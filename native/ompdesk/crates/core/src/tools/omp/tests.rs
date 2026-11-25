//! The omp part against fakes of setup, the network and main (was `omp-updater.test.ts`, `omp-auto-takeover.test.ts`,
//! `omp-compat-source.test.ts`, `omp-hold-notice.test.ts`; `src/shared/omp-compat.test.ts`'s rules through the shared
//! vectors). Each case names the TypeScript case it ports. Main's timers are this test's (a `manual` instance): time
//! moves only through [`H::advance`].

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;

use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio::task::LocalSet;

use super::super::queue::{Ctx, STEP_MAX_MS};
use super::super::runner::Supervisor;
use super::super::setup::{BeforeInstall, OmpRun, OmpUpdateOutcome};
use super::super::{CHECK_INTERVAL_MS, MAX_CHECK_INTERVAL_MS, Main, Tools, call_tools};
use super::Deps;
use super::compat::{self, Fetched};
use super::hold::{self, Hold, RETELL_MS, Told, VERIFYING_TELL_AFTER_MS};
use super::takeover::{self, Record, Step};
use crate::hub::{LocalFuture, Outcome};
use crate::server::Fault;

const HOUR: u64 = 60 * 60 * 1000;
const TESTED: &str = "18.22.2";
const APP: &str = "0.135.0";
/// 2026-11-20T00:00:00.000Z, when every world starts.
const T0: u64 = 1_795_132_800_000;
const SINCE: &str = "2026-11-19T00:18:00.000Z";

/// What the fakes answer, as the TypeScript harness's `set`.
struct Set {
    latest: String,
    /// The verified list of this release; none verifies whatever the registry calls newest.
    verified: Option<Vec<String>>,
    within: Option<String>,
    holding: Option<(String, String)>,
    installed: Option<String>,
    outcome: OmpUpdateOutcome,
    /// What the next lookups fail with, one each.
    fetch_errors: VecDeque<String>,
    /// Every lookup fails with this while set.
    fetch_error: Option<String>,
    within_errors: VecDeque<String>,
}

/// Stock's settings for the takeover: `value` none stands for no config file (stock's default, off).
#[derive(Default)]
struct Stock {
    value: Option<bool>,
    writes: Vec<bool>,
    reads: u32,
    refuse: Option<String>,
}

/// Main, setup and the network as a test sees them.
struct World {
    set: RefCell<Set>,
    calls: RefCell<Vec<String>>,
    items: RefCell<Vec<Value>>,
    stock: Rc<RefCell<Stock>>,
    /// One-shot gates: a fake waits for its gate once, when one is set.
    fetch_gate: RefCell<Option<oneshot::Receiver<()>>>,
    compat_gate: RefCell<Option<oneshot::Receiver<()>>>,
    within_gate: RefCell<Option<oneshot::Receiver<()>>>,
    update_gate: RefCell<Option<oneshot::Receiver<()>>>,
    /// Replies of the list's address, in order; the last one repeats. None: the list built from `set`.
    compat_replies: RefCell<Option<VecDeque<Fetched>>>,
    compat_reads: Cell<u32>,
    /// Main's timers: id → when due.
    armed: RefCell<BTreeMap<u64, u64>>,
    scanned: Cell<usize>,
    now: Cell<u64>,
}

impl Main for World {
    fn push(&self, item: Value) {
        if item["k"] == "ompUpdated" {
            self.calls
                .borrow_mut()
                .push(format!("toast {}", item["version"].as_str().unwrap()));
        }
        self.items.borrow_mut().push(item);
    }

    fn ask(&self, q: &str, payload: Value) -> LocalFuture<Result<Value, Fault>> {
        match q {
            "releaseHelpers" => self.calls.borrow_mut().push("release".into()),
            "resume" => self
                .calls
                .borrow_mut()
                .push(format!("resume {}", payload["updated"])),
            _ => {}
        }
        self.items
            .borrow_mut()
            .push(json!({"k": "ask", "q": q, "payload": payload}));
        Box::pin(async { Ok(Value::Null) })
    }
}

async fn gate(gate: &RefCell<Option<oneshot::Receiver<()>>>) {
    let gate = gate.borrow_mut().take();
    if let Some(gate) = gate {
        let _ = gate.await;
    }
}

struct Fake(Rc<World>);

impl Deps for Fake {
    fn latest(&self, _: &Rc<Tools>) -> LocalFuture<Result<String, String>> {
        let w = Rc::clone(&self.0);
        Box::pin(async move {
            w.calls.borrow_mut().push("fetch".into());
            gate(&w.fetch_gate).await;
            let mut set = w.set.borrow_mut();
            match set.fetch_errors.pop_front().or(set.fetch_error.clone()) {
                Some(error) => Err(error),
                None => Ok(set.latest.clone()),
            }
        })
    }

    fn newest_within(
        &self,
        _: &Rc<Tools>,
        major: u64,
    ) -> LocalFuture<Result<Option<String>, String>> {
        let w = Rc::clone(&self.0);
        Box::pin(async move {
            w.calls.borrow_mut().push(format!("within {major}"));
            gate(&w.within_gate).await;
            let mut set = w.set.borrow_mut();
            match set.within_errors.pop_front() {
                Some(error) => Err(error),
                None => Ok(set.within.clone()),
            }
        })
    }

    fn update(
        &self,
        _: &Rc<Tools>,
        _: &Ctx,
        target: String,
        before: BeforeInstall,
        exact_only: bool,
    ) -> LocalFuture<OmpUpdateOutcome> {
        let w = Rc::clone(&self.0);
        Box::pin(async move {
            let exact = if exact_only { " exact" } else { "" };
            w.calls.borrow_mut().push(format!("update {target}{exact}"));
            let skipped = w.set.borrow().outcome == OmpUpdateOutcome::Skipped;
            if !skipped {
                let _ = before().await;
            }
            gate(&w.update_gate).await;
            let mut set = w.set.borrow_mut();
            if let OmpUpdateOutcome::Updated(version) = &set.outcome {
                set.installed = Some(version.clone());
            }
            set.outcome.clone()
        })
    }

    fn installed(&self, _: &Tools) -> Option<String> {
        self.0.set.borrow().installed.clone()
    }

    fn fetch_compat(&self, _: &Rc<Tools>) -> LocalFuture<Fetched> {
        let w = Rc::clone(&self.0);
        Box::pin(async move {
            w.compat_reads.set(w.compat_reads.get() + 1);
            gate(&w.compat_gate).await;
            if let Some(replies) = w.compat_replies.borrow_mut().as_mut() {
                return match replies.len() {
                    0 => Fetched::Failed,
                    1 => match &replies[0] {
                        Fetched::Missing => Fetched::Missing,
                        Fetched::Body(body) => Fetched::Body(body.clone()),
                        Fetched::Failed => Fetched::Failed,
                    },
                    _ => replies.pop_front().unwrap(),
                };
            }
            let set = w.set.borrow();
            let verified = set
                .verified
                .clone()
                .unwrap_or_else(|| vec![set.latest.clone()]);
            let holding = set
                .holding
                .as_ref()
                .map(|(version, since)| json!({"version": version, "since": since, "issue": 41}));
            Fetched::Body(
                json!({ APP: {"verified": verified, "holding": holding} })
                    .to_string()
                    .into_bytes(),
            )
        })
    }

    fn run_omp(
        &self,
        _: &Rc<Tools>,
        args: Vec<&'static str>,
    ) -> LocalFuture<Result<OmpRun, String>> {
        let stock = Rc::clone(&self.0.stock);
        Box::pin(async move {
            let mut stock = stock.borrow_mut();
            let stdout = match args.as_slice() {
                ["config", "get", "update.auto", "--json"] => {
                    stock.reads += 1;
                    json!({"key": "update.auto", "value": stock.value.unwrap_or(false)})
                }
                ["config", "set", "update.auto", value, "--json"] => match stock.refuse.clone() {
                    Some(by) => json!({"key": "update.auto", "value": false, "overriddenBy": by}),
                    None => {
                        let value = *value == "true";
                        stock.writes.push(value);
                        stock.value = Some(value);
                        json!({"key": "update.auto", "value": value})
                    }
                },
                other => return Err(format!("unexpected omp {other:?}")),
            };
            Ok(OmpRun {
                code: 0,
                stdout: stdout.to_string(),
                stderr: String::new(),
            })
        })
    }
}

fn spawn_local(task: LocalFuture<()>) {
    tokio::task::spawn_local(task);
}

/// Options of a world, as the TypeScript harness's.
struct Opt {
    scheduled: bool,
    enabled: bool,
    installed: Option<&'static str>,
    follow: bool,
}

impl Default for Opt {
    fn default() -> Opt {
        Opt {
            scheduled: true,
            enabled: true,
            installed: Some("18.8.7"),
            follow: true,
        }
    }
}

struct H {
    tools: Rc<Tools>,
    w: Rc<World>,
    dir: Rc<tempfile::TempDir>,
}

fn prefs_file(dir: &tempfile::TempDir) -> String {
    dir.path().join("prefs.json").to_string_lossy().into_owned()
}

fn harness(opt: Opt) -> H {
    harness_in(opt, Rc::new(tempfile::tempdir().unwrap()), Rc::default())
}

/// A world in `dir` with stock's settings `stock`: a relaunch is a second world over the same two.
fn harness_in(opt: Opt, dir: Rc<tempfile::TempDir>, stock: Rc<RefCell<Stock>>) -> H {
    let w = Rc::new(World {
        set: RefCell::new(Set {
            latest: "18.9.0".into(),
            verified: None,
            within: None,
            holding: None,
            installed: opt.installed.map(str::to_owned),
            outcome: OmpUpdateOutcome::Updated("18.9.0".into()),
            fetch_errors: VecDeque::new(),
            fetch_error: None,
            within_errors: VecDeque::new(),
        }),
        calls: RefCell::default(),
        items: RefCell::default(),
        stock,
        fetch_gate: RefCell::default(),
        compat_gate: RefCell::default(),
        within_gate: RefCell::default(),
        update_gate: RefCell::default(),
        compat_replies: RefCell::default(),
        compat_reads: Cell::new(0),
        armed: RefCell::default(),
        scanned: Cell::new(0),
        now: Cell::new(T0),
    });
    let file = prefs_file(&dir);
    crate::prefs::set(&file, "toolsAutoUpdate", json!(opt.enabled)).unwrap();
    crate::prefs::set(&file, "ompFollowVerified", json!(opt.follow)).unwrap();
    let opts = serde_json::from_value(json!({
        "platform": "win32",
        "arch": "x64",
        "toolsDir": dir.path().join("tools").to_string_lossy(),
        "userData": dir.path().to_string_lossy(),
        "appVersion": APP,
        "testedOmp": TESTED,
        "automatic": false,
        "scheduled": {"omp": opt.scheduled, "cli": false, "ext": false},
        "manual": true,
        "now": T0,
    }))
    .unwrap();
    let tools = Tools::new(
        opts,
        w.clone(),
        spawn_local,
        Supervisor::this_binary(),
        STEP_MAX_MS,
    );
    tools.omp.borrow_mut().deps = Rc::new(Fake(Rc::clone(&w)));
    // Setup's detection finds the omp this world has installed (none: missing); its installers never start.
    let mut seams = super::super::setup::Seams::offline();
    let installed = opt.installed.map(str::to_owned);
    seams.detect = Some(Rc::new(move || {
        let mut detection = super::super::setup::Detection::default();
        if let Some(version) = &installed {
            detection
                .presence
                .insert("omp", super::super::setup::Presence::present(version));
            detection.omp = Some("/home/u/.bun/bin/omp".to_owned());
        }
        Box::pin(async move { detection })
    }));
    tools.setup.borrow_mut().seams = seams;
    super::super::cli::offline(&tools);
    H { tools, w, dir }
}

impl H {
    fn call(&self, method: &str) -> Outcome {
        let params = serde_json::value::to_raw_value(&json!({})).unwrap();
        call_tools(&self.tools, method, &params)
    }

    /// Lets every task run until none is ready, then notes main's timers.
    async fn settle(&self) {
        for _ in 0..200 {
            tokio::task::yield_now().await;
        }
        let items = self.w.items.borrow();
        let mut armed = self.w.armed.borrow_mut();
        for item in &items[self.w.scanned.get()..] {
            let timer = item["timer"].as_u64();
            match item["k"].as_str() {
                Some("timer") => {
                    armed.insert(
                        timer.unwrap(),
                        self.w.now.get() + item["ms"].as_u64().unwrap(),
                    );
                }
                Some("clearTimer") => {
                    armed.remove(&timer.unwrap());
                }
                _ => {}
            }
        }
        self.w.scanned.set(items.len());
    }

    /// `vi.advanceTimersByTimeAsync(ms)`: main's timers due by then fire in order, each at its time.
    async fn advance(&self, ms: u64) {
        let target = self.w.now.get() + ms;
        loop {
            self.settle().await;
            let next = {
                let armed = self.w.armed.borrow();
                armed
                    .iter()
                    .filter(|(_, due)| **due <= target)
                    .min_by_key(|(timer, due)| (**due, **timer))
                    .map(|(timer, due)| (*timer, *due))
            };
            let Some((timer, due)) = next else { break };
            self.w.armed.borrow_mut().remove(&timer);
            self.w.now.set(due);
            self.tools.clock.fire(timer, Some(due));
        }
        self.w.now.set(target);
        // Main's clock moved on: one timer that says so (the only one due now: all before it fired).
        let clock = Rc::clone(&self.tools.clock);
        tokio::task::spawn_local(async move { clock.sleep(0).await });
        self.settle().await;
        let dummy = {
            let armed = self.w.armed.borrow();
            armed
                .iter()
                .find(|(_, due)| **due == target)
                .map(|(timer, _)| *timer)
        };
        if let Some(timer) = dummy {
            self.w.armed.borrow_mut().remove(&timer);
            self.tools.clock.fire(timer, Some(target));
        }
        self.settle().await;
    }

    fn start(&self) {
        assert_eq!(now(self.call("start")), Ok(json!(true)));
    }

    /// Settings › Update now; settles when the pass ended.
    fn update_now(&self) -> LocalFuture<Result<Value, Fault>> {
        match self.call("omp.now") {
            Outcome::Later(answer) => answer,
            Outcome::Now(answer) => Box::pin(async move { answer }),
        }
    }

    fn repair(&self) -> LocalFuture<Result<Value, Fault>> {
        match self.call("omp.repair") {
            Outcome::Later(answer) => answer,
            Outcome::Now(answer) => Box::pin(async move { answer }),
        }
    }

    fn pref_changed(&self) {
        assert_eq!(now(self.call("omp.prefChanged")), Ok(Value::Null));
    }

    fn pref(&self, key: &str, value: Value) {
        crate::prefs::set(&prefs_file(&self.dir), key, value).unwrap();
    }

    fn state(&self) -> Value {
        now(self.call("state")).unwrap()["omp"].clone()
    }

    fn calls(&self) -> Vec<String> {
        self.w.calls.borrow().clone()
    }

    /// Forgets the calls and lines so far (the TypeScript cases' `calls.length = 0`, `logs.length = 0`).
    fn clear(&self) {
        self.w.calls.borrow_mut().clear();
        self.w
            .items
            .borrow_mut()
            .retain(|item| item["k"] == "timer" || item["k"] == "clearTimer");
        self.w.scanned.set(self.w.items.borrow().len());
    }

    fn count(&self, call: &str) -> usize {
        self.calls().iter().filter(|c| c.starts_with(call)).count()
    }

    /// The `omp-update` lines: step and details without `level`.
    fn logs(&self) -> Vec<(String, Value)> {
        self.w
            .items
            .borrow()
            .iter()
            .filter(|item| item["k"] == "log" && item["source"] == "omp-update")
            .map(|item| {
                let mut details = item["details"].clone();
                details.as_object_mut().unwrap().remove("level");
                (item["message"].as_str().unwrap().to_owned(), details)
            })
            .collect()
    }

    fn steps(&self) -> Vec<(String, Value)> {
        self.logs()
            .into_iter()
            .map(|(step, details)| (step, details["path"].clone()))
            .collect()
    }

    fn states(&self) -> Vec<Value> {
        self.w
            .items
            .borrow()
            .iter()
            .filter(|item| item["k"] == "state" && item["part"] == "omp")
            .map(|item| item["state"].clone())
            .collect()
    }

    fn set(&self, change: impl FnOnce(&mut Set)) {
        change(&mut self.w.set.borrow_mut());
    }

    fn close(&self) {
        assert_eq!(now(self.call("close")), Ok(Value::Null));
    }
}

fn now(outcome: Outcome) -> Result<Value, Fault> {
    match outcome {
        Outcome::Now(answer) => answer,
        Outcome::Later(_) => panic!("answered later"),
    }
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

fn held(version: &str, reason: &str) -> (Value, Value) {
    (json!(version), json!(reason))
}

fn held_of(state: &Value) -> Option<(Value, Value)> {
    (!state["held"].is_null()).then(|| {
        (
            state["held"]["version"].clone(),
            state["held"]["reason"].clone(),
        )
    })
}

/// Runs `test` on a local set (the hub's one thread).
fn run<F: Future<Output = ()>>(test: impl FnOnce() -> F) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(LocalSet::new().run_until(test()));
}

// ---- OmpUpdater (omp-updater.test.ts) ------------------------------------------------------------------------------

#[test]
fn checks_at_launch_installs_a_newer_omp_without_a_click_then_every_few_hours() {
    // "checks at launch, installs a newer omp without a click, then checks again every few hours"
    run(|| async {
        let h = harness(Opt::default());
        h.start();
        h.advance(0).await;
        assert_eq!(
            h.calls(),
            [
                "fetch",
                "update 18.9.0 exact",
                "release",
                "resume true",
                "toast 18.9.0"
            ]
        );
        let state = h.state();
        assert_eq!(
            (
                &state["phase"],
                &state["installed"],
                &state["latest"],
                &state["updatedTo"],
                &state["failure"]
            ),
            (
                &json!("idle"),
                &json!("18.9.0"),
                &json!("18.9.0"),
                &json!("18.9.0"),
                &Value::Null
            )
        );
        assert!(h.states().iter().any(|state| state["phase"] == "updating"));
        h.clear();
        h.advance(CHECK_INTERVAL_MS - 1).await;
        assert!(h.calls().is_empty());
        h.advance(1).await;
        assert_eq!(
            h.calls(),
            ["fetch"],
            "up to date: it only asks the registry"
        );
        h.close();
    });
}

#[test]
fn installs_nothing_when_the_latest_is_not_newer() {
    // "installs nothing when the registry's latest is not newer than the installed omp"
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.11.0"),
            ..Opt::default()
        });
        h.start();
        h.advance(0).await;
        assert_eq!(h.calls(), ["fetch"]);
        let state = h.state();
        assert_eq!(
            (&state["latest"], &state["installed"], &state["failure"]),
            (&json!("18.9.0"), &json!("18.11.0"), &Value::Null)
        );
    });
}

#[test]
fn names_the_omp_this_release_was_tested_with() {
    // "names the omp this release was tested with, and a paired device reads it from the host's state" (the schema half
    // stays with app-protocol.ts; main passes `TESTED_OMP_VERSION` as `testedOmp`)
    run(|| async {
        assert_eq!(harness(Opt::default()).state()["tested"], TESTED);
    });
}

#[test]
fn a_canary_of_the_installed_release_is_not_newer_and_a_newer_canary_installs_only_when_asked() {
    // "treats a canary of the installed release as not newer, and installs a canary of a newer release only when asked"
    run(|| async {
        let same = harness(Opt {
            installed: Some("18.9.0"),
            ..Opt::default()
        });
        same.set(|s| s.latest = "18.9.0-canary.3".into());
        same.start();
        same.advance(0).await;
        assert_eq!(same.calls(), ["fetch"]);
        let newer = harness(Opt::default());
        newer.set(|s| {
            s.latest = "18.9.0-canary.3".into();
            s.outcome = OmpUpdateOutcome::Updated("18.9.0-canary.3".into());
        });
        newer.start();
        newer.advance(0).await;
        assert_eq!(newer.count("update"), 0);
        assert_eq!(
            held_of(&newer.state()),
            Some(held("18.9.0-canary.3", "verifying"))
        );
        newer.update_now().await.unwrap();
        let calls = newer.calls();
        assert_eq!(calls[calls.len() - 4], "update 18.9.0-canary.3");
    });
}

#[test]
fn leaves_a_missing_omp_to_machine_setup() {
    // "leaves a missing omp to machine setup: no check (stock's needs an omp to run), no failure"
    run(|| async {
        let h = harness(Opt {
            installed: None,
            ..Opt::default()
        });
        h.start();
        h.advance(0).await;
        assert!(h.calls().is_empty());
        let state = h.state();
        assert_eq!(
            (&state["phase"], &state["failure"], &state["latest"]),
            (&json!("idle"), &Value::Null, &Value::Null)
        );
    });
}

#[test]
fn keeps_the_registry_error_backs_off_to_a_day_and_resets_after_a_good_check() {
    // "keeps the registry error as the reason, backs off 4 h → 8 h → 16 h → 24 h, and resets after a good check"
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.9.0"),
            ..Opt::default()
        });
        h.set(|s| s.fetch_error = Some("getaddrinfo ENOTFOUND registry.npmjs.org".into()));
        h.start();
        h.advance(0).await;
        assert_eq!(
            h.state()["failure"],
            json!({"reason": "check", "detail": "getaddrinfo ENOTFOUND registry.npmjs.org"})
        );
        assert_eq!(h.count("fetch"), 1);
        h.advance(8 * HOUR - 1).await;
        assert_eq!(h.count("fetch"), 1);
        h.advance(1).await;
        assert_eq!(h.count("fetch"), 2);
        h.advance(16 * HOUR).await;
        assert_eq!(h.count("fetch"), 3);
        h.advance(MAX_CHECK_INTERVAL_MS).await;
        assert_eq!(h.count("fetch"), 4);
        // The network is back: the failure clears and the next check is a normal interval away.
        h.set(|s| s.fetch_error = None);
        h.advance(MAX_CHECK_INTERVAL_MS).await;
        assert_eq!(h.count("fetch"), 5);
        assert_eq!(h.state()["failure"], Value::Null);
        h.advance(CHECK_INTERVAL_MS).await;
        assert_eq!(h.count("fetch"), 6);
    });
}

#[test]
fn a_failed_install_keeps_its_reason_brings_the_helpers_back_and_retries() {
    // "keeps a failed install's reason in the state, brings the helpers back on the old omp and retries on the next check"
    run(|| async {
        let h = harness(Opt::default());
        h.set(|s| {
            s.outcome =
                OmpUpdateOutcome::Failed(json!({"reason": "install", "detail": "exit 1 — EBUSY"}))
        });
        h.start();
        h.advance(0).await;
        assert_eq!(
            h.calls(),
            ["fetch", "update 18.9.0 exact", "release", "resume false"]
        );
        let state = h.state();
        assert_eq!(
            (
                &state["phase"],
                &state["installed"],
                &state["updatedTo"],
                &state["failure"]
            ),
            (
                &json!("idle"),
                &json!("18.8.7"),
                &Value::Null,
                &json!({"reason": "install", "detail": "exit 1 — EBUSY"})
            )
        );
        h.clear();
        h.set(|s| s.outcome = OmpUpdateOutcome::Updated("18.9.0".into()));
        h.advance(8 * HOUR).await;
        assert_eq!(
            h.calls(),
            [
                "fetch",
                "update 18.9.0 exact",
                "release",
                "resume true",
                "toast 18.9.0"
            ]
        );
        assert_eq!(h.state()["failure"], Value::Null);
    });
}

#[test]
fn a_skipped_install_leaves_no_failure_and_helpers_never_released_stay() {
    // "skipped (omp went missing meanwhile) leaves no failure and no toast; helpers stay if never released"
    run(|| async {
        let h = harness(Opt::default());
        h.set(|s| s.outcome = OmpUpdateOutcome::Skipped);
        h.start();
        h.advance(0).await;
        assert_eq!(h.calls(), ["fetch", "update 18.9.0 exact"]);
        assert_eq!(h.state()["failure"], Value::Null);
        assert_eq!(h.logs().last().unwrap().0, "skipped");
    });
}

#[test]
fn does_nothing_on_a_timer_while_the_pref_is_off_but_update_now_installs() {
    // "does nothing on a timer while the pref is off, but Update now still checks and installs"
    run(|| async {
        let h = harness(Opt {
            enabled: false,
            ..Opt::default()
        });
        h.start();
        h.advance(CHECK_INTERVAL_MS * 3).await;
        assert!(h.calls().is_empty());
        assert_eq!(h.state()["enabled"], false);
        h.update_now().await.unwrap();
        assert_eq!(
            h.calls(),
            [
                "fetch",
                "update 18.9.0",
                "release",
                "resume true",
                "toast 18.9.0"
            ]
        );
    });
}

#[test]
fn turning_the_pref_on_checks_now_and_off_stops_the_timers_checks() {
    // "turning the pref on checks right away; turning it off stops the timer's checks"
    run(|| async {
        let h = harness(Opt {
            enabled: false,
            installed: Some("18.9.0"),
            ..Opt::default()
        });
        h.start();
        h.advance(0).await;
        assert_eq!(h.count("fetch"), 0);
        h.pref("toolsAutoUpdate", json!(true));
        h.pref_changed();
        h.advance(0).await;
        assert_eq!(h.count("fetch"), 1);
        h.pref("toolsAutoUpdate", json!(false));
        h.pref_changed();
        h.advance(CHECK_INTERVAL_MS * 2).await;
        assert_eq!(h.count("fetch"), 1);
    });
}

#[test]
fn never_checks_on_its_own_in_a_launch_that_does_not_schedule() {
    // "never checks on its own in a launch that does not schedule (dev, tests); Update now still works"
    run(|| async {
        let h = harness(Opt {
            scheduled: false,
            ..Opt::default()
        });
        h.start();
        h.advance(CHECK_INTERVAL_MS * 3).await;
        assert!(h.calls().is_empty());
        assert_eq!(h.state()["scheduled"], false);
        h.update_now().await.unwrap();
        assert_eq!(h.count("update"), 1);
    });
}

#[test]
fn update_now_during_a_check_joins_it() {
    // "one run at a time: Update now during a check joins it"
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.9.0"),
            ..Opt::default()
        });
        let (open, gate) = oneshot::channel();
        *h.w.fetch_gate.borrow_mut() = Some(gate);
        h.start();
        h.settle().await;
        let joined = h.update_now();
        open.send(()).unwrap();
        joined.await.unwrap();
        h.advance(0).await;
        assert_eq!(h.count("fetch"), 1);
    });
}

#[test]
fn never_runs_after_the_close() {
    // "never runs after dispose"
    run(|| async {
        let h = harness(Opt::default());
        h.close();
        assert_eq!(now(h.call("start")), Ok(json!(false)));
        assert_eq!(h.update_now().await.unwrap_err().code, "tools_closed");
        h.advance(CHECK_INTERVAL_MS).await;
        assert!(h.calls().is_empty());
    });
}

#[test]
fn a_quit_during_an_install_starts_nothing_after_it() {
    // "starts nothing after a quit that lands during an install: no resume, no toast, helpers stay down"
    // "does not resume the helpers after a failed install that lands once disposed"
    run(|| async {
        for outcome in [
            OmpUpdateOutcome::Updated("18.9.0".into()),
            OmpUpdateOutcome::Failed(json!({"reason": "cancelled"})),
        ] {
            let h = harness(Opt::default());
            h.set(|s| s.outcome = outcome);
            let (open, gate) = oneshot::channel();
            *h.w.update_gate.borrow_mut() = Some(gate);
            h.start();
            h.advance(0).await;
            assert_eq!(h.calls(), ["fetch", "update 18.9.0 exact", "release"]);
            h.close();
            let _ = open.send(());
            h.advance(CHECK_INTERVAL_MS * 2).await;
            assert_eq!(h.calls(), ["fetch", "update 18.9.0 exact", "release"]);
        }
    });
}

#[test]
fn update_now_shows_checking_in_the_state_right_after_the_call() {
    // "Update now starts its check within the call: the phase is checking before anything is awaited"
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.9.0"),
            ..Opt::default()
        });
        let run = h.update_now();
        assert_eq!(h.state()["phase"], "checking");
        run.await.unwrap();
        assert_eq!(h.state()["phase"], "idle");
    });
}

#[test]
fn a_cancelled_install_backs_off_like_any_failure() {
    // "a cancelled install backs off like any other failure"
    run(|| async {
        let h = harness(Opt::default());
        h.set(|s| s.outcome = OmpUpdateOutcome::Failed(json!({"reason": "cancelled"})));
        h.start();
        h.advance(0).await;
        assert_eq!(h.count("update"), 1);
        h.advance(CHECK_INTERVAL_MS).await;
        assert_eq!(h.count("update"), 1);
        h.advance(CHECK_INTERVAL_MS).await;
        assert_eq!(h.count("update"), 2);
    });
}

#[test]
fn a_skipped_install_keeps_the_back_off_before_it() {
    // "an install that was skipped keeps the back-off of the failures before it"
    run(|| async {
        let h = harness(Opt::default());
        h.set(|s| {
            s.fetch_errors.push_back("offline".into());
            s.outcome = OmpUpdateOutcome::Skipped;
        });
        h.start();
        h.advance(0).await;
        h.advance(8 * HOUR).await;
        assert_eq!(h.calls(), ["fetch", "fetch", "update 18.9.0 exact"]);
        h.advance(8 * HOUR - 1).await;
        assert_eq!(h.count("fetch"), 2, "still one failure in a row: 8 h again");
        h.advance(1).await;
        assert_eq!(h.count("fetch"), 3);
    });
}

#[test]
fn a_pref_change_checks_now_and_restarts_the_timer_but_not_during_a_check_or_before_start() {
    // "a pref change checks now and restarts the timer from there; during a check, or before start, it starts none"
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.9.0"),
            ..Opt::default()
        });
        h.pref_changed();
        h.advance(0).await;
        assert_eq!(h.count("fetch"), 0);
        assert_eq!(h.states().len(), 1);
        h.start();
        h.advance(HOUR).await;
        assert_eq!(h.count("fetch"), 1);
        h.pref_changed();
        h.advance(0).await;
        assert_eq!(h.count("fetch"), 2);
        // The launch timer (due at 4 h) is gone: the next check is 4 h after the pref change.
        h.advance(CHECK_INTERVAL_MS - 1).await;
        assert_eq!(h.count("fetch"), 2);
        h.advance(1).await;
        assert_eq!(h.count("fetch"), 3);
        let (open, gate) = oneshot::channel();
        *h.w.fetch_gate.borrow_mut() = Some(gate);
        let running = h.update_now();
        h.settle().await;
        h.pref_changed();
        open.send(()).unwrap();
        running.await.unwrap();
        h.advance(0).await;
        assert_eq!(h.count("fetch"), 4);
        // The timer still counts from the last scheduled check.
        h.advance(CHECK_INTERVAL_MS).await;
        assert_eq!(h.count("fetch"), 5);
    });
}

#[test]
fn a_pass_past_its_bound_fails_and_brings_the_helpers_back() {
    // New with the one queue: an omp pass is bound like every step (it ran beside the chain unbound).
    run(|| async {
        let h = harness(Opt::default());
        let (_open, gate) = oneshot::channel::<()>();
        *h.w.update_gate.borrow_mut() = Some(gate);
        h.start();
        h.advance(STEP_MAX_MS).await;
        assert_eq!(
            h.calls(),
            ["fetch", "update 18.9.0 exact", "release", "resume false"]
        );
        let state = h.state();
        assert_eq!(
            (&state["phase"], &state["failure"]["reason"]),
            (&json!("idle"), &json!("install"))
        );
        assert!(h.w.items.borrow().iter().any(|item| item["k"] == "stalled"));
        // A failure in a row: 8 h to the next check.
        h.set(|s| s.installed = Some("18.9.0".into()));
        h.advance(8 * HOUR - 1).await;
        assert_eq!(h.count("fetch"), 1);
        h.advance(1).await;
        assert_eq!(h.count("fetch"), 2);
    });
}

// ---- OmpUpdater and the verified list ------------------------------------------------------------------------------

#[test]
fn an_unverified_omp_is_held_verifying_and_each_check_says_so() {
    // "a scheduled check that finds an omp runners have not verified installs nothing and says it is being verified"
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.22.2"),
            ..Opt::default()
        });
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.verified = Some(vec![]);
        });
        h.start();
        h.advance(0).await;
        assert_eq!(h.count("update"), 0);
        let state = h.state();
        assert_eq!(held_of(&state), Some(held("19.0.0", "verifying")));
        assert_eq!(
            (&state["failure"], &state["updatedTo"]),
            (&Value::Null, &Value::Null)
        );
        h.advance(CHECK_INTERVAL_MS).await;
        assert_eq!(h.count("fetch"), 2, "holding is no failure");
        let since = state["held"]["since"].clone();
        let checked = |path: &str| json!({"path": path, "installed": "18.22.2", "latest": "19.0.0", "tested": TESTED, "verified": null});
        let held_line = |path: &str| json!({"path": path, "installed": "18.22.2", "version": "19.0.0", "reason": "verifying", "since": since});
        assert_eq!(
            h.logs(),
            [
                ("checked".into(), checked("launch")),
                ("held".into(), held_line("launch")),
                ("checked".into(), checked("scheduled")),
                ("held".into(), held_line("scheduled")),
            ]
        );
    });
}

#[test]
fn a_held_version_carries_when_this_computer_first_saw_it() {
    // "a version held for verification carries when this computer first saw it, the same on every later check"
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.22.2"),
            ..Opt::default()
        });
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.verified = Some(vec![]);
        });
        h.start();
        h.advance(0).await;
        let since = crate::care::iso_of(T0 as f64);
        assert_eq!(
            h.state()["held"],
            json!({"version": "19.0.0", "reason": "verifying", "since": since})
        );
        assert_eq!(
            crate::prefs::get(&prefs_file(&h.dir), "ompHeldSeen").unwrap(),
            Some(json!({"version": "19.0.0", "at": since}))
        );
        h.advance(CHECK_INTERVAL_MS).await;
        assert_eq!(h.state()["held"]["since"], json!(since));
        h.set(|s| {
            s.verified = Some(strings(&["19.0.0"]));
            s.outcome = OmpUpdateOutcome::Updated("19.0.0".into());
        });
        h.advance(CHECK_INTERVAL_MS).await;
        let state = h.state();
        assert_eq!(
            (&state["installed"], &state["held"]),
            (&json!("19.0.0"), &Value::Null)
        );
        // A failed release names the runners' time, not this computer's.
        h.set(|s| {
            s.latest = "19.1.0".into();
            s.holding = Some(("19.1.0".into(), SINCE.into()));
        });
        h.advance(CHECK_INTERVAL_MS).await;
        assert_eq!(
            h.state()["held"],
            json!({"version": "19.1.0", "reason": "failed", "since": SINCE})
        );
    });
}

#[test]
fn once_verified_the_next_check_installs_it_whatever_its_major() {
    // "once runners verified it, the next check installs it, whatever its major"
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.22.2"),
            ..Opt::default()
        });
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.verified = Some(vec![]);
        });
        h.start();
        h.advance(0).await;
        assert_eq!(h.count("update"), 0);
        h.set(|s| {
            s.verified = Some(strings(&["19.0.0"]));
            s.outcome = OmpUpdateOutcome::Updated("19.0.0".into());
        });
        h.advance(CHECK_INTERVAL_MS).await;
        assert_eq!(
            h.calls(),
            [
                "fetch",
                "fetch",
                "update 19.0.0 exact",
                "release",
                "resume true",
                "toast 19.0.0"
            ]
        );
        let state = h.state();
        assert_eq!(
            (&state["installed"], &state["held"], &state["verified"]),
            (&json!("19.0.0"), &Value::Null, &json!(["19.0.0"]))
        );
        let logs = h.logs();
        assert_eq!(
            logs[logs.len() - 3..],
            [
                (
                    "checked".into(),
                    json!({"path": "scheduled", "installed": "18.22.2", "latest": "19.0.0", "tested": TESTED, "verified": "19.0.0"})
                ),
                (
                    "started".into(),
                    json!({"path": "scheduled", "from": "18.22.2", "target": "19.0.0"})
                ),
                (
                    "finished".into(),
                    json!({"path": "scheduled", "from": "18.22.2", "target": "19.0.0", "version": "19.0.0"})
                ),
            ]
        );
    });
}

#[test]
fn an_omp_runners_failed_is_held_failed_with_their_time() {
    // "an omp runners failed is held as failed, with when they first failed it"
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.22.2"),
            ..Opt::default()
        });
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.verified = Some(vec![]);
            s.holding = Some(("19.0.0".into(), SINCE.into()));
        });
        h.start();
        h.advance(0).await;
        assert_eq!(h.count("update"), 0);
        assert_eq!(
            h.state()["held"],
            json!({"version": "19.0.0", "reason": "failed", "since": SINCE})
        );
        assert_eq!(
            h.logs().last().unwrap(),
            &(
                "held".into(),
                json!({"path": "launch", "installed": "18.22.2", "version": "19.0.0", "reason": "failed", "since": SINCE})
            )
        );
    });
}

#[test]
fn while_the_newest_is_held_a_check_installs_the_newest_verified_below_it_by_name() {
    // "while the newest is held, a check installs the newest verified omp below it, by name only"
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.22.0"),
            ..Opt::default()
        });
        h.set(|s| {
            s.latest = "19.0.1".into();
            s.verified = Some(strings(&["18.22.2", "19.0.0"]));
            s.outcome = OmpUpdateOutcome::Updated("19.0.0".into());
        });
        h.start();
        h.advance(0).await;
        assert_eq!(
            h.calls(),
            [
                "fetch",
                "update 19.0.0 exact",
                "release",
                "resume true",
                "toast 19.0.0"
            ]
        );
        let state = h.state();
        assert_eq!(state["installed"], "19.0.0");
        assert_eq!(held_of(&state), Some(held("19.0.1", "verifying")));
        let steps: Vec<String> = h.logs().into_iter().map(|(step, _)| step).collect();
        assert_eq!(steps, ["checked", "held", "started", "finished"]);
    });
}

#[test]
fn with_nothing_verified_a_check_brings_omp_to_the_tested_omp() {
    // "with nothing verified for this release yet, a check brings omp up to the tested omp, by name only"
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.20.0"),
            ..Opt::default()
        });
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.verified = Some(vec![]);
            s.outcome = OmpUpdateOutcome::Updated(TESTED.into());
        });
        h.start();
        h.advance(0).await;
        assert_eq!(
            h.calls(),
            [
                "fetch",
                "update 18.22.2 exact",
                "release",
                "resume true",
                "toast 18.22.2"
            ]
        );
        assert_eq!(held_of(&h.state()), Some(held("19.0.0", "verifying")));
    });
}

#[test]
fn never_steps_down_nor_past_the_registry() {
    // "never steps omp down, and never installs a verified omp the registry does not offer yet"
    run(|| async {
        let h = harness(Opt {
            installed: Some("19.0.0"),
            ..Opt::default()
        });
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.verified = Some(strings(&["18.22.2"]));
        });
        h.start();
        h.advance(0).await;
        assert_eq!(h.count("update"), 0);
        assert_eq!(h.state()["held"], Value::Null);
        h.set(|s| s.verified = Some(strings(&["19.0.0", "19.1.0"])));
        h.advance(CHECK_INTERVAL_MS).await;
        assert_eq!(h.count("update"), 0);
    });
}

#[test]
fn holds_a_newest_that_is_no_exact_release() {
    // "holds a newest that is no exact release rather than install it unasked"
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.22.2"),
            ..Opt::default()
        });
        h.set(|s| s.latest = "nightly-3f2a".into());
        h.start();
        h.advance(0).await;
        assert_eq!(h.count("update"), 0);
        assert_eq!(held_of(&h.state()), Some(held("nightly-3f2a", "verifying")));
    });
}

#[test]
fn the_repair_pass_runs_nothing_while_the_pref_is_off_or_the_launch_does_not_schedule() {
    // "the repair pass installs nothing while the pref is off: no check, no install, one line saying so"
    // "the repair pass installs nothing in a launch that never updates on its own (dev, tests)"
    run(|| async {
        for (opt, reason) in [
            (
                Opt {
                    enabled: false,
                    installed: Some("18.22.0"),
                    ..Opt::default()
                },
                "auto-update-off",
            ),
            (
                Opt {
                    scheduled: false,
                    installed: Some("18.22.0"),
                    ..Opt::default()
                },
                "not-scheduled",
            ),
        ] {
            let h = harness(opt);
            h.set(|s| s.latest = "18.23.0".into());
            assert_eq!(h.repair().await, Ok(Value::Null));
            assert!(h.calls().is_empty());
            assert_eq!(h.state()["phase"], "idle");
            assert_eq!(
                h.logs(),
                [(
                    "skipped".into(),
                    json!({"path": "repair", "reason": reason})
                )]
            );
        }
    });
}

#[test]
fn the_repair_pass_with_the_pref_on_installs_a_verified_newer_omp_and_no_unverified_one() {
    // "the repair pass with the pref on installs a verified newer omp"
    // "the repair pass with the pref on installs no unverified omp"
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.22.0"),
            ..Opt::default()
        });
        h.set(|s| {
            s.latest = "18.23.0".into();
            s.outcome = OmpUpdateOutcome::Updated("18.23.0".into());
        });
        h.repair().await.unwrap();
        assert_eq!(
            h.calls(),
            [
                "fetch",
                "update 18.23.0 exact",
                "release",
                "resume true",
                "toast 18.23.0"
            ]
        );
        let path = json!("repair");
        assert_eq!(
            h.steps(),
            [
                ("checked".into(), path.clone()),
                ("started".into(), path.clone()),
                ("finished".into(), path.clone())
            ]
        );
        let h = harness(Opt {
            installed: Some("18.22.2"),
            ..Opt::default()
        });
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.verified = Some(vec![]);
        });
        h.repair().await.unwrap();
        assert_eq!(h.count("update"), 0);
        let state = h.state();
        assert_eq!(
            (held_of(&state), &state["failure"]),
            (Some(held("19.0.0", "verifying")), &Value::Null)
        );
        assert_eq!(
            h.steps(),
            [("checked".into(), path.clone()), ("held".into(), path)]
        );
    });
}

#[test]
fn the_repair_call_leaves_a_missing_or_broken_omp_to_setup() {
    // BridgeHealth's branch (index.ts): setup's retry of omp while setup holds it missing or broken.
    run(|| async {
        let h = harness(Opt::default());
        h.tools.setup.borrow_mut().items[2].presence =
            Some(super::super::setup::Presence::Broken {
                detail: "compiled".into(),
                path: None,
            });
        assert_eq!(h.repair().await, Ok(Value::Null), "setup's retry, queued");
        assert!(h.calls().is_empty());
        // Only setup's own lines (its retry found no Bun to install omp with), none of the updater's.
        assert!(
            h.logs()
                .iter()
                .all(|(_, details)| details["path"] == "setup")
        );
    });
}

#[test]
fn an_omp_above_the_tested_major_is_kept() {
    // "an omp already above the tested major is kept: launch, the timer and the repair pass neither move it back nor
    // install an unverified newer release"
    run(|| async {
        let h = harness(Opt {
            installed: Some("19.0.0"),
            ..Opt::default()
        });
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.verified = Some(vec![]);
        });
        h.start();
        h.advance(0).await;
        assert_eq!(h.calls(), ["fetch"]);
        let state = h.state();
        assert_eq!(
            (&state["held"], &state["failure"]),
            (&Value::Null, &Value::Null)
        );
        h.clear();
        h.set(|s| s.latest = "19.0.1".into());
        h.advance(CHECK_INTERVAL_MS).await;
        h.repair().await.unwrap();
        assert_eq!(h.calls(), ["fetch", "fetch"]);
        assert_eq!(held_of(&h.state()), Some(held("19.0.1", "verifying")));
        let steps: Vec<_> = h.steps();
        assert_eq!(
            steps,
            [
                ("checked".into(), json!("scheduled")),
                ("held".into(), json!("scheduled")),
                ("checked".into(), json!("repair")),
                ("held".into(), json!("repair")),
            ]
        );
    });
}

#[test]
fn update_now_installs_a_held_omp_and_the_timer_still_holds_the_next() {
    // "Update now installs a held omp: a person's click is the ask"
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.22.2"),
            ..Opt::default()
        });
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.verified = Some(vec![]);
        });
        h.start();
        h.advance(0).await;
        assert_eq!(held_of(&h.state()), Some(held("19.0.0", "verifying")));
        h.clear();
        h.set(|s| s.outcome = OmpUpdateOutcome::Updated("19.0.0".into()));
        h.update_now().await.unwrap();
        assert_eq!(
            h.calls(),
            [
                "fetch",
                "update 19.0.0",
                "release",
                "resume true",
                "toast 19.0.0"
            ]
        );
        let state = h.state();
        assert_eq!(
            (
                &state["installed"],
                &state["updatedTo"],
                &state["held"],
                &state["failure"]
            ),
            (
                &json!("19.0.0"),
                &json!("19.0.0"),
                &Value::Null,
                &Value::Null
            )
        );
        assert_eq!(
            h.logs(),
            [
                (
                    "checked".into(),
                    json!({"path": "manual", "installed": "18.22.2", "latest": "19.0.0", "tested": TESTED, "verified": null})
                ),
                (
                    "started".into(),
                    json!({"path": "manual", "from": "18.22.2", "target": "19.0.0"})
                ),
                (
                    "finished".into(),
                    json!({"path": "manual", "from": "18.22.2", "target": "19.0.0", "version": "19.0.0"})
                ),
            ]
        );
        h.set(|s| s.latest = "19.0.1".into());
        h.advance(CHECK_INTERVAL_MS).await;
        assert_eq!(h.count("update"), 1);
        assert_eq!(held_of(&h.state()), Some(held("19.0.1", "verifying")));
    });
}

#[test]
fn update_now_with_the_pref_off_installs_a_held_omp() {
    // "Update now with the pref off still installs a held omp"
    run(|| async {
        let h = harness(Opt {
            enabled: false,
            installed: Some("18.22.2"),
            ..Opt::default()
        });
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.verified = Some(vec![]);
            s.outcome = OmpUpdateOutcome::Updated("19.0.0".into());
        });
        h.update_now().await.unwrap();
        assert_eq!(
            h.calls(),
            [
                "fetch",
                "update 19.0.0",
                "release",
                "resume true",
                "toast 19.0.0"
            ]
        );
    });
}

#[test]
fn a_click_before_the_version_is_chosen_makes_the_pass_the_persons() {
    // "a click that lands while the timer's pass is still checking makes that pass the person's"
    // "a click that lands while the pass still reads the verified list installs the held omp"
    run(|| async {
        for gated in ["fetch", "compat"] {
            let h = harness(Opt {
                installed: Some("18.22.2"),
                ..Opt::default()
            });
            h.set(|s| {
                s.latest = "19.0.0".into();
                s.verified = Some(vec![]);
                s.outcome = OmpUpdateOutcome::Updated("19.0.0".into());
            });
            let (open, gate) = oneshot::channel();
            *(if gated == "fetch" {
                &h.w.fetch_gate
            } else {
                &h.w.compat_gate
            })
            .borrow_mut() = Some(gate);
            h.start();
            h.settle().await;
            let clicked = h.update_now();
            open.send(()).unwrap();
            clicked.await.unwrap();
            assert_eq!(
                h.calls(),
                [
                    "fetch",
                    "update 19.0.0",
                    "release",
                    "resume true",
                    "toast 19.0.0"
                ],
                "{gated}"
            );
            let manual = json!("manual");
            assert_eq!(
                h.steps(),
                [
                    ("checked".into(), manual.clone()),
                    ("started".into(), manual.clone()),
                    ("finished".into(), manual)
                ]
            );
            // The click was for that pass only: the timer's next one holds 19.0.1.
            h.set(|s| s.latest = "19.0.1".into());
            h.advance(CHECK_INTERVAL_MS).await;
            assert_eq!(h.count("update"), 1);
        }
    });
}

#[test]
fn a_click_after_the_version_is_chosen_changes_nothing_about_the_install() {
    // "a click after the version is chosen changes nothing about the install that runs"
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.22.0"),
            ..Opt::default()
        });
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.verified = Some(strings(&["18.22.2"]));
            s.outcome = OmpUpdateOutcome::Updated("18.22.2".into());
        });
        let (open, gate) = oneshot::channel();
        *h.w.update_gate.borrow_mut() = Some(gate);
        h.start();
        h.advance(0).await;
        let clicked = h.update_now();
        open.send(()).unwrap();
        clicked.await.unwrap();
        assert_eq!(
            h.calls(),
            [
                "fetch",
                "update 18.22.2 exact",
                "release",
                "resume true",
                "toast 18.22.2"
            ]
        );
        assert_eq!(
            h.logs().last().unwrap(),
            &(
                "finished".into(),
                json!({"path": "launch", "from": "18.22.0", "target": "18.22.2", "version": "18.22.2"})
            )
        );
        assert_eq!(held_of(&h.state()), Some(held("19.0.0", "verifying")));
    });
}

#[test]
fn writes_a_line_for_a_failed_check_and_a_failed_install() {
    // "writes a line for a failed check and for a failed install, each with its path and reason"
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.22.0"),
            ..Opt::default()
        });
        h.set(|s| {
            s.fetch_errors
                .push_back("getaddrinfo ENOTFOUND registry.npmjs.org".into())
        });
        h.start();
        h.advance(0).await;
        assert_eq!(
            h.logs(),
            [(
                "failed".into(),
                json!({"path": "launch", "reason": "check", "detail": "getaddrinfo ENOTFOUND registry.npmjs.org"})
            )]
        );
        h.clear();
        h.set(|s| {
            s.latest = "18.23.0".into();
            s.outcome =
                OmpUpdateOutcome::Failed(json!({"reason": "install", "detail": "exit 1 — EBUSY"}));
        });
        h.update_now().await.unwrap();
        assert_eq!(
            h.logs(),
            [
                (
                    "checked".into(),
                    json!({"path": "manual", "installed": "18.22.0", "latest": "18.23.0", "tested": TESTED, "verified": "18.23.0"})
                ),
                (
                    "started".into(),
                    json!({"path": "manual", "from": "18.22.0", "target": "18.23.0"})
                ),
                (
                    "failed".into(),
                    json!({"path": "manual", "target": "18.23.0", "reason": "install", "detail": "exit 1 — EBUSY"})
                ),
            ]
        );
        assert_eq!(
            h.w.items
                .borrow()
                .iter()
                .rev()
                .find(|item| item["k"] == "log")
                .unwrap()["details"]["level"],
            "warn"
        );
    });
}

#[test]
fn a_hold_is_written_as_main_sends_it_whichever_the_reason() {
    // "a paired device reads what its host holds from the host's state, whichever the reason" (the zod half stays)
    let hold = |reason, since: Option<&str>| Hold {
        version: "19.0.0".into(),
        reason,
        since: since.map(str::to_owned),
    };
    assert_eq!(
        json!(hold("verifying", None)),
        json!({"version": "19.0.0", "reason": "verifying"})
    );
    assert_eq!(
        json!(hold("failed", Some(SINCE))),
        json!({"version": "19.0.0", "reason": "failed", "since": SINCE})
    );
    assert_eq!(
        json!(hold("untested-major", None)),
        json!({"version": "19.0.0", "reason": "untested-major"})
    );
}

// ---- OmpUpdater with the verified list off -------------------------------------------------------------------------

fn off(installed: &'static str) -> H {
    harness(Opt {
        installed: Some(installed),
        follow: false,
        ..Opt::default()
    })
}

#[test]
fn a_newer_major_is_held_without_reading_the_list() {
    // "a scheduled check that finds a newer major installs nothing, says it is held, and never reads the verified list"
    run(|| async {
        let h = off("18.22.2");
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.within = Some("18.22.2".into());
        });
        h.start();
        h.advance(0).await;
        assert_eq!(h.calls(), ["fetch", "within 18"]);
        let state = h.state();
        assert_eq!(
            state["held"],
            json!({"version": "19.0.0", "reason": "untested-major"})
        );
        assert!(state.get("verified").is_none(), "{state}");
        h.advance(CHECK_INTERVAL_MS).await;
        assert_eq!(h.count("fetch"), 2);
        assert_eq!(h.count("update"), 0);
        assert_eq!(h.w.compat_reads.get(), 0);
        let checked = |path: &str| json!({"path": path, "installed": "18.22.2", "latest": "19.0.0", "tested": TESTED});
        let held = |path: &str| json!({"path": path, "installed": "18.22.2", "version": "19.0.0", "reason": "untested-major", "tested": TESTED});
        assert_eq!(
            h.logs(),
            [
                ("checked".into(), checked("launch")),
                ("held".into(), held("launch")),
                ("checked".into(), checked("scheduled")),
                ("held".into(), held("scheduled")),
            ]
        );
    });
}

#[test]
fn the_tested_majors_newest_installs_by_name() {
    // "a scheduled check installs the registry's newest release of the tested major, by name only, whatever the list says"
    // "while a major is held, a scheduled check still installs the newest release of the tested major, by name only"
    run(|| async {
        let h = off("18.22.2");
        h.set(|s| {
            s.latest = "18.23.0".into();
            s.verified = Some(vec![]);
            s.outcome = OmpUpdateOutcome::Updated("18.23.0".into());
        });
        h.start();
        h.advance(0).await;
        assert_eq!(
            h.calls(),
            [
                "fetch",
                "update 18.23.0 exact",
                "release",
                "resume true",
                "toast 18.23.0"
            ]
        );
        assert_eq!(h.state()["held"], Value::Null);
        let h = off("18.22.0");
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.within = Some("18.22.2".into());
            s.outcome = OmpUpdateOutcome::Updated("18.22.2".into());
        });
        h.start();
        h.advance(0).await;
        assert_eq!(
            h.calls(),
            [
                "fetch",
                "within 18",
                "update 18.22.2 exact",
                "release",
                "resume true",
                "toast 18.22.2"
            ]
        );
        let state = h.state();
        assert_eq!(
            (&state["updatedTo"], held_of(&state)),
            (&json!("18.22.2"), Some(held("19.0.0", "untested-major")))
        );
    });
}

#[test]
fn never_installs_another_major_or_an_unreadable_version() {
    // "never installs what the lookup for the tested major answers when that is another major, nor a version whose
    // major cannot be read"
    run(|| async {
        let h = off("18.22.0");
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.within = Some("19.0.0".into());
        });
        h.start();
        h.advance(0).await;
        assert_eq!(h.count("update"), 0);
        assert_eq!(held_of(&h.state()), Some(held("19.0.0", "untested-major")));
        h.set(|s| s.latest = "nightly-3f2a".into());
        h.advance(CHECK_INTERVAL_MS).await;
        assert_eq!(h.count("update"), 0);
        assert_eq!(
            held_of(&h.state()),
            Some(held("nightly-3f2a", "untested-major"))
        );
    });
}

#[test]
fn the_repair_pass_installs_no_newer_major_and_update_now_does() {
    // "the repair pass with the pref on installs no newer major"
    // "Update now installs a held major through whatever owns omp: a person's click is the ask"
    run(|| async {
        let h = off("18.22.2");
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.within = Some("18.22.2".into());
        });
        h.repair().await.unwrap();
        assert_eq!(h.count("update"), 0);
        assert_eq!(held_of(&h.state()), Some(held("19.0.0", "untested-major")));
        h.clear();
        h.set(|s| s.outcome = OmpUpdateOutcome::Updated("19.0.0".into()));
        h.update_now().await.unwrap();
        assert_eq!(
            h.calls(),
            [
                "fetch",
                "update 19.0.0",
                "release",
                "resume true",
                "toast 19.0.0"
            ]
        );
        assert_eq!(h.state()["held"], Value::Null);
    });
}

#[test]
fn a_click_during_the_tested_majors_lookup_installs_the_held_major() {
    // "a click that lands while a held pass still looks up the tested major's newest release installs the held major"
    run(|| async {
        let h = off("18.22.0");
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.within = Some("18.22.2".into());
            s.outcome = OmpUpdateOutcome::Updated("19.0.0".into());
        });
        let (open, gate) = oneshot::channel();
        *h.w.within_gate.borrow_mut() = Some(gate);
        h.start();
        h.advance(0).await;
        let clicked = h.update_now();
        open.send(()).unwrap();
        clicked.await.unwrap();
        assert_eq!(
            h.calls(),
            [
                "fetch",
                "within 18",
                "update 19.0.0",
                "release",
                "resume true",
                "toast 19.0.0"
            ],
            "the TypeScript case counts the lookup out of its list; it still ran"
        );
    });
}

#[test]
fn a_failed_lookup_of_the_tested_major_is_a_failed_check() {
    // "a failed lookup of the tested major's newest release is a failed check, and nothing installs"
    run(|| async {
        let h = off("18.22.0");
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.within_errors.push_back("bun pm view: 503".into());
        });
        h.start();
        h.advance(0).await;
        assert_eq!(h.count("update"), 0);
        let state = h.state();
        assert_eq!(held_of(&state), Some(held("19.0.0", "untested-major")));
        assert_eq!(
            state["failure"],
            json!({"reason": "check", "detail": "bun pm view: 503"})
        );
    });
}

#[test]
fn turning_the_list_on_and_off_between_checks() {
    // "turning the list on later holds what it has not verified at the next check, and off again drops the list"
    run(|| async {
        let h = off("18.22.2");
        h.set(|s| {
            s.latest = "18.23.0".into();
            s.verified = Some(vec![]);
            s.outcome = OmpUpdateOutcome::Failed(json!({"reason": "install", "detail": "EBUSY"}));
        });
        h.start();
        h.advance(0).await;
        assert_eq!(h.count("update"), 1);
        h.pref("ompFollowVerified", json!(true));
        h.pref_changed();
        h.advance(0).await;
        assert_eq!(h.count("update"), 1);
        let state = h.state();
        assert_eq!(
            (&state["verified"], held_of(&state)),
            (&json!([]), Some(held("18.23.0", "verifying")))
        );
        h.pref("ompFollowVerified", json!(false));
        h.pref_changed();
        h.advance(0).await;
        assert_eq!(h.count("update"), 2);
        assert!(h.state().get("verified").is_none());
    });
}

// ---- The hold notice (omp-hold-notice.test.ts) --------------------------------------------------------------------

fn since_ms() -> f64 {
    crate::care::date_parse("2026-11-20T00:00:00.000Z").unwrap() as f64
}

fn at(ms: f64) -> f64 {
    since_ms() + ms
}

fn hold(version: &str, reason: &'static str) -> Hold {
    Hold {
        version: version.into(),
        reason,
        since: Some("2026-11-20T00:00:00.000Z".into()),
    }
}

#[test]
fn a_failed_hold_is_told_once_then_after_a_day_then_never() {
    // "tells a hold once when first seen, once more after a day with the days, then never again"
    // "tells a hold first seen days late once, with its days, and sends no second notice"
    // "tells a newer held version afresh"
    let failed = hold("19.1.0", "failed");
    let h = 3_600_000.0;
    let (first, told) = hold::notice(Some(&failed), None, at(60_000.0));
    assert_eq!(
        first.as_ref().map(|n| (n.reason, n.days)),
        Some(("failed", 0.0))
    );
    assert_eq!(
        hold::notice(Some(&failed), told.clone(), at(RETELL_MS - 1.0)).0,
        None
    );
    let (second, told) = hold::notice(Some(&failed), told, at(RETELL_MS + h));
    assert_eq!(second.map(|n| n.days), Some(1.0));
    assert_eq!(
        hold::notice(Some(&failed), told, at(5.0 * RETELL_MS)).0,
        None
    );
    let (late, told) = hold::notice(Some(&failed), None, at(3.0 * RETELL_MS + 1.0));
    assert_eq!(late.map(|n| n.days), Some(3.0));
    assert_eq!(
        hold::notice(Some(&failed), told, at(4.0 * RETELL_MS)).0,
        None
    );
    let told = hold::notice(Some(&failed), None, at(0.0)).1;
    let next = hold::notice(Some(&hold("19.1.1", "failed")), told, at(1000.0)).0;
    assert_eq!(next.map(|n| n.version), Some("19.1.1".into()));
}

#[test]
fn a_verifying_hold_is_told_after_six_hours_then_every_day() {
    // "says nothing for 6 hours, then tells once with the hours, not again within 24 h, and again after them"
    // "stops once the version is verified or installed: no hold is said, whatever was told"
    let verifying = hold("19.2.0", "verifying");
    let h = 3_600_000.0;
    assert_eq!(
        hold::notice(Some(&verifying), None, at(VERIFYING_TELL_AFTER_MS - 1.0)),
        (None, None)
    );
    let (first, told) = hold::notice(Some(&verifying), None, at(VERIFYING_TELL_AFTER_MS));
    assert_eq!(first.map(|n| (n.hours, n.days)), Some((6.0, 0.0)));
    for later in [h, 4.0 * h, RETELL_MS - 1.0] {
        assert_eq!(
            hold::notice(
                Some(&verifying),
                told.clone(),
                at(VERIFYING_TELL_AFTER_MS + later)
            )
            .0,
            None
        );
    }
    let (again, told) = hold::notice(
        Some(&verifying),
        told,
        at(VERIFYING_TELL_AFTER_MS + RETELL_MS),
    );
    assert_eq!(again.map(|n| (n.hours, n.days)), Some((30.0, 1.0)));
    let third = hold::notice(
        Some(&verifying),
        told.clone(),
        at(VERIFYING_TELL_AFTER_MS + 2.0 * RETELL_MS),
    )
    .0;
    assert_eq!(third.map(|n| n.days), Some(2.0));
    assert_eq!(
        hold::notice(None, told.clone(), at(5.0 * RETELL_MS)),
        (None, told)
    );
}

#[test]
fn a_newer_release_starts_its_own_clock_and_never_a_hold_without_its_time() {
    // "a newer release starts its own clock, and the same release failing is told at once"
    // "never tells a hold without a first-seen time, or the default passes' major hold"
    let verifying = hold("19.2.0", "verifying");
    let told = hold::notice(Some(&verifying), None, at(VERIFYING_TELL_AFTER_MS)).1;
    let newer = Hold {
        since: Some(crate::care::iso_of(at(VERIFYING_TELL_AFTER_MS))),
        ..hold("19.2.1", "verifying")
    };
    assert_eq!(
        hold::notice(
            Some(&newer),
            told.clone(),
            at(VERIFYING_TELL_AFTER_MS + 3_600_000.0)
        )
        .0,
        None
    );
    let failing = hold::notice(
        Some(&hold("19.2.0", "failed")),
        told,
        at(VERIFYING_TELL_AFTER_MS + 3_600_000.0),
    )
    .0;
    assert_eq!(failing.map(|n| n.reason), Some("failed"));
    let unknown = Hold {
        since: None,
        ..verifying
    };
    assert_eq!(
        hold::notice(Some(&unknown), None, at(10.0 * RETELL_MS)).0,
        None
    );
    let major = Hold {
        since: None,
        ..hold("19.0.0", "untested-major")
    };
    assert_eq!(hold::notice(Some(&major), None, at(0.0)).0, None);
}

#[test]
fn reads_back_only_its_own_records() {
    // "reads back only a told record of its own shape"
    // "keeps the first time a version was seen held, and starts over for another version"
    let told = json!({"version": "19.1.0", "reason": "failed", "at": 5, "count": 1});
    assert_eq!(
        hold::parse_told(Some(&told)),
        Some(Told {
            version: "19.1.0".into(),
            reason: "failed".into(),
            at: 5.0,
            count: 1.0
        })
    );
    assert_eq!(hold::parse_told(Some(&told)).unwrap().to_value(), told);
    assert_eq!(
        hold::parse_told(Some(&json!({"version": "19.1.0", "retold": true}))),
        None
    );
    assert_eq!(
        hold::parse_told(Some(
            &json!({"version": "19.1.0", "reason": "untested-major", "at": 5, "count": 1})
        )),
        None
    );
    assert_eq!(hold::parse_told(Some(&json!("19.1.0"))), None);
    let start = since_ms() as u64;
    let (first, store) = hold::held_since(None, "19.2.0", start);
    assert_eq!(first, "2026-11-20T00:00:00.000Z");
    assert_eq!(store, Some(json!({"version": "19.2.0", "at": first})));
    assert_eq!(
        hold::held_since(store.as_ref(), "19.2.0", start + 9 * HOUR),
        (first.clone(), None)
    );
    let later = crate::care::iso_of((start + 9 * HOUR) as f64);
    assert_eq!(
        hold::held_since(store.as_ref(), "19.2.1", start + 9 * HOUR),
        (
            later.clone(),
            Some(json!({"version": "19.2.1", "at": later}))
        )
    );
    assert!(
        hold::held_since(
            Some(&json!({"version": "19.2.0", "at": "not a time"})),
            "19.2.0",
            start
        )
        .1
        .is_some()
    );
}

#[test]
fn a_failed_hold_a_pass_finds_is_told_once_through_main() {
    // index.ts's onState: `ompHoldTold` written before the notice, the `told` line, then the `notify` ask.
    run(|| async {
        let h = harness(Opt {
            installed: Some("18.22.2"),
            ..Opt::default()
        });
        h.set(|s| {
            s.latest = "19.0.0".into();
            s.verified = Some(vec![]);
            s.holding = Some(("19.0.0".into(), "2026-11-19T00:00:00.000Z".into()));
        });
        h.start();
        h.advance(0).await;
        let notices: Vec<Value> =
            h.w.items
                .borrow()
                .iter()
                .filter(|item| item["k"] == "ask" && item["q"] == "notify")
                .map(|item| item["payload"].clone())
                .collect();
        assert_eq!(
            notices,
            [
                json!({"kind": "ompHold", "params": {"version": "19.0.0", "reason": "failed", "hours": 24, "days": 1, "installed": "18.22.2"}})
            ]
        );
        assert_eq!(
            crate::prefs::get(&prefs_file(&h.dir), "ompHoldTold").unwrap(),
            Some(json!({"version": "19.0.0", "reason": "failed", "at": T0, "count": 2}))
        );
        assert!(
            h.logs()
                .iter()
                .any(|(step, details)| step == "told" && details["count"] == 2)
        );
    });
}

// ---- OmpAutoTakeover (omp-auto-takeover.test.ts) ------------------------------------------------------------------

fn takeover_world(
    initial: Option<bool>,
    enabled: bool,
) -> (Rc<tempfile::TempDir>, Rc<RefCell<Stock>>) {
    let stock = Rc::new(RefCell::new(Stock {
        value: initial,
        ..Stock::default()
    }));
    let dir = Rc::new(tempfile::tempdir().unwrap());
    let file = prefs_file(&dir);
    crate::prefs::set(&file, "ompFollowVerified", json!(enabled)).unwrap();
    (dir, stock)
}

fn launch(dir: &Rc<tempfile::TempDir>, stock: &Rc<RefCell<Stock>>, enabled: bool) -> H {
    harness_in(
        Opt {
            follow: enabled,
            ..Opt::default()
        },
        Rc::clone(dir),
        Rc::clone(stock),
    )
}

async fn sync(h: &H) {
    takeover::sync(&h.tools);
    h.settle().await;
}

fn takeover_steps(h: &H) -> Vec<String> {
    h.logs()
        .into_iter()
        .map(|(step, _)| step)
        .filter(|step| step.starts_with("stock-auto"))
        .collect()
}

#[test]
fn takes_an_on_value_once_and_gives_it_back_when_the_switch_goes_off() {
    // "round trip: takes an on value once, records it, and gives it back when the switch goes off"
    run(|| async {
        let (dir, stock) = takeover_world(Some(true), true);
        let h = launch(&dir, &stock, true);
        sync(&h).await;
        assert_eq!(
            (stock.borrow().value, stock.borrow().writes.clone()),
            (Some(false), vec![false])
        );
        assert_eq!(h.state()["stockAutoTaken"], true);
        let file = dir.path().join("omp-auto-takeover.json");
        let at = crate::care::iso_of(T0 as f64);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            format!(
                "{{\n\t\"record\": {{\n\t\t\"state\": \"taken\",\n\t\t\"before\": true,\n\t\t\"wrote\": false,\n\t\t\"at\": \"{at}\",\n\t\t\"by\": \"OMPdesk {APP}\"\n\t}}\n}}\n"
            )
        );
        // A relaunch reads the record and takes nothing twice.
        let relaunched = launch(&dir, &stock, true);
        sync(&relaunched).await;
        assert_eq!(stock.borrow().writes, [false]);
        relaunched.pref("ompFollowVerified", json!(false));
        sync(&relaunched).await;
        assert_eq!(
            (stock.borrow().value, stock.borrow().writes.clone()),
            (Some(true), vec![false, true])
        );
        assert_eq!(relaunched.state()["stockAutoTaken"], false);
        assert_eq!(takeover_steps(&h), ["stock-auto-taken"]);
        assert_eq!(takeover_steps(&relaunched), ["stock-auto-given-back"]);
        assert_eq!(
            relaunched.logs().last().unwrap().1,
            json!({"key": "update.auto", "value": true, "taken": at})
        );
    });
}

#[test]
fn a_persons_change_in_between_wins() {
    // "a person's change in between wins: nothing is written over it while the switch stays on, nor when it goes off"
    run(|| async {
        let (dir, stock) = takeover_world(Some(true), true);
        let h = launch(&dir, &stock, true);
        sync(&h).await;
        stock.borrow_mut().value = Some(true);
        sync(&h).await;
        assert_eq!(stock.borrow().writes, [false]);
        assert_eq!(h.state()["stockAutoTaken"], false);
        sync(&launch(&dir, &stock, true)).await;
        h.pref("ompFollowVerified", json!(false));
        sync(&h).await;
        assert_eq!(
            (stock.borrow().value, stock.borrow().writes.clone()),
            (Some(true), vec![false])
        );
        assert_eq!(
            takeover_steps(&h),
            ["stock-auto-taken", "stock-auto-let-go"]
        );
        // Turning the switch on again later is a fresh start.
        h.pref("ompFollowVerified", json!(true));
        sync(&h).await;
        assert_eq!(
            (stock.borrow().value, stock.borrow().writes.clone()),
            (Some(false), vec![false, false])
        );
    });
}

#[test]
fn leaves_an_off_value_or_no_config_alone() {
    // "leaves a value that was off already alone, both ways, and records nothing"
    // "leaves a computer with no config file alone (stock's default is off)"
    run(|| async {
        let (dir, stock) = takeover_world(Some(false), true);
        let h = launch(&dir, &stock, true);
        sync(&h).await;
        h.pref("ompFollowVerified", json!(false));
        sync(&h).await;
        assert!(stock.borrow().writes.is_empty());
        assert_eq!(h.state()["stockAutoTaken"], false);
        assert!(takeover_steps(&h).is_empty());
        let (dir, stock) = takeover_world(None, true);
        sync(&launch(&dir, &stock, true)).await;
        assert_eq!(
            (stock.borrow().value, stock.borrow().writes.is_empty()),
            (None, true)
        );
    });
}

#[test]
fn an_ompdesk_that_does_not_follow_never_reads_stocks_config() {
    // "an OMPdesk that does not follow the verified list neither reads nor writes stock's config, launch after launch"
    run(|| async {
        let (dir, stock) = takeover_world(Some(true), false);
        let first = launch(&dir, &stock, false);
        sync(&first).await;
        sync(&launch(&dir, &stock, false)).await;
        assert_eq!(
            (stock.borrow().reads, stock.borrow().writes.is_empty()),
            (0, true)
        );
        assert!(takeover_steps(&first).is_empty());
        // Nor does the launch's start in a launch that does not update omp on its own.
        let h = harness_in(
            Opt {
                scheduled: false,
                ..Opt::default()
            },
            Rc::clone(&dir),
            Rc::clone(&stock),
        );
        h.start();
        h.settle().await;
        assert_eq!(stock.borrow().reads, 0);
    });
}

#[test]
fn does_nothing_while_stock_cannot_say_and_logs_a_refused_write() {
    // "does nothing while stock cannot say its value, and logs a write stock refused"
    assert_eq!(takeover::step(true, None, None), Step::None);
    assert_eq!(
        takeover::step(
            false,
            Some(false),
            Some(&Record::Left {
                current: false,
                at: String::new(),
                by: String::new()
            })
        ),
        Step::Forget
    );
    run(|| async {
        let (dir, stock) = takeover_world(Some(true), true);
        stock.borrow_mut().refuse = Some("OMP_UPDATE_AUTO".into());
        let h = launch(&dir, &stock, true);
        sync(&h).await;
        assert_eq!(h.state()["stockAutoTaken"], false);
        assert_eq!(
            h.logs().last().unwrap(),
            &(
                "stock-auto-failed".into(),
                json!({"key": "update.auto", "step": "take", "detail": "written, but OMP_UPDATE_AUTO overrides it"})
            )
        );
    });
}

#[test]
fn the_launch_and_a_pref_change_settle_stocks_value_in_a_launch_that_updates_omp() {
    // index.ts: `stockAuto.sync()` after setup's first pass and on either pref's change, only when omp updates are
    // scheduled.
    run(|| async {
        let (dir, stock) = takeover_world(Some(true), true);
        let h = launch(&dir, &stock, true);
        h.start();
        h.advance(0).await;
        assert_eq!(stock.borrow().writes, [false]);
        h.pref("toolsAutoUpdate", json!(false));
        h.pref_changed();
        h.settle().await;
        assert_eq!(stock.borrow().writes, [false, true]);
    });
}

// ---- OmpCompatSource (omp-compat-source.test.ts) ------------------------------------------------------------------

fn list() -> Value {
    json!({"0.135.0": {"verified": ["19.0.0"], "holding": null}})
}

fn replies(h: &H, replies: Vec<Fetched>) {
    *h.w.compat_replies.borrow_mut() = Some(replies.into());
}

async fn read(h: &H) -> Option<Value> {
    compat::read(&h.tools).await.map(Value::Object)
}

#[test]
fn reads_the_list_at_most_every_fifteen_minutes() {
    // "reads at most every 15 minutes"
    run(|| async {
        let h = harness(Opt::default());
        replies(&h, vec![Fetched::Body(list().to_string().into_bytes())]);
        assert_eq!(read(&h).await, Some(list()));
        h.advance(14 * 60_000).await;
        read(&h).await;
        assert_eq!(h.w.compat_reads.get(), 1);
        h.advance(60_000).await;
        read(&h).await;
        assert_eq!(h.w.compat_reads.get(), 2);
    });
}

#[test]
fn keeps_the_last_good_list_through_a_refused_shape_and_an_outage() {
    // "keeps the last good list through a failed read, a refused shape and an outage"
    // "reads no list yet as nothing verified"
    run(|| async {
        let h = harness(Opt::default());
        replies(
            &h,
            vec![
                Fetched::Body(list().to_string().into_bytes()),
                Fetched::Body(br#"{"0.135.0":{"verified":["^20.0.0"],"holding":null}}"#.to_vec()),
                Fetched::Failed,
                Fetched::Failed,
            ],
        );
        read(&h).await;
        for _ in 1..=3 {
            h.advance(15 * 60_000).await;
            assert_eq!(read(&h).await, Some(list()));
        }
        let h = harness(Opt::default());
        replies(&h, vec![Fetched::Missing]);
        assert_eq!(read(&h).await, Some(json!({})));
    });
}

#[test]
fn a_launch_without_network_follows_what_an_earlier_launch_read() {
    // "a launch without network follows what an earlier launch read, and nothing before any read"
    run(|| async {
        let dir = Rc::new(tempfile::tempdir().unwrap());
        let file = dir.path().join("omp-compat.json");
        let at = |replies_: Vec<Fetched>| {
            let h = harness_in(Opt::default(), Rc::clone(&dir), Rc::default());
            replies(&h, replies_);
            h
        };
        assert_eq!(read(&at(vec![Fetched::Failed])).await, None);
        let text = format!("{}\r\n", serde_json::to_string_pretty(&list()).unwrap());
        read(&at(vec![Fetched::Body(text.clone().into_bytes())])).await;
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
        let restart = at(vec![Fetched::Failed, Fetched::Missing]);
        assert_eq!(read(&restart).await, Some(list()));
        // The offline read does not start a freshness window.
        assert_eq!(read(&restart).await, Some(json!({})));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{}\n");
        // A kept copy that was tampered with is not used.
        std::fs::write(
            &file,
            r#"{"0.135.0":{"verified":["latest"],"holding":null}}"#,
        )
        .unwrap();
        assert_eq!(read(&at(vec![Fetched::Failed])).await, None);
    });
}

#[test]
fn keeps_the_exact_last_good_bytes_after_invalid_utf8() {
    // "stops reading oversized network bodies and keeps the exact last good bytes after invalid UTF-8" (the size bound
    // is the fetch's: `fetch_from_bounds_the_body_and_reads_a_missing_branch_as_empty`)
    run(|| async {
        let h = harness(Opt::default());
        let mut good = "\u{feff}".as_bytes().to_vec();
        good.extend(format!("{}\r\n", list()).into_bytes());
        let mut malformed = br#"{"0.135.0":""#.to_vec();
        malformed.push(0xff);
        malformed.extend(br#"","0.135.0":{"verified":[],"holding":null}}"#);
        replies(
            &h,
            vec![Fetched::Body(good.clone()), Fetched::Body(malformed)],
        );
        assert_eq!(read(&h).await, Some(list()));
        h.advance(15 * 60_000).await;
        assert_eq!(read(&h).await, Some(list()));
        assert_eq!(
            std::fs::read(h.dir.path().join("omp-compat.json")).unwrap(),
            good
        );
    });
}

#[test]
fn a_test_launch_reads_the_list_from_its_file_and_never_the_network() {
    // index.ts: `OMP_GUI_TEST_OMP_COMPAT` (an unpacked app) or a test installer: the file, else no list (404).
    run(|| async {
        let h = harness(Opt::default());
        let file = h.dir.path().join("compat-fixture.json");
        let tools = |compat: Option<&std::path::Path>, installer: Option<&str>| {
            let mut opts: super::super::Opts = serde_json::from_value(json!({
                "platform": "win32", "arch": "x64", "toolsDir": "C:\\tools", "userData": h.dir.path().to_string_lossy(),
                "appVersion": APP, "testedOmp": TESTED, "automatic": false, "scheduled": {"omp": false, "cli": false, "ext": false},
            }))
            .unwrap();
            opts.test_omp_compat = compat.map(|file| file.to_string_lossy().into_owned());
            opts.test_installer = installer.map(str::to_owned);
            Tools::new(
                opts,
                h.w.clone(),
                spawn_local,
                Supervisor::this_binary(),
                STEP_MAX_MS,
            )
        };
        assert_eq!(
            compat::fetch(&tools(Some(&file), None)).await,
            Fetched::Missing
        );
        assert_eq!(
            compat::fetch(&tools(None, Some("/fake/installer"))).await,
            Fetched::Missing
        );
        std::fs::write(&file, list().to_string()).unwrap();
        assert_eq!(
            compat::fetch(&tools(Some(&file), None)).await,
            Fetched::Body(list().to_string().into_bytes())
        );
    });
}

#[test]
fn fetch_from_bounds_the_body_and_reads_a_missing_branch_as_empty() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    run(|| async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::task::spawn_local(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut request = vec![0; 4096];
                let read = socket.read(&mut request).await.unwrap_or(0);
                let path = String::from_utf8_lossy(&request[..read])
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("")
                    .to_owned();
                let (status, body) = match path.as_str() {
                    "/list" => ("200 OK", list().to_string().into_bytes()),
                    "/large" => ("200 OK", vec![b' '; crate::setup::compat::MAX_BYTES + 1]),
                    "/missing" => ("404 Not Found", b"404: Not Found".to_vec()),
                    _ => ("502 Bad Gateway", b"bad gateway".to_vec()),
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(&body).await;
            }
        });
        let at = |path: &str| format!("http://{address}{path}");
        assert_eq!(
            compat::fetch_from(&at("/list"), None).await,
            Fetched::Body(list().to_string().into_bytes())
        );
        assert_eq!(
            compat::fetch_from(&at("/missing"), None).await,
            Fetched::Missing
        );
        assert_eq!(
            compat::fetch_from(&at("/large"), None).await,
            Fetched::Failed
        );
        assert_eq!(
            compat::fetch_from(&at("/down"), None).await,
            Fetched::Failed
        );
    });
}

// ---- The verified list's reader (src/shared/omp-compat.test.ts, through the shared vectors) ----------------------

#[test]
fn reads_the_list_as_the_typescript_reader_does() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../../../../src/shared/omp-compat-vectors.json"
    ))
    .unwrap();
    for case in vectors["refused"].as_array().unwrap() {
        assert_eq!(
            compat::parse(case[1].as_str().unwrap()),
            None,
            "{}",
            case[0]
        );
    }
    for case in vectors["read"].as_array().unwrap() {
        let list = compat::parse(case["text"].as_str().unwrap()).expect("a good list");
        let entry = compat::entry_of(&list, case["app"].as_str().unwrap());
        let holding = entry
            .holding
            .map(|holding| json!({"version": holding.version, "since": holding.since}));
        assert_eq!(
            json!({"verified": entry.verified, "holding": holding}),
            case["entry"],
            "{}",
            case["text"]
        );
    }
    for case in vectors["follow"].as_array().unwrap() {
        let verified: Vec<String> = serde_json::from_value(case["verified"].clone()).unwrap();
        let s = |key: &str| case[key].as_str().unwrap();
        assert_eq!(
            json!(compat::follow_target(
                s("installed"),
                s("latest"),
                s("tested"),
                &verified
            )),
            case["target"],
            "{case}"
        );
    }
}
