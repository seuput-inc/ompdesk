//! The app's entry points (docs/rust-node-removal.md, W2): a second launch, macOS `open-url`/`open-file` and the Dock's
//! `activate`, the window shortcut, and the `omp://` links they carry; and the windows the app menu and the tray act on
//! (W3). The shell decides which window shows; a window it does not have it asks Node for (`session.spawnWindow`,
//! `session.openPath`), which owns the windows' tabs and cwds.

use crate::{host, log, page_push, registry::Identity, runtime};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, mpsc};
use std::time::Duration;

/// `IPC_EVENTS.DEEP_LINK` (src/shared/ipc-types.ts).
const DEEP_LINK: &str = "deep-link";
/// `IPC_EVENTS.MENU_ACTION` (src/shared/ipc-types.ts).
const MENU_ACTION: &str = "menu:action";
/// How long an open waits for Node's window before the next open goes on.
const NODE_WAIT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq)]
pub enum Open {
    Link(String),
    /// A folder to show: the window already on it, else a new one there (Node resolves and matches it).
    Path(String),
    /// A second launch with nothing to open: the target window comes forward.
    Show,
    /// A Dock click or the shortcut with no window left.
    Spawn,
    /// New Window: a window in this window's project.
    Window(u64),
    /// A menu item for a page with no window left: a new window's page gets `{action}` once it is up.
    Menu(Value),
}

impl Open {
    /// Only opens a window: dropped before `session.ready`, as the startup is opening its windows anyway.
    fn spawns(&self) -> bool {
        matches!(self, Open::Spawn | Open::Window(_) | Open::Menu(_))
    }
}

/// What `omp://` asks of the page.
#[derive(Debug, PartialEq)]
pub enum Link {
    /// A URL that asks nothing: the window still comes forward.
    Show,
    NewSession,
    Session(String),
}

/// A URL as `new URL()` reads it; None when it is not one. The first segment of `scheme://` is the host, compared in
/// any case; `omp://session/<id>` takes the path without its outer slashes.
pub fn parse(url: &str) -> Option<Link> {
    let parsed = url::Url::parse(url).ok()?;
    Some(
        match parsed
            .host_str()
            .unwrap_or_default()
            .to_lowercase()
            .as_str()
        {
            "new" => Link::NewSession,
            "session" => match parsed.path().trim_matches('/') {
                "" => Link::Show,
                id => Link::Session(id.to_owned()),
            },
            _ => Link::Show,
        },
    )
}

impl Link {
    fn payload(&self) -> Option<Value> {
        match self {
            Link::Show => None,
            Link::NewSession => Some(json!({"action":"new-session"})),
            Link::Session(id) => Some(json!({"action":"switch-session","sessionId":id})),
        }
    }
}

/// `startup::second_instance`'s request.
pub fn launched(request: &Value) -> Option<Open> {
    let text = |key: &str| request[key].as_str().map(str::to_owned);
    match request["kind"].as_str()? {
        "url" => text("url").map(Open::Link),
        "path" => text("path").map(Open::Path),
        "focus" => Some(Open::Show),
        _ => None,
    }
}

/// A macOS open: a file URL is a folder or file to open, anything else a link.
#[cfg(any(target_os = "macos", test))]
fn opened(url: &tauri::Url) -> Open {
    match url.to_file_path() {
        Ok(path) if url.scheme() == "file" => Open::Path(path.to_string_lossy().into_owned()),
        _ => Open::Link(url.to_string()),
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq)]
enum Activate {
    Spawn,
    Show,
    Ignore,
}

/// A Dock click opens a window when none is left and brings a hidden one back. Once a quit is approved it does neither:
/// the services are torn down (or going down), and a window restored on them cannot open a paired host's tab, which then
/// leaves the saved layout (21 Oct 2026: an update restart's first quit stalled and the Dock click rebuilt the session
/// on a disposed `RemoteDevices`).
#[cfg(any(target_os = "macos", test))]
fn activate_action(quit_approved: bool, windows: usize, any_visible: bool) -> Activate {
    if quit_approved || (windows > 0 && any_visible) {
        Activate::Ignore
    } else if windows == 0 {
        Activate::Spawn
    } else {
        Activate::Show
    }
}

/// One open at a time, in arrival order: the next must see the window the one before it asked Node for. Opens that come
/// before Node serves its two commands (`session.ready`) wait and run after, in order; a spawn then is dropped, as the
/// startup is opening its windows anyway.
struct Queue {
    send: mpsc::Sender<Open>,
    ready: AtomicBool,
    go: Mutex<Option<mpsc::Sender<()>>>,
}

impl Queue {
    fn start(run: impl Fn(Open) + Send + 'static) -> Self {
        let (send, opens) = mpsc::channel();
        let (go, ready) = mpsc::channel::<()>();
        std::thread::Builder::new()
            .name("entry".into())
            .spawn(move || {
                if ready.recv().is_ok() {
                    opens.into_iter().for_each(run);
                }
            })
            .expect("entry thread");
        Self {
            send,
            ready: AtomicBool::new(false),
            go: Mutex::new(Some(go)),
        }
    }

    fn push(&self, open: Open) {
        if open.spawns() && !self.ready.load(Ordering::SeqCst) {
            return;
        }
        let _ = self.send.send(open);
    }

    fn ready(&self) {
        self.ready.store(true, Ordering::SeqCst);
        if let Some(go) = self.go.lock().expect("entry queue").take() {
            let _ = go.send(());
        }
    }
}

static QUEUE: LazyLock<Queue> = LazyLock::new(|| Queue::start(run));

pub fn push(open: Open) {
    QUEUE.push(open);
}

/// Node's `session.ready`: its startup windows exist and it answers `session.*`.
pub fn ready() {
    QUEUE.ready();
}

#[cfg(target_os = "macos")]
pub fn opened_url(url: &tauri::Url) {
    push(opened(url));
}

/// The Dock was clicked (`applicationShouldHandleReopen`). UI thread.
#[cfg(target_os = "macos")]
pub fn activate() {
    let windows = app_windows();
    let any_visible = windows
        .iter()
        .any(|(_, window)| window.is_visible().unwrap_or(false));
    let approved = runtime().quit.lock().expect("quit chain").approved();
    match activate_action(approved, windows.len(), any_visible) {
        Activate::Spawn => push(Open::Spawn),
        Activate::Show => {
            if let Some(win) = target(&windows) {
                reveal(win);
            }
        }
        Activate::Ignore => {}
    }
}

/// The window shortcut: the focused app window hides, or shows when hidden; else the first window comes forward; else
/// one opens. UI thread.
fn toggle() {
    let windows = app_windows();
    if let Some((win, window)) = windows
        .iter()
        .find(|(_, window)| crate::window_focused(window).unwrap_or(false))
    {
        if window.is_visible().unwrap_or(false) {
            op(*win, "hide");
        } else {
            op(*win, "show");
            op(*win, "focus");
        }
    } else if let Some((win, _)) = windows.first() {
        op(*win, "show");
        op(*win, "focus");
    } else {
        push(Open::Spawn);
    }
}

/// The live app windows, oldest first (Node's `getAllWindows`; the first is its `getMainWindow`).
pub fn app_windows() -> Vec<(u64, tauri::WebviewWindow)> {
    let mut pages: Vec<(u64, u64)> = runtime()
        .registry
        .lock()
        .expect("registry")
        .app_documents()
        .filter_map(|id| Some((id.win?, id.wc)))
        .collect();
    pages.sort_unstable();
    pages
        .into_iter()
        .filter_map(|(win, wc)| Some((win, crate::window_for_wc(wc).ok()?)))
        .collect()
}

/// What a menu or a launch acts on (Node's `getTargetWindow`): the focused app window, else the first.
pub fn target(windows: &[(u64, tauri::WebviewWindow)]) -> Option<u64> {
    windows
        .iter()
        .find(|(_, window)| crate::window_focused(window).unwrap_or(false))
        .or(windows.first())
        .map(|(win, _)| *win)
}

/// Through `win.op`, so Node's mirror of the window hears it as it heard its own calls.
pub fn op(win: u64, name: &str) {
    if let Err(error) = crate::win_op(&json!({"winId":win,"op":name,"args":{}})) {
        log::log(
            "entry.window_failed",
            json!({"winId":win,"op":name,"error":error.message}),
        );
    }
}

/// Brings a window forward the way a launch from the Start menu or the Dock expects: a window hidden to the tray comes
/// back, a minimized one is restored.
fn reveal(win: u64) {
    let minimized = crate::window_for_win(win)
        .and_then(|window| window.is_minimized().map_err(crate::failed))
        .unwrap_or(false);
    if minimized {
        op(win, "restore");
    }
    op(win, "show");
    op(win, "focus");
}

/// A menu item for the page: the target window's page gets `{action}`; with no window left, one opens and its page gets
/// it once it is up (Node's `sendMenuAction`). UI thread.
pub fn menu_action(action: &str) {
    let payload = json!({"action":action});
    match target(&app_windows()) {
        Some(win) => deliver(win, MENU_ACTION, payload),
        None => push(Open::Menu(payload)),
    }
}

/// New Window: in the target window's project, else as a Dock click opens one. UI thread.
pub fn new_window() {
    push(target(&app_windows()).map_or(Open::Spawn, Open::Window));
}

/// Close Window: the target window closes as its own close button closes it, so Node still decides whether it hides
/// to the tray. UI thread.
pub fn close_target() {
    let Some(win) = target(&app_windows()) else {
        return;
    };
    if let Err(error) = crate::window_for_win(win).and_then(|w| w.close().map_err(crate::failed)) {
        log::log(
            "entry.window_failed",
            json!({"winId":win,"op":"close","error":error.message}),
        );
    }
}

/// Runs `f` on the UI thread and waits for it; None once the event loop is gone.
fn on_ui<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (send, receive) = mpsc::channel();
    runtime()
        .app
        .run_on_main_thread(move || {
            let _ = send.send(f());
        })
        .ok()?;
    receive.recv().ok()
}

fn ask_node(method: &str, params: Value) -> Value {
    host::request_blocking(method, params, NODE_WAIT).unwrap_or_else(|error| {
        log::log(
            "entry.node_failed",
            json!({"method":method,"code":error.code,"error":error.message}),
        );
        Value::Null
    })
}

/// A new window from Node: in window `from`'s project, else with no cwd (the saved layout, or the app's workspace).
fn spawn_window(from: Option<u64>) -> Option<u64> {
    let params = from.map_or_else(|| json!({}), |from| json!({"from":from}));
    ask_node("session.spawnWindow", params)["win"].as_u64()
}

/// One open, on the queue's thread.
fn run(open: Open) {
    match open {
        Open::Link(url) => {
            let Some(link) = parse(&url) else {
                return;
            };
            let main = on_ui(|| app_windows().first().map(|(win, _)| *win)).flatten();
            let Some(win) = main.or_else(|| spawn_window(None)) else {
                return;
            };
            on_ui(move || {
                op(win, "show");
                op(win, "focus");
                if let Some(payload) = link.payload() {
                    deliver(win, DEEP_LINK, payload);
                }
            });
        }
        Open::Path(path) => {
            if let Some(win) = ask_node("session.openPath", json!({"path":path}))["focus"].as_u64()
            {
                on_ui(move || reveal(win));
            }
        }
        Open::Show => {
            on_ui(|| {
                if let Some(win) = target(&app_windows()) {
                    reveal(win);
                }
            });
        }
        Open::Spawn => {
            spawn_window(None);
        }
        Open::Window(from) => {
            spawn_window(Some(from));
        }
        Open::Menu(payload) => {
            if let Some(win) = spawn_window(None) {
                on_ui(move || deliver(win, MENU_ACTION, payload));
            }
        }
    }
}

/// A push for a page: its channel and payload.
type Push = (&'static str, Value);

/// Pushes for a window whose page has not started its app document yet (a window just spawned), by webContents id.
static AWAITING: LazyLock<Mutex<HashMap<u64, Vec<Push>>>> = LazyLock::new(Mutex::default);

/// Sends the push to the window's app document through its outbox, which holds it until the page is ready; a window
/// still before its first app document gets it on that document.
fn deliver(win: u64, channel: &'static str, payload: Value) {
    let page = {
        let registry = runtime().registry.lock().expect("registry");
        registry.by_window(win).and_then(|page| {
            let loaded = crate::trusted_url(&page.url) && !crate::profile_bootstrap(&page.url);
            Some((registry.app_document(page.identity.wc)?, loaded))
        })
    };
    match page {
        Some((id, true)) => send(id, channel, payload),
        Some((id, false)) => AWAITING
            .lock()
            .expect("awaiting pushes")
            .entry(id.wc)
            .or_default()
            .push((channel, payload)),
        None => {}
    }
}

/// An app document started in a window: the pushes that waited for it.
pub fn document_started(id: Identity) {
    let pushes = AWAITING.lock().expect("awaiting pushes").remove(&id.wc);
    for (channel, payload) in pushes.into_iter().flatten() {
        send(id, channel, payload);
    }
}

/// The window closed before its page started.
pub fn forget(wc: u64) {
    AWAITING.lock().expect("awaiting pushes").remove(&wc);
}

fn send(id: Identity, channel: &'static str, payload: Value) {
    if let Err(error) = page_push::enqueue(id, channel, &[payload], None) {
        log::log(
            "entry.push_failed",
            json!({"wcId":id.wc,"channel":channel,"error":error.message}),
        );
    }
}

/// `window.toggle` (src/shared/hotkeys.ts): the one system-wide shortcut, which the shell owns.
pub mod shortcut {
    use crate::{log, system};
    use serde_json::json;

    /// `nativeAccelerator("window.toggle")`; it cannot be rebound.
    const WINDOW_TOGGLE: &str = "CommandOrControl+Shift+O";
    const ID: i32 = 1;

    /// After `system::init`, on the UI thread. Another app holding the keys is logged, as Node logged it.
    pub fn register() {
        let registered = shell_core::hotkey::parse(WINDOW_TOGGLE, cfg!(target_os = "macos"))
            .is_some_and(|parsed| system::register_hotkey(ID, &parsed));
        if !registered {
            log::log("shortcut.taken", json!({"accelerator":WINDOW_TOGGLE}));
        }
    }

    /// A hotkey fired (`system.rs`'s message window). UI thread.
    pub fn fired(id: i32) {
        if id == ID {
            super::toggle();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn omp_links_read_as_main_read_them() {
        let link = |id: &str| Some(Link::Session(id.into()));
        for (url, expected) in [
            ("omp://new", Some(Link::NewSession)),
            ("omp://NEW", Some(Link::NewSession)),
            ("omp://new?from=mail", Some(Link::NewSession)),
            ("omp://session/abc-1/", link("abc-1")),
            ("omp://session//abc//", link("abc")),
            ("omp://Session/abc?x=1#y", link("abc")),
            ("omp://session/a%20b", link("a%20b")),
            ("omp://session", Some(Link::Show)),
            ("omp://session/", Some(Link::Show)),
            ("omp://elsewhere/abc", Some(Link::Show)),
            ("omp:new", Some(Link::Show)),
            ("https://x.test", Some(Link::Show)),
            ("nope", None),
            ("", None),
        ] {
            assert_eq!(parse(url), expected, "{url}");
        }
        assert_eq!(
            Link::Session("abc".into()).payload(),
            Some(json!({"action":"switch-session","sessionId":"abc"}))
        );
        assert_eq!(
            Link::NewSession.payload(),
            Some(json!({"action":"new-session"}))
        );
        assert_eq!(Link::Show.payload(), None);
    }

    #[test]
    fn a_dock_click_spawns_shows_or_ignores() {
        assert_eq!(activate_action(false, 0, false), Activate::Spawn);
        assert_eq!(activate_action(false, 2, false), Activate::Show);
        assert_eq!(activate_action(false, 2, true), Activate::Ignore);
        // An approved quit never rebuilds a window: a restore on torn-down services drops tabs from the saved layout.
        assert_eq!(activate_action(true, 0, false), Activate::Ignore);
        assert_eq!(activate_action(true, 2, false), Activate::Ignore);
    }

    #[test]
    fn a_second_launch_opens_its_link_its_folder_or_the_window() {
        assert_eq!(
            launched(&json!({"kind":"url","url":"omp://new"})),
            Some(Open::Link("omp://new".into()))
        );
        assert_eq!(
            launched(&json!({"kind":"path","path":"C:/work"})),
            Some(Open::Path("C:/work".into()))
        );
        assert_eq!(launched(&json!({"kind":"focus"})), Some(Open::Show));
        assert_eq!(launched(&json!({"kind":"url"})), None);
        assert_eq!(launched(&json!({"kind":"other"})), None);
    }

    #[test]
    fn a_macos_open_of_a_file_url_is_a_path() {
        let folder = std::env::temp_dir();
        let url = tauri::Url::from_directory_path(&folder).unwrap();
        assert_eq!(
            opened(&url),
            Open::Path(url.to_file_path().unwrap().to_string_lossy().into_owned())
        );
        let link = tauri::Url::parse("omp://session/abc").unwrap();
        assert_eq!(opened(&link), Open::Link("omp://session/abc".into()));
    }

    #[test]
    fn opens_run_one_at_a_time_and_those_before_ready_replay_in_order() {
        let (seen, runs) = mpsc::channel();
        let queue = Queue::start(move |open| {
            seen.send(("start", open.clone())).unwrap();
            std::thread::sleep(Duration::from_millis(20));
            seen.send(("end", open)).unwrap();
        });
        queue.push(Open::Link("omp://new".into()));
        queue.push(Open::Spawn);
        queue.push(Open::Window(1));
        queue.push(Open::Menu(json!({"action":"open-settings"})));
        queue.push(Open::Path("/work".into()));
        queue.push(Open::Show);
        assert!(
            runs.recv_timeout(Duration::from_millis(100)).is_err(),
            "nothing runs before ready"
        );
        queue.ready();
        queue.push(Open::Window(1));
        queue.push(Open::Menu(json!({"action":"open-settings"})));
        queue.ready();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut order = Vec::new();
        while order.len() < 10 {
            order.push(
                runs.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .unwrap(),
            );
        }
        let expected = [
            Open::Link("omp://new".into()),
            Open::Path("/work".into()),
            Open::Show,
            Open::Window(1),
            Open::Menu(json!({"action":"open-settings"})),
        ];
        let paired: Vec<_> = expected
            .iter()
            .flat_map(|open| [("start", open.clone()), ("end", open.clone())])
            .collect();
        assert_eq!(order, paired);
    }
}
