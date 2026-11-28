//! Direct `tauri-shell -> ompdesk-core` IPC client (H(c), docs/rust-node-removal.md §4).
//!
//! Each `ompdesk-core` generation started by main exposes its client listener (`OMPDESK_CLIENTS` /
//! `OMPDESK_CLIENTS_TOKEN`). Once `core.start` reports the core is ready and main has handed over `IPC_POLICY` in
//! `ipc.routes`, the shell opens one `client: "shell"` connection to that core, sends `ipc.start {policy, userData}`,
//! and routes every core-owned page call (`Route::Core`) directly through that single writer stream: desktop calls from
//! `omp_ipc` (`w<wcId>`) and main-delegated calls from `ipc.call` (`c<connId>` / `w<id>`).
//!
//! Calls arriving while a generation is starting wait until `ipc.start` answers, then dispatch in FIFO order. A call
//! that finds no running core, or whose core ends before answering, fails `core_exited` and is never retried on Node
//! or on the next core.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};
use tokio::sync::{mpsc as async_mpsc, oneshot};

use crate::ipc_router::{Caller, Dir};
use crate::log::log;

/// How long to retry connecting to a newly-bound `OMPDESK_CLIENTS` pipe on Windows when main connects beside us.
const CONNECT_RETRY_LIMIT: Duration = Duration::from_secs(2);
const CONNECT_RETRY_PAUSE: Duration = Duration::from_millis(5);

type Reply = mpsc::Sender<Result<Option<Value>, Value>>;

struct Held {
    caller: Value,
    dir: Dir,
    channel: String,
    args: Value,
    reply: Reply,
}

#[derive(Clone)]
struct PolicyConfig {
    policy: Value,
    user_data: PathBuf,
}

#[derive(Clone)]
struct Endpoint {
    address: String,
    token: String,
}

enum Phase {
    /// No running core generation.
    Idle,
    /// `core.start` arrived for `generation`; holding calls until `ipc.start` finishes on the shell connection.
    Starting {
        generation: u64,
        endpoint: Option<Endpoint>,
        shutdown: Option<oneshot::Sender<()>>,
        held: Vec<Held>,
    },
    /// Shell connection established and `ipc.start` succeeded for `generation`.
    Ready {
        generation: u64,
        writer: async_mpsc::UnboundedSender<String>,
        pending: Arc<Mutex<HashMap<u64, Reply>>>,
        next_id: u64,
        _shutdown: oneshot::Sender<()>,
    },
}

struct Inner {
    policy: Option<PolicyConfig>,
    phase: Phase,
}

pub(crate) struct CoreIpc {
    inner: Mutex<Inner>,
}

impl CoreIpc {
    fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                policy: None,
                phase: Phase::Idle,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Hands over `IPC_POLICY` and `<userData>` from `ipc.routes`. If a core generation already reported its
    /// `OMPDESK_CLIENTS` endpoint, opens the shell connection right away.
    pub(crate) fn set_policy(self: &Arc<Self>, policy: Value, user_data: &Path) {
        let start = {
            let mut inner = self.lock();
            let config = PolicyConfig {
                policy,
                user_data: user_data.to_path_buf(),
            };
            inner.policy = Some(config.clone());
            match &mut inner.phase {
                Phase::Starting {
                    generation,
                    endpoint: Some(endpoint),
                    shutdown,
                    ..
                } if shutdown.is_none() => {
                    let (stop_tx, stop_rx) = oneshot::channel();
                    *shutdown = Some(stop_tx);
                    Some((*generation, endpoint.clone(), config, stop_rx))
                }
                _ => None,
            }
        };
        if let Some((generation, endpoint, config, stop_rx)) = start {
            self.spawn_connect(generation, endpoint, config, stop_rx);
        }
    }

    /// `core.start` arrived for `generation`: fail any superseded generation and begin holding core calls.
    pub(crate) fn starting(&self, generation: u64) {
        let mut inner = self.lock();
        let previous = std::mem::replace(
            &mut inner.phase,
            Phase::Starting {
                generation,
                endpoint: None,
                shutdown: None,
                held: Vec::new(),
            },
        );
        drop(inner);
        fail_phase(previous, core_exited("ompdesk-core restarted"));
    }

    /// `core.start` replied `Ok` for `generation`: the core has bound `OMPDESK_CLIENTS`.
    pub(crate) fn started(self: &Arc<Self>, generation: u64, address: String, token: String) {
        let start = {
            let mut inner = self.lock();
            let policy = inner.policy.clone();
            match &mut inner.phase {
                Phase::Starting {
                    generation: current,
                    endpoint,
                    shutdown,
                    ..
                } if *current == generation => {
                    let ep = Endpoint { address, token };
                    *endpoint = Some(ep.clone());
                    if let Some(config) = policy
                        && shutdown.is_none()
                    {
                        let (stop_tx, stop_rx) = oneshot::channel();
                        *shutdown = Some(stop_tx);
                        Some((ep, config, stop_rx))
                    } else {
                        None
                    }
                }
                _ => None,
            }
        };
        if let Some((endpoint, config, stop_rx)) = start {
            self.spawn_connect(generation, endpoint, config, stop_rx);
        }
    }

    /// `generation` ended (or its `core.start` failed): close its connection and fail all its calls without retry.
    pub(crate) fn ended(&self, generation: u64) {
        let mut inner = self.lock();
        let matches = match &inner.phase {
            Phase::Idle => false,
            Phase::Starting {
                generation: current,
                ..
            }
            | Phase::Ready {
                generation: current,
                ..
            } => *current == generation,
        };
        if !matches {
            return;
        }
        let previous = std::mem::replace(&mut inner.phase, Phase::Idle);
        drop(inner);
        fail_phase(previous, core_exited("ompdesk-core ended"));
    }

    /// Main's core-owner connection ended: fail every waiting call cleanly.
    pub(crate) fn reset(&self) {
        let mut inner = self.lock();
        let previous = std::mem::replace(&mut inner.phase, Phase::Idle);
        drop(inner);
        fail_phase(previous, core_exited("ompdesk-core owner ended"));
    }

    /// Calls `channel` directly on the running `ompdesk-core`. Blocks off the UI thread until answered (for `invoke`)
    /// or queued on the core's writer stream (for `send`).
    pub(crate) fn call(
        &self,
        caller: &Caller,
        dir: Dir,
        channel: &str,
        args: &Value,
    ) -> Result<Option<Value>, Value> {
        let caller = caller_json(caller);
        let (reply, wait) = mpsc::channel();
        {
            let mut inner = self.lock();
            match &mut inner.phase {
                Phase::Idle => return Err(core_exited("ompdesk-core is not running")),
                Phase::Starting { held, .. } => {
                    held.push(Held {
                        caller,
                        dir,
                        channel: channel.to_owned(),
                        args: args.clone(),
                        reply,
                    });
                }
                Phase::Ready {
                    writer,
                    pending,
                    next_id,
                    ..
                } => {
                    let id = *next_id;
                    *next_id += 1;
                    dispatch_to_ready(writer, pending, id, caller, dir, channel, args, reply);
                }
            }
        }
        wait.recv()
            .unwrap_or_else(|_| Err(core_exited("ompdesk-core ended")))
    }

    fn spawn_connect(
        self: &Arc<Self>,
        generation: u64,
        endpoint: Endpoint,
        config: PolicyConfig,
        stop: oneshot::Receiver<()>,
    ) {
        let this = Arc::clone(self);
        thread::spawn(move || {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                this.ended(generation);
                return;
            };
            runtime.block_on(this.connect_and_serve(generation, endpoint, config, stop));
        });
    }

    async fn connect_and_serve(
        self: Arc<Self>,
        generation: u64,
        endpoint: Endpoint,
        config: PolicyConfig,
        mut stop: oneshot::Receiver<()>,
    ) {
        let stream = match connect_with_retry(&endpoint.address, &mut stop).await {
            Ok(Some(stream)) => stream,
            Ok(None) => return,
            Err(error) => {
                log(
                    "core.ipc.connect_failed",
                    json!({"generation":generation,"error":error.to_string()}),
                );
                self.ended(generation);
                return;
            }
        };
        let (read_half, mut write_half) = tokio::io::split(stream);
        let mut reader = BufReader::new(read_half);

        let hello = json!({"token": endpoint.token, "client": "shell"}).to_string();
        if write_line(&mut write_half, &hello, &mut stop).await != Step::Continue {
            self.ended(generation);
            return;
        }
        // First line from `clients.rs` / `server::serve_as` is `{"event":"ready",...}`.
        loop {
            match read_frame_or_stop(&mut reader, &mut stop).await {
                FrameStep::Frame(frame) if frame["event"] == "ready" => break,
                FrameStep::Frame(_) => continue,
                FrameStep::Stopped => return,
                FrameStep::Ended => {
                    self.ended(generation);
                    return;
                }
            }
        }
        let start = json!({
            "id": 1,
            "method": "ipc.start",
            "params": {
                "policy": config.policy,
                "userData": config.user_data.to_string_lossy(),
            }
        })
        .to_string();
        if write_line(&mut write_half, &start, &mut stop).await != Step::Continue {
            self.ended(generation);
            return;
        }
        let started = loop {
            match read_frame_or_stop(&mut reader, &mut stop).await {
                FrameStep::Frame(frame) if frame["id"] == 1 => break frame,
                FrameStep::Frame(_) => continue,
                FrameStep::Stopped => return,
                FrameStep::Ended => {
                    self.ended(generation);
                    return;
                }
            }
        };
        if started["ok"] != true {
            log(
                "core.ipc.start_refused",
                json!({"generation":generation,"error":started["error"]}),
            );
            self.ended(generation);
            return;
        }

        let (writer, mut write_rx) = async_mpsc::unbounded_channel::<String>();
        let pending: Arc<Mutex<HashMap<u64, Reply>>> = Arc::default();
        let promoted = {
            let mut inner = self.lock();
            match &mut inner.phase {
                Phase::Starting {
                    generation: current,
                    shutdown,
                    held,
                    ..
                } if *current == generation => {
                    let Some(stop_tx) = shutdown.take() else {
                        return;
                    };
                    let queued = std::mem::take(held);
                    let mut next_id = 2u64;
                    for item in queued {
                        let id = next_id;
                        next_id += 1;
                        dispatch_to_ready(
                            &writer,
                            &pending,
                            id,
                            item.caller,
                            item.dir,
                            &item.channel,
                            &item.args,
                            item.reply,
                        );
                    }
                    inner.phase = Phase::Ready {
                        generation,
                        writer: writer.clone(),
                        pending: Arc::clone(&pending),
                        next_id,
                        _shutdown: stop_tx,
                    };
                    true
                }
                _ => false,
            }
        };
        if !promoted {
            return;
        }

        let mut line_buf = Vec::new();
        loop {
            tokio::select! {
                biased;
                _ = &mut stop => return,
                maybe_line = write_rx.recv() => {
                    let Some(line) = maybe_line else { break; };
                    if write_all_line(&mut write_half, &line).await.is_err() {
                        break;
                    }
                }
                frame = read_frame(&mut reader, &mut line_buf) => {
                    match frame {
                        Ok(Some(frame)) => deliver_reply(&pending, frame),
                        Ok(None) | Err(_) => break,
                    }
                }
            }
        }
        self.ended(generation);
    }
}

#[cfg(windows)]
type CoreStream = tokio::net::windows::named_pipe::NamedPipeClient;
#[cfg(unix)]
type CoreStream = tokio::net::UnixStream;

async fn connect_with_retry(
    address: &str,
    stop: &mut oneshot::Receiver<()>,
) -> io::Result<Option<CoreStream>> {
    let deadline = Instant::now() + CONNECT_RETRY_LIMIT;
    loop {
        #[cfg(windows)]
        let attempt = tokio::net::windows::named_pipe::ClientOptions::new().open(address);
        #[cfg(unix)]
        let attempt = tokio::net::UnixStream::connect(address).await;
        match attempt {
            Ok(stream) => return Ok(Some(stream)),
            Err(error) => {
                if Instant::now() >= deadline {
                    return Err(error);
                }
                let transient =
                    error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(231); // Windows ERROR_PIPE_BUSY
                if !transient {
                    return Err(error);
                }
                tokio::select! {
                    biased;
                    _ = &mut *stop => return Ok(None),
                    () = tokio::time::sleep(CONNECT_RETRY_PAUSE) => {}
                }
            }
        }
    }
}

#[derive(PartialEq, Eq)]
enum Step {
    Continue,
    Stopped,
}

enum FrameStep {
    Frame(Value),
    Stopped,
    Ended,
}

async fn write_all_line<W: AsyncWrite + Unpin>(out: &mut W, line: &str) -> io::Result<()> {
    out.write_all(line.as_bytes()).await?;
    out.write_all(b"\n").await?;
    out.flush().await
}

async fn write_line<W: AsyncWrite + Unpin>(
    out: &mut W,
    line: &str,
    stop: &mut oneshot::Receiver<()>,
) -> Step {
    tokio::select! {
        biased;
        _ = &mut *stop => Step::Stopped,
        res = write_all_line(out, line) => if res.is_ok() { Step::Continue } else { Step::Stopped },
    }
}

async fn read_frame<R: AsyncBufRead + AsyncRead + Unpin>(
    reader: &mut R,
    line: &mut Vec<u8>,
) -> io::Result<Option<Value>> {
    line.clear();
    let n = reader.read_until(b'\n', line).await?;
    if n == 0 {
        return Ok(None);
    }
    let head: Value = serde_json::from_slice(line).unwrap_or(Value::Null);
    if let Some(bin) = head["bin"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| *n > 0)
    {
        let mut skip = vec![0u8; bin];
        reader.read_exact(&mut skip).await?;
    }
    Ok(Some(head))
}

async fn read_frame_or_stop<R: AsyncBufRead + AsyncRead + Unpin>(
    reader: &mut R,
    stop: &mut oneshot::Receiver<()>,
) -> FrameStep {
    let mut line = Vec::new();
    tokio::select! {
        biased;
        _ = &mut *stop => FrameStep::Stopped,
        res = read_frame(reader, &mut line) => match res {
            Ok(Some(frame)) => FrameStep::Frame(frame),
            Ok(None) | Err(_) => FrameStep::Ended,
        },
    }
}

fn deliver_reply(pending: &Arc<Mutex<HashMap<u64, Reply>>>, frame: Value) {
    let Some(id) = frame["id"].as_u64() else {
        return;
    };
    let reply = pending
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&id);
    let Some(reply) = reply else {
        return;
    };
    let outcome = if frame["ok"] == true {
        Ok(frame["result"].get("value").cloned())
    } else {
        let code = frame["error"]["code"].as_str().unwrap_or("failed");
        let message = frame["error"]["message"]
            .as_str()
            .unwrap_or("ompdesk-core refused IPC call");
        Err(json!({"code": code, "message": message}))
    };
    let _ = reply.send(outcome);
}

#[allow(clippy::too_many_arguments)]
fn dispatch_to_ready(
    writer: &async_mpsc::UnboundedSender<String>,
    pending: &Arc<Mutex<HashMap<u64, Reply>>>,
    id: u64,
    caller: Value,
    dir: Dir,
    channel: &str,
    args: &Value,
    reply: Reply,
) {
    let line = json!({
        "id": id,
        "method": "ipc.call",
        "params": {
            "caller": caller,
            "channel": channel,
            "dir": dir.name(),
            "args": args,
        }
    })
    .to_string();
    match dir {
        Dir::Invoke => {
            pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(id, reply);
            if writer.send(line).is_err()
                && let Some(reply) = pending
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&id)
            {
                let _ = reply.send(Err(core_exited("ompdesk-core ended")));
            }
        }
        Dir::Send => {
            // A send acknowledges once queued for the core's writer stream (docs/rust-node-removal.md §4).
            if writer.send(line).is_ok() {
                let _ = reply.send(Ok(None));
            } else {
                let _ = reply.send(Err(core_exited("ompdesk-core ended")));
            }
        }
    }
}

fn fail_phase(phase: Phase, error: Value) {
    match phase {
        Phase::Idle => {}
        Phase::Starting { held, shutdown, .. } => {
            drop(shutdown);
            for item in held {
                let _ = item.reply.send(Err(error.clone()));
            }
        }
        Phase::Ready {
            pending, _shutdown, ..
        } => {
            drop(_shutdown);
            let waiting =
                std::mem::take(&mut *pending.lock().unwrap_or_else(PoisonError::into_inner));
            for (_, reply) in waiting {
                let _ = reply.send(Err(error.clone()));
            }
        }
    }
}

fn caller_json(caller: &Caller) -> Value {
    match caller {
        Caller::Page(identity) => json!({
            "key": format!("w{}", identity.wc),
            "window": identity.wc as i64,
            "connId": Value::Null,
            "deviceId": Value::Null,
        }),
        Caller::Main {
            key,
            window,
            conn_id,
            device_id,
        } => json!({
            "key": key,
            "window": window,
            "connId": conn_id,
            "deviceId": device_id,
        }),
    }
}

fn core_exited(message: &str) -> Value {
    json!({"code": "core_exited", "message": message})
}

static GLOBAL: LazyLock<Arc<CoreIpc>> = LazyLock::new(|| Arc::new(CoreIpc::new()));

pub(crate) fn set_policy(policy: Value, user_data: &Path) {
    GLOBAL.set_policy(policy, user_data);
}

pub(crate) fn starting(generation: u64) {
    GLOBAL.starting(generation);
}

pub(crate) fn started(generation: u64, address: String, token: String) {
    GLOBAL.started(generation, address, token);
}

pub(crate) fn ended(generation: u64) {
    GLOBAL.ended(generation);
}

pub(crate) fn reset() {
    GLOBAL.reset();
}

pub(crate) fn call(
    caller: &Caller,
    dir: Dir,
    channel: &str,
    args: &Value,
) -> Result<Option<Value>, Value> {
    GLOBAL.call(caller, dir, channel, args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::Identity;
    use shell_core::conn;
    use std::io::{BufReader as StdBufReader, Write as _};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn test_addr(tag: &str) -> String {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        #[cfg(windows)]
        return format!(
            "\\\\.\\pipe\\ompdesk-core-ipc-test-{}-{tag}-{n}",
            std::process::id()
        );
        #[cfg(not(windows))]
        return std::env::temp_dir()
            .join(format!("core-ipc-{}-{tag}-{n}.sock", std::process::id()))
            .to_string_lossy()
            .into_owned();
    }

    fn page_caller(wc: u64) -> Caller {
        Caller::Page(Identity {
            win: Some(1),
            wc,
            generation: 1,
        })
    }

    fn read_std_frame(reader: &mut impl std::io::BufRead) -> io::Result<Option<Value>> {
        let mut line = Vec::new();
        if reader.read_until(b'\n', &mut line)? == 0 {
            return Ok(None);
        }
        let head: Value = serde_json::from_slice(&line).unwrap_or(Value::Null);
        if let Some(bin) = head["bin"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n > 0)
        {
            let mut skip = vec![0u8; bin];
            reader.read_exact(&mut skip)?;
        }
        Ok(Some(head))
    }

    fn is_starting(ipc: &CoreIpc, generation: u64) -> bool {
        matches!(
            ipc.lock().phase,
            Phase::Starting {
                generation: current,
                ..
            } if current == generation
        )
    }

    #[test]
    fn idle_core_fails_with_core_exited() {
        let ipc = Arc::new(CoreIpc::new());
        let err = ipc
            .call(
                &page_caller(7),
                Dir::Invoke,
                "draft-pictures:read",
                &json!([]),
            )
            .unwrap_err();
        assert_eq!(err["code"], "core_exited");
    }

    #[test]
    fn holds_calls_until_policy_and_ipc_start_and_preserves_undefined_vs_null() {
        let addr = test_addr("hold");
        let mut listener = conn::Listener::bind(&addr).unwrap();
        let ipc = Arc::new(CoreIpc::new());
        ipc.starting(1);
        ipc.started(1, addr.clone(), "tok-1".into());

        // Start two calls while policy has not arrived yet: both hold until ipc.start completes.
        let c1 = Arc::clone(&ipc);
        let t1 = thread::spawn(move || {
            c1.call(
                &page_caller(5),
                Dir::Invoke,
                "draft-pictures:put",
                &json!(["id-1"]),
            )
        });
        let c2 = Arc::clone(&ipc);
        let t2 = thread::spawn(move || {
            c2.call(
                &Caller::Main {
                    key: "c9".into(),
                    window: Some(-1),
                    conn_id: Some("9".into()),
                    device_id: Some("phone-a".into()),
                },
                Dir::Invoke,
                "draft-pictures:read",
                &json!(["id-1"]),
            )
        });

        // Stand-in core server verifies hello, ipc.start, and both ipc.call requests.
        let server = thread::spawn(move || {
            let conn = listener.accept().unwrap();
            let mut out = conn.try_clone().unwrap();
            let mut reader = StdBufReader::new(conn);
            let hello = read_std_frame(&mut reader).unwrap().unwrap();
            assert_eq!(hello, json!({"token": "tok-1", "client": "shell"}));
            writeln!(
                out,
                "{}",
                json!({"event": "ready", "data": {"protocol": 1}})
            )
            .unwrap();
            out.flush().unwrap();

            let start = read_std_frame(&mut reader).unwrap().unwrap();
            assert_eq!(start["method"], "ipc.start");
            assert_eq!(start["params"]["userData"], "/tmp/profile");
            writeln!(
                out,
                "{}",
                json!({"id": start["id"], "ok": true, "result": {"channels": []}})
            )
            .unwrap();
            out.flush().unwrap();

            let mut seen = Vec::new();
            for _ in 0..2 {
                let req = read_std_frame(&mut reader).unwrap().unwrap();
                assert_eq!(req["method"], "ipc.call");
                let ch = req["params"]["channel"].as_str().unwrap().to_owned();
                seen.push((ch.clone(), req["params"]["caller"].clone()));
                let reply = if ch == "draft-pictures:put" {
                    // Omitted `value` => JS `undefined`.
                    json!({"id": req["id"], "ok": true, "result": {}})
                } else {
                    // Explicit `null` => JS `null`.
                    json!({"id": req["id"], "ok": true, "result": {"value": null}})
                };
                writeln!(out, "{reply}").unwrap();
                out.flush().unwrap();
            }
            seen
        });

        // Handing over policy triggers the connection and releases held calls.
        ipc.set_policy(
            json!({"draft-pictures:put": {"dir": "invoke"}}),
            Path::new("/tmp/profile"),
        );

        assert_eq!(t1.join().unwrap(), Ok(None));
        assert_eq!(t2.join().unwrap(), Ok(Some(Value::Null)));
        let seen = server.join().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen.iter().any(|(ch, caller)| {
            ch == "draft-pictures:put" && caller["key"] == "w5" && caller["deviceId"].is_null()
        }));
        assert!(seen.iter().any(|(ch, caller)| {
            ch == "draft-pictures:read" && caller["key"] == "c9" && caller["deviceId"] == "phone-a"
        }));
        ipc.ended(1);
        #[cfg(not(windows))]
        let _ = std::fs::remove_file(&addr);
    }

    #[test]
    fn ending_generation_fails_in_flight_calls_and_ignores_stale_ended() {
        let addr = test_addr("end");
        let mut listener = conn::Listener::bind(&addr).unwrap();
        let ipc = Arc::new(CoreIpc::new());
        ipc.set_policy(json!({}), Path::new("/tmp/p"));
        ipc.starting(1);
        ipc.started(1, addr.clone(), "tok-2".into());

        let (got_call, wait_call) = mpsc::channel();
        let server = thread::spawn(move || {
            let conn = listener.accept().unwrap();
            let mut out = conn.try_clone().unwrap();
            let mut reader = StdBufReader::new(conn);
            let _hello = read_std_frame(&mut reader).unwrap().unwrap();
            writeln!(
                out,
                "{}",
                json!({"event": "ready", "data": {"protocol": 1}})
            )
            .unwrap();
            out.flush().unwrap();
            let start = read_std_frame(&mut reader).unwrap().unwrap();
            writeln!(
                out,
                "{}",
                json!({"id": start["id"], "ok": true, "result": {"channels": []}})
            )
            .unwrap();
            out.flush().unwrap();
            let req = read_std_frame(&mut reader).unwrap().unwrap();
            let _ = got_call.send(req["params"]["channel"].as_str().unwrap().to_owned());
            // Never answer; wait for the shell to close its end on supersede.
            let _ = read_std_frame(&mut reader);
        });

        let c = Arc::clone(&ipc);
        let inflight = thread::spawn(move || {
            c.call(
                &page_caller(2),
                Dir::Invoke,
                "draft-pictures:read",
                &json!([]),
            )
        });
        assert_eq!(
            wait_call.recv_timeout(Duration::from_secs(5)).unwrap(),
            "draft-pictures:read"
        );

        // Superseding with generation 2 closes generation 1's stream and fails its in-flight call immediately.
        ipc.starting(2);
        let err = inflight.join().unwrap().unwrap_err();
        assert_eq!(err["code"], "core_exited");
        // Late `ended(1)` must NOT cancel generation 2.
        ipc.ended(1);
        assert!(is_starting(&ipc, 2));
        ipc.ended(2);
        assert!(!is_starting(&ipc, 2));
        // The server observes EOF as soon as generation 1's stream drops.
        server.join().unwrap();
        #[cfg(not(windows))]
        let _ = std::fs::remove_file(&addr);
    }
}
