//! Tests of the sessions family over a fake main: what `service.test.ts` checks of `ompdesk_sessions`,
//! `ompdesk_session_open`, `ompdesk_session_read`, `ompdesk_session_result` and `ompdesk_session_stop` that only
//! this family decides. The whole `service.test.ts` runs against the core at the cutover (the parity suite).

use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::agentctl::journal::system_clock;
use crate::agentctl::service::host::{Caps, HostState};
use crate::agentctl::service::tuning::Tuning;
use crate::agentctl::service::{AgentControl, Files};
use crate::ports::Port;

type Asked = Arc<Mutex<Vec<(String, Value)>>>;

/// Plays main: answers each ask with `reply(method, args)` and records it.
fn play_main(
    port: Arc<Port<HostState>>,
    mut lines: tokio::io::Lines<BufReader<tokio::io::DuplexStream>>,
    reply: impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static,
) -> Asked {
    let asked: Asked = Arc::default();
    let record = asked.clone();
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            let event: Value = serde_json::from_str(&line).unwrap();
            let data = &event["data"];
            let method = data["method"].as_str().unwrap_or("").to_owned();
            let args = data["args"].clone();
            record.lock().unwrap().push((method.clone(), args.clone()));
            if let Some(ask) = data["ask"].as_u64() {
                match reply(&method, &args) {
                    Ok(value) => crate::ports::apply_answer(&port, ask, Ok(&value.to_string())),
                    Err(message) => crate::ports::apply_answer(&port, ask, Err((&message, None))),
                }
            }
        }
    });
    asked
}

fn tab(id: &str, path: &str) -> Value {
    json!({ "tabId": id, "title": id, "cwd": "/w", "status": "ready", "busy": false, "asks": [], "hidden": false, "sessionPath": path })
}

fn rig(
    id: u64,
    tabs: Vec<Value>,
    extra: Value,
    reply: impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static,
) -> (AgentControl, Asked) {
    let windows: Map<String, Value> = tabs
        .iter()
        .map(|tab| (tab["tabId"].as_str().unwrap().to_owned(), json!("w")))
        .collect();
    let mut state = json!({ "enabled": true, "tabs": tabs, "windowOf": windows });
    for (key, value) in extra.as_object().cloned().unwrap_or_default() {
        state[key] = value;
    }
    let (writer, reader) = tokio::io::duplex(1 << 20);
    let (tx, _task) = crate::wire::spawn_writer(writer);
    let events = crate::server::test_events(&tx);
    std::mem::forget(tx);
    let port =
        Port::<HostState>::open(&events, id, serde_json::from_value(state).unwrap()).unwrap();
    let asked = play_main(port.clone(), BufReader::new(reader).lines(), reply);
    let tuning = Tuning {
        close_wait_ms: 30,
        abort_before_close_ms: 30,
        omp_exit_wait_ms: 30,
        stop_wait_ms: 100,
        ..Tuning::default()
    };
    (
        AgentControl::new(
            port,
            Caps::default(),
            &Files::default(),
            tuning,
            system_clock(),
        ),
        asked,
    )
}

fn main_of(method: &str, args: &Value) -> Result<Value, String> {
    match method {
        "args.parse" => Ok(json!({ "ok": true, "args": args["args"] })),
        "stored" => Ok(json!([])),
        "command" => Ok(json!({ "success": true, "data": {} })),
        "mail" | "exited" => Ok(Value::Null),
        "release" => Ok(json!(true)),
        other => Err(format!("fake main has no {other}")),
    }
}

fn names(asked: &Asked, method: &str) -> Vec<Value> {
    asked
        .lock()
        .unwrap()
        .iter()
        .filter(|(asked, _)| asked == method)
        .map(|(_, args)| args.clone())
        .collect()
}

#[tokio::test]
async fn a_list_names_each_session_of_the_window_and_the_stored_ones_are_a_scope_away() {
    let (control, _) = rig(
        7_301,
        vec![
            tab("a", "/s/x_aaaa1111.jsonl"),
            tab("b", "/s/y_bbbb2222.jsonl"),
        ],
        json!({}),
        main_of,
    );
    let outcome = control.run("a", "ompdesk_sessions", json!({}), None).await;
    assert!(!outcome.is_error, "{}", outcome.text);
    assert!(outcome.text.starts_with("2 sessions in this window:\n- a \"a\" (saved id aaaa1111) [this session]\n  idle; folder /w"));
    assert!(
        outcome
            .text
            .contains("- b \"b\" (saved id bbbb2222)\n  idle; folder /w")
    );
    assert!(
        outcome
            .text
            .contains("Saved sessions, closed ones too: scope stored.\nNo paired devices.")
    );
    let mine = control
        .run(
            "a",
            "ompdesk_sessions",
            json!({ "status": "running" }),
            None,
        )
        .await;
    assert!(
        mine.text.starts_with("0 sessions in this window:\n"),
        "{}",
        mine.text
    );
    control.host.port().close();
}

#[tokio::test]
async fn a_stored_list_refuses_a_status_filter() {
    let (control, _) = rig(7_302, vec![tab("a", "/s/x_1.jsonl")], json!({}), main_of);
    let outcome = control
        .run(
            "a",
            "ompdesk_sessions",
            json!({ "scope": "stored", "status": "idle" }),
            None,
        )
        .await;
    assert_eq!(
        outcome.text,
        "status filters open sessions; leave it out with scope stored."
    );
    control.host.port().close();
}

#[tokio::test]
async fn an_open_marks_the_child_a_worker_and_sends_its_message_wrapped() {
    let (control, asked) = rig(
        7_303,
        vec![tab("a", "/s/x_1.jsonl"), tab("c1", "/s/c_1.jsonl")],
        json!({}),
        |method, args| match method {
            "spawn" => Ok(json!({ "tabId": "c1" })),
            other => main_of(other, args),
        },
    );
    let outcome = control
        .run(
            "a",
            "ompdesk_session_open",
            json!({ "message": "Title: do it\nbody", "folder": "/w" }),
            None,
        )
        .await;
    assert!(!outcome.is_error, "{}", outcome.text);
    assert!(outcome.text.starts_with("Opened session c1 in /w. It is working on your message.\nThey report back to you with ompdesk_report"), "{}", outcome.text);
    let commands: Vec<Value> = names(&asked, "command")
        .into_iter()
        .map(|args| args["command"].clone())
        .collect();
    assert_eq!(commands[0]["type"], "agent_control_worker");
    assert_eq!(commands[0]["from"], "a");
    assert_eq!(commands[1]["type"], "prompt");
    assert_eq!(commands[1]["streamingBehavior"], "followUp");
    assert!(
        commands[1]["message"]
            .as_str()
            .unwrap()
            .contains("[ompdesk dispatch d1:")
    );
    // The open's own reservation is gone and the child is the caller's.
    assert_eq!(control.children_of("a"), vec!["c1".to_owned()]);
    let spawn = &names(&asked, "spawn")[0];
    assert_eq!(spawn["request"]["folder"], "/w");
    assert_eq!(spawn["request"]["task"], "do it");
    control.host.port().close();
}

#[tokio::test]
async fn an_open_that_cannot_set_the_child_up_names_every_failure() {
    let (control, _) = rig(
        7_304,
        vec![tab("a", "/s/x_1.jsonl"), tab("c1", "/s/c_1.jsonl")],
        json!({}),
        |method, args| match method {
            "spawn" => Ok(json!({ "tabId": "c1" })),
            "command" => Ok(json!({ "success": false, "error": "no way" })),
            other => main_of(other, args),
        },
    );
    let outcome = control
        .run("a", "ompdesk_session_open", json!({ "message": "x" }), None)
        .await;
    assert!(outcome.is_error);
    assert_eq!(
        outcome.text,
        "Could not open a session: Marking the session as a worker failed: no way"
    );
    control.host.port().close();
}

#[tokio::test]
async fn a_read_of_an_open_session_renders_its_newest_page() {
    let (control, _) = rig(
        7_305,
        vec![tab("a", "/s/x_1.jsonl"), tab("b", "/s/y_2.jsonl")],
        json!({}),
        |method, args| match method {
            "command" if args["command"]["type"] == "get_transcript_page" => Ok(json!({
                "success": true,
                "data": { "messages": [{ "role": "user", "content": "hello" }], "totalMessages": 1 }
            })),
            other => main_of(other, args),
        },
    );
    let outcome = control
        .run("a", "ompdesk_session_read", json!({ "session": "b" }), None)
        .await;
    assert!(!outcome.is_error, "{}", outcome.text);
    assert!(
        outcome.text.starts_with("\"b\": 1 message(s) of 1."),
        "{}",
        outcome.text
    );
    assert!(outcome.text.contains("hello"));
    control.host.port().close();
}

#[tokio::test]
async fn a_saved_session_reads_from_its_file_and_restarts_from_a_cursor_past_its_end() {
    let row = json!({ "id": "sid", "path": "/s/z_sid.jsonl", "title": "Old", "cwd": "/w", "modified": "2026-11-01", "messages": 2, "status": "idle" });
    let listed = row.clone();
    let (control, _) = rig(
        7_306,
        vec![tab("a", "/s/x_1.jsonl")],
        json!({}),
        move |method, args| match method {
            "stored" => Ok(json!([listed])),
            "storedMessages" => Ok(json!([
                { "role": "user", "content": "one" },
                { "role": "user", "content": "two" }
            ])),
            other => main_of(other, args),
        },
    );
    let outcome = control
        .run(
            "a",
            "ompdesk_session_read",
            json!({ "session": "sid", "before": "9", "limit": 1 }),
            None,
        )
        .await;
    assert!(!outcome.is_error, "{}", outcome.text);
    assert!(
        outcome
            .text
            .starts_with("The cursor \"9\" names no page of this session"),
        "{}",
        outcome.text
    );
    assert!(
        outcome
            .text
            .contains("\"Old\" (saved, not open): 1 message(s) of 2."),
        "{}",
        outcome.text
    );
    assert!(outcome.text.contains(
        "Earlier messages: ompdesk_session_read {\"session\":\"sid\",\"before\":\"1\"}."
    ));
    control.host.port().close();
}

#[tokio::test]
async fn a_result_without_wait_answers_at_once_and_marks_what_was_collected() {
    let (control, _) = rig(
        7_307,
        vec![tab("a", "/s/x_1.jsonl"), tab("b", "/s/y_2.jsonl")],
        json!({}),
        |method, args| match method {
            "command" if args["command"]["type"] == "get_last_assistant_text" => {
                Ok(json!({ "success": true, "data": { "text": "all done" } }))
            }
            other => main_of(other, args),
        },
    );
    let outcome = control
        .run(
            "a",
            "ompdesk_session_result",
            json!({ "session": "b" }),
            None,
        )
        .await;
    assert!(!outcome.is_error, "{}", outcome.text);
    assert!(
        outcome.text.contains("\"b\" [b]: idle."),
        "{}",
        outcome.text
    );
    assert!(
        outcome.text.ends_with("Last answer:\nall done"),
        "{}",
        outcome.text
    );
    assert!(control.mem().collected.contains("b"));
    control.host.port().close();
}

#[tokio::test]
async fn a_stop_of_a_session_the_user_looks_at_waits_for_a_turn_the_user_started() {
    let mut looked = tab("b", "/s/y_2.jsonl");
    looked["looked"] = json!(true);
    let (control, asked) = rig(
        7_308,
        vec![tab("a", "/s/x_1.jsonl"), looked],
        json!({}),
        |method, args| match method {
            "command" if args["command"]["type"] == "agent_control_turn" => {
                Ok(json!({ "success": true, "data": { "person": false } }))
            }
            other => main_of(other, args),
        },
    );
    let outcome = control
        .run(
            "a",
            "ompdesk_session_stop",
            json!({ "session": "b", "close": true }),
            None,
        )
        .await;
    assert!(outcome.is_error);
    assert!(outcome.text.starts_with("\"b\": it is in the user's view and you did not open it, and your current turn was not started by the user's own message"), "{}", outcome.text);
    assert!(outcome.text.ends_with("the same call works then."));
    assert!(names(&asked, "view").is_empty());
    control.host.port().close();
}

#[tokio::test]
async fn closing_a_resting_session_needs_no_card_and_a_tab_the_window_keeps_is_reported() {
    let (control, asked) = rig(
        7_309,
        vec![tab("a", "/s/x_1.jsonl"), tab("b", "/s/y_2.jsonl")],
        json!({}),
        main_of,
    );
    let outcome = control
        .run(
            "a",
            "ompdesk_session_stop",
            json!({ "session": "b", "close": true }),
            None,
        )
        .await;
    assert!(outcome.is_error);
    assert_eq!(
        outcome.text,
        "\"b\" is still open: its window kept the tab (it is that window's last tab, or it holds unsaved Files edits). Ask the user to close it; its session is saved either way."
    );
    assert!(names(&asked, "confirm").is_empty());
    let view = &names(&asked, "view")[0];
    assert_eq!(view["event"], json!({ "tabId": "b", "how": "close" }));
    // The tab is marked closing only while the call runs.
    assert!(!control.mem().closing.contains("b"));
    control.host.port().close();
}

#[tokio::test]
async fn a_delete_of_an_own_idle_child_removes_it_journals_it_and_remembers_the_fate() {
    let mut child = tab("c1", "/s/c_cccc3333.jsonl");
    child["title"] = json!("Child");
    let (control, asked) = rig(
        7_310,
        vec![tab("a", "/s/x_1.jsonl"), child],
        json!({ "parents": { "c1": { "callerTabId": "a" } } }),
        |method, args| match method {
            "deleteSession" => Ok(Value::Null),
            other => main_of(other, args),
        },
    );
    let outcome = control
        .run(
            "a",
            "ompdesk_session_stop",
            json!({ "session": "c1", "delete": true }),
            None,
        )
        .await;
    assert!(!outcome.is_error, "{}", outcome.text);
    assert_eq!(outcome.text, "Stopped, closed and deleted \"Child\".");
    assert_eq!(names(&asked, "deleteSession").len(), 1);
    let mails = names(&asked, "mail");
    assert_eq!(mails.len(), 2);
    assert_eq!(mails[0]["content"], "Deleted \"Child\".");
    assert_eq!(mails[0]["details"]["kind"], "note");
    assert_eq!(mails[0]["delivery"], json!({ "triggerTurn": false }));
    let fate = control.fates().find("c1").expect("a fate");
    assert_eq!(
        fate.state,
        crate::agentctl::journal::session_fates::FateState::Deleted
    );
    assert!(!control.mem().closing.contains("c1"));
    control.host.port().close();
}

async fn held_summary_does_not_hold_result(arrival: bool, until_any: bool, port_id: u64) {
    use std::collections::HashSet;
    use std::future::{Future, poll_fn};
    use std::task::Poll;
    use std::time::Duration;

    let mut tabs = vec![tab("a", "/s/a"), tab("b", "/s/b"), tab("c", "/s/c")];
    for tab in &mut tabs {
        tab["sessionPath"] = Value::Null;
    }
    let state: HostState = serde_json::from_value(json!({
        "enabled": true,
        "tabs": tabs,
        "windowOf": { "a": "w", "b": "w", "c": "w" }
    }))
    .unwrap();
    let (writer, reader) = tokio::io::duplex(1 << 20);
    let (tx, _writer) = crate::wire::spawn_writer(writer);
    let port = Port::open(&crate::server::test_events(&tx), port_id, state).unwrap();
    let control = AgentControl::new(
        port.clone(),
        Caps::default(),
        &Files::default(),
        Tuning::default(),
        system_clock(),
    );
    let state = control.host.state();
    let tabs = state.tabs("a").unwrap();
    let caller = tabs.iter().find(|tab| tab.tab_id == "a").unwrap();
    let targets: Vec<_> = ["b", "c"]
        .iter()
        .map(|id| {
            super::Target::Tab(Box::new(
                tabs.iter().find(|tab| tab.tab_id == *id).unwrap().clone(),
            ))
        })
        .collect();
    let args = super::ResultArgs {
        wait: Some(true),
        until: until_any.then(|| "any".to_owned()),
        timeout_seconds: Some(30),
        ..super::ResultArgs::default()
    };
    let result = control.result(caller, targets, args, true);
    tokio::pin!(result);
    let mut lines = BufReader::new(reader).lines();
    let mut requests = HashSet::new();
    let mut held = None;
    while requests.len() < 4 {
        let line = tokio::select! {
            biased;
            result = &mut result => panic!("result returned before the held-summary barrier: {result:?}"),
            line = lines.next_line() => line.unwrap().unwrap(),
        };
        let event: Value = serde_json::from_str(&line).unwrap();
        let data = &event["data"];
        assert_eq!(data["method"], "command");
        let tab_id = data["args"]["tabId"].as_str().unwrap();
        let command = data["args"]["command"]["type"].as_str().unwrap();
        assert!(["b", "c"].contains(&tab_id));
        assert!(["get_state", "get_last_assistant_text"].contains(&command));
        assert!(requests.insert((tab_id.to_owned(), command.to_owned())));
        let ask = data["ask"].as_u64().unwrap();
        if tab_id == "b" && command == "get_last_assistant_text" {
            held = Some(ask);
        } else {
            let response = json!({
                "success": true,
                "data": if command == "get_last_assistant_text" {
                    json!({ "text": "confirmed answer from c" })
                } else {
                    json!({})
                }
            });
            crate::ports::apply_answer(&port, ask, Ok(&response.to_string()));
        }
    }
    let held = held.expect("the actual Port summary answer stays withheld");
    if !until_any {
        if arrival {
            control.arrive("a");
        } else {
            tokio::time::advance(Duration::from_secs(30)).await;
        }
    }
    let outcome = poll_fn(|cx| {
        let Poll::Ready(outcome) = result.as_mut().poll(cx) else {
            panic!("the result still waits for an unanswered summary after its wake boundary");
        };
        Poll::Ready(outcome)
    })
    .await
    .unwrap();
    if until_any {
        assert!(!outcome.contains("Returned early:"), "{outcome}");
    } else {
        assert!(
            outcome.contains(if arrival {
                "Returned early: a message reached you"
            } else {
                "Still running after waiting 30 s"
            }),
            "{outcome}"
        );
        assert!(outcome.contains("1/2 finished"), "{outcome}");
    }
    assert!(outcome.contains("summary unconfirmed"), "{outcome}");
    assert!(outcome.contains("confirmed answer from c"), "{outcome}");
    assert!(!control.mem().collected.contains("b"));
    assert!(control.mem().collected.contains("c"));
    crate::ports::apply_answer(
        &port,
        held,
        Ok(r#"{"success":true,"data":{"text":"late answer from b"}}"#),
    );
    assert!(!control.mem().collected.contains("b"));
    port.close();
}

#[tokio::test(start_paused = true)]
async fn an_arrival_returns_while_a_real_port_summary_answer_is_still_held() {
    held_summary_does_not_hold_result(true, false, 7_320).await;
}

#[tokio::test(start_paused = true)]
async fn a_deadline_returns_while_a_real_port_summary_answer_is_still_held() {
    held_summary_does_not_hold_result(false, false, 7_321).await;
}

#[tokio::test(start_paused = true)]
async fn any_result_returns_a_completed_summary_while_another_port_answer_is_held() {
    held_summary_does_not_hold_result(false, true, 7_322).await;
}

#[tokio::test(start_paused = true)]
async fn an_arrival_during_saved_result_preparation_is_not_absorbed_by_the_wait_baseline() {
    use std::future::{Future, poll_fn};
    use std::task::Poll;

    let mut waiting = tab("b", "/s/b");
    waiting["sessionPath"] = Value::Null;
    let state: HostState = serde_json::from_value(json!({
        "enabled": true,
        "tabs": [tab("a", "/s/a"), waiting],
        "windowOf": { "a": "w", "b": "w" }
    }))
    .unwrap();
    let (writer, reader) = tokio::io::duplex(1 << 20);
    let (tx, _writer) = crate::wire::spawn_writer(writer);
    let port = Port::open(&crate::server::test_events(&tx), 7_323, state).unwrap();
    let control = AgentControl::new(
        port.clone(),
        Caps::default(),
        &Files::default(),
        Tuning::default(),
        system_clock(),
    );
    let state = control.host.state();
    let tabs = state.tabs("a").unwrap();
    let caller = tabs.iter().find(|tab| tab.tab_id == "a").unwrap();
    let targets = vec![
        super::Target::Tab(Box::new(
            tabs.iter().find(|tab| tab.tab_id == "b").unwrap().clone(),
        )),
        super::Target::Stored(Box::new(
            serde_json::from_value(json!({
                "id": "saved", "path": "/s/old_saved.jsonl", "title": "Saved"
            }))
            .unwrap(),
        )),
    ];
    let args = super::ResultArgs {
        wait: Some(true),
        timeout_seconds: Some(30),
        ..super::ResultArgs::default()
    };
    let result = control.result(caller, targets, args, true);
    tokio::pin!(result);
    let mut lines = BufReader::new(reader).lines();
    let line = tokio::select! {
        biased;
        result = &mut result => panic!("result returned before the saved-read barrier: {result:?}"),
        line = lines.next_line() => line.unwrap().unwrap(),
    };
    let event: Value = serde_json::from_str(&line).unwrap();
    let data = &event["data"];
    assert_eq!(data["method"], "storedMessages");
    assert_eq!(data["args"]["session"]["id"], "saved");
    assert_eq!(data["args"]["session"]["path"], "/s/old_saved.jsonl");
    let ask = data["ask"].as_u64().unwrap();
    control.arrive("a");
    crate::ports::apply_answer(&port, ask, Ok("[]"));
    let outcome = poll_fn(|cx| {
        let Poll::Ready(outcome) = result.as_mut().poll(cx) else {
            panic!("the arrival during preparation was absorbed by a later baseline");
        };
        Poll::Ready(outcome)
    })
    .await
    .unwrap();
    assert!(
        outcome.contains("Returned early: a message reached you"),
        "{outcome}"
    );
    assert!(outcome.contains("1/2 finished"), "{outcome}");
    assert!(outcome.contains("summary unconfirmed"), "{outcome}");
    assert!(outcome.contains("saved, not open in any tab"), "{outcome}");
    assert!(!control.mem().collected.contains("b"));
    port.close();
}

async fn a_held_stored_result_respects_its_wait_boundary(
    arrival: bool,
    waiting: bool,
    port_id: u64,
) {
    use std::collections::HashSet;
    use std::future::{Future, poll_fn};
    use std::task::Poll;
    use std::time::Duration;

    let state: HostState = serde_json::from_value(json!({
        "enabled": true,
        "tabs": [tab("a", "/s/a")],
        "windowOf": { "a": "w" }
    }))
    .unwrap();
    let (writer, reader) = tokio::io::duplex(1 << 20);
    let (tx, _writer) = crate::wire::spawn_writer(writer);
    let port = Port::open(&crate::server::test_events(&tx), port_id, state).unwrap();
    let control = AgentControl::new(
        port.clone(),
        Caps::default(),
        &Files::default(),
        Tuning::default(),
        system_clock(),
    );
    let state = control.host.state();
    let tabs = state.tabs("a").unwrap();
    let caller = tabs.iter().find(|tab| tab.tab_id == "a").unwrap();
    let targets = [("done", "Done"), ("held", "Held")]
        .into_iter()
        .map(|(id, title)| {
            super::Target::Stored(Box::new(
                serde_json::from_value(json!({
                    "id": id, "path": format!("/s/{id}.jsonl"), "title": title
                }))
                .unwrap(),
            ))
        })
        .collect();
    let args = super::ResultArgs {
        wait: Some(waiting),
        timeout_seconds: Some(30),
        ..super::ResultArgs::default()
    };
    let result = control.result(caller, targets, args, true);
    tokio::pin!(result);
    let mut lines = BufReader::new(reader).lines();
    let mut requests = HashSet::new();
    let mut held = None;
    while requests.len() < 2 {
        let line = tokio::select! {
            biased;
            result = &mut result => panic!("result returned before the stored-read barrier: {result:?}"),
            line = lines.next_line() => line.unwrap().unwrap(),
        };
        let event: Value = serde_json::from_str(&line).unwrap();
        let data = &event["data"];
        assert_eq!(data["method"], "storedMessages");
        let id = data["args"]["session"]["id"].as_str().unwrap();
        assert!(["done", "held"].contains(&id));
        assert!(requests.insert(id.to_owned()));
        assert_eq!(data["args"]["session"]["path"], format!("/s/{id}.jsonl"));
        let ask = data["ask"].as_u64().unwrap();
        if id == "held" {
            held = Some(ask);
        } else {
            crate::ports::apply_answer(&port, ask, Ok("[]"));
        }
    }
    let held = held.expect("the actual storedMessages response remains withheld");
    let blocked_while_held = control.is_blocked("a");
    poll_fn(|cx| {
        assert!(result.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    if arrival {
        control.arrive("a");
    } else {
        tokio::time::advance(Duration::from_secs(30)).await;
    }
    if !waiting {
        tokio::time::advance(Duration::from_secs(30)).await;
        poll_fn(|cx| {
            assert!(result.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        crate::ports::apply_answer(&port, held, Ok("[]"));
    }
    let outcome = poll_fn(|cx| {
        let Poll::Ready(outcome) = result.as_mut().poll(cx) else {
            panic!("the wait boundary is still blocked on its unanswered storedMessages read");
        };
        Poll::Ready(outcome)
    })
    .await
    .unwrap();
    assert!(outcome.contains("\"Done\" [done]: saved"), "{outcome}");
    assert!(outcome.contains("Last answer:\n(no answer)"), "{outcome}");
    if waiting {
        assert!(
            outcome.contains(if arrival {
                "Returned early: a message reached you"
            } else {
                "Still running after waiting 30 s"
            }),
            "{outcome}"
        );
        assert!(outcome.contains("1/2 finished"), "{outcome}");
        assert!(outcome.contains("[held]: summary unconfirmed"), "{outcome}");
        assert!(!outcome.contains("\"Held\" [held]: saved"), "{outcome}");
        // No response to `held` is supplied, even after the result has returned.
    } else {
        assert!(outcome.contains("\"Held\" [held]: saved"), "{outcome}");
        assert!(!outcome.contains("summary unconfirmed"), "{outcome}");
        assert!(!outcome.contains("Returned early:"), "{outcome}");
    }
    assert_eq!(blocked_while_held, waiting);
    assert!(!control.is_blocked("a"));
    assert!(control.mem().collected.is_empty());
    port.close();
}

#[tokio::test(start_paused = true)]
async fn an_arrival_returns_without_releasing_a_stored_messages_answer() {
    a_held_stored_result_respects_its_wait_boundary(true, true, 7_324).await;
}

#[tokio::test(start_paused = true)]
async fn a_deadline_returns_without_releasing_a_stored_messages_answer() {
    a_held_stored_result_respects_its_wait_boundary(false, true, 7_325).await;
}

#[tokio::test(start_paused = true)]
async fn a_nonwaiting_stored_result_keeps_waiting_for_its_actual_read_not_arrival_or_deadline() {
    a_held_stored_result_respects_its_wait_boundary(true, false, 7_326).await;
}
