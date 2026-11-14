//! The device's remote tab. A single inbox applies link events and completed operations in order. Socket requests
//! run beside it, never holding a streamed status or ask behind a long `tab.command`.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot, watch};
use tokio::task::JoinSet;

use super::events::decoder::Decoder;
use super::events::delta::{ReadDecoder, encoded_read_key};
use super::requests::{RemoteError, RemoteEvent, RemoteRequests};
use crate::remotebytes::native::{ContentCache, Forward, ListenState, NativeRelay, Page, Words};
use crate::server::Fault;

const REQUEST: Duration = Duration::from_secs(30);
const LINK_SLACK: Duration = Duration::from_secs(5);
const MAX_REPLIES: usize = 64;

#[derive(Clone, Debug)]
pub struct TabOptions {
    pub rtab: String,
    pub cwd: String,
    pub kind: String,
    pub fresh: bool,
    pub session_path: Option<String>,
    pub offline_message: String,
    pub unanswered_message: String,
    /// The saved execution host, supplied by the native device registry, never the visible view host.
    pub execution_host: String,
    pub sign_in_failure: Words,
}

#[derive(Clone, Debug)]
pub struct TabEvent {
    pub name: String,
    pub arg: Value,
    /// Only link-derived status preserves the pool's open question routes.
    pub from_link: bool,
}

#[derive(Clone)]
pub struct TabSnapshot {
    pub status: String,
    pub cwd: String,
    pub kind: String,
    pub process_alive: bool,
    pub shared: bool,
    pub status_from_link: bool,
    pub detail: Value,
    pub session_path: Option<String>,
    /// Changes when the original link epoch or host omp binding changes.
    pub generation: u64,
    pub omp: Option<String>,
    pub bridge: Value,
    connection: RemoteRequests,
}

impl std::fmt::Debug for TabSnapshot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("TabSnapshot")
            .field("status", &self.status)
            .field("generation", &self.generation)
            .field("process_alive", &self.process_alive)
            .finish_non_exhaustive()
    }
}

/// Original actor facts only; this value grants no connection, caller or card authority.
pub(crate) struct ObservedRun {
    pub generation: u64,
    pub path: String,
    pub omp: String,
    pub connection: RemoteRequests,
}

#[derive(Clone)]
pub struct RemoteTab {
    inbox: mpsc::UnboundedSender<Input>,
    snapshot: Arc<Mutex<TabSnapshot>>,
    cache: Arc<ContentCache>,
    execution_host: String,
    disposed: watch::Receiver<Option<Result<(), Fault>>>,
    emitted: Arc<AtomicU64>,
}

type Answer = oneshot::Sender<Result<Value, RemoteError>>;
enum Input {
    Start,
    Restart {
        cwd: Option<String>,
        session: Option<String>,
    },
    AdoptCwd(String),
    Link(RemoteRequests),
    Lost(u64),
    Event(u64, RemoteEvent),
    Opened(u64, Result<Value, RemoteError>),
    Started(u64, Result<Value, RemoteError>),
    CachedCommand(RemoteTab, u64, Value, Duration, Answer),
    Check(u64, oneshot::Sender<Result<(), RemoteError>>),
    Bridge(Option<u64>, String, Answer),
    Command(Option<u64>, Value, Duration, Answer),
    ReadDone(
        u64,
        Option<u64>,
        Value,
        Duration,
        bool,
        Answer,
        Result<Value, RemoteError>,
    ),
    SideChannel(Option<u64>, Value, Answer),
    Delivered(
        u64,
        Option<String>,
        Option<u64>,
        Value,
        Answer,
        Result<Value, RemoteError>,
    ),
    CancelWait(Answer),
    Notify(&'static str, Value),
    RelayListening(u64, ListenState),
    RelayEnded(u64),
    ForwardSignIn(u64, String, String, oneshot::Sender<Result<Page, Fault>>),
    Dispose(bool),
}

enum BringUp {
    Closed,
    Opening,
    Open,
}

struct State {
    options: TabOptions,
    link: RemoteRequests,
    epoch: u64,
    phase: BringUp,
    bound_omp: bool,
    wanted: bool,
    opened_once: bool,
    omp: Option<String>,
    reattaching: bool,
    reattach_run: Option<Value>,
    restart: Option<(Option<String>, Option<String>)>,
    queued: VecDeque<(Option<String>, Value)>,
    waiting: VecDeque<Input>,
    decoder: Decoder,
    reads: HashMap<String, ReadDecoder>,
    inbox: mpsc::UnboundedSender<Input>,
    output: mpsc::UnboundedSender<TabEvent>,
    snapshot: Arc<Mutex<TabSnapshot>>,
    emitted: Arc<AtomicU64>,
    closes: Arc<PendingTabCloses>,
    relay: Option<NativeRelay>,
    relay_generation: u64,
    signing_in: bool,
    work: JoinSet<()>,
    watchers: JoinSet<()>,
}

fn offline() -> RemoteError {
    Fault::new("remote_offline", "The device running this tab is offline").into()
}
fn replayable(frame: &Value) -> bool {
    matches!(
        frame["type"].as_str(),
        Some("host_tool_result" | "host_uri_result")
    )
}

impl RemoteTab {
    pub fn new(
        options: TabOptions,
        link: RemoteRequests,
        closes: Arc<PendingTabCloses>,
        cache: Arc<ContentCache>,
    ) -> (Self, mpsc::UnboundedReceiver<TabEvent>) {
        closes.cancel(&options.rtab);
        let execution_host = options.execution_host.clone();
        let (inbox, receiver) = mpsc::unbounded_channel();
        let (output, events) = mpsc::unbounded_channel();
        let emitted = Arc::new(AtomicU64::new(0));
        let snapshot = Arc::new(Mutex::new(TabSnapshot {
            status: "asleep".into(),
            cwd: options.cwd.clone(),
            kind: options.kind.clone(),
            process_alive: false,
            shared: false,
            status_from_link: true,
            detail: json!({}),
            session_path: options.session_path.clone(),
            generation: 1,
            omp: None,
            bridge: Value::Null,
            connection: link.clone(),
        }));
        let mut state = State {
            options,
            link,
            epoch: 1,
            phase: BringUp::Closed,
            bound_omp: false,
            wanted: false,
            opened_once: false,
            omp: None,
            reattaching: false,
            reattach_run: None,
            restart: None,
            queued: VecDeque::new(),
            waiting: VecDeque::new(),
            decoder: Decoder::new(),
            reads: HashMap::new(),
            inbox: inbox.clone(),
            output,
            snapshot: Arc::clone(&snapshot),
            emitted: Arc::clone(&emitted),
            closes,
            relay: None,
            relay_generation: 0,
            signing_in: false,
            work: JoinSet::new(),
            watchers: JoinSet::new(),
        };
        state.watch_link();
        let (finished, disposed) = watch::channel(None);
        tokio::spawn(async move {
            let result = tokio::spawn(state.run(receiver))
                .await
                .unwrap_or_else(|error| Err(Fault::new("remote_actor", error.to_string())));
            let _ = finished.send_replace(Some(result));
        });
        (
            Self {
                inbox,
                snapshot,
                cache,
                execution_host,
                disposed,
                emitted,
            },
            events,
        )
    }

    pub fn snapshot(&self) -> TabSnapshot {
        self.snapshot
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
    pub fn same_instance(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.snapshot, &other.snapshot)
    }
    pub fn generation(&self) -> u64 {
        self.snapshot
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .generation
    }
    pub fn emitted_events(&self) -> u64 {
        self.emitted.load(Ordering::Acquire)
    }
    pub fn facts(&self) -> Value {
        let state = self.snapshot.lock().unwrap_or_else(|p| p.into_inner());
        json!({"cwd":state.cwd,"kind":state.kind,"status":state.status,"processAlive":state.process_alive,
            "shared":state.shared,"sleep":false,"rpc":state.status!="asleep","bridge":state.bridge["connected"]==true})
    }
    pub fn bridge_connected(&self) -> bool {
        self.snapshot
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .bridge["connected"]
            == true
    }
    pub(crate) fn observed_run(&self) -> Result<ObservedRun, Fault> {
        let snapshot = self.snapshot.lock().unwrap_or_else(|p| p.into_inner());
        if !snapshot.process_alive {
            return Err(Fault::new("remote_run_changed", "The observed remote session is no longer current"));
        }
        let path = snapshot.session_path.as_deref().filter(|path| !path.is_empty())
            .ok_or_else(|| Fault::new("remote_run_changed", "The remote tab has no saved session"))?;
        let omp = snapshot.omp.as_deref().filter(|omp| !omp.is_empty())
            .ok_or_else(|| Fault::new("remote_run_changed", "The remote tab has no execution binding"))?;
        Ok(ObservedRun { generation: snapshot.generation, path: path.to_owned(), omp: omp.to_owned(), connection: snapshot.connection.clone() })
    }
    /// Snapshot admission only; Root must admit the original connection online before entering.
    /// The synchronous effect must neither await nor re-enter this snapshot mutex.
    pub(crate) fn admit_observation<T>(
        &self,
        generation: u64,
        session_path: &str,
        omp: &str,
        connection: &RemoteRequests,
        effect: impl FnOnce() -> Result<T, Fault>,
    ) -> Result<T, Fault> {
        let snapshot = self.snapshot.lock().unwrap_or_else(|p| p.into_inner());
        if snapshot.generation != generation
            || snapshot.session_path.as_deref() != Some(session_path)
            || snapshot.omp.as_deref() != Some(omp)
            || !snapshot.connection.same_connection(connection)
            || !snapshot.process_alive
        {
            return Err(Fault::new(
                "remote_run_changed",
                "The observed remote session is no longer current",
            ));
        }
        let result = effect();
        drop(snapshot);
        result
    }
    pub fn start(&self) {
        let _ = self.inbox.send(Input::Start);
    }
    pub fn restart(&self, cwd: Option<String>, session: Option<String>) {
        let _ = self.inbox.send(Input::Restart { cwd, session });
    }
    pub fn relink(&self, link: RemoteRequests) {
        let _ = self.inbox.send(Input::Link(link));
    }
    pub fn dispose(&self, keep_on_host: bool) {
        let _ = self.inbox.send(Input::Dispose(keep_on_host));
    }
    /// Completion of this local actor and its cleanup, not of the host's omp.
    pub fn when_disposed(
        &self,
    ) -> crate::sidecar::application::EffectFuture<'static, Result<(), Fault>> {
        let mut disposed = self.disposed.clone();
        Box::pin(async move {
            loop {
                if let Some(result) = disposed.borrow_and_update().clone() {
                    return result;
                }
                disposed.changed().await.map_err(|_| {
                    Fault::new(
                        "remote_actor",
                        "Remote tab actor lost its completion receipt",
                    )
                })?;
            }
        })
    }
    pub async fn command(&self, command: Value, timeout: Duration) -> Result<Value, RemoteError> {
        self.command_inner(command, timeout, None).await
    }
    /// Enqueues against this actor before the returned receipt is polled.
    pub fn command_for_generation(
        &self,
        generation: u64,
        command: Value,
        timeout: Duration,
    ) -> crate::sidecar::application::EffectFuture<'static, Result<Value, RemoteError>> {
        let (answer, result) = oneshot::channel();
        let sent = self.inbox.send(Input::CachedCommand(
            self.clone(),
            generation,
            command,
            timeout,
            answer,
        ));
        Box::pin(async move {
            sent.map_err(|_| offline())?;
            result.await.unwrap_or_else(|_| Err(offline()))
        })
    }
    async fn check(&self, expected: Option<u64>) -> Result<(), RemoteError> {
        let Some(generation) = expected else {
            return Ok(());
        };
        let (answer, result) = oneshot::channel();
        self.inbox
            .send(Input::Check(generation, answer))
            .map_err(|_| offline())?;
        result.await.unwrap_or_else(|_| Err(offline()))
    }
    pub fn bridge(
        &self,
        expected: Option<u64>,
        method: String,
    ) -> crate::sidecar::application::EffectFuture<'static, Result<Value, RemoteError>> {
        let (answer, result) = oneshot::channel();
        let sent = self.inbox.send(Input::Bridge(expected, method, answer));
        Box::pin(async move {
            sent.map_err(|_| offline())?;
            result.await.unwrap_or_else(|_| Err(offline()))
        })
    }
    async fn command_inner(
        &self,
        mut command: Value,
        timeout: Duration,
        expected: Option<u64>,
    ) -> Result<Value, RemoteError> {
        self.check(expected).await?;
        let session = self.snapshot().session_path;
        let journal = matches!(
            command["type"].as_str(),
            Some("get_subagent_messages" | "get_subagent_transcript")
        );
        let pictured = journal || command["type"] == "get_transcript_page";
        if pictured {
            command["imageRefs"] = true.into();
        }
        let mut response = if journal
            && command["firstPrompt"] != true
            && let (Some(session), Some(id)) = (
                session.as_ref(),
                command["subagentId"].as_str().filter(|id| !id.is_empty()),
            ) {
            let key = format!("{}\0{session}\0subagent\0{id}", self.execution_host);
            let from = command.get("fromByte").cloned().unwrap_or_else(|| 0.into());
            self.cache
                .journal(&key, from, |from, tail| async move {
                    command["fromByte"] = from;
                    command["tails"] = true.into();
                    if let Some(tail) = tail {
                        command["knownTail"] = tail;
                    }
                    self.request(command, timeout, expected)
                        .await
                        .map_err(|error| error.fault)
                })
                .await
                .map_err(RemoteError::from)?
        } else {
            let key = if command["type"] == "get_transcript_page"
                && command["fromEnd"] == true
                && command.get("cursor").is_none()
            {
                session.map(|session| {
                    format!(
                        "{}\0{session}\0tail\0{}",
                        self.execution_host,
                        command.get("limit").map_or_else(
                            || "undefined".into(),
                            |value| value
                                .as_str()
                                .map_or_else(|| value.to_string(), str::to_owned)
                        )
                    )
                })
            } else {
                None
            };
            let kept = if command.get("ifVersion").is_none()
                && let Some(key) = key.as_ref()
            {
                self.cache.page(key).await
            } else {
                None
            };
            if let Some(kept) = kept.as_ref() {
                command["ifVersion"] = kept["version"].clone();
            }
            let mut response = self.request(command, timeout, expected).await?;
            if response["success"] == true
                && let Some(key) = key
            {
                if response["data"]["unchanged"] == true
                    && let Some(kept) = kept
                {
                    response["data"] = kept["page"].clone();
                } else if let Some(version) = response["data"]["version"]
                    .as_str()
                    .filter(|_| response["data"]["unchanged"] != true)
                {
                    self.check(expected).await?;
                    self.cache.keep_page(&key, version, &response["data"]).await;
                }
            }
            response
        };
        if pictured
            && response["success"] == true
            && let Some(messages) = response["data"].get_mut("messages")
        {
            self.cache
                .pictures(messages, |reference| async move {
                    let response = self
                        .request(
                            json!({"type":"read_image_blob","ref":reference}),
                            Duration::from_secs(8),
                            expected,
                        )
                        .await
                        .ok()?;
                    (response["success"] == true)
                        .then(|| response["data"]["data"].as_str().map(str::to_owned))
                        .flatten()
                })
                .await;
        }
        self.check(expected).await?;
        Ok(response)
    }
    async fn request(
        &self,
        command: Value,
        timeout: Duration,
        expected: Option<u64>,
    ) -> Result<Value, RemoteError> {
        let (answer, result) = oneshot::channel();
        self.inbox
            .send(Input::Command(expected, command, timeout, answer))
            .map_err(|_| offline())?;
        result.await.unwrap_or_else(|_| Err(offline()))
    }
    pub async fn side_channel(&self, frame: Value) -> Result<(), RemoteError> {
        let (answer, result) = oneshot::channel();
        self.inbox
            .send(Input::SideChannel(None, frame, answer))
            .map_err(|_| offline())?;
        result.await.unwrap_or_else(|_| Err(offline())).map(|_| ())
    }
    pub fn enqueue_side_channel(
        &self,
        frame: Value,
    ) -> Result<
        crate::sidecar::application::EffectFuture<'static, Result<(), RemoteError>>,
        RemoteError,
    > {
        let (answer, result) = oneshot::channel();
        self.inbox
            .send(Input::SideChannel(None, frame, answer))
            .map_err(|_| offline())?;
        Ok(Box::pin(async move {
            result.await.unwrap_or_else(|_| Err(offline())).map(|_| ())
        }))
    }
    pub fn side_channel_for_generation(
        &self,
        generation: u64,
        frame: Value,
    ) -> crate::sidecar::application::EffectFuture<'static, Result<(), RemoteError>> {
        let (answer, result) = oneshot::channel();
        let sent = self
            .inbox
            .send(Input::SideChannel(Some(generation), frame, answer));
        Box::pin(async move {
            sent.map_err(|_| offline())?;
            result.await.unwrap_or_else(|_| Err(offline())).map(|_| ())
        })
    }
    pub fn adopt_cwd(&self, cwd: &str) -> bool {
        let mut snapshot = self.snapshot.lock().unwrap_or_else(|p| p.into_inner());
        if snapshot.cwd == cwd {
            return false;
        }
        snapshot.cwd = cwd.to_owned();
        drop(snapshot);
        let _ = self.inbox.send(Input::AdoptCwd(cwd.to_owned()));
        true
    }
    pub async fn cancel_wait(&self) -> Result<(), RemoteError> {
        let (answer, result) = oneshot::channel();
        self.inbox
            .send(Input::CancelWait(answer))
            .map_err(|_| offline())?;
        result.await.unwrap_or_else(|_| Err(offline())).map(|_| ())
    }
    pub fn sync_image_generation(&self) {
        let _ = self
            .inbox
            .send(Input::Notify("tab.syncImageGeneration", json!({})));
    }
}

impl State {
    fn check_generation(&self, expected: Option<u64>) -> Result<(), RemoteError> {
        let Some(expected) = expected else {
            return Ok(());
        };
        if !self.link.is_online() {
            return Err(offline());
        }
        let snapshot = self.snapshot.lock().unwrap_or_else(|p| p.into_inner());
        if snapshot.generation != expected || snapshot.omp.is_none() {
            return Err(Fault::new(
                "remote_run_changed",
                "The original remote tab run is no longer current",
            )
            .into());
        }
        Ok(())
    }
    fn bind_wire(&self, expected: Option<u64>, params: &mut Value) -> Result<(), RemoteError> {
        self.check_generation(expected)?;
        if expected.is_some() {
            if !self.bound_omp {
                return Err(Fault::new(
                    "remote_run_binding_unavailable",
                    "The execution host does not support generation-bound tab effects",
                )
                .into());
            }
            let omp = self
                .omp
                .as_deref()
                .filter(|omp| !omp.is_empty())
                .ok_or_else(|| {
                    Fault::new(
                        "remote_run_changed",
                        "The original remote tab run is no longer current",
                    )
                })?;
            params["expectedOmp"] = omp.into();
        }
        Ok(())
    }
    fn emit(&self, name: &str, arg: Value, from_link: bool) {
        if self
            .output
            .send(TabEvent {
                name: name.to_owned(),
                arg,
                from_link,
            })
            .is_ok()
        {
            self.emitted.fetch_add(1, Ordering::Release);
        }
    }
    fn status(&mut self, status: &str, detail: Value, from_link: bool) {
        self.reattaching = status == "starting" && detail["reconnecting"] == true;
        let mut snapshot = self.snapshot.lock().unwrap_or_else(|p| p.into_inner());
        snapshot.status = status.into();
        snapshot.detail = detail;
        snapshot.status_from_link = from_link;
        let mut payload = snapshot.detail.clone();
        payload["status"] = status.into();
        payload["cwd"] = snapshot.cwd.clone().into();
        drop(snapshot);
        self.emit("status", payload, from_link);
    }
    fn watch_link(&mut self) {
        self.watchers.abort_all();
        let inbox = self.inbox.clone();
        let epoch = self.epoch;
        let rtab = self.options.rtab.clone();
        self.link.on_event(move |event| {
            event.event != "tab.event"
                || event.data["rtab"] != rtab
                || inbox.send(Input::Event(epoch, event.clone())).is_ok()
        });
        let mut changes = self.link.changes();
        let inbox = self.inbox.clone();
        self.watchers.spawn(async move {
            if !*changes.borrow() {
                let _ = inbox.send(Input::Lost(epoch));
                return;
            }
            while changes.changed().await.is_ok() {
                if !*changes.borrow_and_update() {
                    let _ = inbox.send(Input::Lost(epoch));
                    break;
                }
            }
        });
    }
    fn open(&mut self) {
        if !self.link.is_online() || !matches!(self.phase, BringUp::Closed) {
            return;
        }
        self.phase = BringUp::Opening;
        self.opened_once = true;
        let mut params = json!({"rtab":self.options.rtab,"cwd":self.options.cwd,"kind":self.options.kind,"fresh":self.options.fresh});
        if let Some(session) = &self.options.session_path {
            params["sessionPath"] = session.clone().into();
        }
        let link = self.link.clone();
        let inbox = self.inbox.clone();
        let epoch = self.epoch;
        let closes = Arc::clone(&self.closes);
        self.work.spawn(async move {
            let result = closes.open(&link, params).await;
            let _ = inbox.send(Input::Opened(epoch, result));
        });
    }
    fn start_opened(&mut self, attached: bool) {
        if !self.wanted {
            return;
        }
        if attached && self.restart.is_none() {
            return;
        }
        let mut params = json!({"rtab":self.options.rtab});
        let method = if let Some((cwd, session)) = self.restart.take() {
            if let Some(cwd) = cwd {
                params["cwd"] = cwd.into();
            }
            if let Some(session) = session {
                params["sessionPath"] = session.into();
            }
            "tab.restart"
        } else {
            "tab.start"
        };
        if !attached && self.reattaching {
            self.status("starting", json!({}), true);
        }
        let link = self.link.clone();
        let inbox = self.inbox.clone();
        let epoch = self.epoch;
        self.work.spawn(async move {
            let result = link.request(method, params, REQUEST).await;
            let _ = inbox.send(Input::Started(epoch, result));
        });
    }
    fn queue(&mut self, frame: Value) {
        self.queued.push_back((self.omp.clone(), frame));
        if self.queued.len() > MAX_REPLIES {
            self.queued.pop_front();
        }
    }
    fn deliver(&mut self, expected: Option<u64>, frame: Value, answer: Answer) {
        let link = self.link.clone();
        let inbox = self.inbox.clone();
        let epoch = self.epoch;
        let omp = self.omp.clone();
        let mut params = json!({"rtab":self.options.rtab,"frame":frame});
        if let Err(error) = self.bind_wire(expected, &mut params) {
            let _ = answer.send(Err(error));
            return;
        }
        self.work.spawn(async move {
            let result = link.request("tab.sideChannel", params, REQUEST).await;
            let _ = inbox.send(Input::Delivered(
                epoch, omp, expected, frame, answer, result,
            ));
        });
    }
    fn read(
        &mut self,
        expected: Option<u64>,
        command: Value,
        timeout: Duration,
        fresh: bool,
        answer: Answer,
    ) {
        let link = self.link.clone();
        let inbox = self.inbox.clone();
        let epoch = self.epoch;
        let mut params = json!({"rtab":self.options.rtab,"command":command,"timeoutMs":timeout.as_millis().min(u64::MAX as u128) as u64});
        if let Err(error) = self.bind_wire(expected, &mut params) {
            let _ = answer.send(Err(error));
            return;
        }
        if fresh {
            params["fresh"] = true.into();
        }
        self.work.spawn(async move {
            let result = link
                .request("tab.command", params, timeout.saturating_add(LINK_SLACK))
                .await;
            let _ = inbox.send(Input::ReadDone(
                epoch, expected, command, timeout, fresh, answer, result,
            ));
        });
    }
    fn failed(&mut self, error: RemoteError) {
        if !self.link.is_online() {
            self.lost();
            return;
        }
        if error.fault.code != "timeout" {
            for input in self.waiting.drain(..) {
                match input {
                    Input::Command(_, _, _, answer)
                    | Input::SideChannel(_, _, answer)
                    | Input::CancelWait(answer) => {
                        let _ = answer.send(Err(error.clone()));
                    }
                    Input::ForwardSignIn(_, _, _, answer) => {
                        let _ = answer.send(Err(error.fault.clone()));
                    }
                    _ => {}
                }
            }
        }
        match error.fault.code.as_ref() {
            "timeout" => {
                self.status(
                    "starting",
                    json!({"slow":true,"message":self.options.unanswered_message}),
                    true,
                );
                self.phase = BringUp::Closed;
                self.open();
            }
            "session_deleted" => {
                self.emit("sessionDeleted", json!(self.options.session_path), false)
            }
            "session_open_in_tab" => {
                self.emit("shownElsewhere", error.holder.unwrap_or(Value::Null), false)
            }
            "session_folder_missing" if is_worktree_folder(&self.options.cwd) => {
                self.emit("folderGone", Value::Null, false)
            }
            _ => {
                self.snapshot
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .process_alive = false;
                self.status("error", json!({"message":error.fault.message}), false);
            }
        }
    }
    fn lost(&mut self) {
        self.phase = BringUp::Closed;
        self.bound_omp = false;
        self.reattach_run = None;
        self.snapshot
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .process_alive = false;
        if self.wanted {
            self.status(
                "starting",
                json!({"reconnecting":true,"message":self.options.offline_message}),
                true,
            );
        }
        while let Some(input) = self.waiting.pop_front() {
            match input {
                Input::Command(_, _, _, answer) | Input::CancelWait(answer) => {
                    let _ = answer.send(Err(offline()));
                }
                Input::SideChannel(None, frame, answer) if replayable(&frame) => {
                    self.queue(frame);
                    let _ = answer.send(Ok(Value::Null));
                }
                Input::SideChannel(_, _, answer) => {
                    let _ = answer.send(Err(offline()));
                }
                Input::ForwardSignIn(_, _, _, answer) => {
                    let _ = answer.send(Err(offline().fault));
                }
                _ => {}
            }
        }
    }
    fn event(&mut self, event: RemoteEvent) {
        if event.event != "tab.event" || event.data["rtab"] != self.options.rtab {
            return;
        }
        let Some(name) = event.data["name"].as_str() else {
            return;
        };
        let arg = event.data.get("arg").cloned().unwrap_or(Value::Null);
        match name {
            "status" => {
                let Some(status) = arg["status"].as_str() else {
                    return;
                };
                if !matches!(
                    status,
                    "asleep" | "starting" | "ready" | "error" | "exited" | "restarting" | "waiting"
                ) {
                    return;
                }
                let omp = arg["omp"]
                    .as_str()
                    .filter(|omp| !omp.is_empty())
                    .map(str::to_owned);
                if self.reattaching && (omp.is_none() || omp != self.omp) {
                    self.status("starting", json!({}), true);
                }
                if omp != self.omp {
                    self.queued.clear();
                    let mut snapshot = self.snapshot.lock().unwrap_or_else(|p| p.into_inner());
                    snapshot.generation += 1;
                    snapshot.omp = omp.clone();
                    snapshot.bridge = Value::Null;
                }
                self.omp = omp;
                {
                    let mut snapshot = self.snapshot.lock().unwrap_or_else(|p| p.into_inner());
                    snapshot.process_alive = arg["processAlive"].as_bool().unwrap_or(false);
                    if let Some(cwd) = arg["cwd"].as_str() {
                        snapshot.cwd = cwd.into();
                        self.options.cwd = cwd.into();
                    }
                }
                if let Some(run) = self.reattach_run.take() {
                    self.emit("hostRun", run, false);
                }
                self.status(
                    status,
                    arg.get("statusPayload")
                        .filter(|v| v.is_object())
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                    false,
                );
            }
            "run" => {
                if self.reattaching {
                    self.reattach_run = Some(arg);
                } else {
                    self.emit("hostRun", arg, false);
                }
            }
            "session" => {
                self.options.session_path = arg["sessionFile"].as_str().map(str::to_owned);
                self.snapshot
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .session_path = self.options.session_path.clone();
                self.emit(name, arg, false);
            }
            "bridge" => {
                self.snapshot
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .bridge = arg.clone();
                self.emit(name, arg, false);
            }
            "signIn" => {
                let Some(active) = arg["active"]
                    .as_array()
                    .filter(|active| active.iter().all(Value::is_string))
                else {
                    return;
                };
                self.signing_in = !active.is_empty();
                if !self.signing_in {
                    self.end_relay();
                }
                self.emit(name, arg, false);
            }
            "extensionUi" => {
                self.start_relay(&arg);
                self.emit(name, arg, false);
            }
            "events" => {
                if let Some(events) = arg.as_array() {
                    let decoded = self.decoder.events(events).into_owned();
                    self.emit(name, Value::Array(decoded), false);
                }
            }
            "subagentFrame" => {
                for frame in arg
                    .as_array()
                    .map_or_else(|| vec![&arg], |frames| frames.iter().collect())
                {
                    if let Some(decoded) = self.decoder.subagent_frame(frame) {
                        self.emit(name, decoded.into_owned(), false);
                    }
                }
            }
            "scheduledRetry" => {
                let retry = if arg.is_null() {
                    Value::Null
                } else if let (Some(remaining), Some(attempt)) =
                    (arg["remainingMs"].as_f64(), arg["attempt"].as_u64())
                {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0.0, |time| time.as_secs_f64() * 1000.0);
                    let mut retry = json!({"at":now+remaining,"attempt":attempt});
                    if arg["limit"] == true {
                        retry["limit"] = true.into();
                    }
                    retry
                } else {
                    return;
                };
                self.emit(name, retry, false);
            }
            _ => self.emit(name, arg, false),
        }
    }
    fn end_relay(&mut self) {
        self.relay_generation += 1;
        if self.relay.take().is_some() {
            self.emit("signInRelay", Value::Null, false);
        }
    }
    fn start_relay(&mut self, request: &Value) {
        if !self.signing_in || request["method"] != "open_url" || !request["launchUrl"].is_string()
        {
            return;
        }
        let Some(url) = request["url"].as_str() else {
            return;
        };
        self.end_relay();
        let generation = self.relay_generation;
        let inbox = self.inbox.clone();
        let forward: Forward = Arc::new(move |path, query| {
            let inbox = inbox.clone();
            Box::pin(async move {
                let (answer, result) = oneshot::channel();
                inbox
                    .send(Input::ForwardSignIn(generation, path, query, answer))
                    .map_err(|_| offline().fault)?;
                result.await.unwrap_or_else(|_| Err(offline().fault))
            })
        });
        let inbox = self.inbox.clone();
        let ended = Arc::new(move || {
            let _ = inbox.send(Input::RelayEnded(generation));
        });
        let Some(relay) =
            NativeRelay::prepare(url, forward, self.options.sign_in_failure.clone(), ended)
        else {
            return;
        };
        let listen = relay.listen();
        self.relay = Some(relay);
        let inbox = self.inbox.clone();
        self.work.spawn(async move {
            let _ = inbox.send(Input::RelayListening(generation, listen.await));
        });
    }
    async fn run(mut self, mut receiver: mpsc::UnboundedReceiver<Input>) -> Result<(), Fault> {
        let mut failure = None;
        while let Some(input) = receiver.recv().await {
            while let Some(result) = self.work.try_join_next() {
                if let Err(error) = result {
                    failure.get_or_insert_with(|| Fault::new("remote_task", error.to_string()));
                }
            }
            match input {
                Input::Start => {
                    self.wanted = true;
                    self.status("starting", json!({}), true);
                    if self.link.is_online() {
                        self.open();
                    } else {
                        self.lost();
                    }
                }
                Input::Restart { cwd, session } => {
                    let first = self
                        .snapshot
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .status
                        == "asleep";
                    if let Some(cwd) = &cwd {
                        self.options.cwd = cwd.clone();
                    }
                    self.options.session_path = session.clone();
                    self.wanted = true;
                    if !first {
                        self.restart = Some((cwd, session));
                    }
                    self.status("starting", json!({}), true);
                    if matches!(self.phase, BringUp::Open) {
                        self.start_opened(true);
                    } else {
                        self.open();
                    }
                }
                Input::Link(link) => {
                    self.epoch += 1;
                    {
                        let mut snapshot = self.snapshot.lock().unwrap_or_else(|p| p.into_inner());
                        snapshot.generation += 1;
                        snapshot.bridge = Value::Null;
                        snapshot.connection = link.clone();
                        snapshot.process_alive = false;
                    }
                    self.lost();
                    self.link = link;
                    self.watch_link();
                    if self.wanted && self.link.is_online() {
                        self.status("starting", json!({"reconnecting":self.omp.is_some()}), true);
                        self.open();
                    }
                }
                Input::Lost(epoch) if epoch == self.epoch => self.lost(),
                Input::Event(epoch, event) if epoch == self.epoch => self.event(event),
                Input::Opened(epoch, result) if epoch == self.epoch && self.link.is_online() => {
                    match result {
                        Ok(opened)
                            if opened["cwd"].is_string()
                                && matches!(opened["kind"].as_str(), Some("agent" | "chat"))
                                && opened["attached"].is_boolean() =>
                        {
                            self.phase = BringUp::Open;
                            self.bound_omp = opened["boundOmp"] == true;
                            self.options.cwd = opened["cwd"].as_str().unwrap_or_default().into();
                            self.snapshot.lock().unwrap_or_else(|p| p.into_inner()).cwd =
                                self.options.cwd.clone();
                            let attached = opened["attached"] == true;
                            {
                                let mut snapshot =
                                    self.snapshot.lock().unwrap_or_else(|p| p.into_inner());
                                let shared = opened["viewing"] == true;
                                if snapshot.shared != shared {
                                    snapshot.shared = shared;
                                    drop(snapshot);
                                    self.emit("shared", json!(shared), false);
                                }
                            }
                            if attached {
                                while let Some((omp, frame)) = self.queued.pop_front() {
                                    if omp == self.omp {
                                        let (answer, _) = oneshot::channel();
                                        self.deliver(None, frame, answer);
                                    }
                                }
                            } else {
                                self.queued.clear();
                            }
                            self.start_opened(attached);
                            while let Some(input) = self.waiting.pop_front() {
                                let _ = self.inbox.send(input);
                            }
                        }
                        Ok(_) => {
                            self.failed(Fault::new("protocol", "Invalid tab.open response").into())
                        }
                        Err(error) => {
                            self.phase = BringUp::Closed;
                            self.failed(error);
                        }
                    }
                }
                Input::Started(epoch, Err(error)) if epoch == self.epoch => self.failed(error),
                Input::AdoptCwd(cwd) => {
                    self.options.cwd = cwd.clone();
                    let _ = self
                        .inbox
                        .send(Input::Notify("tab.adoptCwd", json!({"cwd":cwd})));
                }
                Input::Check(generation, answer) => {
                    let _ = answer.send(self.check_generation(Some(generation)));
                }
                Input::Bridge(expected, method, answer) => {
                    let result = self.check_generation(expected).and_then(|()| {
                        let snapshot = self.snapshot.lock().unwrap_or_else(|p| p.into_inner());
                        if method != "capabilities" {
                            Err(Fault::new("remote_bridge_method", format!("Bridge method {method} is not available remotely")).into())
                        } else if snapshot.bridge["connected"] != true {
                            Err(Fault::new("bridge_disconnected", "The remote tab's bridge is not connected").into())
                        } else {
                            Ok(json!({"ompVersion":snapshot.bridge["ompVersion"],"unavailable":snapshot.bridge["unavailable"]}))
                        }
                    });
                    let _ = answer.send(result);
                }
                Input::CachedCommand(tab, generation, command, timeout, answer) => {
                    if let Err(error) = self.check_generation(Some(generation)) {
                        let _ = answer.send(Err(error));
                    } else {
                        self.work.spawn(async move {
                            let result =
                                tab.command_inner(command, timeout, Some(generation)).await;
                            let _ = answer.send(result);
                        });
                    }
                }
                Input::Command(expected, command, timeout, answer) => {
                    if let Err(error) = self.check_generation(expected) {
                        let _ = answer.send(Err(error));
                    } else if !self.link.is_online() {
                        let _ = answer.send(Err(offline()));
                    } else if matches!(self.phase, BringUp::Open) {
                        self.read(expected, command, timeout, false, answer);
                    } else {
                        self.waiting
                            .push_back(Input::Command(expected, command, timeout, answer));
                        self.open();
                    }
                }
                Input::ReadDone(epoch, expected, command, timeout, fresh, answer, result) => {
                    if epoch != self.epoch {
                        let _ = answer.send(Err(offline()));
                        continue;
                    }
                    if let Err(error) = self.check_generation(expected) {
                        let _ = answer.send(Err(error));
                        continue;
                    }
                    match result {
                        Ok(mut response) if response["success"] == true => {
                            if let Some((key, _)) = encoded_read_key(&command) {
                                match self.reads.entry(key).or_default().decode(&response["data"]) {
                                    Some(data) => response["data"] = data,
                                    None if !fresh => {
                                        self.read(expected, command, timeout, true, answer);
                                        continue;
                                    }
                                    None => {
                                        let _ = answer.send(Err(Fault::new(
                                            "protocol",
                                            "Cannot rebuild remote read",
                                        )
                                        .into()));
                                        continue;
                                    }
                                }
                            }
                            let _ = answer.send(Ok(response));
                        }
                        result => {
                            let _ = answer.send(result);
                        }
                    }
                }
                Input::SideChannel(expected, frame, answer) => {
                    if let Err(error) = self.check_generation(expected) {
                        let _ = answer.send(Err(error));
                    } else if !self.link.is_online() {
                        if expected.is_none() && replayable(&frame) {
                            self.queue(frame);
                            let _ = answer.send(Ok(Value::Null));
                        } else {
                            let _ = answer.send(Err(offline()));
                        }
                    } else if matches!(self.phase, BringUp::Open) {
                        self.deliver(expected, frame, answer);
                    } else {
                        self.waiting
                            .push_back(Input::SideChannel(expected, frame, answer));
                        self.open();
                    }
                }
                Input::Delivered(epoch, omp, expected, frame, answer, result) => {
                    let result = if let Err(error) = self.check_generation(expected) {
                        Err(error)
                    } else if epoch != self.epoch {
                        Err(offline())
                    } else {
                        result
                    };
                    match result {
                        Err(error)
                            if expected.is_none()
                                && replayable(&frame)
                                && error.fault.code == "remote_offline" =>
                        {
                            if omp == self.omp {
                                self.queued.push_back((omp, frame));
                                if self.queued.len() > MAX_REPLIES {
                                    self.queued.pop_front();
                                }
                            }
                            let _ = answer.send(Ok(Value::Null));
                        }
                        Ok(value) => {
                            if frame["type"] == "host_tool_result" && frame["id"].is_string() {
                                self.emit("hostReplyDelivered", frame["id"].clone(), false);
                            }
                            let _ = answer.send(Ok(value));
                        }
                        Err(error) => {
                            let _ = answer.send(Err(error));
                        }
                    }
                }
                Input::CancelWait(answer) => {
                    if !self.link.is_online() {
                        let _ = answer.send(Err(offline()));
                    } else if matches!(self.phase, BringUp::Open) {
                        let link = self.link.clone();
                        let params = json!({"rtab":self.options.rtab});
                        self.work.spawn(async move {
                            let _ =
                                answer.send(link.request("tab.cancelWait", params, REQUEST).await);
                        });
                    } else {
                        self.waiting.push_back(Input::CancelWait(answer));
                        self.open();
                    }
                }
                Input::ForwardSignIn(generation, path, query, answer) => {
                    if generation != self.relay_generation
                        || self.relay.is_none()
                        || !self.link.is_online()
                    {
                        let _ = answer.send(Err(offline().fault));
                    } else if matches!(self.phase, BringUp::Open) {
                        let link = self.link.clone();
                        let params = json!({"rtab":self.options.rtab,"path":path,"query":query});
                        self.work.spawn(async move {
                            let result = link
                                .request("host.signIn.callback", params, REQUEST)
                                .await
                                .map_err(|error| error.fault)
                                .and_then(|value| {
                                    serde_json::from_value::<Page>(value)
                                        .map_err(|error| Fault::new("protocol", error.to_string()))
                                });
                            let _ = answer.send(result);
                        });
                    } else {
                        self.waiting
                            .push_back(Input::ForwardSignIn(generation, path, query, answer));
                        self.open();
                    }
                }
                Input::RelayListening(generation, state) if generation == self.relay_generation => {
                    match state {
                        ListenState::Listening => {
                            self.emit("signInRelay", json!({"listening":true}), false)
                        }
                        ListenState::Busy(port) => {
                            self.emit("signInRelay", json!({"listening":false,"port":port}), false)
                        }
                        ListenState::Closed => {}
                    }
                }
                Input::RelayEnded(generation) if generation == self.relay_generation => {
                    self.end_relay()
                }
                Input::Notify(method, mut params)
                    if self.link.is_online() && matches!(self.phase, BringUp::Open) =>
                {
                    params["rtab"] = self.options.rtab.clone().into();
                    let link = self.link.clone();
                    self.work.spawn(async move {
                        let _ = link.request(method, params, REQUEST).await;
                    });
                }
                Input::Dispose(keep) => {
                    receiver.close();
                    while let Ok(pending) = receiver.try_recv() {
                        drop(pending);
                    }
                    self.end_relay();
                    self.watchers.abort_all();
                    while self.watchers.join_next().await.is_some() {}
                    while let Some(result) = self.work.join_next().await {
                        if let Err(error) = result {
                            failure.get_or_insert_with(|| {
                                Fault::new("remote_task", error.to_string())
                            });
                        }
                    }
                    if self.opened_once && !keep {
                        self.closes.defer(self.options.rtab.clone());
                        if let Err(error) = self.closes.flush_result(&self.link).await {
                            failure.get_or_insert(error);
                        }
                    }
                    break;
                }
                _ => {}
            }
        }
        failure.map_or(Ok(()), Err)
    }
}

/// Pending closes belong to the host, not a tab instance. Reopening an id cancels an older close.
#[derive(Default)]
pub struct PendingTabCloses(Mutex<Closes>);
#[derive(Default)]
struct Closes {
    serial: u64,
    tabs: HashMap<String, u64>,
    turns: HashMap<String, Arc<AsyncMutex<()>>>,
}
struct CloseTurn<'a> {
    pending: &'a PendingTabCloses,
    rtab: &'a str,
    gate: Arc<AsyncMutex<()>>,
}
impl Drop for CloseTurn<'_> {
    fn drop(&mut self) {
        let mut pending = self.pending.0.lock().unwrap_or_else(|p| p.into_inner());
        if Arc::strong_count(&self.gate) == 2 {
            pending.turns.remove(self.rtab);
        }
    }
}
impl PendingTabCloses {
    fn turn<'a>(&'a self, rtab: &'a str) -> CloseTurn<'a> {
        let mut pending = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let gate = match pending.turns.get(rtab) {
            Some(gate) => Arc::clone(gate),
            None => {
                let gate = Arc::new(AsyncMutex::new(()));
                pending.turns.insert(rtab.to_owned(), Arc::clone(&gate));
                gate
            }
        };
        CloseTurn {
            pending: self,
            rtab,
            gate,
        }
    }
    async fn open(&self, link: &RemoteRequests, params: Value) -> Result<Value, RemoteError> {
        let rtab = params["rtab"]
            .as_str()
            .ok_or_else(|| Fault::new("invalid_params", "Invalid rtab"))?
            .to_owned();
        let turn = self.turn(&rtab);
        let _held = turn.gate.lock().await;
        self.cancel(&rtab);
        link.request("tab.open", params, REQUEST).await
    }
    pub fn defer(&self, rtab: String) {
        let mut pending = self.0.lock().unwrap_or_else(|p| p.into_inner());
        pending.serial += 1;
        let serial = pending.serial;
        pending.tabs.insert(rtab, serial);
    }
    pub fn cancel(&self, rtab: &str) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .tabs
            .remove(rtab);
    }
    pub async fn flush(&self, link: &RemoteRequests) {
        let _ = self.flush_result(link).await;
    }
    async fn flush_result(&self, link: &RemoteRequests) -> Result<(), Fault> {
        let mut failure = None;
        let pending = self
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .tabs
            .clone();
        for (rtab, serial) in pending {
            let turn = self.turn(&rtab);
            let _held = turn.gate.lock().await;
            if self
                .0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .tabs
                .get(&rtab)
                != Some(&serial)
            {
                continue;
            }
            let result = link
                .request("tab.close", json!({"rtab":rtab}), REQUEST)
                .await;
            if let Err(error) = &result {
                failure.get_or_insert_with(|| error.fault.clone());
            }
            if result
                .as_ref()
                .is_err_and(|error| error.fault.code == "remote_offline")
            {
                continue;
            }
            let mut current = self.0.lock().unwrap_or_else(|p| p.into_inner());
            if current.tabs.get(&rtab) == Some(&serial) {
                current.tabs.remove(&rtab);
            }
        }
        failure.map_or(Ok(()), Err)
    }
}

#[cfg(test)]
mod tests;

fn is_worktree_folder(path: &str) -> bool {
    let Some(name) = path
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .and_then(|name| name.strip_prefix("gui-"))
    else {
        return false;
    };
    name.rsplit_once('-').is_some_and(|(name, hash)| {
        !name.is_empty()
            && hash.len() == 7
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}
