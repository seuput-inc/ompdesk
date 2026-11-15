//! Tests of the message tools against a fake main: what an agent reads back from a send, a report, an answer and a
//! card, and what main is asked or told meanwhile.

use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::super::host::{Caps, HostState};
use super::super::tuning::Tuning;
use super::super::{AgentControl, Files, JournalFile};
use crate::agentctl::journal::send_outbox::OutboxSend;
use crate::agentctl::journal::{system_clock, tests::Dir};
use crate::ports::Port;

type Asked = Arc<Mutex<Vec<(String, Value)>>>;

fn rig(
    id: u64,
    state: Value,
    tuning: Tuning,
    reply: impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static,
) -> (AgentControl, Asked) {
    rig_with_files(id, state, tuning, &Files::default(), Caps::default(), reply)
}

fn rig_with_files(
    id: u64,
    state: Value,
    tuning: Tuning,
    files: &Files,
    caps: Caps,
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
    let control = AgentControl::new(port, caps, files, tuning, system_clock());
    (control, asked)
}

fn main_replies(method: &str, args: &Value) -> Result<Value, String> {
    match method {
        "args.parse" => Ok(json!({ "ok": true, "args": args["args"] })),
        "command" => match args["command"]["type"].as_str() {
            Some("prompt") => Ok(json!({ "success": true })),
            Some("get_state") => Ok(json!({ "success": true, "data": { "isStreaming": false } })),
            _ => Ok(json!({ "success": false, "error": "no" })),
        },
        "mail" | "answer" | "markAnswered" => Ok(Value::Null),
        other => Err(format!("fake main has no {other}")),
    }
}

fn tab(id: &str) -> Value {
    json!({ "tabId": id, "title": id, "cwd": "/w", "status": "ready", "busy": false, "asks": [], "hidden": false, "sessionPath": format!("/s/{id}_1.jsonl") })
}

fn state(tabs: Vec<Value>) -> Value {
    let windows: Map<String, Value> = tabs
        .iter()
        .map(|tab| (tab["tabId"].as_str().unwrap().to_owned(), json!("w")))
        .collect();
    json!({
        "enabled": true,
        "approveEnabled": true,
        "tabs": tabs,
        "windowOf": windows,
        "parents": { "b": { "callerTabId": "a" } },
    })
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

#[tokio::test]
async fn a_send_to_an_idle_child_hands_over_a_numbered_dispatch_and_repeats_its_receipt() {
    let tuning = Tuning {
        turn_start_wait_ms: 40,
        ..Tuning::default()
    };
    let (control, asked) = rig(9_301, state(vec![tab("a"), tab("b")]), tuning, main_replies);
    let args = json!({ "session": "b", "message": "do it", "request_id": "r1" });
    let first = control
        .run("a", "ompdesk_session_send", args.clone(), None)
        .await;
    assert!(!first.is_error, "{}", first.text);
    assert_eq!(
        first.text,
        "Sent to \"b\" (saved id 1): accepted; it was idle, but no turn started within 0.04 s: see ompdesk_session_result before sending it again. Dispatch d1: it reports back with ompdesk_report."
    );
    let prompts: Vec<Value> = asked_with(&asked, "command")
        .into_iter()
        .filter(|args| args["command"]["type"] == "prompt")
        .collect();
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0]["command"]["streamingBehavior"], "steer");
    assert!(
        prompts[0]["command"]["message"]
            .as_str()
            .unwrap()
            .contains("[ompdesk dispatch d1:")
    );
    let again = control.run("a", "ompdesk_session_send", args, None).await;
    assert_eq!(
        again.text,
        format!(
            "{} (request r1 was already delivered; nothing sent again)",
            first.text
        )
    );
    let to_itself = control
        .run(
            "a",
            "ompdesk_session_send",
            json!({ "session": "a", "message": "x" }),
            None,
        )
        .await;
    // The tool resolves its target first, and that refuses the caller's own session (`#sendTarget`), as the
    // TypeScript did before `#send` could say it.
    assert_eq!(
        to_itself.text,
        "You cannot send to your own session with this tool."
    );
    control.host.port().close();
}

#[tokio::test]
async fn a_report_reaches_the_opener_once_and_says_what_to_do_next() {
    let (control, asked) = rig(
        9_302,
        state(vec![tab("a"), tab("b")]),
        Tuning::default(),
        main_replies,
    );
    let args = json!({ "kind": "question", "text": "which one?" });
    let first = control.run("b", "ompdesk_report", args.clone(), None).await;
    assert_eq!(
        first.text,
        "Delivered. Wait for the answer: it comes as a message (between your steps while this turn runs); do not guess the decision meanwhile."
    );
    let mails = asked_with(&asked, "mail");
    assert_eq!(mails.len(), 1);
    assert_eq!(mails[0]["tabId"], "a");
    assert!(mails[0]["content"].as_str().unwrap().contains("which one?"));
    let again = control.run("b", "ompdesk_report", args, None).await;
    assert!(
        again.text.starts_with("Report ")
            && again
                .text
                .contains("was already delivered; nothing sent again."),
        "{}",
        again.text
    );
    assert_eq!(asked_with(&asked, "mail").len(), 1);
    // A session nobody opened has no one to report to.
    let alone = control
        .run(
            "a",
            "ompdesk_report",
            json!({ "kind": "done", "text": "x" }),
            None,
        )
        .await;
    assert!(
        alone.is_error
            && alone
                .text
                .starts_with("ompdesk_report goes to the session that opened you")
    );
    control.host.port().close();
}

#[tokio::test]
async fn an_answer_picks_the_option_and_a_tool_approval_needs_the_user_s_leave() {
    let mut card = tab("b");
    card["asks"] = json!([{ "id": "r1", "request": { "id": "r1", "method": "select", "title": "Pick", "options": ["Red", "Blue"] } }]);
    let (control, asked) = rig(
        9_303,
        state(vec![tab("a"), card.clone()]),
        Tuning::default(),
        main_replies,
    );
    let done = control
        .run(
            "a",
            "ompdesk_session_answer",
            json!({ "session": "b", "choice": "blue" }),
            None,
        )
        .await;
    assert_eq!(
        done.text,
        "Answered \"b\": \"Blue\" to \"Pick\". It continues now."
    );
    assert_eq!(asked_with(&asked, "answer")[0]["response"]["value"], "Blue");
    let missing = control
        .run(
            "a",
            "ompdesk_session_answer",
            json!({ "session": "b" }),
            None,
        )
        .await;
    assert_eq!(
        missing.text,
        "No choice given: pass `choice` with one of: \"Red\" | \"Blue\"."
    );
    control.host.port().close();

    let mut approval = tab("b");
    approval["asks"] = json!([{ "id": "r2", "request": { "id": "r2", "method": "select", "title": "Allow tool: bash\nrm", "options": ["Approve", "Deny"] } }]);
    let mut off = state(vec![tab("a"), approval]);
    off["approveEnabled"] = json!(false);
    let (control, _) = rig(9_304, off, Tuning::default(), main_replies);
    let refused = control
        .run(
            "a",
            "ompdesk_session_answer",
            json!({ "session": "b", "approve": true }),
            None,
        )
        .await;
    assert!(
        refused.is_error && refused.text.starts_with("사용자 승인이 필요해요:"),
        "{}",
        refused.text
    );
    let denied = control
        .run(
            "a",
            "ompdesk_session_answer",
            json!({ "session": "b", "approve": false }),
            None,
        )
        .await;
    assert!(!denied.is_error, "{}", denied.text);
    control.host.port().close();
}

#[tokio::test]
async fn a_child_s_card_reaches_its_opener_once_and_focus_and_notify_tell_main() {
    let mut card = tab("b");
    card["asks"] =
        json!([{ "id": "r1", "request": { "id": "r1", "method": "confirm", "title": "Go on?" } }]);
    let (control, asked) = rig(
        9_305,
        state(vec![tab("a"), card]),
        Tuning::default(),
        main_replies,
    );
    control.child_asked("a", "b", "r1").await.unwrap();
    control.child_asked("a", "b", "r1").await.unwrap();
    let mails = asked_with(&asked, "mail");
    assert_eq!(mails.len(), 1);
    assert_eq!(mails[0]["tabId"], "a");
    assert_eq!(mails[0]["details"]["kind"], "question");
    let shown = control
        .run("a", "ompdesk_tab_focus", json!({ "session": "b" }), None)
        .await;
    assert_eq!(shown.text, "Showing \"b\" (focus).");
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert_eq!(asked_with(&asked, "view")[0]["event"]["tabId"], "b");
    control.host.port().close();
}

fn busy(id: &str) -> Value {
    let mut tab = tab(id);
    tab["busy"] = json!(true);
    tab["busySince"] = json!(1);
    tab
}

/// 13 Nov 2026: a steer to a session inside `ompdesk_session_result {wait: true}` was read 50 minutes later, when the
/// wait ended: stock's host tool call cannot be cut by a steer. The wait now returns when a message reaches it.
#[tokio::test]
async fn a_steer_ends_the_receiver_s_blocking_wait_and_the_receipt_says_so() {
    let (control, asked) = rig(
        9_310,
        state(vec![tab("s"), busy("a"), busy("w")]),
        Tuning::default(),
        main_replies,
    );
    let waiting = {
        let control = control.clone();
        tokio::spawn(async move {
            control
                .run(
                    "a",
                    "ompdesk_session_result",
                    json!({ "session": "w", "wait": true, "timeout_seconds": 60 }),
                    None,
                )
                .await
        })
    };
    while !control.is_blocked("a") {
        tokio::task::yield_now().await;
    }
    let receipt = control
        .run(
            "s",
            "ompdesk_session_send",
            json!({ "session": "a", "message": "read me now" }),
            None,
        )
        .await;
    assert!(
        receipt
            .text
            .contains("inside a blocking ompdesk_session_result wait")
            && receipt.text.contains("returns now"),
        "{}",
        receipt.text
    );
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
        .await
        .expect("the wait never returned")
        .unwrap();
    assert!(result.text.contains("Returned early"), "{}", result.text);
    assert!(!result.text.contains("Still running"), "{}", result.text);
    assert!(!control.is_blocked("a"));
    let prompts: Vec<Value> = asked_with(&asked, "command")
        .into_iter()
        .filter(|args| args["command"]["type"] == "prompt")
        .collect();
    assert_eq!(prompts[0]["command"]["streamingBehavior"], "steer");
    control.host.port().close();
}

#[tokio::test]
async fn a_report_or_the_person_s_prompt_ends_the_blocking_wait_too() {
    let (control, _asked) = rig(
        9_311,
        state(vec![busy("a"), busy("b"), busy("w")]),
        Tuning::default(),
        main_replies,
    );
    // The state's parents make "a" the opener of "b".
    for wake in 0..2 {
        let waiting = {
            let control = control.clone();
            tokio::spawn(async move {
                control
                    .run(
                        "a",
                        "ompdesk_session_result",
                        json!({ "session": "w", "wait": true, "timeout_seconds": 60 }),
                        None,
                    )
                    .await
            })
        };
        while !control.is_blocked("a") {
            tokio::task::yield_now().await;
        }
        if wake == 0 {
            control
                .run(
                    "b",
                    "ompdesk_report",
                    json!({ "kind": "done", "text": "finished" }),
                    None,
                )
                .await;
        } else {
            let _ = control.person_typed("a");
        }
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
            .await
            .expect("the wait never returned")
            .unwrap();
        assert!(result.text.contains("Returned early"), "{}", result.text);
    }
    control.host.port().close();
}

/// An instruction must leave the person's approval card open and send no answer or abort.
#[tokio::test]
async fn a_current_instruction_preserves_the_open_approval_card_without_a_mode_selector() {
    let mut card = busy("c");
    card["asks"] = json!([{ "id": "r1", "request": { "id": "r1", "method": "select", "title": "Which?", "options": ["x", "y"] } }]);
    let (control, asked) = rig(
        9_312,
        state(vec![tab("s"), card]),
        Tuning::default(),
        |method, args| {
            if method == "command" && args["command"]["type"] == "agent_control_instruction" {
                return Ok(json!({"success": true}));
            }
            main_replies(method, args)
        },
    );
    let receipt = control
        .run(
            "s",
            "ompdesk_session_send",
            json!({"session": "c", "message": "an update", "request_id": "card-update"}),
            None,
        )
        .await;
    assert!(!receipt.is_error, "{}", receipt.text);
    let commands = asked_with(&asked, "command");
    let instructions = commands
        .iter()
        .filter(|args| args["command"]["type"] == "agent_control_instruction")
        .collect::<Vec<_>>();
    assert_eq!(instructions.len(), 1);
    assert!(
        instructions[0]["command"]
            .get("streamingBehavior")
            .is_none()
    );
    assert!(
        receipt.text.contains("which stays open")
            && receipt.text.contains("once the user has answered"),
        "{}",
        receipt.text
    );
    let live = control.host.state();
    let actual = live.tabs.iter().find(|tab| tab.tab_id == "c").unwrap();
    assert_eq!(actual.asks.len(), 1);
    assert_eq!(actual.asks[0].id, "r1");
    assert_eq!(actual.asks[0].request.method, "select");
    assert_eq!(actual.asks[0].request.title.as_deref(), Some("Which?"));
    assert_eq!(actual.asks[0].request.options, ["x", "y"]);
    assert!(commands.iter().all(|args| {
        !matches!(
            args["command"]["type"].as_str(),
            Some("abort" | "extension_ui_response" | "plan_approval")
        )
    }));
    assert!(asked_with(&asked, "answer").is_empty());
    assert!(asked_with(&asked, "markAnswered").is_empty());
    control.host.port().close();
}

#[tokio::test]
async fn retired_instruction_delivery_inputs_are_refused_without_card_or_instruction_effects() {
    for (n, delivery) in ["steer", "follow_up"].into_iter().enumerate() {
        let mut card = busy("c");
        card["asks"] = json!([{ "id": "r1", "request": { "id": "r1", "method": "select", "title": "Which?", "options": ["x", "y"] } }]);
        let (control, asked) = rig(
            9_313 + n as u64,
            state(vec![tab("s"), card]),
            Tuning::default(),
            main_replies,
        );
        let receipt = control
            .run(
                "s",
                "ompdesk_session_send",
                json!({"session": "c", "message": "an update", "delivery": delivery}),
                None,
            )
            .await;
        assert!(receipt.is_error, "{delivery}: {}", receipt.text);
        assert!(asked_with(&asked, "command").is_empty());
        assert!(asked_with(&asked, "answer").is_empty());
        assert!(asked_with(&asked, "markAnswered").is_empty());
        assert_eq!(
            control
                .host
                .state()
                .tabs
                .iter()
                .find(|tab| tab.tab_id == "c")
                .unwrap()
                .asks
                .len(),
            1
        );
        control.host.port().close();
    }
}

fn retained_original() -> OutboxSend {
    OutboxSend::new(
        super::super::wrap::dispatch_mark("d1"),
        Some(1),
        "/s/b_1.jsonl".into(),
        None,
        "/s/a_1.jsonl".into(),
        "original instruction".into(),
        "original instruction".into(),
        1_000.0,
    )
}

#[tokio::test]
async fn retrying_an_unsaved_original_cannot_report_success_or_already_on_its_way() {
    let directory = Dir::new();
    let file = directory.file("send.json");
    let files = Files {
        send_outbox: Some(JournalFile {
            file: Some(file.clone()),
        }),
        ..Files::default()
    };
    let (control, asked) = rig_with_files(
        9_320,
        state(vec![tab("a"), busy("b")]),
        Tuning::default(),
        &files,
        Caps::default(),
        main_replies,
    );
    std::fs::create_dir(&file).unwrap();
    let original = retained_original();
    let outbox = control.send_outbox.as_ref().unwrap();
    assert!(outbox.keep(original.clone()).is_err());
    let receipt = control
        .run(
            "a",
            "ompdesk_session_send",
            json!({"session": "b", "message": original.body}),
            None,
        )
        .await;
    assert!(
        receipt.is_error,
        "an unsaved original received a successful receipt: {}",
        receipt.text
    );
    assert!(
        !receipt.text.contains("already on its way"),
        "{}",
        receipt.text
    );
    assert_eq!(outbox.pending(), [original]);
    assert!(
        asked_with(&asked, "command")
            .iter()
            .all(|args| args["command"]["type"] != "agent_control_instruction")
    );
    control.host.port().close();
}

#[tokio::test]
async fn a_saved_original_with_an_unanswered_receiver_keeps_an_unconfirmed_queue_receipt() {
    let directory = Dir::new();
    let file = directory.file("send.json");
    let files = Files {
        send_outbox: Some(JournalFile { file: Some(file) }),
        ..Files::default()
    };
    let (control, asked) = rig_with_files(
        9_321,
        state(vec![tab("a"), busy("b")]),
        Tuning::default(),
        &files,
        Caps {
            sent_marks: true,
            ..Caps::default()
        },
        |method, args| {
            if method == "sentMarks" {
                return Err("the receiver cannot answer yet".into());
            }
            main_replies(method, args)
        },
    );
    let original = retained_original();
    let outbox = control.send_outbox.as_ref().unwrap();
    outbox.keep(original.clone()).unwrap();
    let receipt = control
        .run(
            "a",
            "ompdesk_session_send",
            json!({"session": "b", "message": original.body}),
            None,
        )
        .await;
    assert!(!receipt.is_error, "{}", receipt.text);
    assert!(receipt.text.contains("unconfirmed"), "{}", receipt.text);
    assert_eq!(outbox.pending(), [original]);
    assert!(
        asked_with(&asked, "command")
            .iter()
            .all(|args| args["command"]["type"] != "agent_control_instruction")
    );
    control.host.port().close();
}

#[tokio::test]
async fn storage_recovery_during_a_new_send_cannot_bypass_an_earlier_original() {
    let directory = Dir::new();
    let file = directory.file("send.json");
    let files = Files {
        send_outbox: Some(JournalFile {
            file: Some(file.clone()),
        }),
        ..Files::default()
    };
    let recover_at_journal = file.clone();
    let (control, asked) = rig_with_files(
        9_322,
        state(vec![tab("a"), busy("b")]),
        Tuning::default(),
        &files,
        Caps {
            sent_marks: true,
            ..Caps::default()
        },
        move |method, args| {
            if method == "sentMarks" {
                return Ok(json!({"instance": "current-omp", "journaled": []}));
            }
            if method == "command" {
                match args["command"]["type"].as_str() {
                    Some("get_transcript_page") => {
                        std::fs::remove_dir(&recover_at_journal).unwrap();
                        return Ok(json!({"success": true, "data": {"messages": []}}));
                    }
                    Some("agent_control_instruction") => return Ok(json!({"success": true})),
                    _ => {}
                }
            }
            main_replies(method, args)
        },
    );
    std::fs::create_dir(&file).unwrap();
    let original = retained_original();
    let outbox = control.send_outbox.as_ref().unwrap();
    assert!(outbox.keep(original.clone()).is_err());
    let receipt = control
        .run(
            "a",
            "ompdesk_session_send",
            json!({"session": "b", "message": "next instruction", "request_id": "next"}),
            None,
        )
        .await;
    assert!(!receipt.is_error, "{}", receipt.text);
    assert!(
        asked_with(&asked, "command")
            .iter()
            .all(|args| args["command"]["type"] != "agent_control_instruction"),
        "a newer instruction bypassed unresolved earlier debt"
    );
    assert!(receipt.text.contains("unconfirmed"), "{}", receipt.text);
    let pending = outbox.pending();
    assert_eq!(
        pending
            .iter()
            .map(|entry| entry.body.as_str())
            .collect::<Vec<_>>(),
        ["original instruction", "next instruction"]
    );
    assert_eq!(pending[0], original);
    control.redeliver_sends().await.unwrap();
    let delivered = asked_with(&asked, "command")
        .into_iter()
        .filter(|args| args["command"]["type"] == "agent_control_instruction")
        .map(|args| args["command"]["requestId"].clone())
        .collect::<Vec<_>>();
    assert_eq!(
        delivered,
        pending
            .iter()
            .map(|entry| Value::String(entry.mark.clone()))
            .collect::<Vec<_>>()
    );
    control.host.port().close();
}
