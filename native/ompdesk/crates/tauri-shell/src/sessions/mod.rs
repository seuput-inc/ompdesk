mod cookie_spec;
pub mod cookies;
#[cfg(target_os = "macos")]
mod cookies_macos;
#[cfg(windows)]
mod cookies_windows;
#[cfg(target_os = "macos")]
mod macos;
mod native;
mod policy;
pub mod preview;
pub mod protocol;
#[cfg(target_os = "macos")]
mod protocol_macos;
#[cfg(windows)]
mod windows;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::webview::{DownloadEvent, PermissionResponse};
use tauri::{Manager, Webview, WebviewWindowBuilder, Wry};
use tokio::sync::oneshot;

use crate::host::{self, Call};
pub use policy::canonical;
use policy::{Command, Policy, Registry, Storage};

static SESSIONS: OnceLock<Mutex<Registry>> = OnceLock::new();

fn registry() -> Result<&'static Mutex<Registry>, String> {
    SESSIONS
        .get()
        .ok_or_else(|| "session runtime is not initialized".into())
}

pub fn init(user_data: PathBuf) -> Result<(), String> {
    SESSIONS
        .set(Mutex::new(Registry {
            user_data,
            partitions: HashMap::new(),
        }))
        .map_err(|_| "session runtime already initialized".to_string())
}

fn with<R>(f: impl FnOnce(&mut Registry) -> Result<R, String>) -> Result<R, String> {
    f(&mut registry()?
        .lock()
        .map_err(|_| "session registry poisoned")?)
}

pub fn policy(partition: &str) -> Result<Policy, String> {
    with(|r| Ok(r.get(partition)?.policy.clone()))
}

pub struct NetworkPolicy {
    pub user_agent: Option<String>,
    pub accept_languages: Option<String>,
    pub deny_network: bool,
}

pub fn network_policy(partition: &str) -> Result<NetworkPolicy, String> {
    with(|r| {
        let policy = &r.get(partition)?.policy;
        Ok(NetworkPolicy {
            deny_network: policy.deny_network(),
            user_agent: policy.user_agent.clone(),
            accept_languages: policy.accept_languages.clone(),
        })
    })
}

pub fn handles_scheme(partition: &str, scheme: &str) -> bool {
    with(|r| {
        let session = r.get(partition)?;
        Ok(session
            .policy
            .schemes
            .iter()
            .any(|name| name.eq_ignore_ascii_case(scheme))
            && protocol::can_handle(session, scheme)?)
    })
    .unwrap_or(false)
}

/// Main passes the same builder and wcId it owns; this module allocates no window or page identity.
pub fn configure_app<'a, M: Manager<Wry>>(
    mut builder: WebviewWindowBuilder<'a, Wry, M>,
    partition: &str,
    wc_id: u64,
) -> Result<WebviewWindowBuilder<'a, Wry, M>, String> {
    let partition = canonical(partition).to_string();
    let (storage, user_data, current_policy) = with(|r| {
        let root = r.user_data.clone();
        let s = r.ensure(&partition, true)?;
        Ok((s.storage.clone(), root, s.policy.clone()))
    })?;
    let directory = match &storage {
        Storage::App => user_data.join("tauri-webview"),
        Storage::Persistent(name) => user_data
            .join("tauri-webview")
            .join("Partitions")
            .join(format!("{:x}", Sha256::digest(name.as_bytes()))),
        Storage::Memory => {
            return Err(
                "in-memory Preview partitions must use their Chromium BrowserContext".into(),
            );
        }
    };
    let namespace = if storage == Storage::App {
        user_data.to_string_lossy().into_owned()
    } else {
        format!("{}\0{}", user_data.display(), partition)
    };
    let identifier: [u8; 16] = Sha256::digest(namespace.as_bytes())[..16]
        .try_into()
        .expect("digest size");
    builder = builder
        .data_directory(directory)
        .data_store_identifier(identifier);
    #[cfg(target_os = "macos")]
    {
        let configuration =
            protocol_macos::configuration(&partition, identifier, protocol::declared_schemes()?)?;
        builder = builder.with_webview_configuration(configuration);
    }
    if let Some(ua) = &current_policy.user_agent {
        builder = builder.user_agent(ua);
    }
    let permission_partition = partition.clone();
    builder = builder.on_permission_request(move |_, _| {
        if policy(&permission_partition).is_ok_and(|p| p.deny_permissions) {
            PermissionResponse::Deny
        } else {
            PermissionResponse::Default
        }
    });
    Ok(builder.on_download(move |_, event| {
        if !policy(&partition).is_ok_and(|p| p.deny_downloads) {
            return true;
        }
        if let DownloadEvent::Requested { url, destination } = event {
            host::event("session.download", json!({"partition":partition,"wcId":wc_id,
                "url":url.as_str(),"filename":destination.file_name().map(|v|v.to_string_lossy()).unwrap_or_default(),
                "mimeType":"","totalBytes":-1}));
        }
        false
    }))
}

pub async fn attach_app(partition: &str, webview: Webview) -> Result<(), String> {
    let partition = canonical(partition).to_string();
    let preloads = with(|r| {
        let s = r.ensure(&partition, true)?;
        if s.storage == Storage::Memory {
            return Err("a Preview session cannot attach an app WebView".into());
        }
        s.app_views.push(webview.clone());
        Ok(s.policy.preloads.clone())
    })?;
    let result = async {
        let (tx, rx) = oneshot::channel();
        native::apply(
            &webview,
            native::Operation::SetPreloads(preloads),
            Box::new(move |result| {
                let _ = tx.send(result);
            }),
        );
        rx.await
            .map_err(|_| "native preload installation was dropped".to_string())??;
        let (tx, rx) = oneshot::channel();
        native::describe(
            &webview,
            Box::new(move |result| {
                let _ = tx.send(result);
            }),
        );
        rx.await
            .map_err(|_| "native session snapshot was dropped".to_string())?
    }
    .await;
    with(|r| {
        let s = r.get_mut(&partition)?;
        if !s
            .app_views
            .iter()
            .any(|attached| attached.label() == webview.label())
        {
            return Err("app WebView detached before session attachment completed".into());
        }
        match &result {
            Ok(snapshot) => {
                s.snapshot = Some(snapshot.clone());
                s.snapshot_error = None;
                #[cfg(target_os = "macos")]
                {
                    s.native_stream = true;
                }
            }
            Err(error) => {
                s.snapshot_error = Some(error.clone());
            }
        }
        s.ready.notify_waiters();
        Ok(())
    })?;
    result.map(|_| ())
}

pub fn detach_app(webview: &Webview) -> Result<(), String> {
    #[cfg(windows)]
    webview
        .with_webview(windows::forget)
        .map_err(|e| e.to_string())?;
    with(|r| {
        for session in r.partitions.values_mut() {
            session.app_views.retain(|v| v.label() != webview.label());
            if session.app_views.is_empty() {
                session.native_stream = false;
            }
        }
        Ok(())
    })
}

async fn snapshot(partition: &str) -> Result<native::Snapshot, String> {
    if with(|r| Ok(r.get(partition)?.storage == Storage::Memory))? {
        return preview::snapshot(partition).await;
    }
    let ready = with(|r| Ok(r.get(partition)?.ready.clone()))?;
    loop {
        let notified = ready.notified();
        let state = with(|r| {
            let s = r.get(partition)?;
            if let Some(error) = &s.snapshot_error {
                return Err(error.clone());
            }
            Ok(s.snapshot.clone())
        })?;
        if let Some(snapshot) = state {
            return Ok(snapshot);
        }
        notified.await;
    }
}

async fn native_apply(partition: &str, op: native::Operation) -> Result<(), String> {
    let mut views = with(|r| Ok(r.get(partition)?.app_views.clone()))?;
    if views.is_empty() {
        return Err("no live WebView of this session".into());
    }
    if matches!(
        op,
        native::Operation::ClearHttpCache | native::Operation::LearnWord(_)
    ) {
        views.truncate(1);
    }
    for view in views {
        let (tx, rx) = oneshot::channel();
        native::apply(
            &view,
            op.clone(),
            Box::new(move |result| {
                let _ = tx.send(result);
            }),
        );
        rx.await
            .map_err(|_| "native session operation was dropped".to_string())??;
    }
    Ok(())
}

pub fn dispatch(call: Call) -> Option<Call> {
    if !matches!(call.method.as_str(), "session.create" | "session.op") {
        return Some(call);
    }
    let (tx, rx) = oneshot::channel();
    host::on_cancel(call.id(), move || {
        let _ = tx.send(());
    });
    dispatch_with_cancel(call, rx)
}

/// Takes the original cancellation receiver registered before an external lazy-launch queue.
/// No callback replacement gap and no second cancellation or identity registry.
pub fn dispatch_with_cancel(call: Call, cancelled: oneshot::Receiver<()>) -> Option<Call> {
    if !matches!(call.method.as_str(), "session.create" | "session.op") {
        return Some(call);
    }
    let partition = canonical(call.params["partition"].as_str().unwrap_or("")).to_string();
    let cache = call.params["cache"].as_bool().unwrap_or(true);
    match queue(&partition, cache) {
        Ok(queue) => {
            if let Err(error) = queue.send(Command::Request(call, cancelled)) {
                if let Command::Request(call, _) = error.0 {
                    host::forget_cancel(call.id());
                    call.err("failed", "session command queue closed");
                }
            }
        }
        Err(error) => {
            host::forget_cancel(call.id());
            call.err("failed", error);
        }
    }
    None
}

fn queue(
    partition: &str,
    cache: bool,
) -> Result<tokio::sync::mpsc::UnboundedSender<Command>, String> {
    let (queue, receiver) = with(|r| {
        let session = r.ensure(partition, cache)?;
        Ok((session.queue.clone(), session.receiver.take()))
    })?;
    if let Some(receiver) = receiver {
        let partition = partition.to_string();
        tauri::async_runtime::spawn(drain(partition, receiver));
    }
    Ok(queue)
}

async fn drain(partition: String, mut receiver: tokio::sync::mpsc::UnboundedReceiver<Command>) {
    while let Some(command) = receiver.recv().await {
        match command {
            Command::Request(call, mut cancelled) => {
                let cancelled_error = || Failure {
                    code: "cancelled",
                    message: "session operation cancelled".into(),
                };
                let mut result = if cancelled.try_recv().is_ok() {
                    Err(cancelled_error())
                } else if call.method == "session.create" {
                    tokio::select! {
                        result = execute(&call) => result,
                        Ok(()) = &mut cancelled => Err(cancelled_error()),
                    }
                } else {
                    // A native mutation already started cannot be rolled back. Keep this partition's FIFO
                    // until its real completion instead of letting a later mutation overtake it.
                    execute(&call).await
                };
                if cancelled.try_recv().is_ok() {
                    result = Err(cancelled_error());
                }
                host::forget_cancel(call.id());
                match result {
                    Ok(value) => call.ok(value),
                    Err(error) => call.err(error.code, error.message),
                }
            }
            Command::Context(reply) => {
                let result = preview::ensure_context(&partition)
                    .await
                    .and_then(|context| {
                        with(|r| {
                            r.get_mut(&partition)?.context_exposed = true;
                            Ok(context)
                        })
                    });
                let _ = reply.send(result);
            }
        }
    }
}

struct Failure {
    code: &'static str,
    message: String,
}
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self {
            code: "failed",
            message,
        }
    }
}
impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

async fn execute(call: &Call) -> Result<Value, Failure> {
    let partition = canonical(call.params["partition"].as_str().unwrap_or("")).to_string();
    let create = call.method == "session.create";
    let storage = with(|r| Ok(r.get(&partition)?.storage.clone()))?;
    if create {
        let snapshot = snapshot(&partition).await?;
        let policy = policy(&partition)?;
        return Ok(
            json!({"userAgent":policy.user_agent.unwrap_or(snapshot.user_agent),
            "acceptLanguages":policy.accept_languages.unwrap_or(snapshot.accept_languages),
            "spellCheckerLanguages":policy.spell_languages.unwrap_or(snapshot.spell_languages),
            "availableSpellCheckerLanguages":snapshot.available_spell_languages,
            "cachePath":Value::Null}),
        );
    }
    let op = call.params["op"].as_str().unwrap_or("");
    let args = &call.params["args"];
    let mut updated = policy(&partition)?;
    if storage == Storage::Memory && op == "setDownloads" && args["mode"] != "deny" {
        return Err(Failure {
            code: "unsupported",
            message: "Preview's download safety policy cannot be disabled".into(),
        });
    }
    let native_op = match op {
        "setPermissions" => {
            updated.deny_permissions = args["mode"] == "deny-all";
            None
        }
        "setDownloads" => {
            updated.deny_downloads = args["mode"] == "deny";
            None
        }
        "registerPreload" => {
            updated.preload(
                args["id"].as_str().unwrap_or("").to_string(),
                args["source"].as_str().unwrap_or("").to_string(),
            );
            Some(native::Operation::SetPreloads(updated.preloads.clone()))
        }
        "setUserAgent" => {
            let ua = args["userAgent"].as_str().unwrap_or("").to_string();
            updated.user_agent = Some(ua.clone());
            if let Some(languages) = args["acceptLanguages"].as_str() {
                updated.accept_languages = Some(languages.to_string());
            }
            Some(native::Operation::SetUserAgent(ua))
        }
        "clearCache" | "clearStorageData" => {
            if storage == Storage::Memory {
                preview::clear(&partition, op == "clearStorageData").await?;
            } else {
                native_apply(&partition, native::Operation::ClearHttpCache).await?;
                if op == "clearStorageData" {
                    clear_cookies(&partition).await?;
                }
            }
            return Ok(json!({}));
        }
        "setProxy" => {
            if storage != Storage::Memory {
                return Err("changing an existing system WebView's proxy is unsupported".into());
            }
            preview::set_proxy(&partition, args).await?;
            updated.proxy = Some(args.clone());
            None
        }
        "resolveProxy" => {
            let url = args["url"].as_str().unwrap_or("").to_string();
            let result = tauri::async_runtime::spawn_blocking(move || {
                #[cfg(target_os = "macos")]
                {
                    shell_core::sys_mac::proxy::resolve_proxy(&url)
                }
                #[cfg(windows)]
                {
                    shell_core::sys::system::resolve_proxy(&url)
                }
            })
            .await
            .map_err(|e| e.to_string())?;
            return Ok(json!({"result":result}));
        }
        "handleScheme" | "unhandleScheme" => {
            let scheme = args["scheme"].as_str().unwrap_or("").to_ascii_lowercase();
            if op == "handleScheme" && !with(|r| protocol::can_handle(r.get(&partition)?, &scheme))?
            {
                return Err(Failure {
                    code: "unsupported",
                    message:
                        "this declared scheme has no installed native or gateway stream consumer"
                            .into(),
                });
            }
            if op == "handleScheme" {
                updated.schemes.insert(scheme);
            } else {
                updated.schemes.remove(&scheme);
            }
            None
        }
        "setSpellCheckerLanguages" => {
            let requested = args["languages"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .map(String::from)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let normalized = shell_core::spell::normalize(&requested);
            updated.spell_languages = Some(normalized.clone());
            Some(native::Operation::SetSpellLanguages(normalized))
        }
        "addWordToSpellCheckerDictionary" => {
            let word = args["word"].as_str().unwrap_or("").trim().to_string();
            if word.is_empty() {
                return Err(Failure {
                    code: "invalid",
                    message: "no word to add".into(),
                });
            }
            Some(native::Operation::LearnWord(word))
        }
        other => {
            return Err(Failure {
                code: "unsupported",
                message: format!("session.op {other} is not implemented by this shell"),
            });
        }
    };
    if matches!(
        op,
        "setSpellCheckerLanguages" | "addWordToSpellCheckerDictionary"
    ) {
        if storage == Storage::Memory {
            return Err(Failure {
                code: "unsupported",
                message: "Chromium CDP exposes no spellchecker language or dictionary API".into(),
            });
        }
        if let Some(op) = native_op {
            native_apply(&partition, op).await?;
        }
        with(|r| {
            r.get_mut(&partition)?.policy = updated;
            Ok(())
        })?;
        return Ok(json!({}));
    }
    if matches!(op, "handleScheme" | "unhandleScheme") {
        with(|r| {
            r.get_mut(&partition)?.policy = updated;
            Ok(())
        })?;
        return Ok(json!({}));
    }
    with(|r| {
        r.get_mut(&partition)?.policy = updated.clone();
        Ok(())
    })?;
    if storage == Storage::Memory {
        preview::apply(&partition, &updated, op, args).await?;
    } else if let Some(op) = native_op {
        native_apply(&partition, op).await?;
    }
    Ok(json!({}))
}

async fn clear_cookies(partition: &str) -> Result<(), String> {
    let partition = partition.to_string();
    tauri::async_runtime::spawn_blocking(move || crate::network::session::clear_cookies(&partition))
        .await
        .map_err(|e| e.to_string())?
}
