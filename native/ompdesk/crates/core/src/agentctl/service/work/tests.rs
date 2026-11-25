//! Tests of the work tools against a fake main (what `service.test.ts` asks of compare, merge, schedule, Autopilot, the
//! review board, family edits, auto-close and the app tools; the full run of that file against the real core is the
//! parity suite at cutover) and of the pure cuts (`turnEdits`, `costSplitOf`, the command timeouts) against tables
//! captured from the TypeScript (`captured.json`).

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::super::host::{Caps, HostState};
use super::super::tuning::Tuning;
use super::super::{AgentControl, Files};
use super::command_timeout;
use super::review::{cost_split_of, saved_edits};
use crate::agentctl::journal::system_clock;
use crate::ports::Port;

type Asked = Arc<Mutex<Vec<(String, Value)>>>;

/// A control over a fake main: `reply` answers every ask; what was asked and told is kept in order.
fn rig(
    id: u64,
    state: Value,
    caps: Caps,
    reply: impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static,
) -> (AgentControl, Asked) {
    rig_files(id, state, caps, &Files::default(), reply)
}

/// `rig` over journals in `files`.
fn rig_files(
    id: u64,
    state: Value,
    caps: Caps,
    files: &Files,
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
    let tuning = Tuning {
        close_wait_ms: 50,
        ready_poll_ms: 20,
        ..Tuning::default()
    };
    let control = AgentControl::new(port, caps, files, tuning, system_clock());
    (control, asked)
}

fn tab(id: &str, fields: Value) -> Value {
    let mut tab = json!({ "tabId": id, "status": "ready", "title": id, "cwd": "/repo" });
    for (key, value) in fields.as_object().cloned().unwrap_or_default() {
        tab[key] = value;
    }
    tab
}

fn worktree(branch: &str) -> Value {
    json!({ "name": branch, "branch": branch, "baseCwd": "/repo", "path": format!("/wt/{branch}") })
}

const CLEAN: &str = r#"{"branch":"omp/agent/a","baseBranch":"main","commitsAhead":2,"files":[{"path":"src/a.ts","added":10,"removed":2},{"path":"src/b.ts","added":5,"removed":0}],"uncommitted":0,"untracked":0,"merged":false}"#;

fn facts(branch: &str, uncommitted: u32) -> Value {
    let mut facts: Value = serde_json::from_str(CLEAN).unwrap();
    facts["branch"] = json!(branch);
    facts["uncommitted"] = json!(uncommitted);
    facts
}

/// The caller `main0001` and two worktree children it opened.
fn family() -> Value {
    json!({
        "enabled": true,
        "tabs": [
            tab("main0001", json!({ "title": "Boss", "sessionPath": "/s/boss.jsonl" })),
            tab("alpha001", json!({ "title": "Alpha", "worktree": worktree("omp/agent/a"), "sessionPath": "/s/a.jsonl" })),
            tab("beta0002", json!({ "title": "Beta", "worktree": worktree("omp/agent/b"), "sessionPath": "/s/b.jsonl" })),
        ],
        "windowOf": { "main0001": "w", "alpha001": "w", "beta0002": "w" },
        "parents": {
            "alpha001": { "callerTabId": "main0001" },
            "beta0002": { "callerTabId": "main0001" },
        },
        "texts": {
            "mergeTitle": "Merge?",
            "mergeMessage": "{caller} merges {target} ({branch} into {base} in {cwd})",
            "scheduleTitle": "Schedule?",
            "scheduleMessage": "{caller} schedules {name} {when} in {folder}",
        },
    })
}

fn branch_of(args: &Value) -> String {
    args["worktree"]["branch"].as_str().unwrap_or("").to_owned()
}

/// What a fake main answers about git and the omp of a session, for the tools of this family.
fn main_of(
    reply: impl Fn(&str, &Value) -> Option<Value> + Send + 'static,
) -> impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static {
    move |method, args| {
        if let Some(value) = reply(method, args) {
            return Ok(value);
        }
        match method {
            "args.parse" => Ok(json!({ "ok": true, "args": args["args"] })),
            "state" => Ok(Value::Null),
            "branchFacts" => Ok(facts(&branch_of(args), 0)),
            "branchEvidence" => {
                Ok(json!({ "diff": "", "diffOmitted": 0, "merge": { "kind": "clean" } }))
            }
            "confirm" => Ok(json!(true)),
            "command" => match args["command"]["type"].as_str() {
                Some("get_state") => Ok(
                    json!({ "success": true, "data": { "isStreaming": false, "isSettled": true } }),
                ),
                Some("get_last_assistant_text") => {
                    let text = if args["tabId"] == "alpha001" {
                        "Alpha is done: tests pass"
                    } else {
                        "Beta is done"
                    };
                    Ok(json!({ "success": true, "data": { "text": text } }))
                }
                Some("get_transcript_page") => {
                    Ok(json!({ "success": true, "data": { "messages": [], "totalMessages": 0 } }))
                }
                _ => Ok(json!({ "success": false, "error": "no" })),
            },
            _ => Ok(Value::Null),
        }
    }
}

async fn run(control: &AgentControl, tool: &str, args: Value) -> (String, bool) {
    let outcome = control.run("main0001", tool, args, None).await;
    (outcome.text, outcome.is_error)
}

#[tokio::test]
async fn compare_gives_each_branch_its_facts_its_answer_and_runs_no_tests() {
    let (control, asked) = rig(
        201,
        family(),
        Caps::default(),
        main_of(|method, args| match method {
            "branchFacts" if branch_of(args) == "omp/agent/b" => {
                let mut facts = facts("omp/agent/b", 3);
                facts["commitsBehind"] = json!(12);
                Some(facts)
            }
            _ => None,
        }),
    );
    let (text, is_error) = run(&control, "ompdesk_compare", json!({})).await;
    assert!(!is_error, "{text}");
    assert!(text.contains("- alpha001 \"Alpha\""), "{text}");
    assert!(
        text.contains("branch omp/agent/a → main: 2 commit(s) ahead, 2 file(s) changed (+15 −2)"),
        "{text}"
    );
    assert!(
        text.contains("files: src/a.ts +10 −2, src/b.ts +5 −0"),
        "{text}"
    );
    assert!(
        text.contains("final answer: Alpha is done: tests pass"),
        "{text}"
    );
    assert!(text.contains("ready to merge with ompdesk_merge"), "{text}");
    assert!(
        text.contains("cannot merge yet: omp/agent/b has 3 uncommitted file(s)"),
        "{text}"
    );
    assert!(
        text.contains("12 commits behind main (rebase or merge main before landing)"),
        "{text}"
    );
    assert_eq!(text.matches("behind main").count(), 1, "{text}");
    assert!(text.contains("Compare runs no tests"), "{text}");
    // Reading them counts as collecting their answers.
    assert!(control.mem().collected.contains("alpha001"));
    assert!(
        asked
            .lock()
            .unwrap()
            .iter()
            .any(|(method, _)| method == "branchEvidence")
    );
}

#[tokio::test]
async fn compare_says_when_no_session_has_a_worktree_and_names_a_judge_that_failed() {
    let state = json!({
        "enabled": true,
        "tabs": [tab("main0001", json!({})), tab("plain002", json!({ "title": "Plain" }))],
        "windowOf": { "main0001": "w", "plain002": "w" },
    });
    let (control, _) = rig(202, state, Caps::default(), main_of(|_, _| None));
    let (text, is_error) = run(&control, "ompdesk_compare", json!({})).await;
    assert!(is_error);
    assert!(text.contains("No worktree sessions to compare"), "{text}");
    let (text, _) = run(
        &control,
        "ompdesk_compare",
        json!({ "sessions": ["plain002"], "criteria": ["it works"] }),
    )
    .await;
    assert!(
        text.starts_with("Verdict: unavailable (Judging failed: no)."),
        "{text}"
    );
    assert!(text.contains("no worktree: no branch to diff"), "{text}");
}

#[tokio::test]
async fn compare_names_the_judge_and_ranks_the_sessions_it_knows() {
    let verdict = json!({
        "ranking": [
            { "session": "beta0002", "score": 40, "criteria": [{ "criterion": "ok", "met": "no", "why": "no hunk" }], "reasons": "weak" },
            { "session": "alpha001", "score": 90, "criteria": [{ "criterion": "ok", "met": "yes" }], "reasons": "strong" },
            { "session": "ghost999", "score": 99, "criteria": [], "reasons": "unknown id" },
        ],
        "winner": "alpha001",
        "why": "it did the work",
    });
    let (control, asked) = rig(
        203,
        family(),
        Caps::default(),
        main_of(move |method, args| {
            (method == "command" && args["command"]["type"] == "agent_control_judge").then(|| {
                json!({ "success": true, "data": { "text": verdict.to_string(), "model": "m/x", "role": "slow", "family": "openai", "mainFamily": "anthropic", "crossFamily": true, "usd": 0.01234 } })
            })
        }),
    );
    let (text, is_error) = run(&control, "ompdesk_compare", json!({ "criteria": ["ok"] })).await;
    assert!(!is_error, "{text}");
    assert!(
        text.starts_with(
            "Verdict by m/x (slow role, openai family; your model is anthropic), $0.0123:\n1. alpha001: 90/100. strong\n   - yes: ok\n2. beta0002: 40/100. weak\n   - no: ok (no hunk)\nWinner: alpha001. it did the work\n\nEvidence:\n"
        ),
        "{text}"
    );
    let judged = asked
        .lock()
        .unwrap()
        .iter()
        .find(|(_, args)| args["command"]["type"] == "agent_control_judge")
        .map(|(_, args)| args.clone())
        .expect("the judge was asked");
    assert_eq!(judged["timeoutMs"], json!(180_000));
    let user = judged["command"]["user"].as_str().unwrap();
    assert!(
        user.starts_with("Acceptance criteria:\n1. ok\n\n<session id=\"alpha001\">"),
        "{user}"
    );
}

#[tokio::test]
async fn merge_asks_first_merges_and_never_pushes() {
    let (control, asked) = rig(
        204,
        family(),
        Caps::default(),
        main_of(|method, _| {
            (method == "mergeBranch")
                .then(|| json!({ "merged": true, "sha": "abc1234", "summary": "2 files changed" }))
        }),
    );
    let (text, is_error) = run(&control, "ompdesk_merge", json!({ "session": "alpha001" })).await;
    assert!(!is_error, "{text}");
    assert_eq!(
        text,
        "Merged omp/agent/a into /repo (abc1234: 2 files changed). Nothing was pushed."
    );
    let asked = asked.lock().unwrap();
    let card = asked
        .iter()
        .find(|(method, _)| method == "confirm")
        .expect("a card");
    assert_eq!(card.1["title"], "Merge?");
    assert_eq!(
        card.1["message"],
        "Boss merges Alpha (omp/agent/a into main in /repo)"
    );
    drop(asked);
    // Merged: its review item is settled and its conflict gone.
    assert!(control.mem().reviewed.contains("alpha001"));
}

#[tokio::test]
async fn merge_declined_conflicting_and_hooked() {
    let declined = Arc::new(Mutex::new(false));
    let seen = declined.clone();
    let result = Arc::new(Mutex::new(json!(null)));
    let outcome = result.clone();
    let (control, asked) = rig(
        205,
        family(),
        Caps::default(),
        main_of(move |method, args| match method {
            "confirm" => Some(json!(!*seen.lock().unwrap())),
            "mergeBranch" => Some(outcome.lock().unwrap().clone()),
            "branchFacts" if branch_of(args) == "omp/agent/b" => Some(facts("omp/agent/b", 2)),
            _ => None,
        }),
    );
    *declined.lock().unwrap() = true;
    let (text, _) = run(&control, "ompdesk_merge", json!({ "session": "alpha001" })).await;
    assert!(
        text.contains("The user declined the merge of omp/agent/a. Do not ask again"),
        "{text}"
    );
    assert!(
        !asked
            .lock()
            .unwrap()
            .iter()
            .any(|(method, _)| method == "mergeBranch")
    );
    *declined.lock().unwrap() = false;

    *result.lock().unwrap() =
        json!({ "merged": false, "reason": "conflict", "files": ["src/a.ts"], "predicted": false });
    let (text, is_error) = run(&control, "ompdesk_merge", json!({ "session": "alpha001" })).await;
    assert!(is_error);
    assert!(
        text.contains("Merge conflict in src/a.ts: the merge was aborted and /repo is unchanged."),
        "{text}"
    );
    assert_eq!(
        control.mem().conflicts.get("alpha001"),
        Some(&vec!["src/a.ts".to_owned()])
    );

    *result.lock().unwrap() = json!({ "merged": false, "reason": "conflict", "files": ["README.md", "src/a.ts"], "predicted": true });
    let (text, _) = run(&control, "ompdesk_merge", json!({ "session": "alpha001" })).await;
    assert!(text.contains("Merging omp/agent/a would conflict in README.md, src/a.ts (predicted by git merge-tree): no merge was attempted and /repo is unchanged."), "{text}");

    let report = json!({ "script": ".ompdesk/worktree-pre-merge", "ok": false, "exitCode": 3, "timedOut": false, "durationMs": 900, "logPath": "/repo/.git/x.log", "outputTail": "lint failed: src/a.ts" });
    *result.lock().unwrap() = json!({ "merged": false, "reason": "hook", "hook": report });
    let (text, _) = run(&control, "ompdesk_merge", json!({ "session": "alpha001" })).await;
    assert!(text.contains("Pre-merge hook .ompdesk/worktree-pre-merge failed (exit 3) in /wt/omp/agent/a; the merge was not started. Output tail:\nlint failed: src/a.ts\nLog: /repo/.git/x.log"), "{text}");

    let (text, _) = run(&control, "ompdesk_merge", json!({ "session": "beta0002" })).await;
    assert!(text.contains("uncommitted file"), "{text}");

    let post = json!({ "script": ".ompdesk/worktree-post-merge", "ok": false, "exitCode": null, "timedOut": true, "durationMs": 120000, "logPath": "/l", "outputTail": "t" });
    *result.lock().unwrap() =
        json!({ "merged": true, "sha": "abc1234", "summary": "", "postMerge": post });
    let (text, is_error) = run(&control, "ompdesk_merge", json!({ "session": "alpha001" })).await;
    assert!(!is_error);
    assert!(text.starts_with("Merged omp/agent/a into /repo (abc1234). Nothing was pushed. Post-merge hook .ompdesk/worktree-post-merge failed (timed out after 120s); the merge stays."), "{text}");
}

#[tokio::test]
async fn merge_refuses_a_session_without_a_branch_or_still_working() {
    let mut state = family();
    state["tabs"][2]["busy"] = json!(true);
    state["tabs"]
        .as_array_mut()
        .unwrap()
        .push(tab("plain003", json!({})));
    state["windowOf"]["plain003"] = json!("w");
    let (control, _) = rig(206, state, Caps::default(), main_of(|_, _| None));
    let (text, _) = run(&control, "ompdesk_merge", json!({ "session": "plain003" })).await;
    assert!(text.contains("has no worktree branch to merge"), "{text}");
    let (text, _) = run(&control, "ompdesk_merge", json!({ "session": "beta0002" })).await;
    assert!(
        text.contains("is still working or waiting; collect its result first."),
        "{text}"
    );
}

fn scheduled(id: &str, name: &str, frequency: Value) -> Value {
    json!({ "id": id, "createdAt": "2026-01-01T00:00:00.000Z", "name": name, "prompt": "p", "cwd": "/repo", "frequency": frequency, "model": null, "autoApprove": false, "enabled": true })
}

#[tokio::test]
async fn schedule_creates_after_a_card_lists_and_changes_only_the_agent_s_own() {
    let mut state = family();
    state["scheduleDevices"] = json!([""]);
    let saved = Arc::new(Mutex::new(Vec::<Value>::new()));
    let book = saved.clone();
    let (control, asked) = rig(
        207,
        state,
        Caps::default(),
        main_of(move |method, args| match method {
            "schedules.create" => {
                let draft = args["draft"].clone();
                let made = scheduled(
                    "sch00001",
                    draft["name"].as_str().unwrap(),
                    draft["frequency"].clone(),
                );
                book.lock().unwrap().push(made);
                Some(
                    json!({ "id": "sch00001", "state": { "schedules": book.lock().unwrap().clone(), "nextRuns": { "sch00001": "2026-01-02T09:00:00.000Z" } } }),
                )
            }
            "schedules.command" => {
                let mut schedules = book.lock().unwrap().clone();
                schedules.push(scheduled(
                    "user0001",
                    "Mine",
                    json!({ "kind": "interval", "minutes": 5 }),
                ));
                if args["request"]["action"].as_str() == Some("delete") {
                    schedules.retain(|row| row["id"] != args["request"]["id"]);
                }
                Some(
                    json!({ "schedules": schedules, "runs": [], "nextRuns": { "sch00001": "2026-01-02T09:00:00.000Z" } }),
                )
            }
            _ => None,
        }),
    );
    let (text, is_error) = run(
        &control,
        "ompdesk_schedule",
        json!({ "action": "create", "name": "nightly", "prompt": "do it", "daily_at": "09:00", "days": [3, 1, 3], "folder": "/repo" }),
    )
    .await;
    assert!(!is_error, "{text}");
    assert!(text.starts_with("Scheduled “[agent] nightly” "), "{text}");
    assert!(text.contains("id sch00001; next run 2026-01-02T09:00:00.000Z. It runs only while OMPdesk is open on this computer, never with auto-approve; cancel it with ompdesk_schedule {\"action\":\"cancel\",\"id\":\"sch00001\"}."), "{text}");
    let asked_now = asked.lock().unwrap().clone();
    let card = asked_now
        .iter()
        .find(|(method, _)| method == "confirm")
        .unwrap();
    assert_eq!(card.1["title"], "Schedule?");
    let create = asked_now
        .iter()
        .find(|(method, _)| method == "schedules.create")
        .unwrap();
    assert_eq!(create.1["draft"]["name"], "[agent] nightly");
    assert_eq!(create.1["draft"]["autoApprove"], false);
    assert_eq!(
        create.1["draft"]["frequency"],
        json!({ "kind": "daily", "time": "09:00", "days": [1, 3] })
    );

    let (text, _) = run(&control, "ompdesk_schedule", json!({ "action": "list" })).await;
    assert!(
        text.starts_with("Scheduled runs on this computer:\n- sch00001 “[agent] nightly” "),
        "{text}"
    );
    assert!(
        text.contains("[made by an agent: you can change it]"),
        "{text}"
    );
    assert!(
        text.contains("- user0001 “Mine” every 5 min in /repo; next —"),
        "{text}"
    );
    assert!(
        text.ends_with("[the user's own: leave it]") || text.contains("[the user's own: leave it]"),
        "{text}"
    );

    let (text, is_error) = run(
        &control,
        "ompdesk_schedule",
        json!({ "action": "cancel", "id": "user0001" }),
    )
    .await;
    assert!(is_error);
    assert!(
        text.contains(
            "is the user's own schedule; only the user changes it (Settings › Schedules)."
        ),
        "{text}"
    );
    let (text, _) = run(
        &control,
        "ompdesk_schedule",
        json!({ "action": "cancel", "id": "sch0" }),
    )
    .await;
    assert_eq!(text, "Cancelled “[agent] nightly” on this computer.");
    let (text, _) = run(
        &control,
        "ompdesk_schedule",
        json!({ "action": "runs", "id": "nope" }),
    )
    .await;
    assert!(
        text.contains("No scheduled run \"nope\" on this computer."),
        "{text}"
    );
}

#[tokio::test]
async fn schedule_says_so_without_a_service_and_needs_one_start() {
    let (control, _) = rig(208, family(), Caps::default(), main_of(|_, _| None));
    let (text, _) = run(&control, "ompdesk_schedule", json!({ "action": "list" })).await;
    assert_eq!(text, "Scheduled runs are not available on this computer.");
    let mut state = family();
    state["scheduleDevices"] = json!([""]);
    let (control, _) = rig(
        209,
        state,
        Caps::default(),
        main_of(|method, _| (method == "schedules.command").then(|| json!({ "schedules": [] }))),
    );
    let (text, _) = run(
        &control,
        "ompdesk_schedule",
        json!({ "action": "create", "name": "x" }),
    )
    .await;
    assert_eq!(
        text,
        "Invalid arguments for ompdesk_schedule: create needs prompt; create needs exactly one of every_minutes, daily_at, at, in_minutes or on"
    );
    let (text, _) = run(
        &control,
        "ompdesk_schedule",
        json!({ "action": "create", "name": "x", "prompt": "p", "every_minutes": 5, "folder": "repo" }),
    )
    .await;
    assert_eq!(text, "folder must be an absolute path.");
    let (text, _) = run(&control, "ompdesk_schedule", json!({ "action": "list" })).await;
    assert_eq!(text, "No scheduled runs on this computer.");
}

#[tokio::test]
async fn schedule_asks_for_every_precheck_and_sends_the_answer_where_asked() {
    let mut state = family();
    state["scheduleDevices"] = json!([""]);
    state["manageEnabled"] = json!(true);
    state["texts"]["schedulePrecheckMessage"] = json!("{caller} prechecks {name} with {command}");
    let (control, asked) = rig(
        290,
        state,
        Caps::default(),
        main_of(|method, args| match method {
            "schedules.create" => {
                let draft = args["draft"].clone();
                let made = scheduled(
                    "sch00002",
                    draft["name"].as_str().unwrap(),
                    draft["frequency"].clone(),
                );
                Some(json!({ "id": "sch00002", "state": { "schedules": [made], "nextRuns": {} } }))
            }
            "schedules.command" => Some(json!({ "schedules": [], "runs": [], "nextRuns": {} })),
            _ => None,
        }),
    );
    let (text, is_error) = run(
        &control,
        "ompdesk_schedule",
        json!({ "action": "create", "name": "standup", "prompt": "brief me", "folder": "/repo",
            "on": { "source": "calendar", "url": "https://example.com/a.ics" }, "within_minutes": 60,
            "precheck": "test -f ready", "results_to": "self" }),
    )
    .await;
    assert!(!is_error, "{text}");
    let asked = asked.lock().unwrap().clone();
    let card = asked
        .iter()
        .find(|(method, _)| method == "confirm")
        .expect("a precheck asks even while agents may manage sessions");
    assert_eq!(
        card.1["message"],
        "Boss prechecks standup with test -f ready"
    );
    let draft = &asked
        .iter()
        .find(|(method, _)| method == "schedules.create")
        .unwrap()
        .1["draft"];
    assert_eq!(draft["precheck"], "test -f ready");
    assert_eq!(
        draft["resultsTo"],
        json!({ "kind": "session", "session": "/s/boss.jsonl" })
    );
    assert_eq!(
        draft["frequency"]["event"],
        json!({ "source": "calendar", "url": "https://example.com/a.ics", "leadMinutes": 10 })
    );
    assert!(draft["frequency"]["by"].is_string(), "{draft}");

    let (text, is_error) = run(
        &control,
        "ompdesk_schedule",
        json!({ "action": "create", "name": "x", "prompt": "p", "every_minutes": 30, "within_minutes": 5,
            "results_to": "notify", "target": "self" }),
    )
    .await;
    assert!(is_error);
    assert!(text.contains("by and within_minutes go with on"), "{text}");
    assert!(
        text.contains("results_to is for a fresh run: it takes no target"),
        "{text}"
    );
}

fn autopilot_status(state: &str) -> Value {
    json!({ "state": state, "active": true, "role": "parent", "cycle": 2, "branch": "autopilot/x", "tabId": "run00001" })
}

#[tokio::test]
async fn autopilot_starts_from_the_callers_folder_reads_and_stops_a_run() {
    let mut state = family();
    state["fullEnabled"] = json!(true);
    let stopped = Arc::new(Mutex::new(false));
    let was_stopped = stopped.clone();
    let caps = Caps {
        autopilot: true,
        ..Caps::default()
    };
    let (control, asked) = rig(
        210,
        state,
        caps,
        main_of(move |method, _| match method {
            "autopilot.plan" => Some(json!({ "defaultBranch": "main" })),
            "autopilot.start" => Some(autopilot_status("running")),
            "autopilot.status" => Some(if *was_stopped.lock().unwrap() {
                autopilot_status("stopping")
            } else {
                autopilot_status("running")
            }),
            "autopilot.stop" => {
                *was_stopped.lock().unwrap() = true;
                Some(autopilot_status("stopping"))
            }
            _ => None,
        }),
    );
    let (text, is_error) = run(
        &control,
        "ompdesk_autopilot",
        json!({ "action": "start", "ship": "push" }),
    )
    .await;
    assert!(!is_error, "{text}");
    assert!(
        text.starts_with("Started Autopilot in session run00001."),
        "{text}"
    );
    assert!(
        text.contains(
            "read it with ompdesk_autopilot {\"action\":\"status\",\"session\":\"run00001\"}"
        ),
        "{text}"
    );
    let started = asked
        .lock()
        .unwrap()
        .iter()
        .find(|(method, _)| method == "autopilot.start")
        .cloned()
        .unwrap();
    assert_eq!(started.1["callerTabId"], "main0001");
    assert_eq!(started.1["sourceTabId"], "main0001");
    assert_eq!(started.1["options"]["preset"], "push");
    // Full control: no card.
    assert!(
        !asked
            .lock()
            .unwrap()
            .iter()
            .any(|(method, _)| method == "confirm")
    );
    // The run counts among what the caller opened.
    assert!(
        control
            .mem()
            .opened
            .get("main0001")
            .is_some_and(|ids| ids.contains(&"run00001".to_owned()))
    );
    let (text, _) = run(
        &control,
        "ompdesk_autopilot",
        json!({ "action": "start", "ship": "commit", "advanced": { "cadence": 3 } }),
    )
    .await;
    assert_eq!(
        text,
        "advanced.cadence goes with ship release (it is the release rhythm)."
    );
    let (text, _) = run(
        &control,
        "ompdesk_autopilot",
        json!({ "action": "start", "folder": "relative" }),
    )
    .await;
    assert_eq!(text, "folder must be an absolute path.");
    let (text, _) = run(
        &control,
        "ompdesk_autopilot",
        json!({ "action": "start", "folder": "/elsewhere" }),
    )
    .await;
    assert!(
        text.starts_with("/elsewhere is not open in a session of this window on this computer."),
        "{text}"
    );
}

#[tokio::test]
async fn autopilot_stop_ends_a_run_after_its_cycle_and_refuses_what_is_no_run() {
    let mut state = family();
    state["tabs"]
        .as_array_mut()
        .unwrap()
        .push(tab("run00001", json!({ "title": "Run" })));
    state["windowOf"]["run00001"] = json!("w");
    state["parents"]["run00001"] = json!({ "callerTabId": "main0001" });
    let caps = Caps {
        autopilot: true,
        ..Caps::default()
    };
    let (control, asked) = rig(
        211,
        state,
        caps,
        main_of(|method, args| match method {
            "autopilot.status" if args["tabId"] == "run00001" => Some(autopilot_status("running")),
            "autopilot.status" => Some(json!({ "active": false })),
            "autopilot.stop" => Some(autopilot_status("stopping")),
            _ => None,
        }),
    );
    let (text, is_error) = run(
        &control,
        "ompdesk_autopilot",
        json!({ "action": "stop", "session": "run00001" }),
    )
    .await;
    assert!(!is_error, "{text}");
    assert!(text.ends_with("Ending: it finishes the cycle in flight, then closes its children and stops. It will not continue by itself."), "{text}");
    let stop = asked
        .lock()
        .unwrap()
        .iter()
        .find(|(method, _)| method == "autopilot.stop")
        .cloned()
        .unwrap();
    assert_eq!(stop.1, json!({ "tabId": "run00001", "now": false }));
    // Nothing stays marked as closing once it returned.
    assert!(!control.mem().closing.contains("run00001"));
    let (text, is_error) = run(
        &control,
        "ompdesk_autopilot",
        json!({ "action": "status", "session": "alpha001" }),
    )
    .await;
    assert!(is_error);
    assert!(text.contains("is not an Autopilot run."), "{text}");
}

#[tokio::test]
async fn the_review_board_lists_what_waits_and_what_each_session_cost() {
    let mut state = family();
    state["tabs"][2]["busy"] = json!(true);
    state["tabs"][2]["busySince"] = json!(1_700_000_000_000u64);
    let (control, _) = rig(
        212,
        state,
        Caps::default(),
        main_of(|method, args| match method {
            "branchFacts" if branch_of(args) == "omp/agent/b" => Some(facts("omp/agent/b", 1)),
            "command" => match args["command"]["type"].as_str() {
                Some("get_session_stats") => Some(
                    json!({ "success": true, "data": { "cost": 0.5, "history": { "cost": 1.25 } } }),
                ),
                Some("get_session_spend") => Some(
                    json!({ "success": true, "data": { "providers": { "a": { "billing": "metered", "cost": 1 }, "b": { "billing": "subscription", "cost": 0.25 }, "c": { "billing": "metered", "cost": 0 } } } }),
                ),
                _ => None,
            },
            _ => None,
        }),
    );
    let review = control.review("main0001").await.unwrap();
    let items = review["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["tabId"], "alpha001");
    assert_eq!(items[0]["state"], "needs-review");
    assert_eq!(items[0]["branch"], "omp/agent/a");
    assert_eq!(items[0]["commitsAhead"], 2);
    assert_eq!(items[0]["files"], 2);
    assert_eq!(items[0]["added"], 15);
    assert_eq!(items[0]["answer"], "Alpha is done: tests pass");
    assert_eq!(items[1]["state"], "running");
    assert_eq!(items[1]["runningSince"], json!(1_700_000_000_000u64));
    assert_eq!(items[1]["uncommitted"], 1);
    let usage = &review["usage"];
    assert_eq!(usage["/s/a.jsonl"]["cost"], 1.25);
    assert_eq!(
        usage["/s/a.jsonl"]["split"],
        json!({ "charged": 1.0, "estimate": 0.25 })
    );
    // The caller's own journal is part of the family's cost.
    assert_eq!(usage["/s/boss.jsonl"]["cost"], 1.25);
    assert_eq!(
        control.review_items("main0001").await.unwrap(),
        review["items"]
    );

    // A running child's step and cost are read again between full reviews; the rest stays as sent.
    let live = control
        .live_review("main0001", review.clone(), Some(vec!["beta0002".into()]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(live["items"][0], review["items"][0]);
    assert_eq!(live["usage"]["/s/b.jsonl"]["cost"], 1.25);
    assert!(
        control
            .live_review("main0001", review, Some(vec!["alpha001".into()]))
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_merged_clean_child_is_no_review_item_but_a_conflict_one_is() {
    let (control, _) = rig(
        213,
        family(),
        Caps::default(),
        main_of(|method, args| {
            (method == "branchFacts").then(|| {
                let mut facts = facts(&branch_of(args), 0);
                facts["merged"] = json!(true);
                facts
            })
        }),
    );
    assert_eq!(
        control.review("main0001").await.unwrap()["items"],
        json!([])
    );
    control
        .mem()
        .conflicts
        .insert("beta0002".into(), vec!["a.ts".into(), "b.ts".into()]);
    let review = control.review("main0001").await.unwrap();
    // Merged and clean: still nothing to review, and its conflict note is dropped.
    assert_eq!(review["items"], json!([]));
    assert!(control.mem().conflicts.is_empty());
}

#[tokio::test]
async fn family_edits_read_each_childs_turn_and_each_closed_childs_file_once() {
    let mut state = family();
    state["tabs"][2]["status"] = json!("asleep");
    state["tabs"][2]["cwd"] = json!("/worktree/asleep");
    state["closedChildren"] = json!([
        { "path": "/s/old.jsonl", "openedBySession": "/s/boss.jsonl", "title": "Old", "cwd": "/worktree/closed", "closedAt": 2000 },
        { "path": "/s/older.jsonl", "openedBySession": "/s/boss.jsonl", "title": "Older", "cwd": "/repo", "closedAt": 500 },
        { "path": "/s/a.jsonl", "openedBySession": "/s/boss.jsonl", "title": "Open still", "cwd": "/repo", "closedAt": 3000 },
    ]);
    let edit = |id: &str, at: u64| {
        json!([
            { "role": "user", "content": "go", "timestamp": at },
            { "role": "assistant", "content": [{ "type": "toolCall", "id": id, "name": "edit", "arguments": { "path": "a" } }, { "type": "text", "text": "x" }], "timestamp": at + 1 },
            { "role": "toolResult", "toolCallId": id, "toolName": "edit", "content": [], "timestamp": at + 2 },
        ])
    };
    let stored_reads = Arc::new(Mutex::new(0));
    let reads = stored_reads.clone();
    let (control, _) = rig(
        214,
        state,
        Caps::default(),
        main_of(move |method, args| match method {
            "storedMessages" => {
                *reads.lock().unwrap() += 1;
                Some(if args["session"]["path"] == "/s/old.jsonl" {
                    edit("c1", 100)
                } else {
                    edit("c2", 200)
                })
            }
            "command" => match args["command"]["type"].as_str() {
                Some("get_turn_edits") => Some(
                    json!({ "success": true, "data": { "cwd": "/repo", "startedAt": 1, "endedAt": 2, "messages": [] } }),
                ),
                Some("get_git_unlanded") => Some(
                    json!({ "success": true, "data": { "branch": "b", "target": "main", "files": [], "truncated": false } }),
                ),
                _ => None,
            },
            _ => None,
        }),
    );
    let first = control
        .family_edits("main0001", Some(1000.0))
        .await
        .unwrap();
    let members = first["members"].as_array().unwrap();
    assert_eq!(members.len(), 3, "{first}");
    assert_eq!(members[0]["key"], "/s/a.jsonl");
    assert_eq!(members[0]["live"], false);
    assert_eq!(members[0]["edits"]["cwd"], "/repo");
    assert_eq!(members[0]["unlanded"]["target"], "main");
    // Asleep: read from its saved file, and no git read.
    assert_eq!(members[1]["key"], "/s/b.jsonl");
    assert_eq!(members[1]["edits"]["cwd"], "/worktree/asleep");
    assert_eq!(members[1]["edits"]["messages"].as_array().unwrap().len(), 2);
    assert_eq!(members[1]["unlanded"], Value::Null);
    // Closed since `since`: its last turn only; a close before it, or one still open, is left out.
    assert_eq!(members[2]["key"], "/s/old.jsonl");
    assert_eq!(members[2]["edits"]["cwd"], "/worktree/closed");
    assert_eq!(members[2]["edits"]["startedAt"], 100);
    assert_eq!(members[2]["edits"]["endedAt"], 102);
    let before = *stored_reads.lock().unwrap();
    control
        .family_edits("main0001", Some(1000.0))
        .await
        .unwrap();
    // The closed child's turn never changes: read once. The asleep child's file is read again.
    assert_eq!(*stored_reads.lock().unwrap(), before + 1);
    assert_eq!(
        control.family_edits("main0001", None).await.unwrap()["members"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn stored_edits_resolve_relative_paths_in_the_owner_not_the_session_index() {
    let row = super::super::types::StoredSession {
        path: "/s/asleep.jsonl".into(),
        cwd: "/original".into(),
        ..Default::default()
    };
    let (control, _) = rig(
        219,
        family(),
        Caps::default(),
        main_of(|method, args| {
            (method == "storedMessages" && args["session"]["cwd"] == "/original").then(|| {
                json!([{ "role": "assistant", "content": [
                    { "type": "toolCall", "name": "edit", "arguments": { "path": "src/app.ts" } }
                ] }])
            })
        }),
    );
    let edits = control.stored_edits(&row, "/current").await.unwrap();
    assert_eq!(edits["cwd"], "/current");
    assert_eq!(
        edits["messages"][0]["content"][0]["arguments"]["path"],
        "src/app.ts"
    );
}

#[tokio::test]
async fn an_app_action_runs_a_command_on_another_computer_in_one_background_session() {
    let mut state = family();
    state["devices"] = json!([{ "id": "dev-studio", "name": "Studio", "state": "online" }]);
    // The background session it opens is a tab of that computer main lists but agents never see.
    state["tabs"].as_array_mut().unwrap().push(tab(
        "util0001",
        json!({ "device": "dev-studio", "hidden": true }),
    ));
    state["windowOf"]["util0001"] = json!("w");
    let (control, asked) = rig(
        215,
        state,
        Caps::default(),
        main_of(|method, args| match method {
            "spawn" => Some(json!({ "tabId": "util0001" })),
            "command" => {
                Some(json!({ "success": true, "data": { "echo": args["command"]["type"] } }))
            }
            _ => None,
        }),
    );
    let response = control
        .rpc_on("main0001", "Studio", &json!({ "type": "get_state" }))
        .await
        .unwrap();
    assert_eq!(response.data, Some(json!({ "echo": "get_state" })));
    let asked = asked.lock().unwrap().clone();
    let methods: Vec<&str> = asked.iter().map(|(method, _)| method.as_str()).collect();
    assert_eq!(methods, ["spawn", "command", "deleteSession"], "{asked:?}");
    assert_eq!(
        asked[0].1,
        json!({ "callerTabId": "main0001", "request": { "device": "dev-studio" } })
    );
    assert_eq!(asked[1].1["tabId"], "util0001");
    assert_eq!(asked[1].1["timeoutMs"], 30_000);
    assert_eq!(
        asked[2].1,
        json!({ "callerTabId": "main0001", "tabId": "util0001" })
    );
    assert!(control.mem().utility_tabs.is_empty());
    assert!(control.mem().closing.is_empty());
}

#[tokio::test]
async fn an_app_action_without_app_ports_says_so_and_the_catalog_lists_with_them() {
    let (control, _) = rig(216, family(), Caps::default(), main_of(|_, _| None));
    let (text, is_error) = run(&control, "ompdesk_app", json!({ "action": "settings.get" })).await;
    assert!(is_error);
    assert_eq!(text, "App actions are not available here.");
    assert!(control.mem().app_runs.is_empty());
    let caps = Caps {
        app_ports: true,
        ..Caps::default()
    };
    let (control, _) = rig(217, family(), caps, main_of(|_, _| None));
    let (text, is_error) = run(&control, "ompdesk_app_list", json!({ "area": "settings" })).await;
    assert!(!is_error, "{text}");
    assert!(text.contains("settings.get"), "{text}");
    let (text, is_error) = run(
        &control,
        "ompdesk_app",
        json!({ "action": "no.such.action" }),
    )
    .await;
    assert!(is_error);
    assert!(text.contains("Unknown action"), "{text}");
}

// ---- pure cuts against the TypeScript ---------------------------------------------------------------------------

fn captured(name: &str) -> Vec<Value> {
    let table: Value =
        serde_json::from_str(include_str!("captured.json")).expect("captured.json is JSON");
    table[name]
        .as_array()
        .unwrap_or_else(|| panic!("no table {name}"))
        .clone()
}

fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| same(a, b)))
        }
        _ => a == b,
    }
}

#[test]
fn a_turn_s_edit_calls_are_cut_as_the_typescript_cut_them() {
    for (index, case) in captured("turnEdits").iter().enumerate() {
        let messages = serde_json::value::to_raw_value(&case["in"][0]).unwrap();
        let got = saved_edits(&messages, case["in"][1].as_str().unwrap()).unwrap();
        assert!(
            same(&got, &case["out"]),
            "turnEdits case {index}\n got  {got}\n want {}",
            case["out"]
        );
    }
}

#[test]
fn saved_results_follow_their_call_and_only_a_nullish_end_uses_the_prompt_time() {
    let call = json!({"type": "toolCall", "name": "write", "id": "x"});
    let assistant = json!({"role": "assistant", "timestamp": null, "content": [call]});
    let result = json!({"role": "toolResult", "toolCallId": "x", "extra": {"kept": true}});
    for (last, ended) in [
        (json!({"role": "custom"}), json!(42)),
        (json!({"role": "custom", "timestamp": null}), json!(42)),
        (
            json!({"role": "custom", "timestamp": "invalid"}),
            Value::Null,
        ),
        (json!({"role": "custom", "timestamp": false}), Value::Null),
    ] {
        let rows = json!([
            {"role": "user", "timestamp": 42},
            result,
            assistant,
            result,
            last
        ]);
        let raw = serde_json::value::to_raw_value(&rows).unwrap();
        assert_eq!(
            saved_edits(&raw, "/r").unwrap(),
            json!({"cwd": "/r", "startedAt": 42, "endedAt": ended, "messages": [assistant, result]})
        );
    }
}

#[test]
fn spend_is_split_as_the_typescript_split_it() {
    for (index, case) in captured("costSplitOf").iter().enumerate() {
        let got = cost_split_of(case["in"][0].as_object().unwrap());
        assert!(
            same(
                &json!({ "charged": got.charged, "estimate": got.estimate }),
                &case["out"]
            ),
            "costSplitOf case {index}"
        );
    }
}

#[test]
fn commands_get_the_windows_the_typescript_gave_them() {
    for (index, case) in captured("timeoutForCommand").iter().enumerate() {
        let got = command_timeout(case["in"][0].as_str().unwrap());
        assert_eq!(
            got.map(|ms| json!(ms)),
            case["out"].as_u64().map(|ms| json!(ms)),
            "timeoutForCommand case {index}: {}",
            case["in"][0]
        );
    }
}

// ---- bots and items ---------------------------------------------------------------------------------------------------

/// A folder of the test's own, gone when it drops.
struct Scratch(std::path::PathBuf);

impl Scratch {
    fn new() -> Scratch {
        Scratch(crate::fs::disk::make_temp_dir("ompdesk-bots-").unwrap())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The ids of the reports main was asked to hand over, and which of them the fake bridge took as new (it drops an id
/// it already holds, as the real one does).
type Mails = Arc<Mutex<Vec<(String, bool)>>>;

/// A fake main whose bridge keeps the mail ids it took, plus `extra`.
fn bots_main(
    mails: Mails,
    extra: impl Fn(&str, &Value) -> Option<Value> + Send + 'static,
) -> impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static {
    move |method, args| {
        if let Some(value) = extra(method, args) {
            return Ok(value);
        }
        match method {
            "args.parse" => Ok(json!({ "ok": true, "args": args["args"] })),
            "mail" => {
                let id = args["details"]["id"].as_str().unwrap_or("").to_owned();
                let mut mails = mails.lock().unwrap();
                let fresh = !mails.iter().any(|(known, new)| *known == id && *new);
                mails.push((id, fresh));
                Ok(json!({ "duplicate": !fresh, "journaled": true }))
            }
            "command" => match args["command"]["type"].as_str() {
                Some("prompt") | Some("agent_control_bot") => Ok(json!({ "success": true })),
                Some("get_state") => {
                    Ok(json!({ "success": true, "data": { "isStreaming": false } }))
                }
                _ => Ok(json!({ "success": false, "error": "no" })),
            },
            "schedules.command" => Ok(json!({ "schedules": [] })),
            // The tab that holds the bot's chat now.
            "reach" => Ok(json!("bot1")),
            _ => Ok(Value::Null),
        }
    }
}

/// Reports each id was delivered as new (the bridge's own count).
fn delivered(mails: &Mails, id: &str) -> usize {
    mails
        .lock()
        .unwrap()
        .iter()
        .filter(|(known, new)| known == id && *new)
        .count()
}

fn bot_files(root: &Scratch) -> Files {
    Files {
        mail_outbox: Some(super::super::JournalFile::default()),
        bots_root: Some(root.0.clone()),
        ..Files::default()
    }
}

/// The caller `main0001`, the bot Ada's chat `bot1` in `folder` and a sender `send1` that reports to it.
fn bot_world(folder: &str) -> Value {
    json!({
        "enabled": true,
        "manageEnabled": true,
        "scheduleDevices": [""],
        "tabs": [
            tab("main0001", json!({ "title": "Boss", "sessionPath": "/s/boss.jsonl" })),
            tab("bot1", json!({ "title": "Ada chat", "cwd": folder, "sessionPath": "/s/bot.jsonl" })),
            tab("send1", json!({ "title": "Sender", "sessionPath": "/s/sender.jsonl" })),
            tab("work1", json!({ "title": "Work", "sessionPath": "/s/work.jsonl" })),
        ],
        "windowOf": { "main0001": "w", "bot1": "w", "send1": "w", "work1": "w" },
    })
}

/// Makes the bot Ada, shows main a world where `bot1` runs in its folder and lets the bot see its chat.
async fn ada(
    id: u64,
    root: &Scratch,
    mails: Mails,
    extra: impl Fn(&str, &Value) -> Option<Value> + Send + 'static,
) -> (AgentControl, Asked, String) {
    let folder = root.0.join("ada").to_string_lossy().into_owned();
    let (control, asked) = rig_files(
        id,
        bot_world(&folder),
        Caps::default(),
        &bot_files(root),
        bots_main(mails, extra),
    );
    let (text, is_error) = run(
        &control,
        "ompdesk_bot",
        json!({ "action": "create", "name": "Ada" }),
    )
    .await;
    assert!(!is_error, "{text}");
    assert!(text.contains(&folder), "{text}");
    control.observe_bots();
    let bot = control.bot_named("Ada").unwrap();
    (control, asked, bot.id)
}

fn report(id: &str) -> Value {
    json!({ "id": id, "from": "send1", "fromTitle": "Sender", "kind": "note", "text": id })
}

const NOTE: crate::agentctl::rules::mail::MailDelivery =
    crate::agentctl::rules::mail::MailDelivery {
        trigger_turn: false,
        aside: false,
    };

#[tokio::test]
async fn a_bot_is_made_in_its_own_folder_and_its_first_chat_becomes_its_home_once() {
    let root = Scratch::new();
    let (control, asked, _) = ada(9_701, &root, Mails::default(), |_, _| None).await;
    assert!(root.0.join("ada").is_dir());
    let bot = control.bot_named("ada").unwrap();
    assert_eq!(bot.home.as_deref(), Some("/s/bot.jsonl"));
    assert_eq!(bot.sessions, vec!["/s/bot.jsonl"]);
    assert_eq!(bot.stale_days, Some(7.0));
    // A second bot of the same name is refused; one with another name gets a folder of its own.
    let (text, is_error) = run(
        &control,
        "ompdesk_bot",
        json!({ "action": "create", "name": "ada" }),
    )
    .await;
    assert!(is_error && text.contains("already a bot"), "{text}");
    std::fs::create_dir_all(root.0.join("bo")).unwrap();
    let (text, _) = run(
        &control,
        "ompdesk_bot",
        json!({ "action": "create", "name": "Bo" }),
    )
    .await;
    assert!(
        text.contains(&*root.0.join("bo-2").to_string_lossy()),
        "{text}"
    );
    // Another chat joins; the home stays the first.
    let mut world = bot_world(&root.0.join("ada").to_string_lossy());
    world["tabs"][3]["cwd"] = json!(root.0.join("ada").to_string_lossy());
    crate::ports::apply_state(control.host.port(), 1, &world.to_string()).unwrap();
    control.observe_bots();
    let bot = control.bot_named("Ada").unwrap();
    assert_eq!(bot.home.as_deref(), Some("/s/bot.jsonl"));
    assert_eq!(bot.sessions, vec!["/s/bot.jsonl", "/s/work.jsonl"]);
    let (text, _) = run(&control, "ompdesk_bot", json!({ "action": "list" })).await;
    assert!(text.contains("- Ada (id "), "{text}");
    assert!(
        asked
            .lock()
            .unwrap()
            .iter()
            .any(|(method, _)| method == "botsChanged")
    );
}

#[tokio::test]
async fn a_paused_bot_holds_its_mail_and_a_resume_hands_each_held_report_over_once() {
    let root = Scratch::new();
    let mails = Mails::default();
    let (control, _, _) = ada(9_702, &root, mails.clone(), |_, _| None).await;
    let (text, is_error) = run(
        &control,
        "ompdesk_bot",
        json!({ "action": "pause", "bot": "Ada" }),
    )
    .await;
    assert!(!is_error, "{text}");
    control
        .host
        .mail("bot1", "m1", &report("m1"), NOTE)
        .await
        .unwrap();
    control.redeliver_mail_now().await;
    assert_eq!(delivered(&mails, "m1"), 0, "held while paused");
    assert_eq!(
        control
            .host
            .outbox()
            .unwrap()
            .kept_for("/s/bot.jsonl")
            .len(),
        1
    );
    // Two resumes and a new report, all at once: each report reaches the chat once.
    let resume = json!({ "action": "resume", "bot": "Ada" });
    let (first, second, sent) = tokio::join!(
        control.run("main0001", "ompdesk_bot", resume.clone(), None),
        control.run("main0001", "ompdesk_bot", resume, None),
        control.host.mail("bot1", "m2", &report("m2"), NOTE),
    );
    assert!(
        !first.is_error && !second.is_error,
        "{} / {}",
        first.text,
        second.text
    );
    sent.unwrap();
    control.redeliver_mail_now().await;
    control.redeliver_mail_now().await;
    assert_eq!(delivered(&mails, "m1"), 1);
    assert_eq!(delivered(&mails, "m2"), 1);
    assert!(control.host.outbox().unwrap().pending().is_empty());
}

#[tokio::test]
async fn a_send_to_a_paused_bot_is_refused_and_nothing_changes() {
    let root = Scratch::new();
    let (control, asked, id) = ada(9_703, &root, Mails::default(), |_, _| None).await;
    control
        .bots_command(json!({ "action": "update", "id": id, "paused": true }))
        .await
        .unwrap();
    assert_eq!(
        control.paused_bot_of("/s/bot.jsonl").as_deref(),
        Some("Ada")
    );
    let (text, is_error) = run(
        &control,
        "ompdesk_session_send",
        json!({ "session": "bot1", "message": "hi" }),
    )
    .await;
    assert!(is_error && text.contains("The bot Ada is paused"), "{text}");
    let (text, is_error) = run(
        &control,
        "ompdesk_session_send",
        json!({ "session": "bot:Ada", "message": "hi" }),
    )
    .await;
    assert!(is_error && text.contains("The bot Ada is paused"), "{text}");
    assert!(
        !asked
            .lock()
            .unwrap()
            .iter()
            .any(|(method, args)| method == "command" && args["command"]["type"] == "prompt")
    );
}

#[tokio::test]
async fn deleting_a_bot_drops_its_held_mail_with_a_note_to_its_sender_and_removes_its_wakes() {
    let root = Scratch::new();
    let mails = Mails::default();
    let (control, asked, id) = ada(
        9_704,
        &root,
        mails.clone(),
        |method, args| {
            (method == "schedules.command" && args["request"]["action"] == "get").then(|| {
                let wake = |id: &str, session: &str| {
                    let mut row = scheduled(id, "wake", json!({ "kind": "interval", "minutes": 60 }));
                    row["wakeSession"] = json!(session);
                    row
                };
                json!({ "schedules": [wake("sch-bot", "/s/bot.jsonl"), wake("sch-other", "/s/sender.jsonl")] })
            })
        },
    )
    .await;
    control
        .bots_command(json!({ "action": "update", "id": id, "paused": true }))
        .await
        .unwrap();
    control
        .host
        .mail("bot1", "m1", &report("m1"), NOTE)
        .await
        .unwrap();
    control
        .host
        .mail("bot1", "m2", &report("m2"), NOTE)
        .await
        .unwrap();
    let state = control
        .bots_command(json!({ "action": "delete", "id": id }))
        .await
        .unwrap();
    assert_eq!(state["bots"], json!([]));
    assert!(root.0.join("ada").is_dir(), "its folder stays");
    assert!(
        control
            .host
            .outbox()
            .unwrap()
            .kept_for("/s/bot.jsonl")
            .is_empty()
    );
    assert_eq!(delivered(&mails, "m1") + delivered(&mails, "m2"), 0);
    let notes: Vec<Value> = asked
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, args)| method == "mail" && args["tabId"] == "send1")
        .map(|(_, args)| args.clone())
        .collect();
    assert_eq!(notes.len(), 1, "one note per sender");
    assert!(
        notes[0]["content"]
            .as_str()
            .unwrap()
            .contains("The bot Ada was deleted")
    );
    assert_eq!(notes[0]["delivery"]["triggerTurn"], false);
    let deleted: Vec<Value> = asked
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, args)| {
            method == "schedules.command" && args["request"]["action"] == "delete"
        })
        .map(|(_, args)| args["request"]["id"].clone())
        .collect();
    assert_eq!(deleted, vec![json!("sch-bot")]);
}

#[tokio::test]
async fn an_owner_change_is_mailed_once_per_version_and_an_empty_one_or_a_gone_item_mails_nothing()
{
    let root = Scratch::new();
    let mails = Mails::default();
    let (control, _, _) = ada(9_705, &root, mails.clone(), |_, _| None).await;
    let out = control
        .run(
            "bot1",
            "ompdesk_item",
            json!({ "action": "add", "title": "Ship it" }),
            None,
        )
        .await;
    assert!(!out.is_error, "{}", out.text);
    let out = control
        .run(
            "bot1",
            "ompdesk_item",
            json!({ "action": "set", "item": "1", "ask": "Which day?", "options": ["Mon", "Tue"], "recommended": 1 }),
            None,
        )
        .await;
    assert!(
        out.text.contains("[needs_you]") && out.text.contains("Which day?"),
        "{}",
        out.text
    );
    let item = control
        .items()
        .find(&control.bot_named("Ada").unwrap().id, "1")
        .cloned()
        .unwrap();
    assert_eq!(item.version, 2);
    // A comment: a quiet note named by the new version.
    control
        .bots_command(json!({ "action": "item", "id": item.id, "comment": "soon" }))
        .await
        .unwrap();
    assert_eq!(delivered(&mails, &format!("item-{}-v3", item.id)), 1);
    // The same change again is a new version; nothing at all is no change.
    control
        .bots_command(json!({ "action": "item", "id": item.id }))
        .await
        .unwrap();
    assert_eq!(control.items().get(&item.id).unwrap().version, 3);
    // The answer starts a turn and clears the question.
    control
        .bots_command(json!({ "action": "item", "id": item.id, "answer": { "choice": 1 } }))
        .await
        .unwrap();
    let answered = control.items().get(&item.id).cloned().unwrap();
    assert_eq!(answered.version, 4);
    assert!(answered.question.is_none());
    assert_eq!(answered.status, "working");
    assert_eq!(delivered(&mails, &format!("item-{}-v4", item.id)), 1);
    // A change to an item that is gone: no mail, no question, no error.
    let before = mails.lock().unwrap().len();
    control
        .bots_command(json!({ "action": "item", "id": "item-gone", "answer": { "text": "x" } }))
        .await
        .unwrap();
    assert_eq!(mails.lock().unwrap().len(), before);
}

#[tokio::test]
async fn a_closed_item_writes_its_journal_line_and_items_work_only_in_a_bot_s_chat() {
    let root = Scratch::new();
    let (control, _, _) = ada(9_706, &root, Mails::default(), |_, _| None).await;
    let (text, is_error) = run(&control, "ompdesk_item", json!({ "action": "list" })).await;
    assert!(
        is_error && text.contains("ompdesk_item works in a bot's chat"),
        "{text}"
    );
    control
        .run(
            "bot1",
            "ompdesk_item",
            json!({ "action": "add", "title": "Tidy up" }),
            None,
        )
        .await;
    let out = control
        .run(
            "bot1",
            "ompdesk_item",
            json!({ "action": "done", "item": "#1", "note": "done" }),
            None,
        )
        .await;
    assert!(out.text.contains("[done]"), "{}", out.text);
    let journal = root.0.join("ada").join("memory").join("journal");
    let month = std::fs::read_dir(&journal)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let text = std::fs::read_to_string(month).unwrap();
    assert!(
        text.starts_with("- 20") && text.trim_end().ends_with("| item #1 | done | Tidy up"),
        "{text}"
    );
    let listed = control
        .run(
            "bot1",
            "ompdesk_item",
            json!({ "action": "list", "status": "done" }),
            None,
        )
        .await;
    assert!(listed.text.contains("#1 [done] Tidy up"), "{}", listed.text);
}

#[tokio::test]
async fn an_item_reads_stale_snoozed_and_limited_from_what_it_links() {
    let root = Scratch::new();
    let (control, _, bot_id) = ada(9_707, &root, Mails::default(), |_, _| None).await;
    let bot = control.bot_named("Ada").unwrap();
    let now = control.now();
    let item = crate::agentctl::journal::items::ItemRecord {
        id: "item-x".into(),
        bot: bot_id,
        number: 1,
        status: "working".into(),
        touched: now - 8.0 * 24.0 * 60.0 * 60_000.0,
        snoozed_until: Some(crate::aimemory::value::iso((now + 60_000.0) as u64)),
        links: vec![crate::agentctl::journal::items::ItemLink {
            kind: "session".into(),
            target: "/s/work.jsonl".into(),
            ..Default::default()
        }],
        ..Default::default()
    };
    let mut world = bot_world(&bot.folder);
    world["tabs"][3]["scheduledRetry"] =
        json!({ "at": 1_800_000_000_000.0, "attempt": 1, "limit": true });
    crate::ports::apply_state(control.host.port(), 1, &world.to_string()).unwrap();
    let read = control.read_item(&control.host.state(), Some(&bot), &item, now);
    assert_eq!(read.stale, Some(true));
    assert!(item.snoozed(now));
    assert_eq!(read.links[0].state.as_deref(), Some("done"));
    assert_eq!(
        read.limit_until.as_deref(),
        Some(&*crate::aimemory::value::iso(1_800_000_000_000))
    );
    // A bot that never goes stale, and a linked session that is not waiting for a limit.
    let calm = crate::agentctl::journal::bots::BotRecord {
        stale_days: None,
        ..bot.clone()
    };
    world["tabs"][3]["scheduledRetry"] = Value::Null;
    crate::ports::apply_state(control.host.port(), 2, &world.to_string()).unwrap();
    let read = control.read_item(&control.host.state(), Some(&calm), &item, now);
    assert_eq!(read.stale, None);
    assert_eq!(read.limit_until, None);
}

#[tokio::test]
async fn a_session_an_item_opened_is_linked_and_names_its_file_once_it_has_one() {
    let root = Scratch::new();
    let (control, _, _) = ada(9_708, &root, Mails::default(), |_, _| None).await;
    let (text, is_error) = run(
        &control,
        "ompdesk_session_open",
        json!({ "message": "go", "item": "1" }),
    )
    .await;
    assert!(
        is_error && text.contains("item works only from a bot's chat"),
        "{text}"
    );
    control
        .run(
            "bot1",
            "ompdesk_item",
            json!({ "action": "add", "title": "Build it" }),
            None,
        )
        .await;
    let caller = control
        .host
        .state()
        .tabs
        .iter()
        .find(|tab| tab.tab_id == "bot1")
        .cloned()
        .unwrap();
    control.link_opened(&caller, "1", "child1").unwrap();
    let bot = control.bot_named("Ada").unwrap();
    let item = control.items().find(&bot.id, "1").cloned().unwrap();
    assert_eq!(item.status, "working");
    assert_eq!(item.links[0].target, "child1");
    let mut world = bot_world(&bot.folder);
    world["tabs"]
        .as_array_mut()
        .unwrap()
        .push(tab("child1", json!({ "sessionPath": "/s/child.jsonl" })));
    crate::ports::apply_state(control.host.port(), 1, &world.to_string()).unwrap();
    control.observe_bots();
    assert_eq!(
        control.items().get(&item.id).unwrap().links[0].target,
        "/s/child.jsonl"
    );
}

#[tokio::test]
async fn a_bot_by_name_is_its_home_chat_and_another_computer_reaches_it_only_when_let() {
    let root = Scratch::new();
    let (control, _, _) = ada(9_709, &root, Mails::default(), |_, _| None).await;
    let tabs = control.host.state().tabs.clone();
    let caller = tabs[0].clone();
    assert_eq!(
        control
            .bot_target(&caller, &tabs, "Ada")
            .await
            .unwrap()
            .tab_id,
        "bot1"
    );
    let refused = control
        .bot_home("Ada", Some("dev1"), Some("MacBook"))
        .unwrap_err();
    assert_eq!(
        refused.message(),
        "This bot does not take messages from MacBook"
    );
    control
        .bots_command(json!({ "action": "update", "id": control.bot_named("Ada").unwrap().id, "reach": ["dev1"] }))
        .await
        .unwrap();
    assert_eq!(
        control
            .bot_home("Ada", Some("dev1"), Some("MacBook"))
            .unwrap()["path"],
        "/s/bot.jsonl"
    );
    assert!(control.bot_target(&caller, &tabs, "Nobody").await.is_err());
}

#[tokio::test]
async fn look_around_is_one_daily_wake_of_the_home_chat_and_goes_when_turned_off() {
    let root = Scratch::new();
    let (control, asked, id) = ada(9_710, &root, Mails::default(), |method, args| {
        (method == "schedules.create").then(|| {
            let mut made = scheduled(
                "sch-look",
                args["draft"]["name"].as_str().unwrap(),
                args["draft"]["frequency"].clone(),
            );
            made["wakeSession"] = args["draft"]["wakeSession"].clone();
            json!({ "id": "sch-look", "state": { "schedules": [made] } })
        })
    })
    .await;
    let (text, is_error) = run(
        &control,
        "ompdesk_bot",
        json!({ "action": "look_around", "bot": "Ada", "on": true, "time": "08:30" }),
    )
    .await;
    assert!(!is_error, "{text}");
    let create = asked
        .lock()
        .unwrap()
        .iter()
        .find(|(method, _)| method == "schedules.create")
        .map(|(_, args)| args["draft"].clone())
        .unwrap();
    assert_eq!(create["name"], "Ada: Look around");
    assert_eq!(create["wakeSession"], "/s/bot.jsonl");
    assert_eq!(
        create["frequency"],
        json!({ "kind": "daily", "time": "08:30", "days": [] })
    );
    assert!(create["prompt"].as_str().unwrap().contains("NO_REPLY"));
    assert_eq!(
        control.bot_named("Ada").unwrap().look_around.as_deref(),
        Some("sch-look")
    );
    control
        .bots_command(json!({ "action": "update", "id": id, "lookAround": { "on": false } }))
        .await
        .unwrap();
    assert!(
        asked
            .lock()
            .unwrap()
            .iter()
            .any(|(method, args)| method == "schedules.command"
                && args["request"]["action"] == "delete"
                && args["request"]["id"] == "sch-look")
    );
    assert_eq!(control.bot_named("Ada").unwrap().look_around, None);
}

#[tokio::test]
async fn a_session_handed_to_a_bot_gets_its_home_chat_as_opener_and_the_text_from_it() {
    let root = Scratch::new();
    let (control, asked, id) = ada(9_711, &root, Mails::default(), |_, _| None).await;
    control
        .bots_command(json!({ "action": "handTo", "id": id, "session": "work1", "text": "Finish the release notes" }))
        .await
        .unwrap();
    let asked = asked.lock().unwrap().clone();
    let opener = asked
        .iter()
        .find(|(method, _)| method == "setOpener")
        .unwrap();
    assert_eq!(opener.1, json!({ "tabId": "work1", "openerTabId": "bot1" }));
    let prompt = asked
        .iter()
        .find(|(method, args)| {
            method == "command" && args["tabId"] == "work1" && args["command"]["type"] == "prompt"
        })
        .unwrap();
    assert!(
        prompt.1["command"]["message"]
            .as_str()
            .unwrap()
            .contains("Finish the release notes")
    );
}
