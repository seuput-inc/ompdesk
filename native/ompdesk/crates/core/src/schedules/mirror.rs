//! A bot's Slack thread chats as main reaches them (`routines/slack_mirror.rs` holds the rules):
//! - `schedules.threadChat {service, run, session}`: the chat main opened for a thread's first ask.
//! - `schedules.mirror {service, session, text, botToken}`: the owner typed `text` in `session`; when it is a thread's
//!   chat set to post, it posts there (after asking Slack, once, whether the thread is a Slack Connect one). Answers
//!   `{posted: bool}`. The bot token comes from main's keystore for this one call and is never kept.
//! - `schedules.mirrorAction {service, id, key, op, post?, on?, botToken?}`: the owner's `set` (the chat's switch),
//!   `retry` and `dismiss` of a failed post, `delete` of a posted one from Slack.
//!
//! After Orca `main/external-conversations/slack-mirror.ts:80-217` (`admitted`, `retry`, `dismiss`, `deleteFromSlack`).

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{RunParams, Service, asked};
use crate::routines::slack_mirror::{self, place_of};
use crate::server::{Call, Fault, Registry, Reply};

type Object = Map<String, Value>;

#[derive(Deserialize)]
struct ThreadChatParams {
    #[serde(flatten)]
    run: RunParams,
    session: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MirrorParams {
    session: String,
    text: String,
    bot_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActionParams {
    id: String,
    key: String,
    op: String,
    #[serde(default)]
    post: Option<String>,
    #[serde(default)]
    on: Option<bool>,
    #[serde(default)]
    bot_token: Option<String>,
}

fn post_row(id: &str, text: &str, state: &str, now: i64) -> Object {
    let mut post = Object::new();
    post.insert("id".into(), id.into());
    post.insert("text".into(), slack_mirror::kept_text(text).into());
    post.insert("state".into(), state.into());
    post.insert("at".into(), crate::schedules::rules::iso(now).into());
    post
}

/// Posts one message of a thread chat and records what became of it; a refusal that leaves the chat unable to post
/// blocks it (Orca `slackMirrorBlockOf`).
async fn send(
    service: &Arc<Service>,
    id: &str,
    key: &str,
    post_id: &str,
    text: &str,
    token: &str,
) -> bool {
    let now = service.at(None);
    let Some((_, channel, thread)) = place_of(key) else {
        return false;
    };
    service.with(|engine| {
        engine.change_thread(id, key, |row| {
            slack_mirror::with_post(row, post_id, Some(post_row(post_id, text, "posting", now)));
        })
    });
    let sent = slack_mirror::post(token, channel, thread, text).await;
    let now = service.at(None);
    let posted = sent.is_ok();
    service.with(|engine| {
        engine.change_thread(id, key, |row| {
            let mut post = post_row(post_id, text, if posted { "posted" } else { "failed" }, now);
            match &sent {
                Ok(ts) => {
                    post.insert("ts".into(), ts.as_str().into());
                }
                Err(error) => {
                    post.insert("error".into(), error.as_str().into());
                    if let Some(blocked) = slack_mirror::block_of(error) {
                        row.insert("blocked".into(), blocked.into());
                    }
                }
            }
            slack_mirror::with_post(row, post_id, Some(post));
        })
    });
    posted
}

async fn mirror(call: Call) -> Result<Reply, Fault> {
    let (service, now, params): (_, _, MirrorParams) = asked(&call)?;
    let found = service.with(|engine| engine.thread_of_session(&params.session));
    let Some((id, row)) = found else {
        return Reply::json(&json!({ "posted": false }));
    };
    let key = row
        .get("key")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if params.text.trim().is_empty() || !slack_mirror::may_post(&row) {
        return Reply::json(&json!({ "posted": false }));
    }
    let mut row = row;
    if row.get("external").and_then(Value::as_bool).is_none() {
        let Some((_, channel, _)) = place_of(&key) else {
            return Reply::json(&json!({ "posted": false }));
        };
        // Unknown is never posted on: a Slack Connect thread reaches people outside the workspace.
        let Ok(external) = slack_mirror::external(&params.bot_token, channel).await else {
            return Reply::json(&json!({ "posted": false }));
        };
        service.with(|engine| {
            engine.change_thread(&id, &key, |row| {
                row.insert("external".into(), external.into());
            })
        });
        row.insert("external".into(), external.into());
    }
    if !slack_mirror::posts(&row) {
        return Reply::json(&json!({ "posted": false }));
    }
    let post_id = format!("post-{now}-{}", super::uuid());
    let posted = send(
        &service,
        &id,
        &key,
        &post_id,
        &params.text,
        &params.bot_token,
    )
    .await;
    Reply::json(&json!({ "posted": posted }))
}

async fn action(call: Call) -> Result<Reply, Fault> {
    let (service, _, params): (_, _, ActionParams) = asked(&call)?;
    let Some(row) = service.with(|engine| engine.thread_row(&params.id, &params.key)) else {
        return Err(Fault::new(
            "schedule_error",
            "That Slack thread's chat is no longer kept",
        ));
    };
    let post = params
        .post
        .as_deref()
        .and_then(|post| slack_mirror::post_of(&row, post))
        .cloned();
    let token = params.bot_token.as_deref().unwrap_or_default();
    match params.op.as_str() {
        "set" => {
            let on = params.on == Some(true);
            service.with(|engine| {
                engine.change_thread(&params.id, &params.key, |row| {
                    row.insert("mirror".into(), on.into());
                    // Turned on by the owner: a Slack Connect thread posts too; a block is cleared to try again.
                    if on {
                        row.insert("chosen".into(), true.into());
                        row.shift_remove("blocked");
                    }
                })
            });
        }
        "retry" => {
            let post = post
                .filter(|post| post.get("state").and_then(Value::as_str) == Some("failed"))
                .ok_or_else(|| Fault::new("schedule_error", "That message did not fail to post"))?;
            let text = post
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let post_id = post
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            service.with(|engine| {
                engine.change_thread(&params.id, &params.key, |row| {
                    row.shift_remove("blocked");
                })
            });
            send(&service, &params.id, &params.key, &post_id, &text, token).await;
        }
        "dismiss" => {
            let post_id = params.post.clone().unwrap_or_default();
            service.with(|engine| {
                engine.change_thread(&params.id, &params.key, |row| {
                    slack_mirror::with_post(row, &post_id, None)
                })
            });
        }
        "delete" => {
            let post = post
                .filter(|post| post.get("state").and_then(Value::as_str) == Some("posted"))
                .ok_or_else(|| Fault::new("schedule_error", "That message is not posted"))?;
            let ts = post.get("ts").and_then(Value::as_str).unwrap_or_default();
            let Some((_, channel, _)) = place_of(&params.key) else {
                return Err(Fault::new(
                    "schedule_error",
                    "That Slack thread's chat is no longer kept",
                ));
            };
            slack_mirror::unpost(token, channel, ts)
                .await
                .map_err(|error| Fault::new("slack_error", error))?;
            let post_id = params.post.clone().unwrap_or_default();
            service.with(|engine| {
                engine.change_thread(&params.id, &params.key, |row| {
                    slack_mirror::with_post(row, &post_id, None)
                })
            });
        }
        _ => return Err(Fault::new("invalid_params", "Unknown mirror action")),
    }
    Reply::json(&service.with(|engine| engine.state()))
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("schedules.threadChat", |call| {
        Box::pin(async move {
            let (service, now, params): (_, _, ThreadChatParams) = asked(&call)?;
            service.with(|engine| engine.thread_chat(&params.run.run, &params.session, now));
            Reply::json(&())
        })
    });
    registry.add("schedules.mirror", |call| Box::pin(mirror(call)));
    registry.add("schedules.mirrorAction", |call| Box::pin(action(call)));
}
