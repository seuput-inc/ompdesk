//! `ompdesk check`: a test suite or any check command, run so that it never repeats work it proved and never dies
//! with the app that started it.
//!
//! What is reused (`decide`), against the newest earlier run of the same command in the same folder whose files did
//! not change while it ran (the run reused from):
//! - Nothing changed since (every file by content, the environment, the tools, the runner's own files: `inputs`):
//!   its passes are reused and only what did not pass runs again, by test name where the runner can name one
//!   (Playwright `--test-list-invert`, Vitest `-t`, `cargo test -- --exact`) and by file otherwise (Vitest `--exclude`,
//!   Jest `--runTestsByPath`). Failed, flaky-failed and unknown results always run again; a plain command is reused
//!   only whole.
//! - Only test files changed (files the earlier run ran tests from, or new files named as they are): the tests of
//!   those files run, the other passes are reused. Runners' own change detection is not trusted: Playwright's
//!   `--only-changed` and Vitest's `related` follow the import graph of the test code, and a test can depend on code
//!   it never imports (a server, a built app, a file another process loads).
//! - Anything else changed (product code, a helper, configuration, a lockfile, the environment, a tool): everything
//!   runs. Unknown means full.
//!
//! Every result of the merged verdict (`verdict.txt`) says where it came from: the run, its commit, time and log, or
//! this run. A test that both passed and failed on the same inputs goes into quarantine (`flaky`).
//!
//! The command runs in a detached runner that journals every step, holds one of the computer's heavy slots while the
//! command runs (`--light` holds none), and starts the command with headless defaults; see `start` and `run_runner`.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::flaky::Book;
use crate::heavy::{self, now_ms};
use crate::inputs::{self, InputSet, StatCache};
use crate::runner::{self, Detected, Earlier, Kind, Record};
use crate::store::{self, Plan, Run, State, Store};
use crate::sys::child_command;
use crate::watch::gb;

/// Set for a check's command: a check started inside it runs as its child (no second runner, no second slot).
pub const RUN_ENV: &str = "OMPDESK_CHECK_RUN";
/// The tag OMPdesk gives everything a session's omp starts (`src/main/session-processes.ts`): who started a run.
const SESSION_ENV: &str = "OMP_GUI_SESSION_TAG";

/// Defaults that keep a check's browsers and reports off the person's screen; a variable already set is kept.
/// Playwright already starts Chromium and Electron headless with `--use-mock-keychain` unless a config asks for a
/// window; its HTML report opens a browser only outside CI.
const HEADLESS_ENV: &[(&str, &str)] = &[
    ("CI", "1"),
    ("PLAYWRIGHT_HTML_OPEN", "never"),
    ("PW_TEST_HTML_REPORT_OPEN", "never"),
    ("BROWSER", "none"),
];
/// Variables that would open a debugger window, removed.
const WINDOW_ENV: &[&str] = &["PWDEBUG"];
/// Statuses a later run may reuse.
const REUSABLE: &[&str] = &["passed", "flaky"];

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

pub fn checks_dir() -> PathBuf {
    store::store_dir(&env)
}

/// Allocated bytes of idle input payloads unlinked by disk care. A missing store stays missing.
pub fn prune_idle_inputs(dir: &Path, now: u64, cancelled: impl Fn() -> bool) -> u64 {
    Store {
        dir: dir.to_owned(),
    }
    .expire_inputs(now, &cancelled)
}

pub(crate) fn open_store() -> io::Result<Store> {
    Store::open(checks_dir())
}

/// The OMPdesk session this process runs in; none in a plain terminal.
pub(crate) fn session_tag() -> Option<String> {
    env(SESSION_ENV).filter(|tag| !tag.is_empty())
}

/// A session cancels only the runs it started; a person (a plain terminal, no session) cancels any.
fn may_cancel(owner: Option<&str>, caller: Option<&str>) -> bool {
    caller.is_none() || owner == caller
}

/// A result that fails a verdict.
pub(crate) fn failing(status: &str) -> bool {
    !matches!(status, "passed" | "skipped" | "unrun" | "flaky")
}

/// The check a command is: its checkout, its folder there, and its words.
pub fn key_of(root: &Path, cwd: &Path, argv: &[String]) -> String {
    let rel = cwd.strip_prefix(root).unwrap_or(cwd).to_string_lossy();
    let mut text = format!("{}\0{rel}\0", root.display());
    for a in argv {
        text.push_str(a);
        text.push('\0');
    }
    inputs::sha256_hex(text.as_bytes())[..16].to_string()
}

pub struct Start {
    pub argv: Vec<String>,
    pub full: bool,
    pub light: bool,
    pub release: bool,
}

/// Where a result came from.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Origin {
    pub run: String,
    pub head: Option<String>,
    pub started: u64,
    pub log: String,
}

/// One result of a merged verdict and where it came from.
type Merged<'a> = &'a (Record, Origin);

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Reused {
    #[serde(flatten)]
    record: Record,
    origin: Origin,
}

fn origin_of(store: &Store, run: &Run) -> Origin {
    Origin {
        run: run.id.clone(),
        head: run.head.clone(),
        started: run.started,
        log: store.file(&run.id, "log").display().to_string(),
    }
}

/// A run's merged results: what it reused and what it ran, the last per key. A test this run left out by name
/// (reported `skipped` by a filter) keeps the result it reused.
fn merged(store: &Store, run: &Run) -> Vec<(Record, Origin)> {
    let own = origin_of(store, run);
    let mut order: Vec<String> = Vec::new();
    let mut by_key: HashMap<String, (Record, Origin)> = HashMap::new();
    if let Ok(text) = fs::read_to_string(store.file(&run.id, "reused.jsonl")) {
        for line in text.lines() {
            if let Ok(r) = serde_json::from_str::<Reused>(line) {
                order.push(r.record.key.clone());
                by_key.insert(r.record.key.clone(), (r.record, r.origin));
            }
        }
    }
    let (records, _) = runner::read_results(&store.file(&run.id, "results.jsonl"));
    for r in records {
        match by_key.get(&r.key) {
            Some((_, o)) if r.status == "skipped" && o.run != own.run => continue,
            Some(_) => {}
            None => order.push(r.key.clone()),
        }
        by_key.insert(r.key.clone(), (r, own.clone()));
    }
    order
        .into_iter()
        .filter_map(|k| by_key.remove(&k))
        .collect()
}

/// The results people count: tests, errors outside tests, and a file's own record only when the file has no test
/// record (it did not load).
fn countable(records: &[(Record, Origin)]) -> Vec<&(Record, Origin)> {
    let with_cases: BTreeSet<(&str, &str, &str)> = records
        .iter()
        .filter(|(r, _)| !r.file_record)
        .map(|(r, _)| (r.runner.as_str(), r.project.as_str(), r.file.as_str()))
        .collect();
    records
        .iter()
        .filter(|(r, _)| {
            !r.file_record
                || !with_cases.contains(&(r.runner.as_str(), r.project.as_str(), r.file.as_str()))
        })
        .collect()
}

pub fn start(opts: Start) -> i32 {
    let store = match open_store() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("ompdesk check: cannot open the check store: {e}");
            return 1;
        }
    };
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let root = inputs::root_of(&cwd);
    let key = key_of(&root, &cwd, &opts.argv);

    let detected = runner::detect(&opts.argv, &cwd);
    let running = store
        .of_key(&key)
        .into_iter()
        .find(|r| matches!(r.state, State::Waiting | State::Running) && store.runner_alive(&r.id));
    if let Some(running) = running {
        // Follow it only when its results answer this request: the same inputs as now (an edit since it started
        // makes them stale) and the same kind of run (a `--full` or `--release` request is not answered by another).
        let now = input_set(
            &root,
            &cwd,
            &opts.argv,
            &command_env(),
            detected.kind,
            &store,
        );
        let same_inputs = now.is_ok_and(|set| running.inputs.as_ref() == Some(&set.digest()));
        if same_inputs && !opts.full && running.release == opts.release {
            eprintln!(
                "ompdesk check: run {} of this check is already under way on the same inputs (started {}); following \
                 it instead of starting another.",
                running.id,
                store::utc(running.started)
            );
            return attach_id(&store, &running.id);
        }
        eprintln!(
            "ompdesk check: run {} of this check is under way, but {}; starting another",
            running.id,
            if !same_inputs {
                "on other inputs (or still reading them)"
            } else if opts.full {
                "this run asks for a full run"
            } else {
                "it is not the same kind of run (release or not)"
            }
        );
    }

    let id = store::new_id(now_ms());
    let run = Run {
        id: id.clone(),
        key,
        root: root.display().to_string(),
        cwd: cwd.display().to_string(),
        argv: opts.argv.clone(),
        runner: detected.kind.name().into(),
        state: State::Starting,
        pid: 0,
        started: now_ms(),
        ended: None,
        milestones: Some(store::Milestones::default()),
        exit_code: None,
        head: None,
        dirty: false,
        inputs: None,
        changed_during: Vec::new(),
        plan: Plan {
            mode: if opts.full {
                "full".into()
            } else {
                String::new()
            },
            ..Plan::default()
        },
        reused: 0,
        ran: 0,
        failed: 0,
        quarantined_failed: 0,
        flaky: Vec::new(),
        saved_ms: 0,
        light: opts.light,
        release: opts.release,
        summary: None,
        session: session_tag(),
    };
    if let Err(e) = store.create(&run) {
        eprintln!("ompdesk check: cannot record the run: {e}");
        return 1;
    }
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("ompdesk check: {e}");
            return 1;
        }
    };
    let nested = env(RUN_ENV).is_some_and(|outer| store.runner_alive(&outer));
    let started = if nested {
        // Inside another check's command: a plain child, so cancelling the outer check ends this one too.
        child_command(&exe)
            .args(["check", "--runner", &id])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
    } else {
        // Through a middle process that exits at once, so the runner's parent is gone before anyone walks the
        // starter's process tree to end it.
        child_command(&exe)
            .args(["check", "--spawn", &id])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .status()
            .and_then(|s| {
                if s.success() {
                    Ok(())
                } else {
                    Err(io::Error::other(format!("the runner did not start ({s})")))
                }
            })
    };
    if let Err(e) = started {
        eprintln!("ompdesk check: cannot start the runner: {e}");
        let mut run = run;
        run.state = State::Error;
        run.ended = Some(now_ms());
        eprintln!("ompdesk check: {}", run.timing(now_ms()).report());
        let _ = store.write(&run);
        return 1;
    }
    eprintln!(
        "ompdesk check: run {id} ({}); it keeps running if this terminal or OMPdesk goes away: `ompdesk check attach {id}` follows it again",
        detected.kind.name()
    );
    attach_id(&store, &id)
}

/// The middle process: starts the runner detached, then exits.
pub fn spawn_runner(id: &str) -> i32 {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("ompdesk check: {e}");
            return 1;
        }
    };
    let args = vec!["check".to_string(), "--runner".to_string(), id.to_string()];
    #[cfg(unix)]
    let started = {
        let mut command = child_command(&exe);
        command
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::sys::child_defaults(&mut command, true);
        command.spawn().map(|_| ())
    };
    #[cfg(windows)]
    let started = start_on_windows(&exe, &args, id);
    match started {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("ompdesk check: cannot start the runner: {e}");
            1
        }
    }
}

/// Starts the runner on the checks desktop and watches it take over (its `alive` lock, or a journal past `starting`).
/// Never on the person's desktop: a desktop that cannot be made, or a runner that ends before it takes over (an
/// NTSTATUS such as 0xC0000142 when Windows cannot initialize a process there), fails the run with that evidence.
#[cfg(windows)]
fn start_on_windows(exe: &Path, args: &[String], id: &str) -> io::Result<()> {
    let store = open_store()?;
    let fail = |why: String| -> io::Result<()> {
        if let Some(mut run) = store.read(id) {
            run.state = State::Error;
            run.ended = Some(now_ms());
            run.summary = Some(format!("not started: {why}"));
            let _ = store.write(&run);
        }
        let _ = store.append(id, "log", &format!("ompdesk check: {why}"));
        Err(io::Error::other(why))
    };
    let Some(desktop) = crate::sys::check_desktop() else {
        return fail(format!(
            "the checks desktop could not be made ({}); the command does not start on the person's desktop",
            io::Error::last_os_error()
        ));
    };
    let runner = crate::sys::spawn_detached(exe, args, Some(&desktop))?;
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        if store.runner_alive(id) || store.read(id).is_some_and(|r| r.state != State::Starting) {
            return Ok(());
        }
        if let Some(code) = runner.exit_code() {
            return fail(format!(
                "the runner ended on the {desktop} desktop before it started (exit 0x{code:08X}); the command does not \
                 start on the person's desktop"
            ));
        }
        if Instant::now() >= until {
            // Still running, only slow: the foreground's attach waits for it.
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Follows a run's log to its end; the run's exit code.
fn attach_id(store: &Store, id: &str) -> i32 {
    attach_to(store, id, &mut io::stdout())
}

/// How long a finished run's runner may still hold `alive` (it is writing its last lines, or ending) before the
/// attached caller stops waiting for it.
const RUNNER_LINGER: Duration = Duration::from_secs(5);

/// `attach_id` into `out`. A run reads as finished the moment its runner saved the state, but the runner is only done
/// with the log once it released `alive` (its process ended): returning earlier could leave out its last lines.
pub(crate) fn attach_to(store: &Store, id: &str, out: &mut dyn Write) -> i32 {
    let Ok(mut log) = fs::File::open(store.file(id, "log")) else {
        eprintln!("ompdesk check: no run {id}");
        return 1;
    };
    let mut buf = vec![0u8; 64 * 1024];
    let begun = Instant::now();
    let mut finished_at: Option<Instant> = None;
    loop {
        let mut read_any = false;
        while let Ok(n) = log.read(&mut buf) {
            if n == 0 {
                break;
            }
            read_any = true;
            let _ = out.write_all(&buf[..n]);
        }
        let _ = out.flush();
        let Some(run) = store.read(id) else {
            return 1;
        };
        if run.state.finished() {
            let since = *finished_at.get_or_insert_with(Instant::now);
            if !store.runner_alive(id) || since.elapsed() > RUNNER_LINGER {
                let mut rest = Vec::new();
                let _ = log.read_to_end(&mut rest);
                let _ = out.write_all(&rest);
                let _ = out.flush();
                if run.state == State::Killed {
                    eprintln!(
                        "ompdesk check {id}: its runner stopped before it finished (killed); what passed before stays \
                         reusable, so running the check again runs only the rest."
                    );
                    eprintln!("ompdesk check: {}", run.timing(now_ms()).report());
                }
                return exit_of(&run);
            }
        } else if run.state == State::Starting && begun.elapsed() > Duration::from_secs(60) {
            eprintln!("ompdesk check {id}: the runner never started");
            return 1;
        }
        if !read_any {
            let pause = if finished_at.is_some() { 20 } else { 200 };
            std::thread::sleep(Duration::from_millis(pause));
        }
    }
}

fn exit_of(run: &Run) -> i32 {
    match run.state {
        State::Passed if !run.changed_during.is_empty() => crate::board::EXIT_UNKNOWN,
        State::Passed => 0,
        State::Cancelled => 130,
        State::Failed => run.exit_code.filter(|c| *c != 0).unwrap_or(1),
        _ => 1,
    }
}

pub(crate) fn find_run(store: &Store, id: Option<&str>) -> Option<Run> {
    match id {
        Some(id) => store.read(id).or_else(|| {
            store
                .all()
                .into_iter()
                .find(|r| r.id.starts_with(id) || r.id.ends_with(id))
        }),
        None => {
            let cwd = std::env::current_dir().ok()?;
            let root = inputs::root_of(&cwd).display().to_string();
            let mine: Vec<Run> = store.all().into_iter().filter(|r| r.root == root).collect();
            mine.iter()
                .find(|r| !r.state.finished())
                .or_else(|| mine.first())
                .cloned()
        }
    }
}

pub fn attach(id: Option<&str>) -> i32 {
    let Ok(store) = open_store() else {
        return 1;
    };
    match find_run(&store, id) {
        Some(run) => attach_id(&store, &run.id),
        None => {
            eprintln!("ompdesk check: no such run");
            1
        }
    }
}

pub fn status(id: Option<&str>, all: bool, json: bool) -> i32 {
    let Ok(store) = open_store() else {
        return 1;
    };
    let runs: Vec<Run> = if let Some(id) = id {
        find_run(&store, Some(id)).into_iter().collect()
    } else {
        let root = std::env::current_dir()
            .map(|c| inputs::root_of(&c).display().to_string())
            .unwrap_or_default();
        store
            .all()
            .into_iter()
            .filter(|r| all || r.root == root)
            .take(if all { 50 } else { 15 })
            .collect()
    };
    let mut out = io::stdout().lock();
    let now = now_ms();
    if json {
        #[derive(Serialize)]
        struct Status<'a> {
            #[serde(flatten)]
            run: &'a Run,
            timing: store::Timing,
        }
        let rows = runs.iter().map(|run| Status {
            run,
            timing: run.timing(now),
        });
        let mut serializer = serde_json::Serializer::new(&mut out);
        return i32::from(
            serde::Serializer::collect_seq(&mut serializer, rows).is_err()
                || writeln!(out).is_err(),
        );
    }
    if runs.is_empty() {
        let _ = writeln!(
            out,
            "no checks recorded here (ompdesk check -- <command> runs one)"
        );
        return 0;
    }
    for r in &runs {
        let timing = r.timing(now);
        let state = format!("{:?}", r.state).to_lowercase();
        let mode = if r.plan.mode.is_empty() {
            String::new()
        } else {
            format!("[{}] ", r.plan.mode)
        };
        let _ = writeln!(
            out,
            "{}  {:<9}  {}  {}  {mode}{}",
            r.id,
            state,
            timing,
            r.argv.join(" "),
            r.summary.as_deref().unwrap_or("")
        );
        if id.is_some() {
            let _ = writeln!(out, "  folder: {}", r.cwd);
            let _ = writeln!(out, "  log: {}", store.file(&r.id, "log").display());
            let _ = writeln!(
                out,
                "  verdict: {}",
                store.file(&r.id, "verdict.txt").display()
            );
            for line in std::iter::once(&r.plan.reason).chain(&r.plan.evidence) {
                if !line.is_empty() {
                    let _ = writeln!(out, "  {line}");
                }
            }
        }
    }
    0
}

pub fn cancel(id: &str) -> i32 {
    let Ok(store) = open_store() else {
        return 1;
    };
    let Some(run) = find_run(&store, Some(id)) else {
        eprintln!("ompdesk check: no run {id}");
        return 1;
    };
    if run.state.finished() {
        eprintln!("ompdesk check: run {} has already ended", run.id);
        return 0;
    }
    if !may_cancel(run.session.as_deref(), session_tag().as_deref()) {
        eprintln!(
            "ompdesk check: run {} was started by {}, so this session does not cancel it",
            run.id,
            run.session
                .as_deref()
                .map_or("a person in a terminal".into(), |s| format!(
                    "another session ({s})"
                ))
        );
        return 1;
    }
    let _ = fs::write(store.file(&run.id, "cancel"), "");
    stop_command(&store, &run);
    eprintln!("ompdesk check: cancelling run {}", run.id);
    0
}

#[cfg(unix)]
fn stop_command(store: &Store, run: &Run) {
    // The command leads a process group of its own; the runner then records the end.
    if let Some(pid) = fs::read_to_string(store.file(&run.id, "child"))
        .ok()
        .and_then(|p| p.trim().parse::<u32>().ok())
    {
        crate::sys::signal_group(pid, libc::SIGTERM);
    }
}

#[cfg(windows)]
fn stop_command(store: &Store, run: &Run) {
    if let Ok(pid) = fs::read_to_string(store.file(&run.id, "child")) {
        let _ = child_command("taskkill")
            .args(["/T", "/F", "/PID", pid.trim()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// The environment a check's command runs with: this process's, with the headless defaults.
fn command_env() -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = std::env::vars_os()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .collect();
    for (k, v) in HEADLESS_ENV {
        env.entry((*k).to_string())
            .or_insert_with(|| (*v).to_string());
    }
    for k in WINDOW_ENV {
        env.remove(*k);
    }
    env
}

struct Runtime<'a> {
    store: &'a Store,
    run: Run,
    log: fs::File,
    /// Why the command was stopped by the check itself (a full disk): the run ends `error` whatever the command's
    /// exit code, and `decide` never reuses it.
    resource_stop: Option<String>,
}

impl Runtime<'_> {
    fn say(&mut self, line: &str) {
        let _ = writeln!(self.log, "ompdesk check: {line}");
        let _ = self.log.flush();
    }
    fn save(&self) {
        let _ = self.store.write(&self.run);
    }
    fn end_before_command(&mut self, state: State, summary: String) -> i32 {
        let end = now_ms();
        self.run.state = state;
        self.run.ended = Some(end);
        self.say(&format!("{summary}; {}", self.run.timing(end).report()));
        self.run.summary = Some(summary);
        self.save();
        exit_of(&self.run)
    }
}

/// The input set of the checkout now.
fn input_set(
    root: &Path,
    cwd: &Path,
    argv: &[String],
    env: &BTreeMap<String, String>,
    kind: Kind,
    store: &Store,
) -> io::Result<InputSet> {
    let boundary = inputs::Boundary::load(root, cwd, argv)?;
    let ignored = boundary.is_none().then(|| inputs::ignored(root)).flatten();
    let mut cache = StatCache::load(&store.dir, root);
    let files = inputs::snapshot(root, ignored.as_deref(), boundary.as_ref(), &mut cache)?;
    let outside =
        InputSet::command_files(cwd, argv, env, root, boundary.as_ref(), &files, &mut cache)?;
    let _ = cache.save();
    let mut tools = inputs::tools(kind == Kind::Cargo);
    tools.insert(
        "input-policy-v2".into(),
        match boundary {
            Some(b) => inputs::sha256_hex(&serde_json::to_vec(&b)?),
            None => "default".into(),
        },
    );
    Ok(InputSet {
        files,
        outside,
        env: InputSet::env_hashes(env),
        tools,
        argv: argv.to_vec(),
    })
}

struct Decision {
    plan: Plan,
    rewrite: runner::Rewrite,
    reused: Vec<Reused>,
    /// Results of the run reused from that this run has to give again: what did not pass there and is not in a
    /// changed file. One that comes back missing or skipped fails the verdict, so a filter that missed a test can
    /// never pass for it.
    must_run: Vec<Record>,
}

fn full(reason: String, evidence: Vec<String>, rewrite: runner::Rewrite) -> Decision {
    Decision {
        plan: Plan {
            mode: "full".into(),
            reason,
            from: None,
            evidence,
        },
        rewrite,
        reused: Vec::new(),
        must_run: Vec::new(),
    }
}

/// The compound suffix tests are named with: `.test.ts`, `.e2e.ts`, `.spec.tsx`.
fn test_suffix(path: &str) -> Option<String> {
    let name = path.rsplit(['/', '\\']).next()?;
    let mut dots = name.rmatch_indices('.');
    dots.next()?;
    let (at, _) = dots.next()?;
    (at > 0).then(|| name[at..].to_string())
}

/// Whether the run reached its end, so its results name every test.
fn complete(store: &Store, run: &Run, kind: Kind) -> bool {
    if !matches!(run.state, State::Passed | State::Failed) {
        return false;
    }
    match kind {
        Kind::Cargo => {
            let log = fs::read_to_string(store.file(&run.id, "log")).unwrap_or_default();
            runner::cargo_results(&log).1
        }
        Kind::Playwright | Kind::Vitest | Kind::Jest => {
            runner::read_results(&store.file(&run.id, "results.jsonl"))
                .1
                .is_some()
        }
        Kind::Command => true,
    }
}

/// What to run, given the input set now and the check's earlier runs.
fn decide(
    store: &Store,
    run: &Run,
    detected: &Detected,
    set: &InputSet,
    digest: &str,
    forced_full: bool,
) -> Decision {
    let reporters = runner::install_reporters(&store.dir);
    let list_path = store.file(&run.id, "test-list.txt");
    let plain = || match &reporters {
        Ok(r) => runner::rewrite(detected, &run.argv, r, None),
        Err(_) => runner::Rewrite {
            argv: run.argv.clone(),
            ..runner::Rewrite::default()
        },
    };
    if forced_full {
        return full("asked for a full run (--full)".into(), Vec::new(), plain());
    }
    // A run the check stopped itself (a full disk) or that never started is no evidence for any result.
    let earlier: Vec<Run> = store
        .of_key(&run.key)
        .into_iter()
        .filter(|r| {
            r.id != run.id && r.state.finished() && r.state != State::Error && r.inputs.is_some()
        })
        .collect();
    // An exact digest needs no file list. Comparing different digests needs a list we actually read.
    let stable = || earlier.iter().filter(|r| r.changed_during.is_empty());
    let Some((prev, detail)) = stable()
        .find(|r| r.inputs.as_deref() == Some(digest))
        .map(|r| (r, None))
        .or_else(|| stable().find_map(|r| store.input_detail(&r.id).map(|tsv| (r, Some(tsv)))))
    else {
        let mut evidence = Vec::new();
        if stable().next().is_some() {
            evidence.push("the previous input lists are unavailable; running in full".into());
        } else if let Some(last) = earlier.first() {
            evidence.push(format!(
                "run {} changed its own inputs while it ran ({}), so none of its results hold",
                last.id,
                last.changed_during.join(", ")
            ));
        }
        return full(
            "no earlier run of this check to reuse".into(),
            evidence,
            plain(),
        );
    };
    let from = format!(
        "run {} of {}{} ({})",
        prev.id,
        store::utc(prev.started),
        prev.head
            .as_ref()
            .map(|h| format!(" at {h}"))
            .unwrap_or_default(),
        format!("{:?}", prev.state).to_lowercase()
    );
    let records = merged(store, prev);
    let same = prev.inputs.as_deref() == Some(digest);
    let mut evidence = vec![format!("compared with {from}")];
    let all_passed = !records.is_empty()
        && records
            .iter()
            .all(|(r, _)| matches!(r.status.as_str(), "passed" | "skipped"));

    if set.files.outputs != inputs::Outputs::Undeclared {
        if !same || prev.state != State::Passed || !all_passed {
            return full(
                "the output-producing check needs a full run on these inputs".into(),
                evidence,
                plain(),
            );
        }
        if !set
            .files
            .outputs
            .matches_proof(&store.file(&prev.id, "outputs.sha256"))
        {
            return full(
                "declared outputs are missing, changed, or have no previous fingerprint".into(),
                evidence,
                plain(),
            );
        }
    }

    // What changed, and whether all of it is test files the runner can run on their own.
    let mut changed_tests: BTreeSet<PathBuf> = BTreeSet::new();
    if let Some(tsv) = detail {
        let diff = inputs::differences(&tsv, set, 12);
        evidence.extend(diff.iter().cloned());
        let only_files = !diff.is_empty()
            && diff
                .iter()
                .all(|l| l.contains(" file") && !l.contains("outside file"));
        if !only_files || matches!(detected.kind, Kind::Command | Kind::Cargo) {
            let why = if matches!(detected.kind, Kind::Command | Kind::Cargo) && only_files {
                format!(
                    "inputs changed since {from}; a {} is reused only when nothing changed",
                    detected.kind.name()
                )
            } else {
                format!(
                    "the environment, a tool or a file outside the checkout changed since {from}"
                )
            };
            return full(why, evidence, plain());
        }
        let root = PathBuf::from(&run.root);
        let known: BTreeSet<PathBuf> = records
            .iter()
            .filter(|(r, _)| !r.abs.is_empty())
            .map(|(r, _)| PathBuf::from(&r.abs))
            .collect();
        let suffixes: BTreeSet<String> = known
            .iter()
            .filter_map(|p| test_suffix(&p.to_string_lossy()))
            .collect();
        let before: BTreeMap<&str, &str> = tsv
            .lines()
            .filter_map(|l| l.strip_prefix("F\t"))
            .filter_map(|l| l.split_once('\t'))
            .collect();
        let now: BTreeMap<&str, &str> = set
            .files
            .files
            .iter()
            .map(|(p, h)| (p.as_str(), h.as_str()))
            .collect();
        let changed: Vec<&str> = now
            .iter()
            .filter(|(p, h)| before.get(*p) != Some(*h))
            .map(|(p, _)| *p)
            .chain(before.keys().filter(|p| !now.contains_key(*p)).copied())
            .collect();
        let mut not_tests = Vec::new();
        for path in changed {
            let abs = root.join(path);
            let is_new = !before.contains_key(path);
            let named_as_test = test_suffix(path).is_some_and(|s| suffixes.contains(&s));
            if known.contains(&abs) || (is_new && named_as_test) {
                changed_tests.insert(abs);
            } else {
                not_tests.push(path);
            }
        }
        if !not_tests.is_empty() || known.is_empty() {
            let n = not_tests.len();
            evidence.push(format!(
                "{n} changed file{} {} no test file the earlier run ran ({}{}): it may change what any test does, so everything runs",
                if n == 1 { "" } else { "s" },
                if n == 1 { "is" } else { "are" },
                not_tests.iter().take(8).copied().collect::<Vec<_>>().join(", "),
                if n > 8 { ", …" } else { "" }
            ));
            return full(
                format!("files other than tests changed since {from}"),
                evidence,
                plain(),
            );
        }
    }

    // Whole reuse only when every result of that run passed: a run can pass with a quarantined test failing, and that
    // test runs again, under `--release` too.
    if same && prev.state == State::Passed && all_passed {
        let reused: Vec<Reused> = records
            .iter()
            .map(|(r, o)| Reused {
                record: r.clone(),
                origin: o.clone(),
            })
            .collect();
        return Decision {
            plan: Plan {
                mode: "reused".into(),
                reason: format!("the inputs are the same as {from}, which passed: nothing runs"),
                from: Some(prev.id.clone()),
                evidence,
            },
            rewrite: runner::Rewrite {
                argv: run.argv.clone(),
                ..runner::Rewrite::default()
            },
            reused,
            must_run: Vec::new(),
        };
    }
    if matches!(detected.kind, Kind::Command) {
        return full(
            format!(
                "the inputs are the same as {from}, which did not pass; a command is reused only whole"
            ),
            evidence,
            plain(),
        );
    }
    let Ok(reporters) = &reporters else {
        return full(
            "the reporters could not be written".into(),
            evidence,
            plain(),
        );
    };
    let in_changed = |r: &Record| !r.abs.is_empty() && changed_tests.contains(Path::new(&r.abs));
    let candidates: Vec<Record> = records
        .iter()
        .map(|(r, _)| r)
        .filter(|r| !in_changed(r))
        .cloned()
        .collect();
    let jest_files = (detected.kind == Kind::Jest)
        .then(|| jest_list(&run.argv, Path::new(&run.cwd), detected))
        .flatten();
    let e = Earlier {
        records: &candidates,
        complete: complete(store, prev, detected.kind),
        failed_only: same,
        list_path: &list_path,
        jest_files: jest_files.as_deref(),
    };
    let rewrite = runner::rewrite(detected, &run.argv, reporters, Some(&e));
    evidence.extend(rewrite.notes.iter().cloned());
    if !changed_tests.is_empty() {
        evidence.push(format!(
            "only test files changed: {} run in full",
            changed_tests
                .iter()
                .map(|p| p.strip_prefix(&run.root).unwrap_or(p).display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let failed: Vec<&Record> = candidates
        .iter()
        .filter(|r| failing(&r.status) && !r.key.contains(" error|"))
        .collect();
    if !failed.is_empty() {
        evidence.push(format!(
            "{} did not pass there and run again: {}{}",
            failed.len(),
            failed
                .iter()
                .take(10)
                .map(|r| display_name(r))
                .collect::<Vec<_>>()
                .join("; "),
            if failed.len() > 10 { "; …" } else { "" }
        ));
    }
    if rewrite.skipped.is_empty() {
        return full(
            if same {
                format!(
                    "the inputs are the same as {from}, but none of its passes can be left out of this run"
                )
            } else {
                format!(
                    "only test files changed since {from}, but none of its passes can be left out of this run"
                )
            },
            evidence,
            rewrite,
        );
    }
    let reused: Vec<Reused> = records
        .iter()
        .filter(|(r, _)| rewrite.skipped.contains(&r.key) && REUSABLE.contains(&r.status.as_str()))
        .map(|(r, o)| Reused {
            record: r.clone(),
            origin: o.clone(),
        })
        .collect();
    let must_run: Vec<Record> = failed
        .iter()
        .filter(|r| !rewrite.skipped.contains(&r.key))
        .map(|r| (*r).clone())
        .collect();
    let mode = if rewrite.nothing_left {
        "reused"
    } else {
        "narrowed"
    };
    let reason = format!(
        "{}: {} passes reused, the rest runs",
        if same {
            format!("the inputs are the same as {from}")
        } else {
            format!("only test files changed since {from}")
        },
        reused.iter().filter(|r| !r.record.file_record).count()
    );
    Decision {
        plan: Plan {
            mode: mode.into(),
            reason,
            from: Some(prev.id.clone()),
            evidence,
        },
        rewrite,
        reused,
        must_run,
    }
}

fn display_name(r: &Record) -> String {
    if r.runner == "command" || r.file.is_empty() {
        r.titles.join(" ")
    } else if r.titles.is_empty() {
        r.file.clone()
    } else {
        let project = if r.project.is_empty() {
            String::new()
        } else {
            format!("[{}] ", r.project)
        };
        format!("{project}{} › {}", r.file, r.titles.join(" › "))
    }
}

/// Every Jest test file, as `jest --listTests --json` prints them; only for a run that names no files of its own.
fn jest_list(argv: &[String], cwd: &Path, detected: &Detected) -> Option<Vec<String>> {
    if detected.script.is_none() {
        let at = argv.iter().position(|a| a.contains("jest"))?;
        if argv[at + 1..].iter().any(|a| !a.starts_with('-')) {
            return None;
        }
    }
    let mut args: Vec<String> = argv[1..].to_vec();
    if detected.needs_dashdash {
        args.push("--".into());
    }
    args.extend(["--listTests".into(), "--json".into()]);
    let out = child_command(&argv[0])
        .args(&args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('['))?;
    serde_json::from_str(line).ok()
}

/// The runner: everything a run does, from inputs to verdict.
pub fn run_runner(id: &str) -> i32 {
    let Ok(store) = open_store() else {
        return 1;
    };
    let Some(mut run) = store.read(id) else {
        return 1;
    };
    let Ok(alive) = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(store.file(id, "alive"))
    else {
        return 1;
    };
    if alive.lock().is_err() {
        return 1;
    }
    // A signal meant for the runner (a session's tree being ended) reaches the command's group instead, and the
    // runner records the end once the command is gone.
    #[cfg(unix)]
    let held = crate::sys::HeldSignals::block().ok();
    let Ok(log) = fs::OpenOptions::new()
        .append(true)
        .open(store.file(id, "log"))
    else {
        return 1;
    };
    run.pid = std::process::id();
    run.state = State::Running;
    let forced_full = run.plan.mode == "full";
    let mut rt = Runtime {
        store: &store,
        run,
        log,
        resource_stop: None,
    };
    rt.save();
    #[cfg(unix)]
    if let Some(held) = held {
        let child = store.file(id, "child");
        std::thread::spawn(move || {
            loop {
                let signal = held.wait();
                if let Some(pid) = fs::read_to_string(&child)
                    .ok()
                    .and_then(|p| p.trim().parse::<u32>().ok())
                {
                    crate::sys::signal_group(pid, signal);
                }
            }
        });
    }
    let code = execute(&mut rt, forced_full);
    drop(alive);
    code
}

/// macOS keychains in this user's search list (`security list-keychains`), to put back a list a check changed.
#[cfg(target_os = "macos")]
fn keychains() -> Option<Vec<String>> {
    let out = child_command("/usr/bin/security")
        .args(["list-keychains", "-d", "user"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status.success().then(|| {
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim().trim_matches('"').to_string())
            .filter(|l| !l.is_empty())
            .collect()
    })
}

fn execute(rt: &mut Runtime, forced_full: bool) -> i32 {
    let root = PathBuf::from(&rt.run.root);
    let cwd = PathBuf::from(&rt.run.cwd);
    let argv = rt.run.argv.clone();
    let detected = runner::detect(&argv, &cwd);
    let env = command_env();
    let (head, dirty) = inputs::head(&root);
    rt.run.head = head;
    rt.run.dirty = dirty;
    rt.say(&format!(
        "{} in {} ({}{}){}",
        argv.join(" "),
        cwd.display(),
        rt.run.head.as_deref().unwrap_or("no commit"),
        if dirty {
            ", with changes not committed"
        } else {
            ""
        },
        if rt.run.release {
            ", release check"
        } else {
            ""
        }
    ));

    let mut lease: Option<heavy::Lease> = None;
    let mut decided: Option<(Decision, InputSet, String)> = None;
    let held_by_parent = env
        .get(heavy::HELD_ENV)
        .and_then(|p| p.parse::<u32>().ok())
        .is_some_and(crate::sys::alive);
    // Decide, take a slot, and decide again when the inputs changed while it waited.
    for _ in 0..3 {
        let hashing = Instant::now();
        let set = match input_set(&root, &cwd, &argv, &env, detected.kind, rt.store) {
            Ok(set) => set,
            Err(e) => {
                return rt.end_before_command(
                    State::Error,
                    format!("not started: cannot establish check inputs: {e}"),
                );
            }
        };
        let digest = set.digest();
        rt.say(&format!(
            "inputs: {} files, {} variables, {} tools hashed in {} (digest {})",
            set.files.files.len(),
            set.env.len(),
            set.tools.len(),
            store::duration(hashing.elapsed().as_millis() as u64),
            &digest[..12]
        ));
        if decided
            .as_ref()
            .is_some_and(|d| d.2 == digest && d.1.files.outputs == set.files.outputs)
        {
            break;
        }
        let decision = decide(rt.store, &rt.run, &detected, &set, &digest, forced_full);
        let nothing_to_run = decision.plan.mode == "reused";
        decided = Some((decision, set, digest));
        if nothing_to_run || rt.run.light || lease.is_some() || held_by_parent {
            break;
        }
        let queued_at = now_ms();
        let lookup = |k: &str| env.get(k).cloned();
        let owner = heavy::Owner {
            pid: std::process::id(),
            command: format!("ompdesk check {}", argv.join(" "))
                .chars()
                .take(200)
                .collect(),
            cwd: cwd.display().to_string(),
            since: 0,
            weight: 1,
            run_id: Some(rt.run.id.clone()),
            session: rt.run.session.clone(),
        };
        let cancel_file = rt.store.file(&rt.run.id, "cancel");
        let taken = heavy::Pool::new(heavy::pool_dir(&lookup), heavy::machine_size(&lookup))
            .and_then(|mut pool| {
                pool.volumes = heavy::Volumes::of_work(&cwd, &argv, &lookup);
                pool.volumes.paths.push(rt.store.dir.clone());
                pool.acquire_unless(
                    1,
                    owner,
                    rt.run.release,
                    |w| {
                        if rt.run.state != State::Waiting {
                            rt.run.state = State::Waiting;
                            rt.run.milestones.get_or_insert_default().queued_at = Some(queued_at);
                            rt.save();
                        }
                        let line = if let Some(reason) = w.pressure {
                            format!("waiting before starting: {reason}")
                        } else if w.low_disk.is_empty() {
                            format!(
                                "waiting for a heavy slot ({} ahead, {} in use)",
                                w.ahead,
                                w.holders.len()
                            )
                        } else {
                            let disks: Vec<String> = w
                                .low_disk
                                .iter()
                                .map(|d| {
                                    format!(
                                        "{} free on {} (needs {})",
                                        gb(d.free),
                                        d.path,
                                        gb(d.need)
                                    )
                                })
                                .collect();
                            format!(
                                "waiting for disk space before starting: {}",
                                disks.join(", ")
                            )
                        };
                        rt.say(&line);
                    },
                    &|| cancel_file.exists(),
                )
            });
        match taken {
            Ok(l) => {
                if !l.has_slots() && rt.run.state != State::Waiting {
                    break;
                }
                let milestones = rt.run.milestones.get_or_insert_default();
                milestones.queued_at = Some(queued_at);
                milestones.acquired_at = Some(l.acquired_at);
                if l.has_slots() && l.waited.as_secs() >= 1 {
                    let waited = store::duration(l.waited.as_millis() as u64);
                    rt.say(&format!("heavy slot taken after {waited}"));
                }
                lease = Some(l);
            }
            // Fail closed: an admission that cannot be decided (a full disk refuses the queue's own files, the pool
            // folder cannot be written) never lets the command start, or the disk rule is lost exactly when it matters.
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {
                rt.say("cancelled while waiting for a heavy slot; the command never started");
                return rt
                    .end_before_command(State::Cancelled, "cancelled before it started".into());
            }
            Err(e) => {
                rt.say(&format!(
                    "cannot take a heavy slot ({e}); the command does not start (free space, or the pool folder {}?)",
                    heavy::pool_dir(&lookup).display()
                ));
                return rt
                    .end_before_command(State::Error, format!("not started: no heavy slot ({e})"));
            }
        }
        rt.run.state = State::Running;
        rt.save();
    }
    let Some((decision, start_set, digest)) = decided else {
        return 1;
    };
    rt.run.plan = decision.plan.clone();
    rt.run.inputs = Some(digest.clone());
    let _ = fs::write(rt.store.file(&rt.run.id, "inputs.tsv"), start_set.to_tsv());
    let reused_lines: String = decision
        .reused
        .iter()
        .filter_map(|r| serde_json::to_string(r).ok())
        .map(|l| l + "\n")
        .collect();
    let _ = fs::write(rt.store.file(&rt.run.id, "reused.jsonl"), reused_lines);
    rt.say(&format!("{}: {}", decision.plan.mode, decision.plan.reason));
    for line in &decision.plan.evidence {
        rt.say(&format!("  {line}"));
    }
    rt.save();

    if rt.store.file(&rt.run.id, "cancel").exists() {
        rt.say("cancelled before the command started");
        return rt.end_before_command(State::Cancelled, "cancelled before it started".into());
    }
    #[cfg(target_os = "macos")]
    let keychains_before = keychains();
    let started = Instant::now();
    let exit_code = if decision.plan.mode == "reused" {
        0
    } else {
        for (path, text) in &decision.rewrite.files {
            let _ = fs::write(path, text);
        }
        let results = rt.store.file(&rt.run.id, "results.jsonl");
        let mut cmd_env = env.clone();
        cmd_env.extend(decision.rewrite.env.clone());
        cmd_env.insert(runner::RESULTS_ENV.into(), results.display().to_string());
        cmd_env.insert(RUN_ENV.into(), rt.run.id.clone());
        if lease.as_ref().is_some_and(heavy::Lease::has_slots) {
            cmd_env.insert(heavy::HELD_ENV.into(), std::process::id().to_string());
        } else if !held_by_parent {
            cmd_env.remove(heavy::HELD_ENV);
        }
        if decision.rewrite.argv != argv {
            rt.say(&format!("running: {}", decision.rewrite.argv.join(" ")));
        }
        run_command(rt, &decision.rewrite.argv, &cwd, &cmd_env)
    };
    let ran_for = started.elapsed();
    drop(lease);
    #[cfg(target_os = "macos")]
    if let (Some(before), Some(after)) = (keychains_before, keychains())
        && before != after
    {
        {
            let _ = child_command("/usr/bin/security")
                .args(["list-keychains", "-d", "user", "-s"])
                .args(&before)
                .status();
            rt.say(&format!(
                "the check changed this user's keychain search list ({}); it is put back as it was, so a test's \
                 keychain can never ask the person for a password",
                after
                    .iter()
                    .filter(|k| !before.contains(k))
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }

    // What changed while the command ran.
    let changed = match input_set(&root, &cwd, &argv, &env, detected.kind, rt.store) {
        Ok(end_set) => {
            let mut changed = start_set.changed_during(&end_set);
            match &end_set.files.outputs {
                inputs::Outputs::Undeclared => {}
                inputs::Outputs::Missing => {
                    changed.push("declared output missing after the check".into())
                }
                inputs::Outputs::Present(_)
                    if decision.plan.mode == "reused"
                        && start_set.files.outputs != end_set.files.outputs =>
                {
                    changed.push("declared outputs changed during cache reuse".into());
                }
                inputs::Outputs::Present(hash) => {
                    if let Err(e) = fs::write(rt.store.file(&rt.run.id, "outputs.sha256"), hash) {
                        changed.push(format!("could not record output fingerprint: {e}"));
                    }
                }
            }
            changed
        }
        Err(e) => vec![format!("could not verify final inputs: {e}")],
    };
    if !changed.is_empty() {
        rt.say(&format!(
            "{} input changes or verification errors while the check ran ({}{}): its results will not be reused",
            changed.len(),
            changed
                .iter()
                .take(10)
                .cloned()
                .collect::<Vec<_>>()
                .join(", "),
            if changed.len() > 10 { ", …" } else { "" }
        ));
    }
    rt.run.changed_during = changed;

    // Results no reporter wrote: cargo's lines, a plain command's exit code.
    let results_path = rt.store.file(&rt.run.id, "results.jsonl");
    if decision.plan.mode != "reused" {
        let mut lines: Vec<serde_json::Value> = Vec::new();
        if detected.kind == Kind::Cargo {
            let log = fs::read_to_string(rt.store.file(&rt.run.id, "log")).unwrap_or_default();
            for r in runner::cargo_results(&log).0 {
                lines.push(serde_json::json!({
                    "runner": "cargo", "file": r.file, "titles": r.titles, "status": r.status, "ms": 0,
                }));
            }
        }
        if lines.is_empty() {
            let (reported, _) = runner::read_results(&results_path);
            let wrapper_failed = detected.kind == Kind::Command && exit_code != 0;
            let mut seen = BTreeSet::new();
            if reported.is_empty()
                || (wrapper_failed
                    && !reported
                        .iter()
                        .rev()
                        .any(|r| seen.insert(&r.key) && failing(&r.status)))
            {
                let error = if wrapper_failed && reported.is_empty() {
                    runner::playwright_log_diagnostic(&rt.store.file(&rt.run.id, "log"), &cwd)
                } else {
                    None
                };
                lines.push(serde_json::json!({
                    "runner": "command", "titles": ["command"],
                    "status": if exit_code == 0 { "passed" } else { "failed" },
                    "ms": ran_for.as_millis() as u64, "error": error,
                }));
            }
        }
        for line in lines {
            let _ = rt
                .store
                .append(&rt.run.id, "results.jsonl", &line.to_string());
        }
    }
    let cancelled = rt.store.file(&rt.run.id, "cancel").exists();
    finish(rt, exit_code, cancelled, &decision, &digest)
}

#[cfg(unix)]
fn command_for(argv: &[String], _env: &BTreeMap<String, String>) -> Command {
    let mut command = child_command(&argv[0]);
    command.args(&argv[1..]);
    // A group of its own, so a cancel or a full disk ends what it started too.
    crate::sys::child_defaults(&mut command, true);
    command
}

#[cfg(windows)]
fn command_for(argv: &[String], env: &BTreeMap<String, String>) -> Command {
    // A batch file (npm.cmd, a project's check.bat) runs through cmd, as a shell would start it.
    match crate::cli::resolve_windows(&argv[0], env) {
        Some(p)
            if p.extension().is_some_and(|e| {
                e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat")
            }) =>
        {
            let mut c = child_command("cmd");
            c.arg("/d").arg("/s").arg("/c").arg(p).args(&argv[1..]);
            c
        }
        Some(p) => {
            let mut c = child_command(p);
            c.args(&argv[1..]);
            c
        }
        None => {
            let mut c = child_command(&argv[0]);
            c.args(&argv[1..]);
            c
        }
    }
}

/// Ends the command and what it started: its process group (POSIX) or its tree (Windows), SIGTERM then SIGKILL.
fn stop_tree(pid: u32) {
    #[cfg(unix)]
    {
        crate::sys::signal_group(pid, libc::SIGTERM);
        std::thread::sleep(crate::watch::GRACE);
        crate::sys::signal_group(pid, libc::SIGKILL);
    }
    #[cfg(windows)]
    crate::cli::stop_process(pid, crate::watch::GRACE);
}

/// Runs the check's command with its output through the log's cap and its volumes watched; its exit code.
fn run_command(
    rt: &mut Runtime,
    argv: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> i32 {
    let (Ok(log), Ok(said)) = (rt.log.try_clone(), rt.log.try_clone()) else {
        return 1;
    };
    let mut command = command_for(argv, env);
    command
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            rt.say(&format!("cannot start {}: {e}", argv[0]));
            return 127;
        }
    };
    let pid = child.id();
    rt.run.milestones.get_or_insert_default().command_started_at = Some(now_ms());
    let _ = fs::write(rt.store.file(&rt.run.id, "child"), pid.to_string());
    rt.save();
    let said = std::sync::Mutex::new(said);
    let mut volumes = heavy::Volumes::of_work(cwd, argv, &|k| env.get(k).cloned());
    volumes.paths.push(rt.store.dir.clone());
    let watch = crate::watch::Watch::start(
        volumes,
        None,
        move |line| {
            if let Ok(mut log) = said.lock() {
                let _ = writeln!(log, "ompdesk check: {line}");
            }
        },
        Some(Box::new(move || stop_tree(pid))),
    );
    let capped = std::sync::Arc::new(crate::watch::Capped::new(log));
    let mut pumps = Vec::new();
    for from in [
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let to = capped.clone();
        pumps.push(std::thread::spawn(move || to.pump(from)));
    }
    let status = child.wait();
    // What the command left running in its group goes with it.
    #[cfg(unix)]
    crate::sys::signal_group(pid, libc::SIGKILL);
    if status.is_ok() {
        rt.run.milestones.get_or_insert_default().command_ended_at = Some(now_ms());
        rt.save();
    }
    for pump in pumps {
        let _ = pump.join();
    }
    let cut = capped.finish();
    let stopped_for_disk = watch.stopped_for_disk();
    drop(watch);
    if cut > 0 {
        rt.say(&format!(
            "the command printed {} more than the log keeps; its start and end are kept",
            gb(cut)
        ));
    }
    if stopped_for_disk {
        let why = "the command was stopped because the disk was nearly full; what it recorded before stays";
        rt.say(why);
        rt.resource_stop = Some(why.into());
    }
    #[cfg(unix)]
    return crate::cli::exit_code(status);
    #[cfg(windows)]
    status.ok().and_then(|s| s.code()).unwrap_or(1)
}

/// About how long the reused results took when they ran: each origin command's runtime, shared out by its results'
/// durations (tests run side by side, so their durations add up to more than the run took).
fn saved_ms(store: &Store, records: &[(Record, Origin)], own: &str) -> u64 {
    let mut by_origin: BTreeMap<&str, u64> = BTreeMap::new();
    for (r, o) in records {
        if o.run != own && REUSABLE.contains(&r.status.as_str()) && !r.file_record {
            *by_origin.entry(o.run.as_str()).or_default() += r.ms.max(1);
        }
    }
    let mut saved = 0u64;
    for (origin, reused_ms) in by_origin {
        let Some(run) = store.read(origin) else {
            continue;
        };
        let Some(wall) = run.timing(now_ms()).run_ms else {
            continue;
        };
        let (own_records, _) = runner::read_results(&store.file(origin, "results.jsonl"));
        let total: u64 = own_records
            .iter()
            .filter(|r| !r.file_record)
            .map(|r| r.ms.max(1))
            .sum();
        if total == 0 {
            continue;
        }
        saved += ((wall as f64) * (reused_ms as f64 / total as f64)).min(wall as f64) as u64;
    }
    saved
}

fn finish(
    rt: &mut Runtime,
    exit_code: i32,
    cancelled: bool,
    decision: &Decision,
    digest: &str,
) -> i32 {
    let own = rt.run.id.clone();
    let mut records = merged(rt.store, &rt.run);
    // A test the filter was meant to run again but that did not come back.
    for r in &decision.must_run {
        let back = records.iter().any(|(m, o)| {
            m.key == r.key && o.run == own && !matches!(m.status.as_str(), "skipped" | "unrun")
        });
        if !back {
            records.retain(|(m, _)| m.key != r.key);
            let mut missing = r.clone();
            missing.status = "missing".into();
            records.push((missing, origin_of(rt.store, &rt.run)));
        }
    }

    // Quarantine: what this run itself produced, on the inputs it began with.
    let mut book = Book::load(&rt.store.dir, &rt.run.key);
    let mut entered = Vec::new();
    for (r, o) in &records {
        if !rt.run.changed_during.is_empty() {
            break;
        }
        if o.run != own || r.file_record || r.key.contains(" error|") {
            continue;
        }
        if book.record(&r.key, &display_name(r), &r.status, digest, &own) {
            entered.push(display_name(r));
        }
    }
    let _ = book.save(&rt.store.dir, &rt.run.key);

    let counted = countable(&records);
    let reused = counted.iter().filter(|(_, o)| o.run != own).count();
    let now: Vec<&&(Record, Origin)> = counted.iter().filter(|(_, o)| o.run == own).collect();
    let failures: Vec<&&(Record, Origin)> =
        counted.iter().filter(|(r, _)| failing(&r.status)).collect();
    let (quarantined, blocking): (Vec<Merged>, Vec<Merged>) = failures
        .iter()
        .map(|x| **x)
        .partition(|(r, _)| book.quarantined(&r.key));
    let quarantined_flaky: Vec<&&(Record, Origin)> = counted
        .iter()
        .filter(|(r, o)| o.run == own && r.status == "flaky" && book.quarantined(&r.key))
        .collect();
    let release_blocked =
        rt.run.release && (!quarantined.is_empty() || !quarantined_flaky.is_empty());
    let passed_now = now
        .iter()
        .filter(|(r, _)| matches!(r.status.as_str(), "passed" | "flaky"))
        .count();
    rt.run.reused = reused;
    rt.run.ran = now.len();
    rt.run.failed = blocking.len();
    rt.run.quarantined_failed = quarantined.len();
    rt.run.flaky = entered.clone();
    rt.run.saved_ms = saved_ms(rt.store, &records, &own);
    rt.run.exit_code = Some(exit_code);
    // The command's exit code fails the verdict unless every failure it reports is a quarantined test's.
    let exit_explained = exit_code == 0
        || (rt.run.runner != Kind::Command.name()
            && !quarantined.is_empty()
            && blocking.is_empty());
    rt.run.state = if cancelled {
        State::Cancelled
    } else if rt.resource_stop.is_some() {
        State::Error
    } else if blocking.is_empty() && exit_explained && !release_blocked {
        State::Passed
    } else {
        State::Failed
    };

    // The verdict: every result and where it came from, quarantined tests first.
    let state = format!("{:?}", rt.run.state).to_lowercase();
    let mut text = format!(
        "ompdesk check {own} — {}\n{state} in {}\n{}: {}\n",
        rt.run.argv.join(" "),
        rt.run.cwd,
        rt.run.plan.mode,
        rt.run.plan.reason
    );
    for line in &rt.run.plan.evidence {
        text.push_str(&format!("  {line}\n"));
    }
    let in_quarantine: Vec<_> = book.tests.iter().filter(|(_, t)| t.quarantined).collect();
    if !in_quarantine.is_empty() {
        text.push_str(&format!(
            "\nquarantined (flaky: passed and failed on the same inputs; their failures do not fail this verdict{}):\n",
            if rt.run.release {
                ", except in a release check"
            } else {
                ""
            }
        ));
        for (key, t) in &in_quarantine {
            let this_run = counted.iter().find(|(r, _)| &r.key == *key).map_or(
                "not in this run".to_string(),
                |(r, o)| {
                    if o.run == own {
                        format!("{} now", r.status)
                    } else {
                        format!("{} (reused)", r.status)
                    }
                },
            );
            text.push_str(&format!(
                "  {} — {this_run}; {} passed, {} failed in all; flaked on inputs {}; {} of {} passes on changed inputs to leave\n",
                t.name,
                t.passed,
                t.failed,
                t.flaked_on
                    .iter()
                    .map(|d| &d[..12.min(d.len())])
                    .collect::<Vec<_>>()
                    .join(", "),
                t.streak,
                crate::flaky::CLEAR_AFTER
            ));
        }
    }
    text.push('\n');
    let mut sorted: Vec<&&(Record, Origin)> = counted.iter().collect();
    sorted.sort_by_key(|(r, _)| (!failing(&r.status), r.key.clone()));
    for (r, o) in sorted {
        let from = if o.run == own {
            "run now".to_string()
        } else {
            format!(
                "reused from run {} ({}, {}), log {}",
                o.run,
                o.head.as_deref().unwrap_or("no commit"),
                store::utc(o.started),
                o.log
            )
        };
        text.push_str(&format!("{:<8} {} — {from}\n", r.status, display_name(r)));
    }
    let verdict = rt.store.file(&own, "verdict.txt");
    let _ = fs::write(&verdict, &text);
    let counted_keys: BTreeSet<&str> = counted.iter().map(|(r, _)| r.key.as_str()).collect();
    // `counted` and `error` are what `ompdesk checks wait` answers from (`board.rs`).
    let json: Vec<serde_json::Value> = records
        .iter()
        .map(|(r, o)| {
            serde_json::json!({
                "key": r.key, "name": display_name(r), "status": r.status, "ms": r.ms,
                "quarantined": book.quarantined(&r.key),
                "counted": counted_keys.contains(r.key.as_str()),
                "error": r.error,
                "origin": if o.run == own { serde_json::Value::Null } else { serde_json::to_value(o).unwrap_or_default() },
            })
        })
        .collect();
    let _ = fs::write(
        rt.store.file(&own, "verdict.json"),
        serde_json::to_vec(&json).unwrap_or_default(),
    );

    for (r, _) in blocking.iter().take(30) {
        let line = format!("{}: {}", r.status, display_name(r));
        rt.say(&line);
    }
    for (r, _) in &quarantined {
        let line = format!("{} (quarantined, flaky): {}", r.status, display_name(r));
        rt.say(&line);
    }
    for name in &entered {
        rt.say(&format!(
            "flaky: {name} passed and failed on the same inputs; quarantined"
        ));
    }
    if release_blocked {
        rt.say("release check: quarantined tests failed in this run, so it does not pass");
    }
    if exit_code != 0 && blocking.is_empty() && quarantined.is_empty() && !cancelled {
        rt.say(&format!(
            "the command exited {exit_code} with no failed test recorded: the verdict is failed"
        ));
    }
    let finished = now_ms();
    rt.run.ended = Some(finished);
    let timing = rt.run.timing(finished).report();
    let summary = format!(
        "{} results: {} reused, {} run now ({} passed, {} failed{})",
        counted.len(),
        reused,
        now.len(),
        passed_now,
        blocking.len(),
        if quarantined.is_empty() {
            String::new()
        } else {
            format!(", {} quarantined failed", quarantined.len())
        }
    );
    rt.run.summary = Some(summary.clone());
    let note = if decision.plan.mode == "reused" {
        " (nothing had to run)"
    } else {
        ""
    };
    // OMPdesk's Pace line reads `reuse saved about … (<n> s)` from this line (`src/main/session-pace.ts`).
    rt.say(&format!(
        "{own}: {state} in {timing}{note} — {summary} — reuse saved about {} ({} s) — verdict {}",
        store::duration(rt.run.saved_ms),
        rt.run.saved_ms / 1000,
        verdict.display()
    ));
    // The finished state goes last: `attach_id` stops reading the log once it reads the run as finished.
    rt.save();
    rt.store.prune(&rt.run.key, finished);
    exit_of(&rt.run)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_suffixes_are_the_last_two_extensions() {
        assert_eq!(test_suffix("e2e/a-b.e2e.ts").as_deref(), Some(".e2e.ts"));
        assert_eq!(
            test_suffix("src/x.y.test.tsx").as_deref(),
            Some(".test.tsx")
        );
        assert_eq!(test_suffix("src/index.ts"), None);
        assert_eq!(test_suffix(".eslintrc.js"), None);
    }

    #[test]
    fn a_session_cancels_only_its_own_runs_and_a_person_any() {
        assert!(may_cancel(Some("tab-a"), Some("tab-a")));
        assert!(!may_cancel(Some("tab-a"), Some("tab-b")));
        // A run a person started in a terminal is never an agent's to cancel.
        assert!(!may_cancel(None, Some("tab-b")));
        assert!(may_cancel(Some("tab-a"), None));
        assert!(may_cancel(None, None));
    }

    fn earlier_run(store: &Store, id: &str, state: &str, digest: &str) -> Run {
        let run: Run = serde_json::from_value(serde_json::json!({
            "id": id, "key": "k", "root": "/r", "cwd": "/r", "argv": ["vitest", "run"], "runner": "vitest",
            "state": state, "pid": 0, "started": 1, "ended": 2, "exit_code": 0, "head": null, "dirty": false,
            "inputs": digest, "changed_during": [], "plan": {"mode": "full", "reason": "", "from": null, "evidence": []},
            "reused": 0, "ran": 2, "failed": 0, "saved_ms": 0, "light": false, "summary": null
        }))
        .unwrap();
        store.create(&run).unwrap();
        run
    }

    const CACHE_NOW: u64 = 1_794_536_107_000;
    const DAY: u64 = 86_400_000;

    fn cache_store(name: &str) -> Store {
        let dir = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "ompdesk-input-retention-{name}-{}",
                std::process::id()
            ));
        let _ = fs::remove_dir_all(&dir);
        Store::open(dir).unwrap()
    }

    fn write_at(path: &Path, bytes: &str, ms: u64) {
        let mut file = fs::File::create(path).unwrap();
        file.write_all(bytes.as_bytes()).unwrap();
        file.set_modified(std::time::UNIX_EPOCH + Duration::from_millis(ms))
            .unwrap();
    }

    fn cached_run(store: &Store, n: u32, checkout: &str, state: &str, at: u64) -> Run {
        let id = format!("20261108-000000-{n:04x}");
        let hash = "a".repeat(64);
        let mut run = earlier_run(store, &id, state, &hash);
        run.root = store.dir.join(checkout).display().to_string();
        run.cwd.clone_from(&run.root);
        run.key = key_of(Path::new(&run.root), Path::new(&run.cwd), &run.argv);
        run.started = at;
        run.ended = run.state.finished().then_some(at);
        store.write(&run).unwrap();
        fs::File::create(store.file(&id, "alive")).unwrap();
        write_at(
            &store.file(&id, "inputs.tsv"),
            &format!("F\ta\t{hash}\n"),
            at,
        );
        write_at(
            &inputs::stat_cache_path(&store.dir, &run.root),
            &format!("a\t1\t2\t3\t4\t0\t{hash}\n"),
            at,
        );
        run
    }

    #[test]
    fn disk_care_expires_only_idle_input_payloads() {
        let store = cache_store("expiry");
        let old = CACHE_NOW - 4 * DAY;
        let a = cached_run(&store, 1, "first", "passed", old);
        let b = cached_run(&store, 2, "second", "failed", old);
        let recent = cached_run(&store, 3, "recent", "passed", CACHE_NOW - DAY);
        let queued = cached_run(&store, 4, "queued", "waiting", old);
        let ancestor = cached_run(&store, 5, "queued", "passed", old);
        let running = cached_run(&store, 6, "running", "running", old);
        let bad = cached_run(&store, 7, "malformed-tsvs", "passed", old);
        let next = cached_run(&store, 8, "starting", "starting", old);
        let held = cached_run(&store, 9, "held", "passed", old);
        let alive = fs::File::open(store.file(&held.id, "alive")).unwrap();
        alive.lock().unwrap();
        let detail = |run: &Run| store.file(&run.id, "inputs.tsv");
        let cache = |run: &Run| inputs::stat_cache_path(&store.dir, &run.root);
        let refreshed = cached_run(&store, 10, "refreshed", "passed", old);
        for path in [detail(&refreshed), cache(&refreshed)] {
            fs::OpenOptions::new()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(std::time::UNIX_EPOCH + Duration::from_millis(CACHE_NOW))
                .unwrap();
        }
        write_at(&detail(&bad), "not input detail\n", old);
        write_at(&cache(&bad), "not a stat cache\n", old);
        let unknown = store.dir.join("inputs").join("0123456789abcdef.tsv");
        write_at(&unknown, "personal file", old);
        let flaky = store.dir.join("flaky").join(format!("{}.json", a.key));
        fs::create_dir(store.dir.join("flaky")).unwrap();
        write_at(&flaky, "quarantine", old);
        let evidence = [
            "log",
            "results.jsonl",
            "verdict.txt",
            "outputs.sha256",
            "reused.jsonl",
        ];
        for name in evidence {
            write_at(&store.file(&a.id, name), "evidence", old);
        }
        let expected: u64 = [&a, &b]
            .into_iter()
            .flat_map(|run| [detail(run), cache(run)])
            .map(|p| {
                let meta = fs::metadata(p).unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    meta.blocks() * 512
                }
                #[cfg(windows)]
                {
                    meta.len()
                }
            })
            .sum();
        assert_eq!(prune_idle_inputs(&store.dir, CACHE_NOW, || true), 0);
        assert_eq!(prune_idle_inputs(&store.dir, CACHE_NOW, || false), expected);
        for run in [&a, &b] {
            assert!(!detail(run).exists() && !cache(run).exists());
            assert_eq!(store.read(&run.id).unwrap().state, run.state);
        }
        for run in [
            &recent, &queued, &ancestor, &running, &bad, &next, &held, &refreshed,
        ] {
            assert!(
                detail(run).is_file() && cache(run).is_file(),
                "{}",
                run.root
            );
        }
        for name in evidence {
            assert_eq!(fs::read(store.file(&a.id, name)).unwrap(), b"evidence");
        }
        assert_eq!(fs::read(unknown).unwrap(), b"personal file");
        assert_eq!(fs::read(flaky).unwrap(), b"quarantine");
        assert_eq!(prune_idle_inputs(&store.dir, CACHE_NOW, || false), 0);
        drop(alive);
        fs::remove_dir_all(store.dir).unwrap();
    }

    #[test]
    fn a_journal_cannot_choose_a_cleanup_path_and_the_ten_run_limit_stays_local() {
        let store = cache_store("journals");
        let old = CACHE_NOW - 4 * DAY;
        let a = cached_run(&store, 0, "history", "passed", old);
        for i in 1..=10 {
            cached_run(&store, i, "history", "passed", old + u64::from(i));
        }
        let other = cached_run(&store, 11, "other", "passed", old);
        let forged = cached_run(&store, 12, "forged", "passed", old);
        let journal = store.file(&forged.id, "run.json");
        let mut spoof = forged.clone();
        spoof.id = "../..".into();
        fs::write(journal, serde_json::to_vec(&spoof).unwrap()).unwrap();
        prune_idle_inputs(&store.dir, CACHE_NOW, || false);
        assert!(store.file(&forged.id, "inputs.tsv").exists());
        assert!(inputs::stat_cache_path(&store.dir, &other.root).exists());
        store.prune(&a.key, CACHE_NOW);
        assert!(!store.run_dir(&a.id).exists());
        assert_eq!(store.of_key(&a.key).len(), 10);
        assert!(store.file(&other.id, "run.json").is_file());
        fs::remove_dir_all(store.dir).unwrap();
    }

    #[test]
    fn linked_cache_directories_do_not_authorize_their_targets() {
        fn link(target: &Path, at: &Path) {
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, at).unwrap();
            #[cfg(windows)]
            assert!(
                child_command("cmd")
                    .args(["/D", "/C", "mklink", "/J"])
                    .arg(at)
                    .arg(target)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let store = cache_store("links");
        let old = CACHE_NOW - 4 * DAY;
        let run = cached_run(&store, 1, "checkout", "passed", old);
        let inputs = store.dir.join("inputs");
        let personal = store.dir.join("elsewhere");
        fs::rename(&inputs, &personal).unwrap();
        link(&personal, &inputs);
        #[cfg(unix)]
        {
            let detail = store.file(&run.id, "inputs.tsv");
            let file = personal.join("input-list");
            fs::rename(&detail, &file).unwrap();
            std::os::unix::fs::symlink(&file, &detail).unwrap();
        }
        prune_idle_inputs(&store.dir, CACHE_NOW, || false);
        assert!(inputs::stat_cache_path(&store.dir, &run.root).is_file());
        #[cfg(unix)]
        assert!(store.file(&run.id, "inputs.tsv").is_symlink());
        let original = store.run_dir(&run.id);
        let elsewhere = store.dir.join("other-run");
        fs::rename(&original, &elsewhere).unwrap();
        link(&elsewhere, &original);
        let target = elsewhere.join("inputs.tsv");
        #[cfg(unix)]
        fs::remove_file(&target).unwrap();
        write_at(&target, &format!("F\ta\t{}\n", "a".repeat(64)), old);
        assert_eq!(prune_idle_inputs(&store.dir, CACHE_NOW, || false), 0);
        assert!(target.is_file());
        let absent = store.dir.join("absent");
        assert_eq!(prune_idle_inputs(&absent, CACHE_NOW, || false), 0);
        assert!(!absent.exists());
        fs::remove_dir_all(store.dir).unwrap();
    }

    #[test]
    fn cancellation_after_one_unlink_leaves_the_other_payloads() {
        let store = cache_store("cancel");
        let old = CACHE_NOW - 4 * DAY;
        let a = cached_run(&store, 1, "first", "passed", old);
        let b = cached_run(&store, 2, "second", "passed", old);
        let first = store.file(&a.id, "inputs.tsv");
        let second = store.file(&b.id, "inputs.tsv");
        prune_idle_inputs(&store.dir, CACHE_NOW, || {
            !first.exists() || !second.exists()
        });
        assert_ne!(first.exists(), second.exists());
        for run in [a, b] {
            assert!(inputs::stat_cache_path(&store.dir, &run.root).is_file());
        }
        fs::remove_dir_all(store.dir).unwrap();
    }

    #[test]
    fn missing_input_detail_runs_in_full_without_inventing_a_changed_file() {
        let store = cache_store("missing");
        let prev = earlier_run(&store, "0001", "passed", "old");
        let now = earlier_run(&store, "0002", "running", "new");
        let detected = Detected {
            kind: Kind::Vitest,
            needs_dashdash: false,
            script: None,
        };
        let decision = decide(&store, &now, &detected, &InputSet::default(), "new", false);
        assert_eq!(decision.plan.mode, "full");
        assert!(
            decision
                .plan
                .evidence
                .iter()
                .any(|line| line.contains("unavailable"))
        );
        assert!(decision.reused.is_empty());
        let row = serde_json::json!({
            "runner": "vitest", "kind": "test", "file": "a.test.ts", "titles": ["case"],
            "status": "passed", "ms": 1
        });
        store
            .append(&prev.id, "results.jsonl", &row.to_string())
            .unwrap();
        let same = decide(&store, &now, &detected, &InputSet::default(), "old", false);
        assert_eq!(same.plan.mode, "reused");
        fs::remove_dir_all(store.dir).unwrap();
    }

    #[test]
    fn a_pass_with_a_quarantined_failure_is_not_reused_whole() {
        let dir = std::env::temp_dir().join(format!("ompdesk-decide-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = Store::open(dir.clone()).unwrap();
        let prev = earlier_run(&store, "0001", "passed", "same");
        for (title, status) in [("steady", "passed"), ("quarantined", "failed")] {
            let line = serde_json::json!({
                "runner": "vitest", "kind": "test", "project": "", "file": "a.test.ts", "titles": [title],
                "status": status, "ms": 5
            });
            store
                .append(&prev.id, "results.jsonl", &line.to_string())
                .unwrap();
        }
        let mut now = earlier_run(&store, "0002", "running", "same");
        now.state = State::Running;
        let detected = Detected {
            kind: Kind::Vitest,
            needs_dashdash: false,
            script: None,
        };
        let decision = decide(&store, &now, &detected, &InputSet::default(), "same", false);
        assert_ne!(decision.plan.mode, "reused", "{:?}", decision.plan);
        assert!(
            !decision.reused.iter().any(|r| r.record.status == "failed"),
            "a failed result was carried over as reused"
        );
        let _ = fs::remove_dir_all(dir);
    }

    /// What `attach_to` writes, and a signal when the first bytes arrive.
    struct Tap<'a> {
        seen: &'a std::sync::Mutex<Vec<u8>>,
        first: Option<std::sync::mpsc::Sender<()>>,
    }

    impl Write for Tap<'_> {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.seen.lock().unwrap().extend_from_slice(bytes);
            if let Some(first) = self.first.take() {
                let _ = first.send(());
            }
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// A run reads as finished as soon as its runner saved the state, but the runner's last log line (the verdict
    /// line `session-pace` and the caller read) may come after: an attached caller returns only once the runner let
    /// go of `alive`, and then has every line.
    #[test]
    fn an_attached_caller_returns_only_after_the_runner_let_go_and_keeps_its_last_line() {
        let dir = std::env::temp_dir().join(format!("ompdesk-attach-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = Store::open(dir.clone()).unwrap();
        let mut run = earlier_run(&store, "0001", "passed", "same");
        run.state = State::Passed;
        store.write(&run).unwrap();
        store
            .append("0001", "log", "ompdesk check: running")
            .unwrap();
        let alive = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(store.file("0001", "alive"))
            .unwrap();
        alive.lock().unwrap();

        let seen = std::sync::Mutex::new(Vec::new());
        let (first, first_seen) = std::sync::mpsc::channel();
        let (done, finished) = std::sync::mpsc::channel();
        let code = std::thread::scope(|scope| {
            scope.spawn(|| {
                let mut tap = Tap {
                    seen: &seen,
                    first: Some(first),
                };
                let _ = done.send(attach_to(&store, "0001", &mut tap));
            });
            // The caller has read the log's first line, so it is attached; the state it reads is already finished.
            first_seen.recv().unwrap();
            assert!(
                finished.recv_timeout(Duration::from_millis(300)).is_err(),
                "the caller returned while the runner still held alive"
            );
            store
                .append(
                    "0001",
                    "log",
                    "ompdesk check: 0001: passed — verdict /x/verdict.txt",
                )
                .unwrap();
            drop(alive);
            finished.recv().unwrap()
        });
        assert_eq!(code, 0);
        let text = String::from_utf8(seen.into_inner().unwrap()).unwrap();
        assert!(text.contains("passed — verdict /x/verdict.txt"), "{text}");
        let _ = fs::remove_dir_all(dir);
    }
}
