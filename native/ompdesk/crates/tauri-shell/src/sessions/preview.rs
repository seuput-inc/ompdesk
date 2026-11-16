use std::collections::HashSet;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use serde_json::{Value, json};
use shell_preview::{AttachedPage, Browser, Error, PageInitializer, Partition, Viewport};
use tokio::sync::oneshot;

use crate::preview_protocol::{Gateway, PreviewTransport};

use super::native::Snapshot;
use super::policy::{Command, Policy, Storage};

struct Backend {
    browser: Arc<Browser>,
    gateway: Arc<Gateway>,
}

static BACKEND: OnceLock<Backend> = OnceLock::new();

fn backend() -> Result<&'static Backend, String> {
    BACKEND
        .get()
        .ok_or_else(|| "Preview backend is not installed".into())
}

pub(super) fn browser() -> Result<&'static Arc<Browser>, String> {
    Ok(&backend()?.browser)
}

pub fn install(browser: Arc<Browser>, gateway: Arc<Gateway>) -> Result<(), String> {
    BACKEND
        .set(Backend { browser, gateway })
        .map_err(|_| "Preview backend already installed".into())
}

async fn transport_for(partition: &str) -> Result<PreviewTransport, String> {
    if let Some(transport) = super::with(|r| Ok(r.get(partition)?.preview_transport.clone()))? {
        if !transport.is_live() {
            return Err("Preview transport closed before its BrowserContext was disposed".into());
        }
        return Ok(transport);
    }
    let transport = backend()?
        .gateway
        .reserve_preview_partition(super::canonical(partition))
        .await?;
    if !transport.is_live() {
        return Err("Preview transport closed during reservation".into());
    }
    super::with(|r| {
        r.get_mut(partition)?.preview_transport = Some(transport.clone());
        Ok(())
    })?;
    Ok(transport)
}

pub fn protected_transport(partition: &str) -> Result<PreviewTransport, String> {
    super::with(|r| {
        let session = r.get(partition)?;
        if session.context.is_none() || !session.gateway_proxy_applied {
            return Err(
                "Preview gateway requires a successfully configured explicit proxy bypass".into(),
            );
        }
        session
            .preview_transport
            .as_ref()
            .filter(|transport| transport.is_live())
            .cloned()
            .ok_or_else(|| "Preview gateway transport is not live".into())
    })
}

/// Construct before launch_with_hooks; it stores no Browser and cannot form a shutdown ownership cycle.
pub struct Initializer;

impl PageInitializer for Initializer {
    fn initialize(
        &self,
        page: AttachedPage,
    ) -> Pin<Box<dyn Future<Output = shell_preview::Result<()>> + Send>> {
        Box::pin(async move {
            let target = page
                .command("Target.getTargetInfo", json!({"targetId":page.target_id}))
                .await?;
            if !matches!(
                target["targetInfo"]["type"].as_str(),
                Some("page" | "iframe")
            ) {
                return Err(Error::new(
                    "unsupported",
                    "session frame initialization requires an actual page or iframe",
                ));
            }
            let partition = super::with(|r| {
                r.partitions
                    .iter()
                    .find_map(|(name, s)| {
                        (s.context.as_deref() == Some(page.context_id.as_str())
                            || s.page_contexts.contains(page.context_id.as_str()))
                        .then(|| name.clone())
                    })
                    .ok_or_else(|| "Preview target has no canonical partition".to_string())
            })
            .map_err(|e| Error::new("failed", e))?;
            initialize_page(&partition, page).await
        })
    }
}

pub async fn context_for(partition: &str) -> Result<Partition, String> {
    let (tx, rx) = oneshot::channel();
    super::queue(partition, true)?
        .send(Command::Context(tx))
        .map_err(|_| "session queue closed")?;
    let context = rx
        .await
        .map_err(|_| "session context creation was dropped".to_string())??;
    Ok(context)
}

pub(super) async fn ensure_context(partition: &str) -> Result<Partition, String> {
    if !super::with(|r| Ok(r.get(partition)?.storage == Storage::Memory))? {
        return Err("an app WebView partition is not a Preview BrowserContext".into());
    }
    let transport = transport_for(partition).await?;
    if let Some(context_id) = super::with(|r| Ok(r.get(partition)?.context.clone()))? {
        return Ok(Partition { context_id });
    }
    let policy = super::policy(partition)?;
    create_context(partition, &policy, &transport).await
}

async fn create_context(
    partition: &str,
    policy: &Policy,
    transport: &PreviewTransport,
) -> Result<Partition, String> {
    let (context_id, protected) = new_context(policy, transport).await?;
    super::with(|r| {
        let session = r.get_mut(partition)?;
        session.context = Some(context_id.clone());
        session.gateway_proxy_applied = protected;
        Ok(())
    })?;
    Ok(Partition { context_id })
}

/// Creates one actual BrowserContext with the captured policy, proxy and reserved gateway transport.
async fn new_context(
    policy: &Policy,
    transport: &PreviewTransport,
) -> Result<(String, bool), String> {
    let browser = browser()?;
    if !transport.is_live() {
        return Err("Preview transport is not live".into());
    }
    let mut params = json!({"disposeOnDetach":true});
    if let Some(proxy) = &policy.proxy {
        match proxy["mode"].as_str().unwrap_or("system") {
            "system" => {}
            "direct" => {
                params["proxyServer"] = json!("direct://");
            }
            "fixed_servers" => {
                params["proxyServer"] = proxy["proxyRules"]
                    .as_str()
                    .ok_or("fixed proxy has no rules")?
                    .into();
                if let Some(bypass) = proxy["proxyBypassRules"].as_str() {
                    params["proxyBypassList"] = bypass.into();
                }
            }
            _ => return Err("Preview BrowserContext does not expose a PAC script setter".into()),
        }
    }
    // CDP ignores proxyBypassList without proxyServer. Preserve system mode without claiming protection.
    let protected = params.get("proxyServer").is_some();
    if protected {
        let mut bypass = params["proxyBypassList"].as_str().unwrap_or("").to_string();
        if !bypass.is_empty() {
            bypass.push(';');
        }
        bypass.push_str("<-loopback>;");
        bypass.push_str(&transport.proxy_bypass_rule);
        params["proxyBypassList"] = bypass.into();
    }
    let result = browser
        .command("Target.createBrowserContext", params, None)
        .await
        .map_err(|e| e.to_string())?;
    let context_id = result["browserContextId"]
        .as_str()
        .ok_or("BrowserContext id is missing")?
        .to_string();
    let setup = async {
        if !transport.is_live() {
            return Err(Error::new(
                "gone",
                "Preview transport closed during context creation",
            ));
        }
        browser
            .command(
                "Browser.grantPermissions",
                json!({"browserContextId":context_id,"permissions":[]}),
                None,
            )
            .await?;
        browser
            .command(
                "Browser.setDownloadBehavior",
                json!({"browserContextId":context_id,"behavior":"deny","eventsEnabled":true}),
                None,
            )
            .await?;
        Ok::<(), Error>(())
    }
    .await;
    if let Err(error) = setup {
        let _ = browser
            .command(
                "Target.disposeBrowserContext",
                json!({"browserContextId":context_id}),
                None,
            )
            .await;
        return Err(error.to_string());
    }
    Ok((context_id, protected))
}

fn is_visual(policy: &Policy) -> bool {
    policy
        .schemes
        .iter()
        .any(|name| name.eq_ignore_ascii_case("omp-visual"))
}

/// Runs in the canonical session queue. A registered `omp-visual` partition gets one isolated actual
/// BrowserContext per page (separate cookie jar, CookieStore and service workers); every other
/// partition keeps its shared canonical context.
pub(super) async fn ensure_page_context(partition: &str) -> Result<Partition, String> {
    let shared = ensure_context(partition).await?;
    let policy = super::policy(partition)?;
    if !is_visual(&policy) {
        super::with(|r| {
            r.get_mut(partition)?.context_exposed = true;
            Ok(())
        })?;
        return Ok(shared);
    }
    let transport = transport_for(partition).await?;
    let (context_id, _) = new_context(&policy, &transport).await?;
    let registered = super::with(|r| {
        r.get_mut(partition)?
            .page_contexts
            .insert(context_id.clone());
        Ok(())
    });
    if let Err(error) = registered {
        let _ = browser()?.close_partition(&Partition { context_id }).await;
        return Err(error);
    }
    Ok(Partition { context_id })
}

/// The context for one actual Preview page; see `ensure_page_context`. `context_for` stays the shared one.
pub async fn page_context(partition: &str) -> Result<Partition, String> {
    let (tx, rx) = oneshot::channel();
    super::queue(partition, true)?
        .send(Command::PageContext(tx))
        .map_err(|_| "session queue closed")?;
    rx.await
        .map_err(|_| "session page context creation was dropped".to_string())?
}

/// Disposes a per-page context after its page closed. Ownership stays with the canonical Session until
/// Chromium answers, so a failed disposal can be retried. A shared context is never disposed here.
pub async fn release_page_context(partition: &str, context: &Partition) -> Result<(), String> {
    if !super::with(|r| {
        Ok(r.get(partition)?
            .page_contexts
            .contains(&context.context_id))
    })? {
        return Ok(());
    }
    browser()?
        .command_settled(
            "Target.disposeBrowserContext",
            json!({"browserContextId":context.context_id}),
            None,
        )
        .await
        .map_err(|e| e.to_string())?;
    super::with(|r| {
        r.get_mut(partition)?
            .page_contexts
            .remove(&context.context_id);
        Ok(())
    })
}

pub async fn snapshot(partition: &str) -> Result<Snapshot, String> {
    let context = ensure_context(partition).await?;
    let page = browser()?
        .create_page(
            &context,
            Viewport {
                width: 1,
                height: 1,
                device_scale_factor: 1.0,
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    let result = page
        .evaluate(
            "({userAgent:navigator.userAgent,languages:navigator.languages})",
            false,
        )
        .await;
    let closed = page.close().await;
    let value = result.map_err(|e| e.to_string())?;
    closed.map_err(|e| e.to_string())?;
    let user_agent = value["userAgent"]
        .as_str()
        .ok_or("Preview user agent is unavailable")?
        .to_string();
    let languages = value["languages"]
        .as_array()
        .ok_or("Preview languages are unavailable")?
        .iter()
        .map(|v| v.as_str().ok_or("invalid Preview language"))
        .collect::<Result<Vec<_>, _>>()?
        .join(",");
    Ok(Snapshot {
        user_agent,
        accept_languages: languages,
        spell_languages: Vec::new(),
        available_spell_languages: shell_core::spell::AVAILABLE
            .iter()
            .map(|v| v.to_string())
            .collect(),
    })
}

async fn live_pages(partition: &str) -> Result<Vec<AttachedPage>, String> {
    let targets = browser()?
        .command("Target.getTargets", json!({}), None)
        .await
        .map_err(|e| e.to_string())?;
    let alive: HashSet<&str> = targets["targetInfos"]
        .as_array()
        .ok_or("Preview target list is unavailable")?
        .iter()
        .filter_map(|target| target["targetId"].as_str())
        .collect();
    super::with(|r| {
        let s = r.get_mut(partition)?;
        s.preview_pages
            .retain(|page| alive.contains(page.target_id.as_str()));
        let sessions: HashSet<&str> = s
            .preview_pages
            .iter()
            .map(|p| p.session_id.as_str())
            .collect();
        s.script_ids
            .retain(|session, _| sessions.contains(session.as_str()));
        Ok(s.preview_pages.clone())
    })
}

pub(super) async fn initialize_page(
    partition: &str,
    page: AttachedPage,
) -> shell_preview::Result<()> {
    loop {
        let current = super::policy(partition).map_err(|e| Error::new("failed", e))?;
        apply_page(partition, &page, &current).await?;
        let accepted = super::with(|r| {
            let session = r.get_mut(partition)?;
            if session.policy != current {
                return Ok(false);
            }
            session
                .preview_pages
                .retain(|old| old.target_id != page.target_id);
            session.preview_pages.push(page.clone());
            Ok(true)
        })
        .map_err(|e| Error::new("failed", e))?;
        if accepted {
            break;
        }
    }
    let cache =
        super::with(|r| Ok(r.get(partition)?.cache)).map_err(|e| Error::new("failed", e))?;
    page.command("Network.setCacheDisabled", json!({"cacheDisabled":!cache}))
        .await?;
    Ok(())
}

async fn apply_page(
    partition: &str,
    page: &AttachedPage,
    policy: &Policy,
) -> shell_preview::Result<()> {
    if let Some(ua) = &policy.user_agent {
        let mut params = json!({"userAgent":ua});
        if let Some(languages) = &policy.accept_languages {
            params["acceptLanguage"] = languages.clone().into();
        }
        page.command("Emulation.setUserAgentOverride", params)
            .await?;
    }
    let ids = super::with(|r| {
        Ok(r.get_mut(partition)?
            .script_ids
            .remove(&page.session_id)
            .unwrap_or_default())
    })
    .map_err(|e| Error::new("failed", e))?;
    for id in ids {
        page.command(
            "Page.removeScriptToEvaluateOnNewDocument",
            json!({"identifier":id}),
        )
        .await?;
    }
    if !policy.preloads.is_empty() {
        let registered = page
            .command(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({"source":policy.preload_source()}),
            )
            .await?;
        let id = registered["identifier"]
            .as_str()
            .ok_or_else(|| Error::new("failed", "Preview preload registration has no id"))?
            .to_string();
        super::with(|r| {
            r.get_mut(partition)?
                .script_ids
                .insert(page.session_id.clone(), vec![id]);
            Ok(())
        })
        .map_err(|e| Error::new("failed", e))?;
    }
    Ok(())
}

pub(super) async fn set_proxy(partition: &str, args: &Value) -> Result<(), String> {
    let arbiter = super::with(|r| Ok(r.get(partition)?.cookie_arbiter.clone()))?;
    let _hold = arbiter.lock_owned().await;
    if super::with(|r| Ok(r.get(partition)?.context_exposed))? {
        return Err("changing the proxy would discard an exposed Preview BrowserContext".into());
    }
    if !super::with(|r| Ok(r.get(partition)?.page_contexts.is_empty()))? {
        return Err("the proxy cannot change while per-page Preview contexts are live".into());
    }
    if !live_pages(partition).await?.is_empty() {
        return Err(
            "the proxy cannot change while Preview pages of this partition are live".into(),
        );
    }
    let current = super::with(|r| Ok(r.get(partition)?.context.clone()))?;
    if let Some(context_id) = current {
        browser()?
            .close_partition(&Partition { context_id })
            .await
            .map_err(|e| e.to_string())?;
        super::with(|r| {
            let session = r.get_mut(partition)?;
            session.context = None;
            session.gateway_proxy_applied = false;
            Ok(())
        })?;
    }
    let mut policy = super::policy(partition)?;
    policy.proxy = Some(args.clone());
    let transport = transport_for(partition).await?;
    create_context(partition, &policy, &transport).await?;
    Ok(())
}

pub(super) async fn apply(
    partition: &str,
    policy: &Policy,
    op: &str,
    _args: &Value,
) -> Result<(), String> {
    match op {
        "setUserAgent" | "registerPreload" => {
            for page in live_pages(partition).await? {
                apply_page(partition, &page, policy)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        "setPermissions" => {
            let context = ensure_context(partition).await?;
            let (method, params) = if policy.deny_permissions {
                (
                    "Browser.grantPermissions",
                    json!({"browserContextId":context.context_id,"permissions":[]}),
                )
            } else {
                (
                    "Browser.resetPermissions",
                    json!({"browserContextId":context.context_id}),
                )
            };
            browser()?
                .command(method, params, None)
                .await
                .map_err(|e| e.to_string())?;
        }
        "setDownloads" => {
            if !policy.deny_downloads {
                return Err("Preview's download safety policy cannot be disabled".into());
            }
            let context = ensure_context(partition).await?;
            browser()?.command("Browser.setDownloadBehavior", json!({"browserContextId":context.context_id,"behavior":"deny","eventsEnabled":true}), None).await.map_err(|e|e.to_string())?;
        }
        "setSpellCheckerLanguages" | "addWordToSpellCheckerDictionary" => {
            return Err(
                "Chromium CDP has no public spellchecker language or dictionary API".into(),
            );
        }
        "setProxy" => {}
        other => return Err(format!("session.op {other} has no Preview consumer")),
    }
    Ok(())
}

pub(super) async fn clear(partition: &str, cookies: bool) -> Result<(), String> {
    let context = ensure_context(partition).await?;
    let pages = live_pages(partition).await?;
    let mut cleared_contexts = HashSet::new();
    for page in &pages {
        if cleared_contexts.insert(page.context_id.clone()) {
            page.command("Network.clearBrowserCache", json!({}))
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    if !cleared_contexts.contains(&context.context_id) {
        let page = browser()?
            .create_page(
                &context,
                Viewport {
                    width: 1,
                    height: 1,
                    device_scale_factor: 1.0,
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        let cleared = page.command("Network.clearBrowserCache", json!({})).await;
        let closed = page.close().await;
        cleared.map_err(|e| e.to_string())?;
        closed.map_err(|e| e.to_string())?;
    }
    if cookies {
        super::clear_cookies(partition).await?;
        let aliases = super::with(|r| Ok(r.get(partition)?.page_contexts.clone()))?;
        for context_id in aliases {
            browser()?
                .command(
                    "Storage.clearCookies",
                    json!({"browserContextId":context_id}),
                    None,
                )
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn cookie_context(partition: &str) -> Result<String, String> {
    super::with(|r| {
        let s = r.get_mut(partition)?;
        let context = s
            .context
            .clone()
            .ok_or("Preview BrowserContext does not exist")?;
        s.context_exposed = true;
        Ok(context)
    })
}
