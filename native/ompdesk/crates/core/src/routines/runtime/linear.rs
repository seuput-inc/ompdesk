//! A bot's Linear connector (`connectors.rs`): every `connector_poll_ms` one read of the workspace with the key
//! Settings › Trackers holds (main hands it per read, `routineAsk` `linear`), for comments and new issues that say the
//! bot's keyword since the last read. Orca reads Linear through its cloud (`bot-linear-copy.ts:64`); this reads it
//! from here, so nothing outside needs to reach this computer.

use serde_json::{Value, json};

use super::{Timing, wait};
use crate::routines::connectors;
use crate::schedules::triggers::Context;
use crate::server::Scope;
use crate::trackers;

/// Ids remembered across reads: a comment made in the same millisecond as the newest one read stays new once.
const SEEN_MAX: usize = 200;

pub(super) async fn run(
    event: &Value,
    mark: Option<Value>,
    context: &Context,
    scope: &Scope,
    timing: Timing,
) {
    let account_id = event["account"].as_str().unwrap_or_default().to_owned();
    let keyword = connectors::keyword(event["handle"].as_str().unwrap_or_default());
    let key = format!("linear {account_id}");
    // The first read starts now: what was asked before the connector was made is not its to answer.
    let mut since = mark
        .as_ref()
        .and_then(|mark| mark["since"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| crate::schedules::rules::iso(trackers::now_ms() as i64));
    let mut seen: Vec<String> = mark
        .as_ref()
        .and_then(|mark| mark["seen"].as_array())
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    loop {
        if scope.cancelled() {
            return;
        }
        let read = async {
            let account = context
                .ask::<trackers::Account>("linear", Some(&account_id))
                .await
                .map_err(|fault| fault.message)?;
            trackers::linear_asks(&account, &keyword, &since)
                .await
                .map_err(|fault| fault.message)
        }
        .await;
        if scope.cancelled() {
            return;
        }
        match read {
            Ok(data) => {
                context.failure(&key, None);
                let asks = connectors::linear_asks(event, &data, &seen);
                for path in ["/comments/nodes", "/issues/nodes"] {
                    for node in data
                        .pointer(path)
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        if let Some(at) = node["createdAt"].as_str()
                            && at > since.as_str()
                        {
                            since = at.to_owned();
                        }
                    }
                }
                seen.extend(asks.iter().map(|ask| ask.id.clone()));
                if seen.len() > SEEN_MAX {
                    seen.drain(..seen.len() - SEEN_MAX);
                }
                let lines: Vec<String> = asks.into_iter().map(|ask| ask.line).collect();
                if !context.publish(json!({ "since": since, "seen": seen }), &lines) {
                    return;
                }
            }
            Err(error) => context.failure(&key, Some(&error)),
        }
        if !wait(scope, timing.connector_poll_ms).await {
            return;
        }
    }
}
