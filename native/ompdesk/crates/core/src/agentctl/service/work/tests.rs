//! Tests of the work tools against a fake main (what `service.test.ts` asks of compare, merge, schedule, Autopilot, the
//! review board, family edits, auto-close and the app tools; the full run of that file against the real core is the
//! parity suite at cutover) and of the pure cuts (`turnEdits`, `costSplitOf`, the command timeouts) against tables
//! captured from the TypeScript (`captured.json`).

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
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
    state: Value,
    caps: Caps,
    reply: impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static,
) -> (AgentControl, Asked) {
    rig_files(state, caps, &Files::default(), reply)
}

/// `rig` over journals in `files`.
fn rig_files(
    state: Value,
    caps: Caps,
    files: &Files,
    reply: impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static,
) -> (AgentControl, Asked) {
    let (writer, reader) = tokio::io::duplex(1 << 20);
    let (tx, _task) = crate::wire::spawn_writer(writer);
    let events = crate::server::test_events(&tx);
    std::mem::forget(tx);
    // Port IDs share one process-wide registry with the fixed IDs used by other test modules.
    static NEXT_PORT: AtomicU64 = AtomicU64::new(1 << 32);
    let id = NEXT_PORT.fetch_add(1, Ordering::Relaxed);
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
    let (control, _) = rig(state, Caps::default(), main_of(|_, _| None));
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
    let (control, _) = rig(state, Caps::default(), main_of(|_, _| None));
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
    let (control, _) = rig(family(), Caps::default(), main_of(|_, _| None));
    let (text, _) = run(&control, "ompdesk_schedule", json!({ "action": "list" })).await;
    assert_eq!(text, "Scheduled runs are not available on this computer.");
    let mut state = family();
    state["scheduleDevices"] = json!([""]);
    let (control, _) = rig(
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
        "Invalid arguments for ompdesk_schedule: create needs prompt; create needs exactly one of every_minutes, daily_at, cron, at, in_minutes or on"
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
    let (control, _) = rig(family(), Caps::default(), main_of(|_, _| None));
    let (text, is_error) = run(&control, "ompdesk_app", json!({ "action": "settings.get" })).await;
    assert!(is_error);
    assert_eq!(text, "App actions are not available here.");
    assert!(control.mem().app_runs.is_empty());
    let caps = Caps {
        app_ports: true,
        ..Caps::default()
    };
    let (control, _) = rig(family(), caps, main_of(|_, _| None));
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
            // A bot's folder moved: each session lands in `<to>/.moved/` (stock files it under the new folder's dir).
            "bots.relocate" => {
                let to = args["to"].as_str().unwrap_or("");
                let moved: serde_json::Map<String, Value> = args["sessions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(|session| (session.to_owned(), json!(moved_to(to, session))))
                    .collect();
                Ok(Value::Object(moved))
            }
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
        items: Some(root.0.join("items.json")),
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

/// Where the fake main's `bots.relocate` puts `session` when the bot's folder moved to `to`.
fn moved_to(to: &str, session: &str) -> String {
    format!(
        "{to}/.moved/{}",
        session.rsplit('/').next().unwrap_or(session)
    )
}

/// Makes the bot Ada, shows main a world where `bot1` runs in its folder and lets the bot see its chat.
async fn ada(
    root: &Scratch,
    mails: Mails,
    extra: impl Fn(&str, &Value) -> Option<Value> + Send + 'static,
) -> (AgentControl, Asked, String) {
    ada_in(root, &bot_files(root), mails, extra).await
}

/// `ada` over the journals in `files`.
async fn ada_in(
    root: &Scratch,
    files: &Files,
    mails: Mails,
    extra: impl Fn(&str, &Value) -> Option<Value> + Send + 'static,
) -> (AgentControl, Asked, String) {
    let folder = root.0.join("ada").to_string_lossy().into_owned();
    let (control, asked) = rig_files(
        bot_world(&folder),
        Caps::default(),
        files,
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
    let (control, asked, _) = ada(&root, Mails::default(), |_, _| None).await;
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
    // An offer makes nothing: the owner's Create bot on its card does; a taken name cannot be offered.
    let (text, is_error) = run(
        &control,
        "ompdesk_bot",
        json!({ "action": "offer", "name": "Cy", "text": "Watches the release." }),
    )
    .await;
    assert!(!is_error && text.contains("Create bot"), "{text}");
    assert!(control.bot_named("Cy").is_err());
    let (text, is_error) = run(
        &control,
        "ompdesk_bot",
        json!({ "action": "offer", "name": "Ada" }),
    )
    .await;
    assert!(is_error && text.contains("already exists"), "{text}");
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
    let (control, _, _) = ada(&root, mails.clone(), |_, _| None).await;
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
    let m2 = report("m2");
    let (first, second, sent) = tokio::join!(
        control.run("main0001", "ompdesk_bot", resume.clone(), None),
        control.run("main0001", "ompdesk_bot", resume, None),
        control.host.mail("bot1", "m2", &m2, NOTE),
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
    let (control, asked, id) = ada(&root, Mails::default(), |_, _| None).await;
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
    let (control, _, _) = ada(&root, mails.clone(), |_, _| None).await;
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
    let (control, _, _) = ada(&root, Mails::default(), |_, _| None).await;
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
    let (control, _, bot_id) = ada(&root, Mails::default(), |_, _| None).await;
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
    // A snoozed item is never stale.
    assert_eq!(read.stale, None);
    assert!(item.snoozed(now));
    assert_eq!(read.links[0].state.as_deref(), Some("done"));
    // Awake, In progress with no live worker, it is; Planned waits three times as long; Needs you does not wait.
    let awake = |status: &str| crate::agentctl::journal::items::ItemRecord {
        status: status.into(),
        snoozed_until: None,
        ..item.clone()
    };
    let stale = |status: &str| {
        control
            .read_item(&control.host.state(), Some(&bot), &awake(status), now)
            .stale
    };
    assert_eq!(stale("working"), Some(true));
    assert_eq!(stale("planned"), None);
    assert_eq!(stale("needs_you"), Some(true));
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
    let (control, _, _) = ada(&root, Mails::default(), |_, _| None).await;
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
async fn a_bot_by_name_is_its_home_chat_and_another_computer_reaches_it_unless_restricted() {
    let root = Scratch::new();
    let (control, _, _) = ada(&root, Mails::default(), |_, _| None).await;
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
    assert_eq!(
        control
            .bot_home("Ada", Some("dev1"), Some("MacBook"))
            .unwrap()["path"],
        "/s/bot.jsonl"
    );
    control
        .bots_command(
            json!({ "action": "update", "id": control.bot_named("Ada").unwrap().id, "reach": [] }),
        )
        .await
        .unwrap();
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

/// The `schedules.create` drafts main was asked for, oldest first.
fn created(asked: &Asked) -> Vec<Value> {
    asked
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _)| method == "schedules.create")
        .map(|(_, args)| args["draft"].clone())
        .collect()
}

fn deleted(asked: &Asked, schedule: &str) -> bool {
    asked.lock().unwrap().iter().any(|(method, args)| {
        method == "schedules.command"
            && args["request"]["action"] == "delete"
            && args["request"]["id"] == schedule
    })
}

/// Orca's `bot-look-around.ts:42-62`: on for a new bot, every 4 hours on weekdays, its schedule saved once the bot has
/// its home chat; a change names only its fields and saves the schedule again; off removes it.
#[tokio::test]
async fn look_around_is_on_for_a_new_bot_every_four_hours_on_weekdays_and_follows_its_setting() {
    let root = Scratch::new();
    let (control, asked, id) = ada(&root, Mails::default(), |method, args| {
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
    assert!(control.bot_named("Ada").unwrap().look().on);
    control.arm_looks().await;
    let first = created(&asked);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0]["name"], "Ada: Look around");
    assert_eq!(first[0]["wakeSession"], "/s/bot.jsonl");
    assert_eq!(
        first[0]["frequency"],
        json!({ "kind": "cron", "expr": "0 8,12,16,20 * * 1-5" })
    );
    let prompt = first[0]["prompt"].as_str().unwrap();
    assert!(prompt.contains("\"action\":\"suggest\""), "{prompt}");
    assert!(prompt.contains("NO_REPLY"), "{prompt}");
    assert_eq!(
        control.bot_named("Ada").unwrap().look_around.as_deref(),
        Some("sch-look")
    );
    // Armed once: a second pass saves nothing.
    control.arm_looks().await;
    assert_eq!(created(&asked).len(), 1);

    control
        .bots_command(json!({ "action": "update", "id": id, "lookAround": { "every": "mornings", "weekdaysOnly": false, "focus": "PR reviews" } }))
        .await
        .unwrap();
    assert!(deleted(&asked, "sch-look"));
    let again = created(&asked);
    assert_eq!(again.len(), 2);
    assert_eq!(
        again[1]["frequency"],
        json!({ "kind": "cron", "expr": "0 8 * * *" })
    );
    assert!(
        again[1]["prompt"]
            .as_str()
            .unwrap()
            .contains("Look for: PR reviews")
    );
    let look = control.bot_named("Ada").unwrap().look();
    assert!(look.on && !look.weekdays_only && look.every == "mornings");

    let refused = control
        .bots_command(json!({ "action": "update", "id": id, "lookAround": { "every": "hourly" } }))
        .await;
    assert!(refused.is_err());

    control
        .bots_command(json!({ "action": "update", "id": id, "lookAround": { "on": false } }))
        .await
        .unwrap();
    assert_eq!(control.bot_named("Ada").unwrap().look_around, None);
    assert!(!control.bot_named("Ada").unwrap().look().on);
    control.arm_looks().await;
    assert_eq!(created(&asked).len(), 2);
}

/// Orca's `bot-look-around-state.ts`: a look's list replaces the open one (a repeat keeps its id and age), a dismissed
/// one is refused in any spacing or case, a credential is refused, and only a bot's own chat suggests.
#[tokio::test]
async fn a_look_replaces_the_suggestions_list_and_a_dismissed_one_stays_out() {
    let root = Scratch::new();
    let (control, _, id) = ada(&root, Mails::default(), |_, _| None).await;
    let suggest = |list: Value| {
        let control = control.clone();
        async move {
            let outcome = control
                .run(
                    "bot1",
                    "ompdesk_bot",
                    json!({ "action": "suggest", "suggestions": list }),
                    None,
                )
                .await;
            (outcome.text, outcome.is_error)
        }
    };
    let listed = |control: &AgentControl| -> Vec<Value> {
        control.bots_state()["looks"][0]["items"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    let one = json!({ "title": "Review PR 12", "why": "It waits on you.", "ask": "Review PR 12", "link": "https://github.com/o/r/pull/12/files#r1" });
    let two = json!({ "title": "Answer Kim", "why": "She asked twice.", "ask": "Draft my answer to Kim" });
    let (text, is_error) = suggest(json!([one, two])).await;
    assert!(!is_error, "{text}");
    let before = listed(&control);
    assert_eq!(before.len(), 2);
    // The same pull request by another link: it keeps its id; Kim, not listed again, is replaced.
    let again = json!({ "title": "Review pull request 12", "why": "Still waiting.", "ask": "Review it", "link": "https://github.com/o/r/pull/12" });
    let (text, is_error) = suggest(json!([again])).await;
    assert!(!is_error, "{text}");
    let after = listed(&control);
    assert_eq!(after.len(), 1);
    assert_eq!(after[0]["id"], before[0]["id"]);
    assert_eq!(after[0]["title"], "Review pull request 12");

    let suggestion = after[0]["id"].as_str().unwrap().to_owned();
    control
        .bots_command(
            json!({ "action": "suggestion", "id": id, "suggestion": suggestion, "act": "dismiss" }),
        )
        .await
        .unwrap();
    assert!(listed(&control).is_empty());
    let (text, is_error) = suggest(json!([{ "title": "Review  PR 12", "why": "w", "ask": "a", "link": "https://GitHub.com/o/r/pull/12#x" }])).await;
    assert!(is_error && text.contains("dismissed"), "{text}");
    let (text, is_error) = suggest(json!([{ "title": "Rotate the key", "why": "w", "ask": "use ghp_0123456789abcdefghijABCDEFGHIJ" }])).await;
    assert!(is_error && text.contains("credential"), "{text}");
    // A session in no bot's folder is not a look.
    let outcome = control
        .run(
            "main0001",
            "ompdesk_bot",
            json!({ "action": "suggest", "suggestions": [two] }),
            None,
        )
        .await;
    assert!(outcome.is_error, "{}", outcome.text);
    // Seen: nothing listed is new any more.
    let (text, is_error) =
        suggest(json!([{ "title": "Answer Kim", "why": "w", "ask": "a" }])).await;
    assert!(!is_error, "{text}");
    control
        .bots_command(json!({ "action": "looksSeen", "id": id }))
        .await
        .unwrap();
    let seen = control.bots_state()["looks"][0]["seenAt"].as_f64().unwrap();
    assert!(
        listed(&control)
            .iter()
            .all(|item| item["createdAt"].as_f64().unwrap() <= seen)
    );
}

/// Orca's `bot-types.ts:207` `permissionMode`: the owner picks how a bot's chats start; the bot cannot widen it.
#[tokio::test]
async fn only_the_owner_picks_the_approval_mode_and_skill_projects_a_bots_chats_start_with() {
    let root = Scratch::new();
    let (control, _, id) = ada(&root, Mails::default(), |_, _| None).await;
    let launch = |control: &AgentControl| control.bots_state()["bots"][0]["launch"].clone();
    assert_eq!(launch(&control), json!([]));
    let outcome = control
        .run(
            "bot1",
            "ompdesk_bot",
            json!({ "action": "set", "approval": "yolo" }),
            None,
        )
        .await;
    assert!(!outcome.is_error, "{}", outcome.text);
    assert_eq!(control.bot_named("Ada").unwrap().chat_approval, None);
    assert_eq!(launch(&control), json!([]));

    let repo = root.0.join("repo").to_string_lossy().into_owned();
    control
        .bots_command(json!({ "action": "update", "id": id, "chatApproval": "always-ask", "skillProjects": [repo] }))
        .await
        .unwrap();
    let flags = launch(&control);
    assert_eq!(flags[0], "--approval-mode");
    assert_eq!(flags[1], "always-ask");
    assert_eq!(flags[2], "--config");
    let overlay = std::fs::read_to_string(flags[3].as_str().unwrap()).unwrap();
    assert!(overlay.contains("skills"), "{overlay}");
    assert!(
        control
            .bots_command(json!({ "action": "update", "id": id, "chatApproval": "everything" }))
            .await
            .is_err()
    );
    control
        .bots_command(
            json!({ "action": "update", "id": id, "chatApproval": null, "skillProjects": [] }),
        )
        .await
        .unwrap();
    assert_eq!(launch(&control), json!([]));
}

/// Orca's `bot-work-store.ts`: a session a bot's chat opened is its worker, with its branch; one of the bot's own chats
/// never is.
#[tokio::test]
async fn a_session_a_bots_chat_opened_is_its_worker_with_its_branch() {
    let root = Scratch::new();
    let folder = root.0.join("ada").to_string_lossy().into_owned();
    let mut world = bot_world(&folder);
    world["tabs"].as_array_mut().unwrap().extend([
        tab("kid1", json!({ "title": "Fix the build", "cwd": "/other-repo", "sessionPath": "/s/worker.jsonl", "openedBySession": "/s/chat2.jsonl", "worktree": worktree("omp/agent/fix"), "busy": true })),
        tab("manual", json!({ "title": "Fix the build", "cwd": "/other-repo", "sessionPath": "/s/manual.jsonl" })),
        tab("chat2", json!({ "cwd": folder, "sessionPath": "/s/now-in-this-tab.jsonl" })),
        tab("reopened", json!({ "cwd": folder, "sessionPath": "/s/chat2.jsonl" })),
        tab("peer", json!({ "device": "other-host", "cwd": folder, "sessionPath": "/s/chat2.jsonl" })),
    ]);
    world["parents"] = json!({
        "kid1": { "callerTabId": "chat2" },
        "work1": { "callerTabId": "peer" }
    });
    let files = Files {
        bots: Some(root.0.join("bots.json")),
        ..bot_files(&root)
    };
    let (control, asked) = rig_files(
        world,
        Caps::default(),
        &files,
        bots_main(Mails::default(), |_, _| None),
    );
    let (text, is_error) = run(
        &control,
        "ompdesk_bot",
        json!({ "action": "create", "name": "Ada" }),
    )
    .await;
    assert!(!is_error, "{text}");
    control.observe_bots();
    let workers = control.bots_state()["bots"][0]["workers"].clone();
    assert_eq!(workers.as_array().unwrap().len(), 1, "{workers}");
    assert_eq!(workers[0]["session"], "/s/worker.jsonl");
    assert_eq!(workers[0]["openedBySession"], "/s/chat2.jsonl");
    assert_eq!(workers[0]["branch"], "omp/agent/fix");
    assert_eq!(workers[0]["state"], "working");
    assert_eq!(workers[0]["tabId"], "kid1");

    let (restored, _) = rig_files(
        json!({ "tabs": [] }),
        Caps::default(),
        &files,
        bots_main(Mails::default(), |_, _| None),
    );
    let closed = restored.bots_state()["bots"][0]["workers"][0].clone();
    assert_eq!(closed["session"], "/s/worker.jsonl");
    assert_eq!(closed["openedBySession"], "/s/chat2.jsonl");
    assert_eq!(closed["state"], "closed");

    let hand = control
        .run(
            "kid1",
            "ompdesk_bot",
            json!({ "action": "hand", "bot": "Ada", "session": "work1", "text": "Take over" }),
            None,
        )
        .await;
    assert!(hand.is_error && hand.text.contains("Report to your opener"));
    let calls = asked.lock().unwrap();
    assert!(!calls.iter().any(|(op, _)| op == "setOpener"));
}

/// Orca's `sharing/bot-package-archive.ts`, as a local file: a bot's soul, skills and memory topics go out and come
/// back as a new bot; one holding a credential is not exported.
#[tokio::test]
async fn a_bot_exported_to_a_package_file_comes_back_as_a_new_bot() {
    let root = Scratch::new();
    let (control, _, id) = ada(&root, Mails::default(), |_, _| None).await;
    let folder = root.0.join("ada");
    std::fs::write(
        folder.join("SOUL.md"),
        "# Ada\n\nShe reviews pull requests.\n",
    )
    .unwrap();
    std::fs::create_dir_all(folder.join(".omp/skills/review")).unwrap();
    std::fs::write(
        folder.join(".omp/skills/review/SKILL.md"),
        "---\nname: review\n---\nRead the diff.\n",
    )
    .unwrap();
    std::fs::create_dir_all(folder.join("memory")).unwrap();
    std::fs::write(folder.join("memory/repos.md"), "- o/r is the main repo\n").unwrap();
    std::fs::write(folder.join("MEMORY.md"), "- the owner's private fact\n").unwrap();
    std::fs::write(folder.join("picture.png"), b"original picture").unwrap();
    let file = root
        .0
        .join("ada.ompdesk-bot.json")
        .to_string_lossy()
        .into_owned();
    let answer = control
        .bots_command(json!({ "action": "export", "id": id, "file": file }))
        .await
        .unwrap();
    assert_eq!(answer["file"], file.as_str());
    let written = std::fs::read_to_string(&file).unwrap();
    assert!(!written.contains("private fact"), "{written}");
    let mut legacy: Value = serde_json::from_str(&written).unwrap();
    assert!(legacy.get("picture").is_none());
    legacy["picture"] = json!(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII="
    );
    std::fs::write(&file, legacy.to_string()).unwrap();

    let state = control
        .bots_command(json!({ "action": "importPackage", "file": file }))
        .await
        .unwrap();
    let copy = state["bots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|bot| bot["name"] == "Ada 2")
        .cloned()
        .unwrap();
    let copied = std::path::PathBuf::from(copy["folder"].as_str().unwrap());
    assert_ne!(copied, folder);
    assert!(
        std::fs::read_to_string(copied.join("SOUL.md"))
            .unwrap()
            .contains("reviews pull requests")
    );
    assert!(copied.join(".omp/skills/review/SKILL.md").is_file());
    assert!(
        std::fs::read_to_string(copied.join("memory/repos.md"))
            .unwrap()
            .contains("main repo")
    );
    assert!(!copied.join("MEMORY.md").exists());
    assert!(copy.get("picture").is_none());
    assert!(!copied.join("picture.png").exists());
    assert_eq!(
        std::fs::read(folder.join("picture.png")).unwrap(),
        b"original picture"
    );
    control
        .bots_command(json!({ "action": "export", "id": copy["id"], "file": file }))
        .await
        .unwrap();
    let exported: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert!(exported.get("picture").is_none());

    std::fs::write(
        folder.join("memory/keys.md"),
        "token ghp_0123456789abcdefghijABCDEFGHIJ\n",
    )
    .unwrap();
    let refused = control
        .bots_command(json!({ "action": "export", "id": id, "file": file }))
        .await;
    assert!(refused.is_err());
}

#[tokio::test]
async fn a_session_handed_to_a_bot_gets_its_home_chat_as_opener_and_the_text_from_it() {
    let root = Scratch::new();
    let files = Files {
        bots: Some(root.0.join("bots.json")),
        ..bot_files(&root)
    };
    let (control, asked, id) = ada_in(&root, &files, Mails::default(), |_, _| None).await;
    let mut world = bot_world(&root.0.join("ada").to_string_lossy());
    let rex = root.0.join("rex").to_string_lossy().into_owned();
    world["tabs"].as_array_mut().unwrap().push(tab(
        "rex1",
        json!({ "cwd": rex, "sessionPath": "/s/rex.jsonl" }),
    ));
    world["parents"] = json!({ "work1": { "callerTabId": "rex1" } });
    crate::ports::apply_state(control.host.port(), 2, &world.to_string()).unwrap();
    control
        .bots_command(json!({ "action": "create", "name": "Rex" }))
        .await
        .unwrap();
    control.observe_bots();
    assert_eq!(
        control.bot_named("Rex").unwrap().workers[0].session,
        "/s/work.jsonl"
    );
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
    // Restart before another tick can see the new opener. Neither tab is open.
    let (restored, _) = rig_files(
        json!({ "tabs": [] }),
        Caps::default(),
        &files,
        bots_main(Mails::default(), |_, _| None),
    );
    assert!(restored.bot_named("Rex").unwrap().workers.is_empty());
    let ada = restored.bot_named("Ada").unwrap();
    assert_eq!(ada.workers.len(), 1);
    assert_eq!(ada.workers[0].session, "/s/work.jsonl");
    assert_eq!(
        ada.workers[0].opened_by_session.as_deref(),
        Some("/s/bot.jsonl")
    );
}

#[tokio::test]
async fn the_owners_create_carries_the_purpose_and_a_refused_seed_makes_no_bot() {
    let root = Scratch::new();
    let (control, _asked, _id) = ada(&root, Mails::default(), |_, _| None).await;
    let state = control
        .bots_command(json!({
            "action": "create",
            "name": "Rex",
            "purpose": "Reviews pull requests.",
            "skills": [{ "name": "pr-review", "content": "# Review\nRead the diff." }],
        }))
        .await
        .unwrap();
    let rex = state["bots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|bot| bot["name"] == "Rex")
        .unwrap();
    assert_eq!(rex["specialty"], json!("Reviews pull requests."));
    assert!(root.0.join("rex/.omp/skills/pr-review/SKILL.md").is_file());
    let refused = control
        .bots_command(json!({ "action": "create", "name": "Bad", "skills": [{ "name": "../x", "content": "x" }] }))
        .await;
    assert!(refused.is_err());
    assert!(control.bot_named("Bad").is_err());
    assert!(
        !root.0.join("bad").exists(),
        "the folder it made goes with it"
    );
    let old_picture = root.0.join("rex/picture.png");
    std::fs::write(&old_picture, b"owner's file").unwrap();
    let state = control
        .bots_command(json!({ "action": "update", "id": rex["id"], "picture": null, "quiet": ["done", "nonsense"] }))
        .await
        .unwrap();
    let rex = state["bots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|bot| bot["name"] == "Rex")
        .unwrap();
    assert_eq!(rex["quiet"], json!(["done"]));
    assert!(rex.get("picture").is_none());
    assert_eq!(std::fs::read(&old_picture).unwrap(), b"owner's file");
    let soul = control
        .bots_command(json!({ "action": "file", "id": rex["id"], "file": "SOUL.md" }))
        .await
        .unwrap();
    assert_eq!(soul["content"], json!("# Rex\n\nReviews pull requests.\n"));
}

#[tokio::test]
async fn an_answer_names_its_question_and_a_resent_comment_posts_once() {
    let root = Scratch::new();
    let mails = Mails::default();
    let (control, _, bot_id) = ada(&root, mails.clone(), |_, _| None).await;
    let tool = |args: Value| control.run("bot1", "ompdesk_item", args, None);
    assert!(
        !tool(json!({ "action": "add", "title": "Plan the trip" }))
            .await
            .is_error
    );
    let out = tool(json!({
        "action": "set",
        "item": "1",
        "ask": "Two things first.",
        "asks": [
            { "question": "Which day?", "options": ["Mon", "Tue"], "recommended": 1 },
            { "question": "Who comes?", "options": ["Ann", "Bo"], "multi": true }
        ]
    }))
    .await;
    assert!(!out.is_error, "{}", out.text);
    let item = control.items().find(&bot_id, "1").cloned().unwrap();
    let question = item.question.clone().unwrap();
    assert_eq!(item.status, "needs_you");
    assert_eq!(question.decisions.len(), 2);
    let asked = item
        .events
        .iter()
        .rfind(|event| event.kind == "asked")
        .unwrap();
    assert_eq!(
        question.id, asked.id,
        "the question names the event that asked it"
    );
    assert!(asked.text.as_deref().unwrap().contains("2. Who comes?"));
    // A comment sent twice with one request id is one comment and one mail.
    for _ in 0..2 {
        control
            .bots_command(
                json!({ "action": "item", "id": item.id, "comment": "soon", "requestId": "r1" }),
            )
            .await
            .unwrap();
    }
    let commented = control.items().get(&item.id).cloned().unwrap();
    assert_eq!(commented.version, item.version + 1);
    assert_eq!(
        delivered(&mails, &format!("item-{}-v{}", item.id, commented.version)),
        1
    );
    // The bot asks again: an answer to the first question is refused and writes nothing.
    tool(
        json!({ "action": "set", "item": "1", "ask": "Rather Friday?", "options": ["Yes", "No"] }),
    )
    .await;
    let again = control.items().get(&item.id).cloned().unwrap();
    assert_ne!(again.question.as_ref().unwrap().id, question.id);
    let state = control
        .bots_command(json!({ "action": "item", "id": item.id, "answer": { "text": "Mon", "question": question.id } }))
        .await
        .unwrap();
    assert_eq!(state["refused"], json!("question_changed"));
    assert_eq!(
        control.items().get(&item.id).unwrap().version,
        again.version
    );
    // An answer to the question it names goes through and starts a turn.
    let state = control
        .bots_command(json!({ "action": "item", "id": item.id, "answer": { "choice": 0, "question": again.question.as_ref().unwrap().id } }))
        .await
        .unwrap();
    assert_eq!(state.get("refused"), None);
    let answered = control.items().get(&item.id).cloned().unwrap();
    assert_eq!(answered.status, "working");
    let event = answered
        .events
        .iter()
        .rfind(|event| event.kind == "answered")
        .unwrap();
    assert_eq!(event.text.as_deref(), Some("Yes"));
    assert_eq!(
        event.question,
        again.question.as_ref().map(|question| question.id)
    );
    assert_eq!(
        delivered(&mails, &format!("item-{}-v{}", item.id, answered.version)),
        1
    );
}

#[tokio::test]
async fn a_move_of_several_items_is_one_mail_and_waiting_says_what_it_waits_on() {
    let root = Scratch::new();
    let mails = Mails::default();
    let (control, asked, bot_id) = ada(&root, mails.clone(), |_, _| None).await;
    for title in ["One", "Two"] {
        control
            .run(
                "bot1",
                "ompdesk_item",
                json!({ "action": "add", "title": title }),
                None,
            )
            .await;
    }
    let id = |number: &str| control.items().find(&bot_id, number).unwrap().id.clone();
    let (one, two) = (id("1"), id("2"));
    control
        .bots_command(json!({ "action": "item", "ids": [one, two], "status": "waiting", "wait": "the vendor" }))
        .await
        .unwrap();
    for id in [&one, &two] {
        let item = control.items().get(id).cloned().unwrap();
        assert_eq!(item.status, "waiting");
        assert_eq!(item.wait.as_ref().unwrap().text, "the vendor");
        let moved = item
            .events
            .iter()
            .rfind(|event| event.kind == "status")
            .unwrap();
        assert_eq!(moved.from.as_deref(), Some("planned"));
        assert_eq!(moved.note.as_deref(), Some("the vendor"));
    }
    let mailed: Vec<Value> = asked
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _)| method == "mail")
        .map(|(_, args)| args.clone())
        .collect();
    assert_eq!(mailed.len(), 1, "one mail for both items");
    assert_eq!(
        mailed[0]["details"]["id"],
        json!(format!("item-{one}-v2+2"))
    );
    // Waiting again edits what it waits on.
    control
        .bots_command(json!({ "action": "item", "id": one, "status": "waiting", "wait": "QA" }))
        .await
        .unwrap();
    let item = control.items().get(&one).cloned().unwrap();
    assert_eq!(item.wait.as_ref().unwrap().text, "QA");
    let edit = item
        .events
        .iter()
        .rfind(|event| event.kind == "status")
        .unwrap();
    assert_eq!(
        (edit.from.as_deref(), edit.note.as_deref()),
        (Some("waiting"), Some("QA"))
    );
    // A snooze alone keeps the status and mails nobody; opening the Items tab moves the seen mark.
    let before = mails.lock().unwrap().len();
    control
        .bots_command(json!({ "action": "item", "id": two, "snoozeUntil": "2099-01-01T09:00:00Z" }))
        .await
        .unwrap();
    assert_eq!(mails.lock().unwrap().len(), before);
    assert_eq!(control.items().get(&two).unwrap().status, "waiting");
    control
        .bots_command(json!({ "action": "itemsOpened", "id": bot_id }))
        .await
        .unwrap();
    let newest = control.items().newest_event(&bot_id);
    assert!(newest > 0);
    assert_eq!(control.bot_named("Ada").unwrap().items_seen, newest);
}

#[tokio::test]
async fn a_room_asks_the_members_its_reply_mode_names_and_a_member_answers_with_ompdesk_room() {
    let root = Scratch::new();
    let mails = Mails::default();
    let (control, _, ada_id) = ada(&root, mails.clone(), |_, _| None).await;
    assert!(
        !run(
            &control,
            "ompdesk_bot",
            json!({ "action": "create", "name": "Bo" })
        )
        .await
        .1
    );
    let state = control
        .bots_command(json!({ "action": "roomCreate", "name": "Team", "bots": ["Ada", "Bo"] }))
        .await
        .unwrap();
    let room = state["rooms"][0].clone();
    let room_id = room["id"].as_str().unwrap().to_owned();
    assert_eq!(room["replyMode"], json!("all"));
    assert_eq!(room["members"].as_array().unwrap().len(), 2);
    // The owner's post asks everyone; Bo has no chat yet, so its ask fails and says why. A resend posts once.
    for _ in 0..2 {
        control
            .bots_command(
                json!({ "action": "roomPost", "id": room_id, "text": "Plans?", "messageId": "m1" }),
            )
            .await
            .unwrap();
    }
    let room = control.rooms().find(&room_id).cloned().unwrap();
    assert_eq!(room.messages.len(), 1);
    let turns = &room.messages[0].turns;
    assert_eq!(
        turns
            .iter()
            .map(|turn| turn.state.as_str())
            .collect::<Vec<_>>(),
        ["asked", "failed"]
    );
    assert_eq!(delivered(&mails, &format!("room-{room_id}-1-{ada_id}")), 1);
    // Ada answers in the room, handing over to Bo by name.
    let out = control
        .run(
            "bot1",
            "ompdesk_room",
            json!({ "action": "post", "room": "team", "text": "Ask @Bo." }),
            None,
        )
        .await;
    assert!(
        !out.is_error && out.text.contains("asked Bo"),
        "{}",
        out.text
    );
    let room = control.rooms().find(&room_id).cloned().unwrap();
    assert_eq!(room.messages[0].turns[0].state, "replied");
    assert_eq!(room.messages[1].author, ada_id);
    assert_eq!(room.messages[1].hops, 1);
    let listed = control
        .run("bot1", "ompdesk_room", json!({ "action": "list" }), None)
        .await;
    assert!(
        listed.text.contains("Team") && listed.text.contains("with Bo"),
        "{}",
        listed.text
    );
    // Only @mentions: a post naming nobody asks nobody.
    control
        .bots_command(json!({ "action": "roomUpdate", "id": room_id, "replyMode": "mentions" }))
        .await
        .unwrap();
    control
        .bots_command(json!({ "action": "roomPost", "id": room_id, "text": "FYI" }))
        .await
        .unwrap();
    assert!(
        control.rooms().find(&room_id).unwrap().messages[2]
            .turns
            .is_empty()
    );
    // A session that is no bot's chat has no rooms.
    let (text, is_error) = run(&control, "ompdesk_room", json!({ "action": "list" })).await;
    assert!(is_error && text.contains("works in a bot's chat"), "{text}");
}

#[tokio::test]
async fn a_paired_device_lists_this_computers_bots_and_its_answer_lands_here_once() {
    // The host: Ada, whose item asks the owner.
    let root = Scratch::new();
    let mails = Mails::default();
    let (host, host_asked, ada_id) = ada(&root, mails.clone(), |_, _| None).await;
    let tool = |args: Value| host.run("bot1", "ompdesk_item", args, None);
    assert!(
        !tool(json!({ "action": "add", "title": "Pick a day" }))
            .await
            .is_error
    );
    let out = tool(
        json!({ "action": "set", "item": "1", "ask": "Which day?", "options": ["Mon", "Tue"] }),
    )
    .await;
    assert!(!out.is_error, "{}", out.text);
    let item = host.items().find(&ada_id, "1").cloned().unwrap();
    let question = item.question.as_ref().unwrap().id;
    let whole = host.bots_share();
    assert_eq!(whole["state"]["bots"][0]["name"], "Ada");
    assert_eq!(whole["state"]["items"][0]["status"], "needs_you");
    assert_eq!(whole["state"].get("rooms"), None);
    // A round trip to the fake main: every tell before it is recorded.
    run(&host, "ompdesk_bot", json!({ "action": "list" })).await;
    let told_before = host_asked.lock().unwrap().len();

    // The host makes a paired device's answer; sent again (a retry over the link), it changes nothing.
    let request = json!({ "action": "item", "id": item.id, "answer": { "choice": 0, "question": question }, "requestId": "r1" });
    let answer = host
        .bots_from(request.clone(), "dev-b", "MacBook")
        .await
        .unwrap();
    assert_eq!(answer["state"]["items"][0]["status"], "working");
    let again = host
        .bots_from(request.clone(), "dev-b", "MacBook")
        .await
        .unwrap();
    assert_eq!(again["version"], answer["version"]);
    let answered = host.items().get(&item.id).cloned().unwrap();
    assert_eq!(
        answered
            .events
            .iter()
            .filter(|event| event.kind == "answered")
            .count(),
        1
    );
    assert_eq!(
        delivered(&mails, &format!("item-{}-v{}", item.id, answered.version)),
        1
    );
    // Every device heard the change as the rows it touched, on the version it held.
    run(&host, "ompdesk_bot", json!({ "action": "list" })).await;
    let shared: Vec<Value> = host_asked.lock().unwrap()[told_before..]
        .iter()
        .filter(|(method, _)| method == "botsShared")
        .map(|(_, args)| args["change"].clone())
        .collect();
    assert_eq!(
        shared.first().map(|change| &change["base"]),
        Some(&whole["version"])
    );
    assert!(
        shared
            .iter()
            .all(|change| change["set"]["bots"] == json!([]))
    );
    // A bot is made where it is to live: a device cannot make one here.
    let refused = host
        .bots_from(
            json!({ "action": "create", "name": "Cy" }),
            "dev-b",
            "MacBook",
        )
        .await
        .unwrap_err();
    assert!(
        refused.message().contains("MacBook cannot create"),
        "{}",
        refused.message()
    );
    assert!(host.bot_named("Cy").is_err());
    for request in [
        json!({"action":"allowLegacyPeers", "ids":[ada_id]}),
        json!({"action":"update", "id":ada_id, "reach":["dev-b"]}),
        json!({"action":"update", "id":ada_id, "chatApproval":"always-ask"}),
        json!({"action":"update", "id":ada_id, "skillProjects":[]}),
    ] {
        assert!(host.bots_from(request, "dev-b", "MacBook").await.is_err());
    }

    // The device: its main carries a change of the host's to it (`botsCommand`) and hands back the host's answer.
    let carried = answer.clone();
    let (device, device_asked) = rig(
        bot_world("/elsewhere"),
        Caps::default(),
        move |method, _| {
            Ok(if method == "botsCommand" {
                carried.clone()
            } else {
                Value::Null
            })
        },
    );
    let heard = device.bots_remote(
        &json!({ "device": "dev-a", "name": "Mini", "online": true, "change": whole }),
    );
    assert_eq!(heard["applied"], true);
    let state = device.bots_state();
    assert_eq!(state["bots"], json!([]));
    assert_eq!(state["remote"][0]["device"], "dev-a");
    assert_eq!(state["remote"][0]["name"], "Mini");
    assert_eq!(state["remote"][0]["bots"][0]["id"], json!(ada_id));
    let state = device.bots_command(request.clone()).await.unwrap();
    assert_eq!(state["remote"][0]["items"][0]["status"], "working");
    assert!(
        device_asked
            .lock()
            .unwrap()
            .iter()
            .any(|(method, args)| method == "botsCommand"
                && args["device"] == "dev-a"
                && args["request"]["requestId"] == "r1")
    );
    // The host goes offline: the last copy stays, and a change waits for nobody: it is refused at once.
    device.bots_remote(&json!({ "device": "dev-a", "name": "Mini", "online": false }));
    let error = device.bots_command(request).await.unwrap_err();
    assert!(
        error.message().contains("Mini is offline"),
        "{}",
        error.message()
    );
    let state = device.bots_state();
    assert_eq!(state["remote"][0]["online"], false);
    assert_eq!(state["remote"][0]["items"][0]["status"], "working");
    // Unpaired, its copy goes.
    device.bots_remote(&json!({ "device": "dev-a", "forget": true }));
    assert_eq!(device.bots_state().get("remote"), None);
}

#[tokio::test]
async fn a_group_asks_another_computers_bot_on_its_host_and_takes_its_post_once() {
    // The device: Ada is its own; Rex lives on paired host dev-a, whose copy it keeps.
    let root = Scratch::new();
    let (device, asked, ada_id) = ada(&root, Mails::default(), |method, _| {
        (method == "botsCommand").then(|| json!({ "asked": true }))
    })
    .await;
    let rex = json!({ "id": "bot-rex", "name": "Rex", "folder": "/h/rex", "home": "/h/rex.jsonl", "sessions": ["/h/rex.jsonl"] });
    device.bots_remote(&json!({
        "device": "dev-a",
        "name": "Mini",
        "online": true,
        "change": { "version": "e1.1", "state": { "bots": [rex], "items": [] } },
    }));
    // A group needs one of this computer's bots; another computer's join beside them.
    let alone = device
        .bots_command(json!({ "action": "roomCreate", "name": "Solo", "bots": ["Rex"] }))
        .await
        .unwrap_err();
    assert!(
        alone.message().contains("this computer's bots"),
        "{}",
        alone.message()
    );
    let state = device
        .bots_command(json!({ "action": "roomCreate", "name": "Team", "bots": [ada_id, "Rex"] }))
        .await
        .unwrap();
    let room = state["rooms"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(state["rooms"][0]["members"], json!([ada_id, "bot-rex"]));
    device
        .bots_command(
            json!({ "action": "roomPost", "id": room, "text": "Which day?", "messageId": "m1" }),
        )
        .await
        .unwrap();
    // Rex is asked on its host, with the room's words; Ada here.
    let ask = asked
        .lock()
        .unwrap()
        .iter()
        .find(|(method, args)| method == "botsCommand" && args["request"]["action"] == "roomAsk")
        .map(|(_, args)| args.clone())
        .unwrap();
    assert_eq!(ask["device"], "dev-a");
    assert_eq!(ask["request"]["id"], "bot-rex");
    assert_eq!(ask["request"]["room"], json!(room));
    assert!(
        ask["request"]["text"]
            .as_str()
            .unwrap()
            .contains("Which day?")
    );
    let turns = device.rooms().find(&room).unwrap().messages[0]
        .turns
        .clone();
    assert_eq!(
        turns
            .iter()
            .map(|turn| turn.state.as_str())
            .collect::<Vec<_>>(),
        ["asked", "asked"]
    );
    // Its post comes back from the host, once by its id, and answers its ask.
    for _ in 0..2 {
        device
            .bots_room_post(&json!({ "device": "dev-a", "room": room, "bot": "bot-rex", "text": "Tuesday.", "id": "post-r1" }))
            .await
            .unwrap();
    }
    let kept = device.rooms().find(&room).cloned().unwrap();
    let posts: Vec<&str> = kept
        .messages
        .iter()
        .map(|message| message.text.as_str())
        .collect();
    assert_eq!(posts, ["Which day?", "Tuesday."]);
    assert_eq!(kept.messages[1].name, "Rex");
    assert!(
        kept.messages[0]
            .turns
            .iter()
            .any(|turn| turn.bot == "bot-rex" && turn.state == "replied")
    );
    // Another device's word for Rex is not Rex's.
    assert!(device
        .bots_room_post(&json!({ "device": "dev-z", "room": room, "bot": "bot-rex", "text": "No.", "id": "post-z" }))
        .await
        .is_err());
    // Offline, Rex is not asked: its turn says why.
    device.bots_remote(&json!({ "device": "dev-a", "name": "Mini", "online": false }));
    device
        .bots_command(
            json!({ "action": "roomPost", "id": room, "text": "Still there?", "messageId": "m2" }),
        )
        .await
        .unwrap();
    let last = device
        .rooms()
        .find(&room)
        .unwrap()
        .messages
        .last()
        .cloned()
        .unwrap();
    let rex_turn = last
        .turns
        .iter()
        .find(|turn| turn.bot == "bot-rex")
        .unwrap();
    assert_eq!(rex_turn.state, "failed");
    assert!(
        rex_turn
            .error
            .as_deref()
            .unwrap()
            .contains("Mini is offline")
    );
}

#[tokio::test]
async fn a_bot_asked_by_a_paired_computers_group_answers_it_there() {
    let root = Scratch::new();
    let mails = Mails::default();
    let (host, asked, ada_id) = ada(&root, mails.clone(), |method, _| {
        (method == "botsRoomPostTo").then(|| json!({ "sent": true }))
    })
    .await;
    let ask = json!({ "action": "roomAsk", "id": ada_id, "room": "room-b1", "roomName": "Team", "mailId": "room-room-b1-1-x", "text": "In the group “Team” (room room-b1), Owner: Which day?" });
    for _ in 0..2 {
        host.bots_from(ask.clone(), "dev-b", "MacBook")
            .await
            .unwrap();
    }
    // The question reached Ada's home chat once, as the group's on that computer.
    assert_eq!(delivered(&mails, "room-room-b1-1-x"), 1);
    let (text, is_error) = {
        let out = host
            .run("bot1", "ompdesk_room", json!({ "action": "list" }), None)
            .await;
        (out.text, out.is_error)
    };
    assert!(
        !is_error && text.contains("Team (room room-b1): on MacBook"),
        "{text}"
    );
    let out = host
        .run(
            "bot1",
            "ompdesk_room",
            json!({ "action": "post", "room": "Team", "text": "Tuesday." }),
            None,
        )
        .await;
    assert!(
        !out.is_error && out.text.contains("Posted in Team on MacBook"),
        "{}",
        out.text
    );
    let sent = asked
        .lock()
        .unwrap()
        .iter()
        .find(|(method, _)| method == "botsRoomPostTo")
        .map(|(_, args)| args.clone())
        .unwrap();
    assert_eq!(sent["device"], "dev-b");
    assert_eq!(sent["post"]["room"], "room-b1");
    assert_eq!(sent["post"]["bot"], json!(ada_id));
    assert_eq!(sent["post"]["text"], "Tuesday.");
    // A device's group is no group of this computer: reading it says where it is.
    let out = host
        .run(
            "bot1",
            "ompdesk_room",
            json!({ "action": "read", "room": "Team" }),
            None,
        )
        .await;
    assert!(
        out.is_error && out.text.contains("on MacBook"),
        "{}",
        out.text
    );
}

/// A fake main whose bot chat's bridge answers `agent_control_bot` with what `facts` holds now.
fn chat_facts(
    facts: &Arc<Mutex<Value>>,
) -> impl Fn(&str, &Value) -> Option<Value> + Send + 'static {
    let facts = facts.clone();
    move |method, args| {
        (method == "command" && args["command"]["type"] == "agent_control_bot")
            .then(|| json!({ "success": true, "data": facts.lock().unwrap().clone() }))
    }
}

fn said(owner_turns: u64, streaming: bool, kickoff: &str) -> Value {
    json!({ "changed": false, "ownerTurns": owner_turns, "streaming": streaming, "kickoff": kickoff })
}

/// The bot contexts handed to `bot1`, oldest first, and the kickoff each asked about.
fn bot_calls(asked: &Asked) -> Vec<(Value, Value)> {
    asked
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, args)| {
            method == "command"
                && args["tabId"] == "bot1"
                && args["command"]["type"] == "agent_control_bot"
        })
        .map(|(_, args)| {
            (
                args["command"]["context"].clone(),
                args["command"]["kickoff"].clone(),
            )
        })
        .collect()
}

// ---- a bot's folder follows its name (`bot_move.rs`) --------------------------------------------------------------

/// `bot_files` that also keeps the registry on disk (`bots.json`), as a restart reads it again.
fn kept_files(root: &Scratch) -> Files {
    Files {
        bots: Some(root.0.join("bots.json")),
        ..bot_files(root)
    }
}

/// A fake Schedules service over `book`: `get` lists it, `save` replaces the schedule of that id with the draft.
fn schedule_book(
    book: Arc<Mutex<Vec<Value>>>,
) -> impl Fn(&str, &Value) -> Option<Value> + Send + 'static {
    move |method, args| {
        (method == "schedules.command").then(|| {
            let request = &args["request"];
            let mut schedules = book.lock().unwrap();
            if request["action"] == "save"
                && let Some(row) = schedules.iter_mut().find(|row| row["id"] == request["id"])
            {
                let mut saved = request["draft"].clone();
                saved["id"] = row["id"].clone();
                // Main answers JSON numbers as JavaScript writes them (`5`, never the core's `5.0`, which a flattened
                // draft's tagged frequency cannot take back); no move changes a frequency.
                saved["frequency"] = row["frequency"].clone();
                *row = saved;
            }
            json!({ "schedules": schedules.clone(), "runs": [], "nextRuns": {} })
        })
    }
}

/// A routine of the bot in `folder` that wakes its home chat `/s/bot.jsonl`.
fn routine(id: &str, name: &str, folder: &str) -> Value {
    let mut row = scheduled(id, name, json!({ "kind": "interval", "minutes": 5 }));
    row["cwd"] = json!(folder);
    row["wakeSession"] = json!("/s/bot.jsonl");
    row
}

/// A world with only the caller: no chat runs in any bot's folder.
fn quiet_world() -> Value {
    json!({
        "enabled": true,
        "manageEnabled": true,
        "scheduleDevices": [""],
        "tabs": [tab("main0001", json!({ "title": "Boss", "sessionPath": "/s/boss.jsonl" }))],
        "windowOf": { "main0001": "w" },
    })
}

/// A control over `bots` written to the registry first (a start after an update), whose folders exist.
fn started_with(root: &Scratch, bots: Value) -> (AgentControl, Asked) {
    if !root.0.join("bots.json").exists() {
        std::fs::write(root.0.join("bots.json"), bots.to_string()).unwrap();
    }
    rig_files(
        quiet_world(),
        Caps::default(),
        &kept_files(root),
        bots_main(Mails::default(), |_, _| None),
    )
}

/// A link to the folder `target` at `at`: a symlink on POSIX, a junction on Windows (`disk/scratch.rs`'s fixture).
fn link(target: &std::path::Path, at: &std::path::Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, at).unwrap();
    #[cfg(windows)]
    crate::sys::junction(target, at).unwrap();
}

fn relocations(asked: &Asked) -> usize {
    asked
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _)| method == "bots.relocate")
        .count()
}

#[tokio::test]
async fn a_new_bot_speaks_first_once_and_its_first_run_ends_with_the_owners_first_turn() {
    let root = Scratch::new();
    let mails = Mails::default();
    let facts = Arc::new(Mutex::new(said(0, false, "none")));
    let (control, asked, id) = ada(&root, mails.clone(), chat_facts(&facts)).await;
    // Orca bot-new-record.ts:36: every new bot starts in its first run.
    assert!(control.bot_named("Ada").unwrap().first_run);
    control.bots_tick().await;
    let bot = control.bot_named("Ada").unwrap();
    assert_eq!(bot.kickoffs.len(), 1, "the home chat is sent the kickoff");
    let kickoff = bot.kickoffs[0].clone();
    assert!(kickoff.starts_with("kickoff-"), "{kickoff}");
    assert_eq!(delivered(&mails, &kickoff), 1);
    let mail = asked
        .lock()
        .unwrap()
        .iter()
        .find(|(method, args)| method == "mail" && args["details"]["id"] == kickoff)
        .map(|(_, args)| args.clone())
        .unwrap();
    assert_eq!(mail["tabId"], "bot1");
    assert_eq!(mail["details"]["kind"], "question");
    assert_eq!(mail["delivery"]["triggerTurn"], true);
    assert!(
        mail["content"]
            .as_str()
            .unwrap()
            .contains("you were just created")
    );
    let calls = bot_calls(&asked);
    assert_eq!(
        calls[0].0["bot"]["firstRun"], true,
        "the home chat carries the first-run rules"
    );
    // It answered: asked again (the kickoff was not answered at the first look), it is not sent twice.
    *facts.lock().unwrap() = said(0, false, "spoke");
    control.bots_tick().await;
    control.bots_tick().await;
    let bot = control.bot_named("Ada").unwrap();
    assert_eq!(bot.kickoffs, vec![kickoff.clone()]);
    assert!(bot.first_run && !bot.kickoff_silent);
    assert_eq!(bot_calls(&asked).last().unwrap().1, json!(kickoff));
    // The owner's first turn runs: nothing is asked while main says it is at work, and first run lasts.
    let folder = root.0.join("ada").to_string_lossy().into_owned();
    let mut world = bot_world(&folder);
    world["tabs"][1]["busy"] = json!(true);
    crate::ports::apply_state(control.host.port(), 2, &world.to_string()).unwrap();
    *facts.lock().unwrap() = said(1, true, "spoke");
    let before = bot_calls(&asked).len();
    control.bots_tick().await;
    assert_eq!(bot_calls(&asked).len(), before);
    assert!(control.bot_named("Ada").unwrap().first_run);
    // A turn ended there (main's last run moved): asked again; omp still says a turn runs, so asked at the next pass.
    world["tabs"][1]["busy"] = json!(false);
    world["tabs"][1]["lastRun"] = json!({ "id": 1, "stopReason": "stop" });
    crate::ports::apply_state(control.host.port(), 3, &world.to_string()).unwrap();
    control.bots_tick().await;
    assert_eq!(bot_calls(&asked).len(), before + 1);
    assert!(
        control.bot_named("Ada").unwrap().first_run,
        "omp still says a turn runs"
    );
    *facts.lock().unwrap() = said(1, false, "spoke");
    control.bots_tick().await;
    let bot = control.bot_named("Ada").unwrap();
    assert!(!bot.first_run, "the owner's first turn ended");
    assert_eq!(bot.kickoffs.len(), 1);
    control.bots_tick().await;
    assert_eq!(
        bot_calls(&asked).last().unwrap().0["bot"]["firstRun"],
        false
    );
    // Nothing is retried once first run is over.
    assert!(!control.kickoff_retry(&id, true).await.unwrap());
}

#[tokio::test]
async fn a_bot_made_with_a_purpose_still_runs_first_run_and_an_owner_first_gets_no_kickoff() {
    let root = Scratch::new();
    let mails = Mails::default();
    let facts = Arc::new(Mutex::new(said(1, false, "none")));
    let (control, _asked, _id) = ada(&root, mails.clone(), chat_facts(&facts)).await;
    let state = control
        .bots_command(
            json!({ "action": "create", "name": "Cy", "purpose": "Keeps the changelog honest." }),
        )
        .await
        .unwrap();
    let cy = control.bot_named("Cy").unwrap();
    assert!(Path::new(&cy.folder).join("SOUL.md").is_file());
    assert!(
        cy.first_run,
        "SOUL.md written from the purpose does not end first run"
    );
    let listed = state["bots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|bot| bot["name"] == "Cy")
        .cloned()
        .unwrap();
    assert_eq!(listed["firstRun"], true);
    // Ada's home chat already holds the owner's message: no kickoff, and its turn has ended.
    control.bots_tick().await;
    let ada = control.bot_named("Ada").unwrap();
    assert!(ada.kickoffs.is_empty());
    assert!(!ada.first_run);
}

#[tokio::test]
async fn a_kickoff_that_ended_silent_is_sent_again_once_by_itself_and_on_each_try_again() {
    let root = Scratch::new();
    let mails = Mails::default();
    let facts = Arc::new(Mutex::new(said(0, false, "none")));
    let (control, _asked, id) = ada(&root, mails.clone(), chat_facts(&facts)).await;
    control.bots_tick().await;
    // The page reopens before the next bot pass has noticed that the turn ended without a word.
    // The live chat, not the last listed silent flag, decides whether to retry.
    assert!(!control.bot_named("Ada").unwrap().kickoff_silent);
    *facts.lock().unwrap() = said(0, false, "silent");
    assert!(control.kickoff_retry(&id, false).await.unwrap());
    let bot = control.bot_named("Ada").unwrap();
    assert_eq!(bot.kickoffs.len(), 2);
    assert_ne!(bot.kickoffs[0], bot.kickoffs[1]);
    assert!(!bot.kickoff_silent);
    assert_eq!(delivered(&mails, &bot.kickoffs[1]), 1);
    // Opened again: Orca retries by itself only once.
    assert!(!control.kickoff_retry(&id, false).await.unwrap());
    // The owner's Try again sends it whenever it ended silent.
    control.bots_tick().await;
    assert!(control.bot_named("Ada").unwrap().kickoff_silent);
    assert!(control.kickoff_retry(&id, true).await.unwrap());
    assert_eq!(control.bot_named("Ada").unwrap().kickoffs.len(), 3);
    // Not while it speaks, a turn runs, or once the owner wrote.
    for facts_now in [
        said(0, false, "spoke"),
        said(0, true, "silent"),
        said(1, false, "silent"),
        said(0, false, "queued"),
    ] {
        *facts.lock().unwrap() = facts_now;
        assert!(!control.kickoff_retry(&id, true).await.unwrap());
    }
    // Two opens at once send one: the attempt is claimed in the record before the mail goes.
    *facts.lock().unwrap() = said(0, false, "silent");
    let (one, two) = tokio::join!(
        control.kickoff_retry(&id, true),
        control.kickoff_retry(&id, true)
    );
    assert_eq!(u8::from(one.unwrap()) + u8::from(two.unwrap()), 1);
    let bot = control.bot_named("Ada").unwrap();
    assert_eq!(bot.kickoffs.len(), 4);
    for kickoff in &bot.kickoffs {
        assert_eq!(delivered(&mails, kickoff), 1, "{kickoff}");
    }
}

#[tokio::test]
async fn a_bot_without_a_home_renames_its_seeded_title_and_signs_its_next_report() {
    let root = Scratch::new();
    let folder = |name: &str| root.0.join(name).to_string_lossy().into_owned();
    let world = |name: &str| {
        let mut world = bot_world(&folder(name));
        world["parents"] = json!({ "bot1": { "callerTabId": "main0001" } });
        world
    };
    let (control, asked) = rig_files(
        world("ada"),
        Caps::default(),
        &bot_files(&root),
        bots_main(Mails::default(), |_, _| None),
    );
    control
        .bots_command(json!({ "action": "create", "name": "Ada", "purpose": "Ask Ada." }))
        .await
        .unwrap();
    let bot = control.bot_named("Ada").unwrap();
    assert!(bot.home.is_none());
    let report = |text: &str| {
        control.run(
            "bot1",
            "ompdesk_report",
            json!({ "kind": "note", "text": text }),
            None,
        )
    };
    assert!(!report("first").await.is_error);
    control.rename_bot(&bot, "Bea").await.unwrap();
    assert_eq!(
        std::fs::read(root.0.join("bea/SOUL.md")).unwrap(),
        b"# Bea\n\nAsk Ada.\n"
    );
    crate::ports::apply_state(control.host.port(), 1, &world("bea").to_string()).unwrap();
    assert!(!report("second").await.is_error);
    let asked = asked.lock().unwrap();
    let names: Vec<_> = asked
        .iter()
        .filter(|(method, args)| method == "mail" && args["details"]["fromBot"] == bot.id)
        .map(|(_, args)| args["details"]["fromTitle"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Ada", "Bea"]);
}

#[tokio::test]
async fn retrying_the_saved_name_finishes_its_pending_soul_rename() {
    let root = Scratch::new();
    let (control, _, id) = ada(&root, Mails::default(), |_, _| None).await;
    std::fs::write(root.0.join("ada/SOUL.md"), "# Ada\n\nAda's notes").unwrap();
    let pending = control
        .change_bot(&id, |bot| {
            bot.renamed_from = Some(std::mem::replace(&mut bot.name, "Bea".into()));
        })
        .unwrap();
    control.rename_bot(&pending, "Bea").await.unwrap();
    assert_eq!(
        std::fs::read(root.0.join("bea/SOUL.md")).unwrap(),
        b"# Bea\n\nAda's notes"
    );
    assert_eq!(control.bot_named(&id).unwrap().renamed_from, None);
}

/// The owner renames a bot: its folder in the bots folder moves to the new name's slug with its files, its chats'
/// sessions and its routines (their titles too), and its home chat is notified.
#[tokio::test]
async fn a_rename_moves_the_bots_folder_its_sessions_and_routines_and_tells_its_home_chat() {
    let root = Scratch::new();
    let folder = root.0.join("ada").to_string_lossy().into_owned();
    let book = Arc::new(Mutex::new(vec![
        routine("r1", "Ada: Look around", &folder),
        scheduled(
            "u1",
            "Ada: mine",
            json!({ "kind": "interval", "minutes": 5 }),
        ),
    ]));
    let (control, asked, id) = ada(&root, Mails::default(), schedule_book(book.clone())).await;
    std::fs::write(root.0.join("ada").join("SOUL.md"), "I am Ada.").unwrap();
    control
        .bots_command(json!({ "action": "update", "id": id, "name": "Bea" }))
        .await
        .unwrap();
    let to = root.0.join("bea").to_string_lossy().into_owned();
    assert!(root.0.join("bea").join("SOUL.md").is_file());
    assert!(!root.0.join("ada").exists());
    let bot = control.bot_named(&id).unwrap();
    assert_eq!(
        (bot.name.as_str(), bot.folder.as_str()),
        ("Bea", to.as_str())
    );
    assert_eq!(
        bot.home.as_deref(),
        Some(moved_to(&to, "/s/bot.jsonl").as_str())
    );
    assert_eq!((bot.moving, bot.renamed_from), (None, None));
    let book = book.lock().unwrap();
    assert_eq!(book[0]["name"], "Bea: Look around");
    assert_eq!(book[0]["cwd"], json!(to));
    assert_eq!(book[0]["wakeSession"], json!(moved_to(&to, "/s/bot.jsonl")));
    assert_eq!(
        book[1]["name"], "Ada: mine",
        "a schedule elsewhere keeps its title"
    );
    let asked = asked.lock().unwrap();
    assert!(
        asked
            .iter()
            .any(|(method, args)| method == "bots.relocate" && args["from"] == json!(folder))
    );
    assert!(asked.iter().any(|(method, args)| {
        method == "mail"
            && args
                .to_string()
                .contains("You were renamed from Ada to Bea")
    }));
}

/// While a chat in its folder runs a turn the folder waits; the pass after the turn ends moves it.
#[tokio::test]
async fn a_renamed_bots_folder_waits_for_a_running_turn() {
    let root = Scratch::new();
    let (control, asked, id) = ada(&root, Mails::default(), |_, _| None).await;
    let folder = root.0.join("ada").to_string_lossy().into_owned();
    let mut busy = bot_world(&folder);
    busy["tabs"][1]["busy"] = json!(true);
    busy["tabs"][1]["cwd"] = json!(root.0.join("ada").join("child"));
    crate::ports::apply_state(control.host.port(), 1, &busy.to_string()).unwrap();
    control
        .bots_command(json!({ "action": "update", "id": id, "name": "Bea" }))
        .await
        .unwrap();
    let bot = control.bot_named(&id).unwrap();
    assert_eq!(bot.name, "Bea");
    assert_eq!(bot.folder, folder);
    assert_eq!(bot.renamed_from.as_deref(), Some("Ada"));
    assert!(root.0.join("ada").is_dir() && !root.0.join("bea").exists());
    assert_eq!(relocations(&asked), 0);

    crate::ports::apply_state(control.host.port(), 2, &bot_world(&folder).to_string()).unwrap();
    control.bots_tick().await;
    assert!(!root.0.join("ada").exists() && root.0.join("bea").is_dir());
    assert_eq!(control.bot_named(&id).unwrap().renamed_from, None);
    assert_eq!(relocations(&asked), 1);
}

/// A directory rename that fails (a folder held open on Windows) leaves the old folder whole and the registry on it.
#[tokio::test]
async fn a_move_that_fails_leaves_the_old_folder_whole() {
    let root = Scratch::new();
    let (control, asked, id) = ada(&root, Mails::default(), |_, _| None).await;
    std::fs::write(root.0.join("ada").join("SOUL.md"), "I am Ada.").unwrap();
    super::bot_move::FAIL_RENAME.with(|fail| fail.set(true));
    let (text, is_error) = run(
        &control,
        "ompdesk_bot",
        json!({ "action": "rename", "bot": "Ada", "name": "Bea" }),
    )
    .await;
    assert!(!is_error && text.contains("stays"), "{text}");
    assert_eq!(
        std::fs::read_to_string(root.0.join("ada").join("SOUL.md")).unwrap(),
        "I am Ada."
    );
    assert!(!root.0.join("bea").exists());
    let bot = control.bot_named(&id).unwrap();
    assert_eq!(bot.folder, root.0.join("ada").to_string_lossy());
    assert_eq!(bot.moving, None);
    assert_eq!(relocations(&asked), 0);
}

/// A crash right after the directory moved, before the registry was saved: the next start names the new folder at
/// once, its first pass finishes the move (sessions, routines), and the old folder never comes back.
#[tokio::test]
async fn a_move_cut_off_by_a_crash_finishes_on_the_next_start() {
    let root = Scratch::new();
    let from = root.0.join("ada").to_string_lossy().into_owned();
    let to = root.0.join("bea").to_string_lossy().into_owned();
    {
        let (control, _, id) =
            ada_in(&root, &kept_files(&root), Mails::default(), |_, _| None).await;
        control.bots().change(&id, |record| {
            record.name = "Bea".to_owned();
            record.sessions.push("/s/other.jsonl".to_owned());
            record.moving = Some(crate::agentctl::journal::bots::FolderMove {
                from: from.clone(),
                to: to.clone(),
            });
        });
        std::fs::rename(&from, &to).unwrap();
    }
    let book = Arc::new(Mutex::new(vec![routine("r1", "Bea: Look around", &from)]));
    let schedules = schedule_book(book.clone());
    let incomplete = std::sync::atomic::AtomicBool::new(true);
    let (control, asked) = rig_files(
        bot_world(&from),
        Caps::default(),
        &kept_files(&root),
        bots_main(Mails::default(), move |method, args| {
            if method == "bots.relocate"
                && incomplete.swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                return Some(
                    json!({"/s/bot.jsonl": moved_to(args["to"].as_str().unwrap(), "/s/bot.jsonl")}),
                );
            }
            schedules(method, args)
        }),
    );
    assert_eq!(control.bot_named("Bea").unwrap().folder, to);
    control.bots_tick().await;
    let partial = control.bot_named("Bea").unwrap();
    assert!(partial.moving.is_some());
    assert_eq!(partial.home.as_deref(), Some("/s/bot.jsonl"));
    assert!(partial.sessions.iter().any(|s| s == "/s/other.jsonl"));
    assert_eq!(book.lock().unwrap()[0]["cwd"], json!(from));
    control.bots_tick().await;
    let bot = control.bot_named("Bea").unwrap();
    assert_eq!(bot.moving, None);
    assert!(bot.sessions.contains(&moved_to(&to, "/s/other.jsonl")));
    assert_eq!(
        bot.home.as_deref(),
        Some(moved_to(&to, "/s/bot.jsonl").as_str())
    );
    let routine = book.lock().unwrap()[0].clone();
    assert_eq!(
        routine["cwd"],
        json!(to),
        "the routine wakes in the new folder"
    );
    assert_eq!(routine["wakeSession"], json!(moved_to(&to, "/s/bot.jsonl")));
    assert!(
        asked
            .lock()
            .unwrap()
            .iter()
            .any(|(method, args)| method == "bots.relocate"
                && args["sessions"] == json!(["/s/bot.jsonl", "/s/other.jsonl"])),
        "the chat open on the old folder moves along"
    );
    assert!(!root.0.join("ada").exists());
}

/// No rename record, no move: a `-2` left by a name clash and a folder the owner named stay put across starts.
#[tokio::test]
async fn a_bot_never_renamed_keeps_its_folder_across_starts() {
    let root = Scratch::new();
    for name in ["ada-2", "my-desk"] {
        std::fs::create_dir(root.0.join(name)).unwrap();
    }
    let bots = json!([
        { "id": "bot-a", "name": "Ada", "folder": root.0.join("ada-2") },
        { "id": "bot-b", "name": "Bea", "folder": root.0.join("my-desk") },
    ]);
    for _ in 0..2 {
        let (control, asked) = started_with(&root, bots.clone());
        control.bots_tick().await;
        assert_eq!(relocations(&asked), 0);
    }
    assert!(root.0.join("ada-2").is_dir() && root.0.join("my-desk").is_dir());
    assert!(!root.0.join("ada").exists() && !root.0.join("bea").exists());
}

/// A rename to the same name is how a bot renamed before rename records asks for its move: once, then nothing.
#[tokio::test]
async fn a_same_name_rename_moves_an_old_names_folder_once() {
    let root = Scratch::new();
    std::fs::create_dir(root.0.join("old-cy")).unwrap();
    let (control, asked) = started_with(
        &root,
        json!([{ "id": "bot-c", "name": "Cy", "folder": root.0.join("old-cy") }]),
    );
    for _ in 0..2 {
        control
            .bots_command(json!({ "action": "update", "id": "bot-c", "name": "Cy" }))
            .await
            .unwrap();
    }
    assert!(root.0.join("cy").is_dir() && !root.0.join("old-cy").exists());
    assert_eq!(
        control.bot_named("bot-c").unwrap().folder,
        root.0.join("cy").to_string_lossy()
    );
    assert_eq!(relocations(&asked), 1);
}

/// A folder outside the bots folder, one that is a link, and one reached through a link stay where they are, and so
/// does what is behind the link, on a rename and on the pass of a start that finds a rename record.
#[tokio::test]
async fn a_folder_outside_the_bots_folder_or_behind_a_link_never_moves() {
    let root = Scratch::new();
    let outside = Scratch::new();
    for name in ["proj", "linked", "behind/proj"] {
        std::fs::create_dir_all(outside.0.join(name)).unwrap();
    }
    link(&outside.0.join("linked"), &root.0.join("lnk"));
    link(&outside.0.join("behind"), &root.0.join("through"));
    let bots = json!([
        { "id": "bot-d", "name": "Dee", "folder": outside.0.join("proj") },
        { "id": "bot-e", "name": "Eve", "folder": root.0.join("lnk") },
        { "id": "bot-f", "name": "Fay", "folder": root.0.join("through").join("proj") },
        { "id": "bot-g", "name": "Gus", "folder": root.0.join("lnk"), "renamedFrom": "Old" },
    ]);
    let (control, asked) = started_with(&root, bots);
    control.bots_tick().await;
    for (id, name) in [("bot-d", "Dee2"), ("bot-e", "Eve2"), ("bot-f", "Fay2")] {
        control
            .bots_command(json!({ "action": "update", "id": id, "name": name }))
            .await
            .unwrap();
    }
    assert_eq!(relocations(&asked), 0);
    for name in ["proj", "linked", "behind/proj"] {
        assert!(outside.0.join(name).is_dir(), "{name}");
    }
    assert!(std::fs::symlink_metadata(root.0.join("lnk")).is_ok());
    for name in ["dee2", "eve2", "fay2", "gus"] {
        assert!(!root.0.join(name).exists(), "{name}");
        assert!(!outside.0.join(name).exists(), "{name}");
    }
    assert_eq!(control.bot_named("bot-g").unwrap().renamed_from, None);
}

/// A folder nested in the bots folder moves beside itself; one that holds, or sits in, another bot's folder stays, and
/// so does that other bot's.
#[tokio::test]
async fn a_nested_folder_moves_beside_itself_unless_another_bots_folder_overlaps_it() {
    let root = Scratch::new();
    for name in ["team/old", "crew/lead/mate"] {
        std::fs::create_dir_all(root.0.join(name)).unwrap();
    }
    let (control, asked) = started_with(
        &root,
        json!([
            { "id": "bot-h", "name": "Old", "folder": root.0.join("team").join("old") },
            { "id": "bot-i", "name": "Lead", "folder": root.0.join("crew").join("lead") },
            { "id": "bot-j", "name": "Mate", "folder": root.0.join("crew").join("lead").join("mate") },
        ]),
    );
    for (id, name) in [("bot-h", "New"), ("bot-i", "Boss"), ("bot-j", "Pal")] {
        control
            .bots_command(json!({ "action": "update", "id": id, "name": name }))
            .await
            .unwrap();
    }
    assert!(root.0.join("team").join("new").is_dir() && !root.0.join("team").join("old").exists());
    assert_eq!(
        control.bot_named("bot-h").unwrap().folder,
        root.0.join("team").join("new").to_string_lossy()
    );
    assert!(root.0.join("crew").join("lead").join("mate").is_dir());
    assert!(!root.0.join("crew").join("boss").exists());
    assert!(!root.0.join("crew").join("lead").join("pal").exists());
    assert_eq!(
        control.bot_named("bot-j").unwrap().folder,
        root.0
            .join("crew")
            .join("lead")
            .join("mate")
            .to_string_lossy()
    );
    assert_eq!(relocations(&asked), 1);
}
