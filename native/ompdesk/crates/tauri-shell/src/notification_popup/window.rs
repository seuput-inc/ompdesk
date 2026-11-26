//! The popup's window and page (docs/design/custom-notifications.md). Everything here runs on the UI thread.
//!
//! The window is made at the first popup and kept. It shares the app's WebView2 environment (the same data folder and
//! browser arguments as an app window), so it starts a renderer, not a cold browser. A card that arrives before its
//! page is ready waits up to `READY_MS`, then goes to the OS banner. The page has no app preload and no IPC: the shell
//! draws through `eval(render(…))`, and the page asks by navigating to `ompdesk-popup:`, which the shell cancels.

use std::cell::RefCell;
use std::time::Instant;

use base64::Engine;
use serde_json::{Value, json};
use shell_core::notify_spec::ToastSpec;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{LogicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::{Action, CARD_HEIGHT, Card, Host, READY_MS, Route, Stack, WIDTH};
use crate::labels::{fill, text};
use crate::log::log;
use crate::native_chrome::notification::{self, emit};
use crate::{system, theme, tray, ui};

const LABEL: &str = "notification-popup";
const TICK_MS: i64 = 500;
const ICON: &str = include_str!("../../../../../../resources/brand/mark-tile-small.svg");

#[derive(Default)]
struct State {
    window: Option<WebviewWindow>,
    ready: bool,
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

fn with<R>(work: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|state| work(&mut state.borrow_mut()))
}

/// `notification::Popup` for this shell.
pub fn install() {
    notification::set_popup(notification::Popup { show, close });
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
    Err("no popup on this platform".into())
}

/// Takes `spec` unless it belongs to the OS banner.
fn show(spec: &ToastSpec) -> bool {
    let (route, reason) = super::route(host(), gate);
    log(
        "notification.route",
        json!({"id": spec.id, "route": route.name(), "reason": reason}),
    );
    if route == Route::Banner {
        return false;
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
    #[cfg(windows)]
    if !hidden && !spec.silent {
        shell_core::sys::toast::play_default_sound();
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

fn page_ready() {
    let early = with(|state| {
        state.ready = true;
        std::mem::take(&mut state.early)
    });
    log("notification.popup.ready", json!({"early": early.len()}));
    for (spec, _) in early {
        admit(&spec);
    }
}

fn act(action: Action) {
    let (id, name, reason) = match action {
        Action::Click(id) => (id, "click", None),
        Action::Close(id) => (id, "close", Some("userCanceled".to_owned())),
    };
    if with(|state| state.stack.remove(id)) {
        // A clicked card leaves without a `close`, as a clicked Windows toast does.
        emit(id, name, reason);
        render();
    }
}

fn page_url() -> String {
    let icon = format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(ICON)
    );
    let page = include_str!("page.html").replace("__ICON__", &icon);
    format!(
        "data:text/html;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(page)
    )
}

fn ensure_window() -> Result<(), String> {
    if with(|state| state.window.is_some()) {
        return Ok(());
    }
    let page: url::Url = page_url().parse().map_err(|e| format!("{e}"))?;
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
            .on_navigation(move |url| {
                if let Some(action) = super::action(url) {
                    ui::post(move || act(action));
                    return false;
                }
                *url == own
            })
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_page_load(|_, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    ui::post(page_ready);
                }
            });
    if let Some(colour) = theme::window_background() {
        builder = builder.background_color(colour);
    }
    #[cfg(windows)]
    if let Some(args) = crate::webview_args()? {
        builder = builder.additional_browser_args(&args);
    }
    // wcId 0: the page never downloads, the only thing the id names.
    builder = crate::sessions::configure_app(builder, "app", 0)?;
    let window = builder.build().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        shell_core::sys::winops::set_round_corners(hwnd);
        let (no_activate, tool_window, topmost) = shell_core::sys::winops::unobtrusive_flags(hwnd);
        log(
            "notification.popup.window",
            json!({"noActivate": no_activate, "toolWindow": tool_window, "topmost": topmost}),
        );
    }
    with(|state| state.window = Some(window));
    Ok(())
}

/// What the page draws now.
fn view(stack: &Stack) -> Value {
    let lang = tray::language();
    let mut view = stack.view();
    let more = view["more"].as_u64().unwrap_or(0).to_string();
    view["dark"] = json!(theme::is_dark());
    view["background"] = json!(theme::background_hex());
    view["reducedMotion"] = json!(system::reduced_motion());
    view["lang"] = json!(if lang == crate::labels::Lang::Ko {
        "ko"
    } else {
        "en"
    });
    view["labels"] = json!({
        "close": text(lang, "notificationPopup.close"),
        "more": fill(lang, "notificationPopup.more", &[("count", &more)]),
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
        let _ = window.set_size(LogicalSize::new(size.0, size.1.max(1.0)));
        return;
    }
    #[cfg(windows)]
    {
        let Ok(hwnd) = window.hwnd().map(|handle| handle.0 as isize) else {
            return;
        };
        if empty {
            shell_core::sys::winops::hide(hwnd);
            return;
        }
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
    #[cfg(not(windows))]
    let _ = empty;
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

fn pointer() -> Option<(f64, f64)> {
    crate::runtime()
        .app
        .cursor_position()
        .ok()
        .map(|at| (at.x, at.y))
}

/// Whether the pointer is over the popup (its countdown pauses).
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
    let idle = system::idle_seconds();
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
