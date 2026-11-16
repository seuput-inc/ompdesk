use std::sync::mpsc;
use std::thread::ThreadId;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tauri::Webview;
use url::Url;

use super::cookie_spec::{self, Cookie};
use super::native::{self, Done};
use super::policy::Storage;
use crate::network::session::CookieAuthority;

pub struct Authority {
    ui_thread: ThreadId,
}

impl Authority {
    /// `ui_thread` is captured by Main's Tauri setup callback, never by a network worker.
    pub fn new(ui_thread: ThreadId) -> Self {
        Self { ui_thread }
    }

    fn worker(&self) -> Result<(), String> {
        if std::thread::current().id() == self.ui_thread {
            return Err("cookie operations cannot wait on the UI thread".into());
        }
        Ok(())
    }
}

fn url(value: &str) -> Result<Url, String> {
    match Url::parse(value) {
        Ok(url) if matches!(url.scheme(), "http" | "https") && url.host().is_some() => Ok(url),
        _ => Err("invalid cookie URL".into()),
    }
}

fn storage(partition: &str) -> Result<Storage, String> {
    super::with(|r| Ok(r.get(partition)?.storage.clone()))
}

fn view(partition: &str) -> Result<Webview, String> {
    super::with(|r| {
        r.get(partition)?
            .app_views
            .first()
            .cloned()
            .ok_or_else(|| "no live WebView of the cookie partition".into())
    })
}

fn wait<T: Send + 'static>(
    view: &Webview,
    work: impl FnOnce(tauri::webview::PlatformWebview, Done<T>) + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::sync_channel(1);
    native::dispatch(
        view,
        Box::new(move |result| {
            let _ = tx.send(result);
        }),
        work,
    );
    rx.recv_timeout(Duration::from_secs(30))
        .map_err(|_| "native cookie operation did not complete".to_string())?
}

type WriteHold = tokio::sync::OwnedMutexGuard<()>;

fn write_hold(partition: &str) -> Result<WriteHold, String> {
    let arbiter = super::with(|r| Ok(r.get(partition)?.cookie_arbiter.clone()))?;
    tauri::async_runtime::block_on(async move {
        tokio::time::timeout(Duration::from_secs(30), arbiter.lock_owned())
            .await
            .map_err(|_| "partition cookie writer did not become available".to_string())
    })
}

fn wait_locked<T: Send + 'static>(
    view: &Webview,
    hold: WriteHold,
    work: impl FnOnce(tauri::webview::PlatformWebview, Done<T>) + Send + 'static,
) -> Result<(T, WriteHold), String> {
    let (tx, rx) = mpsc::sync_channel(1);
    // The callback owns the writer until the real operation ends, even if this caller times out.
    native::dispatch(
        view,
        Box::new(move |result| {
            let _ = tx.send((result, hold));
        }),
        work,
    );
    let (result, hold) = rx
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "native cookie operation did not complete".to_string())?;
    Ok((result?, hold))
}

pub(super) fn params(cookie: &Cookie, source: &str) -> Value {
    let mut value = json!({"name":cookie.name,"value":cookie.value,"url":source,"path":cookie.path,
        "secure":cookie.secure,"httpOnly":cookie.http_only});
    if !cookie.host_only {
        value["domain"] = format!(".{}", cookie.domain).into();
    }
    if let Some(expires) = cookie.expires {
        value["expires"] = expires.into();
    }
    if let Some(site) = &cookie.same_site {
        value["sameSite"] = site.clone().into();
    }
    value
}

impl CookieAuthority for Authority {
    fn cookie_header(&self, partition: &str, target: &str) -> Result<Option<String>, String> {
        self.worker()?;
        let target = url(target)?;
        if storage(partition)? == Storage::Memory {
            return tauri::async_runtime::block_on(async {
                let context = super::preview::cookie_context(partition)?;
                let result = super::preview::browser()?
                    .command(
                        "Storage.getCookies",
                        json!({"browserContextId":context}),
                        None,
                    )
                    .await
                    .map_err(|_| "Preview cookie read failed".to_string())?;
                let cookies = result["cookies"]
                    .as_array()
                    .ok_or("Preview cookie list is unavailable")?;
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| "system clock precedes epoch")?
                    .as_secs_f64();
                let mut selected = Vec::new();
                for cookie in cookies {
                    let domain = cookie["domain"]
                        .as_str()
                        .ok_or("invalid Preview cookie domain")?;
                    let path = cookie["path"]
                        .as_str()
                        .ok_or("invalid Preview cookie path")?;
                    let expires = cookie["expires"].as_f64().unwrap_or(-1.0);
                    if expires > 0.0 && expires <= now {
                        continue;
                    }
                    if !cookie_spec::matches(
                        domain.trim_start_matches('.'),
                        !domain.starts_with('.'),
                        path,
                        cookie["secure"].as_bool().unwrap_or(false),
                        &target,
                    ) {
                        continue;
                    }
                    let name = cookie["name"]
                        .as_str()
                        .ok_or("invalid Preview cookie name")?;
                    let value = cookie["value"]
                        .as_str()
                        .ok_or("invalid Preview cookie value")?;
                    selected.push((path.len(), format!("{name}={value}")));
                }
                selected.sort_by(|a, b| b.0.cmp(&a.0));
                Ok(if selected.is_empty() {
                    None
                } else {
                    Some(
                        selected
                            .into_iter()
                            .map(|(_, value)| value)
                            .collect::<Vec<_>>()
                            .join("; "),
                    )
                })
            });
        }
        let view = view(partition)?;
        #[cfg(target_os = "macos")]
        {
            wait(&view, move |view, done| {
                super::cookies_macos::header(view, target, done)
            })
        }
        #[cfg(windows)]
        {
            let cookies = view
                .cookies_for_url(target)
                .map_err(|_| "WebView2 cookie read failed")?;
            Ok(if cookies.is_empty() {
                None
            } else {
                Some(
                    cookies
                        .iter()
                        .map(|c| format!("{}={}", c.name(), c.value()))
                        .collect::<Vec<_>>()
                        .join("; "),
                )
            })
        }
    }

    fn store_response(
        &self,
        partition: &str,
        source: &str,
        headers: &[String],
    ) -> Result<(), String> {
        self.worker()?;
        let source_url = url(source)?;
        let storage = storage(partition)?;
        let mut validated: Vec<_> = headers
            .iter()
            .filter_map(|raw| cookie_spec::normalize(&source_url, raw).map(|cookie| (raw, cookie)))
            .collect();
        if validated.is_empty() {
            return Ok(());
        }
        if storage == Storage::Memory {
            // Preview pages are independent writers. CDP setters simulate HTTPS admission;
            // only the actual browser network context can safely admit plaintext response cookies there.
            if source_url.scheme() != "https" {
                return Err(
                    "URL-bound plaintext HTTP cookie import is unavailable for Preview partitions"
                        .into(),
                );
            }
            let cookies: Vec<Value> = validated
                .iter()
                .map(|(_, cookie)| params(cookie, source))
                .collect();
            let _hold = write_hold(partition)?;
            return tauri::async_runtime::block_on(async {
                let context = super::preview::cookie_context(partition)?;
                super::preview::browser()?
                    .command(
                        "Storage.setCookies",
                        json!({"browserContextId":context,"cookies":cookies}),
                        None,
                    )
                    .await
                    .map_err(|_| "Preview cookie write failed".to_string())?;
                Ok(())
            });
        }
        let view = view(partition)?;
        let mut hold = write_hold(partition)?;
        if source_url.scheme() != "https" {
            // App HTTP-origin cookies have only host writers: navigation/CSP/IPC capabilities exclude
            // remote HTTP content, unlike Preview. Every native store/clear uses this same partition hold.
            #[cfg(target_os = "macos")]
            let (scopes, returned) = wait_locked(&view, hold, super::cookies_macos::secure_scopes)?;
            #[cfg(windows)]
            let (scopes, returned) =
                wait_locked(&view, hold, super::cookies_windows::secure_scopes)?;
            hold = returned;
            validated.retain(|(_, cookie)| {
                !scopes
                    .iter()
                    .any(|scope| cookie_spec::blocks_overlay(cookie, scope))
            });
        }
        #[cfg(target_os = "macos")]
        {
            let headers = validated
                .into_iter()
                .map(|(raw, cookie)| (raw.clone(), cookie))
                .collect();
            let (_, _hold) = wait_locked(&view, hold, move |view, done| {
                super::cookies_macos::store(view, source_url, headers, done)
            })?;
            Ok(())
        }
        #[cfg(windows)]
        {
            let cookies = validated.into_iter().map(|(_, cookie)| cookie).collect();
            let (_, _hold) = wait_locked(&view, hold, move |view, done| {
                super::cookies_windows::store(view, cookies, done)
            })?;
            Ok(())
        }
    }

    fn clear(&self, partition: &str) -> Result<(), String> {
        self.worker()?;
        let hold = write_hold(partition)?;
        if storage(partition)? == Storage::Memory {
            return tauri::async_runtime::block_on(async {
                let _hold = hold;
                let context = super::preview::cookie_context(partition)?;
                super::preview::browser()?
                    .command(
                        "Storage.clearCookies",
                        json!({"browserContextId":context}),
                        None,
                    )
                    .await
                    .map_err(|_| "Preview cookie clear failed".to_string())?;
                Ok(())
            });
        }
        let view = view(partition)?;
        #[cfg(target_os = "macos")]
        {
            let (_, _hold) = wait_locked(&view, hold, super::cookies_macos::clear)?;
            Ok(())
        }
        #[cfg(windows)]
        {
            let (_, _hold) = wait_locked(&view, hold, super::cookies_windows::clear)?;
            Ok(())
        }
    }
}
