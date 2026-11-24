use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio::task::LocalSet;

use super::clock::Clock;
use super::queue::{Answer, Ctx, Queue, STEP_MAX_MS, Step, StepKind};
use super::runner::{RunOutcome, Runner, SpawnSpec, Supervisor};
use super::{Backoff, CHECK_INTERVAL_MS, Main, Tools, call_tools, next_check_delay};
use crate::hub::{LocalFuture, Outcome};
use crate::server::Fault;

/// Main as a test sees it: every item, in order; `env` answers this process's environment.
#[derive(Default)]
struct Recorder {
    items: RefCell<Vec<Value>>,
}

impl Main for Recorder {
    fn push(&self, item: Value) {
        self.items.borrow_mut().push(item);
    }

    fn ask(&self, q: &str, _: Value) -> LocalFuture<Result<Value, Fault>> {
        let answer = match q {
            "env" => Ok(json!(std::env::vars().collect::<BTreeMap<_, _>>())),
            _ => Err(Fault::new("no_answer", q.to_owned())),
        };
        Box::pin(async move { answer })
    }
}

impl Recorder {
    fn of(&self, k: &str) -> Vec<Value> {
        self.items
            .borrow()
            .iter()
            .filter(|item| item["k"] == k)
            .cloned()
            .collect()
    }
}

fn spawn_local(task: LocalFuture<()>) {
    tokio::task::spawn_local(task);
}

/// Lets the spawned tasks run until `done` holds.
async fn until(done: impl Fn() -> bool) {
    for _ in 0..1_000 {
        if done() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("never came");
}

/// Whether process `pid` still runs.
fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    return crate::sys::alive(pid);
    #[cfg(windows)]
    return !matches!(crate::sys::process_started_ms(pid), Ok(None));
}

fn queue(bound_ms: u64) -> (Rc<Queue>, Rc<RefCell<Vec<String>>>) {
    let stalls = Rc::new(RefCell::new(Vec::new()));
    let heard = Rc::clone(&stalls);
    let queue = Queue::new(
        Rc::new(Clock::system()),
        bound_ms,
        move |chain, label, ms| heard.borrow_mut().push(format!("{chain}: {label} {ms}")),
    );
    tokio::task::spawn_local(Rc::clone(&queue).run());
    (queue, stalls)
}

fn step(
    label: &str,
    kind: StepKind,
    work: impl FnOnce(Ctx) -> LocalFuture<Answer> + 'static,
) -> Step {
    Step {
        label: label.to_owned(),
        kind,
        work: Box::new(work),
    }
}

/// A step that notes its start, waits `ms`, notes its end and answers its label.
fn noting(log: &Rc<RefCell<Vec<String>>>, label: &'static str, kind: StepKind, ms: u64) -> Step {
    let log = Rc::clone(log);
    step(label, kind, move |_| {
        Box::pin(async move {
            log.borrow_mut().push(format!("start {label}"));
            tokio::time::sleep(Duration::from_millis(ms)).await;
            log.borrow_mut().push(format!("end {label}"));
            Ok(json!(label))
        })
    })
}

#[tokio::test(start_paused = true)]
async fn runs_one_step_at_a_time_in_the_order_asked() {
    LocalSet::new()
        .run_until(async {
            let (queue, _) = queue(STEP_MAX_MS);
            let log = Rc::new(RefCell::new(Vec::new()));
            let a = queue
                .enqueue(noting(&log, "a", StepKind::Install, 50))
                .unwrap();
            let b = queue
                .enqueue(noting(&log, "b", StepKind::CliPass, 10))
                .unwrap();
            let c = queue
                .enqueue(noting(&log, "c", StepKind::ExtPass, 1))
                .unwrap();
            assert_eq!(
                (c.await, b.await, a.await),
                (Ok(json!("c")), Ok(json!("b")), Ok(json!("a")))
            );
            assert_eq!(
                *log.borrow(),
                ["start a", "end a", "start b", "end b", "start c", "end c"]
            );
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn a_step_past_its_bound_is_dropped_its_stops_run_and_the_next_starts() {
    LocalSet::new()
        .run_until(async {
            let (queue, stalls) = queue(STEP_MAX_MS);
            let stopped = Rc::new(RefCell::new(0));
            let after = Rc::new(RefCell::new(false));
            let hung = queue
                .enqueue(step("tool CLI update", StepKind::CliPass, {
                    let (stopped, after) = (Rc::clone(&stopped), Rc::clone(&after));
                    move |ctx| {
                        Box::pin(async move {
                            ctx.on_stop(move || {
                                *stopped.borrow_mut() += 1;
                                true
                            });
                            std::future::pending::<()>().await;
                            *after.borrow_mut() = true;
                            Ok(Value::Null)
                        })
                    }
                }))
                .unwrap();
            let next = queue.enqueue(step("next", StepKind::Install, |_| Box::pin(async { Ok(json!("ran")) }))).unwrap();
            let started = tokio::time::Instant::now();
            let fault = hung.await.unwrap_err();
            assert_eq!(started.elapsed(), Duration::from_millis(STEP_MAX_MS));
            assert_eq!(fault.code, "step_stalled");
            assert_eq!(
                fault.message,
                "tool CLI update did not finish in 30 min and was stopped so the next one can run (update scheduler)."
            );
            assert_eq!(*stalls.borrow(), ["update scheduler: tool CLI update 1800000"]);
            assert_eq!(next.await, Ok(json!("ran")));
            assert_eq!(*stopped.borrow(), 1, "the stopped step's stop ran once");
            assert!(!*after.borrow(), "nothing the dropped step would still do happens");
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn cancel_ends_what_the_step_started_and_close_drops_it_and_skips_the_queued() {
    LocalSet::new()
        .run_until(async {
            let (queue, _) = queue(STEP_MAX_MS);
            assert!(!queue.cancel(), "nothing runs: nothing to cancel");
            let live = Rc::new(RefCell::new(true));
            let ended = Rc::new(Notify::new());
            let seen = Rc::new(RefCell::new(Vec::new()));
            let running = queue
                .enqueue(step("install", StepKind::Install, {
                    let (live, ended, seen) =
                        (Rc::clone(&live), Rc::clone(&ended), Rc::clone(&seen));
                    move |ctx| {
                        Box::pin(async move {
                            ctx.on_stop({
                                let (live, ended) = (Rc::clone(&live), Rc::clone(&ended));
                                move || {
                                    let was = live.replace(false);
                                    ended.notify_one();
                                    was
                                }
                            });
                            ended.notified().await;
                            seen.borrow_mut().push(ctx.cancelled());
                            // The pipeline stops after a Cancel; this step waits for the close.
                            std::future::pending::<Answer>().await
                        })
                    }
                }))
                .unwrap();
            let queued = queue
                .enqueue(step("queued", StepKind::Install, |_| {
                    Box::pin(async { Ok(json!("ran")) })
                }))
                .unwrap();
            tokio::task::yield_now().await;
            assert!(
                queue.cancel(),
                "the person's Cancel ended the running install"
            );
            assert!(!*live.borrow());
            tokio::task::yield_now().await;
            assert_eq!(*seen.borrow(), [true], "the step sees it was cancelled");
            assert!(!queue.cancel(), "nothing left to end");
            queue.close();
            assert_eq!(running.await.unwrap_err().code, "tools_closed");
            assert_eq!(queued.await.unwrap_err().code, "tools_closed");
            assert_eq!(
                queue
                    .enqueue(step("late", StepKind::Install, |_| Box::pin(async {
                        Ok(Value::Null)
                    })))
                    .err()
                    .map(|fault| fault.code),
                Some("tools_closed".into())
            );
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn an_omp_pass_asked_while_one_runs_or_waits_joins_it() {
    LocalSet::new()
        .run_until(async {
            let (queue, _) = queue(STEP_MAX_MS);
            let log = Rc::new(RefCell::new(Vec::new()));
            let cli = queue
                .enqueue(noting(&log, "cli", StepKind::CliPass, 10))
                .unwrap();
            let first = queue
                .enqueue(noting(&log, "omp", StepKind::OmpPass, 10))
                .unwrap();
            let waiting = queue
                .enqueue(noting(&log, "omp again", StepKind::OmpPass, 10))
                .unwrap();
            assert_eq!(cli.await, Ok(json!("cli")));
            tokio::time::sleep(Duration::from_millis(1)).await;
            let running = queue
                .enqueue(noting(&log, "omp a third time", StepKind::OmpPass, 10))
                .unwrap();
            let ext = queue
                .enqueue(noting(&log, "ext", StepKind::ExtPass, 1))
                .unwrap();
            assert_eq!(
                (first.await, waiting.await, running.await),
                (Ok(json!("omp")), Ok(json!("omp")), Ok(json!("omp")))
            );
            assert_eq!(ext.await, Ok(json!("ext")));
            assert_eq!(
                *log.borrow(),
                [
                    "start cli",
                    "end cli",
                    "start omp",
                    "end omp",
                    "start ext",
                    "end ext"
                ]
            );
        })
        .await;
}

fn opts(manual: bool) -> super::Opts {
    serde_json::from_value(json!({
        "platform": "win32",
        "arch": "x64",
        "toolsDir": "C:\\tools",
        "userData": std::env::temp_dir().join("ompdesk-tools-test-none").to_string_lossy(),
        "appVersion": "0.0.0",
        "testedOmp": "18.22.2",
        "automatic": false,
        "scheduled": {"omp": true, "cli": false, "ext": false},
        "manual": manual,
        "now": 1_000,
    }))
    .unwrap()
}

fn tools(manual: bool) -> (Rc<Tools>, Rc<Recorder>) {
    let main = Rc::new(Recorder::default());
    let tools = Tools::new(
        opts(manual),
        main.clone(),
        spawn_local,
        Supervisor::this_binary(),
        STEP_MAX_MS,
    );
    (tools, main)
}

fn call(tools: &Rc<Tools>, method: &str, params: Value) -> Outcome {
    let params = serde_json::value::to_raw_value(&params).unwrap();
    call_tools(tools, method, &params)
}

fn now(outcome: Outcome) -> Result<Value, Fault> {
    match outcome {
        Outcome::Now(answer) => answer,
        Outcome::Later(_) => panic!("answered later"),
    }
}

#[tokio::test]
async fn a_manual_instance_runs_its_schedule_on_mains_timers() {
    LocalSet::new()
        .run_until(async {
            let (tools, main) = tools(true);
            assert_eq!(now(call(&tools, "start", json!({}))), Ok(json!(true)));
            assert_eq!(
                now(call(&tools, "start", json!({}))),
                Ok(json!(false)),
                "starts once"
            );
            // The launch tick's pass ran on the queue (ending at once, it armed no bound), then the 4 h timer was armed.
            let checks = || {
                main.of("timer")
                    .into_iter()
                    .filter(|timer| timer["ms"] == CHECK_INTERVAL_MS)
                    .map(|timer| timer["timer"].clone())
                    .collect::<Vec<_>>()
            };
            until(|| checks().len() == 1).await;
            let timer = checks()[0].clone();
            assert_eq!(
                main.of("timer").len(),
                1,
                "no bound for a step that ended at once"
            );
            assert_eq!(
                now(call(
                    &tools,
                    "fire",
                    json!({"timer": timer, "now": 1_000 + CHECK_INTERVAL_MS})
                )),
                Ok(json!(true))
            );
            assert_eq!(tools.clock.now_ms(), 1_000 + CHECK_INTERVAL_MS);
            // The next tick: another pass and another 4 h timer.
            until(|| checks().len() == 2).await;
            assert_eq!(
                now(call(&tools, "fire", json!({"timer": timer}))),
                Ok(json!(false)),
                "a timer fires once"
            );
            let armed = checks()[1].clone();
            assert_eq!(now(call(&tools, "close", json!({}))), Ok(Value::Null));
            until(|| {
                main.of("clearTimer")
                    .last()
                    .map(|clear| clear["timer"].clone())
                    == Some(armed.clone())
            })
            .await;
            assert_eq!(now(call(&tools, "start", json!({}))), Ok(json!(false)));
        })
        .await;
}

#[tokio::test]
async fn reads_its_state_at_once_and_checks_each_key_before_it_queues() {
    LocalSet::new()
        .run_until(async {
            let (tools, _) = tools(false);
            let state = now(call(&tools, "state", json!({}))).unwrap();
            assert_eq!(state["setup"], json!({"platform": "win32", "automatic": false, "ompReady": false, "requiredRunning": false, "items": []}));
            assert_eq!(state["omp"]["phase"], "idle");
            assert_eq!(state["omp"]["held"], Value::Null);
            assert_eq!(state["cli"], json!({"enabled": true, "scheduled": false, "tools": []}));
            assert_eq!(state["ext"], json!({"enabled": true, "scheduled": false, "rows": []}));
            let refused = |method: &str, params: Value| now(call(&tools, method, params)).unwrap_err().message;
            assert_eq!(refused("setup.retry", json!({"item": "rm -rf"})), "Unknown setup item: rm -rf");
            assert_eq!(refused("setup.installForConnection", json!({"item": "git"})), "Not an optional setup item: git");
            assert_eq!(refused("cli.now", json!({"id": "/bin/sh"})), "Unknown tool: /bin/sh");
            assert_eq!(refused("ext.now", json!({"key": "mcp:nope"})), "Unknown extension: mcp:nope");
            assert_eq!(now(call(&tools, "setup.cancel", json!({}))), Ok(json!(false)));
            for (method, params) in [("cli.now", json!({"id": "gh"})), ("ext.now", json!({})), ("omp.now", json!({})), ("setup.installForConnection", json!({"item": "gh"}))] {
                let Outcome::Later(answer) = call(&tools, method, params) else { panic!("{method} answers later") };
                let answer = answer.await.unwrap();
                if method == "omp.now" {
                    // A pass answers the omp state it ended with (no omp detected: nothing checked).
                    assert_eq!(answer["phase"], "idle");
                } else {
                    assert_eq!(answer, Value::Null, "{method}");
                }
            }
        })
        .await;
}

#[test]
fn backs_off_four_hours_doubling_to_a_day() {
    let hours = |failures| next_check_delay(failures) / 3_600_000;
    assert_eq!([0, 1, 2, 3, 9, 40].map(hours), [4, 8, 16, 24, 24, 24]);
    let mut row = Backoff::default();
    row.settle(true, 1_000);
    assert_eq!(
        row,
        Backoff {
            failures: 1,
            next_at: 1_000 + 8 * 3_600_000
        }
    );
    row.settle(false, 2_000);
    assert_eq!(row, Backoff::default());
}

// ---- Finding 4, on real processes ----------------------------------------------------------------------------------

const MODE: &str = "OMPDESK_TOOLS_TEST_INSTALLER";
const PID_FILE: &str = "OMPDESK_TOOLS_TEST_PID";

/// This test binary as the supervisor (`ompdesk-core --supervise`).
#[test]
#[ignore = "a stand-in the tests start"]
fn supervisor_stand_in() {
    std::process::exit(crate::supervise::run());
}

/// This test binary as an installer: `hold` writes its pid and runs until killed, `quick` succeeds at once.
#[test]
#[ignore = "a stand-in the tests start"]
fn installer_stand_in() {
    if std::env::var(MODE).as_deref() == Ok("hold") {
        std::fs::write(
            std::env::var(PID_FILE).unwrap(),
            std::process::id().to_string(),
        )
        .unwrap();
        println!("holding");
        std::thread::sleep(Duration::from_secs(600));
    }
    println!("installed");
}

fn stand_in(name: &str) -> Vec<String> {
    [
        &format!("tools::tests::{name}"),
        "--exact",
        "--ignored",
        "--nocapture",
        "--test-threads=1",
    ]
    .map(str::to_owned)
    .to_vec()
}

#[tokio::test]
async fn a_stopped_step_cancels_its_installer_and_the_next_install_starts() {
    LocalSet::new()
        .run_until(async {
            let exe = std::env::current_exe().unwrap();
            let runner = Rc::new(Runner::new(Supervisor {
                file: exe.clone(),
                args: stand_in("supervisor_stand_in"),
            }));
            let dir = tempfile::tempdir().unwrap();
            let pid_file = dir.path().join("pid");
            let installer = SpawnSpec {
                file: exe.to_string_lossy().into_owned(),
                args: stand_in("installer_stand_in"),
                ..SpawnSpec::default()
            };
            let env = |mode: &str| {
                let mut env: BTreeMap<String, String> = std::env::vars().collect();
                env.insert(MODE.into(), mode.into());
                env.insert(PID_FILE.into(), pid_file.to_string_lossy().into_owned());
                env
            };
            // A real bound, short: the step that runs the held installer is stopped by it, as the 30 min one stops a pass.
            let (queue, stalls) = queue(5_000);
            let work = |mode: &'static str| {
                let (runner, spec, env) = (Rc::clone(&runner), installer.clone(), env(mode));
                move |ctx: Ctx| -> LocalFuture<Answer> {
                    Box::pin(async move {
                        let ran = runner.run(&ctx, &spec, &env, None, &mut |_| {}).await;
                        Ok(json!({"outcome": ran.outcome, "output": ran.output}))
                    })
                }
            };
            let held = queue
                .enqueue(step("tool CLI update", StepKind::CliPass, work("hold")))
                .unwrap();
            let next = queue
                .enqueue(step("install gh", StepKind::Install, work("quick")))
                .unwrap();
            assert_eq!(held.await.unwrap_err().code, "step_stalled");
            assert_eq!(*stalls.borrow(), ["update scheduler: tool CLI update 5000"]);
            let next = next.await.unwrap();
            assert_eq!(
                serde_json::to_value(RunOutcome::Succeeded).unwrap(),
                next["outcome"],
                "{next}"
            );
            assert!(
                next["output"].as_str().unwrap().contains("installed"),
                "{next}"
            );
            let pid: u32 = std::fs::read_to_string(&pid_file).unwrap().parse().unwrap();
            assert!(
                !alive(pid),
                "the stopped step's installer is gone before the next install started"
            );
        })
        .await;
}
