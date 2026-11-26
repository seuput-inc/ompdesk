//! The popup's window and page (docs/design/custom-notifications.md). Everything here runs on the UI thread.
//!
//! The window is made at the first popup and kept. It shares the app's webview environment (the same data folder and,
//! on Windows, the same browser arguments as an app window), so it starts a renderer, not a cold browser. A card that
//! arrives before its page is ready waits up to `READY_MS`, then goes to the OS banner. The page has no app preload and
//! no IPC: the shell draws through `eval(render(…))`, and the page asks by navigating to `ompdesk-popup:`, which the
//! shell cancels. On macOS the webview's view moves into a non-activating panel (`popup_panel.rs`), and the Tauri
//! window that made it is never shown.

use std::cell::RefCell;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Instant;

use base64::Engine;
use serde_json::{Value, json};
use shell_core::notify_spec::ToastSpec;
use tauri::webview::NewWindowResponse;
use tauri::{WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::{Action, CARD_HEIGHT, Card, Host, READY_MS, Route, Stack, WIDTH};
use crate::labels::{Lang, fill, text};
use crate::log::log;
use crate::native_chrome::notification::{self, emit};
use crate::{entry, system, theme, tray, ui};

pub const LABEL: &str = "notification-popup";
const TICK_MS: i64 = 500;
const WRITE_RETRY_MS: u64 = 250;
const ICON: &str = include_str!("../../../../../../resources/brand/mark-tile-small.svg");

#[derive(Default)]
struct State {
    window: Option<WebviewWindow>,
    /// The macOS panel holding the page.
    #[cfg(target_os = "macos")]
    panel: isize,
    /// The page said it is up (`ompdesk-popup:ready`).
    ready: bool,
    /// Times `write_page` sent the page.
    writes: u32,
    /// A test run's popup: never on screen, no sound, no countdown.
    hidden: bool,
    stack: Stack,
    /// Cards that arrived before the page was ready, with when.
    early: Vec<(ToastSpec, Instant)>,
    ticking: bool,
    last_tick: Option<Instant>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// When the gear's mute ends (ms since the epoch), 0 for none.
static MUTE_UNTIL: AtomicI64 = AtomicI64::new(0);

fn with<R>(work: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|state| work(&mut state.borrow_mut()))
}

fn mute_path() -> PathBuf {
    crate::runtime().user_data.join("notification-mute.json")
}

/// `notification::Popup` for this shell, and the mute a previous run left.
pub fn install() {
    if let Some(until) = std::fs::read_to_string(mute_path())
        .ok()
        .as_deref()
        .and_then(super::read_mute)
    {
        MUTE_UNTIL.store(until, Ordering::Relaxed);
    }
    notification::set_popup(notification::Popup { show, close });
}

/// Whether the gear's mute holds now (also read by `app.admitNotification`). Any thread.
pub fn muted() -> bool {
    MUTE_UNTIL.load(Ordering::Relaxed) > crate::wall_clock_ms()
}

/// Keeps the mute's end where a relaunch finds it. A failed write leaves the mute in memory for this run.
fn save_mute(until: i64) {
    let path = mute_path();
    let written = path
        .parent()
        .ok_or_else(|| std::io::Error::other("no folder"))
        .and_then(|dir| {
            std::fs::create_dir_all(dir)?;
            let mut temp = tempfile::NamedTempFile::new_in(dir)?;
            temp.write_all(super::mute_file(until).as_bytes())?;
            crate::profile_file::persist(temp, &path)
        });
    if let Err(error) = written {
        log(
            "notification.mute_save_failed",
            json!({"error": error.to_string()}),
        );
    }
}

fn host() -> Host {
    if shell_core::facts::test_notification_popup() {
        Host::Test
    } else if cfg!(windows) {
        Host::Windows
    } else {
        Host::MacOs
    }
}

#[cfg(windows)]
fn gate() -> Result<(), String> {
    shell_core::sys::toast::popup_gate()
}

#[cfg(not(windows))]
fn gate() -> Result<(), String> {
    Ok(())
}

/// Takes `spec` unless it belongs to the OS banner.
fn show(spec: &ToastSpec) -> bool {
    let (route, reason) = super::route(host(), muted(), gate);
    log(
        "notification.route",
        json!({"id": spec.id, "route": route.name(), "reason": reason}),
    );
    match route {
        Route::Banner => return false,
        Route::Muted => {
            emit(spec.id, "close", Some("muted".to_owned()));
            return true;
        }
        Route::Popup | Route::Hidden => {}
    }
    with(|state| state.hidden = route == Route::Hidden);
    if let Err(error) = ensure_window() {
        log("notification.popup.failed", json!({"error": error}));
        return false;
    }
    if with(|state| state.ready) {
        admit(spec);
    } else {
        with(|state| state.early.push((spec.clone(), Instant::now())));
        ui::post_delayed(READY_MS as i64 + 50, give_up_waiting);
    }
    true
}

/// Removes notification `id` if the popup holds it.
fn close(id: u64) -> bool {
    let (removed, waited) = with(|state| {
        let before = state.early.len();
        state.early.retain(|(spec, _)| spec.id != id);
        (state.stack.remove(id), before != state.early.len())
    });
    if removed {
        render();
    }
    removed || waited
}

fn admit(spec: &ToastSpec) {
    let hidden = with(|state| {
        state
            .stack
            .push(Card::new(spec.id, &spec.title, &spec.body));
        state.hidden
    });
    emit(spec.id, "show", None);
    if !hidden && !spec.silent {
        #[cfg(windows)]
        shell_core::sys::toast::play_default_sound();
        #[cfg(target_os = "macos")]
        shell_core::sys_mac::popup_panel::alert_sound();
    }
    render();
    if !hidden {
        start_ticking();
    }
}

/// The cards still waiting for a page that never got ready go to the OS banner.
fn give_up_waiting() {
    let late = with(|state| {
        if state.ready {
            return Vec::new();
        }
        let (late, keep) = std::mem::take(&mut state.early)
            .into_iter()
            .partition::<Vec<_>, _>(|(_, at)| at.elapsed().as_millis() as u64 >= READY_MS);
        state.early = keep;
        late
    });
    for (spec, _) in late {
        log("notification.popup.not_ready", json!({"id": spec.id}));
        notification::banner(&spec);
    }
}

/// Writes the page into the window's `about:blank` until the page runs. Tauri opens a `data:` URL only with its
/// `webview-data-url` feature and reports no load of the first `about:blank`, so the shell writes again every 250 ms:
/// a script sent before the webview has its document is lost. The page says it runs twice over, by the write script's
/// result and by its title (`ompdesk-popup:ready`), whichever reaches the shell first.
fn write_page() {
    let Some((window, tries)) = with(|state| {
        if state.ready {
            return None;
        }
        state.writes += 1;
        Some((state.window.clone()?, state.writes))
    }) else {
        return;
    };
    let page = Value::String(page_html());
    let script = format!(
        "(()=>{{if(!window.render){{document.open();document.write({page});document.close();}}return typeof window.render;}})()"
    );
    let answered = window.eval_with_callback(script, move |answer: String| {
        if answer.contains("function") {
            ui::post(page_ready);
        } else {
            log(
                "notification.popup.write_answer",
                json!({"try": tries, "answer": answer}),
            );
        }
    });
    if let Err(error) = answered {
        log(
            "notification.popup.write_failed",
            json!({"try": tries, "error": error.to_string()}),
        );
    }
    if u64::from(tries) * WRITE_RETRY_MS < READY_MS {
        ui::post_delayed(WRITE_RETRY_MS as i64, write_page);
    }
}

/// The page is up: the cards that waited are drawn.
fn page_ready() {
    let early = with(|state| {
        if state.ready {
            return None;
        }
        state.ready = true;
        Some(std::mem::take(&mut state.early))
    });
    let Some(early) = early else {
        return;
    };
    log("notification.popup.ready", json!({"early": early.len()}));
    for (spec, _) in early {
        admit(&spec);
    }
}

fn act(action: Action) {
    match action {
        Action::Click(id) => {
            if with(|state| state.stack.remove(id)) {
                // A clicked card leaves without a `close`, as a clicked Windows toast does.
                emit(id, "click", None);
            }
        }
        Action::Close(id) => {
            if with(|state| state.stack.remove(id)) {
                emit(id, "close", Some("userCanceled".to_owned()));
            }
        }
        Action::Menu => with(|state| state.stack.toggle_menu()),
        Action::Mute(asked) => {
            let Some(until) = super::mute_until(crate::wall_clock_ms(), asked) else {
                log("notification.mute_refused", json!({"until": asked}));
                return;
            };
            MUTE_UNTIL.store(until, Ordering::Relaxed);
            save_mute(until);
            log("notification.muted", json!({"until": until}));
            for id in with(|state| state.stack.clear()) {
                emit(id, "close", Some("userCanceled".to_owned()));
            }
        }
        Action::Settings => {
            with(|state| state.stack.toggle_menu());
            // As the tray's Open: the window the person last used comes forward, then its page opens Settings.
            if let Some(win) = entry::target(&entry::app_windows()) {
                entry::op(win, "show");
                entry::op(win, "focus");
            }
            entry::menu_action("open-settings");
        }
        Action::Ready => return page_ready(),
    }
    render();
}

fn page_html() -> String {
    let icon = format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(ICON)
    );
    include_str!("page.html").replace("__ICON__", &icon)
}

fn ensure_window() -> Result<(), String> {
    if with(|state| state.window.is_some()) {
        return Ok(());
    }
    let page: url::Url = "about:blank".parse().map_err(|e| format!("{e}"))?;
    let own = page.clone();
    let mut builder =
        WebviewWindowBuilder::new(&crate::runtime().app, LABEL, WebviewUrl::External(page))
            .title("OMPdesk notifications")
            .inner_size(WIDTH, CARD_HEIGHT)
            .visible(false)
            .focused(false)
            .focusable(false)
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(true)
            .disable_drag_drop_handler()
            .theme(theme::for_new_window())
            // Only the blank page the shell writes into; the page asks through its title (`super::action`).
            .on_navigation(move |url| *url == own)
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_document_title_changed(|_, title| {
                if let Some(action) = title
                    .parse::<url::Url>()
                    .ok()
                    .and_then(|url| super::action(&url))
                {
                    ui::post(move || act(action));
                }
            });
    if let Some(colour) = theme::window_background() {
        builder = builder.background_color(colour);
    }
    #[cfg(windows)]
    if let Some(args) = crate::webview_args()? {
        builder = builder.additional_browser_args(&args);
    }
    #[cfg(target_os = "macos")]
    {
        // The panel is never key: the first click must reach the page.
        builder = builder.accept_first_mouse(true);
    }
    // wcId 0: the page never downloads, the only thing the id names.
    builder = crate::sessions::configure_app(builder, "app", 0)?;
    let window = builder.build().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        // The styles the popup needs, whatever tao makes of `focusable(false)` and `skip_taskbar(true)`.
        shell_core::sys::winops::set_focusable(hwnd, false);
        shell_core::sys::winops::set_skip_taskbar(hwnd, true);
        shell_core::sys::winops::set_round_corners(hwnd);
        let (no_activate, tool_window, topmost) = shell_core::sys::winops::unobtrusive_flags(hwnd);
        log(
            "notification.popup.window",
            json!({"noActivate": no_activate, "toolWindow": tool_window, "topmost": topmost}),
        );
    }
    #[cfg(target_os = "macos")]
    {
        // WKWebView answered no script on the window's first `about:blank` (macOS runner: no answer, no title), as if it
        // had no document yet; an explicit load gives it one. App windows get theirs from Node's `loadURL`.
        window
            .navigate("about:blank".parse().map_err(|e| format!("{e}"))?)
            .map_err(|e| e.to_string())?;
        let ns_window = window.ns_window().map_err(|e| e.to_string())? as isize;
        let panel = shell_core::sys_mac::popup_panel::adopt(ns_window)?;
        with(|state| state.panel = panel);
        log(
            "notification.popup.window",
            json!({"nonactivatingPanel": true}),
        );
    }
    with(|state| state.window = Some(window));
    write_page();
    Ok(())
}

/// What the page draws now.
fn view(stack: &Stack) -> Value {
    let lang = tray::language();
    let mut view = stack.view();
    let more = view["more"].as_u64().unwrap_or(0).to_string();
    view["corner"] = json!(if cfg!(target_os = "macos") {
        "top"
    } else {
        "bottom"
    });
    view["dark"] = json!(theme::new_window_dark());
    view["background"] = json!(theme::background_hex());
    view["reducedMotion"] = json!(system::reduced_motion());
    view["lang"] = json!(if lang == Lang::Ko { "ko" } else { "en" });
    view["labels"] = json!({
        "close": text(lang, "notificationPopup.close"),
        "options": text(lang, "notificationPopup.options"),
        "more": fill(lang, "notificationPopup.more", &[("count", &more)]),
        "muteHour": text(lang, "notificationPopup.muteHour"),
        "muteTomorrow": text(lang, "notificationPopup.muteTomorrow"),
        "settings": text(lang, "notificationPopup.settings"),
    });
    view
}

fn render() {
    let Some((window, view, size, empty, hidden)) = with(|state| {
        let window = state.window.clone()?;
        if !state.ready {
            return None;
        }
        Some((
            window,
            view(&state.stack),
            state.stack.size(),
            state.stack.is_empty(),
            state.hidden,
        ))
    }) else {
        return;
    };
    if let Err(error) = window.eval(format!("window.render({view})")) {
        log(
            "notification.popup.render_failed",
            json!({"error": error.to_string()}),
        );
    }
    if hidden {
        return;
    }
    if empty {
        surface_hide(&window);
    } else {
        surface_show(&window, size);
    }
}

#[cfg(windows)]
fn surface_show(window: &WebviewWindow, size: (f64, f64)) {
    let Ok(hwnd) = window.hwnd().map(|handle| handle.0 as isize) else {
        return;
    };
    if let Some(at) = super::place(&screens(), primary(), pointer(), size) {
        shell_core::sys::winops::show_topmost_at(
            hwnd,
            at.x,
            at.y,
            at.width as i32,
            at.height as i32,
        );
    }
}

#[cfg(windows)]
fn surface_hide(window: &WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        shell_core::sys::winops::hide(hwnd.0 as isize);
    }
}

/// Whether the pointer is over the popup (its countdown pauses).
#[cfg(windows)]
fn hovered(window: &WebviewWindow) -> bool {
    let (Ok(at), Ok(size), Some((x, y))) =
        (window.outer_position(), window.outer_size(), pointer())
    else {
        return false;
    };
    x >= f64::from(at.x)
        && y >= f64::from(at.y)
        && x < f64::from(at.x) + f64::from(size.width)
        && y < f64::from(at.y) + f64::from(size.height)
}

#[cfg(target_os = "macos")]
fn surface_show(_: &WebviewWindow, size: (f64, f64)) {
    shell_core::sys_mac::popup_panel::show_top_right(
        with(|state| state.panel),
        size.0,
        size.1,
        super::MARGIN,
    );
}

#[cfg(target_os = "macos")]
fn surface_hide(_: &WebviewWindow) {
    shell_core::sys_mac::popup_panel::hide(with(|state| state.panel));
}

#[cfg(target_os = "macos")]
fn hovered(_: &WebviewWindow) -> bool {
    shell_core::sys_mac::popup_panel::contains_mouse(with(|state| state.panel))
}

#[cfg(windows)]
fn screens() -> Vec<super::Screen> {
    let rect = |x: i32, y: i32, width: u32, height: u32| super::Rect {
        x,
        y,
        width,
        height,
    };
    crate::runtime()
        .app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            super::Screen {
                bounds: rect(
                    monitor.position().x,
                    monitor.position().y,
                    monitor.size().width,
                    monitor.size().height,
                ),
                work_area: rect(
                    area.position.x,
                    area.position.y,
                    area.size.width,
                    area.size.height,
                ),
                scale: monitor.scale_factor(),
            }
        })
        .collect()
}

#[cfg(windows)]
fn primary() -> Option<usize> {
    let app = &crate::runtime().app;
    let primary = app.primary_monitor().ok().flatten()?;
    app.available_monitors()
        .ok()?
        .iter()
        .position(|monitor| monitor.position() == primary.position())
}

#[cfg(windows)]
fn pointer() -> Option<(f64, f64)> {
    crate::runtime()
        .app
        .cursor_position()
        .ok()
        .map(|at| (at.x, at.y))
}

fn start_ticking() {
    let start = with(|state| {
        let start = !state.ticking && !state.stack.is_empty();
        if start {
            state.ticking = true;
            state.last_tick = Some(Instant::now());
        }
        start
    });
    if start {
        ui::post_delayed(TICK_MS, tick);
    }
}

fn tick() {
    let Some(window) = with(|state| state.window.clone()) else {
        return;
    };
    let over = hovered(&window);
    // An idle time the system cannot read counts down as active input does.
    let idle = system::idle_seconds().unwrap_or(0);
    let (expired, more) = with(|state| {
        let now = Instant::now();
        let elapsed = state
            .last_tick
            .map_or(0, |at| now.duration_since(at).as_millis() as u64);
        state.last_tick = Some(now);
        let expired = state.stack.tick(elapsed, over, idle);
        state.ticking = !state.stack.is_empty();
        (expired, state.ticking)
    });
    for id in &expired {
        emit(*id, "close", Some("timedOut".to_owned()));
    }
    if !expired.is_empty() {
        render();
    }
    if more {
        ui::post_delayed(TICK_MS, tick);
    }
}
