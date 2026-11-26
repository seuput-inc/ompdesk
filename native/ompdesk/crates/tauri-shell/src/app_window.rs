//! An app window's OS-level state, the shell's since unit W1 of docs/rust-node-removal.md: where it opens
//! (window_state.rs), its Mica backdrop, its slot, how it first shows, the run progress on its taskbar button or the
//! Dock, and what happens when its page crashes or stops answering. Node keeps the window's tabs and cwd; it learns the
//! slot and Mica as the page does, from the page's URL (`?slot=N&mica=1`).
//!
//! Recovery: a page whose process ended loads again, unless it crashed again inside the cooldown (then a dialog offers
//! a restart, once per window). A page that stopped answering (page_watch) gets [`HANG_RESTART`] to answer again before
//! its process is ended and it loads again; a second such restart within the hour also tells the person. When an update
//! replaced the packaged page under the running app, a reload would serve a page whose asset names this run's files do
//! not have, so the app asks to restart instead, once per run. Each step writes Node's `gui-runtime.jsonl` line
//! (`window.log`), which Node completes with the window's cwd; the dialogs' and the notice's text is Node's
//! (`window.notice`), in the app's language.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};
use tauri::WebviewWindow;

use crate::host;
use crate::{log, quit_chain, runtime, window_state};

/// A crash reload this soon after the last one is a crash loop: the dialog is offered instead.
const RECOVERY_COOLDOWN: Duration = Duration::from_secs(30);
/// How long a page that stopped answering (page_watch's `unresponsive`: its probe went unanswered 20 s) has to answer
/// again before its process is ended and it loads again (19 Nov 2026: the Mac mini's page sat in a WebKit log-stream
/// wait for hours).
const HANG_RESTART: Duration = Duration::from_secs(15);
/// A second stuck-page restart within this long tells the person once; a single one only goes to the log.
const HANG_NOTICE_WITHIN: Duration = Duration::from_secs(60 * 60);
/// A window shows this long after it was made though its page has not painted yet, in the theme's background: a fresh
/// WebView2 runtime can take 50 s to start its browser process (nightly 45646449982), and a window that waited for the
/// first paint did not exist on screen meanwhile, so a person clicked the app again.
const SHOW_BEFORE_PAINT: Duration = Duration::from_millis(500);

/// Windows 11 22H2 (build 22621) is the first build the Mica backdrop draws on.
fn mica_supported(windows_build: Option<u32>) -> bool {
    windows_build.is_some_and(|build| build >= 22621)
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn windows_build() -> Option<u32> {
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(info: *mut OSVERSIONINFOW) -> i32;
    }
    // SAFETY: OSVERSIONINFOW is plain integers and a UTF-16 array, for which all zeros is a valid value.
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = size_of::<OSVERSIONINFOW>() as u32;
    // SAFETY: `info` is a live OSVERSIONINFOW with its size set, which the call only writes. Node's `os.release()`
    // reads the same call (libuv's uv_os_uname).
    (unsafe { RtlGetVersion(&raw mut info) } == 0).then_some(info.dwBuildNumber)
}
#[cfg(not(windows))]
fn windows_build() -> Option<u32> {
    None
}

/// How a window first shows: an update's relaunch restores its windows as the app sat when it began (Node's
/// `launchPresence`), never in front of the person.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Presence {
    Hidden,
    Minimized,
    Behind,
}

/// The `win.op` that first shows a window: none for one that comes back in the tray. A test run (`OMP_GUI_HEADLESS`)
/// never takes the focus.
fn first_show(presence: Option<Presence>, headless: bool) -> Option<&'static str> {
    match presence {
        Some(Presence::Hidden) => None,
        Some(Presence::Minimized) => Some("minimize"),
        Some(Presence::Behind) => Some("showInactive"),
        None if headless => Some("showInactive"),
        None => Some("show"),
    }
}

/// The lowest slot no open app window holds: a page paints the tab strip its slot had last time before the tab list
/// answers (renderer/lib/tab-snapshot.ts).
fn free_slot(taken: impl Iterator<Item = u32>) -> u32 {
    let taken: Vec<u32> = taken.collect();
    (0..)
        .find(|slot| !taken.contains(slot))
        .expect("a free slot")
}

/// `url` with the window's `slot` and, with the backdrop, `mica=1`, replacing any the URL had.
fn with_window_query(url: &str, slot: u32, mica: bool) -> Option<String> {
    let mut parsed = url::Url::parse(url).ok()?;
    let kept: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(key, _)| key != "slot" && key != "mica")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    {
        let mut query = parsed.query_pairs_mut();
        query.clear().extend_pairs(kept);
        query.append_pair("slot", &slot.to_string());
        if mica {
            query.append_pair("mica", "1");
        }
    }
    Some(parsed.into())
}

/// Reload a crash, but never turn a boot crash into a tight reload loop.
fn should_reload(reason: &str, last: Option<Instant>, now: Instant) -> bool {
    reason != "clean-exit" && last.is_none_or(|at| now.duration_since(at) >= RECOVERY_COOLDOWN)
}

/// Whether this stuck-page restart is told to the person: it repeats one within the hour.
fn hang_restart_notifies(last: Option<Instant>, now: Instant) -> bool {
    last.is_some_and(|at| now.duration_since(at) < HANG_NOTICE_WITHIN)
}

/// The packaged page's file as the OS names it: a replacement is another file, or the same one rewritten.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Identity {
    device: u64,
    inode: u64,
    size: u64,
    modified: u128,
}

fn resources_changed(launch: Option<Identity>, current: Option<Identity>) -> bool {
    launch.is_some_and(|launch| current != Some(launch))
}

fn identity_of(file: &Path) -> Option<Identity> {
    let meta = std::fs::metadata(file).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    #[cfg(unix)]
    let (device, inode) = {
        use std::os::unix::fs::MetadataExt;
        (meta.dev(), meta.ino())
    };
    #[cfg(windows)]
    let (device, inode) = file_id(file)?;
    Some(Identity {
        device,
        inode,
        size: meta.len(),
        modified,
    })
}

/// The volume serial and file index, which Node's `fs.statSync` reports as `dev` and `ino` on Windows.
#[cfg(windows)]
#[allow(unsafe_code)]
fn file_id(file: &Path) -> Option<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    let opened = std::fs::File::open(file).ok()?;
    // SAFETY: BY_HANDLE_FILE_INFORMATION is plain integers, for which all zeros is a valid value.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the handle is the open file's and outlives the call, which only writes `info`.
    if unsafe { GetFileInformationByHandle(opened.as_raw_handle(), &raw mut info) } == 0 {
        return None;
    }
    Some((
        u64::from(info.dwVolumeSerialNumber),
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    ))
}

/// The packaged page's identity at the first window; `None` in a checkout's run, where nothing replaces it.
fn launch_resources() -> Option<Identity> {
    static LAUNCH: LazyLock<Option<Identity>> = LazyLock::new(current_resources);
    *LAUNCH
}

fn current_resources() -> Option<Identity> {
    let r = runtime();
    r.packaged
        .then(|| identity_of(&r.renderer.join("index.html")))
        .flatten()
}

struct Record {
    win: u64,
    slot: u32,
    mica: bool,
    presence: Option<Presence>,
    opened_at: Instant,
    shown: bool,
    painted: bool,
    /// What the page last loaded, with its query: a crash reload loads it again.
    url: Option<String>,
    last_reload: Option<Instant>,
    /// The pending stuck-page restart.
    hang: Option<u64>,
    last_hang_restart: Option<Instant>,
    crash_offered: bool,
}

static RECORDS: LazyLock<Mutex<HashMap<u64, Record>>> = LazyLock::new(Mutex::default);
impl Record {
    /// The `win.op` that first shows the window, and the window; nothing once it was shown, nor for one its launch
    /// keeps in the tray.
    fn show(&mut self, headless: bool) -> Option<(u64, &'static str)> {
        let op = first_show(self.presence, headless)?;
        (!std::mem::replace(&mut self.shown, true)).then_some((self.win, op))
    }

    /// [`SHOW_BEFORE_PAINT`] passed: the window shows if its page has not painted.
    fn show_before_paint(&mut self, headless: bool) -> Option<(u64, &'static str)> {
        if self.painted {
            return None;
        }
        self.show(headless)
    }

    /// The page painted (every load sends it): the first time, the window shows unless it already did, and how long
    /// after it was made the first paint came when the window had to show before it.
    fn paint(
        &mut self,
        headless: bool,
        now: Instant,
    ) -> (Option<(u64, &'static str)>, Option<Duration>) {
        if std::mem::replace(&mut self.painted, true) {
            return (None, None);
        }
        let late = self.shown.then(|| now.duration_since(self.opened_at));
        (self.show(headless), late)
    }
}

static HANGS: AtomicU64 = AtomicU64::new(0);
/// One changed-resources prompt per run, even when declined: a page reading stale resources keeps failing.
static RESOURCES_PROMPTED: AtomicBool = AtomicBool::new(false);

fn records() -> MutexGuard<'static, HashMap<u64, Record>> {
    RECORDS.lock().unwrap_or_else(|e| e.into_inner())
}

fn with<T>(wc: u64, f: impl FnOnce(&mut Record) -> T) -> Option<T> {
    records().get_mut(&wc).map(f)
}

/// How the window `win.create` is about to make opens.
pub struct Plan {
    /// `window_bounds::for_create`'s options.
    pub geometry: Value,
    pub maximize: bool,
    pub mica: bool,
    slot: u32,
    presence: Option<Presence>,
}

pub fn plan(options: &Value) -> Plan {
    launch_resources();
    let saved = window_state::read();
    let open = records();
    // Mica only for a window that first shows restored: one shown maximized stayed blank for good under Electron,
    // and a saved maximized window opens maximized.
    Plan {
        geometry: window_state::create_options(&saved, open.len()),
        maximize: saved.maximized,
        mica: mica_supported(windows_build()) && !saved.maximized,
        slot: free_slot(open.values().map(|record| record.slot)),
        presence: match options["presence"].as_str() {
            Some("hidden") => Some(Presence::Hidden),
            Some("minimized") => Some(Presence::Minimized),
            Some("behind") => Some(Presence::Behind),
            _ => None,
        },
    }
}

/// The window `plan` was for exists. It shows at its page's first paint, or after [`SHOW_BEFORE_PAINT`] if that comes
/// later.
pub fn opened(win: u64, wc: u64, plan: Plan) {
    records().insert(
        wc,
        Record {
            win,
            slot: plan.slot,
            mica: plan.mica,
            presence: plan.presence,
            opened_at: Instant::now(),
            shown: false,
            painted: false,
            url: None,
            last_reload: None,
            hang: None,
            last_hang_restart: None,
            crash_offered: false,
        },
    );
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SHOW_BEFORE_PAINT).await;
        let shows = with(wc, |record| record.show_before_paint(headless())).flatten();
        if let Some((win, op)) = shows {
            log::log(
                "window.shown_before_paint",
                json!({"wcId": wc, "winId": win, "op": op, "ms": SHOW_BEFORE_PAINT.as_millis()}),
            );
            show_window(win, op);
        }
    });
}

/// The window closed: its slot is free and its pending restart lapses.
pub fn closed(wc: u64) {
    records().remove(&wc);
}

/// The URL an app window's page loads, with the window's query; remembered for a reload.
pub fn page_url(wc: u64, url: &str) -> String {
    with(wc, |record| {
        let full = with_window_query(url, record.slot, record.mica)?;
        record.url = Some(full.clone());
        Some(full)
    })
    .flatten()
    .unwrap_or_else(|| url.to_owned())
}

fn headless() -> bool {
    std::env::var("OMP_GUI_HEADLESS").as_deref() == Ok("1")
}

fn show_window(win: u64, op: &'static str) {
    crate::ui::run(move || {
        if let Err(error) = crate::win_op(&json!({"winId": win, "op": op, "args": {}})) {
            log::log(
                "window.first_show_failed",
                json!({"winId": win, "op": op, "code": error.code, "error": error.message}),
            );
        }
    });
}

/// The page painted (`ready-to-show`): the first time, the window shows as its launch asked, unless it already showed
/// before the paint; then how late the paint came is logged (a cold WebView2 start).
pub fn first_paint(wc: u64) {
    let Some((shows, late)) = with(wc, |record| record.paint(headless(), Instant::now())) else {
        return;
    };
    if let Some(late) = late {
        log::log(
            "window.first_paint",
            json!({"wcId": wc, "ms": late.as_millis()}),
        );
    }
    if let Some((win, op)) = shows {
        show_window(win, op);
    }
}

/// Saves the geometry of an app window that is closing, for the next window to open.
pub fn closing(window: &WebviewWindow) {
    let geometry = (|| {
        let scale = window.scale_factor()?;
        let position = window.outer_position()?.to_logical::<f64>(scale);
        let size = window.outer_size()?.to_logical::<f64>(scale);
        Ok::<_, tauri::Error>(window_state::Closed {
            x: position.x.round(),
            y: position.y.round(),
            width: size.width.round(),
            height: size.height.round(),
            maximized: window.is_maximized()?,
        })
    })();
    match geometry {
        Ok(closed) => window_state::save(&closed),
        Err(error) => log::log(
            "window_state.read_failed",
            json!({"window": window.label(), "error": error.to_string()}),
        ),
    }
}

/// The run progress over every window (`tray::progress_push`: `working`, `waiting`, anything else idle): the Dock
/// badge (● working, ! waiting) and a progress fraction on every app window, a state marker rather than progress; idle
/// clears both. UI thread.
pub fn set_run_progress(state: &str) {
    let (badge, value) = match state {
        "working" => ("●", 0.5),
        "waiting" => ("!", 0.75),
        _ => ("", -1.0),
    };
    let progress = shell_core::native_ui::progress(value, None);
    let windows: Vec<u64> = records().values().map(|record| record.win).collect();
    #[cfg(target_os = "macos")]
    {
        shell_core::sys_mac::app::set_badge(badge);
        if !windows.is_empty() {
            use shell_core::native_ui::{PROGRESS_TOTAL, Progress};
            shell_core::sys_mac::window::set_dock_progress(match progress {
                Progress::Normal(n) => Some(Some(n as f64 / PROGRESS_TOTAL as f64)),
                _ => None,
            });
        }
    }
    #[cfg(windows)]
    {
        let _ = badge;
        for win in windows {
            if let Some(hwnd) = crate::ui::window_handle(win) {
                shell_core::sys::taskbar::set_progress(hwnd, progress);
            }
        }
    }
}

/// A `gui-runtime.jsonl` line about window `wc`'s page, written by Node with the window's cwd.
fn runtime_log(wc: u64, source: &str, message: &str, details: Option<Value>) {
    let url = runtime()
        .registry
        .lock()
        .expect("registry")
        .page(wc)
        .map(|page| page.url.clone());
    let mut entry = json!({"source": source, "message": message});
    if let Some(url) = url {
        entry["url"] = json!(url);
    }
    if let Some(details) = details {
        entry["details"] = details;
    }
    host::event("window.log", json!({"wcId": wc, "entry": entry}));
}

/// The page's preload, or the shell's setup of the page, failed (`preload-error`): its line names the preload.
pub fn preload_failed(wc: u64, path: &str, error: &Value) {
    let mut entry =
        json!({"source": "preload", "message": error["message"].as_str().unwrap_or_default()});
    if let Some(stack) = error.get("stack") {
        entry["stack"] = stack.clone();
    }
    entry["url"] = json!(path);
    host::event("window.log", json!({"wcId": wc, "entry": entry}));
}

/// page_watch: the page stopped answering. Its restart is due after the grace, unless it answers first.
pub fn unresponsive(wc: u64) {
    runtime_log(
        wc,
        "renderer-unresponsive",
        "Renderer stopped responding",
        None,
    );
    let token = HANGS.fetch_add(1, Ordering::SeqCst) + 1;
    if with(wc, |record| record.hang = Some(token)).is_none() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(HANG_RESTART).await;
        crate::ui::run(move || restart_stuck(wc, token));
    });
}

fn restart_stuck(wc: u64, token: u64) {
    let now = Instant::now();
    let notify = with(wc, |record| {
        if record.hang != Some(token) {
            return None;
        }
        record.hang = None;
        let notify = hang_restart_notifies(record.last_hang_restart, now);
        record.last_hang_restart = Some(now);
        Some(notify)
    })
    .flatten();
    let Some(notify) = notify else {
        return;
    };
    runtime_log(
        wc,
        "renderer-unresponsive",
        "Restarting the stuck page",
        Some(json!({"afterMs": HANG_RESTART.as_millis() as u64, "notified": notify})),
    );
    if notify {
        tauri::async_runtime::spawn_blocking(|| {
            if let Err(error) = host::request_blocking(
                "window.notice",
                json!({"kind": "hang"}),
                Duration::from_secs(10),
            ) {
                log::log(
                    "window.notice_failed",
                    json!({"kind": "hang", "error": error.message}),
                );
            }
        });
    }
    crate::page_watch::end_stuck(wc);
}

/// page_watch: the page answers again; a pending restart is called off.
pub fn responsive(wc: u64) {
    if with(wc, |record| record.hang.take()).flatten().is_some() {
        runtime_log(
            wc,
            "renderer-unresponsive",
            "Renderer responding again",
            None,
        );
    }
}

/// The page's content process ended (`killed`: the stuck-page restart ended it). UI thread.
pub fn process_gone(wc: u64, details: &Value, killed: bool) {
    let reason = details["reason"].as_str().unwrap_or_default().to_owned();
    let now = Instant::now();
    let current = current_resources();
    let changed = resources_changed(launch_resources(), current);
    // A page ended for being stuck loads again whatever the crash cooldown says: a stuck page is worse than a reload
    // loop, and its restart already waited out the grace.
    let Some(reload) = with(wc, |record| {
        let reload = killed || should_reload(&reason, record.last_reload, now);
        if reload && !changed {
            record.last_reload = Some(now);
        }
        reload
    }) else {
        return;
    };
    let mut logged = json!({"reason": reason});
    if let Some(code) = details.get("exitCode") {
        logged["exitCode"] = code.clone();
    }
    logged["automaticReload"] = json!(reload && !changed);
    logged["resourcesChanged"] = json!(changed);
    runtime_log(
        wc,
        "renderer-process",
        &format!("Renderer process exited: {reason}"),
        Some(logged),
    );
    if reload && changed {
        return ask_restart_for_resources(wc, current);
    }
    if reload {
        let url = with(wc, |record| record.url.clone()).flatten();
        if let Some(url) = url {
            crate::ui::post(move || {
                if let Ok(window) = crate::window_for_wc(wc)
                    && let Err(error) = crate::load_app(wc, &window, &url)
                {
                    log::log(
                        "window.reload_failed",
                        json!({"wcId": wc, "code": error.code, "error": error.message}),
                    );
                }
            });
        }
    } else if !changed
        && with(wc, |record| {
            !std::mem::replace(&mut record.crash_offered, true)
        }) == Some(true)
    {
        // A crash inside the cooldown would leave the window black for good, and a dead page cannot show a dialog.
        // Its reason picks the text: an out-of-memory crash asks to free memory (Orca D21).
        ask_restart(wc, "crash", Some(reason), "error", "crash-recovery");
    }
}

fn ask_restart_for_resources(wc: u64, current: Option<Identity>) {
    if RESOURCES_PROMPTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let launch = launch_resources();
    let inode = |identity: Option<Identity>| identity.map_or(-1, |i| i.inode as i64);
    let size = |identity: Option<Identity>| identity.map_or(-1, |i| i.size as i64);
    runtime_log(
        wc,
        "application-resources",
        "Packaged application resources changed while omp was running; asking to restart",
        Some(json!({
            "trigger": "process-gone",
            "launchInode": inode(launch),
            "currentInode": inode(current),
            "launchSize": size(launch),
            "currentSize": size(current),
        })),
    );
    ask_restart(wc, "resources", None, "question", "restart-prompt");
}

/// Asks Node for the dialog's text, shows it over the window and, on its first button, relaunches through the quit
/// chain as an approved quit: running work was already weighed by the person here.
fn ask_restart(
    wc: u64,
    kind: &'static str,
    reason: Option<String>,
    style: &'static str,
    asker: &'static str,
) {
    let win = with(wc, |record| record.win);
    tauri::async_runtime::spawn_blocking(move || {
        let text = match host::request_blocking(
            "window.notice",
            json!({"kind": kind, "reason": reason}),
            Duration::from_secs(10),
        ) {
            Ok(text) => text,
            Err(error) => {
                return log::log(
                    "window.notice_failed",
                    json!({"kind": kind, "error": error.message}),
                );
            }
        };
        let options = json!({"type": style, "buttons": text["buttons"], "defaultId": 0, "cancelId": 1,
            "message": text["message"], "detail": text["detail"]});
        crate::native_chrome::dialog::present(
            win,
            format!("window.{kind}"),
            options,
            |owner, options| {
                use shell_core::dialog_spec::{DialogCancel, MessageBoxSpec};
                #[cfg(windows)]
                use shell_core::sys::dialogs as native;
                #[cfg(target_os = "macos")]
                use shell_core::sys_mac::dialogs as native;
                let spec = MessageBoxSpec::from_json(options);
                native::message_box(owner, &spec, &DialogCancel::default())
                    .map(|shown| json!(shown.response))
            },
            move |answer| {
                if answer == Ok(json!(0)) {
                    restart(asker);
                }
            },
        );
    });
}

fn restart(asker: &str) {
    let args: Vec<String> = std::env::args().skip(1).collect();
    log::log("relaunch.stored", json!({"args": args, "asker": asker}));
    *runtime().relaunch.lock().expect("relaunch") = Some(args);
    // Node logs who asked and freezes its state before the chain's first step reaches it on the same stream.
    host::event(
        "app.quitAsked",
        json!({"asker": asker, "ask": {"relaunch": true}, "approved": true}),
    );
    quit_chain::admit(&runtime().quit, quit_chain::Admission::Approved);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mica_needs_windows_11_22h2() {
        assert!(mica_supported(Some(22631)));
        assert!(mica_supported(Some(22621)));
        assert!(!mica_supported(Some(19045)));
        assert!(!mica_supported(None));
    }

    #[test]
    fn a_window_shows_as_its_launch_asked_and_a_test_run_never_takes_the_focus() {
        assert_eq!(first_show(None, false), Some("show"));
        assert_eq!(first_show(None, true), Some("showInactive"));
        assert_eq!(
            first_show(Some(Presence::Behind), false),
            Some("showInactive")
        );
        assert_eq!(
            first_show(Some(Presence::Minimized), true),
            Some("minimize")
        );
        assert_eq!(first_show(Some(Presence::Hidden), false), None);
    }

    fn record(presence: Option<Presence>, opened_at: Instant) -> Record {
        Record {
            win: 3,
            slot: 0,
            mica: false,
            presence,
            opened_at,
            shown: false,
            painted: false,
            url: None,
            last_reload: None,
            hang: None,
            last_hang_restart: None,
            crash_offered: false,
        }
    }

    #[test]
    fn a_window_shows_once_whatever_paints_after() {
        // `ready-to-show` comes with every load, a reload's too; only the first one shows the window.
        let opened = Instant::now();
        let mut record = record(None, opened);
        assert_eq!(record.paint(false, opened), (Some((3, "show")), None));
        assert_eq!(record.paint(false, opened), (None, None));
        assert_eq!(record.show_before_paint(false), None);
    }

    #[test]
    fn a_window_whose_page_has_not_painted_shows_anyway_and_its_late_paint_is_measured() {
        // A cold WebView2 start: the window must exist on screen long before the page paints.
        let opened = Instant::now();
        let mut record = record(None, opened);
        assert_eq!(record.show_before_paint(true), Some((3, "showInactive")));
        let painted = opened + Duration::from_secs(50);
        assert_eq!(
            record.paint(true, painted),
            (None, Some(Duration::from_secs(50)))
        );
    }

    #[test]
    fn an_update_relaunch_keeps_its_presence_when_shown_before_paint() {
        let opened = Instant::now();
        assert_eq!(
            record(Some(Presence::Hidden), opened).show_before_paint(false),
            None
        );
        assert_eq!(
            record(Some(Presence::Minimized), opened).show_before_paint(false),
            Some((3, "minimize"))
        );
        assert_eq!(
            record(Some(Presence::Behind), opened).show_before_paint(false),
            Some((3, "showInactive"))
        );
    }

    #[test]
    fn the_slot_is_the_lowest_one_no_open_window_holds() {
        assert_eq!(free_slot([].into_iter()), 0);
        assert_eq!(free_slot([0, 1, 3].into_iter()), 2);
        assert_eq!(free_slot([1].into_iter()), 0);
    }

    #[test]
    fn the_page_url_carries_the_slot_and_the_backdrop() {
        assert_eq!(
            with_window_query("app://ompdesk/index.html#/styleguide", 2, true).as_deref(),
            Some("app://ompdesk/index.html?slot=2&mica=1#/styleguide")
        );
        assert_eq!(
            with_window_query("http://localhost:5173/?x=1&slot=0&mica=1", 1, false).as_deref(),
            Some("http://localhost:5173/?x=1&slot=1")
        );
    }

    #[test]
    fn reloads_a_crash_after_a_stable_interval_but_not_a_clean_exit_or_a_crash_loop() {
        let at = Instant::now();
        assert!(should_reload("crashed", Some(at), at + RECOVERY_COOLDOWN));
        assert!(should_reload("oom", None, at));
        assert!(!should_reload("clean-exit", None, at));
        assert!(!should_reload(
            "crashed",
            Some(at),
            at + Duration::from_millis(1)
        ));
    }

    #[test]
    fn a_second_stuck_page_restart_within_the_hour_tells_the_person() {
        let at = Instant::now();
        assert!(!hang_restart_notifies(None, at));
        assert!(hang_restart_notifies(
            Some(at),
            at + Duration::from_secs(59 * 60)
        ));
        assert!(!hang_restart_notifies(Some(at), at + HANG_NOTICE_WITHIN));
    }

    #[test]
    fn restarts_instead_of_reloading_when_the_packaged_page_changed() {
        let launch = Identity {
            device: 1,
            inode: 100,
            size: 10_000,
            modified: 1_000,
        };
        assert!(!resources_changed(Some(launch), Some(launch)));
        assert!(resources_changed(
            Some(launch),
            Some(Identity {
                inode: 101,
                ..launch
            })
        ));
        assert!(resources_changed(
            Some(launch),
            Some(Identity {
                size: 10_001,
                ..launch
            })
        ));
        assert!(resources_changed(
            Some(launch),
            Some(Identity {
                modified: 1_001,
                ..launch
            })
        ));
        assert!(resources_changed(Some(launch), None));
        // No packaged page at launch (a checkout's run): nothing to drift.
        assert!(!resources_changed(None, Some(launch)));
        assert!(!resources_changed(None, None));
    }

    #[test]
    fn a_rewritten_file_reads_as_another_identity() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("index.html");
        std::fs::write(&file, "one").unwrap();
        let first = identity_of(&file).unwrap();
        assert_eq!(identity_of(&file), Some(first));
        std::fs::remove_file(&file).unwrap();
        std::fs::write(&file, "three").unwrap();
        assert_ne!(identity_of(&file), Some(first));
        assert_eq!(identity_of(&dir.path().join("missing")), None);
    }
}
