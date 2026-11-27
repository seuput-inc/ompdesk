//! A bot's connectors (the owner's decision of 26 Nov 2026: Orca's Slack, GitHub, Linear and Google connectors on a
//! local route, with the person's own Slack app, `gh`, Linear key and Google client; never Orca Cloud or Composio).
//! A connector is one routine of the bot that wakes its home chat (`BotsRequest` `connect`): Slack's events through
//! Socket Mode or `POST /hooks/<id>`, a GitHub repository and a Linear workspace read on a timer, a Google calendar.
//! This file holds what every connector shares: how an asked event reaches the bot, who may ask, where the bot's
//! answer goes (`ompdesk_bot reply`) and how it is posted there.
//!
//! - **What fired a run is quoted** (FX5, Orca `connector-asker-prompt.ts:272-300`, `automation-event-prompt.ts:121-
//!   137`): a source's line is `header ASKED words`. The header is OMPdesk's own (service, place, who, the reply
//!   handle); the words are someone else's and go inside the run's fence, at most `QUOTED_MAX` characters (Orca's
//!   4096, `automation-event-triggers.ts:243`).
//! - **Who can ask** (FK-B33, Orca `bot-askers.ts:4-24`): `from` lists the people (Slack member ids, GitHub logins,
//!   Linear user ids, e-mails or names); `*` is anyone. A message from anyone else starts nothing.
//! - **Loops** (Orca `trigger-messages.ts:230`, `connector-triggers.ts:65-75`): a Slack event a bot or an app sent, or
//!   an edit, starts nothing; a GitHub or Linear text carrying `REPLY_MARK` is the bot's own answer (it writes as its
//!   owner there, so the author cannot tell).
//! - **Replies** (Orca `bot-preamble.ts:20-23,60-61`): Slack as the bot (its own app), GitHub with the owner's `gh`,
//!   Linear with the owner's key; GitHub and Linear end with the bot's name and `REPLY_MARK`. Orca posts a turn's
//!   final message by itself; here the bot calls `ompdesk_bot reply`, because a woken turn's final text never comes
//!   back through the wake (its quiet `NO_REPLY` turn then simply posts nothing).

use serde_json::{Value, json};

use crate::gh::Gh;
use crate::http::{self, Request};
use crate::run::Opts;
use crate::trackers;

/// Between the header of an asked line and the words it quotes.
pub(crate) const ASKED: char = '\u{1f}';
/// The most of someone's words a run is told.
pub(crate) const QUOTED_MAX: usize = 4096;
/// What every reply posted as the owner ends with, so the trigger that reads it again knows it.
pub(crate) const REPLY_MARK: &str = "via OMPdesk";
/// The most a reply posts (Orca `connector-turn-activity-contract.ts:10`, 32 KiB).
const REPLY_MAX: usize = 32 * 1024;
/// Anyone may ask.
pub(crate) const ANYONE: &str = "*";

/// The words of an asked event, ready for the engine: OMPdesk's header, then someone's words.
pub(crate) fn asked(header: &str, words: &str) -> String {
    // Neither part may carry the separator: words that did would pass the rest off as OMPdesk's header.
    let header = crate::schedules::rules::one_line(&header.replace(ASKED, " "));
    let words: String = words
        .trim()
        .replace(ASKED, " ")
        .chars()
        .take(QUOTED_MAX)
        .collect();
    format!("{header}{ASKED}{words}")
}

/// The header and the words of an asked line; None for any other trigger's line.
pub(crate) fn split(detail: &str) -> Option<(&str, &str)> {
    detail.split_once(ASKED)
}

/// What asks a bot by name in GitHub and Linear text (Orca's label `bot:<handle>`, `bot-linear-copy.ts:64`): words,
/// never an `@`, which GitHub would read as some account's mention.
pub(crate) fn keyword(handle: &str) -> String {
    format!("bot:{}", handle.trim().to_lowercase())
}

/// Whether one of `who` (an id, a login, an e-mail, a name) is among `from`, case aside; `*` lets anyone in.
pub(crate) fn allowed(from: &[String], who: &[&str]) -> bool {
    from.iter().any(|person| {
        let person = person.trim();
        person == ANYONE
            || who
                .iter()
                .any(|known| !known.is_empty() && known.eq_ignore_ascii_case(person))
    })
}

/// The people of an event's `from`.
pub(crate) fn people(event: &Value) -> Vec<String> {
    event
        .get("from")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// Someone not in a connector's `from` who asked the bot (Orca's Request access, `shared/bots/bot-access-request.ts`):
/// the owner allows them (`person` joins `from`) or declines, on the bot's Needs you. What the connector vouches for
/// leads (`person`: a Slack member id, a GitHub login, a Linear e-mail or id); `name` and `place` are only shown.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub(crate) struct AccessAsk {
    pub person: String,
    pub name: String,
    /// Where they asked, in words, and its link when the service has one.
    pub place: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub link: String,
}

// ---- Slack --------------------------------------------------------------------------------------------------------

/// What a Slack event (an `event_callback` body, the same over Socket Mode and HTTP) is to a bot's connector.
#[derive(Debug, PartialEq)]
pub(crate) enum SlackEvent {
    /// Asked: Slack's `event_id` (a retry repeats it) and the line its run is told.
    Asked { id: String, line: String },
    /// Asked by someone not in `from`: nothing runs, the owner is asked to let them in.
    Refused { id: String, ask: AccessAsk },
    /// Not for the bot.
    Passed,
}

/// A mention of the bot in a channel (`app_mention`) or a direct message (`message` in an `im`), from someone in
/// `from`; nothing a bot or an app sent, no edit or deletion (Orca `bot-slack-copy.ts:65`).
pub(crate) fn slack_event(event: &Value, body: &Value) -> SlackEvent {
    let account = event
        .get("account")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let text = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    if text(body, "type") != "event_callback" {
        return SlackEvent::Passed;
    }
    let Some(said) = body.get("event") else {
        return SlackEvent::Passed;
    };
    let kind = text(said, "type");
    let direct = kind == "message" && text(said, "channel_type") == "im";
    if (kind != "app_mention" && !direct)
        || said.get("bot_id").is_some()
        || said.get("subtype").is_some()
    {
        return SlackEvent::Passed;
    }
    let (user, channel, ts) = (text(said, "user"), text(said, "channel"), text(said, "ts"));
    let id = text(body, "event_id");
    if user.is_empty() || channel.is_empty() || ts.is_empty() || id.is_empty() {
        return SlackEvent::Passed;
    }
    if !allowed(&people(event), &[&user]) {
        let team = text(body, "team_id");
        return SlackEvent::Refused {
            id,
            ask: AccessAsk {
                person: user.clone(),
                name: user,
                place: if direct {
                    "Slack, a direct message".to_owned()
                } else {
                    format!("Slack, a mention in channel {channel}")
                },
                link: if team.is_empty() {
                    String::new()
                } else {
                    format!("https://app.slack.com/client/{team}/{channel}")
                },
            },
        };
    }
    // A mention's text starts with the bot's own `<@U…>`; the rest is what was asked.
    let words = text(said, "text");
    let words = match words.trim_start().strip_prefix("<@") {
        Some(rest) => rest.split_once('>').map_or("", |(_, rest)| rest).trim(),
        None => words.trim(),
    };
    let thread = Some(text(said, "thread_ts"))
        .filter(|thread| !thread.is_empty())
        .unwrap_or_else(|| ts.clone());
    let place = if direct {
        "a direct message".to_owned()
    } else {
        format!("<#{channel}>")
    };
    let target = Target::Slack {
        account: account.to_owned(),
        channel,
        thread,
    };
    let header = format!(
        "Slack · {place} · from <@{user}> · reply with ompdesk_bot reply to {}",
        target.handle()
    );
    SlackEvent::Asked {
        id,
        line: asked(&header, words),
    }
}

// ---- Linear -------------------------------------------------------------------------------------------------------

/// One ask a Linear read found: its id, when it was made (ISO) and the line its run is told.
#[derive(Debug, PartialEq)]
pub(crate) struct LinearAsk {
    pub id: String,
    pub at: String,
    pub line: String,
}

/// What one Linear read found: the asks to run, oldest first, and who asked without being in `from`.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct LinearRead {
    pub asks: Vec<LinearAsk>,
    pub refused: Vec<AccessAsk>,
}

/// The new asks of one Linear read (`trackers::linear_asks`: comments and new issues holding the bot's keyword), from
/// someone in `from` (`me` is the key's owner), oldest first; ids in `seen` and the bot's own replies are passed over.
/// Who wrote it, the issue's title and the text are someone's words; identifiers, links and the handle are Linear's.
pub(crate) fn linear_asks(event: &Value, data: &Value, seen: &[String]) -> LinearRead {
    let text = |value: &Value, path: &str| {
        value
            .pointer(path)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let account = text(event, "/account");
    let from = people(event);
    let viewer = text(data, "/viewer/id");
    let nodes = |path: &str| {
        data.pointer(path)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let may_ask = |person: Option<&Value>| {
        let Some(person) = person else {
            return false;
        };
        let id = text(person, "/id");
        let me = if !id.is_empty() && id == viewer {
            "me"
        } else {
            ""
        };
        let (email, name, shown) = (
            text(person, "/email"),
            text(person, "/name"),
            text(person, "/displayName"),
        );
        allowed(&from, &[&id, me, &email, &name, &shown])
    };
    let name = |person: Option<&Value>| {
        person
            .map(|person| text(person, "/name"))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "someone".to_owned())
    };
    // Linear's e-mail leads: a name or a display name can be edited and repeated (Orca `accessRequestIdentity`).
    let refusal = |person: Option<&Value>, place: String, link: String| {
        let person = person?;
        let email = text(person, "/email");
        let id = text(person, "/id");
        let vouched = if email.is_empty() { id } else { email };
        (!vouched.is_empty()).then(|| AccessAsk {
            person: vouched,
            name: name(Some(person)),
            place,
            link,
        })
    };
    let mut asks = Vec::new();
    let mut refused = Vec::new();
    for comment in nodes("/comments/nodes") {
        let (id, body) = (text(&comment, "/id"), text(&comment, "/body"));
        let issue = text(&comment, "/issue/id");
        if id.is_empty() || issue.is_empty() || seen.contains(&id) || body.contains(REPLY_MARK) {
            continue;
        }
        if !may_ask(comment.get("user")) {
            refused.extend(refusal(
                comment.get("user"),
                format!(
                    "Linear, a comment on {}",
                    text(&comment, "/issue/identifier")
                ),
                text(&comment, "/url"),
            ));
            continue;
        }
        let target = Target::Linear {
            account: account.clone(),
            issue,
        };
        let header = format!(
            "Linear · a comment on {} · {} · reply with ompdesk_bot reply to {}",
            text(&comment, "/issue/identifier"),
            text(&comment, "/url"),
            target.handle()
        );
        let words = format!(
            "From: {}\nIssue: {}\n\n{body}",
            name(comment.get("user")),
            text(&comment, "/issue/title")
        );
        asks.push(LinearAsk {
            at: text(&comment, "/createdAt"),
            line: asked(&header, &words),
            id,
        });
    }
    for issue in nodes("/issues/nodes") {
        let (id, body) = (text(&issue, "/id"), text(&issue, "/description"));
        if id.is_empty() || seen.contains(&id) || body.contains(REPLY_MARK) {
            continue;
        }
        if !may_ask(issue.get("creator")) {
            refused.extend(refusal(
                issue.get("creator"),
                format!("Linear, the new issue {}", text(&issue, "/identifier")),
                text(&issue, "/url"),
            ));
            continue;
        }
        let target = Target::Linear {
            account: account.clone(),
            issue: id.clone(),
        };
        let header = format!(
            "Linear · a new issue {} · {} · reply with ompdesk_bot reply to {}",
            text(&issue, "/identifier"),
            text(&issue, "/url"),
            target.handle()
        );
        let words = format!(
            "From: {}\nIssue: {}\n\n{body}",
            name(issue.get("creator")),
            text(&issue, "/title")
        );
        asks.push(LinearAsk {
            at: text(&issue, "/createdAt"),
            line: asked(&header, &words),
            id,
        });
    }
    asks.sort_by(|a, b| a.at.cmp(&b.at));
    LinearRead { asks, refused }
}

// ---- where a reply goes -------------------------------------------------------------------------------------------

/// Where a bot's reply goes, as its `to` names it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Target {
    /// `slack:<account>/<channel>/<thread ts>`.
    Slack {
        account: String,
        channel: String,
        thread: String,
    },
    /// `github:<owner>/<name>#<number>`.
    Github { repo: String, number: u64 },
    /// `linear:<account>/<issue id>`.
    Linear { account: String, issue: String },
}

fn plain(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

impl Target {
    pub fn parse(to: &str) -> Option<Target> {
        let (via, rest) = to.trim().split_once(':')?;
        match via {
            "slack" => {
                let mut parts = rest.splitn(3, '/');
                let (account, channel, thread) = (parts.next()?, parts.next()?, parts.next()?);
                (plain(account) && plain(channel) && plain(thread)).then(|| Target::Slack {
                    account: account.to_owned(),
                    channel: channel.to_owned(),
                    thread: thread.to_owned(),
                })
            }
            "github" => {
                let (repo, number) = rest.rsplit_once('#')?;
                let (owner, name) = repo.split_once('/')?;
                (plain(owner) && plain(name)).then_some(())?;
                Some(Target::Github {
                    repo: repo.to_owned(),
                    number: number.parse().ok().filter(|number| *number > 0)?,
                })
            }
            "linear" => {
                let (account, issue) = rest.split_once('/')?;
                (plain(account) && plain(issue)).then(|| Target::Linear {
                    account: account.to_owned(),
                    issue: issue.to_owned(),
                })
            }
            _ => None,
        }
    }

    pub fn handle(&self) -> String {
        match self {
            Target::Slack {
                account,
                channel,
                thread,
            } => format!("slack:{account}/{channel}/{thread}"),
            Target::Github { repo, number } => format!("github:{repo}#{number}"),
            Target::Linear { account, issue } => format!("linear:{account}/{issue}"),
        }
    }

    /// The service, as an event's `source` names it.
    pub fn source(&self) -> &'static str {
        match self {
            Target::Slack { .. } => "slack",
            Target::Github { .. } => "github",
            Target::Linear { .. } => "linear",
        }
    }

    /// Whether a connector routine's event (`frequency.event`) is the one this reply answers through: the same
    /// Slack app or Linear account, or the same repository asked by keyword.
    pub fn answers_through(&self, event: &Value) -> bool {
        let text = |key: &str| event.get(key).and_then(Value::as_str).unwrap_or_default();
        if text("source") != self.source() {
            return false;
        }
        match self {
            Target::Slack { account, .. } | Target::Linear { account, .. } => {
                text("account") == account
            }
            Target::Github { repo, .. } => {
                text("repo").eq_ignore_ascii_case(repo) && !text("ask").is_empty()
            }
        }
    }
}

/// A reply as it is posted: bounded, and on GitHub and Linear signed with the bot's name and `REPLY_MARK`.
pub(crate) fn reply_text(target: &Target, text: &str, bot: &str) -> String {
    let mut text: String = text.trim().to_owned();
    if text.len() > REPLY_MAX {
        let mut end = REPLY_MAX;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push('…');
    }
    match target {
        Target::Slack { .. } => mrkdwn(&text),
        _ => format!("{text}\n\n— {bot}, {REPLY_MARK}"),
    }
}

/// Markdown as Slack's mrkdwn reads it: `&`, `<` and `>` escaped, `**bold**` and `__bold__` as `*bold*`, `~~x~~` as
/// `~x~`, `[words](url)` as `<url|words>`, a heading as a bold line. Code spans and blocks keep their text.
pub(crate) fn mrkdwn(text: &str) -> String {
    let mut out = Vec::new();
    let mut fenced = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            out.push(line.to_owned());
            continue;
        }
        if fenced {
            out.push(escape(line));
            continue;
        }
        let trimmed = line.trim_start();
        let heading = trimmed
            .strip_prefix('#')
            .map(|rest| rest.trim_start_matches('#'));
        match heading.filter(|rest| rest.starts_with(' ')) {
            Some(rest) => out.push(format!("*{}*", inline(rest.trim()))),
            None => out.push(inline(line)),
        }
    }
    out.join("\n")
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// One line's inline marks; a code span is left as it is (escaped).
fn inline(line: &str) -> String {
    let mut out = String::new();
    for (index, part) in line.split('`').enumerate() {
        if index > 0 {
            out.push('`');
        }
        if index % 2 == 1 {
            out.push_str(&escape(part));
            continue;
        }
        out.push_str(&links(
            &escape(part)
                .replace("**", "*")
                .replace("__", "*")
                .replace("~~", "~"),
        ));
    }
    out
}

/// `[words](url)` as `<url|words>`.
fn links(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        let Some((words, tail)) = after.split_once("](") else {
            break;
        };
        let Some((url, tail)) = tail.split_once(')') else {
            break;
        };
        if words.contains('[') || !(url.starts_with("http://") || url.starts_with("https://")) {
            out.push_str(&rest[..=open]);
            rest = after;
            continue;
        }
        out.push_str(&rest[..open]);
        out.push_str(&format!("<{}|{words}>", url.replace("&amp;", "&")));
        rest = tail;
    }
    out.push_str(rest);
    out
}

// ---- posting ------------------------------------------------------------------------------------------------------

/// Slack's Web API: one `POST` with the bot's token; its `ok`, else its error code.
pub(crate) async fn slack_api(token: &str, method: &str, body: &Value) -> Result<Value, String> {
    let body = serde_json::to_vec(body).map_err(|error| error.to_string())?;
    slack_request(token, method, Some(&body)).await
}

/// Slack supports JSON for write methods; reads use a GET with query parameters.
pub(super) async fn slack_request(
    token: &str,
    method: &str,
    body: Option<&[u8]>,
) -> Result<Value, String> {
    let url = format!("https://slack.com/api/{method}");
    let bearer = format!("Bearer {token}");
    let answer = http::send(Request {
        url: &url,
        headers: &[
            ("authorization", bearer.as_str()),
            ("content-type", "application/json; charset=utf-8"),
        ],
        body,
        proxy: None,
    })
    .await
    .map_err(|failure| format!("Slack did not answer ({failure:?})"))?;
    let reply: Value = serde_json::from_slice(&answer.body).unwrap_or(Value::Null);
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(reply)
    } else {
        let error = reply
            .get("error")
            .and_then(Value::as_str)
            .map_or_else(|| format!("HTTP {}", answer.status), str::to_owned);
        Err(format!("Slack refused it: {error}"))
    }
}

/// A message in the thread (or as the start of one when `thread` is the message's own ts).
pub(crate) async fn post_slack(
    token: &str,
    channel: &str,
    thread: &str,
    text: &str,
) -> Result<(), String> {
    slack_api(
        token,
        "chat.postMessage",
        &json!({ "channel": channel, "thread_ts": thread, "text": text, "unfurl_links": false }),
    )
    .await
    .map(|_| ())
}

/// A comment on the issue or pull request, with the owner's `gh` (the body on stdin, never on the command line).
pub(crate) async fn post_github(
    gh: &Gh,
    home: &str,
    repo: &str,
    number: u64,
    text: &str,
) -> Result<(), String> {
    let endpoint = format!("repos/{repo}/issues/{number}/comments");
    let input = serde_json::to_vec(&json!({ "body": text })).map_err(|error| error.to_string())?;
    let opts = Opts {
        timeout_ms: Some(30_000),
        input: Some(&input),
        ..Opts::default()
    };
    gh.call(
        home,
        &["api", &endpoint, "--method", "POST", "--input", "-"],
        opts,
    )
    .await
    .map(|_| ())
    .map_err(|fault| gh.scrub(fault.message))
}

/// A comment on the Linear issue, with the owner's key.
pub(crate) async fn post_linear(
    account: &trackers::Account,
    issue: &str,
    text: &str,
) -> Result<(), String> {
    trackers::linear_comment(account, issue, text)
        .await
        .map_err(|fault| fault.message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slack(event: Value) -> Value {
        json!({ "type": "event_callback", "event_id": "Ev1", "event": event })
    }

    #[test]
    fn a_mention_from_someone_who_may_ask_is_quoted_with_where_to_reply() {
        let routine = json!({ "source": "slack", "account": "slack-a", "from": ["U1"] });
        let body = slack(json!({
            "type": "app_mention", "user": "U1", "channel": "C9", "ts": "17.5",
            "text": "<@UBOT> summarize ```this``` thread"
        }));
        let SlackEvent::Asked { id, line } = slack_event(&routine, &body) else {
            panic!("asked");
        };
        assert_eq!(id, "Ev1");
        let (header, words) = split(&line).expect("asked line");
        assert_eq!(
            header,
            "Slack · <#C9> · from <@U1> · reply with ompdesk_bot reply to slack:slack-a/C9/17.5"
        );
        assert_eq!(words, "summarize ```this``` thread");
    }

    #[test]
    fn only_the_people_listed_ask_and_never_a_bot_or_an_edit() {
        let routine = json!({ "source": "slack", "account": "a", "from": ["U1"] });
        let mut stranger =
            slack(json!({ "type": "app_mention", "user": "U2", "channel": "C", "ts": "1" }));
        stranger["team_id"] = json!("T1");
        // Someone not listed runs nothing; the owner is asked to let them in.
        assert_eq!(
            slack_event(&routine, &stranger),
            SlackEvent::Refused {
                id: "Ev1".into(),
                ask: AccessAsk {
                    person: "U2".into(),
                    name: "U2".into(),
                    place: "Slack, a mention in channel C".into(),
                    link: "https://app.slack.com/client/T1/C".into(),
                },
            }
        );
        let bot = slack(
            json!({ "type": "message", "channel_type": "im", "user": "U1", "bot_id": "B", "channel": "D", "ts": "1" }),
        );
        assert_eq!(slack_event(&routine, &bot), SlackEvent::Passed);
        let edit = slack(
            json!({ "type": "message", "channel_type": "im", "subtype": "message_changed", "channel": "D", "ts": "1" }),
        );
        assert_eq!(slack_event(&routine, &edit), SlackEvent::Passed);
        let channel_chatter = slack(
            json!({ "type": "message", "channel_type": "channel", "user": "U1", "channel": "C", "ts": "1" }),
        );
        assert_eq!(slack_event(&routine, &channel_chatter), SlackEvent::Passed);
        let anyone = json!({ "source": "slack", "account": "a", "from": ["*"] });
        let direct = slack(
            json!({ "type": "message", "channel_type": "im", "user": "U2", "channel": "D1", "ts": "3", "thread_ts": "2", "text": "hi" }),
        );
        let SlackEvent::Asked { line, .. } = slack_event(&anyone, &direct) else {
            panic!("asked");
        };
        assert!(line.contains("a direct message"), "{line}");
        assert!(line.contains("slack:a/D1/2"), "{line}");
    }

    #[test]
    fn a_reply_handle_reads_back_and_names_its_routine() {
        for to in [
            "slack:slack-a/C9/17.5",
            "github:owner/repo.js#12",
            "linear:linear-abc/9f1c-22",
        ] {
            assert_eq!(Target::parse(to).map(|t| t.handle()).as_deref(), Some(to));
        }
        for bad in [
            "slack:a/C9",
            "github:owner#1",
            "github:o/r#0",
            "linear:a",
            "mail:x/y",
            "slack:a/C 9/1",
        ] {
            assert_eq!(Target::parse(bad), None, "{bad}");
        }
        let github = Target::parse("github:Owner/Repo#3").expect("github");
        assert!(
            github.answers_through(&json!({"source":"github","repo":"owner/repo","ask":"helper"}))
        );
        assert!(!github.answers_through(&json!({"source":"github","repo":"owner/repo"})));
        let slack = Target::parse("slack:a/C/1").expect("slack");
        assert!(slack.answers_through(&json!({"source":"slack","account":"a"})));
        assert!(!slack.answers_through(&json!({"source":"slack","account":"b"})));
    }

    #[test]
    fn markdown_reads_as_slack_mrkdwn() {
        assert_eq!(
            mrkdwn(
                "# Done\n**bold** and [the PR](https://x.test/a?b=1&c=2) <tag>\n```\na<b\n```\n`x**y`"
            ),
            "*Done*\n*bold* and <https://x.test/a?b=1&c=2|the PR> &lt;tag&gt;\n```\na&lt;b\n```\n`x**y`"
        );
    }

    #[test]
    fn a_reply_as_the_owner_is_signed_and_read_as_the_bots_own() {
        let github = Target::Github {
            repo: "o/r".into(),
            number: 1,
        };
        let text = reply_text(&github, "On it.", "Helper");
        assert_eq!(text, "On it.\n\n— Helper, via OMPdesk");
        assert!(text.contains(REPLY_MARK));
    }

    #[test]
    fn who_may_ask_is_matched_case_aside_and_star_is_anyone() {
        assert!(allowed(&["Octo".into()], &["octo"]));
        assert!(!allowed(&["octo".into()], &["someone", ""]));
        assert!(allowed(&["*".into()], &["anyone"]));
        assert!(!allowed(&[], &["anyone"]));
    }

    #[test]
    fn linear_asks_are_new_from_someone_who_may_ask_and_never_the_bots_own() {
        let routine = json!({ "source": "linear", "account": "linear-a", "handle": "helper", "from": ["me", "ana@x.test"] });
        let person =
            |id: &str, email: &str| json!({ "id": id, "name": format!("N{id}"), "email": email });
        let data = json!({
            "viewer": { "id": "V" },
            "comments": { "nodes": [
                { "id": "c2", "body": "bot:helper look", "createdAt": "2026-11-26T10:02:00.000Z", "url": "https://linear.app/c2",
                  "user": person("V", "own@x.test"), "issue": { "id": "i1", "identifier": "ENG-1", "title": "Crash" } },
                { "id": "c1", "body": "bot:helper first", "createdAt": "2026-11-26T10:01:00.000Z", "url": "https://linear.app/c1",
                  "user": person("A", "Ana@x.test"), "issue": { "id": "i1", "identifier": "ENG-1", "title": "Crash" } },
                { "id": "c3", "body": "stranger bot:helper", "createdAt": "2026-11-26T10:03:00.000Z",
                  "user": person("S", "s@x.test"), "issue": { "id": "i1" } },
                { "id": "c4", "body": "Done.\n\n— Helper, via OMPdesk bot:helper", "createdAt": "2026-11-26T10:04:00.000Z",
                  "user": person("V", ""), "issue": { "id": "i1" } },
                { "id": "c0", "body": "bot:helper seen", "createdAt": "2026-11-26T10:00:00.000Z",
                  "user": person("V", ""), "issue": { "id": "i1" } }
            ] },
            "issues": { "nodes": [
                { "id": "i2", "identifier": "ENG-2", "title": "New", "description": "bot:helper do it", "createdAt": "2026-11-26T10:05:00.000Z",
                  "url": "https://linear.app/i2", "creator": person("V", "") }
            ] }
        });
        let read = linear_asks(&routine, &data, &["c0".to_owned()]);
        let asks = &read.asks;
        let ids: Vec<&str> = asks.iter().map(|ask| ask.id.as_str()).collect();
        assert_eq!(ids, ["c1", "c2", "i2"]);
        let (header, words) = split(&asks[0].line).expect("asked");
        assert_eq!(
            header,
            "Linear · a comment on ENG-1 · https://linear.app/c1 · reply with ompdesk_bot reply to linear:linear-a/i1"
        );
        assert_eq!(words, "From: NA\nIssue: Crash\n\nbot:helper first");
        assert!(asks[2].line.contains("linear:linear-a/i2"));
        // The stranger asks to be let in, by the e-mail Linear vouches for; the bot's own reply asks nothing.
        assert_eq!(
            read.refused,
            [AccessAsk {
                person: "s@x.test".into(),
                name: "NS".into(),
                place: "Linear, a comment on ".into(),
                link: String::new(),
            }]
        );
    }
}
