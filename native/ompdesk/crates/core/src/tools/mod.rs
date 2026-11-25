//! Machine setup and the tool updaters as one owner (slice G, T2; `docs/rust-node-removal.md` › "Design: slice G"):
//! hub kind `tools`, one instance per main connection. Setup's installs, the omp, tool CLI and extension updaters'
//! passes and their schedule share one queue (`queue.rs`) and one clock (`clock.rs`) on the hub thread, so whatever
//! one part reads of another (the extension updater's "omp is installing", the omp updater's installed omp) is read
//! in the same tick it is decided, as it was in main's one thread. Main keeps the typed IPC forwards, relays what the
//! instance tells it and answers its questions (`src/main/tools/client.ts`).
//!
//! Each part is a file of its own, the unit that ports it: `setup.rs` (T2.2, `src/main/setup/service.ts`), `omp.rs`
//! (T2.3, `omp-updater.ts` with the takeover, the compat source and the hold notice), `cli.rs` (T2.4,
//! `cli-tools/`), `ext.rs` (T2.5, `ext-update/`). This file holds what they share; T2.1 built it with each part's
//! default state and its calls queuing a step whose work is the unit's to write ([`unported`]).
//!
//! **Open** `opts` ([`Opts`]): `platform` (`SetupPlatform`), `arch`, `toolsDir`, `userData`, `appVersion`, `testedOmp`,
//! `automatic` (setup installs on its own), `scheduled {omp, cli, ext}` (each updater checks on a timer),
//! `testInstaller`, `testDownload {url, sha256}`, `manual` (main's timers, below) and `now` (main's `Date.now()`).
//! A part adds the opts it needs (setup: `systemRoot`, `agentDesktopBundle`, `bunInstall`, a test's `mirror`).
//! The extension updater adds `locale` (`new Intl.Collator().resolvedOptions().locale`: its rows sort by name as
//! main's `localeCompare` sorted them).
//!
//! **Calls** answered at once from memory (main waits for them):
//! - `state` → `{setup, omp, cli, ext}`: `SetupState`, `OmpUpdateState`, `CliUpdateState`, `ExtensionUpdateState`
//!   (`src/shared/`), each as main's `state()` gave it;
//! - `start` → bool: the launch: setup's first pass runs (detection, the required installs, after `firstTab` the
//!   optional ones), then each scheduled updater ticks and goes on on its timer. False when it had started already or
//!   the instance closed;
//! - `close`: the quit; the running step is dropped and what it started ends, queued steps never run, nothing new is
//!   queued (replaces the quit steps omp updater → CLI → extensions → setup);
//! - `fire {timer, now}` → bool: main's timer `timer` fired (a `manual` instance);
//! - `setup.cancel` → bool: the person's Cancel ends the running step's installer or download (`cancelled`) and its
//!   pipeline; false when nothing ran.
//!
//! **Calls answered later** (`Outcome::Later`; main does not wait): each validates its key against what the part
//! holds now and fails at once, as the IPC handler threw, else queues one step and answers when that step ended:
//! `setup.retry {item}`, `setup.installForConnection {item}` (answers the item's `SetupItemState`), `setup.gitAslr
//! {action}` (answers `GitAslrResult`, a stopped step's fault as `{ok: false}`), `omp.now` (joins a pass that runs or
//! waits: one pass, one answer; main reads `state` right after posting it, and the hub runs the call first, so the
//! state already shows the pass), `cli.now {id?}`, `ext.now {key?}`. A step that ended by its bound or the close
//! answers its fault (`step_stalled`, `tools_closed`); the part turns that into its own outcome (`skipped`, `failed`).
//! The extension updater's `ext.rescan` (lists again, answered when listed) and `ext.prefChanged` (answered at once;
//! `toolsAutoUpdate` changed: a started, scheduled instance checks at once when it is on) take no key.
//!
//! **Items** to main (`k`): `state {part, state}` once per change of a part (`setup`, `omp`, `cli`, `ext`; main sends
//! it to the windows and paired devices); `log {source, message, details}` (main writes `gui-runtime.jsonl`: `setup`,
//! `omp-update`, `omp-start-input`); `stalled {chain, label, ms}` (main writes the `chain-stall` line, the chain as the
//! TypeScript named it: `machine setup` for installs and detection, `update scheduler` for passes); and on a
//! `manual` instance `timer {timer, ms}` / `clearTimer {timer}`.
//!
//! **Questions** to main ([`Main::ask`], answered later): `env` → main's spawn environment (`process.env` with the
//! login shell's, [`Tools::spawn_env`] adds the proxy); `refreshPath` (main's PATH and login-shell cache after an
//! install); `ompResolution {fresh}` (main's omp resolution, resolved again when `fresh`); `ompReady` (omp became
//! usable: main restarts the tabs that failed for lack of it, the stats server); `firstTab` (answers once the first
//! tab is ready or 30 s passed; setup's optional installs wait for it); `releaseHelpers` (main stops the stats server
//! and the stock helper before omp is replaced); `resume {updated}` (and starts them again; the tabs restart on a new
//! omp); `applyExtensionUpdate {plan}` (main applies it to its own and its hosted tabs); `notify {kind, params}` (an
//! OS notification, text from main's table); `stock {method, params, timeoutMs}` (a stock worker request:
//! `stock::request_in_process` needs main's stdio `Events` to start a worker, which a hub instance does not hold).
//! Main restarts the local tabs waiting for omp itself, on the `state {part: "setup"}` that says omp is usable.
//! The extension updater asks `workspaceDirs` (the working folders of main's open local and hosted tabs: where
//! project-scoped plugins and skills live).
//!
//! **Preferences** are read in process from `<userData>/prefs.json` ([`Tools::pref`]): `toolsAutoUpdate`,
//! `ompFollowVerified`, `ompHeldSeen`, `ompHoldTold`, `proxyUrl`.
//!
//! **Timing.** One step at a time in the order asked, each bound by 30 min ([`queue::STEP_MAX_MS`]); a CLI pass and
//! an extension pass no longer overlap, and an omp pass is bound like the others (the named timing difference of the
//! ledger). An install an updater pass needs runs inline in that pass's step ([`queue::Ctx`]). The hub thread also
//! answers main's synchronous calls within 2 s, so every process start and every PATH or tool-install lookup runs on
//! the blocking pool ([`spawn::off_hub`]): a PATH entry on an unreachable share or a slow process start costs a step
//! time, never the hub its deadline.
//!
//! **The omp part** (T2.3, `omp/`) adds: opt `testOmpCompat` (the file `OMP_GUI_TEST_OMP_COMPAT` names, an unpacked
//! app only); calls `omp.repair` (BridgeHealth: setup's retry of omp while setup holds omp missing or broken, else the
//! repair pass) and `omp.prefChanged` (`toolsAutoUpdate` or `ompFollowVerified` changed); item `ompUpdated {version}`
//! (main's one "omp updated" toast); it writes the prefs `ompHeldSeen` and `ompHoldTold` and asks `notify {kind:
//! "ompHold", params}`.

mod cli;
mod clock;
mod ext;
mod omp;
mod queue;
mod runner;
mod setup;
mod spawn;
#[cfg(test)]
mod tests;

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::rc::{Rc, Weak};

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use tokio::sync::{Notify, watch};

use crate::hub::{self, Kind, LocalFuture, Out, Outcome, params};
use crate::server::Fault;
use clock::Clock;
use queue::{Answer, Ctx, Queue, Step, StepKind};
use runner::{Runner, Supervisor};

pub const KIND: Kind = Kind {
    name: "tools",
    open,
    call,
    close,
};

/// Between scheduled checks while all is well (`CHECK_INTERVAL_MS`).
pub const CHECK_INTERVAL_MS: u64 = 4 * 60 * 60 * 1000;
/// The longest wait after failures in a row (`MAX_CHECK_INTERVAL_MS`).
pub const MAX_CHECK_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;

/// The wait before the next scheduled check after `failures` failed ones in a row (`nextCheckDelay`).
pub fn next_check_delay(failures: u32) -> u64 {
    (CHECK_INTERVAL_MS << failures.min(8)).min(MAX_CHECK_INTERVAL_MS)
}

/// One row's failures in a row and the earliest time a scheduled pass checks it again (`Backoff`; 0 = due).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Backoff {
    pub failures: u32,
    pub next_at: u64,
}

impl Backoff {
    /// How a check ended (`settleBackoff`): a failure pushes the next scheduled check out, anything else clears it.
    pub fn settle(&mut self, failed: bool, now: u64) {
        self.failures = if failed { self.failures + 1 } else { 0 };
        self.next_at = if failed {
            now + next_check_delay(self.failures)
        } else {
            0
        };
    }
}

#[derive(Deserialize, Clone, Copy)]
pub struct Scheduled {
    pub omp: bool,
    pub cli: bool,
    pub ext: bool,
}

#[derive(Deserialize, Clone)]
pub struct TestDownload {
    pub url: String,
    pub sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Opts {
    pub platform: String,
    pub arch: String,
    pub tools_dir: String,
    pub user_data: String,
    pub app_version: String,
    /// `TESTED_OMP_VERSION` (`src/shared/omp-tested.json`): the omp this release was tested with. An opt, not an
    /// `include_str!`: the native build's fingerprint holds only `native/ompdesk`. Missing, the default passes hold
    /// every newer omp.
    #[serde(default)]
    pub tested_omp: String,
    pub automatic: bool,
    pub scheduled: Scheduled,
    #[serde(default)]
    pub test_installer: Option<String>,
    #[serde(default)]
    pub test_download: Option<TestDownload>,
    #[serde(default)]
    pub test_omp_compat: Option<String>,
    #[serde(default)]
    pub manual: bool,
    #[serde(default)]
    pub now: Option<u64>,
    /// Setup's: `%SystemRoot%` (Windows PowerShell's folder), the agent-desktop the app ships, Bun's root
    /// (`BUN_INSTALL` or `~/.bun`), and a test's server on 127.0.0.1 for every lookup and download.
    #[serde(default = "system_root")]
    pub system_root: String,
    #[serde(default)]
    pub agent_desktop_bundle: Option<String>,
    #[serde(default)]
    pub bun_install: String,
    #[serde(default)]
    pub mirror: Option<String>,
    #[serde(default)]
    pub locale: String,
    /// Main's `process.cwd()` and its per-drive directories (`=X:` of its environment, Windows): what a relative
    /// launcher or PATH entry is resolved against, as main resolved it ([`spawn::Base`]).
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub drive_cwds: BTreeMap<String, String>,
}

fn system_root() -> String {
    "C:\\Windows".to_owned()
}

/// What the instance tells main and asks of it: the hub's `Out`, or a test's stand-in.
pub trait Main {
    fn push(&self, item: Value);
    fn ask(&self, q: &str, payload: Value) -> LocalFuture<Result<Value, Fault>>;
}

impl Main for Out {
    fn push(&self, item: Value) {
        Out::push(*self, &item);
    }

    fn ask(&self, q: &str, payload: Value) -> LocalFuture<Result<Value, Fault>> {
        self.ask_later(q, &payload)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Updater {
    Omp,
    Cli,
    Ext,
}

pub struct Tools {
    pub opts: Opts,
    main: Rc<dyn Main>,
    spawn: fn(LocalFuture<()>),
    pub clock: Rc<Clock>,
    pub queue: Rc<Queue>,
    pub runner: Runner,
    pub setup: RefCell<setup::Part>,
    pub omp: RefCell<omp::Part>,
    pub cli: RefCell<cli::Part>,
    pub ext: RefCell<ext::Part>,
    started: Cell<bool>,
    closed: watch::Sender<bool>,
    /// Wakes an updater's timer to tick now and count its next wait from that tick (a pref turned on).
    rearm: [Rc<Notify>; 3],
}

/// The step work a unit has not written yet: it does nothing and answers null.
pub fn unported(_: Ctx) -> LocalFuture<Answer> {
    Box::pin(async { Ok(Value::Null) })
}

impl Tools {
    /// An instance over `main`; `spawn` runs its tasks (the hub's `spawn`, a test's `spawn_local`), the queue's worker
    /// first. Its steps are bound by `bound_ms`.
    pub fn new(
        opts: Opts,
        main: Rc<dyn Main>,
        spawn: fn(LocalFuture<()>),
        supervisor: Supervisor,
        bound_ms: u64,
    ) -> Rc<Tools> {
        let clock = Rc::new(if opts.manual {
            let main = Rc::clone(&main);
            Clock::manual(opts.now.unwrap_or(0), Box::new(move |item| main.push(item)))
        } else {
            Clock::system()
        });
        let queue = Queue::new(Rc::clone(&clock), bound_ms, {
            let main = Rc::clone(&main);
            move |chain, label, ms| {
                main.push(json!({"k": "stalled", "chain": chain, "label": label, "ms": ms}));
            }
        });
        let tools = Rc::new(Tools {
            setup: RefCell::new(setup::Part::new(&opts)),
            omp: RefCell::new(omp::Part::default()),
            cli: RefCell::new(cli::Part::default()),
            ext: RefCell::new(ext::Part::default()),
            opts,
            main,
            spawn,
            clock,
            queue: Rc::clone(&queue),
            runner: Runner::new(supervisor),
            started: Cell::new(false),
            closed: watch::Sender::new(false),
            rearm: Default::default(),
        });
        tools.spawn_task(queue.run());
        tools
    }

    /// Runs `task` until it ends or the instance closes.
    fn spawn_task(&self, task: impl Future<Output = ()> + 'static) {
        let mut closed = self.closed.subscribe();
        (self.spawn)(Box::pin(async move {
            tokio::select! {
                () = task => {}
                _ = closed.wait_for(|closed| *closed) => {}
            }
        }));
    }

    pub fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// The launch began (`start` ran; setup's first pass may still run).
    pub fn is_started(&self) -> bool {
        self.started.get()
    }

    pub fn state(&self) -> Value {
        json!({
            "setup": setup::state(self),
            "omp": omp::state(self),
            "cli": cli::state(self),
            "ext": ext::state(self),
        })
    }

    /// Tells main a part changed: `part` is `setup`, `omp`, `cli` or `ext`.
    pub fn changed(&self, part: &str) {
        let state = match part {
            "setup" => setup::state(self),
            "omp" => omp::state(self),
            "cli" => cli::state(self),
            _ => ext::state(self),
        };
        self.main
            .push(json!({"k": "state", "part": part, "state": state}));
    }

    /// One `gui-runtime.jsonl` line, written by main.
    pub fn log(&self, source: &str, message: &str, details: Value) {
        self.main
            .push(json!({"k": "log", "source": source, "message": message, "details": details}));
    }

    /// Asks main `q` (the list in this file's header).
    pub fn ask(&self, q: &str, payload: Value) -> LocalFuture<Result<Value, Fault>> {
        self.main.ask(q, payload)
    }

    /// A preference of `<userData>/prefs.json`, read in process; none when unset or unreadable.
    pub fn pref(&self, key: &str) -> Option<Value> {
        let file = Path::new(&self.opts.user_data).join("prefs.json");
        crate::prefs::get(&file.to_string_lossy(), key)
            .ok()
            .flatten()
    }

    /// "Keep tools up to date" (`toolsAutoUpdate`): only a stored `false` turns it off.
    pub fn auto_update(&self) -> bool {
        self.pref("toolsAutoUpdate") != Some(Value::Bool(false))
    }

    /// Main's spawn environment (`env`), without the proxy.
    pub async fn base_env(&self) -> Result<BTreeMap<String, String>, Fault> {
        let base = self.ask("env", json!({})).await?;
        serde_json::from_value(base).map_err(|error| Fault::new("tools_env", error.to_string()))
    }

    /// The environment an install or a check runs with: main's (`env`) plus the proxy the core picks
    /// (`resolveProxyEnvForSpawn`); a late system lookup is logged as main logged it.
    pub async fn spawn_env(&self) -> Result<BTreeMap<String, String>, Fault> {
        let mut env = self.base_env().await?;
        for (name, value) in self.proxy().await.env {
            if let Value::String(value) = value {
                env.insert(name, value);
            }
        }
        Ok(env)
    }

    /// The proxy the core picks (`proxy.resolve`): for a spawn's environment, and as `http::Request.proxy` for the
    /// core's own requests. A late system lookup is logged as main logged it.
    pub async fn proxy(&self) -> crate::proxy::Pick {
        let system = async {
            tokio::task::spawn_blocking(|| ompdesk_sysproxy::resolve(crate::proxy::PROBE_URL))
                .await
                .ok()
        };
        let pick = crate::proxy::pick(
            &self.pref("proxyUrl").unwrap_or(Value::Null),
            |name| std::env::var(name).ok(),
            system,
        )
        .await;
        if pick.late {
            self.log(
                "omp-start-input",
                "proxyEnv",
                json!({"ms": crate::proxy::LOOKUP_BOUND.as_millis(), "reason": "the system proxy lookup did not answer"}),
            );
        }
        pick
    }

    /// Queues `work` as one step of `kind`.
    pub fn enqueue(
        &self,
        label: &str,
        kind: StepKind,
        work: impl FnOnce(Ctx) -> LocalFuture<Answer> + 'static,
    ) -> Result<LocalFuture<Answer>, Fault> {
        self.queue.enqueue(Step {
            label: label.to_owned(),
            kind,
            work: Box::new(work),
        })
    }

    /// The launch: setup's first pass (detection, the required installs, after the first tab the optional ones), then
    /// each scheduled updater ticks and goes on on its timer. False when it had started already or the instance closed.
    pub fn start(self: &Rc<Self>) -> bool {
        if self.started.get() || self.is_closed() {
            return false;
        }
        self.started.set(true);
        let tools = Rc::downgrade(self);
        self.spawn_task(async move {
            let Some(first) = tools.upgrade() else { return };
            setup::start(&first).await;
            let scheduled = first.opts.scheduled;
            for (updater, on) in [
                (Updater::Omp, scheduled.omp),
                (Updater::Cli, scheduled.cli),
                (Updater::Ext, scheduled.ext),
            ] {
                if on {
                    first.spawn_task(schedule(Rc::downgrade(&first), updater));
                }
            }
            if !scheduled.cli {
                // A launch that does not check on a timer still lists the tool CLIs (`CliUpdater.start`).
                cli::start(&first);
            }
            // A launch that does not schedule lists the extensions once, checking nothing.
            if !scheduled.ext {
                let _ = ext::rescan(&first);
            }
            omp::started(&first);
        });
        true
    }

    /// `updater`'s timer ticks now and waits its delay from that tick; nothing when no timer waits (before the start,
    /// while its pass runs, in a launch that does not schedule).
    fn rearm(&self, updater: Updater) {
        self.rearm[updater as usize].notify_waiters();
    }

    /// One scheduled check of `updater`: its pass, queued.
    fn tick(self: &Rc<Self>, updater: Updater) -> Result<LocalFuture<Answer>, Fault> {
        match updater {
            Updater::Omp => omp::tick(self),
            Updater::Cli => cli::tick(self),
            Updater::Ext => ext::tick(self),
        }
    }

    /// The wait after a tick of `updater` ended: omp backs off by its own failures, the others by row.
    fn delay(&self, updater: Updater) -> u64 {
        match updater {
            Updater::Omp => next_check_delay(self.omp.borrow().failures),
            Updater::Cli | Updater::Ext => CHECK_INTERVAL_MS,
        }
    }

    pub fn close(&self) {
        if self.closed.send_replace(true) {
            return;
        }
        setup::closing(self);
        self.queue.close();
    }
}

/// An updater's timer: a tick at start, then one `delay` after each tick's pass ended, until the instance closes. A
/// pass that failed or was stopped does not end the schedule.
async fn schedule(tools: Weak<Tools>, updater: Updater) {
    loop {
        let Some(pass) = tools.upgrade().map(|tools| tools.tick(updater)) else {
            return;
        };
        let Ok(pass) = pass else { return };
        let _ = pass.await;
        let Some((clock, ms, rearm)) = tools.upgrade().map(|tools| {
            (
                Rc::clone(&tools.clock),
                tools.delay(updater),
                Rc::clone(&tools.rearm[updater as usize]),
            )
        }) else {
            return;
        };
        tokio::select! {
            () = clock.sleep(ms) => {}
            () = rearm.notified() => {}
        }
    }
}

thread_local! {
    static INSTANCES: RefCell<HashMap<u64, Rc<Tools>>> = RefCell::default();
}

fn open(id: u64, opts: &RawValue, out: Out) -> Result<(), Fault> {
    let opts: Opts = params(opts)?;
    if let Some(cwd) = &opts.cwd {
        spawn::set_base(spawn::Base {
            cwd: cwd.clone(),
            drives: opts.drive_cwds.clone(),
        });
    }
    let tools = Tools::new(
        opts,
        Rc::new(out),
        hub::spawn,
        Supervisor::this_binary(),
        queue::STEP_MAX_MS,
    );
    INSTANCES.with(|instances| instances.borrow_mut().insert(id, tools));
    Ok(())
}

fn close(id: u64) {
    let tools = INSTANCES.with(|instances| instances.borrow_mut().remove(&id));
    if let Some(tools) = tools {
        tools.close();
    }
}

#[derive(Deserialize)]
struct FireParams {
    timer: u64,
    #[serde(default)]
    now: Option<u64>,
}

fn call(id: u64, method: &str, args: &RawValue) -> Outcome {
    let Some(tools) = INSTANCES.with(|instances| instances.borrow().get(&id).cloned()) else {
        return Outcome::fault("closed", "The tools instance is not open");
    };
    call_tools(&tools, method, args)
}

/// Runs `method` of `tools` (the kind's `call`, and tests').
pub fn call_tools(tools: &Rc<Tools>, method: &str, args: &RawValue) -> Outcome {
    match method {
        "state" => Outcome::Now(Ok(tools.state())),
        "start" => Outcome::ok(&tools.start()),
        "close" => {
            tools.close();
            Outcome::done()
        }
        "fire" => match params::<FireParams>(args) {
            Ok(FireParams { timer, now }) => Outcome::ok(&tools.clock.fire(timer, now)),
            Err(fault) => Outcome::Now(Err(fault)),
        },
        _ => {
            let routed = match method.split_once('.') {
                Some(("setup", method)) => setup::call(tools, method, args),
                Some(("omp", method)) => omp::call(tools, method, args),
                Some(("cli", method)) => cli::call(tools, method, args),
                Some(("ext", method)) => ext::call(tools, method, args),
                _ => None,
            };
            routed.unwrap_or_else(|| Outcome::fault("no_method", method.to_owned()))
        }
    }
}

/// The answer of a queued step, or the fault that kept it from being queued.
fn queued(step: Result<LocalFuture<Answer>, Fault>) -> Outcome {
    match step {
        Ok(answer) => Outcome::Later(answer),
        Err(fault) => Outcome::Now(Err(fault)),
    }
}
