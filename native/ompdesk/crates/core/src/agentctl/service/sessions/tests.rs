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
        "\"b\" is still open: its window did not answer the close within 0.03 s, so its page is not running (a stuck window closes nothing and shows nothing new). Ask the user to look at that window; its session is saved either way."
    );
    assert!(names(&asked, "confirm").is_empty());
    let view = &names(&asked, "view")[0];
    assert_eq!(view["event"]["tabId"], "b");
    assert_eq!(view["event"]["how"], "close");
    assert!(view["event"]["closeId"].is_u64());
    // The tab is marked closing only while the call runs.
    assert!(!control.mem().closing.contains("b"));
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

// ---- the project boundary (`rules/boundary.rs`, `service/boundary.rs`) ------------------------------------------------

use crate::agentctl::service::boundary::OTHER_PROJECT;

/// A tab `id` whose folder is the project itself; its session file is `/s/<id>_<id x4>.jsonl`.
fn tab_in(id: &str, project: &str) -> Value {
    let mut tab = tab(id, &format!("/s/{id}_{}.jsonl", id.repeat(4)));
    tab["cwd"] = json!(project);
    tab["project"] = json!(project);
    tab
}

fn titled(mut tab: Value, title: &str) -> Value {
    tab["title"] = json!(title);
    tab
}

fn saved_in(id: &str, title: &str, project: &str) -> Value {
    json!({ "id": id, "path": format!("/s/z_{id}.jsonl"), "title": title, "cwd": project, "project": project, "modified": "2026-11-01", "messages": 2, "status": "idle" })
}

/// A transcript page for a read, on top of `main_of`.
fn reading_main(method: &str, args: &Value) -> Result<Value, String> {
    match method {
        "command" if args["command"]["type"] == "get_transcript_page" => Ok(json!({
            "success": true,
            "data": { "messages": [{ "role": "user", "content": "hello" }], "totalMessages": 1 }
        })),
        other => main_of(other, args),
    }
}

/// What main was told under `method`, once `count` of them arrived (a tell is written after the call answers).
async fn told(asked: &Asked, method: &str, count: usize) -> Vec<Value> {
    for _ in 0..200 {
        if names(asked, method).len() >= count {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    names(asked, method)
}

fn methods(asked: &Asked) -> Vec<String> {
    asked
        .lock()
        .unwrap()
        .iter()
        .map(|(method, _)| method.clone())
        .collect()
}

#[tokio::test]
async fn an_open_in_another_project_s_folder_is_refused_before_anything_is_made() {
    let (control, asked) = rig(
        7_320,
        vec![tab_in("a", "/pa"), tab_in("c1", "/pa")],
        json!({ "boundary": { "mode": "enforce" } }),
        |method, args| match method {
            "project" => Ok(json!(
                if args["folder"].as_str().unwrap_or("").starts_with("/pa") {
                    "/pa"
                } else {
                    "/pb"
                }
            )),
            "spawn" => Ok(json!({ "tabId": "c1" })),
            other => main_of(other, args),
        },
    );
    let outcome = control
        .run(
            "a",
            "ompdesk_session_open",
            json!({ "message": "x", "folder": "/pb/sub", "worktree": true }),
            None,
        )
        .await;
    assert!(outcome.is_error);
    assert!(
        outcome.text.contains("That folder is in another project"),
        "{}",
        outcome.text
    );
    // No spawn, so no worktree and no tab: main was asked for the folder's project and nothing else.
    assert_eq!(methods(&asked), ["args.parse", "project"]);
    assert_eq!(
        names(&asked, "project")[0],
        json!({ "callerTabId": "a", "folder": "/pb/sub" })
    );
    // A folder of the caller's own project opens as before.
    let own = control
        .run(
            "a",
            "ompdesk_session_open",
            json!({ "message": "x", "folder": "/pa/sub" }),
            None,
        )
        .await;
    assert!(!own.is_error, "{}", own.text);
    assert_eq!(names(&asked, "spawn").len(), 1);
    control.host.port().close();
}

#[tokio::test]
async fn a_reopen_of_another_project_s_saved_session_is_refused_with_no_spawn() {
    let (control, asked) = rig(
        7_321,
        vec![tab_in("a", "/pa")],
        json!({ "boundary": { "mode": "enforce" } }),
        |method, args| match method {
            "stored" => Ok(json!([saved_in("zq9x", "Old secret", "/pb")])),
            "spawn" => Ok(json!({ "tabId": "c1" })),
            other => main_of(other, args),
        },
    );
    for name in ["zq9x", "Old secret"] {
        let outcome = control
            .run("a", "ompdesk_session_open", json!({ "reopen": name }), None)
            .await;
        assert!(outcome.is_error);
        assert!(outcome.text.contains(OTHER_PROJECT), "{}", outcome.text);
    }
    assert!(names(&asked, "spawn").is_empty());
    control.host.port().close();
}

#[tokio::test]
async fn another_project_s_open_tab_and_saved_session_are_refused_by_every_name() {
    let (control, asked) = rig(
        7_322,
        vec![
            tab_in("a", "/pa"),
            titled(tab_in("b", "/pb"), "Secret plan"),
        ],
        json!({ "boundary": { "mode": "enforce" } }),
        |method, args| match method {
            "stored" => Ok(json!([saved_in("zq9x", "Old secret", "/pb")])),
            other => main_of(other, args),
        },
    );
    let calls = [
        ("ompdesk_session_read", json!({ "session": "b" })),
        ("ompdesk_session_read", json!({ "session": "bbbb" })),
        ("ompdesk_session_read", json!({ "session": "Secret plan" })),
        ("ompdesk_session_read", json!({ "session": "secret" })),
        ("ompdesk_session_read", json!({ "session": "zq9x" })),
        ("ompdesk_session_read", json!({ "session": "old secret" })),
        ("ompdesk_session_result", json!({ "session": "b" })),
        ("ompdesk_session_result", json!({ "session": "zq9x" })),
        (
            "ompdesk_session_send",
            json!({ "session": "b", "message": "hi" }),
        ),
        (
            "ompdesk_session_stop",
            json!({ "session": "b", "close": true }),
        ),
    ];
    for (tool, args) in calls {
        let outcome = control.run("a", tool, args.clone(), None).await;
        assert!(outcome.is_error, "{tool} {args}");
        assert_eq!(outcome.text, OTHER_PROJECT, "{tool} {args}");
    }
    // Nothing was read, sent or closed.
    for method in ["command", "storedMessages", "view", "mail"] {
        assert!(names(&asked, method).is_empty(), "{method}");
    }
    control.host.port().close();
}

#[tokio::test]
async fn a_list_shows_another_project_s_sessions_as_counts_and_names_none() {
    let mut running = titled(tab_in("b", "/pb"), "Secret plan");
    running["busy"] = json!(true);
    let (control, _) = rig(
        7_323,
        vec![
            tab_in("a", "/pa"),
            running,
            titled(tab_in("c", "/pb"), "Other secret"),
        ],
        json!({ "boundary": { "mode": "enforce" } }),
        |method, args| match method {
            "stored" => Ok(json!([
                saved_in("own1", "Mine", "/pa"),
                saved_in("zq9x", "Old secret", "/pb")
            ])),
            other => main_of(other, args),
        },
    );
    let counts = "another project's sessions show counts only)\n";
    let open = control.run("a", "ompdesk_sessions", json!({}), None).await;
    assert!(!open.is_error, "{}", open.text);
    assert!(
        open.text.starts_with("1 session in this window:\n- a "),
        "{}",
        open.text
    );
    assert!(
        open.text.contains(&format!(
            "\n2 sessions in 1 other project: 1 running, 0 waiting for the user, 1 idle ({counts}"
        )),
        "{}",
        open.text
    );
    for named in ["ecret", "/pb", "bbbb", "cccc", "- b ", "- c "] {
        assert!(!open.text.contains(named), "{named}: {}", open.text);
    }
    let stored = control
        .run("a", "ompdesk_sessions", json!({ "scope": "stored" }), None)
        .await;
    assert!(
        stored
            .text
            .starts_with("1 session saved on this computer:\n- own1 \"Mine\""),
        "{}",
        stored.text
    );
    assert!(
        stored.text.contains(&format!(
            "\n1 session in 1 other project: 0 running, 0 waiting for the user, 1 idle ({counts}"
        )),
        "{}",
        stored.text
    );
    for named in ["ecret", "/pb", "zq9x"] {
        assert!(!stored.text.contains(named), "{named}: {}", stored.text);
    }
    control.host.port().close();
}

#[tokio::test]
async fn under_log_nothing_is_refused_and_each_crossing_call_writes_one_line() {
    let (control, asked) = rig(
        7_324,
        vec![
            tab_in("a", "/pa"),
            titled(tab_in("b", "/pb"), "Secret plan"),
            tab_in("c1", "/pb"),
        ],
        json!({ "boundary": { "mode": "log" } }),
        |method, args| match method {
            "project" => Ok(json!("/pb")),
            "spawn" => Ok(json!({ "tabId": "c1" })),
            other => reading_main(other, args),
        },
    );
    let read = control
        .run("a", "ompdesk_session_read", json!({ "session": "b" }), None)
        .await;
    assert!(!read.is_error, "{}", read.text);
    assert!(read.text.contains("hello"));
    assert_eq!(
        told(&asked, "boundaryLog", 1).await,
        [json!({
            "tool": "ompdesk_session_read",
            "caller": "/s/a_aaaa.jsonl",
            "target": "/s/b_bbbb.jsonl",
            "callerProject": "/pa",
            "targetProject": "/pb"
        })]
    );
    // A list names both sessions of the other project and writes one line for the call, not one per row.
    let list = control.run("a", "ompdesk_sessions", json!({}), None).await;
    assert!(list.text.contains("Secret plan"), "{}", list.text);
    assert!(!list.text.contains("other project"), "{}", list.text);
    let opened = control
        .run(
            "a",
            "ompdesk_session_open",
            json!({ "message": "x", "folder": "/pb" }),
            None,
        )
        .await;
    assert!(!opened.is_error, "{}", opened.text);
    assert_eq!(names(&asked, "spawn").len(), 1);
    let lines = told(&asked, "boundaryLog", 3).await;
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[1]["tool"], "ompdesk_sessions");
    assert_eq!(lines[2]["tool"], "ompdesk_session_open");
    assert_eq!(lines[2]["target"], "/pb");
    control.host.port().close();
}

#[tokio::test]
async fn a_caller_the_person_allowed_across_projects_reaches_another_project() {
    let (control, asked) = rig(
        7_325,
        vec![
            tab_in("a", "/pa"),
            titled(tab_in("b", "/pb"), "Secret plan"),
        ],
        json!({ "boundary": { "mode": "enforce", "granted": ["/s/a_aaaa.jsonl"] } }),
        reading_main,
    );
    let read = control
        .run("a", "ompdesk_session_read", json!({ "session": "b" }), None)
        .await;
    assert!(!read.is_error, "{}", read.text);
    // What main may hand to a paired host says who asks: a host that enforces judges the request too.
    assert_eq!(
        names(&asked, "command")[0]["boundaryCaller"],
        json!({ "caller": "/s/a_aaaa.jsonl", "device": null, "cwd": "/pa", "granted": true, "own": [] })
    );
    let list = control.run("a", "ompdesk_sessions", json!({}), None).await;
    assert!(list.text.contains("Secret plan"), "{}", list.text);
    // The grant is that session's alone: another caller of the same project is still kept out.
    let (other, _) = rig(
        7_326,
        vec![tab_in("a", "/pa"), tab_in("d", "/pa"), tab_in("b", "/pb")],
        json!({ "boundary": { "mode": "enforce", "granted": ["/s/a_aaaa.jsonl"] } }),
        reading_main,
    );
    let refused = other
        .run("d", "ompdesk_session_read", json!({ "session": "b" }), None)
        .await;
    assert_eq!(refused.text, OTHER_PROJECT);
    assert!(names(&asked, "boundaryLog").is_empty());
    control.host.port().close();
    other.host.port().close();
}

#[tokio::test]
async fn a_child_opened_through_the_check_stays_in_scope_once_the_grant_is_gone() {
    let tabs = vec![tab_in("a", "/pa"), tab_in("b", "/pb"), tab_in("c1", "/pb")];
    let (control, _) = rig(
        7_327,
        tabs.clone(),
        json!({ "boundary": { "mode": "enforce", "granted": ["/s/a_aaaa.jsonl"] } }),
        |method, args| match method {
            "spawn" => Ok(json!({ "tabId": "c1" })),
            other => reading_main(other, args),
        },
    );
    let opened = control
        .run(
            "a",
            "ompdesk_session_open",
            json!({ "message": "x", "folder": "/pb" }),
            None,
        )
        .await;
    assert!(!opened.is_error, "{}", opened.text);
    // The grant goes, and what was opened earlier now needs one: only the check the child passed keeps it.
    let without = state_of(
        tabs,
        json!({
            "boundary": { "mode": "enforce", "earlierOpened": "grant" },
            "parents": { "c1": { "callerTabId": "a" } }
        }),
    )
    .to_string();
    crate::ports::apply_state(control.host.port(), 1, &without).unwrap();
    let child = control
        .run(
            "a",
            "ompdesk_session_read",
            json!({ "session": "c1" }),
            None,
        )
        .await;
    assert!(!child.is_error, "{}", child.text);
    let stranger = control
        .run("a", "ompdesk_session_read", json!({ "session": "b" }), None)
        .await;
    assert_eq!(stranger.text, OTHER_PROJECT);
    control.host.port().close();
}

#[tokio::test]
async fn a_session_opened_before_the_boundary_stays_visible_unless_the_option_says_grant() {
    let tabs = vec![tab_in("a", "/pa"), tab_in("c1", "/pb")];
    let parents = json!({ "c1": { "callerTabId": "a" } });
    let (control, _) = rig(
        7_328,
        tabs.clone(),
        json!({ "boundary": { "mode": "enforce" }, "parents": parents }),
        reading_main,
    );
    let read = || {
        control.run(
            "a",
            "ompdesk_session_read",
            json!({ "session": "c1" }),
            None,
        )
    };
    let visible = read().await;
    assert!(!visible.is_error, "{}", visible.text);
    let grant = state_of(
        tabs,
        json!({ "boundary": { "mode": "enforce", "earlierOpened": "grant" }, "parents": parents }),
    )
    .to_string();
    crate::ports::apply_state(control.host.port(), 1, &grant).unwrap();
    assert_eq!(read().await.text, OTHER_PROJECT);
    control.host.port().close();
}

#[tokio::test]
async fn a_schedule_in_another_project_s_folder_and_the_app_s_session_actions_are_refused() {
    let (control, asked) = rig(
        7_329,
        vec![tab_in("a", "/pa")],
        json!({ "boundary": { "mode": "enforce" }, "scheduleDevices": [""], "manageEnabled": true }),
        |method, args| match method {
            "project" => Ok(json!("/pb")),
            "schedules.command" => Ok(json!({})),
            other => main_of(other, args),
        },
    );
    let schedule = control
        .run(
            "a",
            "ompdesk_schedule",
            json!({ "action": "create", "name": "n", "prompt": "p", "folder": "/pb/x", "every_minutes": 30 }),
            None,
        )
        .await;
    assert!(schedule.is_error);
    assert!(
        schedule.text.contains("That folder is in another project"),
        "{}",
        schedule.text
    );
    assert!(names(&asked, "schedules.create").is_empty());
    assert!(names(&asked, "confirm").is_empty());
    let app = control
        .run(
            "a",
            "ompdesk_app",
            json!({ "action": "sessions.saved" }),
            None,
        )
        .await;
    assert!(app.is_error);
    assert!(
        app.text.contains("sessions.saved and sessions.search"),
        "{}",
        app.text
    );
    control.host.port().close();
}

#[tokio::test]
async fn an_autopilot_start_on_another_project_s_repository_is_refused_and_starts_nothing() {
    let (control, asked) = rig_files(
        7_330,
        state_of(
            vec![tab_in("a", "/pa")],
            json!({ "boundary": { "mode": "enforce" } }),
        ),
        Caps {
            autopilot: true,
            ..Caps::default()
        },
        &Files::default(),
        |method, args, _| match method {
            "project" => Ok(json!("/pb")),
            "spawn" => Ok(json!({ "tabId": "c1" })),
            other => main_of(other, args),
        },
    );
    let outcome = control
        .run(
            "a",
            "ompdesk_autopilot",
            json!({ "action": "start", "folder": "/pb" }),
            None,
        )
        .await;
    assert!(outcome.is_error);
    assert!(
        outcome.text.contains("That folder is in another project"),
        "{}",
        outcome.text
    );
    // No session to start from, no card, no plan and no run: main was asked for the folder's project alone.
    assert_eq!(methods(&asked), ["args.parse", "project"]);
    // The caller's own repository goes on to the coordinator.
    let own = control
        .run("a", "ompdesk_autopilot", json!({ "action": "start" }), None)
        .await;
    assert!(!own.text.contains("another project"), "{}", own.text);
    assert_eq!(names(&asked, "autopilot.plan").len(), 1);
    control.host.port().close();
}

#[tokio::test]
async fn a_snapshot_that_names_no_project_fails_closed() {
    // Main's cache is empty (no tab carries a project) and main can place no folder.
    let bare = |id: &str| tab(id, &format!("/s/{id}_{}.jsonl", id.repeat(4)));
    let (control, asked) = rig(
        7_331,
        vec![bare("a"), titled(bare("b"), "Secret plan")],
        json!({ "boundary": { "mode": "enforce" } }),
        |method, args| match method {
            "project" => Ok(Value::Null),
            "spawn" => Ok(json!({ "tabId": "c1" })),
            "stored" => Ok(
                json!([{ "id": "zq9x", "path": "/s/z_zq9x.jsonl", "title": "Old secret", "cwd": "/w", "modified": "2026-11-01", "messages": 2, "status": "idle" }]),
            ),
            other => main_of(other, args),
        },
    );
    for session in ["b", "Secret plan", "zq9x"] {
        let read = control
            .run(
                "a",
                "ompdesk_session_read",
                json!({ "session": session }),
                None,
            )
            .await;
        assert_eq!(read.text, OTHER_PROJECT, "{session}");
    }
    let open = control.run("a", "ompdesk_sessions", json!({}), None).await;
    assert!(
        open.text
            .contains("\n1 session in 1 other project: 0 running, 0 waiting for the user, 1 idle"),
        "{}",
        open.text
    );
    assert!(!open.text.contains("ecret"), "{}", open.text);
    let stored = control
        .run("a", "ompdesk_sessions", json!({ "scope": "stored" }), None)
        .await;
    assert!(
        stored
            .text
            .starts_with("0 sessions saved on this computer:"),
        "{}",
        stored.text
    );
    assert!(!stored.text.contains("ecret"), "{}", stored.text);
    // The same folder as the caller's is still not known to be the same project: refused, and nothing is made.
    let opened = control
        .run(
            "a",
            "ompdesk_session_open",
            json!({ "message": "x", "folder": "/w" }),
            None,
        )
        .await;
    assert!(
        opened.text.contains("cannot tell its project yet"),
        "{}",
        opened.text
    );
    assert!(names(&asked, "spawn").is_empty());
    control.host.port().close();
}

#[tokio::test]
async fn another_project_s_schedules_are_a_count_and_refuse_every_change() {
    let schedule = |id: &str, name: &str, cwd: &str| json!({ "id": id, "createdAt": "", "name": name, "prompt": "p", "cwd": cwd, "frequency": { "kind": "interval", "minutes": 30 }, "enabled": true });
    let mut wake = schedule("s-wake-3333", "[agent] wake me", "/elsewhere");
    wake["wakeSession"] = json!("/s/a_aaaa.jsonl");
    let state = json!({
        "schedules": [
            schedule("s-own-1111", "[agent] mine", "/pa/sub"),
            schedule("s-oth-2222", "[agent] theirs", "/pb"),
            wake
        ],
        "outside": 2
    });
    let (control, asked) = rig(
        7_332,
        vec![tab_in("a", "/pa")],
        json!({ "boundary": { "mode": "enforce" }, "scheduleDevices": [""], "manageEnabled": true }),
        move |method, args| match method {
            "project" => Ok(json!(
                if args["folder"].as_str().unwrap_or("").starts_with("/pa") {
                    "/pa"
                } else {
                    "/other"
                }
            )),
            "schedules.command" => Ok(state.clone()),
            other => main_of(other, args),
        },
    );
    let list = control
        .run("a", "ompdesk_schedule", json!({ "action": "list" }), None)
        .await;
    assert!(!list.is_error, "{}", list.text);
    // Its own project's schedule and its own wake-up (whatever folder that names) are listed.
    assert!(list.text.contains("- s-own-1111 "), "{}", list.text);
    assert!(list.text.contains("- s-wake-3333 "), "{}", list.text);
    // The other project's, and the two their own computer left out, are a count.
    assert!(
        list.text.ends_with("\n3 scheduled runs on this computer in other projects (another project's schedules show as a count only)"),
        "{}",
        list.text
    );
    for named in ["s-oth-2222", "theirs", "/pb"] {
        assert!(!list.text.contains(named), "{named}: {}", list.text);
    }
    for action in ["runs", "update", "pause", "resume", "run", "cancel"] {
        let outcome = control
            .run(
                "a",
                "ompdesk_schedule",
                json!({ "action": action, "id": "s-oth-2222", "name": "renamed" }),
                None,
            )
            .await;
        assert!(outcome.is_error, "{action}");
        assert_eq!(
            outcome.text,
            crate::agentctl::service::boundary::OTHER_SCHEDULE,
            "{action}"
        );
    }
    // Nothing but reads reached the Schedules service.
    assert!(
        names(&asked, "schedules.command")
            .iter()
            .all(|sent| sent["request"]["action"] == "get")
    );
    let cancelled = control
        .run(
            "a",
            "ompdesk_schedule",
            json!({ "action": "cancel", "id": "s-own-1111" }),
            None,
        )
        .await;
    assert!(!cancelled.is_error, "{}", cancelled.text);
    assert!(
        names(&asked, "schedules.command")
            .iter()
            .any(|sent| sent["request"]["id"] == "s-own-1111")
    );
    // A trigger that watches another project's repository, or every project's sessions, is refused before a save.
    let triggers = [
        (
            json!({ "source": "git", "repo": "/pb", "branch": "main" }),
            "That folder is in another project",
        ),
        (
            json!({ "source": "session", "events": ["idle"], "folder": "/pb" }),
            "That folder is in another project",
        ),
        (
            json!({ "source": "session", "events": ["idle"] }),
            "A session trigger needs on.folder",
        ),
    ];
    for (on, refusal) in triggers {
        let outcome = control
            .run(
                "a",
                "ompdesk_schedule",
                json!({ "action": "create", "name": "n", "prompt": "p", "on": on }),
                None,
            )
            .await;
        assert!(outcome.is_error, "{on}");
        assert!(outcome.text.contains(refusal), "{on}: {}", outcome.text);
    }
    assert!(names(&asked, "schedules.create").is_empty());
    control.host.port().close();
}

#[tokio::test]
async fn a_report_to_another_project_s_session_is_refused() {
    let (control, asked) = rig(
        7_333,
        vec![
            tab_in("a", "/pa"),
            titled(tab_in("b", "/pb"), "Secret plan"),
        ],
        json!({ "boundary": { "mode": "enforce" } }),
        main_of,
    );
    for to in ["b", "bbbb", "Secret plan"] {
        let outcome = control
            .run(
                "a",
                "ompdesk_report",
                json!({ "kind": "note", "text": "hello", "to": to }),
                None,
            )
            .await;
        assert!(outcome.is_error, "{to}");
        assert_eq!(outcome.text, OTHER_PROJECT, "{to}");
    }
    assert!(names(&asked, "mail").is_empty());
    control.host.port().close();
}

#[tokio::test]
async fn the_app_s_sidebar_and_session_actions_refuse_another_project_s_session_file() {
    let (control, asked) = rig(
        7_334,
        vec![tab_in("a", "/pa")],
        json!({ "boundary": { "mode": "enforce" } }),
        |method, args| match method {
            "stored" => Ok(json!([
                saved_in("own1", "Mine", "/pa"),
                saved_in("zq9x", "Old secret", "/pb")
            ])),
            other => main_of(other, args),
        },
    );
    let theirs = "/s/z_zq9x.jsonl";
    let calls = [
        (
            "sidebar.pin_session",
            json!({ "sessionPath": theirs, "pinned": true }),
        ),
        (
            "sidebar.archive_sessions",
            json!({ "sessionPaths": ["/s/z_own1.jsonl", theirs], "archived": true }),
        ),
        (
            "sidebar.archive_sessions",
            json!({ "sessionPaths": ["/s/no_such.jsonl"], "archived": true }),
        ),
        (
            "sessions.rename",
            json!({ "sessionPath": theirs, "name": "x" }),
        ),
        ("sessions.delete", json!({ "sessionPath": theirs })),
    ];
    for (action, args) in calls {
        let outcome = control
            .run(
                "a",
                "ompdesk_app",
                json!({ "action": action, "args": args }),
                None,
            )
            .await;
        assert!(outcome.is_error, "{action}");
        assert_eq!(outcome.text, OTHER_PROJECT, "{action} {args}");
    }
    // The app was asked for nothing: each refusal came before the action ran.
    assert!(
        methods(&asked)
            .iter()
            .all(|method| !method.starts_with("appPorts"))
    );
    // A session of the caller's own project passes the boundary (this rig has no app to run the action in).
    let own = control
        .run(
            "a",
            "ompdesk_app",
            json!({ "action": "sidebar.pin_session", "args": { "sessionPath": "/s/z_own1.jsonl", "pinned": true } }),
            None,
        )
        .await;
    assert!(!own.text.contains("another project"), "{}", own.text);
    control.host.port().close();
}

#[tokio::test]
async fn a_row_its_own_computer_left_out_is_counted_and_never_named_whatever_the_mode_here() {
    // A paired host that enforces answers a blank row for a session the caller may not reach there.
    let (control, _) = rig(
        7_335,
        vec![tab_in("a", "/pa")],
        json!({}),
        |method, args| match method {
            "stored" => Ok(json!([
                saved_in("own1", "Mine", "/pa"),
                { "id": "outside:1", "path": "outside:1", "title": "", "cwd": "", "modified": "", "messages": 0, "status": "unknown", "outside": true }
            ])),
            other => main_of(other, args),
        },
    );
    let stored = control
        .run("a", "ompdesk_sessions", json!({ "scope": "stored" }), None)
        .await;
    assert!(
        stored
            .text
            .starts_with("1 session saved on this computer:\n- own1 \"Mine\""),
        "{}",
        stored.text
    );
    assert!(
        stored
            .text
            .contains("\n1 session in 1 other project: 0 running, 0 waiting for the user, 1 idle"),
        "{}",
        stored.text
    );
    assert!(!stored.text.contains("outside:1"), "{}", stored.text);
    let read = control
        .run(
            "a",
            "ompdesk_session_read",
            json!({ "session": "outside:1" }),
            None,
        )
        .await;
    assert!(read.is_error);
    assert!(
        read.text.starts_with("No session \"outside:1\""),
        "{}",
        read.text
    );
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
