//! A bot's Slack connector over Socket Mode (`connectors.rs`): one WebSocket per Slack app, opened from this computer
//! with the app-level token main hands over per connection (`routineAsk` `slack`), so Slack reaches the bot with no
//! public address. The same app's events may also come signed to `POST /hooks/<id>` (`schedules/engine.rs`).
//!
//! Each `events_api` envelope is acknowledged only after its event was handed to the engine (a run started, kept for
//! after the running one) or passed over on purpose; Slack's `event_id` keeps a redelivered event from asking twice.
//! A dropped socket is opened again after 1 s, doubling to a minute, and at once when the computer wakes or comes back
//! online (`routines.wake`). Without an app-level token the source only waits, asking main again every few minutes.

use std::collections::VecDeque;
use std::sync::LazyLock;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::sync::Notify;
use yawc::{Frame, OpCode, Options, WebSocket};

use crate::routines::connectors::{self, SlackEvent};
use crate::schedules::triggers::Context;
use crate::server::Scope;

/// Event ids remembered: Slack redelivers an event it saw no acknowledgement of within seconds.
const SEEN_MAX: usize = 500;
const BACKOFF_FIRST_MS: u64 = 1_000;
const BACKOFF_MAX_MS: u64 = 60_000;
/// How often an app without an app-level token is asked about again.
const NO_TOKEN_RECHECK_MS: u64 = 5 * 60_000;

/// Woken when the computer resumed or came back online (`routines.wake`): a waiting reconnect goes at once.
static WAKE: LazyLock<Notify> = LazyLock::new(Notify::new);

pub(crate) fn wake() {
    WAKE.notify_waiters();
}

/// What main hands a Slack source: never kept past the connection it opens.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    #[serde(default)]
    app_token: Option<String>,
}

pub(super) async fn run(event: &Value, context: &Context, scope: &Scope) {
    let account = event["account"].as_str().unwrap_or_default().to_owned();
    let key = format!("slack {account}");
    let mut seen: VecDeque<String> = VecDeque::new();
    let mut backoff = BACKOFF_FIRST_MS;
    loop {
        if scope.cancelled() {
            return;
        }
        let app = match context.ask::<Tokens>("slack", Some(&account)).await {
            Ok(tokens) => tokens.app_token.filter(|token| !token.is_empty()),
            Err(fault) => {
                context.failure(&key, Some(&fault.message));
                if !pause(scope, &mut backoff).await {
                    return;
                }
                continue;
            }
        };
        let Some(app) = app else {
            context.failure(&key, None);
            if !sleep_or_wake(scope, NO_TOKEN_RECHECK_MS).await {
                return;
            }
            continue;
        };
        match session(&app, event, context, scope, &key, &mut seen).await {
            Ok(()) => backoff = BACKOFF_FIRST_MS,
            Err(error) => {
                context.failure(&key, Some(&error));
                if !pause(scope, &mut backoff).await {
                    return;
                }
            }
        }
    }
}

/// Waits the backoff (or a wake) and doubles it; false once the source was retired.
async fn pause(scope: &Scope, backoff: &mut u64) -> bool {
    let ms = *backoff;
    *backoff = (*backoff * 2).min(BACKOFF_MAX_MS);
    sleep_or_wake(scope, ms).await
}

async fn sleep_or_wake(scope: &Scope, ms: u64) -> bool {
    tokio::select! {
        biased;
        () = scope.on_cancel() => false,
        () = WAKE.notified() => true,
        () = tokio::time::sleep(Duration::from_millis(ms)) => true,
    }
}

/// One Socket Mode connection, until Slack asks for a reconnect (Ok) or it fails (why).
async fn session(
    app: &str,
    event: &Value,
    context: &Context,
    scope: &Scope,
    key: &str,
    seen: &mut VecDeque<String>,
) -> Result<(), String> {
    let opened = connectors::slack_api(app, "apps.connections.open", &json!({})).await?;
    let url = opened
        .get("url")
        .and_then(Value::as_str)
        .ok_or("Slack named no Socket Mode address")?;
    let mut socket = tokio::select! {
        biased;
        () = scope.on_cancel() => return Ok(()),
        socket = dial(url) => socket?,
    };
    loop {
        let frame = tokio::select! {
            biased;
            () = scope.on_cancel() => return Ok(()),
            frame = socket.next() => frame,
        };
        let Some(frame) = frame else {
            return Err("Slack closed the connection".into());
        };
        match frame.opcode() {
            OpCode::Text => {}
            OpCode::Close => return Err("Slack closed the connection".into()),
            _ => continue,
        }
        let envelope: Value = serde_json::from_slice(frame.payload()).unwrap_or(Value::Null);
        match envelope.get("type").and_then(Value::as_str) {
            Some("hello") => context.failure(key, None),
            Some("disconnect") => return Ok(()),
            Some("events_api") => {
                match connectors::slack_event(event, &envelope["payload"]) {
                    SlackEvent::Asked { id, line } if !seen.contains(&id) => {
                        seen.push_back(id);
                        if seen.len() > SEEN_MAX {
                            seen.pop_front();
                        }
                        if !context.publish(json!({}), &[line]) {
                            return Ok(());
                        }
                    }
                    SlackEvent::Refused { ask, .. } => context.access_asked(&[ask]),
                    _ => {}
                }
                if let Some(envelope_id) = envelope.get("envelope_id").and_then(Value::as_str) {
                    let ack = json!({ "envelope_id": envelope_id }).to_string();
                    socket
                        .send(Frame::text(ack))
                        .await
                        .map_err(|_| "Slack's connection broke".to_owned())?;
                }
            }
            _ => {
                // Slash commands and interactions this app never asked for: acknowledged, nothing more.
                if let Some(envelope_id) = envelope.get("envelope_id").and_then(Value::as_str) {
                    let ack = json!({ "envelope_id": envelope_id }).to_string();
                    let _ = socket.send(Frame::text(ack)).await;
                }
            }
        }
    }
}

/// The `wss://` address Slack named, over TLS checked as every request of the core is.
async fn dial(url: &str) -> Result<WebSocket<tokio_rustls::client::TlsStream<TcpStream>>, String> {
    let url = url::Url::parse(url).map_err(|_| "Slack named an address that is no URL")?;
    if url.scheme() != "wss" {
        return Err("Slack named an address that is not wss://".into());
    }
    let host = url
        .host_str()
        .ok_or("Slack named an address without a host")?
        .to_owned();
    let port = url.port_or_known_default().unwrap_or(443);
    let tcp = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|error| format!("could not reach Slack ({error})"))?;
    let _ = tcp.set_nodelay(true);
    let config = crate::http::machine_tls().map_err(|failure| format!("{failure:?}"))?;
    let name = rustls::pki_types::ServerName::try_from(host)
        .map_err(|_| "Slack named a host TLS cannot check")?;
    let tls = tokio_rustls::TlsConnector::from(config)
        .connect(name, tcp)
        .await
        .map_err(|error| format!("TLS with Slack failed ({error})"))?;
    WebSocket::handshake(url, tls, Options::default())
        .await
        .map_err(|error| format!("Slack refused the socket ({error})"))
}
