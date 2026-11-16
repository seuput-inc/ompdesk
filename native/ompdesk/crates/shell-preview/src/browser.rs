use std::path::PathBuf;
use std::pin::Pin;
use std::process::ExitStatus;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use tokio::sync::{Mutex, broadcast};
use tokio::task::JoinHandle;

use crate::initialization::Initializations;
use crate::transport::Transport;
use crate::{Error, Event, PageInitializer, Result};

pub struct LaunchConfig {
    /// An absolute executable selected by trusted packaging, never a page-supplied path.
    pub executable: PathBuf,
    /// The application's private disposable Preview storage root, not a user's browser profile.
    pub profile_root: PathBuf,
    pub command_timeout: Duration,
}

pub struct Navigation {
    pub session_id: String,
    pub frame_id: String,
    pub url: String,
}

/// Adapts the host's existing navigation authorization. No allow-list is stored in the browser service.
pub trait NavigationHandler: Send + Sync {
    fn allow(&self, navigation: Navigation) -> Pin<Box<dyn Future<Output = bool> + Send>>;
}

#[derive(Debug, Clone, Copy)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
    pub device_scale_factor: f64,
}

impl Viewport {
    fn params(self) -> Result<Value> {
        if self.width == 0
            || self.height == 0
            || self.width > 16384
            || self.height > 16384
            || !self.device_scale_factor.is_finite()
            || !(0.5..=8.0).contains(&self.device_scale_factor)
        {
            return Err(Error::new("invalid", "Invalid Preview viewport"));
        }
        Ok(json!({"width":self.width,"height":self.height,
            "deviceScaleFactor":self.device_scale_factor,"mobile":false}))
    }
}

#[derive(Debug)]
pub struct Partition {
    pub context_id: String,
}

pub struct Browser {
    transport: Transport,
    profile: PathBuf,
    policy: Mutex<Option<JoinHandle<()>>>,
    shutdown: Mutex<()>,
    cleaned: AtomicBool,
    initializations: Option<Arc<Initializations>>,
}

/// Owns one actual Chromium target. The caller owns native wc/view IDs and access checks.
pub struct Page {
    pub target_id: String,
    pub session_id: String,
    transport: Transport,
    closed: AtomicBool,
    closing: Mutex<()>,
}

static PROFILE_ID: AtomicU64 = AtomicU64::new(1);

impl Browser {
    pub async fn launch(config: LaunchConfig) -> Result<Self> {
        Self::launch_inner(config, None, None).await
    }

    pub async fn launch_with_navigation(
        config: LaunchConfig,
        handler: Arc<dyn NavigationHandler>,
    ) -> Result<Self> {
        Self::launch_inner(config, Some(handler), None).await
    }

    pub async fn launch_with_hooks(
        config: LaunchConfig,
        navigation: Arc<dyn NavigationHandler>,
        initializer: Arc<dyn PageInitializer>,
    ) -> Result<Self> {
        Self::launch_inner(config, Some(navigation), Some(initializer)).await
    }

    async fn launch_inner(
        config: LaunchConfig,
        handler: Option<Arc<dyn NavigationHandler>>,
        initializer: Option<Arc<dyn PageInitializer>>,
    ) -> Result<Self> {
        if !config.executable.is_absolute()
            || !config.profile_root.is_absolute()
            || config.command_timeout.is_zero()
            || config.command_timeout > Duration::from_secs(120)
        {
            return Err(Error::new(
                "invalid",
                "Preview requires trusted absolute paths and a bounded timeout",
            ));
        }
        let executable = tokio::fs::canonicalize(&config.executable).await?;
        if !tokio::fs::metadata(&executable).await?.is_file() {
            return Err(Error::new("invalid", "Preview executable is not a file"));
        }
        tokio::fs::create_dir_all(&config.profile_root).await?;
        let profile = loop {
            let id = PROFILE_ID.fetch_add(1, Ordering::Relaxed);
            let path = config
                .profile_root
                .join(format!("preview-{}-{id}", std::process::id()));
            let mut directory = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                directory.mode(0o700);
            }
            // Creation cannot yield before ownership is recorded, and the profile is private from its first inode.
            match directory.create(&path) {
                Ok(()) => break path,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        };
        let transport = match Transport::launch(&executable, &profile, config.command_timeout).await
        {
            Ok(transport) => transport,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&profile).await;
                return Err(error);
            }
        };
        let events = transport.subscribe_policy();
        let initializations = initializer
            .map(|initializer| Arc::new(Initializations::new(initializer, config.command_timeout)));
        let policy = tokio::spawn(enforce_policy(
            transport.clone(),
            events,
            handler,
            initializations.clone(),
        ));
        let browser = Self {
            transport,
            profile,
            policy: Mutex::new(Some(policy)),
            shutdown: Mutex::new(()),
            cleaned: AtomicBool::new(false),
            initializations,
        };
        let initialized = browser.command("Browser.getVersion", json!({}), None).await;
        if let Err(error) = initialized {
            let _ = browser.shutdown().await;
            return Err(error);
        }
        if let Err(error) = browser
            .command("Target.setAutoAttach", auto_attach(), None)
            .await
        {
            let _ = browser.shutdown().await;
            return Err(error);
        }
        Ok(browser)
    }

    pub fn pid(&self) -> u32 {
        self.transport.pid()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.transport.subscribe()
    }

    /// Trusted host-only CDP. Session IDs are the browser's actual IDs; authorization remains with the host.
    pub async fn command(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value> {
        self.transport.request(method, params, session).await
    }

    pub async fn create_partition(&self) -> Result<Partition> {
        let mut transaction = Creation::new(&self.transport);
        let context = self
            .command(
                "Target.createBrowserContext",
                json!({"disposeOnDetach":true}),
                None,
            )
            .await?;
        let context_id = string_field(&context, "browserContextId")?;
        self.command(
            "Browser.grantPermissions",
            json!({"browserContextId":context_id,"permissions":[]}),
            None,
        )
        .await?;
        self.command(
            "Browser.setDownloadBehavior",
            json!({"browserContextId":context_id,
            "behavior":"deny","eventsEnabled":true}),
            None,
        )
        .await?;
        transaction.commit();
        Ok(Partition { context_id })
    }

    pub async fn close_partition(&self, partition: &Partition) -> Result<()> {
        self.command(
            "Target.disposeBrowserContext",
            json!({"browserContextId":partition.context_id}),
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn create_page(&self, partition: &Partition, viewport: Viewport) -> Result<Page> {
        let metrics = viewport.params()?;
        let mut transaction = Creation::new(&self.transport);
        let target = self.command("Target.createTarget", json!({"url":"about:blank",
            "browserContextId":partition.context_id,"width":viewport.width,"height":viewport.height}), None).await?;
        let target_id = string_field(&target, "targetId")?;
        let attached = self
            .command(
                "Target.attachToTarget",
                json!({"targetId":target_id,"flatten":true}),
                None,
            )
            .await?;
        let session_id = string_field(&attached, "sessionId")?;
        let page = Page {
            target_id,
            session_id,
            transport: self.transport.clone(),
            closed: AtomicBool::new(false),
            closing: Mutex::new(()),
        };
        page.command("Page.enable", json!({})).await?;
        page.command("Runtime.enable", json!({})).await?;
        page.command("Network.enable", json!({})).await?;
        page.command("Fetch.enable", document_interception())
            .await?;
        page.command("Target.setAutoAttach", auto_attach()).await?;
        page.command("Emulation.setDeviceMetricsOverride", metrics)
            .await?;
        if let Some(initializations) = &self.initializations {
            initializations.wait(&page.target_id).await?;
        }
        transaction.commit();
        Ok(page)
    }

    /// Returns only after the exact browser process exited and the owned profile was removed.
    pub async fn shutdown(&self) -> Result<ExitStatus> {
        let _hold = self.shutdown.lock().await;
        let status = self.transport.shutdown().await?;
        if let Some(policy) = self.policy.lock().await.take() {
            policy.abort();
            let _ = policy.await;
        }
        if !self.cleaned.load(Ordering::Acquire) {
            match tokio::fs::remove_dir_all(&self.profile).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            self.cleaned.store(true, Ordering::Release);
        }
        Ok(status)
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        if let Some(policy) = self.policy.get_mut().take() {
            policy.abort();
        }
        if self.cleaned.load(Ordering::Acquire) {
            return;
        }
        let transport = self.transport.clone();
        let profile = self.profile.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if transport.shutdown().await.is_ok() {
                    let _ = tokio::fs::remove_dir_all(profile).await;
                }
            });
        }
    }
}

impl Page {
    pub async fn command(&self, method: &str, params: Value) -> Result<Value> {
        if self.closed.load(Ordering::Acquire) {
            return Err(Error::new("gone", "Preview page is closed"));
        }
        self.transport
            .request(method, params, Some(&self.session_id))
            .await
    }

    pub async fn navigate(&self, url: &str) -> Result<Value> {
        if !web_url(url) {
            return Err(Error::new(
                "denied",
                "Preview navigation requires HTTP or HTTPS",
            ));
        }
        let result = self.command("Page.navigate", json!({"url":url})).await?;
        if result.get("errorText").is_some() {
            return Err(Error::new("failed", "Preview navigation failed"));
        }
        Ok(result)
    }

    pub async fn evaluate(&self, expression: &str, user_gesture: bool) -> Result<Value> {
        let result = self
            .command(
                "Runtime.evaluate",
                json!({"expression":expression,
            "awaitPromise":true,"returnByValue":true,"userGesture":user_gesture}),
            )
            .await?;
        evaluated(result)
    }

    pub async fn isolated_world(&self, name: &str) -> Result<i64> {
        let tree = self
            .transport
            .request("Page.getFrameTree", json!({}), Some(&self.session_id))
            .await?;
        let frame = tree
            .pointer("/frameTree/frame/id")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::new("cdp", "Chromium returned no root frame"))?;
        let world = self
            .transport
            .request(
                "Page.createIsolatedWorld",
                json!({"frameId":frame,
            "worldName":name,"grantUniveralAccess":false}),
                Some(&self.session_id),
            )
            .await?;
        world
            .get("executionContextId")
            .and_then(Value::as_i64)
            .ok_or_else(|| Error::new("cdp", "Chromium returned no isolated world"))
    }

    pub async fn resize(&self, viewport: Viewport) -> Result<()> {
        self.command("Emulation.setDeviceMetricsOverride", viewport.params()?)
            .await?;
        Ok(())
    }

    /// CDP clip coordinates are CSS pixels; clip.scale and deviceScaleFactor are not rewritten.
    pub async fn capture(&self, mut options: Value) -> Result<Vec<u8>> {
        let object = options
            .as_object_mut()
            .ok_or_else(|| Error::new("invalid", "Capture options must be an object"))?;
        object.entry("format").or_insert(json!("png"));
        object.entry("fromSurface").or_insert(json!(true));
        let result = self.command("Page.captureScreenshot", options).await?;
        decoded(&result)
    }

    pub async fn pdf(&self, mut options: Value) -> Result<Vec<u8>> {
        let object = options
            .as_object_mut()
            .ok_or_else(|| Error::new("invalid", "PDF options must be an object"))?;
        object.insert("transferMode".into(), json!("ReturnAsBase64"));
        decoded(&self.command("Page.printToPDF", options).await?)
    }

    pub async fn start_screencast(&self, options: Value) -> Result<()> {
        self.command("Page.startScreencast", options).await?;
        Ok(())
    }

    /// ACK only after the compositor or phone stream consumed this frame. Never ACK an unrelated page's frame.
    pub async fn ack_frame(&self, session_id: i64) -> Result<()> {
        self.command("Page.screencastFrameAck", json!({"sessionId":session_id}))
            .await?;
        Ok(())
    }

    pub async fn stop_screencast(&self) -> Result<()> {
        self.command("Page.stopScreencast", json!({})).await?;
        Ok(())
    }

    pub async fn close(&self) -> Result<()> {
        let _closing = self.closing.lock().await;
        if self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        if let Err(error) = self
            .transport
            .request(
                "Target.closeTarget",
                json!({"targetId":self.target_id}),
                None,
            )
            .await
            && error.code != "cdp_error"
        {
            return Err(error);
        }
        self.closed.store(true, Ordering::Release);
        Ok(())
    }
}

fn evaluated(mut result: Value) -> Result<Value> {
    if result.get("exceptionDetails").is_some() {
        // Page exception text can contain credentials and local paths. The caller can inspect raw CDP when authorized.
        return Err(Error::new("failed", "Preview script threw an exception"));
    }
    Ok(result
        .pointer_mut("/result/value")
        .map(Value::take)
        .unwrap_or(Value::Null))
}

fn decoded(result: &Value) -> Result<Vec<u8>> {
    let data = result
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new("cdp", "Chromium returned no encoded bytes"))?;
    STANDARD
        .decode(data)
        .map_err(|_| Error::new("cdp", "Chromium returned invalid encoded bytes"))
}

fn string_field(value: &Value, key: &str) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| Error::new("cdp", "Chromium returned no target or context identifier"))
}

fn web_url(url: &str) -> bool {
    if url == "about:blank" || url == "about:srcdoc" {
        return true;
    }
    url::Url::parse(url).is_ok_and(|parsed| {
        matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some()
    })
}

fn document_interception() -> Value {
    json!({"patterns":[{"urlPattern":"*","resourceType":"Document","requestStage":"Request"}]})
}

fn auto_attach() -> Value {
    json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true,
        "filter":[{"type":"page"},{"type":"iframe"}]})
}

async fn enforce_policy(
    transport: Transport,
    mut events: broadcast::Receiver<Event>,
    handler: Option<Arc<dyn NavigationHandler>>,
    initializations: Option<Arc<Initializations>>,
) {
    let mut operations = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            result = operations.join_next(), if !operations.is_empty() => {
                if !matches!(result, Some(Ok(Ok(())))) {
                    let _ = transport.shutdown().await;
                    return;
                }
            }
            event = events.recv() => {
                let event = match event {
                    Ok(event) => event,
                    Err(_) => {
                        let _ = transport.shutdown().await;
                        return;
                    }
                };
                if !matches!(event.method.as_str(), "Target.attachedToTarget" | "Target.detachedFromTarget" | "Fetch.requestPaused") {
                    continue;
                }
                if operations.len() >= 256 {
                    let _ = transport.shutdown().await;
                    return;
                }
                let transport = transport.clone();
                let handler = handler.clone();
                let initializations = initializations.clone();
                operations.spawn(async move {
                    policy_event(&transport, &event, handler.as_deref(), initializations.as_deref()).await
                });
            }
        }
    }
}

async fn policy_event(
    transport: &Transport,
    event: &Event,
    handler: Option<&dyn NavigationHandler>,
    initializations: Option<&Initializations>,
) -> Result<()> {
    match event.method.as_str() {
        "Target.attachedToTarget" => {
            let waiting = event
                .params
                .get("waitingForDebugger")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !waiting {
                return Ok(());
            }
            let target = event
                .params
                .get("targetInfo")
                .ok_or_else(|| Error::new("cdp", "Missing attached target"))?;
            let id = string_field(target, "targetId")?;
            let session = string_field(&event.params, "sessionId")?;
            if target.get("openerId").is_some() {
                transport
                    .request("Fetch.enable", document_interception(), Some(&session))
                    .await?;
                // A paused popup can hold window.open and the opener's input reply. Close first, then release that pause.
                let (closed, resumed) = tokio::join!(
                    transport.request("Target.closeTarget", json!({"targetId":id}), None),
                    transport.request("Runtime.runIfWaitingForDebugger", json!({}), Some(&session)),
                );
                for result in [closed, resumed] {
                    if let Err(error) = result
                        && error.code != "cdp_error"
                    {
                        return Err(error);
                    }
                }
            } else {
                let completion = if waiting && let Some(initializations) = initializations {
                    Some(initializations.begin(&id, &session).await)
                } else {
                    None
                };
                let result: Result<()> = async {
                    transport
                        .request("Fetch.enable", document_interception(), Some(&session))
                        .await?;
                    transport
                        .request("Target.setAutoAttach", auto_attach(), Some(&session))
                        .await?;
                    if let Some(initializations) = initializations
                        && let Some((_, owner)) = &completion
                    {
                        if *owner {
                            initializations
                                .initialize(transport, target, &session)
                                .await?;
                        } else {
                            initializations.wait(&id).await?;
                        }
                    }
                    transport
                        .request("Runtime.runIfWaitingForDebugger", json!({}), Some(&session))
                        .await?;
                    Ok(())
                }
                .await;
                if let Some((completion, true)) = completion {
                    completion.send_replace(Some(result.clone()));
                }
                result?;
            }
        }
        "Target.detachedFromTarget" => {
            if let Some(initializations) = initializations
                && let (Some(target), Some(session)) = (
                    event.params.get("targetId").and_then(Value::as_str),
                    event.params.get("sessionId").and_then(Value::as_str),
                )
            {
                initializations.detached(target, session).await;
            }
        }
        "Fetch.requestPaused" => {
            let id = string_field(&event.params, "requestId")?;
            let url = event
                .params
                .pointer("/request/url")
                .and_then(Value::as_str)
                .unwrap_or("");
            let target = match transport
                .request(
                    "Target.getTargetInfo",
                    json!({}),
                    event.session_id.as_deref(),
                )
                .await
            {
                Ok(target) => target,
                Err(error) if error.code == "cdp_error" => return Ok(()),
                Err(error) => return Err(error),
            };
            let popup = target.pointer("/targetInfo/openerId").is_some();
            let mut allowed = !popup && web_url(url);
            if allowed && let Some(handler) = handler {
                let navigation = Navigation {
                    session_id: event
                        .session_id
                        .clone()
                        .ok_or_else(|| Error::new("cdp", "Missing navigation session"))?,
                    frame_id: string_field(&event.params, "frameId")?,
                    url: url.to_owned(),
                };
                allowed = tokio::time::timeout(Duration::from_secs(2), handler.allow(navigation))
                    .await
                    .unwrap_or(false);
            }
            let (method, params) = if allowed {
                ("Fetch.continueRequest", json!({"requestId":id}))
            } else {
                (
                    "Fetch.failRequest",
                    json!({"requestId":id,"errorReason":"BlockedByClient"}),
                )
            };
            if let Err(error) = transport
                .request(method, params, event.session_id.as_deref())
                .await
            {
                // This static response also races ordinary navigation cancellation and target disposal.
                if error.code != "cdp_error" {
                    return Err(error);
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// A cancelled creation has an uncertain side effect. End its browser instead of leaving an unowned context or target.
struct Creation {
    transport: Option<Transport>,
}
impl Creation {
    fn new(transport: &Transport) -> Self {
        Self {
            transport: Some(transport.clone()),
        }
    }
    fn commit(&mut self) {
        self.transport = None;
    }
}
impl Drop for Creation {
    fn drop(&mut self) {
        if let Some(transport) = self.transport.take()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn(async move {
                let _ = transport.shutdown().await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_never_accepts_files_or_script_schemes() {
        for url in [
            "file:///secret",
            "javascript:alert(1)",
            "data:text/html,secret",
            "chrome://version",
            "https:",
            "about:config",
        ] {
            assert!(!web_url(url), "{url}");
        }
        for url in [
            "https://example.invalid/",
            "http://127.0.0.1:1234/",
            "about:blank",
            "about:srcdoc",
        ] {
            assert!(web_url(url), "{url}");
        }
    }

    #[test]
    fn rejects_nonfinite_or_unbounded_capture_geometry() {
        for scale in [f64::NAN, f64::INFINITY, 0.0, 9.0] {
            assert!(
                Viewport {
                    width: 100,
                    height: 100,
                    device_scale_factor: scale
                }
                .params()
                .is_err()
            );
        }
        assert!(
            Viewport {
                width: 0,
                height: 100,
                device_scale_factor: 1.0
            }
            .params()
            .is_err()
        );
    }
}
