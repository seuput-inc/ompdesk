//! Tests of the sessions family over a fake main: what `service.test.ts` checks of `ompdesk_sessions`,
//! `ompdesk_session_open`, `ompdesk_session_read`, `ompdesk_session_result` and `ompdesk_session_stop` that only
//! this family decides. The whole `service.test.ts` runs against the core at the cutover (the parity suite).

use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::agentctl::journal::system_clock;
use crate::agentctl::service::host::{Caps, HostState};
use crate::agentctl::service::tuning::Tuning;
use crate::agentctl::service::{AgentControl, Files, JournalFile};
use crate::ports::Port;

type Asked = Arc<Mutex<Vec<(String, Value)>>>;

/// Plays main: answers each ask with `reply(method, args, port)` and records it. `reply` also sees each tell (its
/// answer is dropped) and may push a snapshot through the port first, as main does before it answers.
fn play_main(
    port: Arc<Port<HostState>>,
    mut lines: tokio::io::Lines<BufReader<tokio::io::DuplexStream>>,
    reply: impl Fn(&str, &Value, &Port<HostState>) -> Result<Value, String> + Send + 'static,
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
            let answer = reply(&method, &args, &port);
            if let Some(ask) = data["ask"].as_u64() {
                match answer {
                    Ok(value) => crate::ports::apply_answer(&port, ask, Ok(&value.to_string())),
                    // Main never answers: the app quit while the core waited.
                    Err(message) if message == NO_ANSWER => {}
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

/// An ask main leaves unanswered (`play_main`).
const NO_ANSWER: &str = "<no answer>";

fn rig(
    id: u64,
    tabs: Vec<Value>,
    extra: Value,
    reply: impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static,
) -> (AgentControl, Asked) {
    rig_with(id, state_of(tabs, extra), move |method, args, _| {
        reply(method, args)
    })
}

/// Main's snapshot: `tabs`, each in window "w", plus `extra`'s fields.
fn state_of(tabs: Vec<Value>, extra: Value) -> Value {
    let windows: Map<String, Value> = tabs
        .iter()
        .map(|tab| (tab["tabId"].as_str().unwrap().to_owned(), json!("w")))
        .collect();
    let mut state = json!({ "enabled": true, "tabs": tabs, "windowOf": windows });
    for (key, value) in extra.as_object().cloned().unwrap_or_default() {
        state[key] = value;
    }
    state
}

fn rig_with(
    id: u64,
    state: Value,
    reply: impl Fn(&str, &Value, &Port<HostState>) -> Result<Value, String> + Send + 'static,
) -> (AgentControl, Asked) {
    rig_files(id, state, Caps::default(), &Files::default(), reply)
}

/// `rig_with` with the host's optional methods and the journal files the service keeps.
fn rig_files(
    id: u64,
    state: Value,
    caps: Caps,
    files: &Files,
    reply: impl Fn(&str, &Value, &Port<HostState>) -> Result<Value, String> + Send + 'static,
) -> (AgentControl, Asked) {
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
        AgentControl::new(port, caps, files, tuning, system_clock()),
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

/// Main's index: the caller, the child it opened whose tab closed, and a session nobody opened.
fn main_with_saved(method: &str, args: &Value) -> Result<Value, String> {
    let row = |id: &str, path: &str| json!({ "id": id, "path": path, "title": id, "cwd": "/w", "modified": "2026-11-20T00:00:00Z", "messages": 2, "status": "complete" });
    match method {
        "stored" => Ok(json!([
            row("boss1111", "/s/x_boss1111.jsonl"),
            row("kid22222", "/s/y_kid22222.jsonl"),
            row("else3333", "/s/z_else3333.jsonl"),
        ])),
        other => main_of(other, args),
    }
}

#[tokio::test]
async fn mine_lists_the_sessions_the_caller_opened_whose_tabs_closed_and_open_ones_in_any_window() {
    let far = tab("far", "/s/w_far44444.jsonl");
    let (control, _) = rig(
        7_390,
        vec![tab("boss", "/s/x_boss1111.jsonl"), far],
        json!({
            "windowOf": { "boss": "w", "far": "w2" },
            "parents": { "far": { "callerTabId": "boss" } },
            "closedChildren": [{ "path": "/s/y_kid22222.jsonl", "openedBySession": "/s/x_boss1111.jsonl", "title": "kid22222", "cwd": "/w", "closedAt": 5.0 }],
        }),
        main_with_saved,
    );
    let stored = control
        .run(
            "boss",
            "ompdesk_sessions",
            json!({ "scope": "stored", "mine": true }),
            None,
        )
        .await;
    assert!(!stored.is_error, "{}", stored.text);
    assert!(stored.text.contains("kid22222"), "{}", stored.text);
    assert!(!stored.text.contains("else3333"), "{}", stored.text);
    assert!(!stored.text.contains("boss1111"), "{}", stored.text);
    let open = control
        .run("boss", "ompdesk_sessions", json!({ "mine": true }), None)
        .await;
    assert!(!open.is_error, "{}", open.text);
    assert!(open.text.contains("- far \"far\""), "{}", open.text);
    control.host.port().close();
}

#[tokio::test]
async fn a_view_joined_only_to_reach_a_session_closes_when_the_call_ends() {
    // The view main makes is already in the window (no session file yet), ready.
    let mut view = tab("view1", "");
    view.as_object_mut().unwrap().remove("sessionPath");
    let (control, asked) = rig(
        7_391,
        vec![tab("boss", "/s/x_boss1111.jsonl"), view],
        json!({}),
        |method, args| match method {
            "stored" => Ok(
                json!([{ "id": "far55555", "path": "/s/far_far55555.jsonl", "title": "Far", "cwd": "/w", "elsewhere": { "work": "idle" } }]),
            ),
            "spawn" => Ok(json!({ "tabId": "view1" })),
            other => main_of(other, args),
        },
    );
    let closes = |asked: &Asked| {
        names(asked, "view")
            .into_iter()
            .filter(|view| view["event"]["how"] == "close")
            .map(|view| view["event"]["tabId"].clone())
            .collect::<Vec<_>>()
    };
    let answered = control
        .run(
            "boss",
            "ompdesk_session_answer",
            json!({ "session": "far55555", "choice": "yes" }),
            None,
        )
        .await;
    assert_eq!(names(&asked, "spawn").len(), 1, "{}", answered.text);
    assert_eq!(closes(&asked), vec![json!("view1")], "{}", answered.text);
    // A show joins to be seen: that view stays.
    control
        .run(
            "boss",
            "ompdesk_tab_focus",
            json!({ "session": "far55555" }),
            None,
        )
        .await;
    assert_eq!(names(&asked, "spawn").len(), 2);
    assert_eq!(closes(&asked).len(), 1);
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

/// The commands main was asked to run on `tab_id`, in order.
fn child_commands(asked: &Asked, tab_id: &str) -> Vec<Value> {
    names(asked, "command")
        .into_iter()
        .filter(|args| args["tabId"] == tab_id)
        .map(|args| args["command"].clone())
        .collect()
}

#[tokio::test]
async fn an_open_cut_off_by_a_quit_gives_its_child_the_setup_and_first_message_once_after_the_relaunch()
 {
    // 19 Nov 2026: a child opened during the update's restart countdown came back "not started", untitled and
    // without its brief; the opener had to send it again by hand.
    let dir = std::env::temp_dir().join(format!("open-first-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let files = Files {
        send_outbox: Some(JournalFile {
            file: Some(dir.join("send-outbox.json")),
        }),
        ..Files::default()
    };
    let caps = Caps {
        sent_marks: true,
        ..Caps::default()
    };
    let brief = json!({ "message": "Title: do it\nbody", "folder": "/w", "mode": "plan" });

    // Quit while the first message is on its way: main never answers it, and the core goes with the app.
    let (before, asked_before) = rig_files(
        7_320,
        state_of(
            vec![tab("a", "/s/x_1.jsonl"), tab("c1", "/s/c_1.jsonl")],
            json!({}),
        ),
        caps,
        &files,
        |method, args, _| match method {
            "spawn" => Ok(json!({ "tabId": "c1" })),
            "sentMarks" => Ok(json!({ "instance": "omp-1", "journaled": [] })),
            "command" if args["command"]["type"] == "prompt" => Err(NO_ANSWER.to_owned()),
            other => main_of(other, args),
        },
    );
    let open = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        before.run("a", "ompdesk_session_open", brief.clone(), None),
    )
    .await;
    assert!(
        open.is_err(),
        "the open was cut off while its first message was on its way"
    );
    let sent_before: Vec<Value> = child_commands(&asked_before, "c1")
        .into_iter()
        .map(|command| command["type"].clone())
        .collect();
    assert_eq!(
        sent_before,
        vec![
            json!("agent_control_worker"),
            json!("set_plan_mode"),
            json!("prompt")
        ]
    );
    before.host.port().close();
    drop(before);

    // The relaunch restores the child under another tab id, a new omp that never had the message.
    let journaled = Arc::new(Mutex::new(false));
    let journal = journaled.clone();
    let (after, asked) = rig_files(
        7_321,
        state_of(
            vec![tab("a", "/s/x_1.jsonl"), tab("c9", "/s/c_1.jsonl")],
            json!({}),
        ),
        caps,
        &files,
        move |method, args, _| match method {
            "sentMarks" if *journal.lock().unwrap() => {
                Ok(json!({ "instance": "omp-2", "journaled": args["marks"] }))
            }
            "sentMarks" => Ok(json!({ "instance": "omp-2", "journaled": [] })),
            // A new omp has no turn running: its bridge sends nothing and says so, and main prompts it.
            "command" if args["command"]["type"] == "agent_control_aside" => {
                Ok(json!({ "success": true, "data": { "idle": true } }))
            }
            other => main_of(other, args),
        },
    );
    after.redeliver_sends().await.unwrap();
    let commands = child_commands(&asked, "c9");
    let kinds: Vec<Value> = commands
        .iter()
        .map(|command| command["type"].clone())
        .collect();
    assert_eq!(
        kinds,
        vec![
            json!("agent_control_worker"),
            json!("set_plan_mode"),
            json!("agent_control_aside"),
            json!("prompt")
        ]
    );
    let message = commands[3]["message"].as_str().unwrap();
    assert!(message.contains("[ompdesk dispatch d1:"), "{message}");
    assert!(message.contains("Title: do it"), "{message}");

    // The same omp holds it now: never again, and once its journal has it the record goes.
    after.redeliver_sends().await.unwrap();
    assert_eq!(
        child_commands(&asked, "c9")
            .iter()
            .filter(|c| c["type"] == "prompt")
            .count(),
        1
    );
    *journaled.lock().unwrap() = true;
    after.redeliver_sends().await.unwrap();
    assert_eq!(
        child_commands(&asked, "c9")
            .iter()
            .filter(|c| c["type"] == "prompt")
            .count(),
        1
    );
    let left = std::fs::read_to_string(dir.join("send-outbox.json")).unwrap_or_default();
    assert!(!left.contains("dispatch d1"), "{left}");
    after.host.port().close();
    let _ = std::fs::remove_dir_all(&dir);
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
    let mut child = tab("b", "/s/y_2.jsonl");
    child["closeTurn"] = json!({ "pool": 2, "entry": 3, "turn": 0 });
    let (control, asked) = rig(
        7_309,
        vec![tab("a", "/s/x_1.jsonl"), child],
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
        "\"b\" is still open: its window did not answer the close within 0.03 s, so its page is not running (a stuck window closes nothing and shows nothing new). Ask the user to look at that window; its session is saved either way."
    );
    assert!(names(&asked, "confirm").is_empty());
    let view = &names(&asked, "view")[0];
    assert_eq!(view["event"]["tabId"], "b");
    assert_eq!(view["event"]["how"], "close");
    assert!(view["event"]["closeId"].is_u64());
    assert!(view["event"].get("expectedTurn").is_none());
    // The tab is marked closing only while the call runs.
    assert!(!control.mem().closing.contains("b"));
    control.host.port().close();
}

#[tokio::test]
async fn only_a_stamped_web_orphan_is_released_and_a_requested_close_carries_no_stamp() {
    let mut child = tab("kid", "/s/kid.jsonl");
    child["autoClosable"] = json!(true);
    child["webEdits"] = json!("clean");
    let mut unstamped = child.clone();
    unstamped["tabId"] = json!("unstamped");
    let turn = json!({ "pool": 5, "entry": 8, "turn": 0 });
    child["closeTurn"] = turn.clone();
    let mut unnumbered = child.clone();
    unnumbered["tabId"] = json!("unnumbered");
    unnumbered["lastRun"] = json!({ "stopReason": "stop" });
    let (control, asked) = rig(
        7_317,
        vec![tab("boss", "/s/boss.jsonl"), child, unstamped, unnumbered],
        json!({ "parents": { "kid": { "callerTabId": "boss" } } }),
        |method, args| match method {
            "release" => Ok(json!(false)),
            other => main_of(other, args),
        },
    );
    control
        .close_orphans(
            vec!["unstamped".into(), "unnumbered".into(), "kid".into()],
            None,
        )
        .await;
    let manual = control
        .run(
            "boss",
            "ompdesk_session_stop",
            json!({ "session": "kid", "close": true }),
            None,
        )
        .await;
    assert!(manual.is_error, "main kept the tab");
    assert_eq!(
        names(&asked, "release"),
        [
            json!({ "callerTabId": "kid", "tabId": "kid", "expectedTurn": turn }),
            json!({ "callerTabId": "boss", "tabId": "kid" }),
        ]
    );
    assert!(names(&asked, "view").is_empty());
    assert!(control.fates().find("kid").is_none());
    control.host.port().close();
}

#[tokio::test]
async fn a_caller_that_goes_while_its_close_waits_never_makes_the_open_target_read_closed() {
    // The caller's own tab leaves (its window closed) right after it asked; the target stays open and its window
    // never answers. Only the target's own row says whether it closed, not the caller's view of the tabs.
    let (control, asked) = rig_with(
        7_314,
        state_of(
            vec![tab("a", "/s/x_1.jsonl"), tab("b", "/s/y_2.jsonl")],
            json!({}),
        ),
        |method, args, port| match method {
            "view" if args["event"]["how"] == "close" => {
                let only_target = state_of(vec![tab("b", "/s/y_2.jsonl")], json!({}));
                crate::ports::apply_state(port, 10, &only_target.to_string()).unwrap();
                Ok(Value::Null)
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
    assert!(outcome.is_error, "{}", outcome.text);
    assert!(
        outcome
            .text
            .starts_with("\"b\" is still open: its window did not answer the close"),
        "{}",
        outcome.text
    );
    assert!(names(&asked, "mail").is_empty());
    assert!(control.fates().find("b").is_none());
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

const DESK_ID: &str = "01a1ed95-53b0-752a-a272-9c911a8499c4";
const DESK_PATH: &str = "C:/s/z_01a1ed95-53b0-752a-a272-9c911a8499c4.jsonl";

/// This window ("a") with `tabs`, and the paired host "Desk".
fn desk_state(tabs: Vec<Value>) -> Value {
    let mut all = vec![tab("a", "/s/x_1.jsonl")];
    all.extend(tabs);
    state_of(
        all,
        json!({ "devices": [{ "id": "d1", "name": "Desk", "state": "online" }] }),
    )
}

/// The tab this app has on Desk's session: `viewing` when Desk gave a view of a tab it holds for someone else.
fn desk_tab(id: &str, viewing: bool) -> Value {
    let mut tab = tab(id, DESK_PATH);
    tab["title"] = json!("Report gap");
    tab["device"] = json!("d1");
    tab["deviceName"] = json!("Desk");
    if viewing {
        tab["viewing"] = json!(true);
    }
    tab
}

/// Plays main for a saved session Desk runs in a tab no window here holds (`holder` as Desk's summaries name the
/// device that tab runs for; none: Desk's own window): the join opens tab "j" (`viewing` when Desk answers with a
/// view), and the window's close drops it.
fn desk_main(
    holder: Option<&'static str>,
    viewing: bool,
) -> impl Fn(&str, &Value, &Port<HostState>) -> Result<Value, String> + Send + 'static {
    let seq = std::sync::atomic::AtomicU64::new(10);
    move |method, args, port| {
        let push = |tabs: Vec<Value>| {
            let state = desk_state(tabs).to_string();
            let seq = seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            crate::ports::apply_state(port, seq, &state).unwrap();
        };
        match method {
            "stored" if args["device"] == "d1" => {
                let elsewhere =
                    holder.map_or_else(|| json!({}), |holder| json!({ "holder": holder }));
                Ok(
                    json!([{ "id": DESK_ID, "path": DESK_PATH, "title": "Report gap", "cwd": "C:/w", "modified": "2026-11-19", "messages": 4, "status": "idle", "device": "d1", "deviceName": "Desk", "elsewhere": elsewhere }]),
                )
            }
            "spawn" => {
                push(vec![desk_tab("j", viewing)]);
                Ok(json!({ "tabId": "j" }))
            }
            "view" if args["event"]["how"] == "close" => {
                push(Vec::new());
                Ok(Value::Null)
            }
            other => main_of(other, args),
        }
    }
}

#[tokio::test]
async fn closing_a_saved_session_a_paired_host_still_runs_for_this_computer_closes_that_tab() {
    // 19 Nov 2026: the Mac mini's window lost two children Desk ran for it; the list said "open in a tab Desk runs
    // for Mac mini" and a close answered "not open in any tab: nothing to stop or close" while Desk's omp ran on.
    let (control, asked) = rig_with(
        7_311,
        desk_state(Vec::new()),
        desk_main(Some("Mini"), false),
    );
    let outcome = control
        .run(
            "a",
            "ompdesk_session_stop",
            json!({ "session": DESK_ID, "close": true }),
            None,
        )
        .await;
    assert!(!outcome.is_error, "{}", outcome.text);
    assert_eq!(
        outcome.text,
        "Closed \"Report gap\" (its session stays saved)."
    );
    let spawn = &names(&asked, "spawn")[0]["request"];
    assert_eq!(spawn["sessionPath"], DESK_PATH);
    assert_eq!(spawn["device"], "d1");
    assert_eq!(spawn["join"], true);
    let views = names(&asked, "view");
    assert_eq!(views.len(), 1);
    assert_eq!(views[0]["event"]["tabId"], "j");
    assert_eq!(views[0]["event"]["how"], "close");
    control.host.port().close();
}

#[tokio::test]
async fn closing_a_view_of_a_tab_another_computer_holds_says_that_tab_stays_open() {
    // 14 Nov 2026: a close answered "Closed" while the session stayed open in a tab on the MacBook: the tab here was
    // a view of the MacBook window's tab, and closing a view only leaves it.
    let expected = "\"Report gap\" is still open in a tab on Desk (that computer's own window, or a tab it runs for another device): this app only viewed that tab, so the close ended this app's view and left that tab and its omp running. A tab another computer's window holds closes only there: ask the user to close it there; its session is saved either way.";
    let (control, asked) = rig_with(
        7_312,
        desk_state(vec![desk_tab("v", true)]),
        |method, args, port| match method {
            "view" if args["event"]["how"] == "close" => {
                crate::ports::apply_state(port, 10, &desk_state(Vec::new()).to_string()).unwrap();
                Ok(Value::Null)
            }
            other => main_of(other, args),
        },
    );
    let outcome = control
        .run(
            "a",
            "ompdesk_session_stop",
            json!({ "session": "v", "close": true }),
            None,
        )
        .await;
    assert!(outcome.is_error);
    assert_eq!(outcome.text, expected);
    assert_eq!(names(&asked, "view").len(), 1);
    // Nothing was closed that the close would tell: no note in either session, no closed record.
    assert!(names(&asked, "mail").is_empty());
    assert!(control.fates().find("v").is_none());
    control.host.port().close();

    // The same session named by its saved id while no tab here holds it: joined as a view, and told the same.
    let (control, asked) = rig_with(7_313, desk_state(Vec::new()), desk_main(None, true));
    let outcome = control
        .run(
            "a",
            "ompdesk_session_stop",
            json!({ "session": DESK_ID, "close": true }),
            None,
        )
        .await;
    assert!(outcome.is_error);
    assert_eq!(outcome.text, expected);
    assert_eq!(names(&asked, "view")[0]["event"]["tabId"], "j");
    control.host.port().close();
}

/// This window ("a") and an asleep tab "v" here on Desk's session (restored by a relaunch, not shown since), with what
/// the tab Desk itself holds on it does now, as main reads it from Desk's summary (`hostOpen`).
fn asleep_on_desk(work: &str) -> Value {
    let mut asleep = desk_tab("v", false);
    asleep["status"] = json!("asleep");
    asleep["hostOpen"] = json!({ "work": work });
    desk_state(vec![asleep])
}

#[tokio::test]
async fn an_asleep_tab_on_a_session_its_host_runs_reads_as_the_host_runs_it() {
    // 20 Nov 2026 (C12): after a relaunch the MacBook's list and result read SeuOffice's main tab, which the Mac mini's
    // window ran (its turn resumed there), as "not started (it starts when shown or messaged)" for 26 minutes: the
    // MacBook's own tab on it was restored asleep, and the line read that tab, never the host's summary every row reads.
    let (control, _) = rig_with(7_316, asleep_on_desk("turn"), |method, args, _| {
        main_of(method, args)
    });
    let list = control
        .run(
            "a",
            "ompdesk_sessions",
            json!({ "status": "running" }),
            None,
        )
        .await;
    assert!(!list.is_error, "{}", list.text);
    assert!(
        list.text.contains("- v \"Report gap\" (saved id 01a1ed95-53b0-752a-a272-9c911a8499c4)\n  running (open in a tab on Desk; this app's tab on it starts when shown or messaged); folder /w"),
        "{}",
        list.text
    );
    let result = control
        .run(
            "a",
            "ompdesk_session_result",
            json!({ "session": "v", "wait": true, "timeout_seconds": 0 }),
            None,
        )
        .await;
    assert!(!result.is_error, "{}", result.text);
    assert!(
        result.text.starts_with("Still running after waiting 0 s (0/1 finished).\n\"Report gap\" [v]: running (open in a tab on Desk;"),
        "{}",
        result.text
    );
    control.host.port().close();
}

#[tokio::test]
async fn an_asleep_tab_whose_host_finished_answers_from_the_saved_file() {
    let (control, asked) = rig_with(
        7_315,
        asleep_on_desk("idle"),
        |method, args, _| match method {
            "storedMessages" => Ok(json!([
                { "role": "user", "content": "go", "timestamp": 1 },
                { "role": "assistant", "content": [{ "type": "text", "text": "done there" }], "stopReason": "stop", "timestamp": 2 }
            ])),
            other => main_of(other, args),
        },
    );
    let result = control
        .run(
            "a",
            "ompdesk_session_result",
            json!({ "session": "v", "wait": true, "timeout_seconds": 5 }),
            None,
        )
        .await;
    assert!(!result.is_error, "{}", result.text);
    assert!(
        result.text.starts_with("\"Report gap\" [v]: idle (open in a tab on Desk; this app's tab on it starts when shown or messaged)."),
        "{}",
        result.text
    );
    assert!(
        result.text.ends_with("Last answer:\ndone there"),
        "{}",
        result.text
    );
    let read = &names(&asked, "storedMessages")[0]["session"];
    assert_eq!(read["path"], DESK_PATH);
    assert_eq!(read["device"], "d1");
    control.host.port().close();
}
