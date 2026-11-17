mod accessibility;
pub(crate) mod cleanup;
mod commands;
mod contexts;
mod dialogs;
mod events;
mod frame_scope;
mod frames;
mod initialize;
mod input;
#[cfg(any(windows, test))]
pub(super) mod media;
mod navigation;
mod surface;
mod target;
mod text_queries;
mod view;

use crate::preview_surface as native;
use crate::{
    host,
    registry::{Identity, Kind},
    runtime, wc_event, wc_state,
};
use serde_json::{Value, json};
use shell_core::wire::WireError;
use shell_preview::{Browser, LaunchConfig, Navigation, NavigationHandler, Page, Viewport};
use std::collections::{HashMap, HashSet};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

struct Document {
    frame: Option<String>,
    loader: Option<String>,
    main_world: contexts::MainWorld,
    watches: HashSet<String>,
    debugger: Option<String>,
    viewport: Viewport,
    painting: bool,
    fps: u32,
    frame_pixels: Option<frames::Frame>,
    native_geometry: Option<native::FrameGeometry>,
    last_paint: Option<Instant>,
    pending_ack: Option<i64>,
    navigation: navigation::Pending,
    last_failure: Option<(u64, String)>,
    layout: Option<ViewLayout>,
    marked: Option<native::TextRange>,
    selection: native::TextRange,
    text_target: Option<Arc<frame_scope::FocusedTarget>>,
    native_contexts: contexts::BindingContexts,
}
struct ViewLayout {
    bounds: native::Rect,
    visible: bool,
}
struct Entry {
    page: Arc<Page>,
    partition: String,
    /// The actual BrowserContext this page lives in: a per-page one for an `omp-visual` partition,
    /// otherwise the partition's shared canonical context.
    context: shell_preview::Partition,
    closing: tokio::sync::Mutex<()>,
    surface_change: tokio::sync::Mutex<()>,
    document: Mutex<Document>,
    /// Taken before `document` and before the registry, never after either: a navigation's submission and its
    /// load number move together, and a failure's admission holds it through the UI's publication.
    loads: Mutex<navigation::Loads>,
    publisher: Mutex<Option<native::FramePublisher>>,
    submitting: Mutex<()>,
    surface_acks: Mutex<HashSet<(u64, i64)>>,
    surface_ack_tasks: Mutex<Vec<oneshot::Receiver<Result<(), String>>>>,
    surface_ack_errors: Mutex<Vec<String>>,
    ax_snapshot: Mutex<Option<Arc<native::AxSnapshot>>>,
    refresh_flags: AtomicU8,
    refresh_queued: AtomicBool,
}
#[derive(Clone)]
struct Route {
    wc: u64,
    debugger: Option<String>,
    iframe: bool,
}
#[derive(Default)]
struct Pages {
    entries: Mutex<HashMap<u64, Arc<Entry>>>,
    routes: Mutex<HashMap<String, Route>>,
    browser: OnceLock<Arc<Browser>>,
    dialogs: dialogs::Dialogs,
}
impl Pages {
    fn entry(&self, wc: u64) -> Result<Arc<Entry>, WireError> {
        self.entries
            .lock()
            .expect("Preview pages")
            .get(&wc)
            .cloned()
            .ok_or_else(|| WireError::new("gone", "Preview page ended"))
    }
    fn current(&self, wc: u64) -> Result<Identity, WireError> {
        runtime()
            .registry
            .lock()
            .expect("registry")
            .page(wc)
            .filter(|page| page.state == crate::registry::PageState::Live && page.kind != Kind::App)
            .map(|page| page.identity)
            .ok_or_else(|| WireError::new("gone", "Preview identity ended"))
    }
}
struct NavigationGate(Arc<Pages>);
impl NavigationHandler for NavigationGate {
    fn allow(&self, navigation: Navigation) -> Pin<Box<dyn Future<Output = bool> + Send>> {
        let pages = Arc::clone(&self.0);
        Box::pin(async move {
            let route = pages
                .routes
                .lock()
                .expect("Preview routes")
                .get(&navigation.session_id)
                .cloned();
            let Some(route) = route else {
                return false;
            };
            let Ok(identity) = pages.current(route.wc) else {
                return false;
            };
            let Ok(entry) = pages.entry(route.wc) else {
                return false;
            };
            let url = match runtime()
                .gateway
                .original_url(&entry.partition, &navigation.url)
                .await
            {
                Ok(Some(url)) => url,
                Ok(None) => navigation.url.clone(),
                Err(_) => return false,
            };
            let (main, watched) = {
                let document = entry.document.lock().expect("Preview document");
                (
                    document.frame.as_deref() == Some(&navigation.frame_id),
                    ["will-frame-navigate", "will-navigate"]
                        .into_iter()
                        .filter(|name| document.watches.contains(*name))
                        .collect::<Vec<_>>(),
                )
            };
            for kind in watched {
                if kind == "will-navigate" && !main {
                    continue;
                }
                let (send, receive) = oneshot::channel();
                host::request(
                    "wc.navigate",
                    json!({"wcId":route.wc,"kind":kind,"url":url,
                    "isMainFrame":main,"isSameDocument":false,"isRedirect":kind=="will-redirect"}),
                    None,
                    move |answer, _| {
                        let _ = send.send(answer);
                    },
                );
                if !matches!(tokio::time::timeout(Duration::from_secs(2), receive).await,
                    Ok(Ok(Ok(answer))) if answer["prevent"].as_bool() == Some(false))
                {
                    return false;
                }
                if !runtime()
                    .registry
                    .lock()
                    .expect("registry")
                    .current(identity)
                {
                    return false;
                }
            }
            true
        })
    }
}

const TEXT: u8 = 1;
const AX: u8 = 2;
enum NativeTask {
    Input {
        key: native::SurfaceKey,
        input: native::Input,
        geometry: Option<native::FrameGeometry>,
        focus: Option<Arc<frame_scope::FocusedTarget>>,
    },
    Accessibility {
        key: native::SurfaceKey,
        generation: u64,
        target: native::AxTarget,
        action: native::AxAction,
    },
    Refresh {
        key: native::SurfaceKey,
    },
    Failure {
        key: native::SurfaceKey,
        message: String,
    },
}
enum Message {
    Node(Queued),
    Native(NativeTask),
    CloseParent {
        win: u64,
        done: oneshot::Sender<Result<(), WireError>>,
    },
}
struct Queued {
    call: host::Call,
    cancelled: oneshot::Receiver<()>,
    identity: Option<Identity>,
    script: Option<ScriptDocument>,
}
struct PendingEvaluation(Option<host::Call>);
impl Drop for PendingEvaluation {
    fn drop(&mut self) {
        if let Some(call) = self.0.take() {
            host::forget_cancel(call.id());
            call.err("cancelled", "Preview evaluation ended before its reply");
        }
    }
}

struct ScriptDocument {
    wc: u64,
    entry: Arc<Entry>,
    context: Arc<str>,
}
impl ScriptDocument {
    fn capture(pages: &Pages, call: &host::Call) -> Option<Self> {
        if call.method != "wc.op" || call.params["op"].as_str() != Some("executeJavaScript") {
            return None;
        }
        let wc = call.params["wcId"].as_u64()?;
        let entry = pages.entry(wc).ok()?;
        let context = entry
            .document
            .lock()
            .expect("Preview document")
            .main_world
            .capture()?;
        Some(Self { wc, entry, context })
    }
    fn valid(&self, pages: &Pages) -> Result<(), WireError> {
        pages.current(self.wc)?;
        let entry = pages.entry(self.wc)?;
        if Arc::ptr_eq(&self.entry, &entry)
            && entry
                .document
                .lock()
                .expect("Preview document")
                .main_world
                .owns(&self.context)
        {
            Ok(())
        } else {
            Err(WireError::new(
                "gone",
                "original Preview execution context ended",
            ))
        }
    }
}

fn awaits_cdp_script(params: &Value) -> bool {
    params["method"].as_str() == Some("Runtime.awaitPromise")
        || (matches!(
            params["method"].as_str(),
            Some("Runtime.evaluate" | "Runtime.callFunctionOn" | "Runtime.runScript")
        ) && params
            .pointer("/params/awaitPromise")
            .and_then(Value::as_bool)
            == Some(true))
}
pub struct Service {
    send: mpsc::UnboundedSender<Message>,
    pages: Arc<Pages>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    joined: Mutex<Option<oneshot::Receiver<Result<(), String>>>>,
}
impl Service {
    pub fn new(
        resources: std::path::PathBuf,
        packaged: bool,
        profile_root: std::path::PathBuf,
    ) -> Self {
        let (send, receive) = mpsc::unbounded_channel();
        let (stop, stopped) = oneshot::channel();
        let (finished, joined) = oneshot::channel();
        let pages = Arc::new(Pages::default());
        let actor_pages = Arc::clone(&pages);
        tauri::async_runtime::spawn(async move {
            let result = serve(
                resources,
                packaged,
                profile_root,
                actor_pages,
                receive,
                stopped,
            )
            .await;
            let _ = finished.send(result);
        });
        Self {
            send,
            pages,
            stop: Mutex::new(Some(stop)),
            joined: Mutex::new(Some(joined)),
        }
    }
    pub fn submit(&self, call: host::Call) {
        let id = call.id();
        if call.method == "wc.op"
            && let (Some(wc), Some(op @ ("loadURL" | "stop"))) =
                (call.params["wcId"].as_u64(), call.params["op"].as_str())
        {
            log_navigation("preview.navigation.queued", wc, op, None);
        }
        let (cancel, cancelled) = oneshot::channel();
        host::on_cancel(id, move || {
            let _ = cancel.send(());
        });
        let identity = request_identity(&call);
        let script = ScriptDocument::capture(&self.pages, &call);
        if let Err(error) = self.send.send(Message::Node(Queued {
            call,
            cancelled,
            identity,
            script,
        })) {
            host::forget_cancel(id);
            if let Message::Node(queued) = error.0 {
                queued.call.err("gone", "Preview service stopped");
            }
        }
    }
    fn native(&self, task: NativeTask) -> Result<(), native::SurfaceError> {
        self.send
            .send(Message::Native(task))
            .map_err(|_| native::SurfaceError::Disposed)
    }
    pub async fn close_parent(&self, win: u64) -> Result<(), WireError> {
        let (done, receive) = oneshot::channel();
        self.send
            .send(Message::CloseParent { win, done })
            .map_err(|_| WireError::new("gone", "Preview service stopped"))?;
        receive
            .await
            .map_err(|_| WireError::new("gone", "Preview service stopped"))?
    }
    pub async fn shutdown(&self) -> Result<(), String> {
        if let Some(stop) = self.stop.lock().expect("Preview stop").take() {
            let _ = stop.send(());
        }
        let joined = self.joined.lock().expect("Preview join").take();
        if let Some(joined) = joined {
            joined
                .await
                .map_err(|_| "Preview service ended without exit receipt".to_owned())??;
        }
        Ok(())
    }
}
fn wire(error: shell_preview::Error) -> WireError {
    WireError::new(error.code, error.message)
}
fn original(identity: Identity) -> Result<(), WireError> {
    if runtime()
        .registry
        .lock()
        .expect("registry")
        .current(identity)
    {
        Ok(())
    } else {
        Err(WireError::new("gone", "original Preview document ended"))
    }
}
fn owns(pages: &Pages, wc: u64, entry: &Arc<Entry>) -> Result<(), WireError> {
    pages.current(wc)?;
    if Arc::ptr_eq(entry, &pages.entry(wc)?) {
        Ok(())
    } else {
        Err(WireError::new("gone", "original Preview owner ended"))
    }
}
async fn serve(
    resources: std::path::PathBuf,
    packaged: bool,
    profile_root: std::path::PathBuf,
    pages: Arc<Pages>,
    mut receive: mpsc::UnboundedReceiver<Message>,
    mut stopped: oneshot::Receiver<()>,
) -> Result<(), String> {
    let mut browser: Option<Arc<Browser>> = None;
    let mut observer = None;
    let mut failure = None;
    let mut evaluations = tokio::task::JoinSet::new();
    loop {
        let message = tokio::select! {
            _ = &mut stopped => break,
            finished = evaluations.join_next(), if !evaluations.is_empty() => {
                if let Some(Err(error)) = finished {
                    failure = Some(format!("Preview evaluation task: {error}"));
                    break;
                }
                continue;
            },
            call = receive.recv() => match call { Some(call) => call, None => break },
        };
        let Queued {
            call,
            mut cancelled,
            identity,
            script,
        } = match message {
            Message::Node(queued) => queued,
            Message::Native(task) => {
                native_task(&pages, task).await;
                continue;
            }
            Message::CloseParent { win, done } => {
                let children = runtime().registry.lock().expect("registry").children(win);
                let mut errors = Vec::new();
                for wc in children {
                    if let Err(error) = close(&pages, wc).await {
                        errors.push(format!("page {wc}: {}", error.message));
                    }
                }
                let result = if errors.is_empty() {
                    Ok(())
                } else {
                    Err(WireError::new("cleanup", errors.join("; ")))
                };
                let _ = done.send(result);
                continue;
            }
        };
        let id = call.id();
        if cancelled.try_recv().is_ok() {
            host::forget_cancel(id);
            if matches!(call.method.as_str(), "view.create" | "win.create")
                && let Some(wc) = call.params["wcId"].as_u64()
            {
                crate::close_record(wc);
            }
            call.err("cancelled", "Preview request cancelled before execution");
            continue;
        }
        if browser.is_none() {
            let launched = async {
                let executable = crate::runtime_inputs::preview_binary(&resources, packaged)
                    .map_err(|message| WireError::new("runtime-missing", message))?;
                Browser::launch_with_hooks(
                    LaunchConfig {
                        executable,
                        profile_root: profile_root.clone(),
                        command_timeout: Duration::from_secs(30),
                    },
                    Arc::new(NavigationGate(Arc::clone(&pages))),
                    Arc::new(initialize::Initializer),
                )
                .await
                .map_err(wire)
            };
            let launched = launched.await;
            match launched {
                Ok(value) => {
                    let value = Arc::new(value);
                    browser = Some(Arc::clone(&value));
                    if let Err(error) = crate::sessions::preview::install(
                        Arc::clone(&value),
                        Arc::clone(&runtime().gateway),
                    ) {
                        call.err("failed", error.clone());
                        host::forget_cancel(id);
                        failure = Some(error);
                        break;
                    }
                    let _ = pages.browser.set(Arc::clone(&value));
                    pages
                        .dialogs
                        .install(Arc::new(dialogs::Live::new(Arc::clone(&value))));
                    let events = value.subscribe();
                    observer = Some(tauri::async_runtime::spawn(observe(
                        Arc::clone(&pages),
                        events,
                    )));
                    if let Err(error) = value
                        .command("Target.setDiscoverTargets", json!({"discover":true}), None)
                        .await
                    {
                        host::forget_cancel(id);
                        failure = Some(format!(
                            "target discovery: {}: {}",
                            error.code, error.message
                        ));
                        call.err(error.code, error.message);
                        break;
                    }
                }
                Err(error) => {
                    host::forget_cancel(id);
                    if matches!(call.method.as_str(), "view.create" | "win.create")
                        && let Some(wc) = call.params["wcId"].as_u64()
                    {
                        crate::close_record(wc);
                    }
                    call.err(&error.code, error.message);
                    continue;
                }
            }
        }
        if cancelled.try_recv().is_ok() {
            host::forget_cancel(id);
            if matches!(call.method.as_str(), "view.create" | "win.create")
                && let Some(wc) = call.params["wcId"].as_u64()
            {
                crate::close_record(wc);
            }
            call.err("cancelled", "Preview request cancelled before execution");
            continue;
        }
        if call.method.starts_with("session.") {
            let app = runtime().app.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                if let Some(call) = crate::sessions::dispatch_with_cancel(call, cancelled) {
                    host::forget_cancel(call.id());
                    call.unsupported();
                }
            }) {
                host::forget_cancel(id);
                crate::log::log(
                    "preview.session.dispatch",
                    json!({"error":error.to_string()}),
                );
            }
            continue;
        }
        let browser = browser.as_ref().expect("launched Preview");
        match execute(
            browser,
            &pages,
            &call.method,
            &call.params,
            identity,
            script,
        )
        .await
        {
            Ok(Execution::Awaiting(evaluation)) => {
                let pages = Arc::clone(&pages);
                let mut request = PendingEvaluation(Some(call));
                evaluations.spawn(async move {
                    let result = tokio::select! {
                        biased;
                        _ = &mut cancelled => Err(WireError::new("cancelled", "Preview evaluation cancelled")),
                        result = evaluation.receive(&pages) => result,
                    };
                    answer_call(&pages, request.0.take().expect("owned evaluation"), result).await;
                });
            }
            Ok(Execution::Complete(answer)) => answer_call(&pages, call, Ok(answer)).await,
            Err(error) => answer_call(&pages, call, Err(error)).await,
        }
    }
    evaluations.abort_all();
    while evaluations.join_next().await.is_some() {}
    receive.close();
    while let Ok(message) = receive.try_recv() {
        let Queued { call, .. } = match message {
            Message::Node(queued) => queued,
            Message::CloseParent { done, .. } => {
                let _ = done.send(Err(WireError::new("gone", "Preview service is stopping")));
                continue;
            }
            Message::Native(_) => continue,
        };
        host::forget_cancel(call.id());
        if matches!(call.method.as_str(), "view.create" | "win.create")
            && let Some(wc) = call.params["wcId"].as_u64()
        {
            crate::close_record(wc);
        }
        call.err("gone", "Preview service is stopping");
    }
    let contents: Vec<_> = pages
        .entries
        .lock()
        .expect("Preview pages")
        .keys()
        .copied()
        .collect();
    let pages_cleanup = async {
        let mut errors = Vec::new();
        for wc in contents {
            if let Err(error) = close(&pages, wc).await {
                errors.push(format!("page {wc}: {}", error.message));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    };
    let browser_cleanup = async {
        if let Some(browser) = browser {
            let status = browser
                .shutdown()
                .await
                .map_err(|error| format!("browser: {error}"))?;
            if !status.success() {
                return Err(format!("browser exited unsuccessfully: {status}"));
            }
        }
        Ok(())
    };
    let mut result = cleanup::settle(pages_cleanup, browser_cleanup).await;
    if let Some(failure) = failure {
        result = cleanup::settle(async { Err(failure) }, async { result }).await;
    }
    if let Some(observer) = observer {
        observer.abort();
        match observer.await {
            Ok(()) => {}
            Err(tauri::Error::JoinError(error)) if error.is_cancelled() => {}
            Err(error) => {
                result = cleanup::settle(async { result }, async {
                    Err(format!("observer: {error}"))
                })
                .await;
            }
        }
    }
    result
}

enum Answer {
    Json(Value),
    Binary(Value, Arc<Vec<u8>>, Arc<Page>, Option<i64>),
}

enum Execution {
    Complete(Answer),
    Awaiting(Evaluation),
}
enum EvaluationKind {
    JavaScript(ScriptDocument),
    Cdp(Arc<Entry>),
    Input(Arc<Entry>, Option<&'static str>),
    Navigate(Arc<Entry>),
    Load {
        entry: Arc<Entry>,
        load: u64,
        url: String,
    },
}
struct Evaluation {
    reply: shell_preview::CommandReply,
    identity: Identity,
    kind: EvaluationKind,
}
impl Evaluation {
    async fn receive(self, pages: &Pages) -> Result<Answer, WireError> {
        let mut answer = self.reply.receive().await.map_err(wire)?;
        if let EvaluationKind::Cdp(entry) | EvaluationKind::Navigate(entry) = &self.kind {
            unmap_urls(&entry.partition, &mut answer)
                .await
                .map_err(crate::failed)?;
        }
        let result = match self.kind {
            EvaluationKind::JavaScript(document) => {
                document.valid(pages)?;
                if let Some(error) = answer.get("exceptionDetails") {
                    return Err(WireError::new("failed", error.to_string()));
                }
                json!({"result":answer.pointer("/result/value").cloned().unwrap_or(Value::Null)})
            }
            EvaluationKind::Cdp(_) => {
                original(self.identity)?;
                json!({"result":answer})
            }
            EvaluationKind::Input(entry, release) => {
                let wc = self.identity.wc;
                owns(pages, wc, &entry)?;
                if let Some(kind) = release {
                    wc_event(wc, "input-event", json!([{"type":kind}]));
                }
                json!({"result":answer})
            }
            EvaluationKind::Navigate(entry) => {
                owns(pages, self.identity.wc, &entry)?;
                json!({"result":answer})
            }
            EvaluationKind::Load { entry, load, url } => {
                let wc = self.identity.wc;
                owns(pages, wc, &entry)?;
                let Some(error) = answer["errorText"].as_str() else {
                    log_navigation("preview.navigation.reply", wc, "committed", None);
                    return Ok(Answer::Json(Value::Null));
                };
                let code = shell_core::netmap::error_code(error);
                log_navigation("preview.navigation.reply", wc, "failed", code);
                if let Some(code) = code {
                    let original = runtime().gateway.original_url(&entry.partition, &url).await;
                    let shown = match original {
                        Ok(Some(shown)) => Some(shown),
                        Ok(None) => Some(url),
                        Err(_) => None,
                    };
                    if let Some(shown) = shown {
                        owns(pages, wc, &entry)?;
                        load_failure(&entry, wc, code, error, &shown, "reply", Some(load));
                    }
                }
                return Err(WireError::new("navigation", error));
            }
        };
        Ok(Answer::Json(result))
    }
}

async fn answer_call(pages: &Pages, call: host::Call, result: Result<Answer, WireError>) {
    host::forget_cancel(call.id());
    match result {
        Ok(Answer::Json(value)) => call.ok(value),
        Ok(Answer::Binary(value, bytes, page, ack)) => {
            call.ok_bin(value, &bytes);
            if let Some(ack) = ack
                && let Err(error) = page.ack_frame(ack).await
            {
                crate::log::log("preview.frame.ack", json!({"error":error.to_string()}));
            }
        }
        Err(mut error) => {
            if matches!(call.method.as_str(), "view.create" | "win.create")
                && let Some(wc) = call.params["wcId"].as_u64()
            {
                if pages.entry(wc).is_ok() {
                    if let Err(cleanup) = close(pages, wc).await {
                        error.message = format!("{}; cleanup: {}", error.message, cleanup.message);
                    }
                } else {
                    crate::close_record(wc);
                }
            }
            call.err(&error.code, error.message);
        }
    }
}
async fn execute(
    browser: &Arc<Browser>,
    pages: &Arc<Pages>,
    method: &str,
    params: &Value,
    expected: Option<Identity>,
    script: Option<ScriptDocument>,
) -> Result<Execution, WireError> {
    if method == "view.create" || method == "win.create" {
        return create(browser, pages, method, params)
            .await
            .map(Answer::Json)
            .map(Execution::Complete);
    }
    if method == "wc.op"
        && let Some(op) = params["op"].as_str().filter(|op| commands::is_edit(op))
        && let Some(app) = params["wcId"].as_u64()
        && surface::hosts_preview(app)
    {
        let app_identity =
            expected.ok_or_else(|| WireError::new("gone", "original app edit owner ended"))?;
        original(app_identity)?;
        let wc = surface::edit_owner(app)
            .ok_or_else(|| crate::unsupported(&format!("wc.op {op}: no focused Preview")))?;
        let entry = pages.entry(wc)?;
        let key = surface::key(wc)
            .map_err(|error| WireError::new("native-surface", error.to_string()))?;
        commands::edit(
            browser,
            &entry.page.session_id,
            &iframe_sessions(pages, wc),
            Some(key),
            op,
        )
        .await?;
        original(app_identity)?;
        return Ok(Execution::Complete(Answer::Json(json!({}))));
    }
    let wc = {
        let registry = runtime().registry.lock().expect("registry");
        if method == "view.op" {
            registry
                .by_view(crate::number(params, "viewId")?)
                .map(|page| page.identity.wc)
        } else if method == "win.op" {
            registry
                .by_window(crate::number(params, "winId")?)
                .map(|page| page.identity.wc)
        } else {
            params["wcId"].as_u64()
        }
    }
    .ok_or_else(|| WireError::new("gone", "unknown Preview owner"))?;
    let identity = pages.current(wc)?;
    let bound = document_bound(method, params);
    if bound {
        if method == "wc.op" && params["op"].as_str() == Some("executeJavaScript") {
            script
                .as_ref()
                .ok_or_else(|| WireError::new("gone", "original Preview execution context ended"))?
                .valid(pages)?;
        } else {
            original(
                expected.ok_or_else(|| {
                    WireError::new("gone", "original Preview request owner ended")
                })?,
            )?;
        }
    }
    let entry = pages.entry(wc)?;
    let result = match method {
        "view.op" => {
            return view::operation(pages, wc, params)
                .await
                .map(Answer::Json)
                .map(Execution::Complete);
        }
        "win.op" => {
            return offscreen_operation(pages, wc, params)
                .await
                .map(Answer::Json)
                .map(Execution::Complete);
        }
        "wc.cdp.attach" => {
            if entry
                .document
                .lock()
                .expect("Preview document")
                .debugger
                .is_some()
            {
                return Err(WireError::new("attached", "debugger already attached"));
            }
            let answer = browser
                .command(
                    "Target.attachToTarget",
                    json!({"targetId":entry.page.target_id,"flatten":true}),
                    None,
                )
                .await
                .map_err(wire)?;
            let session = crate::string(&answer, "sessionId")?.to_owned();
            original(identity)?;
            pages.routes.lock().expect("Preview routes").insert(
                session.clone(),
                Route {
                    wc,
                    debugger: Some(session.clone()),
                    iframe: false,
                },
            );
            entry.document.lock().expect("Preview document").debugger = Some(session);
            json!({})
        }
        "wc.cdp.detach" => {
            let session = entry
                .document
                .lock()
                .expect("Preview document")
                .debugger
                .take()
                .ok_or_else(|| WireError::new("not-attached", "debugger not attached"))?;
            pages
                .routes
                .lock()
                .expect("Preview routes")
                .retain(|_, route| route.wc != wc || route.debugger.as_deref() != Some(&session));
            browser
                .command(
                    "Target.detachFromTarget",
                    json!({"sessionId":session}),
                    None,
                )
                .await
                .map_err(wire)?;
            json!({})
        }
        "wc.cdp.send" => {
            let method = crate::string(params, "method")?;
            let session = if params["debugger"].as_bool() == Some(true) {
                let root = entry
                    .document
                    .lock()
                    .expect("Preview document")
                    .debugger
                    .clone()
                    .ok_or_else(|| WireError::new("not-attached", "debugger not attached"))?;
                let session = params["sessionId"].as_str().unwrap_or(&root).to_owned();
                let authorized = pages
                    .routes
                    .lock()
                    .expect("Preview routes")
                    .get(&session)
                    .is_some_and(|route| {
                        route.wc == wc && route.debugger.as_deref() == Some(&root)
                    });
                if !authorized {
                    return Err(WireError::new(
                        "denied",
                        "CDP session is not owned by this debugger",
                    ));
                }
                session
            } else {
                if params.get("sessionId").is_some() {
                    return Err(WireError::new(
                        "denied",
                        "nested CDP requires its debugger owner",
                    ));
                }
                entry.page.session_id.clone()
            };
            let mut command_params = params.get("params").cloned().unwrap_or_else(|| json!({}));
            if method == "Page.navigate" {
                let url = crate::string(&command_params, "url")?;
                if let Some(mapped) = runtime()
                    .gateway
                    .map_url(&entry.partition, url)
                    .await
                    .map_err(crate::failed)?
                {
                    command_params["url"] = json!(mapped);
                }
            }
            if method == "Page.navigate" {
                // Chromium answers a navigation only when it commits or fails. The submission keeps its place in the
                // FIFO and begins the page's next load; the wait does not, so Stop and later commands still run.
                let (root, debugger) = {
                    let document = entry.document.lock().expect("Preview document");
                    (document.frame.clone(), document.debugger.clone())
                };
                let replaces = (session == entry.page.session_id
                    || debugger.as_deref() == Some(session.as_str()))
                    && navigation::replaces_main_load(&command_params, root.as_deref());
                let reply = {
                    let mut loads = entry.loads.lock().expect("Preview loads");
                    let reply = browser
                        .submit_command_settled(method, command_params, Some(&session))
                        .map_err(wire)?;
                    if replaces {
                        loads.begin();
                    }
                    reply
                };
                return Ok(Execution::Awaiting(Evaluation {
                    reply,
                    identity,
                    kind: EvaluationKind::Navigate(entry),
                }));
            }
            let reply = browser
                .submit_command(method, command_params, Some(&session))
                .map_err(wire)?;
            if awaits_cdp_script(params) {
                return Ok(Execution::Awaiting(Evaluation {
                    reply,
                    identity,
                    kind: EvaluationKind::Cdp(entry),
                }));
            }
            if method.starts_with("Input.") {
                let release = match (
                    method,
                    params.pointer("/params/type").and_then(Value::as_str),
                ) {
                    ("Input.dispatchMouseEvent", Some("mouseReleased")) => Some("mouseUp"),
                    ("Input.dispatchKeyEvent", Some("keyUp")) => Some("keyUp"),
                    _ => None,
                };
                // Submission stays in the FIFO; Chromium may hold this reply until its dialog is answered.
                return Ok(Execution::Awaiting(Evaluation {
                    reply,
                    identity,
                    kind: EvaluationKind::Input(entry, release),
                }));
            }
            let mut answer = reply.receive().await.map_err(wire)?;
            unmap_urls(&entry.partition, &mut answer)
                .await
                .map_err(crate::failed)?;
            if bound {
                original(identity)?;
            } else {
                pages.current(wc)?;
                if !Arc::ptr_eq(&entry, &pages.entry(wc)?) {
                    return Err(WireError::new("gone", "original Preview owner ended"));
                }
            }
            return Ok(Execution::Complete(Answer::Json(json!({"result":answer}))));
        }
        "wc.frame" => {
            let frame = entry
                .document
                .lock()
                .expect("Preview document")
                .frame_pixels
                .clone()
                .ok_or_else(|| WireError::new("empty", "Preview has no painted frame"))?;
            let (bytes, width, height) = frame.encode(params)?;
            original(identity)?;
            let ack = entry
                .document
                .lock()
                .expect("Preview document")
                .pending_ack
                .take_if(|ack| *ack == frame.ack());
            return Ok(Execution::Complete(Answer::Binary(
                json!({"width":width,"height":height}),
                bytes,
                Arc::clone(&entry.page),
                ack,
            )));
        }
        "wc.op" => {
            let op = crate::string(params, "op")?;
            let args = &params["args"];
            if op == "loadURL" {
                entry
                    .document
                    .lock()
                    .expect("Preview document")
                    .last_failure = None;
                log_navigation("preview.navigation.start", wc, "loadURL", None);
            }
            if op == "stop" {
                log_navigation("preview.navigation.stop", wc, "stop", None);
            }
            match op {
                "close" => {
                    close(pages, wc).await?;
                    return Ok(Execution::Complete(Answer::Json(json!({}))));
                }
                "focus" if surface::key(wc).is_ok() => {
                    let key = surface::key(wc)
                        .map_err(|error| WireError::new("native-surface", error.to_string()))?;
                    surface::focus(key).await?;
                    json!({})
                }
                "loadURL" => {
                    let mut mapped = args.clone();
                    let url = crate::string(args, "url")?;
                    if let Some(url) = runtime()
                        .gateway
                        .map_url(&entry.partition, url)
                        .await
                        .map_err(crate::failed)?
                    {
                        mapped["url"] = json!(url);
                    }
                    // Chromium answers a navigation only when it commits or fails. The submission keeps its place in
                    // the FIFO; the wait does not, so Stop and the next load still run while this one is pending.
                    let (reply, load) = {
                        let mut loads = entry.loads.lock().expect("Preview loads");
                        let reply = commands::submit_load(&entry.page, &mapped)?;
                        (reply, loads.begin())
                    };
                    return Ok(Execution::Awaiting(Evaluation {
                        reply,
                        identity,
                        kind: EvaluationKind::Load {
                            entry,
                            load,
                            url: url.to_owned(),
                        },
                    }));
                }
                "watchEvents" => {
                    let names: Vec<String> =
                        serde_json::from_value(args["names"].clone()).map_err(crate::failed)?;
                    let mut document = entry.document.lock().expect("Preview document");
                    document.watches = names.into_iter().collect();
                    json!({})
                }
                "setZoomFactor" => {
                    let factor = args["factor"]
                        .as_f64()
                        .filter(|factor| factor.is_finite() && *factor > 0.0)
                        .ok_or_else(|| {
                            WireError::new("invalid", "zoom must be a positive finite number")
                        })?;
                    let viewport = entry.document.lock().expect("Preview document").viewport;
                    entry
                        .page
                        .resize(layout_metrics(viewport, factor)?)
                        .await
                        .map_err(wire)?;
                    if let Some(page) = runtime().registry.lock().expect("registry").page_mut(wc) {
                        page.zoom = factor;
                    }
                    wc_state(wc);
                    json!({})
                }
                "setFrameRate" => {
                    let fps = args["fps"]
                        .as_u64()
                        .filter(|fps| (1..=240).contains(fps))
                        .ok_or_else(|| WireError::new("invalid", "invalid frame rate"))?
                        as u32;
                    entry.document.lock().expect("Preview document").fps = fps;
                    host::event("wc.state", json!({"wcId":wc,"frameRate":fps}));
                    json!({})
                }
                "startPainting" | "stopPainting" | "invalidate" => {
                    if op == "stopPainting" {
                        ack_retained(&entry).await;
                        entry.page.stop_screencast().await.map_err(wire)?;
                        entry.document.lock().expect("Preview document").painting = false;
                    } else {
                        entry
                            .page
                            .start_screencast(json!({"format":"png","everyNthFrame":1}))
                            .await
                            .map_err(wire)?;
                        entry.document.lock().expect("Preview document").painting = true;
                    }
                    json!({})
                }
                "executeJavaScript" => {
                    let document = script.ok_or_else(|| {
                        WireError::new("gone", "original Preview execution context ended")
                    })?;
                    let reply = entry.page.submit_command("Runtime.evaluate",json!({"expression":crate::string(args,"code")?,
                        "uniqueContextId":document.context.as_ref(),"returnByValue":true,"awaitPromise":true,"userGesture":args["userGesture"].as_bool().unwrap_or(false)})).map_err(wire)?;
                    return Ok(Execution::Awaiting(Evaluation {
                        reply,
                        identity,
                        kind: EvaluationKind::JavaScript(document),
                    }));
                }
                op if commands::is_edit(op) => {
                    let key = match surface::key(wc) {
                        Ok(key) => Some(key),
                        Err(_)
                            if runtime()
                                .registry
                                .lock()
                                .expect("registry")
                                .page(wc)
                                .is_some_and(|page| page.kind == Kind::PreviewOffscreen) =>
                        {
                            None
                        }
                        Err(error) => {
                            return Err(WireError::new("native-surface", error.to_string()));
                        }
                    };
                    commands::edit(
                        browser,
                        &entry.page.session_id,
                        &iframe_sessions(pages, wc),
                        key,
                        op,
                    )
                    .await?;
                    Value::Null
                }
                _ => commands::operation(&entry.page, op, args).await?,
            }
        }
        _ => return Err(crate::unsupported(method)),
    };
    if bound {
        original(identity)?;
    } else {
        pages.current(wc)?;
    }
    Ok(Execution::Complete(Answer::Json(result)))
}

async fn create(
    browser: &Arc<Browser>,
    pages: &Arc<Pages>,
    method: &str,
    params: &Value,
) -> Result<Value, WireError> {
    let wc = crate::number(params, "wcId")?;
    let preferences = if method == "view.create" {
        &params["webPreferences"]
    } else {
        &params["options"]["webPreferences"]
    };
    let partition = crate::sessions::canonical(crate::string(preferences, "session")?);
    if partition == "app" {
        return Err(WireError::new(
            "denied",
            "Preview cannot use the privileged app partition",
        ));
    }
    async {
        let context = crate::sessions::preview::page_context(partition)
            .await
            .map_err(crate::failed)?;
        let created = async {
            let viewport = Viewport {
                width: params
                    .pointer("/options/width")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok())
                    .unwrap_or(800),
                height: params
                    .pointer("/options/height")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok())
                    .unwrap_or(600),
                device_scale_factor: native_scale(None).await?,
            };
            let page = browser
                .create_page(&context, viewport)
                .await
                .map_err(wire)?;
            Ok::<_, WireError>((viewport, page))
        }
        .await;
        let (viewport, page) = match created {
            Ok(created) => created,
            Err(error) => {
                return Err(
                    match crate::sessions::preview::release_page_context(partition, &context).await
                    {
                        Ok(()) => error,
                        Err(release) => WireError::new(
                            &error.code,
                            format!("{}; context disposal: {release}", error.message),
                        ),
                    },
                );
            }
        };
        let page = Arc::new(page);
        let entry = Arc::new(Entry {
            page: Arc::clone(&page),
            partition: partition.to_owned(),
            context,
            closing: tokio::sync::Mutex::new(()),
            surface_change: tokio::sync::Mutex::new(()),
            loads: Mutex::new(navigation::Loads::default()),
            document: Mutex::new(Document {
                frame: None,
                loader: None,
                main_world: contexts::MainWorld::default(),
                watches: HashSet::new(),
                debugger: None,
                viewport,
                painting: false,
                fps: 60,
                frame_pixels: None,
                native_geometry: None,
                last_paint: None,
                pending_ack: None,
                navigation: navigation::Pending::default(),
                last_failure: None,
                layout: (method == "view.create").then_some(ViewLayout {
                    bounds: native::Rect::default(),
                    visible: true,
                }),
                marked: None,
                selection: native::TextRange::default(),
                text_target: None,
                native_contexts: contexts::BindingContexts::default(),
            }),
            publisher: Mutex::new(None),
            submitting: Mutex::new(()),
            surface_acks: Mutex::new(HashSet::new()),
            surface_ack_tasks: Mutex::new(Vec::new()),
            surface_ack_errors: Mutex::new(Vec::new()),
            ax_snapshot: Mutex::new(None),
            refresh_flags: AtomicU8::new(0),
            refresh_queued: AtomicBool::new(false),
        });
        pages.routes.lock().expect("Preview routes").insert(
            page.session_id.clone(),
            Route {
                wc,
                debugger: None,
                iframe: false,
            },
        );
        pages
            .entries
            .lock()
            .expect("Preview pages")
            .insert(wc, Arc::clone(&entry));
        let setup = async {
            let tree = page
                .command("Page.getFrameTree", json!({}))
                .await
                .map_err(wire)?;
            entry.document.lock().expect("Preview document").frame = tree
                .pointer("/frameTree/frame/id")
                .and_then(Value::as_str)
                .map(str::to_owned);
            page.command("Page.setLifecycleEventsEnabled", json!({"enabled":true}))
                .await
                .map_err(wire)?;
            page.command("Runtime.disable", json!({}))
                .await
                .map_err(wire)?;
            page.command("Runtime.enable", json!({}))
                .await
                .map_err(wire)?;
            Ok::<(), WireError>(())
        }
        .await;
        if let Err(error) = setup {
            // The page and its per-page context are owned by the Entry; close disposes both and keeps
            // the Entry for a retry if Chromium does not answer.
            return Err(match close(pages, wc).await {
                Ok(()) => error,
                Err(cleanup) => WireError::new(
                    &error.code,
                    format!("{}; cleanup: {}", error.message, cleanup.message),
                ),
            });
        }
        host::event(
            "wc.state",
            json!({"wcId":wc,"nativeScaleFactor":viewport.device_scale_factor}),
        );
        wc_state(wc);
        if method == "win.create" {
            offscreen_state(wc, viewport);
        }
        Ok(json!({}))
    }
    .await
}
fn log_navigation(event: &str, wc: u64, cause: &str, code: Option<i32>) {
    let state = runtime()
        .registry
        .lock()
        .expect("registry")
        .page(wc)
        .map(|page| (page.identity.generation, page.loading));
    crate::log::log(
        event,
        json!({
            "wcId":wc,"cause":cause,"code":code,
            "generation":state.map(|(generation, _)| generation),
            "loading":state.map(|(_, loading)| loading),
        }),
    );
}
fn load_failure(
    entry: &Entry,
    wc: u64,
    code: i32,
    message: &str,
    url: &str,
    cause: &str,
    load: Option<u64>,
) {
    // Held from the admission through the UI's publication: no newer load begins between them, so an older load's
    // failure cannot reach the page after the load that replaced it.
    let loads = entry.loads.lock().expect("Preview loads");
    let page = runtime()
        .registry
        .lock()
        .expect("registry")
        .page(wc)
        .map(|page| (page.identity.generation, page.loading));
    let Some((generation, loading)) = page else {
        return;
    };
    let admission = {
        let mut document = entry.document.lock().expect("Preview document");
        navigation::admit(
            &loads,
            &mut document.last_failure,
            generation,
            loading,
            message,
            load,
        )
    };
    match admission {
        navigation::Admission::Report => {}
        navigation::Admission::Duplicate => {
            log_navigation("preview.navigation.deduplicated", wc, cause, Some(code));
            return;
        }
        navigation::Admission::Superseded => {
            log_navigation("preview.navigation.superseded", wc, cause, Some(code));
            return;
        }
    }
    log_navigation("preview.navigation.failure", wc, cause, Some(code));
    if let Some(page) = runtime().registry.lock().expect("registry").page_mut(wc) {
        page.loading = false;
    }
    wc_state(wc);
    wc_event(wc, "did-fail-load", json!([code, message, url, true]));
    wc_event(wc, "did-stop-loading", json!([]));
}
async fn close(pages: &Pages, wc: u64) -> Result<(), WireError> {
    let entry = pages.entry(wc)?;
    let _surface_change = entry.surface_change.lock().await;
    let _closing = entry.closing.lock().await;
    pages.dialogs.end(wc);
    let key = {
        let _submitting = entry.submitting.lock().expect("native frame submission");
        let mut registry = runtime().registry.lock().expect("registry");
        let key = registry.page(wc).and_then(|page| match page.kind {
            Kind::PreviewView { view, .. } => Some(native::SurfaceKey {
                view,
                wc,
                generation: page.identity.generation,
            }),
            _ => None,
        });
        registry.begin_close(wc);
        entry.publisher.lock().expect("native publisher").take();
        key
    };
    let native_cleanup = async {
        let mut errors = Vec::new();
        if let Some(key) = key
            && let Err(error) = surface::dispose(key).await
        {
            errors.push(format!("surface: {}", error.message));
        }
        let retained = entry
            .document
            .lock()
            .expect("Preview document")
            .pending_ack
            .take();
        if let Some(ack) = retained
            && let Err(error) = entry.page.ack_frame(ack).await
        {
            errors.push(format!("retained frame: {error}"));
        }
        let acknowledgements = std::mem::take(
            &mut *entry
                .surface_ack_tasks
                .lock()
                .expect("native frame acknowledgement tasks"),
        );
        for acknowledgement in acknowledgements {
            match acknowledgement.await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => errors.push(error),
                Err(error) => errors.push(format!("frame acknowledgement receipt: {error}")),
            }
        }
        errors.append(
            &mut *entry
                .surface_ack_errors
                .lock()
                .expect("native frame errors"),
        );
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    };
    let page_cleanup = async {
        entry
            .page
            .close()
            .await
            .map_err(|error| format!("target: {error}"))?;
        crate::sessions::preview::release_page_context(&entry.partition, &entry.context)
            .await
            .map_err(|error| format!("context: {error}"))?;
        pages
            .routes
            .lock()
            .expect("Preview routes")
            .retain(|_, route| route.wc != wc);
        pages.entries.lock().expect("Preview pages").remove(&wc);
        crate::close_record(wc);
        Ok(())
    };
    cleanup::settle(native_cleanup, page_cleanup)
        .await
        .map_err(|message| WireError::new("cleanup", message))
}
async fn offscreen_operation(pages: &Pages, wc: u64, params: &Value) -> Result<Value, WireError> {
    let entry = pages.entry(wc)?;
    let op = crate::string(params, "op")?;
    let args = &params["args"];
    match op {
        "close" | "destroy" => close(pages, wc).await?,
        "setSize" | "setContentSize" | "setBounds" => {
            let args = if op == "setBounds" {
                &args["bounds"]
            } else {
                args
            };
            let viewport = Viewport {
                width: crate::number(args, "width")?
                    .try_into()
                    .map_err(crate::failed)?,
                height: crate::number(args, "height")?
                    .try_into()
                    .map_err(crate::failed)?,
                device_scale_factor: entry
                    .document
                    .lock()
                    .expect("Preview document")
                    .viewport
                    .device_scale_factor,
            };
            let zoom = runtime()
                .registry
                .lock()
                .expect("registry")
                .page(wc)
                .map(|page| page.zoom)
                .ok_or_else(|| WireError::new("gone", "Preview window ended"))?;
            entry
                .page
                .resize(layout_metrics(viewport, zoom)?)
                .await
                .map_err(wire)?;
            entry.document.lock().expect("Preview document").viewport = viewport;
            host::event(
                "wc.state",
                json!({"wcId":wc,"nativeScaleFactor":viewport.device_scale_factor}),
            );
            offscreen_state(wc, viewport);
            if let Some(win) = pages.current(wc)?.win {
                crate::win_event(win, "resize");
            }
        }
        _ => return Err(crate::unsupported(&format!("offscreen win.op {op}"))),
    }
    Ok(json!({}))
}
fn layout_metrics(viewport: Viewport, zoom: f64) -> Result<Viewport, WireError> {
    let width = (f64::from(viewport.width) / zoom).round();
    let height = (f64::from(viewport.height) / zoom).round();
    let scale = viewport.device_scale_factor * zoom;
    if !(1.0..=16384.0).contains(&width)
        || !(1.0..=16384.0).contains(&height)
        || !(0.25..=8.0).contains(&scale)
    {
        return Err(WireError::new(
            "invalid",
            "Preview zoom exceeds the real Chromium viewport limits",
        ));
    }
    Ok(Viewport {
        width: width as u32,
        height: height as u32,
        device_scale_factor: scale,
    })
}
async fn native_scale(win: Option<u64>) -> Result<f64, WireError> {
    let (send, receive) = oneshot::channel();
    runtime()
        .app
        .run_on_main_thread(move || {
            let result = (|| {
                if let Some(win) = win {
                    let wc = runtime()
                        .registry
                        .lock()
                        .expect("registry")
                        .by_window(win)
                        .map(|page| page.identity.wc)
                        .ok_or_else(|| WireError::new("gone", "parent window ended"))?;
                    return crate::window_for_wc(wc)?
                        .scale_factor()
                        .map_err(crate::failed);
                }
                let (displays, primary) = crate::system::displays();
                displays
                    .iter()
                    .find(|display| display["id"].as_i64() == Some(primary))
                    .and_then(|display| display["scaleFactor"].as_f64())
                    .filter(|scale| scale.is_finite() && *scale > 0.0)
                    .ok_or_else(|| {
                        WireError::new("failed", "native primary display scale unavailable")
                    })
            })();
            let _ = send.send(result);
        })
        .map_err(crate::failed)?;
    receive.await.map_err(crate::failed)?
}
fn offscreen_state(wc: u64, viewport: Viewport) {
    let win = runtime()
        .registry
        .lock()
        .expect("registry")
        .page(wc)
        .and_then(|page| page.identity.win);
    if let Some(win) = win {
        let bounds = json!({"x":0,"y":0,"width":viewport.width,"height":viewport.height});
        host::event(
            "win.state",
            json!({"winId":win,"bounds":bounds,"normalBounds":bounds,"contentBounds":bounds,
            "visible":false,"focused":false,"minimized":false,"maximized":false,"fullscreen":false}),
        );
    }
}

fn schedule_frame_ack(entry: &Entry, ack: i64) {
    let (done, finished) = oneshot::channel();
    {
        let mut tasks = entry
            .surface_ack_tasks
            .lock()
            .expect("native frame acknowledgement tasks");
        tasks.retain_mut(|task| match task.try_recv() {
            Err(oneshot::error::TryRecvError::Empty) => true,
            Ok(Ok(())) => false,
            Ok(Err(error)) => {
                entry
                    .surface_ack_errors
                    .lock()
                    .expect("native frame errors")
                    .push(error);
                false
            }
            Err(error) => {
                entry
                    .surface_ack_errors
                    .lock()
                    .expect("native frame errors")
                    .push(format!("frame acknowledgement receipt: {error}"));
                false
            }
        });
        tasks.push(finished);
    }
    let page = Arc::clone(&entry.page);
    tauri::async_runtime::spawn(async move {
        let result = page
            .ack_frame(ack)
            .await
            .map_err(|error| format!("frame: {error}"));
        if let Err(error) = &result {
            crate::log::log("preview.frame.ack", json!({"error":error}));
        }
        let _ = done.send(result);
    });
}
async fn ack_retained(entry: &Entry) {
    let ack = entry
        .document
        .lock()
        .expect("Preview document")
        .pending_ack
        .take();
    if let Some(ack) = ack
        && let Err(error) = entry.page.ack_frame(ack).await
    {
        crate::log::log("preview.frame.ack", json!({"error":error.to_string()}));
    }
}
fn unmap_urls<'a>(
    partition: &'a str,
    value: &'a mut Value,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        match value {
            Value::Object(object) => {
                for (key, value) in object {
                    if matches!(
                        key.as_str(),
                        "url" | "documentURL" | "sourceURL" | "unreachableUrl" | "securityOrigin"
                    ) {
                        if let Some(url) = value
                            .as_str()
                            .filter(|url| url.contains(':') && *url != "://")
                            && let Some(original) =
                                runtime().gateway.original_url(partition, url).await?
                        {
                            *value = json!(original);
                        }
                    } else {
                        unmap_urls(partition, value).await?;
                    }
                }
            }
            Value::Array(values) => {
                for value in values {
                    unmap_urls(partition, value).await?;
                }
            }
            _ => {}
        }
        Ok(())
    })
}
async fn invalidate_document(entry: &Entry, wc: u64) {
    {
        let _submitting = entry.submitting.lock().expect("native frame submission");
        {
            let mut registry = runtime().registry.lock().expect("registry");
            if !registry
                .page(wc)
                .is_some_and(|page| page.state == crate::registry::PageState::Live)
                || registry.invalidate(wc).is_none()
            {
                return;
            }
        }
        {
            let mut document = entry.document.lock().expect("Preview document");
            document.frame_pixels = None;
            document.marked = None;
            document.text_target = None;
            document.selection = native::TextRange::default();
        }
        *entry.ax_snapshot.lock().expect("native AX snapshot") = None;
    }
    let _surface_change = entry.surface_change.lock().await;
    if let Ok(key) = surface::key(wc) {
        match surface::synchronize(key).await {
            Ok(publisher) => {
                let registry = runtime().registry.lock().expect("registry");
                if registry.page(wc).is_some_and(|page| {
                    page.state == crate::registry::PageState::Live
                        && page.identity.generation == key.generation
                        && matches!(page.kind,Kind::PreviewView{view,..} if view==key.view)
                }) {
                    *entry.publisher.lock().expect("native publisher") = publisher;
                    request_refresh(entry, key, TEXT | AX);
                }
            }
            Err(error) => crate::log::log(
                "preview.surface.synchronize",
                json!({"wcId":wc,"error":error.message}),
            ),
        }
    }
}
async fn observe(pages: Arc<Pages>, mut receive: shell_preview::EventReceiver) {
    loop {
        let mut event = match receive.recv().await {
            Ok(event) => event,
            Err(error) => {
                crate::log::log("preview.events.ended", json!({"error":error.to_string()}));
                let ids: Vec<_> = pages
                    .entries
                    .lock()
                    .expect("Preview pages")
                    .keys()
                    .copied()
                    .collect();
                for wc in ids {
                    let _ = close(&pages, wc).await;
                }
                return;
            }
        };
        if event.method == "Target.detachedFromTarget" {
            if let Some(session) = event.params["sessionId"].as_str() {
                let detached = pages.routes.lock().expect("Preview routes").remove(session);
                if let Some(route) = detached
                    && let Ok(entry) = pages.entry(route.wc)
                {
                    let primary = entry.page.session_id == session;
                    let root = route.debugger.as_deref() == Some(session);
                    crate::log::log(
                        "preview.target.detached",
                        json!({
                            "wcId":route.wc,"sessionId":session,"event":event.method,
                            "primary":primary,"debuggerRoot":root,"iframe":route.iframe,
                            "reason":event.params.get("reason")
                        }),
                    );
                    if root {
                        entry.document.lock().expect("Preview document").debugger = None;
                        pages
                            .routes
                            .lock()
                            .expect("Preview routes")
                            .retain(|_, child| child.debugger.as_deref() != Some(session));
                        host::event(
                            "wc.cdp.detached",
                            json!({"wcId":route.wc,"reason":"target closed"}),
                        );
                    }
                    if route.iframe && route.debugger.is_none() {
                        entry
                            .document
                            .lock()
                            .expect("Preview document")
                            .native_contexts
                            .detached(session);
                        invalidate_document(&entry, route.wc).await;
                    }
                    if primary {
                        let _ = close(&pages, route.wc).await;
                    }
                }
            }
            continue;
        }
        let route = event
            .session_id
            .as_ref()
            .and_then(|session| {
                pages
                    .routes
                    .lock()
                    .expect("Preview routes")
                    .get(session)
                    .cloned()
            })
            .or_else(|| {
                let target = event
                    .params
                    .pointer("/targetInfo/targetId")
                    .or_else(|| event.params.get("targetId"))?
                    .as_str()?;
                pages
                    .entries
                    .lock()
                    .expect("Preview pages")
                    .iter()
                    .find_map(|(wc, entry)| {
                        (entry.page.target_id == target).then_some(Route {
                            wc: *wc,
                            debugger: None,
                            iframe: false,
                        })
                    })
            });
        if event.method == "Target.attachedToTarget"
            && let (Some(mut route), Some(session)) =
                (route.clone(), event.params["sessionId"].as_str())
            && event
                .params
                .pointer("/targetInfo/type")
                .and_then(Value::as_str)
                == Some("iframe")
        {
            route.iframe = true;
            pages
                .routes
                .lock()
                .expect("Preview routes")
                .insert(session.to_owned(), route);
        }
        let Some(route) = route else {
            continue;
        };
        let Ok(entry) = pages.entry(route.wc) else {
            continue;
        };
        let Ok(identity) = pages.current(route.wc) else {
            continue;
        };
        if event.method != "Page.screencastFrame" {
            let mut params = event.params.as_ref().clone();
            if unmap_urls(&entry.partition, &mut params).await.is_err() {
                continue;
            }
            event.params = Arc::new(params);
        }
        if original(identity).is_err() {
            continue;
        }
        if route.debugger.is_some() {
            let root = route.debugger.as_deref();
            let nested = event
                .session_id
                .as_deref()
                .filter(|session| Some(*session) != root);
            let mut message =
                json!({"wcId":route.wc,"method":event.method,"params":event.params.as_ref()});
            if let Some(nested) = nested {
                message["sessionId"] = json!(nested);
            }
            host::event("wc.cdp.message", message);
            continue;
        }
        if event.method == "Target.targetCrashed" {
            if let Some(update) = events::decode(&event) {
                update_page(&entry, route.wc, update);
            }
            continue;
        }
        let Some(session) = event.session_id.as_deref() else {
            continue;
        };
        if session != entry.page.session_id && !route.iframe {
            continue;
        }
        match dialogs::decode(&event) {
            Some(dialogs::Event::Opening(opening)) => {
                tauri::async_runtime::spawn(pages.dialogs.opened(route.wc, session, &opening));
                continue;
            }
            Some(dialogs::Event::Closed) => {
                pages.dialogs.closed(route.wc, session);
                continue;
            }
            None => {}
        }
        let update = if route.iframe {
            None
        } else {
            events::decode(&event)
        };
        if event.method == "Page.frameNavigated"
            || event.method == "Page.frameDetached"
            || (event.method == "Page.frameStartedLoading"
                && event.params["frameId"].as_str()
                    == entry
                        .document
                        .lock()
                        .expect("Preview document")
                        .frame
                        .as_deref())
        {
            invalidate_document(&entry, route.wc).await;
        }
        entry
            .document
            .lock()
            .expect("Preview document")
            .native_contexts
            .observe(&event);
        if event.method == "Runtime.bindingCalled" {
            let notification = {
                let document = entry.document.lock().expect("Preview document");
                document.native_contexts.notification(
                    &event,
                    &entry.page.session_id,
                    document.frame.as_deref(),
                )
            };
            match notification {
                Some(contexts::Notification::Text) => {
                    if let Ok(key) = surface::key(route.wc) {
                        request_refresh(&entry, key, TEXT);
                    }
                }
                Some(contexts::Notification::Layout) => {
                    if let Ok(key) = surface::key(route.wc) {
                        request_refresh(&entry, key, TEXT | AX);
                    }
                }
                Some(contexts::Notification::Title(title)) => {
                    let changed = {
                        let mut registry = runtime().registry.lock().expect("registry");
                        registry.current(identity)
                            && registry.page_mut(route.wc).is_some_and(|page| {
                                if page.title == title {
                                    return false;
                                }
                                page.title.clone_from(&title);
                                true
                            })
                    };
                    if changed {
                        wc_state(route.wc);
                        wc_event(route.wc, "page-title-updated", json!([title, true]));
                    }
                }
                _ => {}
            }
            continue;
        }
        if route.iframe {
            continue;
        }
        if event.method == "Page.screencastFrame" {
            let ack = event.params["sessionId"].as_i64();
            let deliver = {
                let document = entry.document.lock().expect("Preview document");
                document.painting
                    && document.last_paint.is_none_or(|last| {
                        last.elapsed() >= Duration::from_secs_f64(1.0 / f64::from(document.fps))
                    })
            };
            if deliver {
                ack_retained(&entry).await;
                if original(identity).is_err() {
                    if let Some(ack) = ack {
                        let _submitting = entry.submitting.lock().expect("native frame submission");
                        if pages.current(route.wc).is_ok() {
                            schedule_frame_ack(&entry, ack);
                        }
                    }
                    continue;
                }
                match frames::Frame::from_event(Arc::clone(&event.params)) {
                    Ok(frame) => {
                        let (width, height, scale) = (frame.width(), frame.height(), frame.scale());
                        {
                            let _submitting =
                                entry.submitting.lock().expect("native frame submission");
                            if original(identity).is_err() {
                                if pages.current(route.wc).is_ok() {
                                    schedule_frame_ack(&entry, frame.ack());
                                }
                                continue;
                            }
                            {
                                let mut document = entry.document.lock().expect("Preview document");
                                document.frame_pixels = Some(frame.clone());
                                document.pending_ack = None;
                                document.last_paint = Some(Instant::now());
                            }
                            let key = surface::key(route.wc);
                            let publisher =
                                entry.publisher.lock().expect("native publisher").clone();
                            match (publisher, key) {
                                (Some(publisher), Ok(key)) => {
                                    entry
                                        .surface_acks
                                        .lock()
                                        .expect("native frame acknowledgements")
                                        .insert((key.generation, frame.ack()));
                                    match publisher.submit(frame.native(key)) {
                                        Ok(()) => {}
                                        Err(native::FrameSubmitError::Rejected(error)) => {
                                            let owned = entry
                                                .surface_acks
                                                .lock()
                                                .expect("native frame acknowledgements")
                                                .remove(&(key.generation, frame.ack()));
                                            if owned {
                                                schedule_frame_ack(&entry, frame.ack());
                                            }
                                            crate::log::log(
                                                "preview.frame.rejected",
                                                json!({"error":error.to_string()}),
                                            );
                                        }
                                        Err(native::FrameSubmitError::Accepted { errors }) => {
                                            for error in errors {
                                                crate::log::log(
                                                    "preview.frame.accepted_error",
                                                    json!({"error":error.to_string()}),
                                                );
                                            }
                                        }
                                    }
                                }
                                _ => {
                                    let offscreen = runtime()
                                        .registry
                                        .lock()
                                        .expect("registry")
                                        .page(route.wc)
                                        .is_some_and(|page| page.kind == Kind::PreviewOffscreen);
                                    if offscreen {
                                        entry
                                            .document
                                            .lock()
                                            .expect("Preview document")
                                            .pending_ack = Some(frame.ack());
                                    } else {
                                        schedule_frame_ack(&entry, frame.ack());
                                    }
                                }
                            }
                        }
                        host::event(
                            "wc.paint",
                            json!({"wcId":route.wc,"width":width,"height":height,"scale":scale}),
                        );
                        continue;
                    }
                    Err(error) => {
                        crate::log::log("preview.frame.invalid", json!({"message":error.message}))
                    }
                }
            }
            if let Some(ack) = ack {
                let _submitting = entry.submitting.lock().expect("native frame submission");
                if pages.current(route.wc).is_ok() {
                    schedule_frame_ack(&entry, ack);
                }
            }
            continue;
        }
        let failure = {
            let mut document = entry.document.lock().expect("Preview document");
            let frame = document.frame.clone();
            document
                .navigation
                .observe(&event.method, &event.params, frame.as_deref())
        };
        if let Some(failure) = failure {
            if let Some(code) = shell_core::netmap::error_code(&failure.error) {
                load_failure(
                    &entry,
                    route.wc,
                    code,
                    &failure.error,
                    &failure.url,
                    "event",
                    None,
                );
            } else {
                crate::log::log(
                    "preview.navigation.unknown-error",
                    json!({"wcId":route.wc,"error":failure.error}),
                );
            }
            continue;
        }
        {
            let mut document = entry.document.lock().expect("Preview document");
            let Document {
                main_world, frame, ..
            } = &mut *document;
            main_world.observe(&event, frame.as_deref());
        }
        if event.method == "Page.lifecycleEvent" {
            lifecycle(&entry, route.wc, &event.params).await;
        }
        if event.method == "Page.frameNavigated"
            && event.params.pointer("/frame/parentId").is_none()
        {
            ack_retained(&entry).await;
            entry.document.lock().expect("Preview document").loader = event
                .params
                .pointer("/frame/loaderId")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        if let Some(update) = update {
            update_page(&entry, route.wc, update);
        }
        if matches!(
            event.method.as_str(),
            "Page.frameNavigated" | "Page.navigatedWithinDocument"
        ) {
            refresh_state(&entry, route.wc).await;
        }
    }
}
fn update_page(entry: &Entry, wc: u64, update: events::Update) {
    match update {
        events::Update::Navigation {
            frame_id,
            url,
            main_frame,
            same_document,
            restored,
        } => {
            let mut document = entry.document.lock().expect("Preview document");
            let main = main_frame.unwrap_or(document.frame.as_deref() == Some(&frame_id));
            if !main {
                return;
            }
            document.frame = Some(frame_id);
            if !same_document {
                document.frame_pixels = None;
            }
            drop(document);
            if same_document {
                if let Some(page) = runtime().registry.lock().expect("registry").page_mut(wc) {
                    page.url = url.clone();
                }
            } else {
                if let Some(page) = runtime().registry.lock().expect("registry").page_mut(wc) {
                    page.url = url.clone();
                    if !restored {
                        page.loading = true;
                    }
                }
            }
            wc_state(wc);
            if same_document {
                wc_event(wc, "did-navigate-in-page", json!([url, true]));
            } else {
                host::event("wc.state", json!({"wcId":wc,"crashed":false}));
                wc_event(wc, "did-navigate", json!([url]));
                if restored {
                    stop_loading(wc);
                }
            }
        }
        events::Update::Loading { frame_id, loading } => {
            if frame_id.as_deref()
                != entry
                    .document
                    .lock()
                    .expect("Preview document")
                    .frame
                    .as_deref()
            {
                return;
            }
            if !loading {
                stop_loading(wc);
                return;
            }
            if let Some(page) = runtime().registry.lock().expect("registry").page_mut(wc) {
                page.loading = true;
            }
            wc_state(wc);
            wc_event(wc, "did-start-loading", json!([]));
            log_navigation("preview.navigation.start", wc, "frameStartedLoading", None);
        }
        events::Update::Console {
            level,
            message,
            line,
            source,
        } => {
            if entry
                .document
                .lock()
                .expect("Preview document")
                .watches
                .contains("console-message")
            {
                let level = match level.as_str() {
                    "error" | "assert" => "error",
                    "warning" | "warn" => "warning",
                    "debug" => "debug",
                    _ => "info",
                };
                wc_event(
                    wc,
                    "console-message",
                    json!([{"level":level,"message":message,"lineNumber":line,"sourceId":source}]),
                );
            }
        }
        events::Update::Crashed { reason } => {
            if let Some(page) = runtime().registry.lock().expect("registry").page_mut(wc) {
                page.loading = false;
            }
            host::event(
                "wc.state",
                json!({"wcId":wc,"loading":false,"crashed":true}),
            );
            wc_event(wc, "render-process-gone", json!([{"reason":reason}]));
        }
        events::Update::WindowOpen {
            url,
            frame_name,
            user_gesture,
        } => {
            host::request(
                "wc.windowOpen",
                json!({"wcId":wc,"url":url,"frameName":frame_name,
                "disposition":if user_gesture{"foreground-tab"}else{"new-popup"},"features":""}),
                None,
                |_, _| {},
            );
        }
        events::Update::Detached { session_id } => {
            let mut document = entry.document.lock().expect("Preview document");
            if document.debugger.as_deref() == Some(&session_id) {
                document.debugger = None;
                host::event(
                    "wc.cdp.detached",
                    json!({"wcId":wc,"reason":"target closed"}),
                );
            }
        }
    }
}
fn stop_loading(wc: u64) {
    let changed = {
        let mut registry = runtime().registry.lock().expect("registry");
        registry.page_mut(wc).is_some_and(|page| {
            let was_loading = page.loading;
            page.loading = false;
            was_loading
        })
    };
    if changed {
        wc_state(wc);
        wc_event(wc, "did-stop-loading", json!([]));
    }
}

async fn lifecycle(entry: &Entry, wc: u64, params: &Value) {
    let matching = {
        let mut document = entry.document.lock().expect("Preview document");
        if params["frameId"].as_str() != document.frame.as_deref() {
            return;
        }
        if params["name"].as_str() == Some("init") {
            document.loader = params["loaderId"].as_str().map(str::to_owned);
        }
        params["loaderId"].as_str() == document.loader.as_deref()
    };
    if !matching {
        return;
    }
    match params["name"].as_str() {
        Some("DOMContentLoaded") => wc_event(wc, "dom-ready", json!([])),
        Some("load") => {
            let identity = {
                runtime()
                    .registry
                    .lock()
                    .expect("registry")
                    .page(wc)
                    .map(|page| page.identity)
            };
            refresh_state(entry, wc).await;
            if !identity.is_some_and(|identity| {
                runtime()
                    .registry
                    .lock()
                    .expect("registry")
                    .current(identity)
            }) {
                return;
            }
            stop_loading(wc);
            wc_event(wc, "did-finish-load", json!([]));
            if let Some(win) = runtime()
                .registry
                .lock()
                .expect("registry")
                .page(wc)
                .and_then(|page| page.identity.win)
            {
                crate::win_event(win, "ready-to-show");
            }
        }
        _ => {}
    }
}
async fn refresh_state(entry: &Entry, wc: u64) {
    let identity = runtime()
        .registry
        .lock()
        .expect("registry")
        .page(wc)
        .map(|page| page.identity);
    let Some(identity) = identity else {
        return;
    };
    if let Ok(history) = entry
        .page
        .command("Page.getNavigationHistory", json!({}))
        .await
    {
        if original(identity).is_err() {
            return;
        }
        if let (Some(index), Some(entries)) = (
            history["currentIndex"].as_u64(),
            history["entries"].as_array(),
        ) {
            host::event(
                "wc.state",
                json!({"wcId":wc,"canGoBack":index>0,"canGoForward":index+1<entries.len() as u64}),
            );
        }
    }
    let context = entry
        .document
        .lock()
        .expect("Preview document")
        .main_world
        .id();
    if let Some(context) = context
        && let Ok(title) = entry
            .page
            .command(
                "Runtime.evaluate",
                json!({"expression":"document.title","contextId":context,"returnByValue":true}),
            )
            .await
    {
        if original(identity).is_err() {
            return;
        }
        if let Some(title) = title.pointer("/result/value").and_then(Value::as_str) {
            if let Some(page) = runtime().registry.lock().expect("registry").page_mut(wc) {
                page.title = title.to_owned();
            }
            wc_state(wc);
            wc_event(wc, "page-title-updated", json!([title, true]));
        }
    }
}

fn document_bound(method: &str, params: &Value) -> bool {
    match method {
        "wc.frame" => true,
        "wc.op" => params["op"].as_str() == Some("executeJavaScript"),
        "wc.cdp.send" => !matches!(
            params["method"].as_str(),
            Some(
                "Page.navigate"
                    | "Page.reload"
                    | "Page.navigateToHistoryEntry"
                    | "Page.stopLoading"
            )
        ),
        _ => false,
    }
}
fn request_identity(call: &host::Call) -> Option<Identity> {
    let registry = runtime().registry.lock().expect("registry");
    let page = match call.method.as_str() {
        "view.op" => registry.by_view(call.params["viewId"].as_u64()?),
        "win.op" => registry.by_window(call.params["winId"].as_u64()?),
        _ => registry.page(call.params["wcId"].as_u64()?),
    }?;
    Some(page.identity)
}
pub fn dispatch(call: host::Call) -> Option<host::Call> {
    let app_edit = call.method == "wc.op"
        && call.params["op"].as_str().is_some_and(commands::is_edit)
        && call.params["wcId"]
            .as_u64()
            .is_some_and(surface::hosts_preview);
    let preview = app_edit || {
        let registry = runtime().registry.lock().expect("registry");
        match call.method.as_str() {
            "view.create" | "view.op" => true,
            "session.create" | "session.op" => {
                call.params["partition"].as_str().is_some_and(|partition| {
                    !partition.is_empty()
                        && partition != "app"
                        && !partition.starts_with("persist:")
                })
            }
            "win.create" => {
                call.params
                    .pointer("/options/webPreferences/offscreen")
                    .and_then(Value::as_bool)
                    == Some(true)
            }
            "win.op" => call.params["winId"]
                .as_u64()
                .and_then(|win| registry.by_window(win))
                .is_some_and(|page| page.kind == Kind::PreviewOffscreen),
            "wc.op" | "wc.cdp.attach" | "wc.cdp.detach" | "wc.cdp.send" | "wc.frame" => call.params
                ["wcId"]
                .as_u64()
                .is_some_and(|wc| registry.is_preview(wc)),
            _ => false,
        }
    };
    if !preview {
        return Some(call);
    }
    if matches!(call.method.as_str(), "view.create" | "win.create") {
        let reserved = (|| {
            let wc = crate::number(&call.params, "wcId")?;
            let mut registry = runtime().registry.lock().expect("registry");
            if call.method == "view.create" {
                registry.create_view(crate::number(&call.params, "viewId")?, wc)
            } else {
                registry.create_offscreen(crate::number(&call.params, "winId")?, wc)
            }
            .map_err(|error| WireError::new("invalid", error))?;
            Ok::<(), WireError>(())
        })();
        if let Err(error) = reserved {
            call.err(&error.code, error.message);
            return None;
        }
    }
    runtime().preview.submit(call);
    None
}

fn iframe_sessions(pages: &Pages, wc: u64) -> Vec<String> {
    pages
        .routes
        .lock()
        .expect("Preview routes")
        .iter()
        .filter(|(_, route)| route.wc == wc && route.debugger.is_none() && route.iframe)
        .map(|(session, _)| session.clone())
        .collect()
}
fn request_refresh(entry: &Entry, key: native::SurfaceKey, flags: u8) {
    entry.refresh_flags.fetch_or(flags, Ordering::SeqCst);
    if !entry.refresh_queued.swap(true, Ordering::SeqCst)
        && runtime()
            .preview
            .native(NativeTask::Refresh { key })
            .is_err()
    {
        entry.refresh_queued.store(false, Ordering::SeqCst);
    }
}
async fn native_task(pages: &Arc<Pages>, task: NativeTask) {
    let key = match &task {
        NativeTask::Input { key, .. }
        | NativeTask::Accessibility { key, .. }
        | NativeTask::Refresh { key }
        | NativeTask::Failure { key, .. } => *key,
    };
    let Ok(entry) = pages.entry(key.wc) else {
        return;
    };
    let refresh = matches!(&task, NativeTask::Refresh { .. });
    if surface::key(key.wc).ok() != Some(key) {
        if refresh {
            entry.refresh_queued.store(false, Ordering::SeqCst);
            if let Ok(current) = surface::key(key.wc) {
                request_refresh(&entry, current, TEXT | AX);
            }
        }
        return;
    }
    let Some(browser) = pages.browser.get() else {
        return;
    };
    let result = async {
        match task {
            NativeTask::Input {
                input,
                focus,
                geometry,
                ..
            } => {
                let input = input::from_surface(input, geometry)?;
                let released = match &input {
                    native::Input::Mouse {
                        kind: native::MouseKind::Up,
                        ..
                    } => Some("mouseUp"),
                    native::Input::Key {
                        kind: native::KeyKind::Up,
                        ..
                    } => Some("keyUp"),
                    _ => None,
                };
                if matches!(
                    &input,
                    native::Input::Ime { .. }
                        | native::Input::CancelIme
                        | native::Input::CommitText { .. }
                ) {
                    let fresh;
                    let focused = match focus.as_deref() {
                        Some(focused) => focused,
                        None => {
                            if matches!(
                                &input,
                                native::Input::Ime {
                                    replacement: Some(_),
                                    ..
                                } | native::Input::CommitText {
                                    replacement: Some(_),
                                    ..
                                }
                            ) {
                                return Err(WireError::new(
                                    "focus-unavailable",
                                    "Native replacement has no original text snapshot",
                                ));
                            }
                            let sessions = iframe_sessions(pages, key.wc);
                            fresh = frame_scope::focused_target(
                                browser,
                                &entry.page.session_id,
                                &sessions,
                                key,
                            )
                            .await?;
                            &fresh
                        }
                    };
                    let target = target::Target::focused(browser, focused, key);
                    input::apply(&target, input, 1.0).await?;
                } else {
                    let target = target::Target::guarded(browser, &entry.page.session_id, key);
                    input::apply(&target, input, 1.0).await?;
                }
                if let Some(kind) = released {
                    wc_event(key.wc, "input-event", json!([{"type":kind}]));
                }
                request_refresh(&entry, key, TEXT);
            }
            NativeTask::Accessibility {
                generation,
                target: node,
                action,
                ..
            } => {
                if generation != key.generation {
                    return Err(WireError::new("gone", "native AX snapshot ended"));
                }
                let snapshot = entry
                    .ax_snapshot
                    .lock()
                    .expect("native AX snapshot")
                    .clone()
                    .filter(|snapshot| snapshot.key == key && snapshot.generation == generation)
                    .ok_or_else(|| WireError::new("gone", "native AX snapshot ended"))?;
                let sessions = iframe_sessions(pages, key.wc);
                let frame = node
                    .frame_id
                    .clone()
                    .ok_or_else(|| WireError::new("invalid", "native AX frame missing"))?;
                let session = frame_scope::resolve_session(
                    browser,
                    &entry.page.session_id,
                    &sessions,
                    &frame,
                )
                .await?;
                let target = target::Target::frame(browser, session, &frame, key);
                accessibility::action(&target, &snapshot, node, action).await?;
                request_refresh(&entry, key, TEXT | AX);
            }
            NativeTask::Refresh { .. } => {
                let flags = entry.refresh_flags.swap(0, Ordering::SeqCst);
                let Some(geometry) = surface::geometry(&entry)
                    .map_err(|error| WireError::new("native-surface", error.to_string()))?
                else {
                    entry.refresh_flags.fetch_or(flags, Ordering::SeqCst);
                    entry.refresh_queued.store(false, Ordering::SeqCst);
                    return Ok(());
                };
                let sessions = iframe_sessions(pages, key.wc);
                if flags & AX != 0 {
                    let snapshot = Arc::new(
                        frame_scope::snapshot(
                            browser,
                            &entry.page.session_id,
                            &sessions,
                            key,
                            geometry,
                        )
                        .await?,
                    );
                    if surface::key(key.wc).ok() != Some(key) {
                        return Err(WireError::new("gone", "native AX document ended"));
                    }
                    *entry.ax_snapshot.lock().expect("native AX snapshot") =
                        Some(Arc::clone(&snapshot));
                    surface::accessibility(Arc::clone(&entry), snapshot, geometry).await?;
                }
                if flags & TEXT != 0 {
                    let marked = entry.document.lock().expect("Preview document").marked;
                    let snapshot = frame_scope::text_state(
                        browser,
                        &entry.page.session_id,
                        &sessions,
                        key,
                        geometry,
                        marked,
                    )
                    .await?;
                    if surface::key(key.wc).ok() != Some(key) {
                        return Err(WireError::new("gone", "native text document ended"));
                    }
                    {
                        let mut document = entry.document.lock().expect("Preview document");
                        document.selection = snapshot.state.selection;
                        document.marked = snapshot.state.marked;
                    }
                    surface::text(Arc::clone(&entry), snapshot, geometry).await?;
                }
                entry.refresh_queued.store(false, Ordering::SeqCst);
                if entry.refresh_flags.load(Ordering::SeqCst) != 0 {
                    request_refresh(&entry, key, 0);
                }
            }
            NativeTask::Failure { message, .. } => {
                return Err(WireError::new("native-surface", message));
            }
        }
        Ok::<(), WireError>(())
    }
    .await;
    if let Err(error) = result {
        if refresh {
            entry.refresh_queued.store(false, Ordering::SeqCst);
            if let Ok(current) = surface::key(key.wc) {
                if current != key {
                    request_refresh(&entry, current, TEXT | AX);
                } else if entry.refresh_flags.load(Ordering::SeqCst) != 0 {
                    request_refresh(&entry, current, 0);
                }
            }
        }
        if surface::key(key.wc).ok() == Some(key) {
            crate::log::log(
                "preview.native.failed",
                json!({"wcId":key.wc,"code":error.code,"message":error.message}),
            );
            wc_event(
                key.wc,
                "native-error",
                json!([{"code":error.code,"message":error.message}]),
            );
        }
    }
}
