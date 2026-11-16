use std::collections::HashSet;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use serde_json::{Value, json};
use shell_preview::{AttachedPage, Browser, Error, PageInitializer, Partition, Viewport};
use tokio::sync::oneshot;

use super::native::Snapshot;
use super::policy::{Command, Policy, Storage};

static BROWSER: OnceLock<Arc<Browser>> = OnceLock::new();

pub(super) fn browser() -> Result<&'static Arc<Browser>, String> {
    BROWSER
        .get()
        .ok_or_else(|| "Preview browser is not installed".to_string())
}

pub fn install(browser: Arc<Browser>) -> Result<(), String> {
    BROWSER
        .set(browser)
        .map_err(|_| "Preview browser already installed".to_string())
}

/// Construct before launch_with_hooks; it stores no Browser and cannot form a shutdown ownership cycle.
pub struct Initializer;

impl PageInitializer for Initializer {
    fn initialize(
        &self,
        page: AttachedPage,
    ) -> Pin<Box<dyn Future<Output = shell_preview::Result<()>> + Send>> {
        Box::pin(async move {
            let partition = super::with(|r| {
                r.partitions
                    .iter()
                    .find_map(|(name, s)| {
                        (s.context.as_deref() == Some(page.context_id.as_str()))
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
    let (storage, context, policy) = super::with(|r| {
        let s = r.get(partition)?;
        Ok((s.storage.clone(), s.context.clone(), s.policy.clone()))
    })?;
    if storage != Storage::Memory {
        return Err("an app WebView partition is not a Preview BrowserContext".into());
    }
    if let Some(context_id) = context {
        return Ok(Partition { context_id });
    }
    create_context(partition, &policy).await
}

async fn create_context(partition: &str, policy: &Policy) -> Result<Partition, String> {
    let browser = browser()?;
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
    let result = browser
        .command("Target.createBrowserContext", params, None)
        .await
        .map_err(|e| e.to_string())?;
    let context_id = result["browserContextId"]
        .as_str()
        .ok_or("BrowserContext id is missing")?
        .to_string();
    let setup = async {
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
    super::with(|r| {
        r.get_mut(partition)?.context = Some(context_id.clone());
        Ok(())
    })?;
    Ok(Partition { context_id })
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
            r.get_mut(partition)?.context = None;
            Ok(())
        })?;
    }
    let mut policy = super::policy(partition)?;
    policy.proxy = Some(args.clone());
    create_context(partition, &policy).await?;
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
        "handleScheme" | "unhandleScheme" => {
            return Err("the Preview streamed custom-scheme consumer is not installed".into());
        }
        "setSpellCheckerLanguages" | "addWordToSpellCheckerDictionary" => {
            return Err("Chromium CDP has no public spellchecker language or dictionary API".into());
        }
        "setProxy" => {}
        other => return Err(format!("session.op {other} has no Preview consumer")),
    }
    Ok(())
}

pub(super) async fn clear(partition: &str, cookies: bool) -> Result<(), String> {
    let context = ensure_context(partition).await?;
    let pages = live_pages(partition).await?;
    if let Some(page) = pages.first() {
        page.command("Network.clearBrowserCache", json!({}))
            .await
            .map_err(|e| e.to_string())?;
    } else {
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
