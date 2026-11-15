#![windows_subsystem = "windows"]

mod assets;
mod registry;
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
use sha2::{Digest, Sha256};
use shell_core::wire::WireError;
use shell_core::{conn, facts, startup};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

struct Evaluation {
    identity: Identity,
    call: host::Call,
}
struct Runtime {
    app: tauri::AppHandle,
    registry: Mutex<Registry>,
    evaluations: Mutex<HashMap<u64, Evaluation>>,
    next_evaluation: AtomicU64,
    preload: String,
    user_data: PathBuf,
    renderer: PathBuf,
    user_agent: Mutex<Option<String>>,
    relaunch: Mutex<Option<Vec<String>>>,
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
fn wc_state(wc: u64) {
    let r = runtime();
    let registry = r.registry.lock().expect("registry");
    if let Some(page) = registry.page(wc) {
        let mut state = json!({"wcId":wc,"url":page.url,"title":page.title,
            "loading":page.loading,"zoomFactor":page.zoom});
        if let Some(agent) = r.user_agent.lock().expect("user agent").as_deref() {
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
        "visible":window.is_visible().map_err(failed)?,"focused":window.is_focused().map_err(failed)?,
        "minimized":minimized,"maximized":maximized,
        "fullscreen":fullscreen,"title":window.title().map_err(failed)?,"opacity":1.0});
    if !maximized && !minimized && !fullscreen {
        state["normalBounds"] = bounds;
    }
    host::event("win.state", state.clone());
    Ok(state)
}
fn invalidate_evaluations(wc: u64) {
    let removed: Vec<_> = {
        let mut pending = runtime().evaluations.lock().expect("evaluations");
        let ids: Vec<_> = pending
            .iter()
            .filter(|(_, e)| e.identity.wc == wc)
            .map(|(id, _)| *id)
            .collect();
        ids.into_iter()
            .filter_map(|id| pending.remove(&id))
            .collect()
    };
    for evaluation in removed {
        host::forget_cancel(evaluation.call.id());
        evaluation.call.err("gone", "original document ended");
    }
}
fn page_load(wc: u64, url: &str, event: PageLoadEvent) {
    if url == "about:blank" {
        return;
    }
    if event == PageLoadEvent::Started {
        invalidate_evaluations(wc);
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
        win_event(win, "ready-to-show");
    }
}
fn close_record(wc: u64) {
    invalidate_evaluations(wc);
    let page = runtime().registry.lock().expect("registry").remove(wc);
    if let Some(page) = page {
        host::event(
            "win.state",
            json!({"winId":page.identity.win,"visible":false,"focused":false}),
        );
        wc_event(wc, "destroyed", json!([]));
        win_event(page.identity.win, "closed");
    }
}
fn create_window(params: &Value) -> Result<Value, WireError> {
    let win = number(params, "winId")?;
    let wc = number(params, "wcId")?;
    let options = &params["options"];
    if options
        .pointer("/webPreferences/offscreen")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Err(unsupported(
            "offscreen windows require the separately owned Preview runtime",
        ));
    }
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
    let profile: [u8; 16] = Sha256::digest(runtime().user_data.to_string_lossy().as_bytes())[..16]
        .try_into()
        .expect("digest size");
    let mut builder = WebviewWindowBuilder::new(
        &runtime().app,
        &label,
        WebviewUrl::External("about:blank".parse().map_err(failed)?),
    )
    .title(options["title"].as_str().unwrap_or("OMPdesk"))
    .inner_size(
        options["width"].as_f64().unwrap_or(1200.0),
        options["height"].as_f64().unwrap_or(800.0),
    )
    .visible(options["show"].as_bool().unwrap_or(true))
    .data_directory(runtime().user_data.join("tauri-webview"))
    .data_store_identifier(profile)
    .initialization_script(&runtime().preload)
    .on_navigation(move |url| {
        let allowed = trusted_url(url.as_str()) || url.as_str() == "about:blank";
        if !allowed {
            log::log("navigation.denied", json!({"wcId":wc,"url":url.as_str()}));
        }
        allowed
    })
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_page_load(move |_, payload| page_load(wc, payload.url().as_str(), payload.event()))
    .on_document_title_changed(move |_, title| {
        if let Some(page) = runtime().registry.lock().expect("registry").page_mut(wc) {
            page.title = title.clone();
        }
        wc_state(wc);
        wc_event(wc, "page-title-updated", json!([title, true]));
    });
    if let (Some(x), Some(y)) = (options["x"].as_f64(), options["y"].as_f64()) {
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
    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            runtime().registry.lock().expect("registry").remove(wc);
            return Err(failed(error));
        }
    };
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
                            let _ = w.destroy();
                        }
                    });
                }
            });
        }
        WindowEvent::Destroyed => close_record(wc),
        WindowEvent::Focused(focus) => {
            let _ = win_state(&observer, win);
            win_event(win, if *focus { "focus" } else { "blur" });
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
    let drops = window.clone();
    window.on_webview_event(move |event| {
        if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Enter { paths, .. }) = event {
            let files: Vec<_> = paths
                .iter()
                .filter_map(|path| {
                    path.file_name().map(
                        |name| json!({"name":name.to_string_lossy(),"path":path.to_string_lossy()}),
                    )
                })
                .collect();
            if let Err(error) = drops.eval(format!("window.__ompTauriDropFiles({});", json!(files)))
            {
                log::log("drop.failed", json!({"error":error.to_string()}));
            }
        }
    });
    wc_state(wc);
    Ok(json!({"state":win_state(&window,win)?}))
}
fn win_op(params: &Value) -> Result<Value, WireError> {
    let win = number(params, "winId")?;
    let wc = runtime()
        .registry
        .lock()
        .expect("registry")
        .by_window(win)
        .map(|p| p.identity.wc)
        .ok_or_else(|| WireError::new("gone", "unknown window"))?;
    let window = window_for_wc(wc)?;
    let op = string(params, "op")?;
    let a = &params["args"];
    match op {
        "show" => window.show(),
        "hide" => window.hide(),
        "focus" => window.set_focus(),
        "minimize" => window.minimize(),
        "maximize" => window.maximize(),
        "unmaximize" => window.unmaximize(),
        "restore" => window.unminimize(),
        "close" | "destroy" => window.destroy(),
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
        "setSize" | "setContentSize" => window.set_size(tauri::LogicalSize::new(
            dimension(a, "width")?,
            dimension(a, "height")?,
        )),
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
            window.set_size(tauri::LogicalSize::new(
                dimension(b, "width")?,
                dimension(b, "height")?,
            ))
        }
        _ => return Err(unsupported(&format!("win.op {op}"))),
    }
    .map_err(failed)?;
    if !matches!(op, "close" | "destroy") {
        win_state(&window, win)?;
        if matches!(
            op,
            "show" | "hide" | "minimize" | "maximize" | "unmaximize" | "restore"
        ) {
            win_event(win, op);
        }
    }
    Ok(json!({}))
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
fn wc_op(call: host::Call) {
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
                let url = url.replacen("app://ompdesk", "http://app.ompdesk", 1);
                window
                    .navigate(url.parse().map_err(failed)?)
                    .map_err(failed)?;
            }
            "reload" | "reloadIgnoringCache" => {
                if op == "reloadIgnoringCache" {
                    return Err(unsupported(op));
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
            "close" => window.destroy().map_err(failed)?,
            "openDevTools" => window.open_devtools(),
            "closeDevTools" => window.close_devtools(),
            "watchEvents" => {
                return Err(unsupported("optional webContents event watches"));
            }
            "executeJavaScript" => return Ok(Some((wc, window, string(a, "code")?.to_owned()))),
            _ => return Err(unsupported(&format!("wc.op {op}"))),
        }
        Ok(None)
    })();
    match result {
        Err(error) => call.err(&error.code, error.message),
        Ok(None) => call.ok(json!({})),
        Ok(Some((wc, window, code))) => {
            let identity = runtime()
                .registry
                .lock()
                .expect("registry")
                .page(wc)
                .map(|p| p.identity);
            let Some(identity) = identity else {
                call.err("gone", "page closed");
                return;
            };
            let id = runtime().next_evaluation.fetch_add(1, Ordering::Relaxed);
            let script = format!(
                "window.__ompTauriEvaluate({id},()=>{{return (0,eval)({});}});",
                json!(code)
            );
            let request_id = call.id();
            runtime()
                .evaluations
                .lock()
                .expect("evaluations")
                .insert(id, Evaluation { identity, call });
            host::on_cancel(request_id, move || {
                runtime()
                    .evaluations
                    .lock()
                    .expect("evaluations")
                    .remove(&id);
            });
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(180)).await;
                if let Some(e) = runtime()
                    .evaluations
                    .lock()
                    .expect("evaluations")
                    .remove(&id)
                {
                    host::forget_cancel(e.call.id());
                    e.call
                        .err("timeout", "JavaScript evaluation exceeded 180 seconds");
                }
            });
            if let Err(error) = window.eval(script) {
                if let Some(e) = runtime()
                    .evaluations
                    .lock()
                    .expect("evaluations")
                    .remove(&id)
                {
                    host::forget_cancel(e.call.id());
                    e.call.err("failed", error.to_string());
                }
            }
        }
    }
}
fn dispatch(call: host::Call) {
    let app = runtime().app.clone();
    if let Err(error) = app.run_on_main_thread(move || dispatch_ui(call)) {
        log::log("dispatch.failed", json!({"error":error.to_string()}));
    }
}
fn dispatch_ui(call: host::Call) {
    if call.method == "wc.op" {
        return wc_op(call);
    }
    let result = match call.method.as_str() {
        "app.init" => {
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
            lifecycle::EXITING.store(true, Ordering::SeqCst);
            call.ok(json!({}));
            // The writer remains alive during node::stop, so Node receives this receipt before teardown.
            runtime().app.exit(code);
            return;
        }
        "win.create" => create_window(&call.params),
        "win.op" => win_op(&call.params),
        _ => Err(unsupported(&call.method)),
    };
    match result {
        Ok(value) => call.ok(value),
        Err(error) => call.err(&error.code, error.message),
    }
}
fn node_event(name: &str, data: Value, _bin: Option<Vec<u8>>) {
    match name {
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
            *runtime().relaunch.lock().expect("relaunch") = Some(args);
        }
        "wc.send" => {
            let Some(wc) = data["wcId"].as_u64() else {
                return;
            };
            let message = json!({"channel":data["channel"],"args":data["args"]}).to_string();
            let app = runtime().app.clone();
            let _ = app.run_on_main_thread(move || {
                let deliver = {
                    let mut registry = runtime().registry.lock().expect("registry");
                    let Some(page) = registry.page_mut(wc) else {
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
                if deliver {
                    if let Ok(window) = window_for_wc(wc) {
                        if let Err(error) =
                            window.eval(format!("window.__ompTauriPush({message});"))
                        {
                            log::log("push.failed", json!({"wcId":wc,"error":error.to_string()}));
                        }
                    }
                }
            });
        }
        _ => log::log("event.unsupported", json!({"name":name})),
    }
}
fn node_gone(code: Option<i32>) {
    if !lifecycle::EXITING.load(Ordering::SeqCst) {
        runtime().app.exit(code.filter(|c| *c != 0).unwrap_or(1));
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
        && kind != "preloadError"
        && value["generation"].as_u64() != Some(identity.generation)
    {
        return Err(json!({"code":"gone","message":"original document ended"}));
    }
    match kind.as_str() {
        "ready" => {
            let queued = {
                let mut registry = runtime().registry.lock().expect("registry");
                let Some(page) = registry
                    .page_mut(identity.wc)
                    .filter(|p| p.identity == identity)
                else {
                    return Err(json!({"code":"gone","message":"document ended"}));
                };
                page.ready = true;
                std::mem::take(&mut page.pushes)
            };
            if let Some(ua) = value["userAgent"].as_str() {
                *runtime().user_agent.lock().expect("user agent") = Some(ua.into());
            }
            for message in queued {
                webview
                    .eval(format!("window.__ompTauriPush({message});"))
                    .map_err(|e| json!({"code":"failed","message":e.to_string()}))?;
            }
            wc_state(identity.wc);
            wc_event(identity.wc, "dom-ready", json!([]));
            Ok(json!({"generation":identity.generation}))
        }
        "preloadError" => {
            wc_event(identity.wc, "preload-error", json!(["tauri.js", value]));
            Ok(json!({}))
        }
        "evaluateResult" => {
            let id = value["id"]
                .as_u64()
                .ok_or_else(|| json!({"code":"invalid","message":"missing evaluation ID"}))?;
            let mut pending = runtime().evaluations.lock().expect("evaluations");
            if pending.get(&id).is_some_and(|e| e.identity == identity) {
                let evaluation = pending.remove(&id).expect("checked evaluation");
                host::forget_cancel(evaluation.call.id());
                if value["ok"] == true {
                    evaluation.call.ok(json!({"result":value["value"]}));
                } else {
                    evaluation.call.err(
                        "failed",
                        value["error"]["message"]
                            .as_str()
                            .unwrap_or("evaluation failed"),
                    );
                }
            }
            Ok(json!({}))
        }
        "invoke" | "send" => {
            let channel = value["channel"]
                .as_str()
                .ok_or_else(|| json!({"code":"invalid","message":"missing channel"}))?;
            if !value["args"].is_array() {
                return Err(json!({"code":"invalid","message":"args must be an array"}));
            }
            let params = json!({"wcId":identity.wc,"frameUrl":url.as_str(),"channel":channel,"args":value["args"]});
            if kind == "send" {
                host::event("ipc.send", params);
                return Ok(json!({}));
            }
            let answer = tauri::async_runtime::spawn_blocking(move || {
                host::request_blocking("ipc.invoke", params, Duration::from_secs(180))
            })
            .await
            .map_err(|e| json!({"code":"failed","message":e.to_string()}))?;
            if !runtime()
                .registry
                .lock()
                .expect("registry")
                .current(identity)
            {
                return Err(json!({"code":"gone","message":"original document ended"}));
            }
            answer.map_err(|e| json!({"code":e.code,"message":e.message}))
        }
        _ => Err(json!({"code":"invalid","message":"unknown native bridge operation"})),
    }
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("[tauri-shell] {error}");
            std::process::exit(1);
        }
    }
}
fn run() -> Result<i32, Box<dyn std::error::Error>> {
    let argv: Vec<String> = std::env::args().collect();
    #[cfg(target_os = "macos")]
    if let Some(code) = shell_core::sys_mac::keychain::cli(&argv[1..]) {
        std::process::exit(code);
    }
    let exe = std::env::current_exe()?;
    let args: Vec<String> = argv.iter().skip(1).cloned().collect();
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
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
    std::fs::create_dir_all(&user_data)?;
    log::start_clock();
    log::open_file(&user_data.join("tauri-shell.jsonl"));
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
    if !entry.is_file() || !renderer.join("index.html").is_file() {
        return Err("actual Node main or React renderer is missing".into());
    }
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
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![omp_ipc])
        .register_asynchronous_uri_scheme_protocol("app", |context, request, responder| {
            let _app = context.app_handle();
            std::thread::spawn(move || {
                responder.respond(assets::serve(&runtime().renderer, request))
            });
        })
        .setup(move |app| {
            RUNTIME
                .set(Runtime {
                    app: app.handle().clone(),
                    registry: Mutex::new(Registry::default()),
                    evaluations: Mutex::new(HashMap::new()),
                    next_evaluation: AtomicU64::new(1),
                    preload,
                    user_data,
                    renderer,
                    user_agent: Mutex::new(None),
                    relaunch: Mutex::new(None),
                })
                .map_err(|_| "runtime already initialized")?;
            std::thread::spawn(move || {
                while let Ok(mut connection) = instance.accept() {
                    if let Ok((argv, cwd)) = conn::take_hand_over(&mut connection) {
                        host::event("app.secondInstance", json!({"argv":argv,"cwd":cwd}));
                    }
                }
            });
            host::serve(
                listener,
                token.clone(),
                facts,
                host::Handlers {
                    request: dispatch,
                    event: node_event,
                    closed: || node_gone(None),
                },
            );
            node::spawn(&program, &entry, &args, &socket, &token)?;
            node::watch(node_gone);
            Ok(())
        })
        .build(tauri::generate_context!())?;
    let code = app.run_return(|_, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            if !lifecycle::EXITING.load(Ordering::SeqCst) {
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
    if let Some(args) = runtime().relaunch.lock().expect("relaunch").take() {
        std::process::Command::new(exe).args(args).spawn()?;
    }
    Ok(code)
}
