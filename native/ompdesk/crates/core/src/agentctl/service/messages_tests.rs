//! Tests of the message tools against a fake main: what an agent reads back from a send, a report, an answer and a
//! card, and what main is asked or told meanwhile.

use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::super::host::{Caps, HostState};
use super::super::tuning::Tuning;
use super::super::{AgentControl, Files};
use crate::agentctl::journal::system_clock;
use crate::ports::Port;

type Asked = Arc<Mutex<Vec<(String, Value)>>>;

fn rig(
    id: u64,
    state: Value,
    tuning: Tuning,
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
        tuning,
        system_clock(),
    );
    (control, asked)
}

fn main_replies(method: &str, args: &Value) -> Result<Value, String> {
    match method {
        "args.parse" => Ok(json!({ "ok": true, "args": args["args"] })),
        "command" => match args["command"]["type"].as_str() {
            Some("prompt") => Ok(json!({ "success": true })),
            // The bridge takes another session's message to a working session as stock's aside.
            Some("agent_control_aside") => Ok(json!({ "success": true, "data": {} })),
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
async fn a_send_that_starts_with_a_slash_goes_as_text_and_its_receipt_says_so() {
    // C17, 20 Nov 2026: '/advisor off' sent to a review session arrived inside the agent-message wrapper and was not
    // run, and the sender was not told. An agent never runs a command in another session; the receipt says so.
    let tuning = Tuning {
        turn_start_wait_ms: 40,
        ..Tuning::default()
    };
    let (control, asked) = rig(9_340, state(vec![tab("a"), tab("b")]), tuning, main_replies);
    let sent = control
        .run(
            "a",
            "ompdesk_session_send",
            json!({ "session": "b", "message": "  /advisor off" }),
            None,
        )
        .await;
    assert!(!sent.is_error, "{}", sent.text);
    assert!(
        sent.text.ends_with(
            " It went as text, not run as a command: an agent never runs a slash command in another session. To keep a session's advisor off, open it with ompdesk_session_open advisor: false."
        ),
        "{}",
        sent.text
    );
    let prompt = asked_with(&asked, "command")
        .into_iter()
        .find(|args| args["command"]["type"] == "prompt")
        .unwrap();
    let message = prompt["command"]["message"].as_str().unwrap();
    assert!(message.starts_with("<ompdesk-agent-message"), "{message}");
    assert!(message.contains("/advisor off"), "{message}");
    let plain = control
        .run(
            "a",
            "ompdesk_session_send",
            json!({ "session": "b", "message": "see /tmp/x" }),
            None,
        )
        .await;
    assert!(
        !plain.text.contains("not run as a command"),
        "{}",
        plain.text
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
    let asides: Vec<Value> = asked_with(&asked, "command")
        .into_iter()
        .filter(|args| args["command"]["type"] == "agent_control_aside")
        .collect();
    assert_eq!(asides.len(), 1);
    assert!(
        asides[0]["command"]["message"]
            .as_str()
            .unwrap()
            .contains("read me now")
    );
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

/// 13 Nov 2026: three default sends to a session waiting for the person's answer closed its question card each time,
/// while the receipt said they would be read after the user answers. Stock's aside leaves the card open; where the
/// receiver's computer does not know it, the message waits as a follow-up, never a steer.
#[tokio::test]
async fn a_message_to_a_session_with_an_open_card_never_closes_it() {
    for aside_known in [true, false] {
        let mut card = busy("c");
        card["asks"] = json!([{ "id": "r1", "request": { "id": "r1", "method": "select", "title": "Which?", "options": ["x", "y"] } }]);
        let (control, asked) = rig(
            9_312 + u64::from(aside_known),
            state(vec![tab("s"), card]),
            Tuning::default(),
            move |method, args| {
                if !aside_known && args["command"]["type"] == "agent_control_aside" {
                    return Ok(
                        json!({ "success": false, "error": "Unknown command: agent_control_aside" }),
                    );
                }
                main_replies(method, args)
            },
        );
        let args = json!({ "session": "c", "message": "an update" });
        let receipt = control.run("s", "ompdesk_session_send", args, None).await;
        let kinds: Vec<Value> = asked_with(&asked, "command")
            .into_iter()
            .filter_map(|args| match args["command"]["type"].as_str() {
                Some("agent_control_aside") => Some(json!("aside")),
                Some("prompt") => Some(args["command"]["streamingBehavior"].clone()),
                _ => None,
            })
            .collect();
        let expected = if aside_known {
            vec![json!("aside")]
        } else {
            vec![json!("aside"), json!("followUp")]
        };
        assert_eq!(kinds, expected, "aside known: {aside_known}");
        assert!(
            receipt.text.contains("that card stays open")
                && receipt.text.contains("after the user has answered")
                && !receipt.text.contains("delivered as steer"),
            "{}",
            receipt.text
        );
        control.host.port().close();
    }
}

/// 18 Nov 2026: the hub's send to a session still starting on another computer never returned, and the person's own
/// messages waited behind that tool call. A send waits for a start only `send_ready_wait_ms`.
#[tokio::test]
async fn a_send_to_a_session_still_starting_returns_within_its_bound() {
    let mut starting = tab("t");
    starting["status"] = json!("starting");
    let tuning = Tuning {
        send_ready_wait_ms: 100,
        ready_poll_ms: 10,
        ..Tuning::default()
    };
    let (control, asked) = rig(9_330, state(vec![tab("s"), starting]), tuning, main_replies);
    let receipt = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        control.run(
            "s",
            "ompdesk_session_send",
            json!({ "session": "t", "message": "when you are up" }),
            None,
        ),
    )
    .await
    .expect("the send waited for the start");
    assert!(receipt.is_error, "{}", receipt.text);
    assert!(receipt.text.contains("still starting"), "{}", receipt.text);
    assert!(
        asked_with(&asked, "command")
            .iter()
            .all(|args| args["tabId"] != "t"),
        "nothing reaches a tab that is not up"
    );
    control.host.port().close();
}

/// A paired host's tab whose `tab.command` timed out on the link (main answers `rpc_delivery_unknown`): the host may
/// have delivered it (19 Nov 2026: the hub got all three copies of one request id after two "nothing was sent").
#[tokio::test]
async fn an_unanswered_send_is_not_confirmed_and_its_resend_answers_from_the_record() {
    let tuning = Tuning {
        turn_start_wait_ms: 40,
        ..Tuning::default()
    };
    let mut remote = tab("b");
    remote["device"] = json!("macbook");
    let (control, asked) = rig(
        9_331,
        state(vec![tab("a"), remote]),
        tuning,
        |method, args| match (method, args["command"]["type"].as_str()) {
            ("command", Some("prompt")) => Ok(json!({
                "success": false,
                "code": "rpc_delivery_unknown",
                "error": "tab.command timed out after 35000 ms",
            })),
            _ => main_replies(method, args),
        },
    );
    let args = json!({ "session": "b", "message": "gate green", "request_id": "main-gate3" });
    let first = control
        .run("a", "ompdesk_session_send", args.clone(), None)
        .await;
    assert!(!first.is_error, "{}", first.text);
    assert!(first.text.contains("not confirmed"), "{}", first.text);
    assert!(!first.text.contains("nothing was sent"), "{}", first.text);
    let again = control.run("a", "ompdesk_session_send", args, None).await;
    assert!(!again.is_error, "{}", again.text);
    assert!(again.text.contains("nothing sent again"), "{}", again.text);
    let prompts = asked_with(&asked, "command")
        .into_iter()
        .filter(|args| args["command"]["type"] == "prompt")
        .count();
    assert_eq!(prompts, 1, "the resend reached the host again");
    control.host.port().close();
}
