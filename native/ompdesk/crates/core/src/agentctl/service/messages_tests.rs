use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::super::host::{Caps, HostState};
use super::super::tuning::Tuning;
use super::super::{AgentControl, Files};
use crate::agentctl::journal::system_clock;
use crate::ports::Port;

type Asked = Arc<Mutex<Vec<(String, Value)>>>;

fn legacy_rig(
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

fn rig(
    id: u64,
    state: Value,
    tuning: Tuning,
    reply: impl Fn(&str, &Value) -> Result<Value, String> + Send + Sync + 'static,
) -> (
    AgentControl,
    Asked,
    tokio::sync::mpsc::UnboundedReceiver<Value>,
    impl Drop,
) {
    crate::agentctl::runtime::tests::native_rig(
        id,
        state,
        Caps::default(),
        &Files::default(),
        tuning,
        reply,
    )
}

async fn delivered(channel: &mut tokio::sync::mpsc::UnboundedReceiver<Value>) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(5), channel.recv())
        .await
        .expect("native inbox delivery timed out")
        .expect("native inbox delivery channel closed")
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
    json!({ "tabId": id, "runtimeInstance": format!("runtime-{id}"), "title": id, "cwd": "/w", "status": "ready", "busy": false, "asks": [], "hidden": false, "sessionPath": format!("/s/{id}_1.jsonl") })
}

fn state(tabs: Vec<Value>) -> Value {
    let windows: Map<String, Value> = tabs
        .iter()
        .map(|tab| (tab["tabId"].as_str().unwrap().to_owned(), json!("w")))
        .collect();
    json!({
        "deviceId": "test-host",
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
    let (control, asked, mut channel, _fixture) =
        rig(9_301, state(vec![tab("a"), tab("b")]), tuning, main_replies);
    let args = json!({ "session": "b", "message": "do it", "request_id": "r1" });
    let first = control
        .run("a", "ompdesk_session_send", args.clone(), None)
        .await;
    assert!(!first.is_error, "{}", first.text);
    let delivery = delivered(&mut channel).await;
    assert_eq!(delivery["tabId"], "b");
    let entry = &delivery["request"]["entries"][0];
    assert_eq!(entry["kind"], "prompt");
    assert_eq!(entry["intent"], "immediate");
    assert_eq!(entry["triggerTurn"], true);
    let content = entry["content"].as_str().unwrap();
    assert!(content.contains("do it"));
    assert!(content.contains("[ompdesk dispatch d1:"));
    let transfers = asked_with(&asked, "inbox");
    assert_eq!(transfers[0]["transfer"]["entries"][0]["dispatch"], 1);
    let again = control.run("a", "ompdesk_session_send", args, None).await;
    assert!(!again.is_error, "{}", again.text);
    assert_eq!(
        asked_with(&asked, "inbox").last().unwrap()["transfer"]["entries"][0]["logical"]["requestId"],
        "r1"
    );
    let changed = control
        .run(
            "a",
            "ompdesk_session_send",
            json!({ "session": "b", "message": "changed", "request_id": "r1" }),
            None,
        )
        .await;
    assert!(changed.is_error, "{}", changed.text);
    assert!(changed.text.contains("conflict"), "{}", changed.text);
    let receiver = serde_json::from_value(delivery["request"]["receiver"].clone()).unwrap();
    let (_, pending) = control
        .receiving_inbox
        .as_ref()
        .unwrap()
        .ledger
        .pending(&receiver)
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].dispatch, Some(1));
    assert_eq!(
        pending[0].entry.delivery_id,
        entry["deliveryId"].as_str().unwrap()
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
    let (control, asked, mut channel, _fixture) = rig(
        9_302,
        state(vec![tab("a"), tab("b")]),
        Tuning::default(),
        main_replies,
    );
    let args = json!({ "id": "question-r1", "kind": "question", "text": "which one?" });
    let first = control.run("b", "ompdesk_report", args.clone(), None).await;
    assert_eq!(
        first.text,
        "Delivered. Wait for the answer: it comes as a message (between your steps while this turn runs); do not guess the decision meanwhile."
    );
    let delivery = delivered(&mut channel).await;
    assert_eq!(delivery["tabId"], "a");
    let entry = &delivery["request"]["entries"][0];
    assert_eq!(entry["kind"], "report");
    assert_eq!(entry["details"]["kind"], "question");
    assert!(entry["content"].as_str().unwrap().contains("which one?"));
    let again = control.run("b", "ompdesk_report", args, None).await;
    assert!(
        again.text.starts_with("Report ")
            && again
                .text
                .contains("was already delivered; nothing sent again."),
        "{}",
        again.text
    );
    let transfers = asked_with(&asked, "inbox");
    let mut original: Option<&Value> = None;
    for transfer in &transfers {
        for candidate in transfer["transfer"]["entries"].as_array().unwrap() {
            assert_eq!(candidate["entry"]["kind"], "report");
            assert_eq!(candidate["entry"]["deliveryId"], entry["deliveryId"]);
            if let Some(first) = original {
                assert_eq!(candidate["logical"], first["logical"]);
            } else {
                original = Some(candidate);
            }
        }
    }
    let original = original.expect("the report must cross the native receiving hop");
    for attempt in asked_with(&asked, "deliverInbox") {
        for provider_entry in attempt["request"]["entries"].as_array().unwrap() {
            assert_eq!(provider_entry["kind"], "report");
            assert_eq!(provider_entry["deliveryId"], entry["deliveryId"]);
        }
    }
    let receiver = serde_json::from_value(delivery["request"]["receiver"].clone()).unwrap();
    let (_, pending) = control
        .receiving_inbox
        .as_ref()
        .unwrap()
        .ledger
        .pending(&receiver)
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(
        pending[0].entry.delivery_id,
        entry["deliveryId"].as_str().unwrap()
    );
    assert_eq!(pending[0].dispatch, original["dispatch"].as_i64());
    assert_eq!(
        serde_json::to_value(&pending[0].logical).unwrap(),
        original["logical"]
    );
    assert_eq!(
        serde_json::to_value(&pending[0].entry.payload).unwrap()["content"],
        entry["content"]
    );
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
    let (control, asked) = legacy_rig(
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
    let (control, _) = legacy_rig(9_304, off, Tuning::default(), main_replies);
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
    let (control, asked, mut channel, _fixture) = rig(
        9_305,
        state(vec![tab("a"), card]),
        Tuning::default(),
        main_replies,
    );
    control.child_asked("a", "b", "r1").await.unwrap();
    control.child_asked("a", "b", "r1").await.unwrap();
    assert_eq!(asked_with(&asked, "inbox").len(), 1);
    let delivery = delivered(&mut channel).await;
    assert_eq!(delivery["tabId"], "a");
    let entry = &delivery["request"]["entries"][0];
    assert_eq!(entry["kind"], "report");
    assert_eq!(entry["details"]["kind"], "question");
    assert!(entry["content"].as_str().unwrap().contains("request r1"));
    assert!(entry["content"].as_str().unwrap().contains("Go on?"));
    let shown = control
        .run("a", "ompdesk_tab_focus", json!({ "session": "b" }), None)
        .await;
    assert_eq!(shown.text, "Showing \"b\" (focus).");
    control.host.fresh().await.unwrap();
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
    let (control, _asked, mut channel, _fixture) = rig(
        9_310,
        state(vec![tab("s"), busy("a"), busy("w")]),
        Tuning::default(),
        main_replies,
    );
    let waiting = blocking_wait(&control).await;
    let receipt = control
        .run(
            "s",
            "ompdesk_session_send",
            json!({ "session": "a", "message": "read me now" }),
            None,
        )
        .await;
    assert!(!receipt.is_error, "{}", receipt.text);
    let delivery = delivered(&mut channel).await;
    assert_eq!(delivery["tabId"], "a");
    assert_eq!(delivery["request"]["entries"][0]["kind"], "prompt");
    assert_eq!(delivery["request"]["entries"][0]["intent"], "immediate");
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
    control.host.port().close();
}

async fn blocking_wait(
    control: &AgentControl,
) -> tokio::task::JoinHandle<super::super::types::ToolOutcome> {
    let caller = control.clone();
    let waiting = tokio::spawn(async move {
        caller
            .run(
                "a",
                "ompdesk_session_result",
                json!({ "session": "w", "wait": true, "timeout_seconds": 60 }),
                None,
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !control.is_blocked("a") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the wait did not block");
    waiting
}

#[tokio::test]
async fn a_report_ends_the_blocking_wait_too() {
    let (control, _asked, mut channel, _fixture) = rig(
        9_311,
        state(vec![busy("a"), busy("b"), busy("w")]),
        Tuning::default(),
        main_replies,
    );
    let waiting = blocking_wait(&control).await;
    let receipt = control
        .run(
            "b",
            "ompdesk_report",
            json!({ "kind": "done", "text": "finished" }),
            None,
        )
        .await;
    assert!(!receipt.is_error, "{}", receipt.text);
    let delivery = delivered(&mut channel).await;
    assert_eq!(delivery["tabId"], "a");
    assert_eq!(delivery["request"]["entries"][0]["kind"], "report");
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
        .await
        .expect("the wait never returned")
        .unwrap();
    assert!(result.text.contains("Returned early"), "{}", result.text);
    assert!(!result.text.contains("Still running"), "{}", result.text);
    assert!(!control.is_blocked("a"));
    control.host.port().close();
}

#[tokio::test]
async fn a_person_s_prompt_ends_the_blocking_wait_too() {
    let (control, _asked, _channel, _fixture) = rig(
        9_315,
        state(vec![busy("a"), busy("b"), busy("w")]),
        Tuning::default(),
        main_replies,
    );
    let waiting = blocking_wait(&control).await;
    let _ = control.person_typed("a");
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
        .await
        .expect("the wait never returned")
        .unwrap();
    assert!(result.text.contains("Returned early"), "{}", result.text);
    assert!(!result.text.contains("Still running"), "{}", result.text);
    assert!(!control.is_blocked("a"));
    control.host.port().close();
}

async fn open_card_queues_message(id: u64, delivery: Option<&str>) {
    let mut card = busy("c");
    card["asks"] = json!([{ "id": "r1", "request": { "id": "r1", "method": "select", "title": "Which?", "options": ["x", "y"] } }]);
    let (control, _asked, mut channel, _fixture) = rig(
        id,
        state(vec![tab("s"), card]),
        Tuning::default(),
        main_replies,
    );
    let mut args = json!({ "session": "c", "message": "an update" });
    if let Some(delivery) = delivery {
        args["delivery"] = json!(delivery);
    }
    let receipt = control.run("s", "ompdesk_session_send", args, None).await;
    assert!(!receipt.is_error, "{}", receipt.text);
    let request = delivered(&mut channel).await;
    assert_eq!(request["tabId"], "c");
    let entry = &request["request"]["entries"][0];
    assert_eq!(entry["kind"], "prompt");
    assert!(entry["content"].as_str().unwrap().contains("an update"));
    assert_eq!(entry["intent"], "follow_up");
    assert!(
        receipt.text.contains("which stays open")
            && receipt.text.contains("once the user has answered")
            && !receipt.text.contains("delivered as steer"),
        "{}",
        receipt.text
    );
    control.host.port().close();
}

#[tokio::test]
async fn default_send_queues_behind_open_card() {
    open_card_queues_message(9_312, None).await;
}

#[tokio::test]
async fn steer_send_queues_behind_open_card() {
    open_card_queues_message(9_313, Some("steer")).await;
}

#[tokio::test]
async fn follow_up_send_queues_behind_open_card() {
    open_card_queues_message(9_314, Some("follow_up")).await;
}

async fn answered_card_board_state(port: u64, succeeds: bool) {
    let mut child = tab("b");
    child["asks"] = json!([{
        "id": "card-one",
        "request": { "id": "card-one", "method": "confirm", "title": "Continue the original work?" }
    }]);
    let (control, _, mut channel, _fixture) = rig(
        port,
        state(vec![tab("a"), child]),
        Tuning::default(),
        move |method, args| {
            if method == "answer" && !succeeds {
                Err("The live question rejected the answer".into())
            } else {
                main_replies(method, args)
            }
        },
    );
    control.child_asked("a", "b", "card-one").await.unwrap();
    delivered(&mut channel).await;
    let before = control.host.state();
    let before = control.report_fields(&before, &before.tabs[1]);
    assert_eq!(before.get("waiting"), Some(&json!(true)));
    let result = control
        .run(
            "a",
            "ompdesk_session_answer",
            json!({ "session": "b", "request": "card-one", "approve": true }),
            None,
        )
        .await;
    assert_eq!(result.is_error, !succeeds, "{}", result.text);
    if succeeds {
        crate::ports::apply_state(
            control.host.port(),
            1,
            &state(vec![tab("a"), tab("b")]).to_string(),
        )
        .unwrap();
    }
    let current = control.host.state();
    assert_eq!(current.tabs[1].asks.is_empty(), succeeds);
    let after = control.report_fields(&current, &current.tabs[1]);
    assert_eq!(after.get("report"), before.get("report"));
    assert_eq!(after.get("waiting") == Some(&json!(true)), !succeeds);
    control.host.port().close();
}

#[tokio::test]
async fn a_successful_live_card_answer_does_not_restore_question_waiting_on_the_board() {
    answered_card_board_state(9_350, true).await;
}

#[tokio::test]
async fn a_failed_live_card_answer_keeps_the_original_question_waiting() {
    answered_card_board_state(9_351, false).await;
}

#[tokio::test]
async fn answering_an_old_card_does_not_clear_a_new_question_admitted_while_it_waits() {
    use crate::agentctl::runtime::tests::native_rig_async;

    let mut child = tab("b");
    child["asks"] = json!([{
        "id": "card-one",
        "request": { "id": "card-one", "method": "confirm", "title": "The first question" }
    }]);
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let entered = Arc::new(Mutex::new(Some(entered_tx)));
    let held = Arc::new(Mutex::new(Some(release_rx)));
    let (control, _, mut channel, _fixture) = native_rig_async(
        9_352,
        state(vec![tab("a"), child]),
        Caps::default(),
        &Files::default(),
        Tuning::default(),
        move |method, args| {
            let reply = if method == "answer" {
                entered.lock().unwrap().take().unwrap().send(()).unwrap();
                held.lock().unwrap().take()
            } else {
                None
            };
            async move {
                if let Some(reply) = reply {
                    reply.await.expect("held live answer was not released")
                } else {
                    main_replies(&method, &args)
                }
            }
        },
    );
    control.child_asked("a", "b", "card-one").await.unwrap();
    let first = delivered(&mut channel).await;
    let answering = control.run(
        "a",
        "ompdesk_session_answer",
        json!({ "session": "b", "request": "card-one", "approve": true }),
        None,
    );
    tokio::pin!(answering);
    tokio::select! {
        result = &mut answering => panic!("answer completed before its actual host reply: {}", result.text),
        entered = entered_rx => entered.expect("the live card answer was not entered"),
    }
    let mut replacement = tab("b");
    replacement["asks"] = json!([{
        "id": "card-two",
        "request": { "id": "card-two", "method": "confirm", "title": "The new question" }
    }]);
    crate::ports::apply_state(
        control.host.port(),
        1,
        &state(vec![tab("a"), replacement]).to_string(),
    )
    .unwrap();
    control.child_asked("a", "b", "card-two").await.unwrap();
    let second = delivered(&mut channel).await;
    assert_ne!(
        first["request"]["entries"][0]["deliveryId"],
        second["request"]["entries"][0]["deliveryId"]
    );
    release_tx.send(Ok(Value::Null)).unwrap();
    let result = answering.await;
    assert!(!result.is_error, "{}", result.text);
    let current = control.host.state();
    assert_eq!(current.tabs[1].asks[0].id, "card-two");
    let fields = control.report_fields(&current, &current.tabs[1]);
    assert_eq!(fields.get("waiting"), Some(&json!(true)));
    assert!(
        fields["report"]["text"]
            .as_str()
            .unwrap()
            .contains("The new question")
    );
    control.host.port().close();
}

#[tokio::test(start_paused = true)]
async fn distinct_pending_native_progress_coalesces_and_done_supersedes_without_orphaning_callers()
{
    use std::future::{Future, poll_fn};
    use std::task::Poll;
    use std::time::Duration;

    use crate::agentctl::rules::mail::{MAIL_COALESCE_MS, Mail, MailKind, Posted};

    async fn pending<F: Future>(mut future: std::pin::Pin<&mut F>) {
        poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
    }

    let (control, asked, mut channel, _fixture) = rig(
        9_353,
        state(vec![tab("a"), tab("b")]),
        Tuning::default(),
        main_replies,
    );
    let native = |id: &str, text: &str, kind: MailKind| {
        let mut mail = Mail::new(id, "b", "b", "a", kind, text, 1.0);
        let state = control.host.state();
        let child = state.tabs.iter().find(|tab| tab.tab_id == "b").unwrap();
        let parent = state.tabs.iter().find(|tab| tab.tab_id == "a").unwrap();
        mail.native_source = Some(
            crate::agentctl::runtime::inbox_source::report_source(
                &state, child, parent, &mail, text,
            )
            .unwrap(),
        );
        mail
    };
    let first = control
        .mailbox
        .post(native("pending-one", "first progress", MailKind::Progress));
    tokio::pin!(first);
    pending(first.as_mut()).await;
    let newest = control
        .mailbox
        .post(native("pending-two", "newest progress", MailKind::Progress));
    tokio::pin!(newest);
    pending(newest.as_mut()).await;
    let superseded = first.await.unwrap_err();
    assert!(superseded.contains("before delivery"), "{superseded}");
    assert!(control.host.outbox().unwrap().pending().is_empty());
    assert!(asked_with(&asked, "inbox").is_empty());
    assert_eq!(
        control.mailbox.state("b", "a").unwrap().last.text,
        "newest progress"
    );
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(MAIL_COALESCE_MS)).await;
    assert_eq!(newest.await.unwrap().posted, Posted::Delivered);
    let progress = delivered(&mut channel).await;
    let progress = &progress["request"]["entries"][0];
    assert_eq!(progress["details"]["id"], "pending-two");
    assert_eq!(progress["details"]["merged"], 1);
    assert_eq!(progress["triggerTurn"], false);

    let replaced = control.mailbox.post(native(
        "pending-three",
        "not yet delivered",
        MailKind::Progress,
    ));
    tokio::pin!(replaced);
    pending(replaced.as_mut()).await;
    let done = control
        .mailbox
        .post(native("pending-done", "finished", MailKind::Done));
    tokio::pin!(done);
    pending(done.as_mut()).await;
    let superseded = replaced.await.unwrap_err();
    assert!(superseded.contains("before delivery"), "{superseded}");
    assert_eq!(done.await.unwrap().posted, Posted::Delivered);
    let completion = delivered(&mut channel).await;
    let entries = completion["request"]["entries"].as_array().unwrap();
    let ids: Vec<_> = entries
        .iter()
        .map(|entry| entry["details"]["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["pending-two", "pending-done"]);
    let completion = entries
        .iter()
        .find(|entry| entry["details"]["id"] == "pending-done")
        .unwrap();
    assert!(completion["details"].get("merged").is_none());
    assert_eq!(completion["triggerTurn"], true);
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(MAIL_COALESCE_MS * 2)).await;
    tokio::task::yield_now().await;
    let accepted = asked_with(&asked, "inbox");
    let ids: Vec<_> = accepted
        .iter()
        .flat_map(|args| args["transfer"]["entries"].as_array().unwrap())
        .map(|entry| entry["logical"]["requestId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["pending-two", "pending-done"]);
    let status = control
        .host
        .inbox_status("a", "/s/a_1.jsonl", None)
        .await
        .unwrap();
    assert!(status.receipts.is_empty());
    let pending = control
        .receiving_inbox
        .as_ref()
        .unwrap()
        .ledger
        .pending(&status.receiver)
        .unwrap()
        .1;
    let ids: Vec<_> = pending
        .iter()
        .map(|entry| entry.logical.request_id.as_deref().unwrap())
        .collect();
    assert_eq!(ids, ["pending-two", "pending-done"]);
    assert!(control.host.outbox().unwrap().pending().is_empty());
    control.host.port().close();
}

#[tokio::test]
async fn receiver_owned_follow_ups_seed_d2_and_d4_after_the_source_relaunches() {
    use super::super::JournalFile;
    use crate::agentctl::inbox::InboxFiles;

    struct Directory(std::path::PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    for (case, count) in [1_u64, 3].into_iter().enumerate() {
        let dir = Directory(crate::fs::disk::make_temp_dir("ompdesk-relaunch-dispatch-").unwrap());
        let files = Files {
            send_outbox: Some(JournalFile {
                file: Some(dir.0.join("sends.json")),
            }),
            mail_outbox: Some(JournalFile {
                file: Some(dir.0.join("mail.json")),
            }),
            inbox: Some(InboxFiles {
                ledger: dir.0.join("receiver.json"),
                upload_user_data: dir.0.join("uploads"),
            }),
            ..Files::default()
        };
        let port = 9_360 + case as u64 * 2;
        {
            let (control, asked, mut channel, _fixture) =
                crate::agentctl::runtime::tests::native_rig(
                    port,
                    state(vec![tab("a"), tab("b")]),
                    Caps::default(),
                    &files,
                    Tuning::default(),
                    main_replies,
                );
            for n in 0..count {
                let result = control
                    .run(
                        "a",
                        "ompdesk_session_send",
                        json!({
                            "session": "b", "message": format!("before relaunch {n}"),
                            "request_id": format!("before-{n}"), "delivery": "follow_up"
                        }),
                        None,
                    )
                    .await;
                assert!(!result.is_error, "{}", result.text);
                delivered(&mut channel).await;
            }
            let transfers = asked_with(&asked, "inbox");
            let dispatches: Vec<_> = transfers
                .iter()
                .map(|args| args["transfer"]["entries"][0]["dispatch"].as_u64().unwrap())
                .collect();
            assert_eq!(dispatches, (1..=count).collect::<Vec<_>>());
            assert!(control.send_outbox.as_ref().unwrap().pending().is_empty());
            let status = control
                .host
                .inbox_status("b", "/s/b_1.jsonl", None)
                .await
                .unwrap();
            assert!(status.receipts.is_empty());
            assert_eq!(
                control
                    .receiving_inbox
                    .as_ref()
                    .unwrap()
                    .ledger
                    .pending(&status.receiver)
                    .unwrap()
                    .1
                    .len(),
                count as usize
            );
        }
        let (control, asked, mut channel, _fixture) = crate::agentctl::runtime::tests::native_rig(
            port + 1,
            state(vec![tab("a"), tab("b")]),
            Caps::default(),
            &files,
            Tuning::default(),
            main_replies,
        );
        assert!(control.send_outbox.as_ref().unwrap().pending().is_empty());
        assert!(!control.mailbox.knows("b"));
        let retry = control
            .run(
                "a",
                "ompdesk_session_send",
                json!({
                    "session": "b", "message": "before relaunch 0",
                    "request_id": "before-0", "delivery": "follow_up"
                }),
                None,
            )
            .await;
        assert!(!retry.is_error, "{}", retry.text);
        assert!(asked_with(&asked, "inbox").is_empty());
        let fresh = control
            .run(
                "a",
                "ompdesk_session_send",
                json!({
                    "session": "b", "message": "after relaunch",
                    "request_id": "after-relaunch", "delivery": "follow_up"
                }),
                None,
            )
            .await;
        assert!(!fresh.is_error, "{}", fresh.text);
        let transfers = asked_with(&asked, "inbox");
        assert_eq!(transfers.len(), 1);
        assert_eq!(
            transfers[0]["transfer"]["entries"][0]["dispatch"],
            count + 1
        );
        let fresh_id = &transfers[0]["transfer"]["entries"][0]["entry"]["deliveryId"];
        loop {
            let delivery = delivered(&mut channel).await;
            if delivery["request"]["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| &entry["deliveryId"] == fresh_id)
            {
                break;
            }
        }
        let status = control
            .host
            .inbox_status("b", "/s/b_1.jsonl", None)
            .await
            .unwrap();
        let pending = control
            .receiving_inbox
            .as_ref()
            .unwrap()
            .ledger
            .pending(&status.receiver)
            .unwrap()
            .1;
        let dispatches: Vec<_> = pending
            .iter()
            .map(|entry| entry.dispatch.unwrap())
            .collect();
        assert_eq!(dispatches, (1..=(count + 1) as i64).collect::<Vec<_>>());
        assert!(control.send_outbox.as_ref().unwrap().pending().is_empty());
        control.host.port().close();
    }
}
