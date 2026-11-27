//! A session's question routed to the bot whose request its run served: who gets the card, who may answer it, and
//! when it stays with the owner.

use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::AskOrigin;
use crate::agentctl::journal::bots::BotRecord;
use crate::agentctl::journal::system_clock;
use crate::agentctl::service::host::{Caps, HostState};
use crate::agentctl::service::tuning::Tuning;
use crate::agentctl::service::{AgentControl, Files};
use crate::ports::Port;

type Asked = Arc<Mutex<Vec<(String, Value)>>>;

const CHAT: &str = "/s/1_chat.jsonl";
const FORM: &str = "<form><p>Which one?</p><input type=radio name=pick value=a>A<input type=radio name=pick value=b>B</form>";

fn rig(
    id: u64,
    state: Value,
    reply: impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static,
) -> (AgentControl, Asked) {
    let (writer, reader) = tokio::io::duplex(1 << 20);
    let (tx, _task) = crate::wire::spawn_writer(writer);
    let events = crate::server::test_events(&tx);
    std::mem::forget(tx);
    let port =
        Port::<HostState>::open(&events, id, serde_json::from_value(state).unwrap()).unwrap();
    let asked: Asked = Arc::default();
    let record = asked.clone();
    let answers = port.clone();
    let mut lines = BufReader::new(reader).lines();
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            let event: Value = serde_json::from_str(&line).unwrap();
            let data = &event["data"];
            let method = data["method"].as_str().unwrap_or("").to_owned();
            let args = data["args"].clone();
            record.lock().unwrap().push((method.clone(), args.clone()));
            if let Some(ask) = data["ask"].as_u64() {
                match reply(&method, &args) {
                    Ok(value) => crate::ports::apply_answer(&answers, ask, Ok(&value.to_string())),
                    Err(message) => {
                        crate::ports::apply_answer(&answers, ask, Err((&message, None)))
                    }
                }
            }
        }
    });
    let control = AgentControl::new(
        port,
        Caps::default(),
        &Files::default(),
        Tuning::default(),
        system_clock(),
    );
    (control, asked)
}

/// Main as these tests need it: the bot's chat is reached at once, the asking session's bridge projects the one-field
/// form and takes "A" or "B" for it.
fn main_replies(method: &str, args: &Value) -> Result<Value, String> {
    match method {
        "args.parse" => Ok(json!({ "ok": true, "args": args["args"] })),
        "reach" => Ok(json!("chat")),
        "command" => match args["command"]["type"].as_str() {
            Some("project_ask_form") => match args["command"]["answers"].as_array() {
                None => Ok(json!({ "success": true, "data": { "questions": [
                    { "id": "field-0", "question": "Which one?", "options": [{ "label": "A" }, { "label": "B" }] }
                ] } })),
                Some(answers) => {
                    let picked = answers[0]["selectedOptions"][0].as_str().unwrap_or("");
                    Ok(
                        json!({ "success": true, "data": { "data": { "pick": picked.to_lowercase() } } }),
                    )
                }
            },
            Some("get_state") => Ok(json!({ "success": true, "data": { "isStreaming": false } })),
            _ => Ok(json!({ "success": true, "data": {} })),
        },
        "mail" | "answer" | "markAnswered" => Ok(Value::Null),
        "escalateAsk" => Ok(json!(true)),
        other => Err(format!("fake main has no {other}")),
    }
}

fn tab(id: &str, path: &str) -> Value {
    json!({ "tabId": id, "title": id, "cwd": "/w", "status": "ready", "busy": false, "asks": [], "hidden": false, "sessionPath": path })
}

/// The worker `work` (opened by `boss`) waits on `asks`; `chat` is the bot Ada's chat, `other` an agent of nobody's.
fn world(asks: Value) -> Value {
    let mut work = tab("work", "/s/1_work.jsonl");
    work["asks"] = asks;
    let tabs = vec![
        tab("boss", "/s/1_boss.jsonl"),
        tab("chat", CHAT),
        tab("other", "/s/1_other.jsonl"),
        work,
    ];
    let windows: Map<String, Value> = tabs
        .iter()
        .map(|tab| (tab["tabId"].as_str().unwrap().to_owned(), json!("w")))
        .collect();
    json!({
        "enabled": true,
        "approveEnabled": true,
        "tabs": tabs,
        "windowOf": windows,
        "parents": { "work": { "callerTabId": "boss" } },
    })
}

fn form(id: &str) -> Value {
    json!({ "id": id, "request": { "id": id, "method": "form", "html": FORM } })
}

fn confirm(id: &str) -> Value {
    json!({ "id": id, "request": { "id": id, "method": "confirm", "title": "Go on?" } })
}

fn ada(control: &AgentControl, paused: bool) {
    control.bots().add(BotRecord {
        id: "bot-ada".into(),
        name: "Ada".into(),
        folder: "/bots/ada".into(),
        home: Some(CHAT.into()),
        sessions: vec![CHAT.into()],
        paused,
        ..BotRecord::default()
    });
}

fn origin() -> AskOrigin {
    AskOrigin {
        session: "chat".into(),
        mark: Some("m-1".into()),
    }
}

fn asked_with(asked: &Asked, method: &str) -> Vec<Value> {
    asked
        .lock()
        .unwrap()
        .iter()
        .filter(|(name, _)| name == method)
        .map(|(_, args)| args.clone())
        .collect()
}

async fn answer(control: &AgentControl, caller: &str, args: Value) -> (String, bool) {
    let outcome = control
        .run(caller, "ompdesk_session_answer", args, None)
        .await;
    (outcome.text, outcome.is_error)
}

#[tokio::test]
async fn a_form_raised_for_a_bot_s_request_goes_to_that_bot_which_alone_answers_it() {
    let (control, asked) = rig(9_901, world(json!([form("r1")])), main_replies);
    ada(&control, false);
    assert_eq!(
        control.route_ask("work", "r1", &origin()).await.as_deref(),
        Some(CHAT)
    );
    control.child_asked("boss", "work", "r1").await.unwrap();
    let mails = asked_with(&asked, "mail");
    assert_eq!(mails.len(), 1, "one card, to the bot's chat only");
    assert_eq!(mails[0]["tabId"], "chat");
    assert_eq!(mails[0]["details"]["kind"], "question");
    let content = mails[0]["content"].as_str().unwrap();
    assert!(
        content.contains("[field-0] Which one?")
            && content.contains("\"A\" | \"B\"")
            && content.contains("\"request\": \"r1\"")
            && content.contains("escalate"),
        "{content}"
    );
    // Any other agent, the opener included, keeps today's refusal of a form, and cannot take the bot's card.
    let (text, is_error) = answer(
        &control,
        "boss",
        json!({ "session": "work", "request": "r1", "answers": [{ "id": "field-0", "selected": ["A"] }] }),
    )
    .await;
    assert!(
        is_error && text.contains("only that bot answers it"),
        "{text}"
    );
    let (text, is_error) = answer(&control, "other", json!({ "session": "work" })).await;
    assert!(
        is_error && text.contains("raised for a bot's request"),
        "{text}"
    );
    // The bot names the card.
    let (text, is_error) = answer(
        &control,
        "chat",
        json!({ "session": "work", "answers": [{ "id": "field-0", "selected": ["A"] }] }),
    )
    .await;
    assert!(is_error && text.starts_with("Name the card"), "{text}");
    let (text, is_error) = answer(
        &control,
        "chat",
        json!({ "session": "work", "request": "r1", "answers": [{ "id": "wrong-field", "selected": ["A"] }] }),
    )
    .await;
    assert!(is_error && text.contains("Missing answer for field"), "{text}");
    assert!(asked_with(&asked, "answer").is_empty());
    let (text, is_error) = answer(
        &control,
        "chat",
        json!({ "session": "work", "request": "r1", "answers": [{ "id": "field-0", "selected": ["a"] }] }),
    )
    .await;
    assert!(!is_error, "{text}");
    let answers = asked_with(&asked, "answer");
    assert_eq!(answers.len(), 1);
    assert_eq!(
        answers[0]["response"],
        json!({ "type": "extension_ui_response", "id": "r1", "data": { "pick": "a" } })
    );
    // Its own answer closing the card is not told back to it.
    control.routed_ask_closed("work", "r1", Some("A")).await;
    assert_eq!(asked_with(&asked, "mail").len(), 1);
    control.host.port().close();
}

#[tokio::test]
async fn a_late_bot_answer_is_refused_and_never_answers_the_owner_s_next_card_or_a_plan() {
    let (control, asked) = rig(9_902, world(json!([form("r1")])), main_replies);
    ada(&control, false);
    assert!(control.route_ask("work", "r1", &origin()).await.is_some());
    // The card closed (the owner's own work moved on); the owner's next card and a plan wait now.
    control.routed_ask_closed("work", "r1", None).await;
    let notes: Vec<Value> = asked_with(&asked, "mail")
        .into_iter()
        .filter(|mail| mail["details"]["kind"] == "note")
        .collect();
    assert_eq!(notes.len(), 1, "the bot hears the card went, once");
    let mut next = world(json!([confirm("r2")]));
    next["tabs"][3]["plan"] = json!({ "title": "Plan", "planFilePath": "/p.md", "generation": 1 });
    crate::ports::apply_state(control.host.port(), 1, &next.to_string()).unwrap();
    for args in [
        json!({ "session": "work", "request": "r1", "approve": true }),
        json!({ "session": "work", "approve": true }),
        json!({ "session": "work", "request": "r2", "approve": true }),
    ] {
        let (text, is_error) = answer(&control, "chat", args).await;
        assert!(is_error, "{text}");
    }
    assert!(asked_with(&asked, "answer").is_empty());
    assert!(
        asked_with(&asked, "command")
            .iter()
            .all(|args| args["command"]["type"] != "plan_approval")
    );
    // The owner's agents keep today's answer to the owner's card.
    let (text, is_error) = answer(
        &control,
        "boss",
        json!({ "session": "work", "request": "r2", "approve": true }),
    )
    .await;
    assert!(!is_error, "{text}");
    control.host.port().close();
}

#[tokio::test]
async fn an_attributed_first_goal_prompt_needs_no_dispatch_number() {
    let (control, asked) = rig(9_909, world(json!([form("goal-form")])), main_replies);
    ada(&control, false);
    let sender = AskOrigin { mark: None, ..origin() };
    assert_eq!(control.route_ask("work", "goal-form", &sender).await.as_deref(), Some(CHAT));
    assert_eq!(asked_with(&asked, "mail")[0]["tabId"], "chat");
    control.host.port().close();
}

#[tokio::test]
async fn pausing_or_deleting_the_bot_returns_its_open_form_to_the_owner() {
    for (id, deleting) in [(9_910, false), (9_911, true)] {
        let (control, asked) = rig(id, world(json!([form("r1")])), main_replies);
        ada(&control, false);
        assert_eq!(control.route_ask("work", "r1", &origin()).await.as_deref(), Some(CHAT));
        if deleting {
            control.delete_bot("bot-ada").await.unwrap();
        } else {
            control.set_paused("bot-ada", true).await.unwrap();
        }
        let returned = asked_with(&asked, "escalateAsk");
        assert_eq!(returned.len(), 1);
        assert_eq!(returned[0]["tabId"], "work");
        assert!(returned[0]["chatTabId"].is_null());
        let (_, refused) = answer(
            &control, "chat", json!({ "session": "work", "request": "r1", "choice": "A" })
        ).await;
        assert!(refused && asked_with(&asked, "answer").is_empty());
        control.host.port().close();
    }
}

#[tokio::test]
async fn the_card_stays_with_the_owner_when_the_bot_is_paused_deleted_or_unreachable_or_the_run_is_the_owner_s()
 {
    // Paused.
    let (control, asked) = rig(9_903, world(json!([form("r1")])), main_replies);
    ada(&control, true);
    assert_eq!(control.route_ask("work", "r1", &origin()).await, None);
    assert!(asked_with(&asked, "mail").is_empty());
    control.host.port().close();
    // No bot has that chat (deleted, or another session's message).
    let (control, asked) = rig(9_904, world(json!([form("r1")])), main_replies);
    assert_eq!(control.route_ask("work", "r1", &origin()).await, None);
    assert!(asked_with(&asked, "mail").is_empty());
    control.host.port().close();
    // Its chat cannot start.
    let (control, asked) = rig(9_905, world(json!([form("r1")])), |method, args| {
        if method == "reach" {
            Err("no window".to_owned())
        } else {
            main_replies(method, args)
        }
    });
    ada(&control, false);
    assert_eq!(control.route_ask("work", "r1", &origin()).await, None);
    assert!(asked_with(&asked, "mail").is_empty());
    // Without a route even the bot may not answer the owner's form.
    let (text, is_error) = answer(
        &control,
        "chat",
        json!({ "session": "work", "approve": true }),
    )
    .await;
    assert!(is_error && text.contains("not a question an agent can answer"), "{text}");
    control.host.port().close();
    // A tool approval is never routed.
    let approval = json!({ "id": "r1", "request": { "id": "r1", "method": "select", "title": "Allow tool: bash", "options": ["Approve", "Deny"] } });
    let (control, asked) = rig(9_906, world(json!([approval])), main_replies);
    ada(&control, false);
    assert_eq!(control.route_ask("work", "r1", &origin()).await, None);
    assert!(asked_with(&asked, "mail").is_empty());
    control.host.port().close();
}

#[tokio::test]
async fn the_bot_passes_a_card_on_to_the_owner_in_its_chat_and_hears_the_owner_s_answer_once() {
    let (control, asked) = rig(9_907, world(json!([form("r1")])), main_replies);
    ada(&control, false);
    assert!(control.route_ask("work", "r1", &origin()).await.is_some());
    let (text, is_error) = answer(
        &control,
        "other",
        json!({ "session": "work", "request": "r1", "escalate": true }),
    )
    .await;
    assert!(is_error, "{text}");
    let (text, is_error) = answer(
        &control,
        "chat",
        json!({ "session": "work", "request": "r1", "escalate": true }),
    )
    .await;
    assert!(
        !is_error && text.starts_with("Passed on to the owner"),
        "{text}"
    );
    let shown = asked_with(&asked, "escalateAsk");
    assert_eq!(
        shown,
        vec![json!({ "tabId": "work", "requestId": "r1", "chatTabId": "chat" })]
    );
    // It is the owner's now: the bot's own answer is refused.
    let (text, is_error) = answer(
        &control,
        "chat",
        json!({ "session": "work", "request": "r1", "answers": [{ "id": "field-0", "selected": ["B"] }] }),
    )
    .await;
    assert!(is_error && text.contains("theirs to answer"), "{text}");
    control.routed_ask_closed("work", "r1", Some("B")).await;
    control.routed_ask_closed("work", "r1", Some("B")).await;
    let notes: Vec<Value> = asked_with(&asked, "mail")
        .into_iter()
        .filter(|mail| mail["details"]["kind"] == "note")
        .collect();
    assert_eq!(notes.len(), 1);
    assert!(
        notes[0]["content"]
            .as_str()
            .unwrap()
            .contains("The owner answered"),
        "{}",
        notes[0]
    );
    control.host.port().close();
}
