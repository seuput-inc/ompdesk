//! A bot's Google Calendar connector (`routines/google.rs`): once a minute the primary calendar's events about to
//! start, read with an access token minted from the sign-in main keeps (`routineAsk` `google`); each event fires once,
//! `leadMinutes` before it starts. The token is kept in memory until a minute before it runs out.

use serde::Deserialize;
use serde_json::{Value, json};

use super::wait;
use crate::routines::google;
use crate::schedules::triggers::Context;
use crate::server::Scope;

/// Events remembered as fired: a moved event fires again (its key holds its start).
const FIRED_MAX: usize = 200;
const POLL_MS: u64 = 60_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sign {
    client_id: String,
    client_secret: String,
    refresh_token: String,
}

pub(super) async fn run(event: &Value, mark: Option<Value>, context: &Context, scope: &Scope) {
    let account = event["account"].as_str().unwrap_or_default().to_owned();
    let lead = event["leadMinutes"].as_i64().unwrap_or(10).max(0) * 60_000;
    let key = format!("google {account}");
    let mut fired: Vec<String> = mark
        .as_ref()
        .and_then(|mark| mark["fired"].as_array())
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let mut token: Option<(String, i64)> = None;
    loop {
        if scope.cancelled() {
            return;
        }
        let now = crate::trackers::now_ms() as i64;
        let cached = token
            .as_ref()
            .filter(|(_, until)| *until > now + 60_000)
            .map(|(value, _)| value.clone());
        let read = async {
            let current = match cached {
                Some(value) => value,
                None => {
                    let sign = context
                        .ask::<Sign>("google", Some(&account))
                        .await
                        .map_err(|fault| fault.message)?;
                    let (value, seconds) = google::access_token(
                        &sign.client_id,
                        &sign.client_secret,
                        &sign.refresh_token,
                    )
                    .await?;
                    token = Some((value.clone(), now + seconds as i64 * 1000));
                    value
                }
            };
            google::events_between(&current, now, now + lead + 2 * POLL_MS as i64).await
        }
        .await;
        if scope.cancelled() {
            return;
        }
        match read {
            Ok(items) => {
                context.failure(&key, None);
                let due = google::due_events(event, &items, now, &fired);
                fired.extend(due.iter().map(|due| due.key.clone()));
                if fired.len() > FIRED_MAX {
                    fired.drain(..fired.len() - FIRED_MAX);
                }
                let lines: Vec<String> = due.into_iter().map(|due| due.line).collect();
                if !context.publish(json!({ "fired": fired }), &lines) {
                    return;
                }
            }
            Err(error) => {
                // A refused sign-in is asked for again next time; a token may simply have expired early.
                token = None;
                context.failure(&key, Some(&error));
            }
        }
        if !wait(scope, POLL_MS).await {
            return;
        }
    }
}
