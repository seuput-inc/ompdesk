//! Native system HTTP transport for Node's existing `net.*` wire contract.
//! OS delegates own sockets and TLS. This module alone owns response ordering and cancellation.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use shell_core::netmap::{self, Credentials, FetchParams, LoginAnswer, Redirect};

use crate::host::{self, Call};

#[cfg(target_os = "macos")]
mod mac;
pub mod session;
#[cfg(windows)]
mod windows;

const MAX_CHUNK: usize = 1 << 20;
type Cancel = Box<dyn FnOnce() + Send>;
type Login = Box<dyn FnOnce(LoginAnswer) + Send>;

enum Phase {
    AwaitingHead(Call),
    Streaming,
    Finished,
}

struct State {
    phase: Phase,
    cancel: Option<Cancel>,
    login: Option<(u64, Login)>,
    next_login: u64,
}

pub(super) struct Transfer {
    pub params: FetchParams,
    cancelled: AtomicBool,
    state: Mutex<State>,
}

static ACTIVE: LazyLock<Mutex<HashMap<u64, Arc<Transfer>>>> = LazyLock::new(Mutex::default);
fn active() -> &'static Mutex<HashMap<u64, Arc<Transfer>>> {
    &ACTIVE
}

pub fn dispatch(call: Call) -> Option<Call> {
    match call.method.as_str() {
        "net.fetch" => fetch(call),
        "net.resolveHost" => resolve(call),
        _ => return Some(call),
    }
    None
}

pub fn cancel(data: Value) {
    let Some(req_id) = data.get("reqId").and_then(Value::as_u64) else {
        return;
    };
    let transfer = active().lock().unwrap().get(&req_id).cloned();
    if let Some(transfer) = transfer {
        transfer.abort();
    }
}

fn fetch(mut call: Call) {
    let mut params = match netmap::parse_fetch(&call.params) {
        Ok(params) => params,
        Err(error) => return call.err("invalid", error),
    };
    if !matches!(
        netmap::url_scheme(&params.url).as_deref(),
        Some("http" | "https")
    ) {
        return call.err("failed", netmap::error_text(-302));
    }
    let policy = match session::policy(&params.partition) {
        Ok(policy) => policy,
        Err(error) => return call.err("failed", error),
    };
    if policy.deny_network {
        return call.err("denied", "network requests are disabled for this partition");
    }
    for (name, value) in [
        ("User-Agent", policy.user_agent),
        ("Accept-Language", policy.accept_languages),
    ] {
        if let Some(value) = value
            && !params
                .headers
                .iter()
                .any(|(key, _)| key.eq_ignore_ascii_case(name))
        {
            params.headers.push((name.into(), value));
        }
    }
    let req_id = params.req_id;
    let call_id = call.id();
    let body = if params.has_body {
        call.bin.take()
    } else {
        None
    };
    let transfer = Arc::new(Transfer {
        params,
        cancelled: AtomicBool::new(false),
        state: Mutex::new(State {
            phase: Phase::AwaitingHead(call),
            cancel: None,
            login: None,
            next_login: 0,
        }),
    });
    {
        let mut requests = active().lock().unwrap();
        if requests.contains_key(&req_id) {
            drop(requests);
            transfer.finish(Some("net.fetch reqId is already active".into()));
            return;
        }
        requests.insert(req_id, transfer.clone());
    }
    let cancelled = Arc::downgrade(&transfer);
    host::on_cancel(call_id, move || {
        if let Some(transfer) = cancelled.upgrade() {
            transfer.abort();
        }
    });
    #[cfg(target_os = "macos")]
    let started = mac::start(transfer.clone(), body);
    #[cfg(windows)]
    let started = windows::start(transfer.clone(), body);
    #[cfg(not(any(target_os = "macos", windows)))]
    let started: Result<(), String> = {
        let _ = body;
        Err("native HTTP requires macOS or Windows".into())
    };
    if let Err(error) = started {
        transfer.finish(Some(error));
    }
}

impl Transfer {
    fn abort(&self) {
        self.cancelled.store(true, Ordering::Release);
        let cancel = self.state.lock().unwrap().cancel.take();
        if let Some(cancel) = cancel {
            cancel();
        }
        self.finish(Some(netmap::error_text(-3)));
    }

    pub(super) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub(super) fn set_cancel(&self, cancel: impl FnOnce() + Send + 'static) {
        let mut state = self.state.lock().unwrap();
        if matches!(state.phase, Phase::Finished) || self.is_cancelled() {
            drop(state);
            cancel();
        } else {
            state.cancel = Some(Box::new(cancel));
        }
    }

    pub(super) fn head(&self, status: i32, final_url: &str, headers: &[(String, String)]) -> bool {
        if self.params.redirect == Redirect::Error
            && netmap::is_redirect(
                status,
                headers
                    .iter()
                    .any(|(name, _)| name.eq_ignore_ascii_case("location")),
            )
        {
            self.finish(Some(netmap::error_text(-310)));
            return false;
        }
        let mut state = self.state.lock().unwrap();
        match std::mem::replace(&mut state.phase, Phase::Streaming) {
            Phase::AwaitingHead(call) => {
                host::forget_cancel(call.id());
                call.ok(netmap::head_json(
                    status,
                    "",
                    &self.params.url,
                    final_url,
                    headers,
                ));
                true
            }
            Phase::Streaming => true,
            Phase::Finished => {
                state.phase = Phase::Finished;
                false
            }
        }
    }

    pub(super) fn chunk(&self, bytes: &[u8]) {
        let state = self.state.lock().unwrap();
        if !matches!(state.phase, Phase::Streaming) || self.is_cancelled() {
            return;
        }
        for chunk in bytes.chunks(MAX_CHUNK) {
            host::event_bin("net.chunk", json!({"reqId": self.params.req_id}), chunk);
        }
    }

    pub(super) fn finish(&self, error: Option<String>) {
        let mut state = self.state.lock().unwrap();
        let previous = std::mem::replace(&mut state.phase, Phase::Finished);
        match previous {
            Phase::Finished => return,
            Phase::AwaitingHead(call) => {
                host::forget_cancel(call.id());
                call.err(
                    "failed",
                    error
                        .as_deref()
                        .unwrap_or("HTTP request ended without a response"),
                );
            }
            Phase::Streaming => {
                let data = match error {
                    Some(error) => json!({"reqId": self.params.req_id, "error": error}),
                    None => json!({"reqId": self.params.req_id}),
                };
                host::event("net.end", data);
            }
        }
        let login = state.login.take();
        let cancel = state.cancel.take();
        drop(state);
        // A refused duplicate id never removes the original transfer.
        let mut requests = active().lock().unwrap();
        if requests
            .get(&self.params.req_id)
            .is_some_and(|request| std::ptr::eq(Arc::as_ptr(request), self))
        {
            requests.remove(&self.params.req_id);
        }
        drop(requests);
        drop(cancel);
        if let Some((_, answer)) = login {
            answer(LoginAnswer::Cancel);
        }
    }

    pub(super) fn login(
        self: &Arc<Self>,
        challenge: netmap::Challenge,
        answer: impl FnOnce(LoginAnswer) + Send + 'static,
    ) {
        let mut state = self.state.lock().unwrap();
        if matches!(state.phase, Phase::Finished) || self.is_cancelled() {
            drop(state);
            answer(LoginAnswer::Cancel);
            return;
        }
        state.next_login += 1;
        let seq = state.next_login;
        let stale = state.login.replace((seq, Box::new(answer)));
        drop(state);
        if let Some((_, answer)) = stale {
            answer(LoginAnswer::Cancel);
        }
        let transfer = Arc::downgrade(self);
        host::request(
            "net.login",
            netmap::login_params(self.params.req_id, &challenge),
            None,
            move |result, _| {
                let Some(transfer) = transfer.upgrade() else {
                    return;
                };
                let mut state = transfer.state.lock().unwrap();
                if !state
                    .login
                    .as_ref()
                    .is_some_and(|(waiting, _)| *waiting == seq)
                {
                    return;
                }
                let answer = state.login.take();
                drop(state);
                if let Some((_, answer)) = answer {
                    answer(netmap::login_answer(result.as_ref().ok()));
                }
            },
        );
    }

    pub(super) fn request_headers<'a>(
        &self,
        url: &str,
        base: &'a [(String, String)],
    ) -> Result<Cow<'a, [(String, String)]>, String> {
        if self.params.credentials == Credentials::Omit {
            return Ok(Cow::Borrowed(base));
        }
        let cookie = session::cookie_header(&self.params.partition, url)?;
        if !base
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("cookie"))
            && let Some(cookie) = cookie
        {
            let mut headers = Vec::with_capacity(base.len() + 1);
            headers.extend_from_slice(base);
            headers.push(("Cookie".into(), cookie));
            return Ok(Cow::Owned(headers));
        }
        Ok(Cow::Borrowed(base))
    }

    pub(super) fn response_cookies(
        &self,
        url: &str,
        headers: &[(String, String)],
    ) -> Result<(), String> {
        if self.params.credentials == Credentials::Omit {
            return Ok(());
        }
        session::response_cookies(&self.params.partition, url, headers)
    }
}

fn resolve(call: Call) {
    let Some(name) = call.str("host").filter(|name| !name.trim().is_empty()) else {
        return call.err("invalid", "net.resolveHost needs a host");
    };
    if let Err(error) = netmap::cache_usage(call.params.get("cacheUsage").and_then(Value::as_str)) {
        return call.err("invalid", error);
    }
    let partition = call.str("partition").unwrap_or_default();
    match session::policy(&partition) {
        Err(error) => return call.err("failed", error),
        Ok(policy) if policy.deny_network => {
            return call.err("denied", "network requests are disabled for this partition");
        }
        Ok(_) => {}
    }
    // All modes use the OS resolver; no separate Chromium/DoH cache exists in this shell.
    let call_id = call.id();
    let slot = Arc::new(Mutex::new(Some(call)));
    let cancelled = slot.clone();
    host::on_cancel(call_id, move || {
        if let Some(call) = cancelled.lock().unwrap().take() {
            call.err("cancelled", netmap::error_text(-3));
        }
    });
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    if let Err(error) = std::thread::Builder::new()
        .name("net-dns".into())
        .spawn(move || {
            let _ = send.send(netmap::resolve_system(&name));
        })
    {
        host::forget_cancel(call_id);
        if let Some(call) = slot.lock().unwrap().take() {
            call.err("failed", error.to_string());
        }
        return;
    }
    let waiting = slot.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("net-dns-deadline".into())
        .spawn(move || {
            let result = receive
                .recv_timeout(Duration::from_secs(15))
                .unwrap_or(Err(-105));
            host::forget_cancel(call_id);
            let call = waiting.lock().unwrap().take();
            if let Some(call) = call {
                match result {
                    Ok(addresses) => call.ok(netmap::endpoints_json(&addresses)),
                    Err(code) => call.err("failed", netmap::error_text(code)),
                }
            }
        })
    {
        host::forget_cancel(call_id);
        if let Some(call) = slot.lock().unwrap().take() {
            call.err("failed", error.to_string());
        }
    }
}
