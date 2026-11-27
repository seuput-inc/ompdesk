//! A bot's Slack thread chats and their mirror (Orca `shared/connectors/slack-mirror-state.ts:1-140`,
//! `main/external-conversations/slack-mirror.ts:1-217`): every Slack thread or direct message that asks a bot's Slack
//! connector gets a chat of the bot of its own, kept by (app, channel, root thread ts), never by the ts alone (two
//! channels can hold the same ts). What the owner types in such a chat posts back to its thread as the app, unless
//! the chat is set not to, Slack says the thread is gone or the app is not in the channel, or the thread is a Slack
//! Connect one the owner never turned on. The bot's home chat is no thread's chat, so it never posts (Orca's
//! `slackMirrorAvailable`: the bot's main chat never does).
//!
//! The rows live in the schedules engine (`threads`, by routine); this module is their pure rules and the Slack calls.

use serde_json::{Map, Value, json};

use super::connectors::{self, Target};

type Object = Map<String, Value>;

/// The posts a thread chat keeps, newest first (Orca `SLACK_MIRROR_KEPT_POSTS` keeps 100; the text of each is kept
/// here for Retry, so fewer).
pub(crate) const POSTS_KEPT: usize = 50;
/// The most of a message's text a post keeps for Retry and posts.
pub(crate) const POST_TEXT_MAX: usize = 8_000;
/// What a mirrored message says it is: the owner's words, typed in OMPdesk, posted by the bot's app.
const OWNER_MARK: &str = "_From the bot's owner, in OMPdesk:_";

/// The thread a connector's asked line came from: `<app>:<channel>:<root ts>`, from the reply handle in its header.
pub(crate) fn thread_key(detail: &str) -> Option<String> {
    let (header, _) = connectors::split(detail)?;
    let handle = header.rsplit_once("reply to ")?.1.trim();
    match Target::parse(handle)? {
        Target::Slack {
            account,
            channel,
            thread,
        } => Some(format!("{account}:{channel}:{thread}")),
        _ => None,
    }
}

/// A thread key's parts: app, channel, root ts.
pub(crate) fn place_of(key: &str) -> Option<(&str, &str, &str)> {
    let mut parts = key.splitn(3, ':');
    Some((parts.next()?, parts.next()?, parts.next()?))
}

fn flag(row: &Object, name: &str) -> Option<bool> {
    row.get(name).and_then(Value::as_bool)
}

/// Whether the chat is set to post: on, not blocked, and not a Slack Connect thread the owner never turned on
/// (Orca `slackMirrorMayPost`).
pub(crate) fn may_post(row: &Object) -> bool {
    flag(row, "mirror") != Some(false)
        && !row.contains_key("blocked")
        && (flag(row, "chosen") == Some(true) || flag(row, "external") != Some(true))
}

/// Whether a message posts now: a chat on by default waits until its thread is known not to be Slack Connect, so
/// nothing posts outside the workspace on a guess (Orca `slackMirrorPosts`).
pub(crate) fn posts(row: &Object) -> bool {
    may_post(row) && (flag(row, "chosen") == Some(true) || flag(row, "external") == Some(false))
}

/// What a refusal of Slack's leaves the chat able to do (Orca `slackMirrorBlockOf`).
pub(crate) fn block_of(error: &str) -> Option<&'static str> {
    if error.contains("thread_not_found")
        || error.contains("is_archived")
        || error.contains("channel_not_found")
    {
        Some("thread_unavailable")
    } else if error.contains("not_in_channel") {
        Some("not_in_channel")
    } else {
        None
    }
}

/// The text a message posts as: marked as the owner's, in Slack's mrkdwn.
pub(crate) fn mirror_text(text: &str) -> String {
    format!("{OWNER_MARK}\n{}", connectors::mrkdwn(text.trim()))
}

/// A message's text as a post keeps it.
pub(crate) fn kept_text(text: &str) -> String {
    text.trim().chars().take(POST_TEXT_MAX).collect()
}

/// The posts with `post` set (`None`: removed) under `id`, newest first, at most `POSTS_KEPT`.
pub(crate) fn with_post(row: &mut Object, id: &str, post: Option<Object>) {
    let mut posts: Vec<Value> = row
        .get("posts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let at = posts
        .iter()
        .position(|known| known.get("id").and_then(Value::as_str) == Some(id));
    match (at, post) {
        (Some(at), Some(post)) => posts[at] = Value::Object(post),
        (Some(at), None) => {
            posts.remove(at);
        }
        (None, Some(post)) => posts.insert(0, Value::Object(post)),
        (None, None) => {}
    }
    posts.truncate(POSTS_KEPT);
    row.insert("posts".into(), Value::Array(posts));
}

/// One post of a row.
pub(crate) fn post_of<'a>(row: &'a Object, id: &str) -> Option<&'a Object> {
    row.get("posts")?
        .as_array()?
        .iter()
        .filter_map(Value::as_object)
        .find(|post| post.get("id").and_then(Value::as_str) == Some(id))
}

/// A DM can include a member of another organization. The channel prefix is not evidence of privacy.
pub(crate) async fn external(token: &str, channel: &str) -> Result<bool, String> {
    let query: String = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("channel", channel)
        .finish();
    let method = format!("conversations.info?{query}");
    let info = connectors::slack_request(token, &method, None).await?;
    Ok(requires_external_consent(&info))
}

fn requires_external_consent(info: &Value) -> bool {
    info.pointer("/channel/is_ext_shared")
        .and_then(Value::as_bool)
        != Some(false)
        || info
            .pointer("/channel/is_pending_ext_shared")
            .and_then(Value::as_bool)
            == Some(true)
}

/// Posts the owner's message into the thread; Slack's `ts` of it.
pub(crate) async fn post(
    token: &str,
    channel: &str,
    thread: &str,
    text: &str,
) -> Result<String, String> {
    let reply = connectors::slack_api(
        token,
        "chat.postMessage",
        &json!({ "channel": channel, "thread_ts": thread, "text": mirror_text(text), "unfurl_links": false }),
    )
    .await?;
    Ok(reply
        .get("ts")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned())
}

/// Deletes a posted message from its thread.
pub(crate) async fn unpost(token: &str, channel: &str, ts: &str) -> Result<(), String> {
    match connectors::slack_api(
        token,
        "chat.delete",
        &json!({ "channel": channel, "ts": ts }),
    )
    .await
    {
        Ok(_) => Ok(()),
        // Already gone is what a delete wanted.
        Err(error) if error.contains("message_not_found") => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(value: Value) -> Object {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn a_thread_is_its_app_channel_and_root_ts() {
        let line = connectors::asked(
            "Slack · <#C9> · from <@U1> · reply with ompdesk_bot reply to slack:slack-a/C9/5.1",
            "hi",
        );
        assert_eq!(thread_key(&line).as_deref(), Some("slack-a:C9:5.1"));
        assert_eq!(place_of("slack-a:C9:5.1"), Some(("slack-a", "C9", "5.1")));
        let github = connectors::asked(
            "GitHub · x · reply with ompdesk_bot reply to github:o/r#1",
            "hi",
        );
        assert_eq!(thread_key(&github), None);
        assert_eq!(thread_key("a plain line"), None);
    }

    #[test]
    fn only_a_known_internal_conversation_can_mirror_without_consent() {
        for channel in [
            json!({"id":"D123","is_ext_shared":true}),
            json!({"id":"D123"}),
            json!({"is_ext_shared":false,"is_pending_ext_shared":true}),
        ] {
            assert!(requires_external_consent(&json!({"channel":channel})));
        }
        assert!(!requires_external_consent(&json!({
            "channel":{"is_shared":true,"is_org_shared":true,"is_ext_shared":false}
        })));
    }

    #[test]
    fn a_chat_posts_once_its_thread_is_known_inside_the_workspace() {
        // On by default, waiting on the Slack Connect check.
        let fresh = row(json!({ "key": "a:C:1" }));
        assert!(may_post(&fresh));
        assert!(!posts(&fresh));
        assert!(posts(&row(json!({ "external": false }))));
        // Slack Connect: off until the owner turns it on.
        assert!(!may_post(&row(json!({ "external": true }))));
        assert!(posts(&row(json!({ "external": true, "chosen": true }))));
        // Off, or blocked by Slack.
        assert!(!posts(&row(json!({ "external": false, "mirror": false }))));
        assert!(!posts(&row(
            json!({ "external": false, "blocked": "not_in_channel" })
        )));
        assert_eq!(
            block_of("Slack refused it: thread_not_found"),
            Some("thread_unavailable")
        );
        assert_eq!(
            block_of("Slack refused it: not_in_channel"),
            Some("not_in_channel")
        );
        assert_eq!(block_of("Slack refused it: ratelimited"), None);
    }

    #[test]
    fn posts_keep_the_newest_and_change_in_place() {
        let mut chat = row(json!({}));
        for n in 0..POSTS_KEPT + 3 {
            with_post(
                &mut chat,
                &format!("p{n}"),
                Some(row(json!({ "id": format!("p{n}"), "state": "posting" }))),
            );
        }
        let posts = chat["posts"].as_array().unwrap();
        assert_eq!(posts.len(), POSTS_KEPT);
        assert_eq!(posts[0]["id"], format!("p{}", POSTS_KEPT + 2));
        let newest = format!("p{}", POSTS_KEPT + 2);
        with_post(
            &mut chat,
            &newest,
            Some(row(json!({ "id": newest, "state": "posted" }))),
        );
        assert_eq!(post_of(&chat, &newest).unwrap()["state"], "posted");
        with_post(&mut chat, &newest, None);
        assert!(post_of(&chat, &newest).is_none());
        assert!(mirror_text("**hi** <b>").ends_with("*hi* &lt;b&gt;"));
    }
}
