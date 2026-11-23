//! A paired host's browser sign-in, finished in THIS computer's browser (was `src/main/remote/sign-in-relay.ts`'s
//! listener; main's `startSignInRelay` reads the authorization URL and answers the forwards). Stock's flow runs on the
//! host, so the authorization URL's `redirect_uri` is the host's loopback callback, and the provider sends this
//! computer's browser to this computer's loopback. While the host's `login` runs, this computer listens on that port
//! on its own loopback, hands the browser's callback to main (`signIn` ask; main sends it over the link as
//! `host.signIn.callback`) and gives the browser the page the host's omp answered.
//! On the host, `signInReplay` sends that query only to stock's advertised loopback callback. Main keeps the tab's
//! one-use path and state checks.
//!
//! Guards: loopback only (both families for `localhost`, as stock binds them), the callback's exact path, the flow's
//! `state`, a loopback Host header (no DNS rebinding), one use, and an end with the sign-in, at Cancel or after
//! stock's own callback timeout. A port this computer already uses is reported, not shared. Nothing here logs the
//! query (it carries the authorization code).

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::header::{CONNECTION, CONTENT_TYPE, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use tokio::sync::watch;

use super::ask;
use crate::server::{Call, Events, Fault, PushCall, Reply};

const PAGE_UNITS: usize = 64 * 1024;

#[derive(Deserialize)]
struct ReplayParams {
    url: String,
    query: String,
}

fn unavailable() -> Fault {
    Fault::new(
        "sign_in_unavailable",
        "The sign-in's callback server did not answer",
    )
}

fn replay_url(params: &ReplayParams) -> Result<url::Url, Fault> {
    // WHATWG Fetch's bad ports are refused even on loopback. Stock's callback uses a high port.
    const BAD_PORTS: &[u16] = &[
        1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101,
        102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389,
        427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636,
        989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665,
        6666, 6667, 6668, 6669, 6679, 6697, 10080,
    ];
    let mut url = url::Url::parse(&params.url).map_err(|_| unavailable())?;
    if BAD_PORTS
        .binary_search(&url.port().ok_or_else(unavailable)?)
        .is_ok()
    {
        return Err(unavailable());
    }
    let query = params.query.as_str();
    url.set_query((!query.is_empty()).then(|| query.strip_prefix('?').unwrap_or(query)));
    url.set_fragment(None);
    Ok(url)
}

fn page_type(headers: &hyper::HeaderMap) -> String {
    let mut values = headers.get_all(CONTENT_TYPE).iter();
    let first = values.next().map_or(&[][..], HeaderValue::as_bytes);
    let allowed = [b"text/html".as_slice(), b"text/plain"]
        .iter()
        .any(|prefix| {
            first
                .get(..prefix.len())
                .is_some_and(|s| s.eq_ignore_ascii_case(prefix))
                && !first
                    .get(prefix.len())
                    .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
        });
    if !allowed {
        return "text/plain; charset=utf-8".into();
    }
    first
        .iter()
        .chain(values.flat_map(|v| b", ".iter().chain(v.as_bytes())))
        .take(200)
        .copied()
        .map(char::from)
        .collect()
}

async fn replay_page(params: &ReplayParams) -> Result<Reply, Fault> {
    let response = crate::http::loopback_get_once(&replay_url(params)?)
        .await
        .map_err(|_| unavailable())?;
    let status = response.status().as_u16();
    let head =
        Reply::json(&json!({"status": status, "contentType": page_type(response.headers())}))?;
    if matches!(status, 204 | 205 | 304) {
        return Ok(head.with_bin(Vec::new()));
    }
    // Stock sends its template as identity. Never display compressed bytes if another responder ignores our request.
    if response
        .headers()
        .get_all("content-encoding")
        .iter()
        .any(|v| !v.as_bytes().eq_ignore_ascii_case(b"identity"))
    {
        return Err(Fault::new(
            "sign_in_unavailable",
            "Unsupported sign-in callback content encoding",
        ));
    }
    let mut body = response.into_body();
    let mut prefix = Vec::new();
    while let Some(frame) = body.frame().await {
        if let Ok(data) = frame.map_err(|_| unavailable())?.into_data() {
            // Allow a BOM and a four-byte scalar starting at the final UTF-16 unit. Still drain to catch late errors.
            let keep = data.len().min(3 + 3 * (PAGE_UNITS - 1) + 4 - prefix.len());
            prefix.extend_from_slice(&data[..keep]);
        }
    }
    let text = String::from_utf8_lossy(prefix.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&prefix));
    let mut units = Vec::with_capacity(2 * text.len().min(PAGE_UNITS));
    for unit in text.encode_utf16().take(PAGE_UNITS) {
        units.extend_from_slice(&unit.to_le_bytes());
    }
    Ok(head.with_bin(units))
}

pub(super) async fn replay(call: Call) -> Result<Reply, Fault> {
    let params: ReplayParams = call.params().map_err(|_| unavailable())?;
    tokio::select! {
        biased;
        () = call.scope.on_cancel() => Err(Fault::cancelled()),
        () = crate::clock::sleep(Duration::from_secs(10)) => Err(unavailable()),
        page = replay_page(&params) => page,
    }
}

struct Relay {
    id: u64,
    path: String,
    state: String,
    loopback_hosts: Vec<String>,
    events: Events,
    closed: watch::Sender<bool>,
    busy: Mutex<bool>,
}

static RELAYS: LazyLock<Mutex<HashMap<u64, Arc<Relay>>>> = LazyLock::new(Mutex::default);

fn relays() -> MutexGuard<'static, HashMap<u64, Arc<Relay>>> {
    RELAYS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Relay {
    fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// Stops listening; a callback on its way finishes (its page is the one the browser shows). Main hears the end
    /// once (`remotebytes.signInEnded`), after every ask this relay made.
    fn close(&self) {
        if self.closed.send_replace(true) {
            return;
        }
        relays().remove(&self.id);
        self.events
            .send("remotebytes.signInEnded", &json!({"relay": self.id}));
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartParams {
    relay: u64,
    port: u16,
    /// The redirect URI's path (`url.pathname`).
    path: String,
    state: String,
    /// The addresses to listen on: `127.0.0.1` and `::1` for `localhost`, else the one the URI names.
    hosts: Vec<String>,
    /// The Host header names a browser may send (`LOOPBACK_HOSTS`).
    loopback_hosts: Vec<String>,
    timeout_ms: u64,
}

/// `remotebytes.signInStart` → `{listening: true}`, or `{listening: false, port}` when this computer already uses
/// the port (then nothing listens), or `{closed: true}` when it was closed meanwhile.
pub async fn start(call: Call) -> Result<Reply, Fault> {
    let params: StartParams = call.params()?;
    let relay = Arc::new(Relay {
        id: params.relay,
        path: params.path,
        state: params.state,
        loopback_hosts: params.loopback_hosts,
        events: call.events.clone(),
        closed: watch::channel(false).0,
        busy: Mutex::new(false),
    });
    relays().insert(relay.id, relay.clone());
    let timer = relay.clone();
    let mut closing = relay.closed.subscribe();
    tokio::spawn(async move {
        tokio::select! {
            () = tokio::time::sleep(Duration::from_millis(params.timeout_ms)) => timer.close(),
            () = ended(&mut closing) => {}
        }
    });
    let mut listeners = Vec::new();
    for (index, host) in params.hosts.iter().enumerate() {
        let bound = TcpListener::bind((host.as_str(), params.port)).await;
        if relay.is_closed() {
            return Reply::json(&json!({"closed": true}));
        }
        match bound {
            Ok(listener) => listeners.push(listener),
            // A computer without IPv6 has no `::1` to take: the IPv4 listener serves alone, as stock's does.
            Err(error) if index > 0 && error.kind() != std::io::ErrorKind::AddrInUse => {}
            Err(_) => {
                relay.close();
                return Reply::json(&json!({"listening": false, "port": params.port}));
            }
        }
    }
    for listener in listeners {
        tokio::spawn(accept(relay.clone(), listener));
    }
    Reply::json(&json!({"listening": true}))
}

/// `remotebytes.signInClose {relay}`: the sign-in ended or a newer page replaced it.
pub fn close(push: PushCall) {
    let Ok(params) = serde_json::from_str::<Map<String, Value>>(push.params.get()) else {
        return;
    };
    let relay = params
        .get("relay")
        .and_then(Value::as_u64)
        .and_then(|id| relays().get(&id).cloned());
    if let Some(relay) = relay {
        relay.close();
    }
}

/// Resolves once the relay closed (the guard `wait_for` gives is no `Send`, so it never crosses an await).
async fn ended(closed: &mut watch::Receiver<bool>) {
    let _ = closed.wait_for(|closed| *closed).await;
}

async fn accept(relay: Arc<Relay>, listener: TcpListener) {
    let mut closed = relay.closed.subscribe();
    loop {
        tokio::select! {
            () = ended(&mut closed) => return,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                tokio::spawn(serve(relay.clone(), stream));
            }
        }
    }
}

/// One connection: one answer (`connection: close`), and an idle one ends with the relay.
async fn serve(relay: Arc<Relay>, stream: tokio::net::TcpStream) {
    let mut closed = relay.closed.subscribe();
    let handler = relay.clone();
    let service = service_fn(move |request| {
        let relay = handler.clone();
        async move { Ok::<_, std::convert::Infallible>(handle(&relay, request).await) }
    });
    let connection = http1::Builder::new().serve_connection(TokioIo::new(stream), service);
    tokio::pin!(connection);
    tokio::select! {
        _ = connection.as_mut() => {}
        () = ended(&mut closed) => {
            connection.as_mut().graceful_shutdown();
            let _ = connection.await;
        }
    }
}

fn answer(status: u16, content_type: Option<&str>, body: String) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(body)));
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = response.headers_mut();
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(CONNECTION, HeaderValue::from_static("close"));
    if let Some(content_type) = content_type {
        let value = HeaderValue::from_str(content_type)
            .unwrap_or(HeaderValue::from_static("text/plain; charset=utf-8"));
        headers.insert(CONTENT_TYPE, value);
    }
    response
}

/// `new URL("http://" + host).hostname`, empty when that is no URL.
pub(super) fn host_name(header: &str) -> String {
    url::Url::parse(&format!("http://{header}"))
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default()
}

/// What `new URL(request.url, "http://localhost")` reads of a request target: its path, its first `state` and its
/// query without `?`.
pub(super) struct Target {
    pub path: String,
    pub state: Option<String>,
    pub query: String,
}

pub(super) fn target(request_target: &str) -> Option<Target> {
    let base = url::Url::parse("http://localhost").ok()?;
    let target = base.join(request_target).ok()?;
    let state = target
        .query_pairs()
        .find(|(name, _)| name == "state")
        .map(|(_, value)| value.into_owned());
    Some(Target {
        path: target.path().to_owned(),
        state,
        query: target.query().unwrap_or_default().to_owned(),
    })
}

fn escape_html(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for char in text.chars() {
        match char {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(char),
        }
    }
    escaped
}

/// The page's words when the host could not take the callback: how to finish by pasting the address.
pub(super) fn failure_page(title: &str, message: &str) -> String {
    let (title, message) = (escape_html(title), escape_html(message));
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{title}</title></head><body style=\"font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem\"><h1 style=\"font-size:1.25rem\">{title}</h1><p>{message}</p></body></html>"
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    status: u16,
    content_type: String,
    body: String,
}

#[derive(Deserialize, Default)]
struct Words {
    #[serde(default)]
    title: String,
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct Forwarded {
    page: Option<Page>,
    failure: Option<Words>,
    /// Main closed the stand-in before its close reached here: nothing was forwarded.
    #[serde(default)]
    closed: bool,
}

async fn handle(relay: &Relay, request: Request<Incoming>) -> Response<Full<Bytes>> {
    let host = request
        .headers()
        .get(hyper::header::HOST)
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
        .unwrap_or_default();
    if !relay.loopback_hosts.contains(&host_name(&host)) {
        return answer(403, None, String::new());
    }
    let callback = target(&request.uri().to_string())
        .filter(|target| request.method() == hyper::Method::GET && target.path == relay.path)
        .filter(|target| target.state.as_deref() == Some(relay.state.as_str()));
    let Some(callback) = callback else {
        return answer(404, Some("text/plain; charset=utf-8"), "Not Found".into());
    };
    {
        let mut busy = relay.busy.lock().unwrap_or_else(|p| p.into_inner());
        if *busy || relay.is_closed() {
            return answer(409, Some("text/plain; charset=utf-8"), String::new());
        }
        *busy = true;
    }
    let mut data = Map::new();
    data.insert("path".into(), callback.path.into());
    data.insert("query".into(), callback.query.into());
    let forwarded = ask(&relay.events, None, relay.id, "signIn", data)
        .await
        .ok()
        .and_then(|answer| serde_json::from_str::<Forwarded>(answer.get()).ok());
    match forwarded {
        Some(Forwarded { closed: true, .. }) => {
            relay.close();
            answer(409, Some("text/plain; charset=utf-8"), String::new())
        }
        // The relay ended between the check above and the ask: main released its asker on the end, so the ask reached
        // nobody and nothing was forwarded. The same answer as a relay closed before the callback came.
        None if relay.is_closed() => answer(409, Some("text/plain; charset=utf-8"), String::new()),
        Some(Forwarded {
            page: Some(page), ..
        }) => {
            // The sign-in ends as its callback arrives; the connection still writes this page.
            relay.close();
            answer(page.status, Some(&page.content_type), page.body)
        }
        other => {
            *relay.busy.lock().unwrap_or_else(|p| p.into_inner()) = false;
            let words = other
                .and_then(|forwarded| forwarded.failure)
                .unwrap_or_default();
            answer(
                502,
                Some("text/html; charset=utf-8"),
                failure_page(&words.title, &words.message),
            )
        }
    }
}

#[cfg(test)]
mod replay_tests {
    use super::*;

    #[tokio::test]
    async fn only_stock_loopback_origins_can_be_dialed() {
        for input in [
            "https://localhost:43210/cb",
            "http://localhost/cb",
            "http://localhost.:43210/cb",
            "http://127.0.0.2:43210/cb",
            "http://[::ffff:127.0.0.1]:43210/cb",
            "http://fixture@127.0.0.1:43210/cb",
        ] {
            let url = url::Url::parse(input).unwrap();
            assert_eq!(
                crate::http::loopback_get_once(&url).await.err(),
                Some(crate::http::Failure::Request),
                "{input}"
            );
        }
        let params = ReplayParams {
            url: "http://localhost:6000/cb".into(),
            query: String::new(),
        };
        assert_eq!(replay_url(&params).unwrap_err(), unavailable());
    }

    #[test]
    fn only_html_and_plain_types_on_a_word_boundary_pass() {
        for (raw, expected) in [
            ("TEXT/PLAIN;charset=UTF-8", "TEXT/PLAIN;charset=UTF-8"),
            ("text/html-fixture", "text/html-fixture"),
            ("text/html_x", "text/plain; charset=utf-8"),
            ("text/html2", "text/plain; charset=utf-8"),
            ("application/xhtml+xml", "text/plain; charset=utf-8"),
        ] {
            let mut headers = hyper::HeaderMap::new();
            headers.insert(CONTENT_TYPE, HeaderValue::from_static(raw));
            assert_eq!(page_type(&headers), expected);
        }
    }
}
