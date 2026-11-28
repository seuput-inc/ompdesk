//! Window-scoped page calls. The key is handed to this window's top-frame preload only, not to
//! `ready` callers (Tauri's Webview command argument identifies a WebView, not its calling frame).
use crate::chrome_document::{Document, permits};
use crate::{failed, registry, registry::Identity, runtime, window_for_wc};
use serde_json::{Value, json};
use shell_core::wire::WireError;

pub(super) async fn run(
    id: Identity,
    webview: tauri::Webview,
    value: Value,
) -> Result<Value, Value> {
    let (send, receive) = tokio::sync::oneshot::channel();
    webview.clone().with_webview(move |_platform| {
        let result = (|| -> Result<Value, WireError> {
            let url = webview.url().map_err(failed)?;
            {
                let registry = runtime().registry.lock().expect("registry");
                // Look up the live app by native label, never by a page-supplied target or URL.
                let owner = registry.by_label(webview.label()).filter(|page| page.identity == id).map(|page| Document {
                    generation: page.identity.generation, label: &page.label, key: page.chrome_key.as_deref(), url: &page.url,
                });
                let caller = Document { label: webview.label(), generation: id.generation, url: url.as_str(), key: value["key"].as_str() };
                if !permits(owner, caller, registry::dev_server_origin()) {
                    return Err(WireError::new("denied", "window control needs the calling app document"));
                }
            }
            let window = window_for_wc(id.wc)?;
            #[cfg(windows)]
            let zoom = || crate::windows_chrome::page_zoom(&_platform).map_err(failed);
            match value["action"].as_str() {
                Some("state") => return Ok(json!({"maximized":window.is_maximized().map_err(failed)?,"fullscreen":window.is_fullscreen().map_err(failed)?})),
                Some("minimize") => window.minimize(),
                Some("maximize") => if window.is_maximized().map_err(failed)? { window.unmaximize() } else { window.maximize() },
                Some("close") => window.close(),
                #[cfg(target_os = "macos")]
                Some("drag" | "doubleClick") => {
                    let coord = |k: &str| value[k].as_f64().ok_or_else(|| WireError::new("invalid", "missing pointer coordinate"));
                    crate::mac_drag::act(&_platform, value["action"] == "drag", coord("x")?, coord("y")?).map_err(failed)?;
                    return Ok(Value::Null);
                }
                #[cfg(windows)]
                Some("regions") => {
                    crate::windows_chrome::layout(window.hwnd().map_err(failed)?.0, id, &value, zoom()?).map_err(|e| WireError::new("invalid", e))?;
                    return Ok(Value::Null);
                }
                #[cfg(windows)]
                Some("menu") => {
                    let zoom = zoom()?;
                    let coord = |k: &str| value[k].as_f64().filter(|n| (0.0..=65535.0).contains(n)).map(|n| n * zoom).ok_or_else(|| WireError::new("invalid", "invalid menu anchor"));
                    crate::app_menu::popup(id, &window, (coord("x")?, coord("y")?))?;
                    return Ok(Value::Null);
                }
                _ => return Err(WireError::new("unsupported", "unknown window control")),
            }.map_err(failed)?;
            Ok(Value::Null)
        })();
        let _ = send.send(result.map_err(|e| json!({"code":e.code,"message":e.message})));
    }).map_err(|e| json!({"code":"failed","message":e.to_string()}))?;
    receive
        .await
        .map_err(|e| json!({"code":"gone","message":e.to_string()}))?
}
