use std::collections::HashMap;
use std::path::Path;
use std::process::ExitStatus;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, broadcast, mpsc, oneshot, watch};

use crate::{Error, Event, Result};

const MAX_FRAME: usize = 16 * 1024 * 1024;
const MAX_PENDING: usize = 256;
const EVENT_CAPACITY: usize = 32;
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_QUEUED_BYTES: usize = 32 * 1024 * 1024;
const MAX_ID: u64 = (1 << 53) - 1;

type Reply = oneshot::Sender<Result<Value>>;

struct Outgoing {
    id: Option<u64>,
    bytes: Vec<u8>,
    _permit: Option<OwnedSemaphorePermit>,
}

struct Frame(Vec<u8>);

impl std::io::Write for Frame {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_FRAME.saturating_sub(self.0.len()) {
            return Err(std::io::Error::other("frame too large"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PendingLifetime {
    Timed,
    SettledQueued,
    SettledWriting,
}

struct Pending {
    session: Option<String>,
    reply: Reply,
    lifetime: PendingLifetime,
}

struct State {
    next_id: u64,
    pending: HashMap<u64, Pending>,
    failure: Option<Error>,
}

struct Shared {
    state: Mutex<State>,
    outgoing: mpsc::Sender<Outgoing>,
    events: Mutex<Option<broadcast::Sender<Event>>>,
    policy_events: Mutex<Option<broadcast::Sender<Event>>>,
    stop: watch::Sender<bool>,
    done: watch::Sender<bool>,
    bytes: Arc<Semaphore>,
}

impl Shared {
    fn fail(&self, error: Error) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.failure.is_some() {
            return;
        }
        state.failure = Some(error.clone());
        for (_, pending) in state.pending.drain() {
            let _ = pending.reply.send(Err(error.clone()));
        }
        drop(state);
        self.events.lock().unwrap_or_else(|e| e.into_inner()).take();
        self.policy_events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        self.stop.send_replace(true);
    }
}

struct Owner {
    shared: Arc<Shared>,
    status: watch::Receiver<Option<Result<ExitStatus>>>,
    pid: u32,
    timeout: Duration,
}

impl Drop for Owner {
    fn drop(&mut self) {
        self.shared.stop.send_replace(true);
    }
}

#[derive(Clone)]
pub struct Transport {
    owner: Arc<Owner>,
}

struct PendingGuard {
    shared: Arc<Shared>,
    id: u64,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .pending
            .get(&self.id)
            .is_some_and(|pending| pending.lifetime != PendingLifetime::SettledWriting)
        {
            state.pending.remove(&self.id);
        }
    }
}

pub(crate) fn arguments(profile: &Path) -> Vec<std::ffi::OsString> {
    let mut profile_arg = std::ffi::OsString::from("--user-data-dir=");
    profile_arg.push(profile);
    [
        "--headless=new",
        "--no-startup-window",
        "--remote-debugging-pipe",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-background-timer-throttling",
    ]
    .into_iter()
    .map(Into::into)
    .chain([profile_arg])
    .collect()
}

impl Transport {
    pub async fn launch(executable: &Path, profile: &Path, timeout: Duration) -> Result<Self> {
        let (child, read, write) = crate::sys::spawn(executable, profile)?;
        let pid = child
            .id()
            .ok_or_else(|| Error::new("launch", "Chromium has no process ID"))?;
        let (outgoing, outgoing_rx) = mpsc::channel(MAX_PENDING);
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let (stop, stop_rx) = watch::channel(false);
        let (status_tx, status) = watch::channel(None);
        let (done, _) = watch::channel(false);
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                next_id: 1,
                pending: HashMap::new(),
                failure: None,
            }),
            outgoing,
            events: Mutex::new(Some(events)),
            policy_events: Mutex::new(Some(broadcast::channel(EVENT_CAPACITY).0)),
            stop,
            done,
            bytes: Arc::new(Semaphore::new(MAX_QUEUED_BYTES)),
        });
        tokio::spawn(read_loop(read, Arc::clone(&shared)));
        tokio::spawn(write_loop(write, outgoing_rx, Arc::clone(&shared)));
        tokio::spawn(supervise(child, stop_rx, status_tx, Arc::clone(&shared)));
        let transport = Self {
            owner: Arc::new(Owner {
                shared,
                status,
                pid,
                timeout,
            }),
        };
        Ok(transport)
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value> {
        self.request_with_lifetime(method, params, session, PendingLifetime::Timed)
            .await
    }

    pub async fn request_settled(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value> {
        self.request_with_lifetime(method, params, session, PendingLifetime::SettledQueued)
            .await
    }

    async fn request_with_lifetime(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
        lifetime: PendingLifetime,
    ) -> Result<Value> {
        let shared = &self.owner.shared;
        let (reply, receiver) = oneshot::channel();
        let id = {
            let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(error) = &state.failure {
                return Err(error.clone());
            }
            if *shared.stop.borrow() {
                return Err(Error::new("closed", "Chromium is closing"));
            }
            if state.pending.len() >= MAX_PENDING {
                return Err(Error::new("capacity", "Too many Chromium requests"));
            }
            if state.next_id > MAX_ID {
                return Err(Error::new("capacity", "Chromium request IDs exhausted"));
            }
            let id = state.next_id;
            state.next_id += 1;
            state.pending.insert(
                id,
                Pending {
                    session: session.map(str::to_owned),
                    reply,
                    lifetime,
                },
            );
            id
        };
        let _guard = PendingGuard {
            shared: Arc::clone(shared),
            id,
        };
        let mut message = json!({"id": id, "method": method, "params": params});
        if let Some(session) = session {
            message["sessionId"] = Value::String(session.to_owned());
        }
        let mut frame = Frame(Vec::new());
        serde_json::to_writer(&mut frame, &message)
            .map_err(|_| Error::new("capacity", "Chromium request is too large"))?;
        let mut bytes = frame.0;
        bytes.push(0);
        let permit = Arc::clone(&shared.bytes)
            .try_acquire_many_owned(bytes.len() as u32)
            .map_err(|_| Error::new("capacity", "Chromium request byte limit reached"))?;
        shared
            .outgoing
            .try_send(Outgoing {
                id: Some(id),
                bytes,
                _permit: Some(permit),
            })
            .map_err(|_| Error::new("capacity", "Chromium request queue is full or closed"))?;
        if lifetime != PendingLifetime::Timed {
            return receiver
                .await
                .unwrap_or_else(|_| Err(Error::new("closed", "Chromium connection closed")));
        }
        match tokio::time::timeout(self.owner.timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(Error::new("closed", "Chromium connection closed")),
            Err(_) => Err(Error::new("timeout", "Chromium request timed out")),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        Self::subscribe_to(&self.owner.shared.events)
    }

    pub(crate) fn subscribe_policy(&self) -> broadcast::Receiver<Event> {
        Self::subscribe_to(&self.owner.shared.policy_events)
    }

    fn subscribe_to(
        sender: &Mutex<Option<broadcast::Sender<Event>>>,
    ) -> broadcast::Receiver<Event> {
        let sender = sender.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sender) = sender.as_ref() {
            sender.subscribe()
        } else {
            let (_sender, receiver) = broadcast::channel(1);
            receiver
        }
    }

    pub async fn shutdown(&self) -> Result<ExitStatus> {
        self.owner.shared.stop.send_replace(true);
        let mut status = self.owner.status.clone();
        loop {
            if let Some(result) = status.borrow_and_update().clone() {
                return result;
            }
            status.changed().await.map_err(|_| {
                Error::new("closed", "Chromium supervisor stopped without a status")
            })?;
        }
    }

    pub fn pid(&self) -> u32 {
        self.owner.pid
    }
}

async fn supervise(
    mut child: crate::sys::Child,
    mut stop: watch::Receiver<bool>,
    status: watch::Sender<Option<Result<ExitStatus>>>,
    shared: Arc<Shared>,
) {
    let result = tokio::select! {
        result = child.wait() => result,
        _ = async { while !*stop.borrow_and_update() { if stop.changed().await.is_err() { break; } } } => {
            shared.fail(Error::new("closed", "Chromium is closing"));
            let close = b"{\"id\":0,\"method\":\"Browser.close\",\"params\":{}}\0".to_vec();
            let _ = tokio::time::timeout(CLOSE_TIMEOUT, shared.outgoing.send(Outgoing { id: None, bytes: close, _permit: None })).await;
            match tokio::time::timeout(CLOSE_TIMEOUT, child.wait()).await {
                Ok(result) => result,
                Err(_) => {
                    let _ = child.start_kill();
                    child.wait().await
                }
            }
        }
    };
    let cleanup = child.finish().await;
    drop(child);
    let result = result
        .and_then(|status| cleanup.map(|()| status))
        .map_err(Error::from);
    shared.fail(Error::new("closed", "Chromium process exited"));
    shared.done.send_replace(true);
    status.send_replace(Some(result));
}

async fn write_loop<W: AsyncWrite + Unpin>(
    mut write: W,
    mut queue: mpsc::Receiver<Outgoing>,
    shared: Arc<Shared>,
) {
    let mut done = shared.done.subscribe();
    loop {
        if *done.borrow() {
            return;
        }
        tokio::select! {
            _ = done.changed() => return,
            item = queue.recv() => match item {
                Some(item) => {
                    if let Some(id) = item.id {
                        let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                        let Some(pending) = state.pending.get_mut(&id) else {
                            continue;
                        };
                        if pending.lifetime == PendingLifetime::SettledQueued {
                            pending.lifetime = PendingLifetime::SettledWriting;
                        }
                    }
                    let result = tokio::select! {
                        _ = done.changed() => return,
                        result = async { write.write_all(&item.bytes).await?; write.flush().await } => result,
                    };
                    if result.is_err() {
                        shared.fail(Error::new("pipe", "Chromium pipe write failed"));
                        return;
                    }
                }
                None => return,
            }
        }
    }
}

async fn read_loop<R: AsyncRead + Unpin>(mut read: R, shared: Arc<Shared>) {
    let mut frame = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut done = shared.done.subscribe();
    loop {
        if *done.borrow() {
            return;
        }
        let n = match tokio::select! {
            _ = done.changed() => return,
            result = read.read(&mut chunk) => result,
        } {
            Ok(0) => {
                shared.fail(Error::new("pipe", "Chromium pipe closed"));
                return;
            }
            Ok(n) => n,
            Err(_) => {
                shared.fail(Error::new("pipe", "Chromium pipe read failed"));
                return;
            }
        };
        let mut start = 0;
        for end in 0..n {
            if chunk[end] != 0 {
                continue;
            }
            if frame.len() + end - start > MAX_FRAME {
                shared.fail(Error::new("protocol", "Chromium frame exceeds limit"));
                return;
            }
            frame.extend_from_slice(&chunk[start..end]);
            if let Err(error) = receive(&shared, &frame) {
                shared.fail(error);
                return;
            }
            frame.clear();
            start = end + 1;
            tokio::task::yield_now().await;
        }
        if frame.len() + n - start > MAX_FRAME {
            shared.fail(Error::new("protocol", "Chromium frame exceeds limit"));
            return;
        }
        frame.extend_from_slice(&chunk[start..n]);
    }
}

fn receive(shared: &Shared, bytes: &[u8]) -> Result<()> {
    let mut value: Value = serde_json::from_slice(bytes)
        .map_err(|_| Error::new("protocol", "Invalid Chromium JSON frame"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| Error::new("protocol", "Invalid Chromium message"))?;
    if let Some(id) = object.get("id") {
        let id = id
            .as_u64()
            .ok_or_else(|| Error::new("protocol", "Invalid Chromium response ID"))?;
        let session = match object.get("sessionId") {
            Some(Value::String(session)) => Some(session.as_str()),
            Some(_) => return Err(Error::new("protocol", "Invalid Chromium session ID")),
            None => None,
        };
        let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pending) = state.pending.remove(&id) {
            // Chromium reports an already-detached flat session's error at the browser level, without sessionId.
            let browser_error = session.is_none() && object.contains_key("error");
            if pending.session.as_deref() != session && !browser_error {
                let error = Error::new("protocol", "Chromium response session mismatch");
                let _ = pending.reply.send(Err(error.clone()));
                return Err(error);
            }
            let result = if object.contains_key("error") {
                let message = match object["error"]["code"].as_i64() {
                    Some(code) => format!("Chromium rejected the request (code {code})"),
                    None => "Chromium rejected the request".to_owned(),
                };
                Err(Error::new("cdp_error", message))
            } else {
                Ok(object
                    .remove("result")
                    .ok_or_else(|| Error::new("protocol", "Chromium response has no result"))?)
            };
            let _ = pending.reply.send(result);
        }
        return Ok(());
    }
    let method = object
        .remove("method")
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or_else(|| Error::new("protocol", "Invalid Chromium event"))?;
    let params = object.remove("params").unwrap_or_else(|| json!({}));
    let session_id = match object.remove("sessionId") {
        Some(Value::String(session)) => Some(session),
        Some(_) => return Err(Error::new("protocol", "Invalid Chromium event session")),
        None => None,
    };
    let event = Event {
        method,
        params: Arc::new(params),
        session_id,
    };
    if matches!(
        event.method.as_str(),
        "Target.attachedToTarget" | "Target.detachedFromTarget" | "Fetch.requestPaused"
    ) {
        let policy = shared
            .policy_events
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(policy) = policy.as_ref() else {
            return Err(Error::new("closed", "Chromium policy events are closed"));
        };
        if policy.len() >= EVENT_CAPACITY {
            return Err(Error::new(
                "event_overflow",
                "Chromium policy consumer fell behind",
            ));
        }
        policy
            .send(event.clone())
            .map_err(|_| Error::new("event_unobserved", "Chromium policy event has no consumer"))?;
    }
    if let Some(events) = shared
        .events
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        let _ = events.send(event);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader, DuplexStream};

    pub(crate) fn connected(timeout: Duration) -> (Transport, DuplexStream) {
        let (client, peer) = tokio::io::duplex(65536);
        let (read, write) = tokio::io::split(client);
        let (outgoing, queue) = mpsc::channel(MAX_PENDING);
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let (stop, _) = watch::channel(false);
        let (done, _) = watch::channel(false);
        let (_status_tx, status) = watch::channel(None);
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                next_id: 1,
                pending: HashMap::new(),
                failure: None,
            }),
            outgoing,
            events: Mutex::new(Some(events)),
            policy_events: Mutex::new(Some(broadcast::channel(EVENT_CAPACITY).0)),
            stop,
            done,
            bytes: Arc::new(Semaphore::new(MAX_QUEUED_BYTES)),
        });
        tokio::spawn(read_loop(read, Arc::clone(&shared)));
        tokio::spawn(write_loop(write, queue, Arc::clone(&shared)));
        (
            Transport {
                owner: Arc::new(Owner {
                    shared,
                    status,
                    pid: 1,
                    timeout,
                }),
            },
            peer,
        )
    }

    pub(crate) async fn command(read: &mut BufReader<tokio::io::ReadHalf<DuplexStream>>) -> Value {
        let mut frame = Vec::new();
        read.read_until(0, &mut frame).await.unwrap();
        assert_eq!(frame.pop(), Some(0));
        serde_json::from_slice(&frame).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{command, connected};
    use super::*;

    #[tokio::test]
    async fn process_pipe_end_closes_event_subscribers() {
        let (transport, peer) = connected(Duration::from_secs(10));
        let mut events = transport.subscribe();
        drop(peer);
        assert!(matches!(
            events.recv().await,
            Err(broadcast::error::RecvError::Closed)
        ));
        assert!(matches!(
            transport.subscribe().recv().await,
            Err(broadcast::error::RecvError::Closed)
        ));
    }

    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[tokio::test]
    async fn fragmented_out_of_order_responses_and_session_events() {
        let (transport, peer) = connected(Duration::from_secs(10));
        let mut events = transport.subscribe();
        let (read, mut write) = tokio::io::split(peer);
        let mut read = BufReader::new(read);
        let first = {
            let t = transport.clone();
            tokio::spawn(async move { t.request("Page.first", json!({}), Some("s")).await })
        };
        let first_id = command(&mut read).await["id"].as_u64().unwrap();
        let second = {
            let t = transport.clone();
            tokio::spawn(async move { t.request("Page.second", json!({}), None).await })
        };
        let second_id = command(&mut read).await["id"].as_u64().unwrap();
        let responses = format!(
            "{{\"id\":{second_id},\"result\":{{\"v\":2}}}}\0{{\"method\":\"Page.event\",\"params\":{{\"v\":3}},\"sessionId\":\"s\"}}\0{{\"id\":{first_id},\"result\":{{\"v\":1}},\"sessionId\":\"s\"}}\0"
        );
        for fragment in responses.as_bytes().chunks(3) {
            write.write_all(fragment).await.unwrap();
        }
        assert_eq!(second.await.unwrap().unwrap(), json!({"v":2}));
        assert_eq!(first.await.unwrap().unwrap(), json!({"v":1}));
        let event = events.recv().await.unwrap();
        assert_eq!(event.method, "Page.event");
        assert_eq!(*event.params, json!({"v":3}));
        assert_eq!(event.session_id.as_deref(), Some("s"));
    }

    #[tokio::test]
    async fn cancelled_request_releases_capacity_and_late_reply_is_ignored() {
        let (transport, peer) = connected(Duration::from_secs(10));
        let (read, mut write) = tokio::io::split(peer);
        let mut read = BufReader::new(read);
        let task = {
            let t = transport.clone();
            tokio::spawn(async move { t.request("first", json!({}), None).await })
        };
        let old_id = command(&mut read).await["id"].as_u64().unwrap();
        task.abort();
        let _ = task.await;
        assert!(
            transport
                .owner
                .shared
                .state
                .lock()
                .unwrap()
                .pending
                .is_empty()
        );
        let task = {
            let t = transport.clone();
            tokio::spawn(async move { t.request("second", json!({}), None).await })
        };
        let id = command(&mut read).await["id"].as_u64().unwrap();
        assert!(id > old_id);
        write.write_all(format!("{{\"id\":{old_id},\"result\":{{\"v\":\"late\"}}}}\0{{\"id\":{id},\"result\":{{\"v\":\"current\"}}}}\0").as_bytes()).await.unwrap();
        assert_eq!(task.await.unwrap().unwrap(), json!({"v":"current"}));
    }

    #[tokio::test]
    async fn writer_skips_cancelled_queued_commands() {
        for lifetime in [PendingLifetime::Timed, PendingLifetime::SettledQueued] {
            let (outgoing, queue) = mpsc::channel(MAX_PENDING);
            let (events, _) = broadcast::channel(EVENT_CAPACITY);
            let (stop, _) = watch::channel(false);
            let (done, _) = watch::channel(false);
            let (reply, _receiver) = oneshot::channel();
            let mut pending = HashMap::new();
            pending.insert(
                1,
                Pending {
                    session: None,
                    reply,
                    lifetime,
                },
            );
            let shared = Arc::new(Shared {
                state: Mutex::new(State {
                    next_id: 2,
                    pending,
                    failure: None,
                }),
                outgoing,
                events: Mutex::new(Some(events)),
                policy_events: Mutex::new(Some(broadcast::channel(EVENT_CAPACITY).0)),
                stop,
                done,
                bytes: Arc::new(Semaphore::new(MAX_QUEUED_BYTES)),
            });
            assert!(
                shared
                    .outgoing
                    .try_send(Outgoing {
                        id: Some(1),
                        bytes: b"{\"id\":1}\0".to_vec(),
                        _permit: None
                    })
                    .is_ok()
            );
            let guard = PendingGuard {
                shared: Arc::clone(&shared),
                id: 1,
            };
            drop(guard);
            assert!(
                shared
                    .outgoing
                    .try_send(Outgoing {
                        id: None,
                        bytes: b"{\"method\":\"Browser.close\"}\0".to_vec(),
                        _permit: None
                    })
                    .is_ok()
            );
            let (writer, peer) = tokio::io::duplex(128);
            tokio::spawn(write_loop(writer, queue, shared));
            let mut peer = BufReader::new(peer);
            let mut frame = Vec::new();
            peer.read_until(0, &mut frame).await.unwrap();
            assert_eq!(frame, b"{\"method\":\"Browser.close\"}\0");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn native_mutation_waits_for_actual_late_response_or_pipe_loss() {
        let (transport, peer) = connected(Duration::from_millis(10));
        let (read, mut write) = tokio::io::split(peer);
        let mut read = BufReader::new(read);
        let mutation = {
            let transport = transport.clone();
            tokio::spawn(async move {
                transport
                    .request_settled("Input.insertText", json!({"text":"한"}), Some("original"))
                    .await
            })
        };
        let id = command(&mut read).await["id"].as_u64().unwrap();
        tokio::time::advance(Duration::from_millis(11)).await;
        tokio::task::yield_now().await;
        assert!(
            !mutation.is_finished(),
            "Sent native mutation reported failure before its actual response"
        );
        write
            .write_all(
                format!(
                    "{{\"id\":{id},\"result\":{{\"applied\":true}},\"sessionId\":\"original\"}}\0"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        assert_eq!(mutation.await.unwrap().unwrap(), json!({"applied":true}));
        let mutation = {
            let transport = transport.clone();
            tokio::spawn(async move {
                transport
                    .request_settled("DOM.focus", json!({"nodeId":7}), Some("original"))
                    .await
            })
        };
        command(&mut read).await;
        tokio::time::advance(Duration::from_millis(11)).await;
        tokio::task::yield_now().await;
        assert!(!mutation.is_finished());
        drop(read);
        drop(write);
        assert_eq!(mutation.await.unwrap().unwrap_err().code, "pipe");
    }

    #[tokio::test(start_paused = true)]
    async fn abandoned_sent_mutations_keep_capacity_until_actual_settlement() {
        let (transport, peer) = connected(Duration::from_millis(10));
        let (read, mut write) = tokio::io::split(peer);
        let mut read = BufReader::new(read);
        let live = {
            let transport = transport.clone();
            tokio::spawn(async move {
                transport
                    .request_settled("DOM.focus", json!({"nodeId":1}), Some("original"))
                    .await
            })
        };
        let live_id = command(&mut read).await["id"].as_u64().unwrap();
        for node in 1..MAX_PENDING {
            let task = {
                let transport = transport.clone();
                tokio::spawn(async move {
                    transport
                        .request_settled("DOM.focus", json!({"nodeId":node + 1}), Some("original"))
                        .await
                })
            };
            command(&mut read).await;
            task.abort();
            let _ = task.await;
        }
        let error = transport
            .request("DOM.getDocument", json!({}), Some("original"))
            .await
            .unwrap_err();
        assert_eq!(error.code, "capacity");
        write.write_all(format!("{{\"id\":{live_id},\"result\":{{\"settled\":true}},\"sessionId\":\"original\"}}\0").as_bytes()).await.unwrap();
        assert_eq!(live.await.unwrap().unwrap(), json!({"settled":true}));
        let following = {
            let transport = transport.clone();
            tokio::spawn(async move {
                transport
                    .request_settled("DOM.focus", json!({"nodeId":999}), Some("original"))
                    .await
            })
        };
        let following_id = command(&mut read).await["id"].as_u64().unwrap();
        write.write_all(format!("{{\"id\":{following_id},\"result\":{{\"settled\":true}},\"sessionId\":\"original\"}}\0").as_bytes()).await.unwrap();
        assert_eq!(following.await.unwrap().unwrap(), json!({"settled":true}));
    }

    #[tokio::test(start_paused = true)]
    async fn timeout_and_pipe_failure_release_all_pending() {
        let (transport, peer) = connected(Duration::from_millis(10));
        let (read, write) = tokio::io::split(peer);
        let mut read = BufReader::new(read);
        let timed = {
            let t = transport.clone();
            tokio::spawn(async move { t.request("timeout", json!({}), None).await })
        };
        command(&mut read).await;
        tokio::time::advance(Duration::from_millis(10)).await;
        assert_eq!(timed.await.unwrap().unwrap_err().code, "timeout");
        assert!(
            transport
                .owner
                .shared
                .state
                .lock()
                .unwrap()
                .pending
                .is_empty()
        );
        let pending = {
            let t = transport.clone();
            tokio::spawn(async move { t.request("pending", json!({}), None).await })
        };
        command(&mut read).await;
        drop(read);
        drop(write);
        assert_eq!(pending.await.unwrap().unwrap_err().code, "pipe");
        assert!(
            transport
                .owner
                .shared
                .state
                .lock()
                .unwrap()
                .pending
                .is_empty()
        );
    }

    #[tokio::test]
    async fn lagging_policy_receiver_fails_closed() {
        let (transport, _peer) = connected(Duration::from_secs(10));
        let _receiver = transport.subscribe_policy();
        for _ in 0..EVENT_CAPACITY {
            receive(
                &transport.owner.shared,
                br#"{"method":"Fetch.requestPaused"}"#,
            )
            .unwrap();
        }
        let error = receive(
            &transport.owner.shared,
            br#"{"method":"Fetch.requestPaused"}"#,
        )
        .unwrap_err();
        assert_eq!(error.code, "event_overflow");
    }

    #[tokio::test]
    async fn lagging_observer_does_not_end_other_requests() {
        let (transport, peer) = connected(Duration::from_secs(10));
        let mut observer = transport.subscribe();
        for _ in 0..=EVENT_CAPACITY {
            receive(
                &transport.owner.shared,
                br#"{"method":"Runtime.consoleAPICalled"}"#,
            )
            .unwrap();
        }
        assert!(matches!(
            observer.recv().await,
            Err(broadcast::error::RecvError::Lagged(_))
        ));
        let (read, mut write) = tokio::io::split(peer);
        let mut read = BufReader::new(read);
        let caller = transport.clone();
        let request =
            tokio::spawn(async move { caller.request("Runtime.evaluate", json!({}), None).await });
        let id = command(&mut read).await["id"].as_u64().unwrap();
        write
            .write_all(format!("{{\"id\":{id},\"result\":{{\"value\":42}}}}\0").as_bytes())
            .await
            .unwrap();
        assert_eq!(request.await.unwrap().unwrap(), json!({"value":42}));
    }

    #[tokio::test]
    async fn wrong_session_fails_pending_and_transport() {
        let (transport, peer) = connected(Duration::from_secs(10));
        let (read, mut write) = tokio::io::split(peer);
        let mut read = BufReader::new(read);
        let task = {
            let t = transport.clone();
            tokio::spawn(async move { t.request("test", json!({}), Some("s")).await })
        };
        let id = command(&mut read).await["id"].as_u64().unwrap();
        write
            .write_all(
                format!("{{\"id\":{id},\"sessionId\":\"other\",\"result\":{{}}}}\0").as_bytes(),
            )
            .await
            .unwrap();
        assert_eq!(task.await.unwrap().unwrap_err().code, "protocol");
        assert_eq!(
            transport
                .request("later", json!({}), None)
                .await
                .unwrap_err()
                .code,
            "protocol"
        );
    }

    #[tokio::test]
    async fn detached_session_error_does_not_end_other_requests() {
        let (transport, peer) = connected(Duration::from_secs(10));
        let (read, mut write) = tokio::io::split(peer);
        let mut read = BufReader::new(read);
        let caller = transport.clone();
        let stale = tokio::spawn(async move {
            caller
                .request("Runtime.evaluate", json!({}), Some("detached"))
                .await
        });
        let id = command(&mut read).await["id"].as_u64().unwrap();
        write.write_all(format!("{{\"id\":{id},\"error\":{{\"code\":-32001,\"message\":\"Session sample-private-target not found.\"}}}}\0").as_bytes()).await.unwrap();
        let error = stale.await.unwrap().unwrap_err();
        assert_eq!(error.code, "cdp_error");
        assert_eq!(error.message, "Chromium rejected the request (code -32001)");
        let caller = transport.clone();
        let live =
            tokio::spawn(
                async move { caller.request("Browser.getVersion", json!({}), None).await },
            );
        let id = command(&mut read).await["id"].as_u64().unwrap();
        write
            .write_all(format!("{{\"id\":{id},\"result\":{{\"product\":\"live\"}}}}\0").as_bytes())
            .await
            .unwrap();
        assert_eq!(live.await.unwrap().unwrap(), json!({"product":"live"}));
    }

    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn supervisor_reaps_the_exact_child_after_close_or_kill() {
        use std::process::Stdio;
        let (transport, mut peer) = connected(Duration::from_secs(10));
        let process = tokio::process::Command::new("/bin/sleep")
            .arg("30")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let child = crate::sys::test_child(process);
        let (status_tx, mut status) = watch::channel(None);
        let stop = transport.owner.shared.stop.subscribe();
        tokio::spawn(supervise(
            child,
            stop,
            status_tx,
            Arc::clone(&transport.owner.shared),
        ));
        transport.owner.shared.stop.send_replace(true);
        let mut close = Vec::new();
        let mut buffered = BufReader::new(&mut peer);
        buffered.read_until(0, &mut close).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&close[..close.len() - 1]).unwrap()["method"],
            "Browser.close"
        );
        tokio::time::advance(CLOSE_TIMEOUT).await;
        loop {
            if let Some(result) = status.borrow_and_update().clone() {
                assert!(!result.unwrap().success());
                break;
            }
            status.changed().await.unwrap();
        }
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[tokio::test]
    async fn failure_and_cancellation_race_releases_every_request() {
        for first_lifetime in [
            PendingLifetime::Timed,
            PendingLifetime::SettledQueued,
            PendingLifetime::SettledWriting,
        ] {
            let (outgoing, _queue) = mpsc::channel(MAX_PENDING);
            let (events, _) = broadcast::channel(EVENT_CAPACITY);
            let (stop, _) = watch::channel(false);
            let (done, _) = watch::channel(false);
            let (first, _first_rx) = oneshot::channel();
            let (second, second_rx) = oneshot::channel();
            let mut pending = HashMap::new();
            pending.insert(
                1,
                Pending {
                    session: None,
                    reply: first,
                    lifetime: first_lifetime,
                },
            );
            pending.insert(
                2,
                Pending {
                    session: None,
                    reply: second,
                    lifetime: PendingLifetime::Timed,
                },
            );
            let shared = Arc::new(Shared {
                state: Mutex::new(State {
                    next_id: 3,
                    pending,
                    failure: None,
                }),
                outgoing,
                events: Mutex::new(Some(events)),
                policy_events: Mutex::new(Some(broadcast::channel(EVENT_CAPACITY).0)),
                stop,
                done,
                bytes: Arc::new(Semaphore::new(MAX_QUEUED_BYTES)),
            });
            let guard = PendingGuard {
                shared: Arc::clone(&shared),
                id: 1,
            };
            let barrier = Arc::new(tokio::sync::Barrier::new(2));
            let failing = {
                let shared = Arc::clone(&shared);
                let barrier = Arc::clone(&barrier);
                tokio::spawn(async move {
                    barrier.wait().await;
                    shared.fail(Error::new("pipe", "pipe failed"));
                })
            };
            barrier.wait().await;
            drop(guard);
            failing.await.unwrap();
            assert_eq!(second_rx.await.unwrap().unwrap_err().code, "pipe");
            assert!(shared.state.lock().unwrap().pending.is_empty());
            assert!(*shared.stop.borrow());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn simultaneous_shutdowns_return_the_same_joined_child_status() {
        use std::process::Stdio;
        let process = tokio::process::Command::new("/bin/sh")
            .args(["-c", "exit 42"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let child = crate::sys::test_child(process);
        let pid = child.id().unwrap();
        let (outgoing, _queue) = mpsc::channel(MAX_PENDING);
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let (stop, stop_rx) = watch::channel(false);
        let (done, _) = watch::channel(false);
        let (status_tx, status) = watch::channel(None);
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                next_id: 1,
                pending: HashMap::new(),
                failure: None,
            }),
            outgoing,
            events: Mutex::new(Some(events)),
            policy_events: Mutex::new(Some(broadcast::channel(EVENT_CAPACITY).0)),
            stop,
            done,
            bytes: Arc::new(Semaphore::new(MAX_QUEUED_BYTES)),
        });
        let transport = Transport {
            owner: Arc::new(Owner {
                shared: Arc::clone(&shared),
                status,
                pid,
                timeout: Duration::from_secs(1),
            }),
        };
        tokio::spawn(supervise(child, stop_rx, status_tx, shared));
        let (first, second) = tokio::join!(transport.shutdown(), transport.shutdown());
        assert_eq!(first.unwrap().code(), Some(42));
        assert_eq!(second.unwrap().code(), Some(42));
    }
}
