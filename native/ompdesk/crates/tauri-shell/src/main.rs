#![windows_subsystem = "windows"]

mod assets;
#[cfg(feature = "test-automation")]
mod automation;
mod evaluate;
mod gpu;
mod migrate_watch;
mod native_chrome;
mod native_services;
mod network;
mod page_watch;
mod preview_protocol;
pub use native_chrome::menu;
mod preview;
mod preview_surface;
mod process_failed;
mod profile;
mod registry;
mod runtime_inputs;
mod sessions;
mod theme;
mod ui;
#[cfg(windows)]
mod window_activation;
mod window_bounds;
use native_services::diagnostic_logs::{FeedbackRead, feedback_profile};
use native_services::{power, screen, shortcut, system};
// These are the existing engine-independent Node wire, child lifetime and log authorities.
#[path = "../../shell/src/host.rs"]
pub mod host;
#[path = "../../shell/src/log.rs"]
pub mod log;
#[path = "../../shell/src/node.rs"]
pub mod node;
pub mod lifecycle {
    pub static EXITING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
}

use registry::{Identity, Registry, trusted_url};
use serde_json::{Value, json};
use shell_core::wire::WireError;
use shell_core::{conn, facts, startup};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        value.push(char::from(DIGITS[usize::from(byte >> 4)]));
        value.push(char::from(DIGITS[usize::from(byte & 15)]));
    }
    value
}

struct Migration {
    profile: profile::Profile,
    targets: HashMap<u64, String>,
    offers: HashMap<u64, (Identity, String, usize)>,
    watches: migrate_watch::Watches,
    /// A given-up migration's reason, until the blank page that shows it has loaded.
    failures: HashMap<u64, String>,
}

type AppInitialization = tokio::sync::watch::Receiver<Option<Result<(), String>>>;

struct Runtime {
    app: tauri::AppHandle,
    preview: preview::Service,
    gateway: Arc<preview_protocol::Gateway>,
    content_policy: String,
    registry: Mutex<Registry>,
    migration: Mutex<Migration>,
    app_initializations: Mutex<HashMap<u64, AppInitialization>>,
    navigation_watch: Mutex<HashSet<u64>>,
    host_navigations: Mutex<HashMap<u64, String>>,
    preload: String,
    user_data: PathBuf,
    feedback_profile: PathBuf,
    renderer: PathBuf,
    user_agent: Mutex<Option<String>>,
    relaunch: Mutex<Option<Vec<String>>>,
    stop_instance: AtomicBool,
    instance_thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}
static RUNTIME: OnceLock<Runtime> = OnceLock::new();
fn runtime() -> &'static Runtime {
    RUNTIME
        .get()
        .expect("Tauri runtime initialized before Node")
}
fn failed(error: impl std::fmt::Display) -> WireError {
    WireError::new("failed", error.to_string())
}
fn unsupported(method: &str) -> WireError {
    WireError::new(
        "unsupported",
        format!("{method} is not implemented by the system-WebView host"),
    )
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, WireError> {
    value[key]
        .as_str()
        .ok_or_else(|| WireError::new("invalid", format!("missing string {key}")))
}
fn number(value: &Value, key: &str) -> Result<u64, WireError> {
    value[key]
        .as_u64()
        .filter(|id| *id > 0)
        .ok_or_else(|| WireError::new("invalid", format!("invalid {key}")))
}
fn wc_event(wc: u64, name: &str, args: Value) {
    host::event("wc.event", json!({"wcId":wc,"name":name,"args":args}));
}
fn win_event(win: u64, name: &str) {
    host::event("win.event", json!({"winId":win,"name":name,"args":[]}));
}
fn window_for_wc(wc: u64) -> Result<WebviewWindow, WireError> {
    let label = runtime()
        .registry
        .lock()
        .expect("registry")
        .page(wc)
        .map(|p| p.label.clone())
        .ok_or_else(|| WireError::new("gone", "unknown page"))?;
    runtime()
        .app
        .get_webview_window(&label)
        .ok_or_else(|| WireError::new("gone", "page closed"))
}
fn window_for_win(win: u64) -> Result<WebviewWindow, WireError> {
    let wc = runtime()
        .registry
        .lock()
        .expect("registry")
        .by_window(win)
        .map(|p| p.identity.wc)
        .ok_or_else(|| WireError::new("gone", "unknown window"))?;
    window_for_wc(wc)
}
/// Electron's `isFocused`: the window's own activation, not the keyboard focus of its page (`Widget::IsActive`,
/// `-[NSWindow isKeyWindow]`). tao's `is_focused` on Windows also wants `WM_SETFOCUS` on the window itself (tao 0.37.2
/// `has_active_focus`), which a window whose WebView holds the focus does not get.
#[cfg(windows)]
fn window_focused(window: &WebviewWindow) -> Result<bool, WireError> {
    Ok(window_activation::is_active(
        window.hwnd().map_err(failed)?.0 as isize,
    ))
}
#[cfg(not(windows))]
fn window_focused(window: &WebviewWindow) -> Result<bool, WireError> {
    window.is_focused().map_err(failed)
}
fn wc_state(wc: u64) {
    let r = runtime();
    let registry = r.registry.lock().expect("registry");
    if let Some(page) = registry.page(wc) {
        let mut state = json!({"wcId":wc,"url":page.url,"title":page.title,
            "loading":page.loading,"zoomFactor":page.zoom});
        if page.kind == registry::Kind::App
            && let Some(agent) = r.user_agent.lock().expect("user agent").as_deref()
        {
            state["userAgent"] = json!(agent);
        }
        host::event("wc.state", state);
    }
}
fn win_state(window: &WebviewWindow, win: u64) -> Result<Value, WireError> {
    let scale = window.scale_factor().map_err(failed)?;
    let position = window
        .outer_position()
        .map_err(failed)?
        .to_logical::<f64>(scale);
    let size = window
        .outer_size()
        .map_err(failed)?
        .to_logical::<f64>(scale);
    let inner_position = window
        .inner_position()
        .map_err(failed)?
        .to_logical::<f64>(scale);
    let inner_size = window
        .inner_size()
        .map_err(failed)?
        .to_logical::<f64>(scale);
    let bounds = json!({"x":position.x,"y":position.y,"width":size.width,"height":size.height});
    let maximized = window.is_maximized().map_err(failed)?;
    let minimized = window.is_minimized().map_err(failed)?;
    let fullscreen = window.is_fullscreen().map_err(failed)?;
    let mut state = json!({"winId":win,"bounds":bounds,
        "contentBounds":{"x":inner_position.x,"y":inner_position.y,"width":inner_size.width,"height":inner_size.height},
        "visible":window.is_visible().map_err(failed)?,"focused":window_focused(window)?,
        "minimized":minimized,"maximized":maximized,
        "fullscreen":fullscreen,"title":window.title().map_err(failed)?,"opacity":1.0});
    if !maximized && !minimized && !fullscreen {
        state["normalBounds"] = bounds;
    }
    host::event("win.state", state.clone());
    Ok(state)
}
fn profile_bootstrap(url: &str) -> bool {
    let base = url.split(['?', '#']).next().unwrap_or(url);
    base == "app://ompdesk/__profile/migrate"
        || (cfg!(windows) && base == "http://app.localhost/__profile/migrate")
}
fn bootstrap_url() -> &'static str {
    if cfg!(windows) {
        "http://app.localhost/__profile/migrate"
    } else {
        "app://ompdesk/__profile/migrate"
    }
}
/// Test seam (`OMP_GUI_TEST_SHELL_STALL_MIGRATE=<n>`, test builds only): the first `n` requests for the migration page
/// are never answered.
#[cfg(feature = "test-automation")]
fn stall_bootstrap_request() -> bool {
    static STALLED: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let wanted = std::env::var("OMP_GUI_TEST_SHELL_STALL_MIGRATE")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    STALLED
        .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < wanted).then(|| n + 1)
        })
        .is_ok()
}

/// Records how far `wc` got through the migration page in tauri-shell.jsonl; `start` begins a timed round when none
/// runs (`migrate_watch.rs`). The caller holds `migration`.
fn migration_step(migration: &mut Migration, wc: u64, step: migrate_watch::Step, start: bool) {
    let now = Instant::now();
    let (round, attempt) = if start {
        let (round, attempt) = migration.watches.start(wc, step, now);
        (round, Some(attempt))
    } else {
        (None, migration.watches.step(wc, step, now))
    };
    log::log(
        "profile.migrate",
        json!({"wcId":wc,"step":step.name(),"attempt":attempt}),
    );
    if let Some(round) = round {
        time_migration(wc, round);
    }
}

fn time_migration(wc: u64, round: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            let due = runtime().migration.lock().expect("migration").watches.due(
                wc,
                round,
                Instant::now(),
            );
            let (after, retry) = match due {
                migrate_watch::Due::Ended => return,
                migrate_watch::Due::Wait(wait) => {
                    tokio::time::sleep(wait).await;
                    continue;
                }
                migrate_watch::Due::Retry { attempt, after } => (after, Some(attempt)),
                migrate_watch::Due::GiveUp { after } => (after, None),
            };
            log::log(
                "profile.migrate.stalled",
                json!({"wcId":wc,"step":after.name(),"waitedMs":migrate_watch::STEP_TIMEOUT.as_millis(),"retry":retry}),
            );
            let app = runtime().app.clone();
            let dispatched = match retry {
                Some(attempt) => app.run_on_main_thread(move || retry_migration(wc, attempt)),
                None => app.run_on_main_thread(move || give_up_migration(wc, after)),
            };
            if let Err(error) = dispatched {
                log::log(
                    "profile.migrate.dispatch_failed",
                    json!({"wcId":wc,"error":error.to_string()}),
                );
            }
            if retry.is_none() {
                return;
            }
        }
    });
}

/// Loads the migration page again (the app page once the profile is done), as `loadURL` did.
fn retry_migration(wc: u64, attempt: u32) {
    let destination = {
        let mut migration = runtime().migration.lock().expect("migration");
        let Some(target) = migration.targets.get(&wc).cloned() else {
            return;
        };
        log::log(
            "profile.migrate",
            json!({"wcId":wc,"step":migrate_watch::Step::Navigate.name(),"attempt":attempt}),
        );
        if migration.profile.pending() {
            migration.offers.remove(&wc);
            bootstrap_url().to_owned()
        } else {
            target
        }
    };
    let navigated = window_for_wc(wc)
        .map_err(|error| error.message)
        .and_then(|window| {
            window
                .navigate(expect_navigation(wc, &destination)?)
                .map_err(|error| error.to_string())
        });
    if let Err(error) = navigated {
        log::log(
            "profile.migrate.retry_failed",
            json!({"wcId":wc,"error":error}),
        );
    }
}

/// Shows the window with the reason and a Retry that loads the migration page again. The reason goes on a fresh blank
/// page: the document a request that never came back leaves in place answers no script (Playwright's evaluate timed
/// out on it), so it is navigated away from first and the text is written once the blank page has loaded.
fn give_up_migration(wc: u64, after: migrate_watch::Step) {
    let reason = format!(
        "OMPdesk could not open its window: the profile migration step \"{}\" got no answer in {} s, {} times. Your existing data has not been overwritten.",
        after.name(),
        migrate_watch::STEP_TIMEOUT.as_secs(),
        migrate_watch::ATTEMPTS
    );
    log::log(
        "profile.migrate.gave_up",
        json!({"wcId":wc,"step":after.name(),"reason":reason}),
    );
    let win = runtime()
        .registry
        .lock()
        .expect("registry")
        .page(wc)
        .and_then(|page| page.identity.win);
    if let Some(win) = win {
        win_event(win, "ready-to-show");
    }
    wc_event(
        wc,
        "preload-error",
        json!(["profile migration", {"message": reason}]),
    );
    runtime()
        .migration
        .lock()
        .expect("migration")
        .failures
        .insert(wc, reason);
    let navigated = window_for_wc(wc)
        .map_err(|error| error.message)
        .and_then(|window| {
            window
                .navigate("about:blank".parse().map_err(|_| "invalid blank URL")?)
                .map_err(|error| error.to_string())
        });
    if let Err(error) = navigated {
        log::log(
            "profile.migrate.show_failed",
            json!({"wcId":wc,"error":error}),
        );
    }
}

/// Writes a given-up migration's reason and its Retry into the blank page `give_up_migration` loaded.
fn show_migration_failure(wc: u64) {
    let Some(reason) = runtime()
        .migration
        .lock()
        .expect("migration")
        .failures
        .remove(&wc)
    else {
        return;
    };
    // The Retry is a navigation the page starts; the host expects it, so Node's `will-navigate` is not asked.
    let shown = expect_navigation(wc, bootstrap_url()).and_then(|_| {
        let script = format!(
            r#"(() => {{
  const text = document.body.appendChild(document.createElement("p"));
  text.id = "omp-profile-error";
  text.setAttribute("role", "alert");
  text.textContent = {reason};
  const retry = document.body.appendChild(document.createElement("button"));
  retry.id = "omp-profile-retry";
  retry.textContent = "Retry / 다시 시도";
  retry.onclick = () => {{ location.href = {url}; }};
}})();"#,
            reason = json!(reason),
            url = json!(bootstrap_url()),
        );
        window_for_wc(wc)
            .map_err(|error| error.message)?
            .eval(script)
            .map_err(|error| error.to_string())
    });
    if let Err(error) = shown {
        log::log(
            "profile.migrate.show_failed",
            json!({"wcId":wc,"error":error}),
        );
    }
}

fn page_load(wc: u64, url: &str, event: PageLoadEvent) {
    if url == "about:blank" {
        if event == PageLoadEvent::Finished {
            show_migration_failure(wc);
        }
        return;
    }
    if profile_bootstrap(url) {
        if event == PageLoadEvent::Started {
            runtime()
                .registry
                .lock()
                .expect("registry")
                .navigate(wc, url.into());
        }
        let step = if event == PageLoadEvent::Started {
            migrate_watch::Step::Loading
        } else {
            migrate_watch::Step::Loaded
        };
        // A Retry the page itself starts (its button) is a new timed round.
        migration_step(
            &mut runtime().migration.lock().expect("migration"),
            wc,
            step,
            event == PageLoadEvent::Started,
        );
        return;
    }
    if event == PageLoadEvent::Started {
        {
            let mut migration = runtime().migration.lock().expect("migration");
            migration.targets.remove(&wc);
            migration.offers.remove(&wc);
            if let Some((attempt, _)) = migration.watches.end(wc) {
                log::log(
                    "profile.migrate",
                    json!({"wcId":wc,"step":"app","attempt":attempt}),
                );
            }
        }
        let changed = runtime()
            .registry
            .lock()
            .expect("registry")
            .navigate(wc, url.into());
        if changed.is_none() {
            return;
        }
        wc_state(wc);
        wc_event(wc, "did-start-loading", json!([]));
        wc_event(
            wc,
            "did-start-navigation",
            json!([{"url":url,"isMainFrame":true,"isSameDocument":false,"isInPlace":false}]),
        );
    } else {
        let win = {
            let mut registry = runtime().registry.lock().expect("registry");
            let Some(page) = registry.page_mut(wc) else {
                return;
            };
            page.loading = false;
            page.identity.win
        };
        wc_state(wc);
        wc_event(wc, "did-navigate", json!([url]));
        wc_event(wc, "did-stop-loading", json!([]));
        wc_event(wc, "did-finish-load", json!([]));
        if let Some(win) = win {
            win_event(win, "ready-to-show");
        }
    }
}
/// Records a navigation the host itself starts (`loadURL`, the profile gate's hand-over, `reload`): Electron raises no
/// `will-navigate` for those, so `node_prevents_navigation` tells them from the page's own by their URL.
fn expect_navigation(wc: u64, url: &str) -> Result<tauri::Url, String> {
    let parsed: tauri::Url = url
        .parse()
        .map_err(|error| format!("invalid navigation URL: {error}"))?;
    runtime()
        .host_navigations
        .lock()
        .expect("host navigations")
        .insert(wc, parsed.as_str().to_owned());
    Ok(parsed)
}

/// Whether Node's `will-navigate` listeners refuse a navigation the page started (not one inside its own document):
/// asked only for a page whose Node side listens (`watchEvents`), held for the answer (2 s, then refused, as
/// PROTOCOL.md `wc.navigate` says). The UI thread waits; Node answers from its own thread.
fn node_prevents_navigation(wc: u64, url: &tauri::Url) -> bool {
    {
        let mut expected = runtime().host_navigations.lock().expect("host navigations");
        if expected.get(&wc).is_some_and(|own| own == url.as_str()) {
            expected.remove(&wc);
            return false;
        }
    }
    // A move inside the document (a fragment) is not a navigation Electron's `will-navigate` reports.
    let without_fragment = |url: &str| url.split('#').next().unwrap_or(url).to_owned();
    if runtime()
        .registry
        .lock()
        .expect("registry")
        .page(wc)
        .is_some_and(|page| without_fragment(&page.url) == without_fragment(url.as_str()))
    {
        return false;
    }
    if !runtime()
        .navigation_watch
        .lock()
        .expect("navigation watch")
        .contains(&wc)
    {
        return false;
    }
    let shown = if cfg!(windows) {
        url.as_str()
            .replacen("http://app.localhost", "app://ompdesk", 1)
    } else {
        url.to_string()
    };
    let answer = host::request_blocking(
        "wc.navigate",
        json!({"wcId":wc,"kind":"will-navigate","url":shown,"isMainFrame":true,"isSameDocument":false,"isRedirect":false}),
        Duration::from_secs(2),
    );
    answer.map_or(true, |answer| answer["prevent"] != false)
}
fn close_record(wc: u64) {
    runtime()
        .app_initializations
        .lock()
        .expect("app initialization")
        .remove(&wc);
    runtime()
        .navigation_watch
        .lock()
        .expect("navigation watch")
        .remove(&wc);
    runtime()
        .host_navigations
        .lock()
        .expect("host navigations")
        .remove(&wc);
    {
        let mut migration = runtime().migration.lock().expect("migration");
        migration.targets.remove(&wc);
        migration.offers.remove(&wc);
        migration.watches.end(wc);
        migration.failures.remove(&wc);
    }
    let page = runtime().registry.lock().expect("registry").remove(wc);
    if let Some(page) = page {
        if let Some(win) = page.identity.win {
            host::event(
                "win.state",
                json!({"winId":win,"visible":false,"focused":false}),
            );
        }
        wc_event(wc, "destroyed", json!([]));
        if let Some(win) = page.identity.win {
            win_event(win, "closed");
        }
    }
}
fn create_window(params: &Value) -> Result<Value, WireError> {
    let win = number(params, "winId")?;
    let wc = number(params, "wcId")?;
    let options = &params["options"];
    if options
        .pointer("/webPreferences/session")
        .and_then(Value::as_str)
        .is_some_and(|s| s != "app")
    {
        return Err(WireError::new(
            "denied",
            "app windows must use the app session",
        ));
    }
    let label = runtime()
        .registry
        .lock()
        .expect("registry")
        .create(win, wc)
        .map_err(|e| WireError::new("invalid", e))?;
    let bounds = screen::with_displays(|snapshot| window_bounds::for_create(options, snapshot));
    let mut builder = WebviewWindowBuilder::new(
        &runtime().app,
        &label,
        WebviewUrl::External("about:blank".parse().map_err(failed)?),
    )
    .title(options["title"].as_str().unwrap_or("OMPdesk"))
    .inner_size(bounds.width, bounds.height)
    .visible(options["show"].as_bool().unwrap_or(true))
    .focused(options["show"].as_bool().unwrap_or(true))
    .disable_drag_drop_handler()
    .theme(theme::for_new_window())
    .initialization_script(&runtime().preload)
    .on_navigation(move |url| {
        let allowed = url.as_str() == "about:blank"
            || (trusted_url(url.as_str())
                && (!runtime()
                    .migration
                    .lock()
                    .expect("migration")
                    .profile
                    .pending()
                    || profile_bootstrap(url.as_str())));
        if !allowed {
            log::log("navigation.denied", json!({"wcId":wc,"url":url.as_str()}));
        }
        // Node's own handler (`will-navigate`) sees every navigation the page starts, as Electron's did, and may refuse it.
        let prevented = url.as_str() != "about:blank" && node_prevents_navigation(wc, url);
        allowed && !prevented
    })
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_page_load(move |_, payload| page_load(wc, payload.url().as_str(), payload.event()))
    .on_document_title_changed(move |window, title| {
        if window
            .url()
            .is_ok_and(|url| profile_bootstrap(url.as_str()))
        {
            return;
        }
        if let Some(page) = runtime().registry.lock().expect("registry").page_mut(wc) {
            page.title = title.clone();
        }
        wc_state(wc);
        wc_event(wc, "page-title-updated", json!([title, true]));
    });
    if let Some((x, y)) = bounds.position {
        builder = builder.position(x, y);
    }
    if let (Some(w), Some(h)) = (options["minWidth"].as_f64(), options["minHeight"].as_f64()) {
        builder = builder.min_inner_size(w, h);
    }
    #[cfg(target_os = "macos")]
    if matches!(
        options["titleBarStyle"].as_str(),
        Some("hidden" | "hiddenInset")
    ) {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    // Electron's `titleBarStyle: "hidden"` + `titleBarOverlay`: no OS caption; the page draws the caption buttons and its
    // own top bar is the drag area (`-webkit-app-region`, which WebView2 serves as a non-client region).
    #[cfg(windows)]
    if options["titleBarStyle"].as_str() == Some("hidden") {
        builder = builder.decorations(false);
    }
    // `backgroundMaterial: "mica"` (a window that first shows restored on Windows 11): the backdrop shows through the
    // page where it is transparent (`?mica=1`).
    #[cfg(windows)]
    if options["backgroundMaterial"].as_str() == Some("mica") {
        builder = builder.transparent(true).effects(
            tauri::window::EffectsBuilder::new()
                .effect(tauri::window::Effect::Mica)
                .build(),
        );
    }
    #[cfg(windows)]
    if let Some(args) = webview_args().map_err(failed)? {
        builder = builder.additional_browser_args(&args);
    }
    builder = match sessions::configure_app(builder, "app", wc) {
        Ok(builder) => builder,
        Err(error) => {
            runtime().registry.lock().expect("registry").remove(wc);
            return Err(failed(error));
        }
    };
    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            runtime().registry.lock().expect("registry").remove(wc);
            return Err(failed(error));
        }
    };
    #[cfg(windows)]
    if let Err(error) = window
        .hwnd()
        .map_err(|error| error.to_string())
        .and_then(|hwnd| window_activation::watch(hwnd.0 as isize, win))
    {
        let _ = window.destroy();
        runtime().registry.lock().expect("registry").remove(wc);
        return Err(failed(error));
    }
    #[cfg(windows)]
    page_watch::attach(&window, wc);
    if !options["useContentSize"].as_bool().unwrap_or(false) {
        apply_size(&window, bounds.width, bounds.height, false)?;
    }
    let webview = runtime()
        .app
        .get_webview(&label)
        .ok_or_else(|| WireError::new("gone", "created app WebView missing"))?;
    #[cfg(windows)]
    if let Err(error) = process_failed::watch(&webview) {
        eprintln!("[tauri-shell] ProcessFailed not watched for wc {wc}: {error}");
    }
    let (initialized, ready) = tokio::sync::watch::channel(None);
    runtime()
        .app_initializations
        .lock()
        .expect("app initialization")
        .insert(wc, ready);
    tauri::async_runtime::spawn(async move {
        let result = sessions::attach_app("app", webview.clone()).await;
        initialized.send_replace(Some(result.clone()));
        if let Err(error) = result {
            let app = runtime().app.clone();
            let _ = app.run_on_main_thread(move || {
                wc_event(
                    wc,
                    "preload-error",
                    json!(["native session",{"message":error}]),
                );
                destroy_app(wc, None);
            });
        }
    });
    let observer = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            tauri::async_runtime::spawn_blocking(move || {
                let answer = host::request_blocking(
                    "win.closeRequested",
                    json!({"winId":win}),
                    Duration::from_secs(5),
                );
                if !answer.ok().is_some_and(|v| v["prevent"] == true) {
                    let app = runtime().app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if let Ok(w) = window_for_wc(wc) {
                            drop(w);
                            destroy_app(wc, None);
                        }
                    });
                }
            });
        }
        WindowEvent::Destroyed => {
            runtime().registry.lock().expect("registry").begin_close(wc);
            tauri::async_runtime::spawn(async move {
                if let Err(error) = runtime().preview.close_parent(win).await {
                    log::log(
                        "window.children.close_failed",
                        json!({"wcId":wc,"code":error.code}),
                    );
                }
                close_record(wc);
            });
        }
        WindowEvent::Focused(focus) => {
            // Windows: the window's activation reaches Node through `window_activation`; this event is the focus of
            // the window's WebView, which can come while the window is hidden or inactive.
            #[cfg(windows)]
            window_activation::webview_focus(&observer, win, *focus);
            #[cfg(not(windows))]
            {
                let _ = win_state(&observer, win);
                win_event(win, if *focus { "focus" } else { "blur" });
            }
        }
        WindowEvent::Resized(_) => {
            let _ = win_state(&observer, win);
            win_event(win, "resize");
        }
        WindowEvent::Moved(_) => {
            let _ = win_state(&observer, win);
            win_event(win, "move");
        }
        _ => {}
    });
    wc_state(wc);
    Ok(json!({"state":win_state(&window,win)?}))
}
/// wry 0.57.1 (src/webview2/mod.rs, `additional_browser_args` default): the flags it passes when none are given, which
/// setting any replaces. The app's webviews set no proxy, and wry's `autoplay` defaults to true.
#[cfg(windows)]
const WRY_DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// The browser arguments of the app's WebView2s: none while wry's defaults serve, else those defaults and what the app
/// asked of Chromium (the GPU off at `app.init`; in a test build also its DevTools port and fake media devices).
#[cfg(windows)]
fn webview_args() -> Result<Option<String>, String> {
    let mut extra = Vec::new();
    if gpu::disabled() {
        extra.push("--disable-gpu".to_owned());
    }
    #[cfg(feature = "test-automation")]
    extra.extend(automation::browser_args()?);
    Ok((!extra.is_empty()).then(|| format!("{WRY_DEFAULT_ARGS} {}", extra.join(" "))))
}
/// Electron's `show` on a window that cannot take focus (`setFocusable(false)`, the e2e harness's windows): it appears
/// without activation, as PROTOCOL.md says; one that can takes the focus.
#[cfg(windows)]
fn show(window: &WebviewWindow) -> tauri::Result<()> {
    if shell_core::sys::winops::is_focusable(window.hwnd()?.0 as isize) {
        window.show()
    } else {
        window_activation::show_inactive(window, "show")
    }
}
fn win_op(params: &Value) -> Result<Value, WireError> {
    let win = number(params, "winId")?;
    let window = window_for_win(win)?;
    let op = string(params, "op")?;
    let a = &params["args"];
    match op {
        #[cfg(windows)]
        "show" => show(&window),
        #[cfg(not(windows))]
        "show" => window.show(),
        "setFocusable" => window.set_focusable(
            a["focusable"]
                .as_bool()
                .ok_or_else(|| WireError::new("invalid", "missing focusable"))?,
        ),
        #[cfg(windows)]
        "showInactive" => window_activation::show_inactive(&window, "showInactive"),
        "hide" => window.hide(),
        "focus" => window.set_focus(),
        "minimize" => window.minimize(),
        "maximize" => window.maximize(),
        "unmaximize" => window.unmaximize(),
        "restore" => window.unminimize(),
        "center" => window.center(),
        "setTitle" => window.set_title(string(a, "title")?),
        "setFullScreen" => window.set_fullscreen(
            a["on"]
                .as_bool()
                .ok_or_else(|| WireError::new("invalid", "missing on"))?,
        ),
        "setAlwaysOnTop" => window.set_always_on_top(
            a["flag"]
                .as_bool()
                .ok_or_else(|| WireError::new("invalid", "missing flag"))?,
        ),
        "setSkipTaskbar" => window.set_skip_taskbar(
            a["skip"]
                .as_bool()
                .ok_or_else(|| WireError::new("invalid", "missing skip"))?,
        ),
        "setIgnoreMouseEvents" => window.set_ignore_cursor_events(
            a["ignore"]
                .as_bool()
                .ok_or_else(|| WireError::new("invalid", "missing ignore"))?,
        ),
        "setSize" | "setContentSize" => {
            apply_size(
                &window,
                dimension(a, "width")?,
                dimension(a, "height")?,
                op == "setContentSize",
            )?;
            Ok(())
        }
        "setTitleBarOverlay" => {
            // The page draws the caption buttons (src/preload/tauri.ts): their colors are its to repaint.
            let colors = json!({"color":a["color"],"symbolColor":a["symbolColor"]});
            window.eval(format!("window.__ompTauriCaption?.({colors});"))
        }
        "setPosition" => window.set_position(tauri::LogicalPosition::new(
            coordinate(a, "x")?,
            coordinate(a, "y")?,
        )),
        "setBounds" => {
            let b = &a["bounds"];
            window
                .set_position(tauri::LogicalPosition::new(
                    coordinate(b, "x")?,
                    coordinate(b, "y")?,
                ))
                .map_err(failed)?;
            apply_size(
                &window,
                dimension(b, "width")?,
                dimension(b, "height")?,
                false,
            )?;
            Ok(())
        }
        _ => return Err(unsupported(&format!("win.op {op}"))),
    }
    .map_err(failed)?;
    if !matches!(op, "close" | "destroy") {
        win_state(&window, win)?;
        if matches!(
            op,
            "show" | "showInactive" | "hide" | "minimize" | "maximize" | "unmaximize" | "restore"
        ) {
            win_event(win, if op == "showInactive" { "show" } else { op });
        }
    }
    Ok(json!({}))
}
fn apply_size(
    window: &WebviewWindow,
    width: f64,
    height: f64,
    content: bool,
) -> Result<(), WireError> {
    let (width, height) = if content {
        (width, height)
    } else {
        let scale = window.scale_factor().map_err(failed)?;
        let outer = window
            .outer_size()
            .map_err(failed)?
            .to_logical::<f64>(scale);
        let inner = window
            .inner_size()
            .map_err(failed)?
            .to_logical::<f64>(scale);
        let width = width - (outer.width - inner.width);
        let height = height - (outer.height - inner.height);
        if width <= 0.0 || height <= 0.0 {
            return Err(WireError::new(
                "invalid",
                "outer size is smaller than native frame",
            ));
        }
        (width, height)
    };
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(failed)
}
fn coordinate(v: &Value, key: &str) -> Result<f64, WireError> {
    v[key]
        .as_f64()
        .filter(|n| n.is_finite())
        .ok_or_else(|| WireError::new("invalid", format!("invalid {key}")))
}
fn dimension(v: &Value, key: &str) -> Result<f64, WireError> {
    coordinate(v, key).and_then(|n| {
        if n > 0.0 {
            Ok(n)
        } else {
            Err(WireError::new("invalid", format!("invalid {key}")))
        }
    })
}
/// A `wc.op` the engine answers later.
enum Later {
    Evaluate(WebviewWindow, String),
    Crash(WebviewWindow, u64),
}
fn wc_op(call: host::Call) {
    let Some(call) = defer_app_load(call) else {
        return;
    };
    let result = (|| {
        let wc = number(&call.params, "wcId")?;
        let window = window_for_wc(wc)?;
        let op = string(&call.params, "op")?;
        let a = &call.params["args"];
        match op {
            "loadURL" => {
                let url = string(a, "url")?;
                if !trusted_url(url) {
                    return Err(WireError::new(
                        "denied",
                        "app windows cannot load remote pages",
                    ));
                }
                #[cfg(windows)]
                let url = url.replacen("app://ompdesk", "http://app.localhost", 1);
                let destination = {
                    let mut migration = runtime().migration.lock().expect("migration");
                    if migration.profile.pending() {
                        migration.targets.insert(wc, url.to_string());
                        migration.offers.remove(&wc);
                        migration_step(&mut migration, wc, migrate_watch::Step::Navigate, true);
                        bootstrap_url().to_owned()
                    } else {
                        url.to_string()
                    }
                };
                window
                    .navigate(
                        expect_navigation(wc, &destination)
                            .map_err(|message| WireError::new("invalid", message))?,
                    )
                    .map_err(failed)?;
            }
            "reload" | "reloadIgnoringCache" => {
                if op == "reloadIgnoringCache" {
                    return Err(unsupported(op));
                }
                if let Ok(current) = window.url() {
                    expect_navigation(wc, current.as_str())
                        .map_err(|message| WireError::new("invalid", message))?;
                }
                window.eval("location.reload()").map_err(failed)?;
            }
            "stop" => window.eval("window.stop()").map_err(failed)?,
            "setZoomFactor" => {
                let factor = dimension(a, "factor")?;
                window.set_zoom(factor).map_err(failed)?;
                if let Some(p) = runtime().registry.lock().expect("registry").page_mut(wc) {
                    p.zoom = factor;
                }
                wc_state(wc);
            }
            "focus" => window.set_focus().map_err(failed)?,
            "openDevTools" => window.open_devtools(),
            "closeDevTools" => window.close_devtools(),
            "watchEvents" => {
                let names = a["names"].as_array().map(Vec::as_slice).unwrap_or_default();
                if names.iter().any(|name| name == "will-navigate") {
                    runtime()
                        .navigation_watch
                        .lock()
                        .expect("navigation watch")
                        .insert(wc);
                }
                let unwatched: Vec<&str> = names
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|name| *name != "will-navigate")
                    .collect();
                if !unwatched.is_empty() {
                    return Err(unsupported(&format!(
                        "webContents events {}",
                        unwatched.join(", ")
                    )));
                }
            }
            "executeJavaScript" => {
                return Ok(Some(Later::Evaluate(window, string(a, "code")?.to_owned())));
            }
            "forcefullyCrashRenderer" => return Ok(Some(Later::Crash(window, wc))),
            _ => return Err(unsupported(&format!("wc.op {op}"))),
        }
        Ok(None)
    })();
    match result {
        Err(error) => call.err(&error.code, error.message),
        Ok(None) => call.ok(json!({})),
        // The engine's own evaluation, outside the page's CSP (evaluate.rs).
        Ok(Some(Later::Evaluate(window, code))) => evaluate::run(&window, call, code),
        Ok(Some(Later::Crash(window, wc))) => page_watch::crash(&window, wc, call),
    }
}
fn dispatch(call: host::Call) {
    if call.method == "app.watchdog" {
        native_services::watchdog::handle(call, &runtime().user_data);
        return;
    }
    if call.method == "app.diagnosticLog" {
        native_services::diagnostic_logs::handle(call, &runtime().user_data);
        return;
    }
    if let Some(read) = FeedbackRead::parse(&call.method, &call.params) {
        tauri::async_runtime::spawn_blocking(move || {
            call.ok(read.read(&runtime().feedback_profile))
        });
        return;
    }
    let app = runtime().app.clone();
    if let Err(error) = app.run_on_main_thread(move || dispatch_ui(call)) {
        log::log("dispatch.failed", json!({"error":error.to_string()}));
    }
}
fn dispatch_ui(call: host::Call) {
    let Some(call) = network::dispatch(call) else {
        return;
    };
    let Some(call) = native_services::dispatch(call) else {
        return;
    };
    let Some(call) = native_chrome::dispatch(call) else {
        return;
    };
    let Some(call) = preview::dispatch(call) else {
        return;
    };
    let Some(call) = sessions::dispatch(call) else {
        return;
    };
    let closing = match call.method.as_str() {
        "win.op" if matches!(call.params["op"].as_str(), Some("close" | "destroy")) => {
            call.params["winId"].as_u64().and_then(|win| {
                runtime()
                    .registry
                    .lock()
                    .expect("registry")
                    .by_window(win)
                    .map(|page| page.identity.wc)
            })
        }
        "wc.op" if call.params["op"].as_str() == Some("close") => call.params["wcId"].as_u64(),
        _ => None,
    };
    if let Some(wc) = closing {
        destroy_app(wc, Some(call));
        return;
    }
    if call.method == "wc.op" {
        return wc_op(call);
    }
    let result = match call.method.as_str() {
        "app.init" => {
            gpu::init(&call.params);
            #[cfg(feature = "test-automation")]
            automation::remember_switches(&call.params);
            if let Err(error) = sessions::protocol::declare_schemes(&call.params) {
                call.err("invalid", error);
                return;
            }
            call.ok(json!({}));
            host::event("app.ready", json!({}));
            return;
        }
        "app.exit" => {
            let Some(code) = call.params["code"]
                .as_i64()
                .and_then(|n| i32::try_from(n).ok())
            else {
                call.err("invalid", "invalid exit code");
                return;
            };
            if lifecycle::EXITING.swap(true, Ordering::SeqCst) {
                call.err("exiting", "application exit already requested");
                return;
            }
            call.ok(json!({}));
            // The writer remains alive during node::stop, so Node receives this receipt before teardown.
            exit_after_preview(code);
            return;
        }
        "app.getGPUInfo" => Ok(gpu::info()),
        "win.create" => create_window(&call.params),
        "win.op" => win_op(&call.params),
        _ => Err(unsupported(&call.method)),
    };
    match result {
        Ok(value) => call.ok(value),
        Err(error) => call.err(&error.code, error.message),
    }
}
fn node_event(name: &str, data: Value, bin: Option<Vec<u8>>) {
    if sessions::protocol::event(name, &data, bin) {
        return;
    }
    match name {
        "net.cancel" => network::cancel(data),
        "app.relaunch" => {
            let args = if data["args"].is_null() {
                std::env::args().skip(1).collect()
            } else {
                match serde_json::from_value::<Vec<String>>(data["args"].clone()) {
                    Ok(args) => args,
                    Err(error) => {
                        log::log("relaunch.invalid", json!({"error":error.to_string()}));
                        return;
                    }
                }
            };
            log::log("relaunch.stored", json!({"args":args}));
            *runtime().relaunch.lock().expect("relaunch") = Some(args);
        }
        "wc.send" => {
            let Some(wc) = data["wcId"].as_u64() else {
                return;
            };
            let identity = runtime()
                .registry
                .lock()
                .expect("registry")
                .page(wc)
                .filter(|page| page.kind == registry::Kind::App)
                .map(|page| page.identity);
            let Some(identity) = identity else {
                return;
            };
            let message = json!({"channel":data["channel"],"args":data["args"]}).to_string();
            let app = runtime().app.clone();
            let _ = app.run_on_main_thread(move || {
                let deliver = {
                    let mut registry = runtime().registry.lock().expect("registry");
                    let Some(page) = registry
                        .page_mut(wc)
                        .filter(|page| page.identity == identity)
                    else {
                        return;
                    };
                    if page.ready {
                        true
                    } else {
                        if page.pushes.len() >= 4096 {
                            page.pushes.clear();
                            page.pushes.push_back(json!({"stream":"reset"}).to_string());
                        }
                        page.pushes.push_back(message.clone());
                        false
                    }
                };
                if deliver
                    && let Ok(window) = window_for_wc(wc)
                    && let Err(error) = window.eval(format!(
                        "window.__ompTauriPush({}, {message});",
                        identity.generation
                    ))
                {
                    log::log("push.failed", json!({"wcId":wc,"error":error.to_string()}));
                }
            });
        }
        _ => log::log("event.unsupported", json!({"name":name})),
    }
}
fn exit_after_preview(code: i32) {
    tauri::async_runtime::spawn(async move {
        let settled =
            preview::cleanup::settle(runtime().preview.shutdown(), runtime().gateway.shutdown())
                .await;
        let code = match settled {
            Ok(()) => code,
            Err(error) => {
                log::log("preview.shutdown.failed", json!({"error":error}));
                if code == 0 { 1 } else { code }
            }
        };
        log::log("exit", json!({"code":code}));
        runtime().app.exit(code);
    });
}
/// Node is gone: `via` says how the shell learned it (`exited`: its process ended, `closed`: its connection did).
fn node_gone(via: &str, code: Option<i32>) {
    sessions::protocol::disconnected();
    let quitting = lifecycle::EXITING.swap(true, Ordering::SeqCst);
    log::log(
        "node.gone",
        json!({"via":via,"code":code,"quitting":quitting}),
    );
    if !quitting {
        exit_after_preview(code.filter(|c| *c != 0).unwrap_or(1));
    }
}
async fn profile_ipc(
    webview: tauri::Webview,
    identity: Identity,
    kind: String,
    value: Value,
) -> Result<Value, Value> {
    let (send, receive) = tokio::sync::oneshot::channel();
    runtime().app.run_on_main_thread(move || {
        let result = (|| -> Result<Value, Value> {
            let original = runtime().registry.lock().expect("registry").current(identity);
            let native_url = webview.url().map_err(|error| json!({"code":"failed","message":error.to_string()}))?;
            if !original || !profile_bootstrap(native_url.as_str()) {
                return Err(json!({"code":"denied","message":"migration caller is not the original bootstrap document"}));
            }
            let mut migration = runtime().migration.lock().expect("migration");
            let target = migration.targets.get(&identity.wc).cloned()
                .ok_or_else(|| json!({"code":"gone","message":"migration app navigation ended"}))?;
            if kind == "profileRead" {
                if migration.profile.pending() {
                    let mut offer = migration.profile.offer().map_err(|message| json!({"code":"failed","message":message}))?;
                    let id = offer["id"].as_str().ok_or_else(|| json!({"code":"failed","message":"invalid native migration identity"}))?.to_owned();
                    let count = offer["items"].as_object().ok_or_else(|| json!({"code":"failed","message":"invalid native migration snapshot"}))?.len();
                    migration.offers.insert(identity.wc, (identity, id, count));
                    migration_step(&mut migration, identity.wc, migrate_watch::Step::Read, false);
                    offer["generation"] = json!(identity.generation);
                    return Ok(offer);
                }
                migration_step(&mut migration, identity.wc, migrate_watch::Step::Handover, false);
                drop(migration);
                webview.navigate(expect_navigation(identity.wc, &target).map_err(|message| json!({"code":"invalid","message":message}))?)
                    .map_err(|error| json!({"code":"failed","message":error.to_string()}))?;
                return Ok(json!({"complete":true,"generation":identity.generation}));
            }
            let id = value["id"].as_str().ok_or_else(|| json!({"code":"invalid","message":"missing migration identity"}))?;
            let count = value["verifiedKeys"].as_u64().and_then(|count| usize::try_from(count).ok())
                .ok_or_else(|| json!({"code":"invalid","message":"invalid verified migration count"}))?;
            if !migration.offers.get(&identity.wc).is_some_and(|(offered, offered_id, offered_count)| *offered == identity && offered_id == id && *offered_count == count) {
                return Err(json!({"code":"denied","message":"migration acknowledgment does not match its offered document"}));
            }
            if migration.profile.pending() {
                migration.profile.acknowledge(id, count).map_err(|message| json!({"code":"failed","message":message}))?;
            }
            migration_step(&mut migration, identity.wc, migrate_watch::Step::Handover, false);
            drop(migration);
            webview.navigate(expect_navigation(identity.wc, &target).map_err(|message| json!({"code":"invalid","message":message}))?)
                .map_err(|error| json!({"code":"failed","message":error.to_string()}))?;
            Ok(json!({"complete":true}))
        })();
        if let Err(error) = &result {
            log::log("profile.migrate.refused", json!({"wcId":identity.wc,"kind":kind,"error":error}));
        }
        let _ = send.send(result);
    }).map_err(|error| json!({"code":"failed","message":error.to_string()}))?;
    receive
        .await
        .map_err(|error| json!({"code":"failed","message":error.to_string()}))?
}

fn ensure_current(identity: Identity) -> Result<(), Value> {
    if runtime()
        .registry
        .lock()
        .expect("registry")
        .current(identity)
    {
        Ok(())
    } else {
        Err(json!({"code":"gone","message":"original document ended"}))
    }
}

#[tauri::command]
async fn omp_ipc(webview: tauri::Webview, kind: String, payload: String) -> Result<Value, Value> {
    let url = webview
        .url()
        .map_err(|e| json!({"code":"failed","message":e.to_string()}))?;
    if !trusted_url(url.as_str()) {
        return Err(json!({"code":"denied","message":"untrusted page"}));
    }
    let identity = runtime()
        .registry
        .lock()
        .expect("registry")
        .by_label(webview.label())
        .filter(|p| trusted_url(&p.url))
        .map(|p| p.identity)
        .ok_or_else(|| json!({"code":"denied","message":"unregistered native caller"}))?;
    let value: Value = serde_json::from_str(&payload)
        .map_err(|e| json!({"code":"invalid","message":e.to_string()}))?;
    if kind != "ready"
        && kind != "profileRead"
        && kind != "preloadError"
        && value["generation"].as_u64() != Some(identity.generation)
    {
        return Err(json!({"code":"gone","message":"original document ended"}));
    }
    if kind == "profileRead" || kind == "profileAck" {
        return profile_ipc(webview, identity, kind, value).await;
    }
    if kind != "preloadError"
        && (profile_bootstrap(url.as_str())
            || runtime()
                .migration
                .lock()
                .expect("migration")
                .profile
                .pending())
    {
        return Err(
            json!({"code":"denied","message":"profile migration has not released the app page"}),
        );
    }
    match kind.as_str() {
        "ready" => {
            let (send, receive) = tokio::sync::oneshot::channel();
            runtime()
                .app
                .run_on_main_thread(move || {
                    let result = (|| -> Result<Value, Value> {
                        let queued = {
                            let mut registry = runtime().registry.lock().expect("registry");
                            let Some(page) = registry
                                .page_mut(identity.wc)
                                .filter(|p| p.identity == identity)
                            else {
                                return Err(json!({"code":"gone","message":"document ended"}));
                            };
                            if page.ready {
                                return Ok(json!({"generation":identity.generation}));
                            }
                            page.ready = true;
                            std::mem::take(&mut page.pushes)
                        };
                        if let Some(ua) = value["userAgent"].as_str() {
                            *runtime().user_agent.lock().expect("user agent") = Some(ua.into());
                        }
                        for message in queued {
                            webview
                                .eval(format!(
                                    "window.__ompTauriPush({}, {message});",
                                    identity.generation
                                ))
                                .map_err(|e| json!({"code":"failed","message":e.to_string()}))?;
                        }
                        wc_state(identity.wc);
                        wc_event(identity.wc, "dom-ready", json!([]));
                        Ok(json!({"generation":identity.generation}))
                    })();
                    let _ = send.send(result);
                })
                .map_err(|e| json!({"code":"failed","message":e.to_string()}))?;
            receive
                .await
                .map_err(|e| json!({"code":"failed","message":e.to_string()}))?
        }
        "windowControl" => {
            let action = value["action"].as_str().unwrap_or_default().to_owned();
            let wc = identity.wc;
            runtime()
                .app
                .run_on_main_thread(move || {
                    let Ok(window) = window_for_wc(wc) else {
                        return;
                    };
                    let _ = match action.as_str() {
                        "minimize" => window.minimize(),
                        "maximize" => match window.is_maximized() {
                            Ok(true) => window.unmaximize(),
                            _ => window.maximize(),
                        },
                        "close" => window.close(),
                        _ => Ok(()),
                    };
                })
                .map_err(|e| json!({"code":"failed","message":e.to_string()}))?;
            Ok(json!({}))
        }
        "preloadError" => {
            if profile_bootstrap(url.as_str()) {
                // The page shows its error and Retry; its Retry starts a new round.
                if let Some((attempt, step)) = runtime()
                    .migration
                    .lock()
                    .expect("migration")
                    .watches
                    .end(identity.wc)
                {
                    log::log(
                        "profile.migrate.failed",
                        json!({"wcId":identity.wc,"step":step.name(),"attempt":attempt,"message":value["message"]}),
                    );
                }
                // Reveal the recovery page without settling Node's original app load promise.
                if let Some(win) = identity.win {
                    win_event(win, "ready-to-show");
                }
            }
            wc_event(identity.wc, "preload-error", json!(["tauri.js", value]));
            Ok(json!({}))
        }
        "invoke" | "send" => {
            let channel = value["channel"]
                .as_str()
                .ok_or_else(|| json!({"code":"invalid","message":"missing channel"}))?;
            if !value["args"].is_array() {
                return Err(json!({"code":"invalid","message":"args must be an array"}));
            }
            if kind == "invoke"
                && let Some(read) = FeedbackRead::parse(channel, &value["args"])
            {
                let result = tauri::async_runtime::spawn_blocking(move || {
                    read.read(&runtime().feedback_profile)
                })
                .await
                .map_err(|e| json!({"code":"failed","message":e.to_string()}))?;
                ensure_current(identity)?;
                return Ok(Value::from_iter([("value", result)]));
            }
            #[cfg(windows)]
            let args = {
                let mut args = value["args"].clone();
                if channel == "fs:media-release"
                    && let Some(mapped) = args[0].as_str()
                {
                    args[0] = json!(
                        preview::media::original(mapped)
                            .map_err(|error| json!({"code":error.code,"message":error.message}))?
                    );
                }
                args
            };
            #[cfg(not(windows))]
            let args = value["args"].clone();
            let params =
                json!({"wcId":identity.wc,"frameUrl":url.as_str(),"channel":channel,"args":args});
            if kind == "send" {
                host::event("ipc.send", params);
                return Ok(json!({}));
            }
            let started = std::time::Instant::now();
            let answer = tauri::async_runtime::spawn_blocking(move || {
                host::request_blocking("ipc.invoke", params, Duration::from_secs(180))
            })
            .await
            .map_err(|e| json!({"code":"failed","message":e.to_string()}))?;
            // A page call main never answered, or answered late, held what the page awaited behind it: name it.
            let ms = started.elapsed().as_millis() as u64;
            if ms >= 10_000 {
                let code = answer.as_ref().err().map(|e| e.code.clone());
                log::log(
                    "ipc.invoke.slow",
                    json!({"wcId":identity.wc,"channel":channel,"ms":ms,"code":code}),
                );
            }
            ensure_current(identity)?;
            let answer = answer.map_err(|e| json!({"code":e.code,"message":e.message}))?;
            #[cfg(windows)]
            let answer = {
                let mut answer = answer;
                if channel == "fs:media-stream" {
                    preview::media::map_stream_answer(&mut answer)
                        .map_err(|error| json!({"code":error.code,"message":error.message}))?;
                }
                answer
            };
            Ok(answer)
        }
        _ => Err(json!({"code":"invalid","message":"unknown native bridge operation"})),
    }
}

/// `startup::RELAUNCHED_BY_ENV` as this shell was started with, removed so Node and what it starts never inherit it.
#[allow(unsafe_code)]
fn take_relaunch_marker() -> Option<String> {
    let value = std::env::var(startup::RELAUNCHED_BY_ENV).ok();
    // SAFETY: called as run's first statements, before any other thread exists to read the environment.
    unsafe { std::env::remove_var(startup::RELAUNCHED_BY_ENV) };
    value
}
/// The log's first line: who started this shell and how (`startup::started_line`).
fn log_start(argv: &[String], relaunched_by: Option<&str>) {
    #[cfg(target_os = "macos")]
    let (parent_pid, parent) = {
        let ppid = std::os::unix::process::parent_id();
        let exe =
            shell_core::sys_mac::childproc::arguments(ppid).and_then(|a| a.into_iter().next());
        (Some(ppid), exe)
    };
    #[cfg(windows)]
    let (parent_pid, parent) = match shell_core::sys::childproc::parent_of(std::process::id()) {
        Some((ppid, exe)) => (Some(ppid), exe),
        None => (None, None),
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let (parent_pid, parent): (Option<u32>, Option<String>) =
        (Some(std::os::unix::process::parent_id()), None);
    let xpc_service = std::env::var("XPC_SERVICE_NAME").ok();
    let at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    log::log(
        "shell.started",
        startup::started_line(&startup::Started {
            pid: std::process::id(),
            parent_pid,
            parent: parent.as_deref(),
            relaunched_by,
            xpc_service: xpc_service.as_deref(),
            argv,
            at_ms,
        }),
    );
}
fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            log::log("shell.failed", json!({"error":error.to_string()}));
            eprintln!("[tauri-shell] {error}");
            std::process::exit(1);
        }
    }
}
fn run() -> Result<i32, Box<dyn std::error::Error>> {
    let argv: Vec<String> = std::env::args().collect();
    let relaunched_by = take_relaunch_marker();
    // WebView2's loader reads these for any app: a release host must not open DevTools or another profile on request.
    #[cfg(all(windows, not(feature = "test-automation")))]
    #[allow(unsafe_code)]
    for name in [
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "WEBVIEW2_USER_DATA_FOLDER",
    ] {
        // SAFETY: the first statement after argv; no other thread exists yet to read the environment.
        unsafe { std::env::remove_var(name) };
    }
    #[cfg(target_os = "macos")]
    if let Some(code) = shell_core::sys_mac::keychain::cli(&argv[1..]) {
        std::process::exit(code);
    }
    let exe = std::env::current_exe()?;
    let args: Vec<String> = argv.iter().skip(1).cloned().collect();
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    #[cfg(target_os = "macos")]
    if !objc2::available!(macos = 14.0) {
        return Err("OMPdesk requires macOS 14 or newer".into());
    }
    let app_data = if cfg!(windows) {
        PathBuf::from(std::env::var("APPDATA")?)
    } else {
        home.join("Library/Application Support")
    };
    let user_data = startup::resolve_user_data(
        &args,
        std::env::var(startup::USER_DATA_ENV).ok().as_deref(),
        startup::default_user_data(&app_data),
    );
    let feedback_profile = feedback_profile(&user_data, &args)?;
    std::fs::create_dir_all(&user_data)?;
    log::start_clock();
    log::open_file(&user_data.join("tauri-shell.jsonl"));
    log_start(&argv, relaunched_by.as_deref());
    #[cfg(windows)]
    let instance_name = startup::pipe_name(&user_data);
    #[cfg(not(windows))]
    let instance_name = startup::socket_path(&user_data).display().to_string();
    let mut instance = match conn::Listener::bind(&instance_name) {
        Ok(listener) => listener,
        Err(_) => {
            conn::hand_over(
                &instance_name,
                &argv,
                &std::env::current_dir()?.to_string_lossy(),
            )?;
            log::log("shell.handedOver", json!({"to":"the running shell"}));
            return Ok(0);
        }
    };
    let exe_dir = exe.parent().ok_or("executable has no parent")?;
    let packaged_resources = if cfg!(target_os = "macos") {
        exe_dir.join("../Resources")
    } else {
        exe_dir.join("resources")
    };
    let packaged = packaged_resources.join("app/out/main/index.js").is_file();
    let app_dir = if packaged {
        packaged_resources.join("app")
    } else {
        std::env::var_os("OMPDESK_APP_DIR")
            .map(PathBuf::from)
            .or_else(|| startup::find_app_dir(exe_dir, |p| p.is_file()))
            .ok_or("set OMPDESK_APP_DIR to the actual Node app directory")?
    };
    let resources = if packaged {
        packaged_resources
    } else {
        app_dir.join("resources")
    };
    let entry = node::entry_script(&app_dir);
    let build = entry
        .parent()
        .and_then(Path::parent)
        .ok_or("invalid Node entry")?;
    let renderer = build.join("renderer");
    let preload = std::fs::read_to_string(build.join("preload/tauri.js"))?;
    // `bun run dev` (scripts/dev.ts): the page comes from Vite's dev server, which main loads by this variable (window.ts).
    // Only a checkout's run honors it; a packaged app never trusts a page outside its own origin.
    let dev_renderer = match std::env::var("ELECTRON_RENDERER_URL") {
        Ok(url) if !packaged => Some(registry::dev_origin(&url).ok_or_else(|| {
            format!("ELECTRON_RENDERER_URL is not a loopback http origin: {url}")
        })?),
        _ => None,
    };
    if !entry.is_file() || (dev_renderer.is_none() && !renderer.join("index.html").is_file()) {
        return Err("actual Node main or React renderer is missing".into());
    }
    if let Some(origin) = &dev_renderer {
        registry::allow_dev_origin(origin);
    }
    let mut context = tauri::generate_context!();
    // Tauri refuses IPC from any http page but its dev URL (`is_local_url`), and this crate builds without
    // `custom-protocol`, so its `dev` cfg reads the dev URL.
    context.config_mut().build.dev_url = dev_renderer;
    let launch = facts::Launch {
        user_data: user_data.clone(),
        exe: exe.clone(),
        app_dir,
        renderer_root: renderer.clone(),
        packaged,
        resources: resources.clone(),
        argv: argv.clone(),
        lang: args
            .iter()
            .find_map(|s| s.strip_prefix("--lang=").map(str::to_owned)),
    };
    let mut facts = facts::collect(&launch, &mut log::log);
    // Do not advertise CEF/Chromium versions for WKWebView. The shim can diagnose the actual engine.
    facts["versions"] = json!({"shell":env!("CARGO_PKG_VERSION"),"tauri":tauri::VERSION,"webview":tauri::webview_version()?});
    let mut token_bytes = [0u8; 32];
    getrandom::fill(&mut token_bytes).map_err(|e| format!("OS entropy: {e}"))?;
    let token: String = token_bytes.iter().map(|b| format!("{b:02x}")).collect();
    #[cfg(windows)]
    let socket = format!("{instance_name}-host-{}", std::process::id());
    #[cfg(not(windows))]
    let socket = startup::host_socket_path(&user_data, std::process::id())
        .display()
        .to_string();
    let listener = conn::Listener::bind(&socket)?;
    let program = node::node_program(packaged, &resources);
    let profile = profile::Profile::open(&user_data).map_err(std::io::Error::other)?;
    let gateway = Arc::new(preview_protocol::Gateway::new());
    let media_origin = tauri::async_runtime::block_on(gateway.reserve_app_media("app"))
        .map_err(std::io::Error::other)?;
    let content_policy =
        assets::content_policy(Some(&media_origin)).map_err(std::io::Error::other)?;
    let builder = tauri::Builder::default();
    // WebKit reports a page's content process ending here; Node reloads the page (page_watch).
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(page_watch::content_process_ended);
    // macOS: IPC calls go through `window.ipc.postMessage`, not Tauri's stock `fetch` to ipc://localhost. WebKit logs
    // every resource load a page starts over one stream to this process, and a page whose main thread waited on that
    // stream froze for hours (19 Nov 2026); a script message is no resource load. OMPDESK_TAURI_IPC_FETCH=1 keeps the
    // stock transport, for comparison.
    #[cfg(target_os = "macos")]
    let builder = if std::env::var("OMPDESK_TAURI_IPC_FETCH").as_deref() == Ok("1") {
        builder
    } else {
        builder.invoke_system(include_str!("ipc_post_message.js"))
    };
    #[cfg(feature = "test-automation")]
    let builder = automation::install(builder, &user_data).map_err(std::io::Error::other)?;
    #[cfg(windows)]
    let builder = preview::media::configure(builder);
    let app = builder
        .invoke_handler(tauri::generate_handler![omp_ipc])
        .register_asynchronous_uri_scheme_protocol("app", |context, request, responder| {
            let label = context.webview_label().to_owned();
            std::thread::spawn(move || {
                if !assets::is_bootstrap(request.uri()) {
                    return responder.respond(assets::serve(&runtime().renderer, request, &runtime().content_policy));
                }
                #[cfg(feature = "test-automation")]
                if stall_bootstrap_request() {
                    // The request stays unanswered, as the Windows runs saw it.
                    std::mem::forget(responder);
                    return;
                }
                responder.respond(assets::serve(&runtime().renderer, request, &runtime().content_policy));
                let wc = runtime().registry.lock().expect("registry").by_label(&label).map(|page| page.identity.wc);
                if let Some(wc) = wc {
                    migration_step(&mut runtime().migration.lock().expect("migration"), wc, migrate_watch::Step::Served, false);
                }
            });
        })
        .setup(move |app| {
            #[cfg(all(target_os = "macos", feature = "test-automation"))]
            automation::probe_edit_menu(app.handle().clone(), &user_data);
            RUNTIME
                .set(Runtime {
                    app: app.handle().clone(),
                    gateway,
                    content_policy,
                    preview: preview::Service::new(resources.clone(),packaged,user_data.join("preview-browser")),
                    registry: Mutex::new(Registry::default()),
                    migration: Mutex::new(Migration {
                        profile,
                        targets: HashMap::new(),
                        offers: HashMap::new(),
                        watches: migrate_watch::Watches::default(),
                        failures: HashMap::new(),
                    }),
                    app_initializations: Mutex::new(HashMap::new()),
                    navigation_watch: Mutex::new(HashSet::new()),
                    host_navigations: Mutex::new(HashMap::new()),
                    preload,
                    user_data,
                    feedback_profile,
                    renderer,
                    user_agent: Mutex::new(None),
                    relaunch: Mutex::new(None),
                    stop_instance: AtomicBool::new(false),
                    instance_thread: Mutex::new(None),
                })
                .map_err(|_| "runtime already initialized")?;
            system::init();
            sessions::init(runtime().user_data.clone()).map_err(std::io::Error::other)?;
            // `net.*` reads the same canonical partitions: their cookies (on a worker, never this UI thread) and policy.
            network::session::install_cookie_authority(std::sync::Arc::new(
                sessions::cookies::Authority::new(std::thread::current().id()),
            ))
            .map_err(std::io::Error::other)?;
            network::session::install_policy_source(sessions::network_policy)
                .map_err(std::io::Error::other)?;
            if std::env::var("OMP_GUI_TEST_SHELL_FAIL_START").as_deref() == Ok("1") {
                let test_profile = std::env::var_os(startup::USER_DATA_ENV)
                    .filter(|value| !value.is_empty())
                    .ok_or("startup failure injection requires an explicit test profile")?;
                let selected = runtime().user_data.canonicalize()?;
                let test_profile = PathBuf::from(test_profile).canonicalize()?;
                let default_profile = startup::default_user_data(&app_data);
                if test_profile != selected
                    || default_profile.canonicalize().ok().as_ref() == Some(&selected)
                {
                    return Err("startup failure injection requires the selected isolated test profile".into());
                }
                log::log(
                    "start.failed_on_purpose",
                    json!({"env":"OMP_GUI_TEST_SHELL_FAIL_START","phase":"native-initialized-before-node"}),
                );
                return Err("OMP_GUI_TEST_SHELL_FAIL_START: native-initialized-before-node".into());
            }
            let consumer=sessions::protocol::install_gateway_consumer().map_err(std::io::Error::other)?;
            tauri::async_runtime::block_on(runtime().gateway.activate(consumer)).map_err(std::io::Error::other)?;
            let instance_thread = std::thread::spawn(move || {
                while let Ok(mut connection) = instance.accept() {
                    if runtime().stop_instance.load(Ordering::SeqCst) {
                        break;
                    }
                    if let Ok((argv, _cwd)) = conn::take_hand_over(&mut connection) {
                        host::event("app.secondInstance", startup::second_instance(&argv));
                    }
                }
            });
            *runtime().instance_thread.lock().expect("instance thread") = Some(instance_thread);
            page_watch::run();
            host::serve(
                listener,
                token.clone(),
                facts,
                host::Handlers {
                    request: dispatch,
                    event: node_event,
                    closed: || node_gone("closed", None),
                },
            );
            node::spawn(&program, &entry, &args, &socket, &token)?;
            node::watch(|code| node_gone("exited", code));
            Ok(())
        })
        .build(context)?;
    let code = app.run_return(|_, event| match event {
        // `code`: None when the system or the last window asked (the Dock's Quit, ⌘Q handled by macOS, a logout),
        // Some when this shell's own `exit` did.
        RunEvent::ExitRequested { code, api, .. } => {
            let forward = !lifecycle::EXITING.load(Ordering::SeqCst);
            log::log(
                "exit.requested",
                json!({"code":code,"forwardedToNode":forward}),
            );
            if forward {
                api.prevent_exit();
                host::event("app.quitRequested", json!({}));
            }
        }
        RunEvent::Exit => node::stop(Duration::from_secs(5)),
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            for url in urls {
                host::event("app.openUrl", json!({"url":url.as_str()}));
            }
        }
        _ => {}
    });
    runtime().stop_instance.store(true, Ordering::SeqCst);
    drop(conn::connect(&instance_name)?);
    if let Some(thread) = runtime()
        .instance_thread
        .lock()
        .expect("instance thread")
        .take()
    {
        thread.join().map_err(|_| "instance listener panicked")?;
    }
    if let Some(args) = runtime().relaunch.lock().expect("relaunch").take() {
        match std::process::Command::new(exe)
            .args(&args)
            .env(startup::RELAUNCHED_BY_ENV, std::process::id().to_string())
            .spawn()
        {
            Ok(child) => log::log("relaunch.spawned", json!({"pid":child.id()})),
            Err(error) => {
                log::log("relaunch.failed", json!({"error":error.to_string()}));
                return Err(error.into());
            }
        }
    }
    log::log("shell.ended", json!({"code":code}));
    Ok(code)
}

fn defer_app_load(call: host::Call) -> Option<host::Call> {
    if call.params["op"].as_str() != Some("loadURL") {
        return Some(call);
    }
    let Some(wc) = call.params["wcId"].as_u64() else {
        return Some(call);
    };
    let ready = runtime()
        .app_initializations
        .lock()
        .expect("app initialization")
        .get(&wc)
        .cloned();
    let Some(mut ready) = ready else {
        call.err("gone", "app WebView initialization ended");
        return None;
    };
    let initialized = ready.borrow().clone();
    match initialized.as_ref() {
        Some(Ok(())) => return Some(call),
        Some(Err(error)) => {
            call.err("preload", error.clone());
            return None;
        }
        None => {}
    }
    let identity = runtime()
        .registry
        .lock()
        .expect("registry")
        .page(wc)
        .map(|page| page.identity);
    let Some(identity) = identity else {
        call.err("gone", "app WebView ended");
        return None;
    };
    let id = call.id();
    let (cancel, mut cancelled) = tokio::sync::oneshot::channel();
    host::on_cancel(id, move || {
        let _ = cancel.send(());
    });
    tauri::async_runtime::spawn(async move {
        let result = loop {
            let current = ready.borrow_and_update().clone();
            if let Some(result) = current {
                break result;
            }
            tokio::select! {
                _=&mut cancelled=>{
                    host::forget_cancel(id);call.err("cancelled","app navigation cancelled before native attachment");return;
                }
                changed=ready.changed()=>{
                    if changed.is_err(){host::forget_cancel(id);call.err("gone","app initialization ended");return;}
                }
            }
        };
        if let Err(error) = result {
            host::forget_cancel(id);
            call.err("preload", error);
            return;
        }
        if let Err(error) = runtime().app.run_on_main_thread(move || {
            let cancelled = cancelled.try_recv().is_ok();
            host::forget_cancel(id);
            if cancelled {
                call.err("cancelled", "app navigation cancelled before admission");
                return;
            }
            if !runtime()
                .registry
                .lock()
                .expect("registry")
                .current(identity)
            {
                call.err("gone", "original app WebView ended");
                return;
            }
            wc_op(call);
        }) {
            host::forget_cancel(id);
            log::log(
                "app.attach.dispatch_failed",
                json!({"error":error.to_string()}),
            );
        }
    });
    None
}

fn detach_app_window(window: &WebviewWindow) -> Result<(), WireError> {
    let webview = runtime()
        .app
        .get_webview(window.label())
        .ok_or_else(|| WireError::new("gone", "native app WebView ended"))?;
    sessions::detach_app(&webview).map_err(failed)
}

fn destroy_app(wc: u64, call: Option<host::Call>) {
    let selected = (|| {
        let mut registry = runtime().registry.lock().expect("registry");
        let page = registry
            .page(wc)
            .filter(|page| page.kind == registry::Kind::App)
            .ok_or_else(|| WireError::new("gone", "native app window ended"))?;
        if page.state == registry::PageState::Closing {
            return Err(WireError::new(
                "closing",
                "native app window is already closing",
            ));
        }
        let win = page
            .identity
            .win
            .ok_or_else(|| WireError::new("gone", "native app window has no owner"))?;
        registry
            .begin_close(wc)
            .ok_or_else(|| WireError::new("gone", "native app window ended"))?;
        Ok(win)
    })();
    let win = match selected {
        Ok(win) => win,
        Err(error) => {
            if let Some(call) = call {
                call.err(&error.code, error.message);
            }
            return;
        }
    };
    tauri::async_runtime::spawn(async move {
        let result = async {
            runtime().preview.close_parent(win).await?;
            let (send, receive) = tokio::sync::oneshot::channel();
            runtime()
                .app
                .run_on_main_thread(move || {
                    let result = (|| {
                        let window = window_for_wc(wc)?;
                        detach_app_window(&window)?;
                        window.destroy().map_err(failed)
                    })();
                    let _ = send.send(result);
                })
                .map_err(failed)?;
            receive.await.map_err(failed)?
        }
        .await;
        match (result, call) {
            (Ok(()), Some(call)) => call.ok(json!({})),
            (Err(error), Some(call)) => call.err(&error.code, error.message),
            (Err(error), None) => wc_event(
                wc,
                "preload-error",
                json!(["native close",{"message":error.message}]),
            ),
            (Ok(()), None) => {}
        }
    });
}
