//! What an agent asks about checks instead of reading logs or polling (`docs/design/check-control.md` §6, the half
//! that needs no hub): `ompdesk checks wait [ID]` blocks until a run ends and answers with the judgment, and `ompdesk
//! checks status` lists this computer's heavy pool and its check runs with who started each. Both print JSON and read
//! only the journals and the pool: no GitHub, no running OMPdesk.

use std::fs;
use std::io;

use serde::{Deserialize, Serialize};

use crate::check::{attach_to, failing, find_run, open_store, session_tag};
use crate::flaky::{Book, CLEAR_AFTER};
use crate::heavy::{Disk, Pool, now_ms};
use crate::store::{Run, State, Store, Timing};

/// `checks wait` exits by outcome: 0 green, 1 red, and this when there is no judgment (still running, cancelled,
/// killed, stopped, or a pass whose inputs changed under it).
pub const EXIT_UNKNOWN: i32 = 4;
/// Reruns of one input set `next` proposes for failures that are all known flaky, before it says `fix`.
const RERUN_CAP: usize = 2;
/// Failed tests an answer lists; `counts.failed` is the whole number.
const LISTED: usize = 30;
/// Finished runs `status` lists; a run not finished is always listed.
const RECENT: usize = 20;

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Green,
    Red,
    /// Never green from results that do not hold.
    Unknown,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Next {
    Fix,
    RerunFailed,
    Wait,
    Land,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Failed {
    pub test: String,
    pub first_error: String,
    pub known_flaky: bool,
    pub history: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Counts {
    pub passed: usize,
    pub failed: usize,
    pub skipped: usize,
    pub unrun: usize,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReusedFrom {
    pub from: String,
    pub saved_min: u64,
}

/// What `checks wait` prints: the judgment, so its reader never opens the log.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub run: String,
    /// No exit was observed for a cache hit or a command that never ran.
    pub command_exit_code: Option<i32>,
    pub inputs_stable: Option<bool>,
    pub verdict: Verdict,
    pub as_of: u64,
    pub state: State,
    pub timing: Timing,
    pub session: Option<String>,
    pub last_progress: Progress,
    pub counts: Counts,
    pub failed: Vec<Failed>,
    /// A `--release` check that is not green.
    pub blocks_release: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reused: Option<ReusedFrom>,
    pub next: Next,
    pub notes: Vec<String>,
}

fn yes() -> bool {
    true
}

/// One line of `verdict.json` (`check::finish`).
#[derive(Deserialize)]
struct Row {
    key: String,
    name: String,
    status: String,
    #[serde(default)]
    quarantined: bool,
    #[serde(default = "yes")]
    counted: bool,
    #[serde(default)]
    error: String,
}

fn history(book: &Book, key: &str) -> String {
    match book.tests.get(key) {
        Some(t) if t.quarantined => format!(
            "{} passed, {} failed in all; quarantined as flaky since run {}; {} of {CLEAR_AFTER} clean passes to leave",
            t.passed,
            t.failed,
            t.since.as_deref().unwrap_or("?"),
            t.streak
        ),
        Some(t) => format!("{} passed, {} failed in all", t.passed, t.failed),
        None => String::new(),
    }
}

/// The judgment of `run` as its journal stands.
pub(crate) fn answer(store: &Store, run: &Run) -> Answer {
    let rows: Vec<Row> = fs::read_to_string(store.file(&run.id, "verdict.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let book = Book::load(&store.dir, &run.key);
    let counted: Vec<&Row> = rows.iter().filter(|r| r.counted).collect();
    let failures: Vec<&&Row> = counted.iter().filter(|r| failing(&r.status)).collect();
    let log = store.file(&run.id, "log").display().to_string();
    let mut notes = Vec::new();

    let verdict = match run.state {
        State::Passed if run.changed_during.is_empty() => Verdict::Green,
        State::Passed => {
            notes.push(format!(
                "the check passed, but its input evidence did not hold ({}); do not reuse it or pass a gate",
                run.changed_during.join(", ")
            ));
            Verdict::Unknown
        }
        State::Failed => Verdict::Red,
        State::Starting | State::Waiting | State::Running => {
            notes.push("it has not finished".into());
            Verdict::Unknown
        }
        State::Cancelled => {
            notes.push("it was cancelled before it finished".into());
            Verdict::Unknown
        }
        State::Killed => {
            notes.push(
                "its runner stopped before it finished; what passed stays reusable, so running the check again runs only the rest"
                    .into(),
            );
            Verdict::Unknown
        }
        State::Error => {
            notes.push(format!(
                "the check could not run or was stopped (the end of {log} says why)"
            ));
            Verdict::Unknown
        }
    };

    let all_flaky = !failures.is_empty() && failures.iter().all(|r| r.quarantined);
    let next = match verdict {
        Verdict::Green => Next::Land,
        Verdict::Unknown if !run.state.finished() => Next::Wait,
        Verdict::Unknown => Next::RerunFailed,
        Verdict::Red if all_flaky => {
            // This run included: how often this check ran on these very inputs.
            let runs = store
                .of_key(&run.key)
                .iter()
                .filter(|r| r.inputs.is_some() && r.inputs == run.inputs)
                .count();
            if runs <= RERUN_CAP {
                notes.push(format!(
                    "every failure is a known flaky test: rerun {runs} of {RERUN_CAP} on these inputs"
                ));
                Next::RerunFailed
            } else {
                notes.push(format!(
                    "every failure is a known flaky test, and {RERUN_CAP} reruns on these inputs did not pass: fix the tests"
                ));
                Next::Fix
            }
        }
        Verdict::Red => Next::Fix,
    };
    if verdict == Verdict::Red && failures.iter().all(|r| r.error.is_empty()) {
        notes.push(format!(
            "no first error was recorded (exit code {}): the end of {log} says what failed",
            run.exit_code.map_or("unknown".into(), |c| c.to_string())
        ));
    }
    if verdict == Verdict::Green && !failures.is_empty() {
        notes.push(format!(
            "{} failure(s) of quarantined flaky tests do not fail this verdict; a --release check fails on them",
            failures.len()
        ));
    }
    if failures.len() > LISTED {
        notes.push(format!(
            "{LISTED} of {} failures listed; all are in {}",
            failures.len(),
            store.file(&run.id, "verdict.txt").display()
        ));
    }

    let as_of = run.ended.unwrap_or_else(now_ms);
    Answer {
        run: run.id.clone(),
        command_exit_code: run
            .exit_code
            .filter(|_| run.milestones.is_some_and(|m| m.command_ended_at.is_some())),
        inputs_stable: matches!(run.state, State::Passed | State::Failed)
            .then_some(run.changed_during.is_empty()),
        verdict,
        as_of,
        state: run.state,
        timing: run.timing(as_of),
        session: run.session.clone(),
        last_progress: last_progress(store, run),
        counts: Counts {
            passed: counted
                .iter()
                .filter(|r| matches!(r.status.as_str(), "passed" | "flaky"))
                .count(),
            failed: failures.len(),
            skipped: counted.iter().filter(|r| r.status == "skipped").count(),
            unrun: counted.iter().filter(|r| r.status == "unrun").count(),
        },
        failed: failures
            .iter()
            .take(LISTED)
            .map(|r| Failed {
                test: r.name.clone(),
                first_error: r.error.clone(),
                known_flaky: r.quarantined,
                history: history(&book, &r.key),
            })
            .collect(),
        blocks_release: run.release && verdict != Verdict::Green,
        reused: run
            .plan
            .from
            .clone()
            .filter(|_| run.reused > 0)
            .map(|from| ReusedFrom {
                from,
                saved_min: run.saved_ms / 60_000,
            }),
        next,
        notes,
    }
}

fn print(value: &impl Serialize) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_default()
    );
}

/// `ompdesk checks wait [ID]`: blocks until the run ends (this folder's running or newest one without an id), prints
/// its `Answer` and exits by the verdict.
pub fn wait(id: Option<&str>) -> i32 {
    let Ok(store) = open_store() else {
        return EXIT_UNKNOWN;
    };
    let Some(run) = find_run(&store, id) else {
        eprintln!("ompdesk checks: no such run (ompdesk checks status lists them)");
        return EXIT_UNKNOWN;
    };
    attach_to(&store, &run.id, &mut io::sink());
    let Some(run) = store.read(&run.id) else {
        return EXIT_UNKNOWN;
    };
    let answer = answer(&store, &run);
    print(&answer);
    match answer.verdict {
        Verdict::Green => 0,
        Verdict::Red => 1,
        Verdict::Unknown => EXIT_UNKNOWN,
    }
}

/// Last observable activity, never the command's output or a guess about its health.
#[derive(Serialize, Clone, Copy, Debug)]
pub struct Progress {
    pub at: u64,
    pub kind: &'static str,
}

fn last_progress(store: &Store, run: &Run) -> Progress {
    if let Some(at) = run.ended {
        return Progress {
            at,
            kind: "finished",
        };
    }
    let m = run.milestones.unwrap_or_default();
    let mut last = Progress {
        at: run.started,
        kind: "registered",
    };
    for (kind, at) in [
        ("queued", m.queued_at),
        ("admitted", m.acquired_at),
        ("command-started", m.command_started_at),
        ("command-ended", m.command_ended_at),
    ] {
        if let Some(at) = at
            && at >= last.at
        {
            last = Progress { kind, at };
        }
    }
    for (kind, file) in [("log-write", "log"), ("result-write", "results.jsonl")] {
        let at = fs::metadata(store.file(&run.id, file))
            .ok()
            .filter(|meta| meta.len() != 0)
            .and_then(|meta| meta.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
        if let Some(at) = at.map(|d| d.as_millis() as u64)
            && at >= last.at
        {
            last = Progress { kind, at };
        }
    }
    last
}

fn check_cancel_guidance(session: Option<&str>, me: Option<&str>) -> &'static str {
    if session.is_some() && session == me {
        "If this check is no longer needed, confirm its run ID and use ompdesk check cancel <run-id>."
    } else if session.is_some() {
        "Ask the owning session whether this check is still needed. Only the owner should use ompdesk check cancel <run-id>."
    } else {
        "Ask the person who started this check before using ompdesk check cancel <run-id> in their terminal."
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Holder {
    pub slot: usize,
    pub pid: Option<u32>,
    pub run_id: Option<String>,
    pub session: Option<String>,
    pub acquired_at: Option<u64>,
    pub held_ms: Option<u64>,
    pub last_progress: Option<Progress>,
    pub cancel_guidance: &'static str,
}

/// This computer's heavy slots as one pool.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PoolRow {
    pub id: &'static str,
    pub os: &'static str,
    pub admission_limited: bool,
    pub limit: Option<usize>,
    pub running: usize,
    pub queued: usize,
    pub oldest_wait_ms: u64,
    pub holders: Vec<Holder>,
    /// Volumes below the free-space threshold used when admission is limited.
    pub low_disk: Vec<Disk>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    pub state: State,
    /// `release` for a `--release` check, else `local`.
    pub lane: &'static str,
    pub command: String,
    pub folder: String,
    /// The OMPdesk session that started it; none from a plain terminal.
    pub session: Option<String>,
    /// Started by the caller's own session.
    pub mine: bool,
    pub started: u64,
    pub ended: Option<u64>,
    pub runner_pid: Option<u32>,
    pub timing: Timing,
    pub last_progress: Progress,
    pub cancel_guidance: Option<&'static str>,
    pub summary: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub as_of: u64,
    pub pools: Vec<PoolRow>,
    pub runs: Vec<RunRow>,
}

/// The pool and every run not finished, then the newest finished ones; `me` is the caller's session.
pub(crate) fn board(store: &Store, pool: &Pool, me: Option<&str>) -> Board {
    let status = pool.status();
    let as_of = now_ms();
    let runs: Vec<_> = store
        .all()
        .into_iter()
        .enumerate()
        .filter(|(at, run)| !run.state.finished() || *at < RECENT)
        .map(|(_, run)| RunRow {
            timing: run.timing(as_of),
            last_progress: last_progress(store, &run),
            cancel_guidance: (!run.state.finished())
                .then(|| check_cancel_guidance(run.session.as_deref(), me)),
            runner_pid: (run.pid != 0).then_some(run.pid),
            lane: if run.release { "release" } else { "local" },
            command: run.argv.join(" "),
            folder: run.cwd,
            mine: me.is_some() && run.session.as_deref() == me,
            session: run.session,
            id: run.id,
            state: run.state,
            started: run.started,
            ended: run.ended,
            summary: run.summary,
        })
        .collect();
    let holders: Vec<_> = status.slots.into_iter().filter(|s| s.held).map(|s| {
        let owner = s.owner.as_ref();
        let pid = owner.map(|o| o.pid);
        let acquired_at = owner.map(|o| o.since);
        let run = owner.and_then(|o| o.run_id.as_ref()).and_then(|id| {
            runs.iter().find(|r| r.id == *id && r.runner_pid == pid && !r.state.finished())
        });
        let last_progress = acquired_at.map(|at| Progress { at, kind: "slot-acquired" }).into_iter()
            .chain(run.map(|r| r.last_progress))
            .max_by_key(|p| p.at);
        let cancel_guidance = match (owner, run.and_then(|r| r.cancel_guidance)) {
            (_, Some(guidance)) => guidance,
            (Some(o), None) if o.run_id.is_none() =>
                "No check run ID. Ask the owning terminal or session to stop its heavy command if no longer needed.",
            _ => "The check owner could not be verified. Do not cancel a run or signal a PID based on this slot.",
        };
        let (run_id, session) = s.owner.map(|o| (o.run_id, o.session)).unwrap_or_default();
        Holder {
            slot: s.slot, pid, run_id, session, acquired_at, last_progress, cancel_guidance,
            held_ms: acquired_at.and_then(|at| as_of.checked_sub(at)),
        }
    }).collect();
    Board {
        as_of,
        pools: vec![PoolRow {
            id: "local",
            os: std::env::consts::OS,
            admission_limited: status.admission_limited,
            limit: status.admission_limited.then_some(status.size),
            running: holders.len(),
            holders,
            queued: status.queue.len(),
            oldest_wait_ms: pool.oldest_wait_ms(),
            low_disk: status.disk.into_iter().filter(Disk::low).collect(),
        }],
        runs,
    }
}

/// `ompdesk checks status`.
pub fn status(pool: &Pool) -> i32 {
    let Ok(store) = open_store() else {
        return 1;
    };
    print(&board(&store, pool, session_tag().as_deref()));
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::heavy::Owner;
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ompdesk-board-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn run(store: &Store, id: &str, state: &str, more: serde_json::Value) -> Run {
        let mut json = serde_json::json!({
            "id": id, "key": "k", "root": "/r", "cwd": "/r", "argv": ["vitest", "run"], "runner": "vitest",
            "state": state, "pid": 0, "started": 1, "ended": 2, "exit_code": 0, "head": null, "dirty": false,
            "inputs": "digest", "changed_during": [], "plan": {"mode": "full", "reason": "", "from": null, "evidence": []},
            "reused": 0, "ran": 2, "failed": 0, "saved_ms": 0, "light": false, "summary": null
        });
        for (k, v) in more.as_object().unwrap() {
            json[k] = v.clone();
        }
        let run: Run = serde_json::from_value(json).unwrap();
        store.create(&run).unwrap();
        run
    }

    fn verdict(store: &Store, id: &str, rows: serde_json::Value) {
        fs::write(store.file(id, "verdict.json"), rows.to_string()).unwrap();
    }

    fn row(name: &str, status: &str, quarantined: bool, error: &str) -> serde_json::Value {
        serde_json::json!({
            "key": name, "name": name, "status": status, "ms": 5, "quarantined": quarantined, "counted": true,
            "error": error, "origin": null
        })
    }

    #[test]
    fn a_failed_run_names_each_failing_test_with_its_first_error_and_says_fix() {
        let dir = temp("red");
        let store = Store::open(dir.clone()).unwrap();
        let r = run(
            &store,
            "0001",
            "failed",
            serde_json::json!({"exit_code": 1, "release": true}),
        );
        verdict(
            &store,
            "0001",
            serde_json::json!([
                row("a passes", "passed", false, ""),
                row("b fails", "failed", false, "AssertionError: expected 1 to be 2"),
                row("c is skipped", "skipped", false, ""),
                row("d did not run", "unrun", false, ""),
                // A file's own record beside its tests is not a result people count.
                {"key": "file", "name": "a.test.ts", "status": "failed", "counted": false},
            ]),
        );
        let a = answer(&store, &r);
        assert_eq!(a.verdict, Verdict::Red);
        assert_eq!(
            a.counts,
            Counts {
                passed: 1,
                failed: 1,
                skipped: 1,
                unrun: 1,
            }
        );
        assert_eq!(
            a.failed,
            vec![Failed {
                test: "b fails".into(),
                first_error: "AssertionError: expected 1 to be 2".into(),
                known_flaky: false,
                history: String::new(),
            }]
        );
        assert_eq!(a.next, Next::Fix);
        assert!(a.blocks_release);
        let json = serde_json::to_value(&a).unwrap();
        assert_eq!(
            json["failed"][0]["firstError"],
            "AssertionError: expected 1 to be 2"
        );
        assert_eq!(json["verdict"], "red");
        assert_eq!(json["next"], "fix");

        // A plain command has no test results: red still says where to look.
        let plain = run(
            &store,
            "0002",
            "failed",
            serde_json::json!({"exit_code": 3}),
        );
        let a = answer(&store, &plain);
        assert_eq!(
            (a.verdict, a.next, a.failed.len()),
            (Verdict::Red, Next::Fix, 0)
        );
        assert!(
            a.notes.iter().any(|n| n.contains("exit code 3")),
            "{:?}",
            a.notes
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_pass_is_green_only_while_its_results_hold() {
        let dir = temp("green");
        let store = Store::open(dir.clone()).unwrap();
        let passed = run(
            &store,
            "0001",
            "passed",
            serde_json::json!({
                "reused": 3, "saved_ms": 180_000,
                "plan": {"mode": "narrowed", "reason": "", "from": "0000", "evidence": []}
            }),
        );
        verdict(
            &store,
            "0001",
            serde_json::json!([row("a", "passed", false, "")]),
        );
        let a = answer(&store, &passed);
        assert_eq!((a.verdict, a.next), (Verdict::Green, Next::Land));
        assert!(!a.blocks_release);
        assert_eq!(
            a.reused,
            Some(ReusedFrom {
                from: "0000".into(),
                saved_min: 3
            })
        );

        let moved = run(
            &store,
            "0002",
            "passed",
            serde_json::json!({
                "release": true, "changed_during": ["src/a.ts"],
                "milestones": {"command_started_at": 1, "command_ended_at": 2}
            }),
        );
        let a = answer(&store, &moved);
        assert_eq!((a.verdict, a.next), (Verdict::Unknown, Next::RerunFailed));
        assert_eq!(
            (a.command_exit_code, a.inputs_stable),
            (Some(0), Some(false))
        );
        assert!(a.blocks_release);
        assert!(
            a.notes.iter().any(|n| n.contains("src/a.ts")),
            "{:?}",
            a.notes
        );

        for (id, state, next) in [
            ("0003", "running", Next::Wait),
            ("0004", "cancelled", Next::RerunFailed),
            ("0005", "error", Next::RerunFailed),
        ] {
            let mut r = run(&store, id, "passed", serde_json::json!({}));
            r.state = serde_json::from_value(serde_json::json!(state)).unwrap();
            let a = answer(&store, &r);
            assert_eq!((a.verdict, a.next), (Verdict::Unknown, next), "{state}");
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_release_check_red_only_on_known_flaky_tests_is_rerun_up_to_the_cap() {
        let dir = temp("flaky");
        let store = Store::open(dir.clone()).unwrap();
        let mut book = Book::default();
        for status in ["passed", "failed"] {
            book.record("flaky one", "flaky one", status, "digest", "0000");
        }
        book.save(&store.dir, "k").unwrap();
        let rows = serde_json::json!([row("flaky one", "failed", true, "Timeout 5000ms")]);
        let more = serde_json::json!({"exit_code": 1, "release": true});

        let first = run(&store, "0001", "failed", more.clone());
        verdict(&store, "0001", rows.clone());
        let a = answer(&store, &first);
        assert_eq!((a.verdict, a.next), (Verdict::Red, Next::RerunFailed));
        assert!(a.failed[0].known_flaky);
        assert!(
            a.failed[0]
                .history
                .contains("quarantined as flaky since run 0000"),
            "{}",
            a.failed[0].history
        );

        run(&store, "0002", "failed", more.clone());
        let third = run(&store, "0003", "failed", more);
        verdict(&store, "0003", rows);
        let a = answer(&store, &third);
        assert_eq!(a.next, Next::Fix, "{:?}", a.notes);

        // Not under --release: the quarantined failure does not fail the verdict, and the answer still lists it.
        let green = run(&store, "0004", "passed", serde_json::json!({}));
        verdict(
            &store,
            "0004",
            serde_json::json!([row("flaky one", "failed", true, "Timeout 5000ms")]),
        );
        let a = answer(&store, &green);
        assert_eq!((a.verdict, a.failed.len()), (Verdict::Green, 1));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn wait_separates_admission_child_runtime_and_total_even_when_nothing_ran() {
        let dir = temp("timing");
        let store = Store::open(dir.clone()).unwrap();
        let observed = |id, state, metadata| {
            let r = run(&store, id, state, metadata);
            serde_json::to_value(answer(&store, &r)).unwrap()
        };
        let complete = observed(
            "complete",
            "passed",
            serde_json::json!({
                "started": 100, "ended": 300, "milestones": {
                    "queued_at": 110, "acquired_at": 240, "command_started_at": 250, "command_ended_at": 280
                }
            }),
        );
        assert_eq!(
            complete["timing"],
            serde_json::json!({
                "registeredAt": 100, "queuedAt": 110, "acquiredAt": 240, "commandStartedAt": 250,
                "commandEndedAt": 280, "finishedAt": 300, "waitMs": 130, "runMs": 30, "totalMs": 200
            })
        );
        let queued = observed(
            "queued",
            "waiting",
            serde_json::json!({
                "ended": null, "milestones": {"queued_at": 10}
            }),
        );
        assert_eq!(
            queued["timing"]["waitMs"],
            queued["asOf"].as_u64().unwrap() - 10
        );
        assert!(queued["timing"]["acquiredAt"].is_null());
        assert_eq!(queued["timing"]["runMs"], 0);
        let running = observed(
            "running",
            "running",
            serde_json::json!({
                "ended": null, "milestones": {"queued_at": 10, "acquired_at": 40, "command_started_at": 45}
            }),
        );
        assert_eq!(running["timing"]["waitMs"], 30);
        assert_eq!(
            running["timing"]["runMs"],
            running["asOf"].as_u64().unwrap() - 45
        );
        let cancelled = observed(
            "cancelled",
            "cancelled",
            serde_json::json!({
                "ended": 90, "milestones": {"queued_at": 10}
            }),
        );
        assert_eq!(cancelled["timing"]["waitMs"], 80);
        assert_eq!(cancelled["timing"]["runMs"], 0);
        assert!(cancelled["timing"]["acquiredAt"].is_null());
        let reused = observed(
            "reused",
            "passed",
            serde_json::json!({
                "milestones": {}, "plan": {"mode": "reused", "reason": "", "from": "complete", "evidence": []}
            }),
        );
        assert_eq!(reused["timing"]["waitMs"], 0);
        assert_eq!(reused["timing"]["runMs"], 0);
        assert!(reused["timing"]["commandStartedAt"].is_null());
        let dead = observed(
            "dead",
            "killed",
            serde_json::json!({
                "ended": null, "milestones": {"command_started_at": 20}
            }),
        );
        assert!(dead["timing"]["runMs"].is_null());
        assert!(dead["timing"]["totalMs"].is_null());
        let old = observed("old", "passed", serde_json::json!({}));
        assert!(old["timing"]["waitMs"].is_null());
        assert!(old["timing"]["runMs"].is_null());
        assert_eq!(old["timing"]["totalMs"], 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn status_lists_the_pool_and_who_started_each_run() {
        let dir = temp("status");
        let store = Store::open(dir.join("store")).unwrap();
        let mut pool = Pool::new(dir.join("heavy"), 2).unwrap();
        // A fixed disk with room: the slot is taken at once whatever this computer's disk holds.
        pool.volumes = pool
            .volumes
            .clone()
            .with_probe(std::sync::Arc::new(|_| Some((Some(1), 1 << 40, 1 << 41))));
        let lease = pool
            .acquire(
                1,
                Owner {
                    pid: std::process::id(),
                    command: "vitest".into(),
                    cwd: "/r".into(),
                    since: 0,
                    weight: 1,
                    run_id: None,
                    session: Some("raw-owner".into()),
                },
                |_| {},
            )
            .unwrap();
        run(
            &store,
            "0001",
            "passed",
            serde_json::json!({"session": "tab-a", "release": true}),
        );
        run(&store, "0002", "failed", serde_json::json!({"started": 5}));

        let b = board(&store, &pool, Some("tab-a"));
        let p = &b.pools[0];
        assert_eq!(
            (p.limit, p.running, p.queued, p.oldest_wait_ms),
            (Some(2), 1, 0, 0)
        );
        let holder = &p.holders[0];
        assert_eq!(holder.pid, Some(std::process::id()));
        assert_eq!(holder.session.as_deref(), Some("raw-owner"));
        assert!(holder.run_id.is_none());
        assert_eq!(holder.acquired_at, Some(lease.acquired_at));
        assert_eq!(holder.held_ms, b.as_of.checked_sub(lease.acquired_at));
        assert_eq!(holder.last_progress.unwrap().kind, "slot-acquired");
        assert!(!holder.cancel_guidance.contains("check cancel"));
        let rows: Vec<(&str, &str, bool, Option<&str>)> = b
            .runs
            .iter()
            .map(|r| (r.id.as_str(), r.lane, r.mine, r.session.as_deref()))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("0002", "local", false, None),
                ("0001", "release", true, Some("tab-a"))
            ]
        );
        assert_eq!(
            serde_json::to_value(&b).unwrap()["pools"][0]["oldestWaitMs"],
            0
        );
        drop(lease);
        assert_eq!(board(&store, &pool, None).pools[0].running, 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_old_check_holder_shows_result_activity_without_its_contents_or_cancelling_it() {
        let dir = temp("long-holder");
        let store = Store::open(dir.join("store")).unwrap();
        let mut pool = Pool::new(dir.join("pool"), 1).unwrap();
        pool.volumes = pool
            .volumes
            .clone()
            .with_probe(std::sync::Arc::new(|_| Some((Some(1), 1 << 40, 1 << 41))));
        let pid = std::process::id();
        let r = run(
            &store,
            "long",
            "running",
            serde_json::json!({
                "ended": null, "pid": pid, "session": "owner", "milestones": {
                    "queued_at": 10, "acquired_at": 42, "command_started_at": 49
                }
            }),
        );
        let alive = fs::File::create(store.file(&r.id, "alive")).unwrap();
        alive.lock().unwrap();
        let slot = fs::File::create(pool.dir.join("slot.0")).unwrap();
        slot.lock().unwrap();
        let owner = Owner {
            pid,
            command: "synthetic private args".into(),
            cwd: "/r".into(),
            since: 42,
            weight: 1,
            run_id: Some(r.id.clone()),
            session: r.session.clone(),
        };
        fs::write(
            pool.dir.join("slot.0.owner"),
            serde_json::to_vec(&owner).unwrap(),
        )
        .unwrap();
        fs::write(
            store.file(&r.id, "results.jsonl"),
            "synthetic private result",
        )
        .unwrap();

        let b = board(&store, &pool, Some("other"));
        let holder = &b.pools[0].holders[0];
        assert_eq!(holder.run_id.as_deref(), Some("long"));
        assert_eq!(holder.session.as_deref(), Some("owner"));
        assert_eq!(holder.held_ms, Some(b.as_of - 42));
        assert_eq!(holder.last_progress.unwrap().kind, "result-write");
        assert!(holder.cancel_guidance.contains("Ask the owning session"));
        assert_eq!(b.runs[0].timing.wait_ms, Some(32));
        assert_eq!(b.runs[0].timing.run_ms, Some(b.as_of - 49));
        assert!(
            !serde_json::to_string(&b)
                .unwrap()
                .contains("synthetic private")
        );
        let owned = board(&store, &pool, Some("owner"));
        assert!(owned.runs[0].mine);
        assert!(
            owned.pools[0].holders[0]
                .cancel_guidance
                .contains("confirm its run ID")
        );
        assert!(!store.file(&r.id, "cancel").exists());
        drop((alive, slot));
        let _ = fs::remove_dir_all(dir);
    }
}
