//! A bot's Google connector (`connectors.rs`): the person's own Google app (a Desktop OAuth client they made in
//! Google Cloud, Orca `skill-guides/orca-cli/references/google-setup.md`, `main/google/google-client-file.ts:1-86`),
//! signed in from this computer with the installed-app flow (PKCE, a loopback redirect to `127.0.0.1`), and what it
//! reads: the primary calendar's events about to start (Orca `main/google/google-trigger-match.ts:173-199`,
//! `shared/automation-google-triggers.ts:30-37`), and for an email routine Gmail's IMAP with an access token instead of
//! a password (`routines/imap`, XOAUTH2).
//!
//! Methods (main's; it keeps the client secret and the refresh token in its keystore and hands them over per use):
//! - `connectors.googleSignIn {clientId, clientSecret}` → `{flow, url}`: a loopback listener waits for Google's
//!   redirect; main opens `url` in the browser.
//! - `connectors.googleSignInWait {flow}` → `{refreshToken, email}` once the person allowed it (ten minutes at most).
//! - `connectors.googleSignInCancel {flow}`.
//! - `connectors.googleToken {clientId, clientSecret, refreshToken}` → `{accessToken}`.
//!
//! Nothing here logs a token or a code; a failure names Google's error code or a kind.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use super::connectors;
use crate::http::{self, Request};
use crate::server::{Fault, Registry, Reply};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const EVENTS_URL: &str = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
/// What a bot's Google connector asks for: who signed in, the calendar's events to read, and Gmail over IMAP.
pub(crate) const SCOPES: &str = "openid email https://www.googleapis.com/auth/calendar.events.readonly https://mail.google.com/";
/// How long a sign-in waits for the person (Orca's `GOOGLE_SIGN_IN_TTL_MS` is ten minutes).
const SIGN_IN_WAIT: Duration = Duration::from_secs(600);
/// The most of a redirect's request read.
const REQUEST_MAX: usize = 16 * 1024;
const CLOSE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>OMPdesk</title><p style=\"font:16px system-ui;margin:3em\">You can close this tab and go back to OMPdesk.</p>";

type Outcome = Result<Value, String>;

struct Flow {
    done: Option<oneshot::Receiver<Outcome>>,
    stop: Option<oneshot::Sender<()>>,
}

static FLOWS: LazyLock<Mutex<HashMap<String, Flow>>> = LazyLock::new(Mutex::default);

fn flows() -> std::sync::MutexGuard<'static, HashMap<String, Flow>> {
    FLOWS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn random_url_safe(bytes: usize) -> String {
    let mut raw = vec![0u8; bytes];
    let _ = crate::sys::random(&mut raw);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
}

/// PKCE's S256 challenge of a verifier (RFC 7636 §4.2).
fn challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(&Sha256::digest(verifier.as_bytes())[..])
}

/// The query of a redirect's request line (`GET /?code=…&state=… HTTP/1.1`), its pairs decoded.
fn redirect_query(head: &str) -> HashMap<String, String> {
    let target = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or_default();
    let query = target.split_once('?').map_or("", |(_, query)| query);
    url::form_urlencoded::parse(query.as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

/// The e-mail an ID token names (its payload's `email`), read without its signature: it came straight from Google's
/// token endpoint over TLS, as a response to this computer's own request.
fn email_of(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    claims.get("email")?.as_str().map(str::to_owned)
}

/// A POST of a form to Google's token endpoint; its JSON answer, or Google's error code.
async fn token_request(form: &[(&str, &str)]) -> Result<Value, String> {
    let body: String = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(form)
        .finish();
    let answer = http::send(Request {
        url: TOKEN_URL,
        headers: &[("content-type", "application/x-www-form-urlencoded")],
        body: Some(body.as_bytes()),
        proxy: None,
    })
    .await
    .map_err(|failure| format!("Google did not answer ({failure:?})"))?;
    let reply: Value = serde_json::from_slice(&answer.body).unwrap_or(Value::Null);
    if (200..300).contains(&answer.status) {
        return Ok(reply);
    }
    let error = reply
        .get("error")
        .and_then(Value::as_str)
        .map_or_else(|| format!("HTTP {}", answer.status), str::to_owned);
    Err(match error.as_str() {
        "invalid_grant" => {
            "Google no longer takes this sign-in (signed out, or the app's access was removed); sign in again".to_owned()
        }
        "invalid_client" => "Google refused the app's client ID or secret".to_owned(),
        other => format!("Google refused it: {other}"),
    })
}

/// An access token for a kept sign-in, and how many seconds it lasts.
pub(crate) async fn access_token(
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<(String, u64), String> {
    let reply = token_request(&[
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ])
    .await?;
    let token = reply
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or("Google gave no access token")?;
    Ok((
        token.to_owned(),
        reply
            .get("expires_in")
            .and_then(Value::as_u64)
            .unwrap_or(3600),
    ))
}

/// The primary calendar's events starting between two times (epoch ms), single occurrences in start order.
pub(crate) async fn events_between(token: &str, from: i64, to: i64) -> Result<Vec<Value>, String> {
    let mut url = url::Url::parse(EVENTS_URL).map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("singleEvents", "true")
        .append_pair("orderBy", "startTime")
        .append_pair("maxResults", "50")
        .append_pair("timeMin", &crate::schedules::rules::iso(from))
        .append_pair("timeMax", &crate::schedules::rules::iso(to));
    let bearer = format!("Bearer {token}");
    let answer = http::send(Request {
        url: url.as_str(),
        headers: &[("authorization", bearer.as_str())],
        body: None,
        proxy: None,
    })
    .await
    .map_err(|failure| format!("Google Calendar did not answer ({failure:?})"))?;
    let reply: Value = serde_json::from_slice(&answer.body).unwrap_or(Value::Null);
    if !(200..300).contains(&answer.status) {
        let reason = reply
            .pointer("/error/message")
            .and_then(Value::as_str)
            .map_or_else(|| format!("HTTP {}", answer.status), str::to_owned);
        return Err(format!("Google Calendar refused it: {reason}"));
    }
    Ok(reply
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// One calendar event due now: its key (id and start, so a moved event fires again) and the line its run is told.
#[derive(Debug, PartialEq)]
pub(crate) struct DueEvent {
    pub key: String,
    pub line: String,
}

/// The events of `items` whose lead time has come and that have not started (Orca `calendarDueAt`: once, at or after
/// `leadMinutes` before, never after the start), not in `fired`; all-day events have no start time and never fire.
/// Their titles, places and notes are other people's words.
pub(crate) fn due_events(
    event: &Value,
    items: &[Value],
    now: i64,
    fired: &[String],
) -> Vec<DueEvent> {
    let account = event["account"].as_str().unwrap_or_default();
    let lead = event["leadMinutes"].as_i64().unwrap_or(10).max(0) * 60_000;
    let text = |item: &Value, path: &str| {
        item.pointer(path)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let mut due = Vec::new();
    for item in items {
        let starts = text(item, "/start/dateTime");
        let at = crate::trackers::time_ms(&starts) as i64;
        if starts.is_empty() || at <= 0 || text(item, "/status") == "cancelled" {
            continue;
        }
        let key = format!("{}@{starts}", text(item, "/id"));
        if !(at - lead <= now && now < at) || fired.contains(&key) {
            continue;
        }
        let header = format!(
            "Google Calendar ({account}) · an event starts at {} · {}",
            crate::schedules::rules::iso(at),
            text(item, "/htmlLink")
        );
        let invited = item
            .get("attendees")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let mut words = format!("Title: {}", text(item, "/summary"));
        for (label, path) in [("Where", "/location"), ("Meet", "/hangoutLink")] {
            let value = text(item, path);
            if !value.is_empty() {
                words.push_str(&format!("\n{label}: {value}"));
            }
        }
        if invited > 0 {
            words.push_str(&format!("\n{invited} invited"));
        }
        let notes = text(item, "/description");
        if !notes.is_empty() {
            words.push_str(&format!("\n\n{notes}"));
        }
        due.push(DueEvent {
            key,
            line: connectors::asked(&header, &words),
        });
    }
    due
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Client {
    client_id: String,
    client_secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Refresh {
    client_id: String,
    client_secret: String,
    refresh_token: String,
}

#[derive(Deserialize)]
struct FlowId {
    flow: String,
}

/// Waits for Google's redirect on `listener`: the one carrying this flow's `state` ends it (its code exchanged for the
/// refresh token), anything else (a favicon, a stray visit) is answered 404 and waited past.
async fn redirect(listener: TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut socket, _) = listener
            .accept()
            .await
            .map_err(|error| format!("the sign-in's listener failed ({error})"))?;
        let mut head = Vec::new();
        let mut buffer = [0u8; 2048];
        while !head.windows(4).any(|window| window == b"\r\n\r\n") && head.len() < REQUEST_MAX {
            match tokio::time::timeout(Duration::from_secs(10), socket.read(&mut buffer)).await {
                Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
                Ok(Ok(read)) => head.extend_from_slice(&buffer[..read]),
            }
        }
        let query = redirect_query(&String::from_utf8_lossy(&head));
        let ours = query.get("state").is_some_and(|given| {
            given.len() == state.len()
                && bool::from(subtle::ConstantTimeEq::ct_eq(
                    given.as_bytes(),
                    state.as_bytes(),
                ))
        });
        if !ours {
            let _ = socket
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            continue;
        }
        let page = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{CLOSE_PAGE}",
            CLOSE_PAGE.len()
        );
        let _ = socket.write_all(page.as_bytes()).await;
        let _ = socket.shutdown().await;
        if let Some(error) = query.get("error") {
            return Err(if error == "access_denied" {
                "the sign-in was not allowed".to_owned()
            } else {
                format!("Google ended the sign-in: {error}")
            });
        }
        return query
            .get("code")
            .cloned()
            .ok_or_else(|| "Google sent no code".to_owned());
    }
}

pub fn register(registry: &mut Registry) {
    registry.add("connectors.googleSignIn", |call| {
        Box::pin(async move {
            let client: Client = call.params()?;
            if !client.client_id.ends_with(".apps.googleusercontent.com") || client.client_secret.trim().is_empty() {
                return Err(Fault::new(
                    "invalid_params",
                    "Enter the Desktop app client's ID (….apps.googleusercontent.com) and secret",
                ));
            }
            let listener = TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(|error| Fault::new("google_sign_in", format!("could not listen for Google ({error})")))?;
            let port = listener
                .local_addr()
                .map_err(|error| Fault::new("google_sign_in", error.to_string()))?
                .port();
            let redirect_uri = format!("http://127.0.0.1:{port}");
            let verifier = random_url_safe(48);
            let state = random_url_safe(24);
            let mut url = url::Url::parse(AUTH_URL).map_err(|error| Fault::new("internal", error.to_string()))?;
            url.query_pairs_mut()
                .append_pair("client_id", &client.client_id)
                .append_pair("redirect_uri", &redirect_uri)
                .append_pair("response_type", "code")
                .append_pair("scope", SCOPES)
                .append_pair("code_challenge", &challenge(&verifier))
                .append_pair("code_challenge_method", "S256")
                .append_pair("state", &state)
                .append_pair("access_type", "offline")
                .append_pair("prompt", "consent");
            let flow = random_url_safe(12);
            let (done, result) = oneshot::channel();
            let (stop, stopped) = oneshot::channel::<()>();
            flows().insert(
                flow.clone(),
                Flow {
                    done: Some(result),
                    stop: Some(stop),
                },
            );
            tokio::spawn(async move {
                let outcome = tokio::select! {
                    _ = stopped => Err("the sign-in was cancelled".to_owned()),
                    () = tokio::time::sleep(SIGN_IN_WAIT) => Err("the sign-in took too long".to_owned()),
                    code = redirect(listener, &state) => match code {
                        Ok(code) => token_request(&[
                            ("code", code.as_str()),
                            ("client_id", client.client_id.as_str()),
                            ("client_secret", client.client_secret.as_str()),
                            ("redirect_uri", redirect_uri.as_str()),
                            ("code_verifier", verifier.as_str()),
                            ("grant_type", "authorization_code"),
                        ])
                        .await
                        .and_then(|reply| {
                            let refresh = reply
                                .get("refresh_token")
                                .and_then(Value::as_str)
                                .ok_or("Google gave no refresh token")?;
                            let email = reply
                                .get("id_token")
                                .and_then(Value::as_str)
                                .and_then(email_of)
                                .ok_or("Google named no account")?;
                            Ok(json!({ "refreshToken": refresh, "email": email }))
                        }),
                        Err(error) => Err(error),
                    },
                };
                let _ = done.send(outcome);
            });
            Reply::json(&json!({ "flow": flow, "url": url.as_str() }))
        })
    });
    registry.add("connectors.googleSignInWait", |call| {
        Box::pin(async move {
            let FlowId { flow } = call.params()?;
            let waiting = flows()
                .get_mut(&flow)
                .and_then(|known| known.done.take())
                .ok_or_else(|| Fault::new("google_sign_in", "No Google sign-in is waiting"))?;
            let outcome = tokio::select! {
                outcome = waiting => outcome.unwrap_or_else(|_| Err("the sign-in ended".to_owned())),
                () = call.scope.on_cancel() => Err("the sign-in was cancelled".to_owned()),
            };
            if let Some(mut known) = flows().remove(&flow)
                && let Some(stop) = known.stop.take()
            {
                let _ = stop.send(());
            }
            match outcome {
                Ok(value) => Reply::json(&value),
                Err(error) => Err(Fault::new("google_sign_in", error)),
            }
        })
    });
    registry.add("connectors.googleSignInCancel", |call| {
        Box::pin(async move {
            let FlowId { flow } = call.params()?;
            if let Some(stop) = flows().get_mut(&flow).and_then(|known| known.stop.take()) {
                let _ = stop.send(());
            }
            Reply::json(&Value::Null)
        })
    });
    registry.add("connectors.googleToken", |call| {
        Box::pin(async move {
            let refresh: Refresh = call.params()?;
            let (token, _) = access_token(
                &refresh.client_id,
                &refresh.client_secret,
                &refresh.refresh_token,
            )
            .await
            .map_err(|error| Fault::new("google_token", error))?;
            Reply::json(&json!({ "accessToken": token }))
        })
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc_7636() {
        // RFC 7636 Appendix B.
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn a_redirect_reads_its_query_and_an_id_token_its_email() {
        let query = redirect_query(
            "GET /?state=s%2B1&code=4%2F0A&scope=email HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        );
        assert_eq!(query.get("state").map(String::as_str), Some("s+1"));
        assert_eq!(query.get("code").map(String::as_str), Some("4/0A"));
        let payload =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"email":"ana@x.test"}"#);
        assert_eq!(
            email_of(&format!("h.{payload}.s")).as_deref(),
            Some("ana@x.test")
        );
        assert_eq!(email_of("not a token"), None);
    }

    #[test]
    fn an_event_is_due_once_inside_its_lead_and_never_after_it_starts() {
        let routine = json!({ "source": "google", "account": "ana@x.test", "leadMinutes": 10 });
        let start = 1_700_000_600_000_i64;
        let item = |id: &str, extra: Value| {
            let mut item = json!({
                "id": id,
                "summary": "Standup ``` run",
                "htmlLink": "https://calendar.google.com/e",
                "start": { "dateTime": crate::schedules::rules::iso(start) },
                "attendees": [{}, {}],
            });
            if let Value::Object(extra) = extra {
                item.as_object_mut().unwrap().extend(extra);
            }
            item
        };
        let items = vec![
            item("a", json!({})),
            item("allday", json!({ "start": { "date": "2023-11-14" } })),
            item("gone", json!({ "status": "cancelled" })),
        ];
        // Eleven minutes before: not yet. Ten: due. At the start: past.
        assert!(due_events(&routine, &items, start - 660_000, &[]).is_empty());
        let due = due_events(&routine, &items, start - 600_000, &[]);
        assert_eq!(due.len(), 1);
        let (header, words) = connectors::split(&due[0].line).expect("asked");
        assert!(
            header.starts_with("Google Calendar (ana@x.test) · an event starts at "),
            "{header}"
        );
        assert_eq!(words, "Title: Standup ``` run\n2 invited");
        assert!(due_events(&routine, &items, start - 1, &[due[0].key.clone()]).is_empty());
        assert!(due_events(&routine, &items, start, &[]).is_empty());
    }
}
