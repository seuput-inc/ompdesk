#![allow(clippy::type_complexity)] // the stand-in seams' closure types, spelled where the test builds them
//! Machine setup's part against a stand-in machine, as `src/main/setup/service.test.ts` drove `SetupService`: detection
//! and the installer are the test's (`Seams`), the queue, the ledger, the plans, the downloads and the lookups (through
//! a server on 127.0.0.1) are the real ones. Each test names the TypeScript case it ports.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio::task::LocalSet;

use super::detect::{Detection, bun_for_omp, git_shell_problem};
use super::ledger::BACKOFF_MS;
use super::plans::OMP_PACKAGE;
use super::*;
use crate::hub::LocalFuture;
use crate::tools::queue::{Ctx, STEP_MAX_MS, StepKind};
use crate::tools::runner::{FailedBy, Ran, RunOutcome, SpawnSpec, Supervisor};
use crate::tools::{Main, Tools, call_tools};

/// The omp this release was tested with, as main passes it (`testedOmp`).
const TESTED_OMP_VERSION: &str = "19.0.0";

fn present(version: &str) -> Presence {
    Presence::Present {
        version: Some(version.to_owned()),
        path: Some("/bin/x".to_owned()),
        git_shell: None,
        git_aslr_override: None,
        git_aslr_undoable: None,
    }
}

fn outdated(version: &str, minimum: &str, path: &str) -> Presence {
    Presence::Outdated {
        version: version.to_owned(),
        minimum: minimum.to_owned(),
        path: Some(path.to_owned()),
    }
}

fn broken(detail: &str, path: Option<&str>) -> Presence {
    Presence::Broken {
        detail: detail.to_owned(),
        path: path.map(str::to_owned),
    }
}

const COMPILED: &str = "a compiled omp, not the package OMPdesk runs";

struct Machine {
    presence: HashMap<&'static str, Presence>,
    brew: Option<String>,
    winget: Option<String>,
}

/// `machine(partial, managers)`: everything present but what `partial` names; Homebrew, no winget.
fn machine(partial: &[(&'static str, Presence)]) -> Machine {
    let mut presence: HashMap<&'static str, Presence> = [
        ("bun", present("1.0.0")),
        ("git", present("1.0.0")),
        ("omp", present("18.9.0")),
        ("gh", present("1.0.0")),
        ("node", present("v24.11.0")),
        ("agent-desktop", present("1.2.0")),
        ("tailscale", present("1.104.1")),
    ]
    .into_iter()
    .collect();
    for (id, found) in partial {
        presence.insert(id, found.clone());
    }
    Machine {
        presence,
        brew: Some("/opt/homebrew/bin/brew".to_owned()),
        winget: None,
    }
}

// ---- a server on 127.0.0.1 standing in for every host ----------------------------------------------------------

/// What the mirror answers for one real address.
#[derive(Clone)]
enum Answer {
    Status(u16, Vec<u8>),
    Text(String),
    /// `length` announced, `first` sent, the rest once `gate` is notified (never, without one).
    Held {
        length: usize,
        first: Vec<u8>,
        gate: Option<Arc<tokio::sync::Notify>>,
        rest: Vec<u8>,
    },
}

type Answers = Arc<Mutex<Box<dyn Fn(&str) -> Option<Answer> + Send>>>;

struct Mirror {
    url: String,
    asked: Arc<Mutex<Vec<String>>>,
    answers: Answers,
}

impl Mirror {
    async fn start() -> Mirror {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let asked: Arc<Mutex<Vec<String>>> = Arc::default();
        let answers: Answers = Arc::new(Mutex::new(Box::new(|_| None)));
        let (log, routes) = (Arc::clone(&asked), Arc::clone(&answers));
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let (log, routes) = (Arc::clone(&log), Arc::clone(&routes));
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        if socket.read(&mut byte).await.unwrap_or(0) == 0 {
                            return;
                        }
                        head.push(byte[0]);
                    }
                    let text = String::from_utf8_lossy(&head);
                    let path = text.split(' ').nth(1).unwrap_or_default();
                    let real = format!("https:/{path}");
                    log.lock().unwrap().push(real.clone());
                    let answer = (routes.lock().unwrap())(&real);
                    let (status, length, first, gate, rest) = match answer {
                        Some(Answer::Status(status, body)) => {
                            (status, body.len(), body, None, Vec::new())
                        }
                        Some(Answer::Text(text)) => {
                            (200, text.len(), text.into_bytes(), None, Vec::new())
                        }
                        Some(Answer::Held {
                            length,
                            first,
                            gate,
                            rest,
                        }) => (200, length, first, Some(gate), rest),
                        None => (404, 9, b"not found".to_vec(), None, Vec::new()),
                    };
                    let head = format!(
                        "HTTP/1.1 {status} X\r\nconnection: close\r\ncontent-length: {length}\r\n\r\n"
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&first).await;
                    let _ = socket.flush().await;
                    if let Some(gate) = gate {
                        match gate {
                            Some(gate) => gate.notified().await,
                            None => std::future::pending::<()>().await,
                        }
                        let _ = socket.write_all(&rest).await;
                    }
                    let _ = socket.shutdown().await;
                });
            }
        });
        Mirror {
            url,
            asked,
            answers,
        }
    }

    fn serve(&self, answer: impl Fn(&str) -> Option<Answer> + Send + 'static) {
        *self.answers.lock().unwrap() = Box::new(answer);
        self.asked.lock().unwrap().clear();
    }

    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
}

// ---- main as the test sees it ---------------------------------------------------------------------------------

#[derive(Default)]
struct FakeMain {
    items: RefCell<Vec<Value>>,
    asked: RefCell<Vec<String>>,
    env: RefCell<Option<Env>>,
    omp_ready: Cell<u32>,
    first_tab: RefCell<Option<Rc<Notify>>>,
    released: Cell<u32>,
}

impl Main for FakeMain {
    fn push(&self, item: Value) {
        self.items.borrow_mut().push(item);
    }

    fn ask(&self, q: &str, _: Value) -> LocalFuture<Result<Value, crate::server::Fault>> {
        self.asked.borrow_mut().push(q.to_owned());
        let answer = match q {
            "env" => Ok(json!(self.env.borrow().clone().unwrap_or_else(|| {
                [("PATH".to_owned(), "/usr/bin".to_owned())].into()
            }))),
            "ompReady" => {
                self.omp_ready.set(self.omp_ready.get() + 1);
                Ok(Value::Null)
            }
            "firstTab" => {
                let gate = self.first_tab.borrow().clone();
                return Box::pin(async move {
                    if let Some(gate) = gate {
                        gate.notified().await;
                    }
                    Ok(Value::Null)
                });
            }
            "releaseHelpers" => {
                self.released.set(self.released.get() + 1);
                Ok(Value::Null)
            }
            "refreshPath" => Ok(Value::Null),
            _ => Err(crate::server::Fault::new("no_answer", q.to_owned())),
        };
        Box::pin(async move { answer })
    }
}

fn spawn_local(task: LocalFuture<()>) {
    tokio::task::spawn_local(task);
}

// ---- the harness --------------------------------------------------------------------------------------------

#[derive(Clone)]
struct Options {
    platform: &'static str,
    automatic: bool,
    test_installer: Option<String>,
    exits: HashMap<&'static str, i32>,
    /// An exit code per `<item> <method>`, over `exits`.
    method_exits: HashMap<&'static str, i32>,
    /// Runs as an `<item> <method>` installer starts.
    on_install: Option<Rc<dyn Fn(&str, &str)>>,
    bun_install: String,
    app_version: String,
    still_missing: Vec<&'static str>,
    output: HashMap<&'static str, &'static str>,
    hold: Option<&'static str>,
    now: Option<u64>,
    test_download: Option<(String, String)>,
    spawn_env: Option<Env>,
    installed_version: &'static str,
    installed: HashMap<&'static str, String>,
    /// What a successful `<item> <method>` install leaves instead of a present item.
    leaves: HashMap<&'static str, Presence>,
    omp_release: Option<Rc<dyn Fn(String, String, Env) -> LocalFuture<Result<Value, String>>>>,
    omp_bin: String,
    tool_exit: i32,
    tool_output: &'static str,
    hold_tool: bool,
    first_tab: Option<Rc<Notify>>,
    bound_ms: u64,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            platform: "darwin",
            automatic: true,
            test_installer: Some("/fake/installer".to_owned()),
            exits: HashMap::new(),
            method_exits: HashMap::new(),
            on_install: None,
            bun_install: "/home/u/.bun".to_owned(),
            app_version: String::new(),
            still_missing: Vec::new(),
            output: HashMap::new(),
            hold: None,
            now: None,
            test_download: None,
            spawn_env: None,
            installed_version: "1.0.0",
            installed: HashMap::new(),
            leaves: HashMap::new(),
            omp_release: Some(Rc::new(|_, _, _| Box::pin(async { Ok(Value::Null) }))),
            omp_bin: "/home/u/.bun/bin/omp".to_owned(),
            tool_exit: 0,
            tool_output: "updating tool",
            hold_tool: false,
            first_tab: None,
            bound_ms: STEP_MAX_MS,
        }
    }
}

struct H {
    tools: Rc<Tools>,
    main: Rc<FakeMain>,
    spawned: Rc<RefCell<Vec<(SpawnSpec, Env)>>>,
    machine: Rc<RefCell<Machine>>,
    dir: PathBuf,
}

/// What an installer's spec says it installs: a setup item, a vendor CLI update (`tool`), or neither.
fn item_of(spec: &SpawnSpec) -> Option<String> {
    let first = spec.args.first().map(String::as_str).unwrap_or_default();
    if ITEMS.contains(&first) {
        return Some(first.to_owned());
    }
    (first == "-c" || first.starts_with("cli-")).then(|| "tool".to_owned())
}

fn ran(code: i32, output: String) -> Ran {
    let outcome = if code == 0 {
        RunOutcome::Succeeded
    } else {
        RunOutcome::Failed {
            reason: FailedBy::Exit,
            exit_code: Some(code),
            detail: output
                .lines()
                .rfind(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_owned()),
        }
    };
    Ran { outcome, output }
}

/// An installer that runs until a stop ends it: `cancelled`, as the supervisor's 130 reads.
async fn held(ctx: Ctx) -> Ran {
    let gate = Rc::new(Notify::new());
    let live = Rc::new(Cell::new(true));
    ctx.on_stop({
        let (gate, live) = (Rc::clone(&gate), Rc::clone(&live));
        move || {
            let was = live.replace(false);
            if was {
                gate.notify_one();
            }
            was
        }
    });
    gate.notified().await;
    Ran {
        outcome: RunOutcome::Cancelled,
        output: String::new(),
    }
}

fn harness_in(dir: &Path, found: Machine, options: Options, mirror: Option<&Mirror>) -> H {
    let machine = Rc::new(RefCell::new(found));
    let main = Rc::new(FakeMain::default());
    *main.env.borrow_mut() = options.spawn_env.clone();
    *main.first_tab.borrow_mut() = options.first_tab.clone();
    let user_data = dir.to_string_lossy().into_owned();
    // A proxy preference keeps the spawn environment from asking the system's (its PAC lookup is slow).
    crate::prefs::set(
        &dir.join("prefs.json").to_string_lossy(),
        "proxyUrl",
        json!("http://127.0.0.1:9"),
    )
    .unwrap();
    let opts: crate::tools::Opts = serde_json::from_value(json!({
        "platform": options.platform,
        "arch": "arm64",
        "toolsDir": dir.join("tools").to_string_lossy(),
        "userData": user_data,
        "appVersion": options.app_version,
        "testedOmp": TESTED_OMP_VERSION,
        "automatic": options.automatic,
        "scheduled": {"omp": false, "cli": false, "ext": false},
        "testInstaller": options.test_installer,
        "testDownload": options.test_download.as_ref().map(|(url, sha256)| json!({"url": url, "sha256": sha256})),
        "manual": options.now.is_some(),
        "now": options.now,
        "systemRoot": "C:\\Windows",
        "bunInstall": options.bun_install,
        "mirror": mirror.map(|mirror| mirror.url.clone()),
    }))
    .unwrap();
    let tools = Tools::new(
        opts,
        main.clone(),
        spawn_local,
        Supervisor::this_binary(),
        options.bound_ms,
    );
    let spawned: Rc<RefCell<Vec<(SpawnSpec, Env)>>> = Rc::default();
    let detect: Rc<dyn Fn() -> LocalFuture<Detection>> = {
        let (machine, omp_bin) = (Rc::clone(&machine), options.omp_bin.clone());
        Rc::new(move || {
            let found = machine.borrow();
            let bun = matches!(
                found.presence["bun"],
                Presence::Present { .. } | Presence::Outdated { .. }
            );
            let omp = matches!(
                found.presence["omp"],
                Presence::Present { .. } | Presence::Outdated { .. }
            );
            let detection = Detection {
                presence: found.presence.clone(),
                bun: bun.then(|| "/home/u/.bun/bin/bun".to_owned()),
                omp: omp.then(|| omp_bin.clone()),
                brew: found.brew.clone(),
                winget: found.winget.clone(),
                path_env: String::new(),
            };
            Box::pin(async move { detection })
        })
    };
    let run = fake_run(Rc::clone(&machine), Rc::clone(&spawned), options.clone());
    tools.setup.borrow_mut().seams = Seams {
        detect: Some(detect),
        run: Some(run),
        omp_release: options.omp_release.clone(),
    };
    H {
        tools,
        main,
        spawned,
        machine,
        dir: dir.to_path_buf(),
    }
}

/// The installer as `service.test.ts`'s `FakeChild` spawner: each install's exit from `exits`; a successful one makes
/// the item present, as a real install would; `hold` runs until a stop.
fn fake_run(
    machine: Rc<RefCell<Machine>>,
    spawned: Rc<RefCell<Vec<(SpawnSpec, Env)>>>,
    options: Options,
) -> RunFn {
    {
        Rc::new(move |ctx, spec, env, output| {
            let (machine, options) = (Rc::clone(&machine), options.clone());
            spawned.borrow_mut().push((spec.clone(), env));
            Box::pin(async move {
                let Some(item) = item_of(&spec) else {
                    return Ran {
                        outcome: RunOutcome::Failed {
                            reason: FailedBy::Spawn,
                            exit_code: None,
                            detail: Some(format!("unexpected spec {}", spec.file)),
                        },
                        output: String::new(),
                    };
                };
                if item == "tool" {
                    if options.hold_tool {
                        return held(ctx).await;
                    }
                    tokio::task::yield_now().await;
                    let text = format!("{}\n", options.tool_output);
                    output(&text);
                    tokio::task::yield_now().await;
                    return ran(options.tool_exit, text);
                }
                if options.hold.is_some_and(|hold| hold == item) {
                    return held(ctx).await;
                }
                let method = spec.args.get(1).cloned().unwrap_or_default();
                if let Some(on_install) = &options.on_install {
                    on_install(&item, &method);
                }
                tokio::task::yield_now().await;
                let id = ITEMS.into_iter().find(|id| *id == item).unwrap();
                let text = format!(
                    "{}\n",
                    options
                        .output
                        .get(id)
                        .map_or_else(|| format!("installing {item}"), |text| (*text).to_owned())
                );
                output(&text);
                let key = format!("{item} {method}");
                let code = options
                    .method_exits
                    .get(key.as_str())
                    .or_else(|| options.exits.get(id))
                    .copied()
                    .unwrap_or(0);
                if code == 0 && !options.still_missing.contains(&id) {
                    let left = options
                        .leaves
                        .get(key.as_str())
                        .cloned()
                        .unwrap_or_else(|| {
                            present(
                                options
                                    .installed
                                    .get(id)
                                    .map_or(options.installed_version, String::as_str),
                            )
                        });
                    machine.borrow_mut().presence.insert(id, left);
                }
                tokio::task::yield_now().await;
                ran(code, text)
            })
        })
    }
}

impl H {
    fn state(&self) -> Value {
        state(&self.tools)
    }

    fn item(&self, id: &str) -> Value {
        self.state()["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id)
            .cloned()
            .unwrap()
    }

    fn phase(&self, id: &str) -> String {
        self.item(id)["phase"].as_str().unwrap().to_owned()
    }

    /// The items the installers ran for, in order (`tool` for a vendor CLI update).
    fn items(&self) -> Vec<String> {
        self.spawned
            .borrow()
            .iter()
            .map(|(spec, _)| item_of(spec).unwrap_or_else(|| "?".to_owned()))
            .collect()
    }

    fn args(&self) -> Vec<Vec<String>> {
        self.spawned
            .borrow()
            .iter()
            .map(|(spec, _)| spec.args.clone())
            .collect()
    }

    fn specs(&self) -> Vec<SpawnSpec> {
        self.spawned
            .borrow()
            .iter()
            .map(|(spec, _)| spec.clone())
            .collect()
    }

    fn env(&self, at: usize) -> Env {
        self.spawned.borrow()[at].1.clone()
    }

    /// Every setup state main was told.
    fn states(&self) -> Vec<Value> {
        self.main
            .items
            .borrow()
            .iter()
            .filter(|item| item["k"] == "state" && item["part"] == "setup")
            .map(|item| item["state"].clone())
            .collect()
    }

    /// The `omp-update` lines of setup's own omp installs: step and details.
    fn omp_installs(&self) -> Vec<(String, Value)> {
        self.main
            .items
            .borrow()
            .iter()
            .filter(|item| item["k"] == "log" && item["source"] == "omp-update")
            .map(|item| {
                (
                    item["message"].as_str().unwrap().to_owned(),
                    item["details"].clone(),
                )
            })
            .collect()
    }

    fn ledger(&self) -> Value {
        std::fs::read_to_string(self.dir.join("setup-state.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(json!({}))
    }

    async fn start(&self) {
        start(&self.tools).await;
    }

    async fn later(&self, method: &str, params: Value) -> Result<Value, crate::server::Fault> {
        let params = serde_json::value::to_raw_value(&params).unwrap();
        match call_tools(&self.tools, method, &params) {
            Outcome::Later(answer) => answer.await,
            Outcome::Now(answer) => answer,
        }
    }

    async fn retry(&self, item: &str) -> Result<Value, crate::server::Fault> {
        self.later("setup.retry", json!({"item": item})).await
    }

    async fn connect(&self, item: &str) -> Result<Value, crate::server::Fault> {
        self.later("setup.installForConnection", json!({"item": item}))
            .await
    }

    fn cancel(&self) -> bool {
        let params = serde_json::value::to_raw_value(&json!({})).unwrap();
        matches!(
            call_tools(&self.tools, "setup.cancel", &params),
            Outcome::Now(Ok(Value::Bool(true)))
        )
    }

    /// Runs `work` as one queued step of `kind` (an updater pass), as the other parts call setup's contract.
    async fn in_step<F, T>(&self, kind: StepKind, work: F) -> Result<Value, crate::server::Fault>
    where
        F: FnOnce(Rc<Tools>, Ctx) -> LocalFuture<T> + 'static,
        T: serde::Serialize + 'static,
    {
        let tools = Rc::clone(&self.tools);
        let step = self
            .tools
            .enqueue("pass", kind, move |ctx| {
                Box::pin(async move { Ok(serde_json::to_value(work(tools, ctx).await).unwrap()) })
            })
            .unwrap();
        step.await
    }

    /// `updateOmp` inline in an omp pass; `hook` hears how many installers had run when the pre-install hook ran.
    async fn update_omp(
        &self,
        target: &str,
        exact_only: bool,
        hook: Rc<RefCell<Vec<usize>>>,
    ) -> Value {
        let target = target.to_owned();
        let spawned = Rc::clone(&self.spawned);
        self.in_step(StepKind::OmpPass, move |tools, ctx| {
            Box::pin(async move {
                let before: BeforeInstall = Box::new(move || {
                    hook.borrow_mut().push(spawned.borrow().len());
                    Box::pin(async { Ok(()) })
                });
                update_omp(&tools, &ctx, &target, before, exact_only)
                    .await
                    .to_json()
            })
        })
        .await
        .unwrap()
    }

    async fn tool_update(&self, request: Value) -> Result<Value, crate::server::Fault> {
        let request: ToolUpdateRequest = serde_json::from_value(request).unwrap();
        self.in_step(StepKind::CliPass, move |tools, ctx| {
            Box::pin(async move { run_tool_update(&tools, &ctx, request).await.to_json() })
        })
        .await
    }
}

/// Runs `test` on a local set with a fresh folder.
fn local<F: Future<Output = ()>>(test: impl FnOnce(PathBuf) -> F) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    runtime.block_on(LocalSet::new().run_until(test(path)));
}

fn harness(dir: &Path, found: Machine, options: Options) -> H {
    harness_in(dir, found, options, None)
}

/// A second harness over the same folder (the ledger), as a later launch.
fn sub(dir: &Path, name: &str) -> PathBuf {
    let sub = dir.join(name);
    std::fs::create_dir_all(&sub).unwrap();
    sub
}

fn sha256(bytes: &[u8]) -> String {
    crate::hex(&Sha256::digest(bytes))
}

async fn until(what: &str, done: impl Fn() -> bool) {
    for _ in 0..2_000 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("never came: {what}");
}

fn exits(pairs: &[(&'static str, i32)]) -> HashMap<&'static str, i32> {
    pairs.iter().copied().collect()
}

// ---- SetupService ---------------------------------------------------------------------------------------------------

/// "installs Bun then omp on its own at launch, then reports omp ready once"
#[test]
fn installs_bun_then_omp_at_launch_and_reports_omp_ready_once() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("bun", Presence::Missing), ("omp", Presence::Missing)]),
            Options::default(),
        );
        h.start().await;
        assert_eq!(h.items(), ["bun", "omp"]);
        assert_eq!(
            h.specs()[0],
            SpawnSpec {
                file: "/fake/installer".into(),
                args: vec!["bun".into(), "bun-script".into()],
                ..SpawnSpec::default()
            }
        );
        assert_eq!(h.args()[1], ["omp", "bun-global"]);
        let env = h.env(0);
        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(
            env.get("BUN_INSTALL").map(String::as_str),
            Some("/home/u/.bun")
        );
        let state = h.state();
        assert_eq!(
            (
                state["ompReady"].clone(),
                state["requiredRunning"].clone(),
                state["automatic"].clone()
            ),
            (json!(true), json!(false), json!(true))
        );
        assert_eq!(h.phase("omp"), "present");
        assert_eq!(h.main.omp_ready.get(), 1);
        let running = h
            .states()
            .into_iter()
            .find(|state| state["items"][0]["phase"] == "running")
            .unwrap();
        assert_eq!(running["requiredRunning"], true);
        assert_eq!(
            running["items"][0]["command"],
            "curl -fsSL https://bun.sh/install | bash"
        );
        assert!(
            h.item("bun")["output"]
                .as_str()
                .unwrap()
                .contains("installing bun")
        );
    });
}

fn compiled_bytes(platform: &str) -> Vec<u8> {
    if platform != "win32" {
        return vec![0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01];
    }
    let mut file = vec![0u8; 0xc0];
    file[..2].copy_from_slice(b"MZ");
    file[0x3c..0x40].copy_from_slice(&0x40u32.to_le_bytes());
    file[0x40..0x44].copy_from_slice(b"PE\0\0");
    file[0x46..0x48].copy_from_slice(&1u16.to_le_bytes());
    file[0x58..0x5c].copy_from_slice(b".bun");
    file
}

const LAUNCHER_SCRIPT: &str = "#!/usr/bin/env bun\n";

/// "restores the compiled launcher symlink, not a copy of its target"
#[cfg(unix)]
#[test]
fn restores_the_compiled_launcher_symlink_not_a_copy() {
    local(|dir| async move {
        let launcher = dir.join("bin").join("omp");
        std::fs::create_dir_all(launcher.parent().unwrap()).unwrap();
        std::fs::write(dir.join("standalone"), compiled_bytes("darwin")).unwrap();
        std::os::unix::fs::symlink("../standalone", &launcher).unwrap();
        let seen = Rc::new(Cell::new(None));
        let h = harness(
            &dir,
            machine(&[("omp", broken(COMPILED, None))]),
            Options {
                bun_install: dir.to_string_lossy().into_owned(),
                exits: exits(&[("omp", 1)]),
                on_install: Some({
                    let (seen, launcher) = (Rc::clone(&seen), launcher.clone());
                    Rc::new(move |_, _| seen.set(Some(launcher.exists())))
                }),
                ..Options::default()
            },
        );
        h.start().await;
        assert_eq!(h.phase("omp"), "failed");
        assert_eq!(seen.get(), Some(false));
        assert_eq!(
            std::fs::read_link(&launcher).unwrap(),
            Path::new("../standalone")
        );
        assert_eq!(
            std::fs::read(dir.join("standalone")).unwrap(),
            compiled_bytes("darwin")
        );
    });
}

/// "<platform>: moves a compiled omp out of the launcher's place so `bun install -g` links the package"
#[test]
fn moves_a_compiled_omp_out_of_the_launchers_place() {
    for platform in ["darwin", "win32"] {
        local(|dir| async move {
            let name = if platform == "win32" {
                "omp.exe"
            } else {
                "omp"
            };
            let root = dir.join("bun");
            let launcher = root.join("bin").join(name);
            std::fs::create_dir_all(launcher.parent().unwrap()).unwrap();
            std::fs::write(&launcher, compiled_bytes(platform)).unwrap();
            std::fs::write(
                format!("{}.ompdesk-compiled-1", launcher.display()),
                "left by an earlier repair",
            )
            .unwrap();
            let seen = Rc::new(Cell::new(None));
            let h = harness(
                &dir,
                machine(&[("omp", broken(COMPILED, None))]),
                Options {
                    platform,
                    bun_install: root.to_string_lossy().into_owned(),
                    on_install: Some({
                        let (seen, launcher) = (Rc::clone(&seen), launcher.clone());
                        Rc::new(move |item, method| {
                            if item == "omp" && method == "bun-global" {
                                seen.set(Some(launcher.exists()));
                                std::fs::write(&launcher, LAUNCHER_SCRIPT).unwrap();
                            }
                        })
                    }),
                    ..Options::default()
                },
            );
            h.start().await;
            assert_eq!(h.args(), [["omp", "bun-global"]]);
            assert_eq!(seen.get(), Some(false), "{platform}");
            assert_eq!(std::fs::read_to_string(&launcher).unwrap(), LAUNCHER_SCRIPT);
            let left: Vec<_> = std::fs::read_dir(launcher.parent().unwrap())
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            assert_eq!(left, [name], "{platform}");
            assert_eq!(h.phase("omp"), "present");
        });
    }
}

/// "<platform>: puts the compiled omp back when the package install fails"
#[test]
fn puts_the_compiled_omp_back_when_the_package_install_fails() {
    for platform in ["darwin", "win32"] {
        local(|dir| async move {
            let name = if platform == "win32" {
                "omp.exe"
            } else {
                "omp"
            };
            let root = dir.join("bun");
            let launcher = root.join("bin").join(name);
            std::fs::create_dir_all(launcher.parent().unwrap()).unwrap();
            std::fs::write(&launcher, compiled_bytes(platform)).unwrap();
            let h = harness(
                &dir,
                machine(&[("omp", broken(COMPILED, None))]),
                Options {
                    platform,
                    bun_install: root.to_string_lossy().into_owned(),
                    exits: exits(&[("omp", 1)]),
                    ..Options::default()
                },
            );
            h.start().await;
            assert_eq!(h.phase("omp"), "failed");
            assert_eq!(std::fs::read(&launcher).unwrap(), compiled_bytes(platform));
            assert_eq!(
                std::fs::read_dir(launcher.parent().unwrap())
                    .unwrap()
                    .count(),
                1
            );
        });
    }
}

/// "<platform>: installs Bun with its official installer when `bun upgrade` fails, then omp"
#[test]
fn installs_bun_with_its_installer_when_bun_upgrade_fails_then_omp() {
    for platform in ["darwin", "win32"] {
        local(|dir| async move {
            let h = harness(
                &dir,
                machine(&[
                    ("bun", outdated("1.4.2", "1.4.4", "/x")),
                    ("omp", broken(COMPILED, None)),
                ]),
                Options {
                    platform,
                    method_exits: [("bun bun-upgrade", 1)].into(),
                    installed: [("bun", "1.4.4".to_owned())].into(),
                    ..Options::default()
                },
            );
            h.start().await;
            assert_eq!(
                h.args(),
                [
                    ["bun", "bun-upgrade"],
                    ["bun", "bun-script"],
                    ["omp", "bun-global"]
                ]
            );
            assert_eq!(h.phase("bun"), "present");
            assert_eq!(h.phase("omp"), "present");
            assert_eq!(h.main.omp_ready.get(), 1);
            // One attempt, though two installers ran; omp's landed and left no miss.
            assert_eq!(h.ledger(), json!({}));
        });
    }
}

/// "<platform>: reinstalls a missing Bun (a `bun upgrade` that left no bun.exe), then omp"
#[test]
fn reinstalls_a_missing_bun_then_omp() {
    for platform in ["darwin", "win32"] {
        local(|dir| async move {
            let h = harness(
                &dir,
                machine(&[
                    ("bun", Presence::Missing),
                    ("omp", broken("bun not found", None)),
                ]),
                Options {
                    platform,
                    ..Options::default()
                },
            );
            h.start().await;
            assert_eq!(h.args(), [["bun", "bun-script"], ["omp", "bun-global"]]);
            assert_eq!(h.state()["ompReady"], true);
        });
    }
}

/// "tries again at once after an OMPdesk update, whatever misses the previous version counted"
#[test]
fn tries_again_at_once_after_an_ompdesk_update() {
    local(|dir| async move {
        let now: u64 = 1_000_000;
        // An hour ago in the clock of the launch before (negative in this test's small clock, as the TypeScript's was).
        let ledger = json!({"bun": {"failures": 3, "lastAttempt": now as i64 - 3_600_000}, "omp": {"failures": 4, "lastAttempt": now}});
        std::fs::write(dir.join("setup-state.json"), ledger.to_string()).unwrap();
        let old = harness(
            &dir,
            machine(&[("bun", Presence::Missing), ("omp", Presence::Missing)]),
            Options {
                now: Some(now),
                ..Options::default()
            },
        );
        old.start().await;
        assert!(old.items().is_empty());
        assert_eq!(old.phase("bun"), "backoff");
        let updated = harness(
            &dir,
            machine(&[("bun", Presence::Missing), ("omp", Presence::Missing)]),
            Options {
                now: Some(now),
                app_version: "0.83.0".into(),
                exits: exits(&[("omp", 1)]),
                ..Options::default()
            },
        );
        updated.start().await;
        assert_eq!(updated.items(), ["bun", "omp"]);
        assert_eq!(
            updated.ledger(),
            json!({"omp": {"failures": 1, "lastAttempt": now, "app": "0.83.0"}})
        );
    });
}

/// "runs the real plan's process when no test installer is set"
#[test]
fn runs_the_real_plans_process_without_a_test_installer() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("omp", outdated("18.0.0", "18.8.7", "/x"))]),
            Options {
                test_installer: None,
                ..Options::default()
            },
        );
        h.start().await;
        assert_eq!(
            h.specs(),
            [SpawnSpec {
                file: "/home/u/.bun/bin/bun".into(),
                args: vec![
                    "install".into(),
                    "-g".into(),
                    format!("{OMP_PACKAGE}@{TESTED_OMP_VERSION}")
                ],
                ..SpawnSpec::default()
            }]
        );
        assert_eq!(h.item("omp")["failure"]["reason"], "spawn");
    });
}

/// "skips present items and installs nothing when automatic setup is off"
#[test]
fn installs_nothing_when_automatic_setup_is_off() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("gh", Presence::Missing)]),
            Options {
                automatic: false,
                ..Options::default()
            },
        );
        h.start().await;
        assert!(h.items().is_empty());
        assert_eq!(h.phase("gh"), "idle");
        assert_eq!(h.phase("bun"), "present");
        assert_eq!(h.main.omp_ready.get(), 0);
    });
}

/// "installs missing optional items in the background after the required ones, skipping present ones"
#[test]
fn installs_missing_optional_items_after_the_required_ones() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[
                ("omp", Presence::Missing),
                ("git", Presence::Missing),
                ("node", Presence::Missing),
            ]),
            Options::default(),
        );
        h.start().await;
        assert_eq!(h.items(), ["omp", "git", "node"]);
        assert_eq!(h.args()[1], ["git", "xcode-select"]);
        assert_eq!(h.args()[2], ["node", "brew"]);
        assert_eq!(h.main.omp_ready.get(), 1);
    });
}

/// "installs agent-desktop on its own on macOS and Windows, with an archive and no package manager"
#[test]
fn installs_agent_desktop_on_its_own_on_macos_and_windows() {
    local(|dir| async move {
        let mac = harness(
            &sub(&dir, "mac"),
            machine(&[("agent-desktop", Presence::Missing)]),
            Options::default(),
        );
        mac.start().await;
        assert_eq!(mac.args(), [["agent-desktop", "agent-desktop-archive"]]);
        assert_eq!(mac.phase("agent-desktop"), "present");
        let windows = harness(
            &sub(&dir, "win"),
            machine(&[("agent-desktop", Presence::Missing)]),
            Options {
                platform: "win32",
                ..Options::default()
            },
        );
        windows.start().await;
        assert_eq!(windows.args(), [["agent-desktop", "agent-desktop-archive"]]);
        assert_eq!(windows.item("agent-desktop")["required"], false);
    });
}

/// "reinstalls an agent-desktop older than agent-desktop mcp's first release"
#[test]
fn reinstalls_an_outdated_agent_desktop() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[(
                "agent-desktop",
                outdated("1.1.0", "1.2.0", "/t/agent-desktop"),
            )]),
            Options::default(),
        );
        h.start().await;
        assert_eq!(h.args(), [["agent-desktop", "agent-desktop-archive"]]);
    });
}

/// "holds the optional installs until main lets them start (the first tab boots alone)"
#[test]
fn holds_the_optional_installs_until_the_first_tab() {
    local(|dir| async move {
        let gate = Rc::new(Notify::new());
        let h = harness(
            &dir,
            machine(&[("omp", Presence::Missing), ("git", Presence::Missing)]),
            Options {
                first_tab: Some(Rc::clone(&gate)),
                ..Options::default()
            },
        );
        let tools = Rc::clone(&h.tools);
        let started = tokio::task::spawn_local(async move { start(&tools).await });
        until("firstTab asked", || {
            h.main.asked.borrow().iter().any(|q| q == "firstTab")
        })
        .await;
        assert_eq!(h.main.omp_ready.get(), 1);
        assert_eq!(h.items(), ["omp"]);
        gate.notify_one();
        started.await.unwrap();
        assert_eq!(h.items(), ["omp", "git"]);
    });
}

/// "leaves the Xcode tools to macOS's dialog and says so"
#[test]
fn leaves_the_xcode_tools_to_macos_dialog() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("git", Presence::Missing)]),
            Options {
                still_missing: vec!["git"],
                ..Options::default()
            },
        );
        h.start().await;
        assert_eq!(h.phase("git"), "requested");
        assert_eq!(h.item("git")["prompt"], "dialog");
    });
}

/// "reports a failure with its exit code, does not try omp without Bun, and does not retry on its own"
#[test]
fn reports_a_failure_and_does_not_retry_on_its_own() {
    local(|dir| async move {
        let found = machine(&[
            ("bun", Presence::Missing),
            ("omp", Presence::Missing),
            ("gh", Presence::Missing),
        ]);
        let h = harness(
            &dir,
            found,
            Options {
                exits: exits(&[("bun", 6)]),
                ..Options::default()
            },
        );
        h.start().await;
        assert_eq!(h.items(), ["bun"]);
        let bun = h.item("bun");
        assert_eq!(
            (bun["phase"].clone(), bun["failure"].clone()),
            (
                json!("failed"),
                json!({"reason": "exit", "exitCode": 6, "detail": "installing bun"})
            )
        );
        assert_eq!(h.item("omp")["phase"], "failed");
        assert_eq!(h.item("omp")["failure"]["reason"], "prerequisite");
        assert_eq!(h.phase("gh"), "idle");
        assert_eq!(h.main.omp_ready.get(), 0);
        h.start().await;
        assert_eq!(h.items(), ["bun"]);
        // The person's retry does, and on success the optional ones follow: Bun's installer works now, as
        // `delete exits.bun` made it in the TypeScript.
        h.tools.setup.borrow_mut().seams.run = Some(fake_run(
            Rc::clone(&h.machine),
            Rc::clone(&h.spawned),
            Options::default(),
        ));
        h.retry("omp").await.unwrap();
        assert_eq!(h.items(), ["bun", "bun", "omp", "gh"]);
        assert_eq!(h.main.omp_ready.get(), 1);
    });
}

/// "calls an install that ends without the item a failure"
#[test]
fn calls_an_install_that_ends_without_the_item_a_failure() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("omp", Presence::Missing)]),
            Options {
                still_missing: vec!["omp"],
                ..Options::default()
            },
        );
        h.start().await;
        assert_eq!(h.item("omp")["failure"], json!({"reason": "not-detected"}));
    });
}

/// "cancels the running install and the rest of its pipeline, as cancelled"
#[test]
fn cancels_the_running_install_and_the_rest_of_its_pipeline() {
    local(|dir| async move {
        let h = Rc::new(harness(
            &dir,
            machine(&[("bun", Presence::Missing), ("omp", Presence::Missing)]),
            Options {
                hold: Some("bun"),
                ..Options::default()
            },
        ));
        let tools = Rc::clone(&h.tools);
        let run = tokio::task::spawn_local(async move { start(&tools).await });
        until("bun runs", || h.phase("bun") == "running").await;
        assert_eq!(h.phase("omp"), "queued");
        assert!(h.cancel());
        run.await.unwrap();
        assert_eq!(h.items(), ["bun"]);
        assert_eq!(h.item("bun")["phase"], "cancelled");
        assert_eq!(h.item("bun")["failure"], Value::Null);
        assert_eq!(h.phase("omp"), "idle");
        assert_eq!(h.state()["requiredRunning"], false);
        assert!(!h.cancel());
    });
}

/// "kills the running install on dispose and starts nothing after it"
#[test]
fn the_close_ends_the_running_install_and_starts_nothing_after_it() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("bun", Presence::Missing), ("omp", Presence::Missing)]),
            Options {
                hold: Some("bun"),
                ..Options::default()
            },
        );
        let tools = Rc::clone(&h.tools);
        let run = tokio::task::spawn_local(async move { start(&tools).await });
        until("bun runs", || h.phase("bun") == "running").await;
        h.tools.close();
        run.await.unwrap();
        assert_eq!(h.retry("bun").await.unwrap_err().code, "tools_closed");
        assert_eq!(h.items(), ["bun"]);
    });
}

/// "does not count a Cancel or a quit mid-install as a miss, so slow first launches never reach the back-off"
#[test]
fn a_cancel_or_a_quit_mid_install_is_not_a_miss() {
    local(|dir| async move {
        std::fs::write(
            dir.join("setup-state.json"),
            json!({"bun": {"failures": 2, "lastAttempt": 1}}).to_string(),
        )
        .unwrap();
        let found = || machine(&[("bun", Presence::Missing), ("omp", Presence::Missing)]);
        let hold = || Options {
            hold: Some("bun"),
            ..Options::default()
        };
        let cancelled = harness(&dir, found(), hold());
        let tools = Rc::clone(&cancelled.tools);
        let first = tokio::task::spawn_local(async move { start(&tools).await });
        until("bun runs", || cancelled.phase("bun") == "running").await;
        assert_eq!(
            cancelled.ledger()["bun"]["failures"],
            3,
            "in the ledger while it runs"
        );
        cancelled.cancel();
        first.await.unwrap();
        assert_eq!(cancelled.ledger()["bun"]["failures"], 2);

        let quit = harness(&dir, found(), hold());
        let tools = Rc::clone(&quit.tools);
        let second = tokio::task::spawn_local(async move { start(&tools).await });
        until("bun runs", || quit.phase("bun") == "running").await;
        quit.tools.close();
        second.await.unwrap();
        assert_eq!(quit.ledger()["bun"]["failures"], 2);

        std::fs::remove_file(dir.join("setup-state.json")).unwrap();
        let fresh = harness(&dir, found(), hold());
        let tools = Rc::clone(&fresh.tools);
        let third = tokio::task::spawn_local(async move { start(&tools).await });
        until("bun runs", || fresh.phase("bun") == "running").await;
        fresh.cancel();
        third.await.unwrap();
        assert_eq!(fresh.ledger(), json!({}));
    });
}

/// "says an installer that could not reach the internet failed on the network, and keeps other errors as exits"
#[test]
fn says_an_offline_installer_failed_on_the_network() {
    local(|dir| async move {
        let offline = harness(
            &sub(&dir, "a"),
            machine(&[("bun", Presence::Missing), ("omp", Presence::Missing)]),
            Options {
                exits: exits(&[("bun", 6)]),
                output: [("bun", "curl: (6) Could not resolve host: bun.sh")].into(),
                ..Options::default()
            },
        );
        offline.start().await;
        assert_eq!(offline.item("bun")["failure"]["reason"], "network");
        assert_eq!(offline.item("bun")["failure"]["exitCode"], 6);
        let refused = harness(
            &sub(&dir, "b"),
            machine(&[("omp", Presence::Missing)]),
            Options { exits: exits(&[("omp", 1)]), output: [("omp", "error: ConnectionRefused downloading package manifest @oh-my-pi/pi-coding-agent")].into(), ..Options::default() },
        );
        refused.start().await;
        assert_eq!(refused.item("omp")["failure"]["reason"], "network");
        let unavailable = harness(
            &sub(&dir, "c"),
            machine(&[("omp", Presence::Missing)]),
            Options {
                exits: exits(&[("omp", 1)]),
                output: [(
                    "omp",
                    "error: GET https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent - 503",
                )]
                .into(),
                ..Options::default()
            },
        );
        unavailable.start().await;
        assert_eq!(unavailable.item("omp")["failure"]["reason"], "exit");
    });
}

/// "backs off after three automatic misses for a day, but a retry always runs"
#[test]
fn backs_off_after_three_misses_for_a_day_but_a_retry_runs() {
    local(|dir| async move {
        let now = 1_000_000;
        std::fs::write(
            dir.join("setup-state.json"),
            json!({"gh": {"failures": 3, "lastAttempt": now - 1000}}).to_string(),
        )
        .unwrap();
        let h = harness(
            &dir,
            machine(&[("gh", Presence::Missing)]),
            Options {
                now: Some(now),
                ..Options::default()
            },
        );
        h.start().await;
        assert!(h.items().is_empty());
        assert_eq!(h.phase("gh"), "backoff");
        let later_now = now + BACKOFF_MS;
        let later = harness(
            &dir,
            machine(&[("gh", Presence::Missing)]),
            Options {
                now: Some(later_now),
                exits: exits(&[("gh", 1)]),
                ..Options::default()
            },
        );
        later.start().await;
        assert_eq!(later.items(), ["gh"]);
        assert_eq!(
            later.ledger(),
            json!({"gh": {"failures": 4, "lastAttempt": later_now}})
        );
        later.retry("gh").await.unwrap();
        assert_eq!(later.items(), ["gh", "gh"]);
    });
}

/// installForConnection: "installs right then past the daily back-off and the once-per-launch rule, and resolves once it ended"
#[test]
fn a_connection_installs_past_the_back_off_and_answers_once_it_ended() {
    local(|dir| async move {
        let now = 1_000_000;
        std::fs::write(
            dir.join("setup-state.json"),
            json!({"gh": {"failures": 3, "lastAttempt": now - 1000}}).to_string(),
        )
        .unwrap();
        let h = harness(
            &dir,
            machine(&[("gh", Presence::Missing)]),
            Options {
                now: Some(now),
                exits: exits(&[("gh", 1)]),
                ..Options::default()
            },
        );
        h.start().await;
        assert_eq!(h.phase("gh"), "backoff");
        assert!(h.items().is_empty());
        let failed = h.connect("gh").await.unwrap();
        assert_eq!(h.items(), ["gh"]);
        assert_eq!(
            (failed["id"].clone(), failed["phase"].clone()),
            (json!("gh"), json!("failed"))
        );
        assert_eq!(
            (
                failed["failure"]["reason"].clone(),
                failed["failure"]["exitCode"].clone()
            ),
            (json!("exit"), json!(1))
        );
        let later = harness(
            &dir,
            machine(&[("gh", Presence::Missing)]),
            Options {
                now: Some(now),
                ..Options::default()
            },
        );
        later.start().await;
        assert_eq!(later.phase("gh"), "backoff");
        let installed = later.connect("gh").await.unwrap();
        assert_eq!(
            (
                installed["phase"].clone(),
                installed["presence"]["kind"].clone()
            ),
            (json!("present"), json!("present"))
        );
        assert_eq!(later.items(), ["gh"]);
    });
}

/// installForConnection: "shows the click's install as queued at once, numbered as its own run"
#[test]
fn a_connection_shows_its_install_queued_at_once() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("node", Presence::Missing)]),
            Options::default(),
        );
        let params = serde_json::value::to_raw_value(&json!({"item": "node"})).unwrap();
        let Outcome::Later(pending) = call_tools(&h.tools, "setup.installForConnection", &params)
        else {
            panic!("answers later")
        };
        assert_eq!(h.phase("node"), "queued");
        pending.await.unwrap();
        let running = h
            .states()
            .into_iter()
            .find(|state| state["items"][4]["phase"] == "running")
            .unwrap();
        assert_eq!(running["items"][4]["progress"]["step"], 1);
        assert_eq!(running["items"][4]["progress"]["steps"], 1);
    });
}

/// installForConnection: "waits behind an install already queued or running, and installs nothing more when that one found the tool"
#[test]
fn a_connection_waits_behind_a_running_install() {
    local(|dir| async move {
        let h = Rc::new(harness(
            &dir,
            machine(&[("gh", Presence::Missing)]),
            Options::default(),
        ));
        let tools = Rc::clone(&h.tools);
        let launch = tokio::task::spawn_local(async move { start(&tools).await });
        tokio::task::yield_now().await;
        let connect = {
            let h = Rc::clone(&h);
            tokio::task::spawn_local(async move { h.connect("gh").await })
        };
        launch.await.unwrap();
        let after = connect.await.unwrap().unwrap();
        assert_eq!(h.items(), ["gh"]);
        assert_eq!(after["phase"], "present");
    });
}

/// installForConnection: "only detects when this launch never installs", "refuses required and unknown items"
#[test]
fn a_connection_only_detects_without_automatic_setup_and_refuses_other_items() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("gh", Presence::Missing)]),
            Options {
                automatic: false,
                ..Options::default()
            },
        );
        assert_eq!(h.connect("gh").await.unwrap()["phase"], "idle");
        assert!(h.items().is_empty());
        for item in ["omp", "claude"] {
            assert!(
                h.connect(item)
                    .await
                    .unwrap_err()
                    .message
                    .starts_with("Not an optional setup item")
            );
        }
    });
}

/// "forgets the misses once the item is found"
#[test]
fn forgets_the_misses_once_the_item_is_found() {
    local(|dir| async move {
        std::fs::write(
            dir.join("setup-state.json"),
            json!({"node": {"failures": 2, "lastAttempt": 1}}).to_string(),
        )
        .unwrap();
        let h = harness(&dir, machine(&[]), Options::default());
        h.start().await;
        assert_eq!(h.ledger(), json!({}));
    });
}

/// "requires Git on Windows (before omp) and marks optional items without winget unavailable"
#[test]
fn requires_git_on_windows_and_marks_optional_items_without_winget_unavailable() {
    local(|dir| async move {
        let mut found = machine(&[
            ("bun", Presence::Missing),
            ("git", Presence::Missing),
            ("omp", Presence::Missing),
            ("gh", Presence::Missing),
            ("node", Presence::Missing),
        ]);
        found.brew = None;
        let h = harness(
            &dir,
            found,
            Options {
                platform: "win32",
                ..Options::default()
            },
        );
        h.start().await;
        assert_eq!(h.items(), ["bun", "git", "omp"]);
        assert_eq!(h.args()[1], ["git", "portable-git"]);
        let required: Vec<Value> = h.state()["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["required"] == true)
            .map(|item| item["id"].clone())
            .collect();
        assert_eq!(required, ["bun", "git", "omp"]);
        assert_eq!(h.phase("gh"), "unavailable");
        assert_eq!(h.phase("node"), "unavailable");
    });
}

/// "starts Windows installers without an inherited PSModulePath, so Windows PowerShell builds its own"
#[test]
fn starts_windows_installers_without_an_inherited_psmodulepath() {
    local(|dir| async move {
        let env: Env = [
            ("Path".to_owned(), "C:\\Windows\\System32".to_owned()),
            ("PSModulePath".to_owned(), "C:\\Program Files\\PowerShell\\7\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules".to_owned()),
        ]
        .into();
        let h = harness(
            &dir,
            machine(&[("bun", Presence::Missing)]),
            Options {
                platform: "win32",
                spawn_env: Some(env),
                ..Options::default()
            },
        );
        h.start().await;
        assert_eq!(h.items(), ["bun"]);
        let env = h.env(0);
        assert_eq!(
            env.get("Path").map(String::as_str),
            Some("C:\\Windows\\System32")
        );
        assert_eq!(
            env.get("BUN_INSTALL").map(String::as_str),
            Some("/home/u/.bun")
        );
        assert!(
            !env.keys()
                .any(|key| key.eq_ignore_ascii_case("PSModulePath"))
        );
    });
}

/// "installs gh and Node from verified archives on a Mac without Homebrew"
#[test]
fn installs_gh_from_a_verified_archive_on_a_mac_without_homebrew() {
    local(|dir| async move {
        let mirror = Mirror::start().await;
        let mut found = machine(&[("gh", Presence::Missing)]);
        found.brew = None;
        let h = harness_in(
            &dir,
            found,
            Options {
                test_installer: None,
                ..Options::default()
            },
            Some(&mirror),
        );
        h.start().await;
        // The release lookup failed (the mirror knows nothing): a download failure, nothing spawned.
        assert!(h.items().is_empty());
        let gh = h.item("gh");
        assert_eq!(
            (
                gh["phase"].clone(),
                gh["method"].clone(),
                gh["failure"]["reason"].clone()
            ),
            (json!("failed"), json!("archive"), json!("download"))
        );
    });
}

/// "numbers each install in its run and stamps when it started, then clears that once it ended"
#[test]
fn numbers_each_install_in_its_run_and_stamps_when_it_started() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[
                ("omp", Presence::Missing),
                ("gh", Presence::Missing),
                ("node", Presence::Missing),
            ]),
            Options {
                now: Some(5000),
                ..Options::default()
            },
        );
        h.start().await;
        let running = |at: usize| {
            h.states()
                .into_iter()
                .map(|state| state["items"][at].clone())
                .find(|item| item["phase"] == "running")
                .unwrap()["progress"]
                .clone()
        };
        assert_eq!(
            running(2),
            json!({"step": 1, "steps": 1, "startedAt": 5000, "download": null})
        );
        assert_eq!(
            running(3),
            json!({"step": 1, "steps": 2, "startedAt": 5000, "download": null})
        );
        assert_eq!(
            running(4),
            json!({"step": 2, "steps": 2, "startedAt": 5000, "download": null})
        );
        assert!(
            h.state()["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["progress"].is_null())
        );
    });
}

/// "downloads a plan's file itself with byte progress before its installer runs, then removes it"
#[test]
fn downloads_a_plans_file_with_byte_progress_then_removes_it() {
    local(|dir| async move {
        let mirror = Mirror::start().await;
        let (a, b) = (vec![1u8; 3000], vec![2u8; 1000]);
        let sha = sha256(&[a.clone(), b.clone()].concat());
        let rest = Arc::new(tokio::sync::Notify::new());
        mirror.serve({
            let rest = Arc::clone(&rest);
            move |_| {
                Some(Answer::Held {
                    length: 4000,
                    first: a.clone(),
                    gate: Some(Arc::clone(&rest)),
                    rest: b.clone(),
                })
            }
        });
        let h = harness_in(
            &dir,
            machine(&[("omp", Presence::Missing)]),
            Options {
                test_download: Some(("https://example.test/omp.bin".into(), sha)),
                hold: Some("omp"),
                ..Options::default()
            },
            Some(&mirror),
        );
        let tools = Rc::clone(&h.tools);
        let run = tokio::task::spawn_local(async move { start(&tools).await });
        until("3000 bytes", || {
            h.item("omp")["progress"]["download"] == json!({"received": 3000, "total": 4000})
        })
        .await;
        assert_eq!(h.item("omp")["phase"], "running");
        assert_eq!(h.item("omp")["progress"]["step"], 1);
        assert!(h.items().is_empty());
        rest.notify_one();
        until("installer runs", || h.items() == ["omp"]).await;
        assert_eq!(h.item("omp")["progress"]["download"], Value::Null);
        let file = dir.join("tools").join(".downloads").join("test-download");
        assert!(file.exists());
        assert_eq!(mirror.asked(), ["https://example.test/omp.bin"]);
        h.cancel();
        run.await.unwrap();
        assert!(!file.exists());
    });
}

/// "fails a download that answers an error or does not match its SHA-256, without running anything"
#[test]
fn fails_a_download_that_answers_an_error_or_another_hash() {
    local(|dir| async move {
        let mirror = Mirror::start().await;
        let download = || Some(("https://example.test/omp.bin".to_owned(), "0".repeat(64)));
        mirror.serve(|_| Some(Answer::Status(404, b"bytes".to_vec())));
        let refused = harness_in(
            &sub(&dir, "a"),
            machine(&[("omp", Presence::Missing)]),
            Options {
                test_download: download(),
                ..Options::default()
            },
            Some(&mirror),
        );
        refused.start().await;
        assert!(refused.items().is_empty());
        let omp = refused.item("omp");
        assert_eq!(
            (omp["phase"].clone(), omp["progress"].clone()),
            (json!("failed"), Value::Null)
        );
        assert_eq!(
            omp["failure"],
            json!({"reason": "download", "detail": "https://example.test/omp.bin answered 404"})
        );
        mirror.serve(|_| Some(Answer::Status(200, b"bytes".to_vec())));
        let tampered = harness_in(
            &sub(&dir, "b"),
            machine(&[("omp", Presence::Missing)]),
            Options {
                test_download: download(),
                ..Options::default()
            },
            Some(&mirror),
        );
        tampered.start().await;
        assert!(tampered.items().is_empty());
        let failure = tampered.item("omp")["failure"].clone();
        assert_eq!(failure["reason"], "checksum");
        assert!(failure["detail"].as_str().unwrap().starts_with(&format!(
            "SHA-256 mismatch: expected {}, got ",
            "0".repeat(64)
        )));
    });
}

/// "cancels a running download as cancelled, and runs nothing after it"
#[test]
fn cancels_a_running_download_as_cancelled() {
    local(|dir| async move {
        let mirror = Mirror::start().await;
        mirror.serve(|_| {
            Some(Answer::Held {
                length: 100,
                first: vec![0; 10],
                gate: None,
                rest: Vec::new(),
            })
        });
        let h = Rc::new(harness_in(
            &dir,
            machine(&[("bun", Presence::Missing), ("omp", Presence::Missing)]),
            Options {
                test_download: Some(("https://example.test/x".into(), "0".repeat(64))),
                ..Options::default()
            },
            Some(&mirror),
        ));
        let tools = Rc::clone(&h.tools);
        let run = tokio::task::spawn_local(async move { start(&tools).await });
        until("10 bytes", || {
            h.item("bun")["progress"]["download"]["received"] == 10
        })
        .await;
        assert!(h.cancel());
        run.await.unwrap();
        assert!(h.items().is_empty());
        let bun = h.item("bun");
        assert_eq!(
            (
                bun["phase"].clone(),
                bun["failure"].clone(),
                bun["progress"].clone()
            ),
            (json!("cancelled"), Value::Null, Value::Null)
        );
        assert_eq!(h.phase("omp"), "idle");
    });
}

/// "refuses an unknown item id"
#[test]
fn refuses_an_unknown_item_id() {
    local(|dir| async move {
        let h = harness(&dir, machine(&[]), Options::default());
        assert!(
            h.retry("rm -rf /")
                .await
                .unwrap_err()
                .message
                .starts_with("Unknown setup item")
        );
        let fault = h.later("setup.retry", json!({})).await.unwrap_err();
        assert!(fault.message.starts_with("Unknown setup item"));
        assert!(h.items().is_empty());
    });
}

// ---- the omp it installs is the one it names -----------------------------------------------------------------------

/// A Bun root as `bun install -g` leaves it: its global omp package and pins.
fn bun_root(dir: &Path, pins: Value) -> (String, String) {
    let root = dir.join("bun");
    let global = root.join("install").join("global");
    std::fs::create_dir_all(
        global
            .join("node_modules")
            .join("@oh-my-pi")
            .join("pi-coding-agent"),
    )
    .unwrap();
    std::fs::write(
        global
            .join("node_modules")
            .join("@oh-my-pi")
            .join("pi-coding-agent")
            .join("package.json"),
        "{}",
    )
    .unwrap();
    std::fs::write(
        global.join("package.json"),
        json!({"dependencies": pins}).to_string(),
    )
    .unwrap();
    (
        root.to_string_lossy().into_owned(),
        root.join("bin").join("omp").to_string_lossy().into_owned(),
    )
}

/// "installs the tested omp for a missing omp, never whatever the registry calls newest"
#[test]
fn installs_the_tested_omp_for_a_missing_omp() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("omp", Presence::Missing)]),
            Options {
                test_installer: None,
                ..Options::default()
            },
        );
        h.start().await;
        assert_eq!(
            h.args(),
            [vec![
                "install".to_owned(),
                "-g".into(),
                format!("{OMP_PACKAGE}@{TESTED_OMP_VERSION}")
            ]]
        );
        assert_eq!(h.specs()[0].file, "/home/u/.bun/bin/bun");
    });
}

/// "brings a too-old omp Bun manages to the tested omp as a package, with the natives its manifest pins"
#[test]
fn brings_a_too_old_bun_omp_to_the_tested_omp_with_its_natives() {
    local(|dir| async move {
        let (root, omp) = bun_root(
            &dir,
            json!({OMP_PACKAGE: "18.0.0", "@oh-my-pi/pi-natives": "18.0.0", "@oh-my-pi/pi-natives-darwin-arm64": "18.0.0"}),
        );
        let h = harness(
            &dir,
            machine(&[("omp", outdated("18.0.0", "18.18.9", &omp))]),
            Options {
                test_installer: None,
                bun_install: root,
                omp_bin: omp,
                ..Options::default()
            },
        );
        h.start().await;
        let v = TESTED_OMP_VERSION;
        assert_eq!(
            h.args(),
            [vec![
                "install".to_owned(),
                "-g".into(),
                format!("{OMP_PACKAGE}@{v}"),
                format!("@oh-my-pi/pi-natives@{v}"),
                format!("@oh-my-pi/pi-natives-darwin-arm64@{v}")
            ]]
        );
    });
}

/// "updates an omp Bun manages to exactly the target, in that omp's own Bun root"
#[test]
fn updates_a_bun_omp_to_exactly_the_target_in_its_own_root() {
    local(|dir| async move {
        let (root, omp) = bun_root(
            &dir,
            json!({OMP_PACKAGE: "18.22.0", "@oh-my-pi/pi-natives": "18.22.0"}),
        );
        let h = harness(
            &dir,
            machine(&[("omp", present("18.22.0"))]),
            Options {
                test_installer: None,
                omp_bin: omp,
                ..Options::default()
            },
        );
        let hook: Rc<RefCell<Vec<usize>>> = Rc::default();
        h.update_omp("18.22.2", true, Rc::clone(&hook)).await;
        assert_eq!(hook.borrow().len(), 1);
        assert_eq!(h.specs()[0].file, "/home/u/.bun/bin/bun");
        assert_eq!(
            h.args(),
            [[
                "install",
                "-g",
                &format!("{OMP_PACKAGE}@18.22.2"),
                "@oh-my-pi/pi-natives@18.22.2"
            ]]
        );
        assert_eq!(h.env(0).get("BUN_INSTALL"), Some(&root));
    });
}

/// "reports the version a package update left, and what it ran"
#[test]
fn reports_the_version_a_package_update_left() {
    local(|dir| async move {
        let (_, omp) = bun_root(&dir, json!({}));
        let h = harness(
            &dir,
            machine(&[("omp", present("18.22.0"))]),
            Options {
                omp_bin: omp,
                installed_version: "18.22.2",
                ..Options::default()
            },
        );
        assert_eq!(
            h.update_omp("18.22.2", false, Rc::default()).await,
            json!({"kind": "updated", "version": "18.22.2"})
        );
        assert_eq!(h.args(), [["omp", "bun-global"]]);
        let item = h.item("omp");
        assert_eq!(
            (
                item["phase"].clone(),
                item["method"].clone(),
                item["failure"].clone()
            ),
            (json!("present"), json!("bun-global"), Value::Null)
        );
        assert!(
            item["command"]
                .as_str()
                .unwrap()
                .contains(&format!("install -g {OMP_PACKAGE}@18.22.2"))
        );
    });
}

/// "leaves an omp Bun does not manage alone when only a named version may be installed"
#[test]
fn leaves_an_unmanaged_omp_alone_when_only_a_named_version_may_be_installed() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("omp", present("18.22.0"))]),
            Options::default(),
        );
        let hook: Rc<RefCell<Vec<usize>>> = Rc::default();
        assert_eq!(
            h.update_omp("18.22.2", true, Rc::clone(&hook)).await,
            json!({"kind": "skipped"})
        );
        assert_eq!(hook.borrow().len(), 0);
        assert!(h.items().is_empty());
    });
}

/// An npm prefix as `npm install -g` leaves it on POSIX: the package, its linked launcher, the prefix's npm.
#[cfg(unix)]
fn npm_prefix(dir: &Path) -> (String, String, String) {
    let prefix = std::fs::canonicalize(dir).unwrap().join("npm");
    let pkg = prefix
        .join("lib")
        .join("node_modules")
        .join("@oh-my-pi")
        .join("pi-coding-agent");
    std::fs::create_dir_all(pkg.join("src")).unwrap();
    std::fs::write(pkg.join("src").join("cli.ts"), "").unwrap();
    std::fs::create_dir_all(prefix.join("bin")).unwrap();
    std::fs::write(prefix.join("bin").join("npm"), "").unwrap();
    std::os::unix::fs::symlink(
        pkg.join("src").join("cli.ts"),
        prefix.join("bin").join("omp"),
    )
    .unwrap();
    let text = |path: PathBuf| path.to_string_lossy().into_owned();
    (
        text(prefix.clone()),
        text(prefix.join("bin").join("omp")),
        text(prefix.join("bin").join("npm")),
    )
}

/// "updates an omp npm owns to exactly the target through that npm, also when only a named version may be installed"
#[cfg(unix)]
#[test]
fn updates_an_npm_omp_to_exactly_the_target_through_that_npm() {
    local(|dir| async move {
        let (prefix, omp, npm) = npm_prefix(&dir);
        let h = harness(
            &dir,
            machine(&[("omp", present("18.22.0"))]),
            Options {
                test_installer: None,
                omp_bin: omp.clone(),
                ..Options::default()
            },
        );
        let hook: Rc<RefCell<Vec<usize>>> = Rc::default();
        h.update_omp("18.22.2", true, Rc::clone(&hook)).await;
        assert_eq!(hook.borrow().len(), 1);
        assert_eq!(
            h.specs(),
            [SpawnSpec {
                file: npm,
                args: [
                    "install",
                    "-g",
                    "--prefix",
                    &prefix,
                    &format!("{OMP_PACKAGE}@18.22.2")
                ]
                .map(str::to_owned)
                .to_vec(),
                ..SpawnSpec::default()
            }]
        );
        let path = h.env(0)["PATH"].clone();
        assert_eq!(
            path.split(':').next(),
            Some(paths::dirname(false, &omp).as_str())
        );
    });
}

/// "brings a too-old omp npm owns to the tested omp through that npm, never stock's own pick"
#[cfg(unix)]
#[test]
fn brings_a_too_old_npm_omp_to_the_tested_omp_through_that_npm() {
    local(|dir| async move {
        let (prefix, omp, npm) = npm_prefix(&dir);
        let h = harness(
            &dir,
            machine(&[("omp", outdated("18.0.0", "18.18.9", &omp))]),
            Options {
                test_installer: None,
                omp_bin: omp,
                ..Options::default()
            },
        );
        h.start().await;
        assert_eq!(
            h.specs(),
            [SpawnSpec {
                file: npm,
                args: [
                    "install",
                    "-g",
                    "--prefix",
                    &prefix,
                    &format!("{OMP_PACKAGE}@{TESTED_OMP_VERSION}")
                ]
                .map(str::to_owned)
                .to_vec(),
                ..SpawnSpec::default()
            }]
        );
    });
}

/// "finds the newest release of one major in the update's registry, for an omp it can install by name"
#[test]
fn finds_the_newest_release_of_one_major() {
    local(|dir| async move {
        let (root, omp) = bun_root(&dir, json!({}));
        let asked: Rc<RefCell<Vec<(String, String, Option<String>)>>> = Rc::default();
        let answer: Rc<RefCell<Result<Value, String>>> =
            Rc::new(RefCell::new(Ok(json!({"version": "18.22.2"}))));
        let release: Rc<dyn Fn(String, String, Env) -> LocalFuture<Result<Value, String>>> = {
            let (asked, answer) = (Rc::clone(&asked), Rc::clone(&answer));
            Rc::new(move |bun, version, env| {
                asked
                    .borrow_mut()
                    .push((bun, version, env.get("BUN_INSTALL").cloned()));
                let answer = answer.borrow().clone();
                Box::pin(async move { answer })
            })
        };
        let h = harness(
            &dir,
            machine(&[("omp", present("18.22.0"))]),
            Options {
                automatic: false,
                omp_bin: omp,
                omp_release: Some(release),
                ..Options::default()
            },
        );
        h.start().await;
        assert_eq!(
            newest_omp_in(&h.tools, 18).await,
            Ok(Some("18.22.2".into()))
        );
        assert_eq!(
            *asked.borrow(),
            [(
                "/home/u/.bun/bin/bun".to_owned(),
                "18".to_owned(),
                Some(root)
            )]
        );
        *answer.borrow_mut() = Ok(json!({"version": "19.0.0"}));
        assert_eq!(newest_omp_in(&h.tools, 18).await, Ok(None));
        *answer.borrow_mut() = Ok(Value::Null);
        assert_eq!(newest_omp_in(&h.tools, 18).await, Ok(None));
        *answer.borrow_mut() = Err("503 Service Unavailable".into());
        assert_eq!(
            newest_omp_in(&h.tools, 18).await,
            Err("503 Service Unavailable".into())
        );
    });
}

/// "names no release for an omp Bun does not manage, without asking the registry"
#[test]
fn names_no_release_for_an_unmanaged_omp() {
    local(|dir| async move {
        let asked = Rc::new(Cell::new(0));
        let release: Rc<dyn Fn(String, String, Env) -> LocalFuture<Result<Value, String>>> = {
            let asked = Rc::clone(&asked);
            Rc::new(move |_, _, _| {
                asked.set(asked.get() + 1);
                Box::pin(async { Ok(json!({"version": "18.22.2"})) })
            })
        };
        let h = harness(
            &dir,
            machine(&[("omp", present("18.22.0"))]),
            Options {
                automatic: false,
                omp_release: Some(release),
                ..Options::default()
            },
        );
        h.start().await;
        assert_eq!(newest_omp_in(&h.tools, 18).await, Ok(None));
        assert_eq!(asked.get(), 0);
    });
}

/// "writes a line when its own omp install starts and when it ends, with the version that landed or the reason"
#[test]
fn writes_a_line_when_its_own_omp_install_starts_and_ends() {
    local(|dir| async move {
        let command =
            format!("\"/home/u/.bun/bin/bun\" install -g {OMP_PACKAGE}@{TESTED_OMP_VERSION}");
        let ok = harness(
            &sub(&dir, "a"),
            machine(&[("omp", Presence::Missing)]),
            Options {
                installed: [("omp", "18.22.2".to_owned())].into(),
                ..Options::default()
            },
        );
        ok.start().await;
        assert_eq!(
            ok.omp_installs(),
            [
                (
                    "started".to_owned(),
                    json!({"path": "setup", "method": "bun-global", "command": command})
                ),
                (
                    "finished".to_owned(),
                    json!({"path": "setup", "method": "bun-global", "command": command, "version": "18.22.2"})
                ),
            ]
        );
        let failed = harness(
            &sub(&dir, "b"),
            machine(&[("omp", Presence::Missing)]),
            Options {
                exits: exits(&[("omp", 1)]),
                ..Options::default()
            },
        );
        failed.start().await;
        assert_eq!(
            failed.omp_installs(),
            [
                (
                    "started".to_owned(),
                    json!({"path": "setup", "method": "bun-global", "command": command})
                ),
                (
                    "failed".to_owned(),
                    json!({"path": "setup", "method": "bun-global", "command": command, "reason": "exit"})
                ),
            ]
        );
        let other = harness(
            &sub(&dir, "c"),
            machine(&[("bun", Presence::Missing)]),
            Options::default(),
        );
        other.start().await;
        assert!(other.omp_installs().is_empty());
    });
}

/// "for a too-old omp neither Bun nor npm owns, launch setup and the repair path install the tested omp with Bun and never run stock `omp update`"
#[test]
fn a_too_old_unowned_omp_gets_the_tested_omp_with_bun_never_stocks_update() {
    local(|dir| async move {
        let npm_omp = outdated("18.0.0", "18.18.9", "/usr/local/bin/omp");
        let tested = SpawnSpec {
            file: "/home/u/.bun/bin/bun".into(),
            args: vec![
                "install".into(),
                "-g".into(),
                format!("{OMP_PACKAGE}@{TESTED_OMP_VERSION}"),
            ],
            ..SpawnSpec::default()
        };
        let real = harness(
            &sub(&dir, "a"),
            machine(&[("omp", npm_omp.clone())]),
            Options {
                test_installer: None,
                omp_bin: "/usr/local/bin/omp".into(),
                ..Options::default()
            },
        );
        real.start().await;
        real.retry("omp").await.unwrap();
        assert_eq!(real.specs(), [tested.clone(), tested]);
        let h = harness(
            &sub(&dir, "b"),
            machine(&[("omp", npm_omp)]),
            Options {
                omp_bin: "/usr/local/bin/omp".into(),
                installed: [("omp", TESTED_OMP_VERSION.to_owned())].into(),
                ..Options::default()
            },
        );
        h.start().await;
        assert_eq!(h.args(), [["omp", "bun-global"]]);
        let omp = h.item("omp");
        assert_eq!(
            (
                omp["phase"].clone(),
                omp["method"].clone(),
                omp["presence"]["version"].clone()
            ),
            (
                json!("present"),
                json!("bun-global"),
                json!(TESTED_OMP_VERSION)
            )
        );
        let steps: Vec<(String, Value)> = h
            .omp_installs()
            .into_iter()
            .map(|(step, details)| (step, details["method"].clone()))
            .collect();
        assert_eq!(
            steps,
            [
                ("started".to_owned(), json!("bun-global")),
                ("finished".to_owned(), json!("bun-global"))
            ]
        );
        assert_eq!(h.main.omp_ready.get(), 1);
    });
}

/// "holds a too-old omp while Bun cannot be installed: no install of omp, one line saying why, and the setup state says omp needs Bun"
#[test]
fn holds_a_too_old_omp_while_bun_cannot_be_installed() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[
                ("bun", Presence::Missing),
                ("omp", outdated("18.0.0", "18.18.9", "/usr/local/bin/omp")),
            ]),
            Options {
                exits: exits(&[("bun", 6)]),
                omp_bin: "/usr/local/bin/omp".into(),
                ..Options::default()
            },
        );
        h.start().await;
        assert_eq!(h.items(), ["bun"]);
        assert_eq!(
            h.omp_installs(),
            [(
                "skipped".to_owned(),
                json!({"path": "setup", "method": "bun-global", "reason": "no-bun"})
            )]
        );
        let omp = h.item("omp");
        assert_eq!(
            (omp["phase"].clone(), omp["failure"].clone()),
            (
                json!("failed"),
                json!({"reason": "prerequisite", "detail": "bun"})
            )
        );
        assert_eq!(
            (
                omp["presence"]["kind"].clone(),
                omp["presence"]["version"].clone()
            ),
            (json!("outdated"), json!("18.0.0"))
        );
    });
}

// ---- updateOmp ---------------------------------------------------------------------------------------------------

/// "runs the omp-update plan under the supervisor after the pre-install hook, without touching the ledger or announcing omp ready"
#[test]
fn update_omp_runs_after_the_hook_without_the_ledger_or_omp_ready() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("omp", present("18.8.7"))]),
            Options {
                installed_version: "18.9.0",
                ..Options::default()
            },
        );
        let hook: Rc<RefCell<Vec<usize>>> = Rc::default();
        assert_eq!(
            h.update_omp("18.9.0", false, Rc::clone(&hook)).await,
            json!({"kind": "updated", "version": "18.9.0"})
        );
        assert_eq!(*hook.borrow(), [0], "the hook ran before any installer");
        assert_eq!(h.args(), [["omp", "omp-update"]]);
        let omp = h.item("omp");
        assert_eq!(
            (
                omp["phase"].clone(),
                omp["method"].clone(),
                omp["progress"].clone(),
                omp["failure"].clone()
            ),
            (
                json!("present"),
                json!("omp-update"),
                Value::Null,
                Value::Null
            )
        );
        assert_eq!(omp["presence"]["version"], "18.9.0");
        assert!(
            h.states()
                .iter()
                .any(|state| state["items"][2]["phase"] == "running")
        );
        assert_eq!(h.main.omp_ready.get(), 0);
        assert!(!dir.join("setup-state.json").exists());
    });
}

/// "counts the installed core of a canary target as updated (omp --version prints no prerelease tag)"
#[test]
fn update_omp_counts_a_canary_targets_core_as_updated() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("omp", present("18.8.7"))]),
            Options {
                installed_version: "18.9.0",
                ..Options::default()
            },
        );
        assert_eq!(
            h.update_omp("18.9.0-canary.3", false, Rc::default()).await,
            json!({"kind": "updated", "version": "18.9.0"})
        );
    });
}

/// "runs stock `omp update` on the detected omp when no test installer is set"
#[test]
fn update_omp_runs_stocks_update_on_the_detected_omp() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("omp", present("18.8.7"))]),
            Options {
                test_installer: None,
                ..Options::default()
            },
        );
        let outcome = h.update_omp("18.9.0", false, Rc::default()).await;
        assert_eq!(
            h.specs(),
            [SpawnSpec {
                file: "/home/u/.bun/bin/omp".into(),
                args: vec!["update".into()],
                ..SpawnSpec::default()
            }]
        );
        assert_eq!(outcome["kind"], "failed");
        assert_eq!(outcome["failure"]["reason"], "install");
    });
}

/// "reports a failing installer with its exit code and last output, and leaves omp as it was"
#[test]
fn update_omp_reports_a_failing_installer() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("omp", present("18.8.7"))]),
            Options {
                exits: exits(&[("omp", 1)]),
                ..Options::default()
            },
        );
        assert_eq!(
            h.update_omp("18.9.0", false, Rc::default()).await,
            json!({"kind": "failed", "failure": {"reason": "install", "detail": "exit 1 — installing omp"}})
        );
        assert_eq!(h.phase("omp"), "present");
        assert_eq!(h.item("omp")["presence"]["version"], "18.8.7");
    });
}

/// "calls a clean exit that leaves omp older than the announced version a failure"
#[test]
fn update_omp_calls_an_omp_left_older_not_updated() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("omp", present("18.8.7"))]),
            Options {
                still_missing: vec!["omp"],
                ..Options::default()
            },
        );
        assert_eq!(
            h.update_omp("18.9.0", false, Rc::default()).await["failure"]["reason"],
            "not-updated"
        );
    });
}

/// "skips when omp is missing (the install pipeline owns that) without running the hook", "skips on a platform without setup"
#[test]
fn update_omp_skips_a_missing_omp_and_a_platform_without_setup() {
    local(|dir| async move {
        let h = harness(
            &sub(&dir, "a"),
            machine(&[("omp", Presence::Missing)]),
            Options::default(),
        );
        let hook: Rc<RefCell<Vec<usize>>> = Rc::default();
        assert_eq!(
            h.update_omp("18.9.0", false, Rc::clone(&hook)).await,
            json!({"kind": "skipped"})
        );
        assert_eq!(hook.borrow().len(), 0);
        assert!(h.items().is_empty());
        let other = harness(
            &sub(&dir, "b"),
            machine(&[("omp", present("18.8.7"))]),
            Options {
                platform: "other",
                ..Options::default()
            },
        );
        assert_eq!(
            other.update_omp("18.9.0", false, Rc::default()).await,
            json!({"kind": "skipped"})
        );
        assert!(other.items().is_empty());
    });
}

/// "a cancel from This computer ends the update as cancelled"
#[test]
fn update_omp_ends_as_cancelled_on_a_cancel() {
    local(|dir| async move {
        let h = Rc::new(harness(
            &dir,
            machine(&[("omp", present("18.8.7"))]),
            Options {
                hold: Some("omp"),
                ..Options::default()
            },
        ));
        let run = {
            let h = Rc::clone(&h);
            tokio::task::spawn_local(
                async move { h.update_omp("18.9.0", false, Rc::default()).await },
            )
        };
        until("omp runs", || h.phase("omp") == "running").await;
        assert!(h.cancel());
        assert_eq!(
            run.await.unwrap(),
            json!({"kind": "failed", "failure": {"reason": "cancelled"}})
        );
        assert_eq!(h.phase("omp"), "present");
    });
}

/// "runs `omp update` with the detected omp's folder first on PATH", "reads Windows' `Path` for that PATH and leaves the child one PATH key"
#[test]
fn update_omp_puts_the_omps_folder_first_on_one_path_key() {
    local(|dir| async move {
        let delimiter = paths::DELIMITER.to_string();
        let own = paths::host_join(&["/home/u", ".bun", "bin"]);
        let omp_bin = paths::host_join(&[&own, "omp"]);
        let path = ["/usr/local/bin", own.as_str(), "/usr/bin"].join(&delimiter);
        let h = harness(
            &sub(&dir, "a"),
            machine(&[("omp", present("18.8.7"))]),
            Options {
                installed_version: "18.9.0",
                omp_bin: omp_bin.clone(),
                spawn_env: Some([("PATH".to_owned(), path)].into()),
                ..Options::default()
            },
        );
        h.update_omp("18.9.0", false, Rc::default()).await;
        let entries: Vec<String> = h.env(0)["PATH"]
            .split(&delimiter)
            .map(str::to_owned)
            .collect();
        assert_eq!(
            entries[..3],
            [own.clone(), "/usr/local/bin".into(), "/usr/bin".into()]
        );
        assert_eq!(entries.iter().filter(|entry| **entry == own).count(), 1);
        let win = harness(
            &sub(&dir, "b"),
            machine(&[("omp", present("18.8.7"))]),
            Options {
                platform: "win32",
                installed_version: "18.9.0",
                omp_bin,
                spawn_env: Some(
                    [(
                        "Path".to_owned(),
                        ["/usr/local/bin", "/usr/bin"].join(&delimiter),
                    )]
                    .into(),
                ),
                ..Options::default()
            },
        );
        win.update_omp("18.9.0", false, Rc::default()).await;
        let env = win.env(0);
        assert_eq!(
            env.keys()
                .filter(|key| key.eq_ignore_ascii_case("PATH"))
                .collect::<Vec<_>>(),
            ["PATH"]
        );
        let entries: Vec<&str> = env["PATH"].split(&delimiter).collect();
        assert_eq!(entries[..3], [own.as_str(), "/usr/local/bin", "/usr/bin"]);
    });
}

fn release(
    answer: impl Fn(&str) -> Result<Value, String> + 'static,
) -> Option<Rc<dyn Fn(String, String, Env) -> LocalFuture<Result<Value, String>>>> {
    Some(Rc::new(move |_, version, _| {
        let answer = answer(&version);
        Box::pin(async move { answer })
    }))
}

/// "upgrades a Bun older than the release's engines.bun before `omp update`, so stock never swaps in its compiled omp"
#[test]
fn update_omp_upgrades_a_too_old_bun_first() {
    local(|dir| async move {
        let views: Rc<RefCell<Vec<(String, String, Option<String>)>>> = Rc::default();
        let omp_release: Rc<dyn Fn(String, String, Env) -> LocalFuture<Result<Value, String>>> = {
            let views = Rc::clone(&views);
            Rc::new(move |bun, version, env| {
                let first = env
                    .get("PATH")
                    .and_then(|path| path.split(paths::DELIMITER).next().map(str::to_owned));
                views.borrow_mut().push((bun, version.clone(), first));
                Box::pin(async move {
                    Ok(
                        json!({"name": OMP_PACKAGE, "version": version, "engines": {"bun": ">=1.4.4"}}),
                    )
                })
            })
        };
        let h = harness(
            &dir,
            machine(&[("bun", present("1.4.2")), ("omp", present("18.12.6"))]),
            Options {
                installed: [("bun", "1.4.4".to_owned()), ("omp", "18.13.3".to_owned())].into(),
                omp_release: Some(omp_release),
                ..Options::default()
            },
        );
        let hook: Rc<RefCell<Vec<usize>>> = Rc::default();
        assert_eq!(
            h.update_omp("18.13.3", false, Rc::clone(&hook)).await,
            json!({"kind": "updated", "version": "18.13.3"})
        );
        assert_eq!(h.args(), [["bun", "bun-upgrade"], ["omp", "omp-update"]]);
        assert_eq!(
            *views.borrow(),
            [(
                "/home/u/.bun/bin/bun".to_owned(),
                "18.13.3".to_owned(),
                Some(paths::dirname(cfg!(windows), "/home/u/.bun/bin/omp"))
            )]
        );
        assert_eq!(hook.borrow().len(), 1);
        assert_eq!(h.item("bun")["presence"]["version"], "1.4.4");
    });
}

/// "runs no Bun upgrade when Bun already meets the release's engines.bun"
#[test]
fn update_omp_runs_no_bun_upgrade_when_bun_meets_it() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("bun", present("1.4.4")), ("omp", present("18.12.6"))]),
            Options {
                installed: [("omp", "18.13.3".to_owned())].into(),
                omp_release: release(|_| Ok(json!({"engines": {"bun": ">=1.4.4"}}))),
                ..Options::default()
            },
        );
        assert_eq!(
            h.update_omp("18.13.3", false, Rc::default()).await,
            json!({"kind": "updated", "version": "18.13.3"})
        );
        assert_eq!(h.args(), [["omp", "omp-update"]]);
    });
}

/// "leaves omp alone when Bun cannot be upgraded far enough, or the release's requirements cannot be read"
#[test]
fn update_omp_leaves_omp_alone_when_bun_cannot_be_upgraded_or_the_requirements_read() {
    local(|dir| async move {
        let stuck = harness(
            &sub(&dir, "a"),
            machine(&[("bun", present("1.4.2")), ("omp", present("18.12.6"))]),
            Options {
                exits: exits(&[("bun", 1)]),
                output: [("bun", "error: bun was installed with Homebrew")].into(),
                omp_release: release(|_| Ok(json!({"engines": {"bun": ">=1.4.4"}}))),
                ..Options::default()
            },
        );
        let hook: Rc<RefCell<Vec<usize>>> = Rc::default();
        assert_eq!(
            stuck.update_omp("18.13.3", false, Rc::clone(&hook)).await,
            json!({"kind": "failed", "failure": {"reason": "install", "detail": "omp 18.13.3 needs Bun 1.4.4 or newer; Bun could not be upgraded to it — error: bun was installed with Homebrew"}})
        );
        assert_eq!(
            stuck.args(),
            [["bun", "bun-upgrade"], ["bun", "bun-script"]]
        );
        assert_eq!(hook.borrow().len(), 0);
        assert_eq!(stuck.item("omp")["presence"]["version"], "18.12.6");
        let offline = harness(
            &sub(&dir, "b"),
            machine(&[("omp", present("18.12.6"))]),
            Options {
                omp_release: release(|_| Err("ConnectionRefused".into())),
                ..Options::default()
            },
        );
        assert_eq!(
            offline.update_omp("18.13.3", false, Rc::default()).await,
            json!({"kind": "failed", "failure": {"reason": "check", "detail": "omp 18.13.3's requirements: ConnectionRefused"}})
        );
        assert!(offline.items().is_empty());
    });
}

/// "never installs a release published only as a standalone build"
#[test]
fn update_omp_never_installs_a_standalone_only_release() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("omp", present("18.12.6"))]),
            Options {
                omp_release: release(|_| Ok(json!({"omp": {"dist": "binary"}}))),
                ..Options::default()
            },
        );
        let outcome = h.update_omp("19.0.0", false, Rc::default()).await;
        assert_eq!(
            (
                outcome["kind"].clone(),
                outcome["failure"]["reason"].clone()
            ),
            (json!("failed"), json!("install"))
        );
        assert!(h.items().is_empty());
    });
}

/// "puts the package back right away when the update left a compiled omp, without announcing omp ready"
#[test]
fn update_omp_puts_the_package_back_over_a_compiled_omp() {
    local(|dir| async move {
        let compiled = broken(COMPILED, Some("/home/u/.bun/bin/omp"));
        let h = harness(
            &dir,
            machine(&[("omp", present("18.12.6"))]),
            Options {
                installed: [("omp", "18.13.3".to_owned())].into(),
                leaves: [("omp omp-update", compiled)].into(),
                ..Options::default()
            },
        );
        assert_eq!(
            h.update_omp("18.13.3", false, Rc::default()).await,
            json!({"kind": "updated", "version": "18.13.3"})
        );
        assert_eq!(h.args(), [["omp", "omp-update"], ["omp", "bun-global"]]);
        assert_eq!(h.main.omp_ready.get(), 0);
        assert_eq!(
            (
                h.state()["ompReady"].clone(),
                h.state()["requiredRunning"].clone()
            ),
            (json!(true), json!(false))
        );
    });
}

/// "calls an omp the repair could not bring back unusable, with what is wrong with it"
#[test]
fn update_omp_calls_an_omp_the_repair_could_not_bring_back_unusable() {
    local(|dir| async move {
        let compiled = broken(COMPILED, Some("/home/u/.bun/bin/omp"));
        let h = harness(
            &dir,
            machine(&[("omp", present("18.12.6"))]),
            Options {
                leaves: [
                    ("omp omp-update", compiled.clone()),
                    ("omp bun-global", compiled),
                ]
                .into(),
                ..Options::default()
            },
        );
        assert_eq!(
            h.update_omp("18.13.3", false, Rc::default()).await,
            json!({"kind": "failed", "failure": {"reason": "unusable", "detail": format!("installing omp — {COMPILED}")}})
        );
        assert_eq!(h.args(), [["omp", "omp-update"], ["omp", "bun-global"]]);
    });
}

/// "puts Bun's installer behind a `bun upgrade` that fails, in the same attempt, then updates omp"
#[test]
fn update_omp_falls_back_to_buns_installer_then_updates() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("bun", present("1.4.2")), ("omp", present("18.12.6"))]),
            Options {
                method_exits: [("bun bun-upgrade", 1)].into(),
                installed: [("bun", "1.4.4".to_owned()), ("omp", "18.13.3".to_owned())].into(),
                omp_release: release(|_| Ok(json!({"engines": {"bun": ">=1.4.4"}}))),
                ..Options::default()
            },
        );
        assert_eq!(
            h.update_omp("18.13.3", false, Rc::default()).await,
            json!({"kind": "updated", "version": "18.13.3"})
        );
        assert_eq!(
            h.args(),
            [
                ["bun", "bun-upgrade"],
                ["bun", "bun-script"],
                ["omp", "omp-update"]
            ]
        );
    });
}

// ---- latestOmp ---------------------------------------------------------------------------------------------------

/// A fake omp that appends `{args, first PATH entry, NO_COLOR}` to `log` and then does `script`.
fn checking_omp(dir: &Path, lines: &[&str], code: i32) -> (String, PathBuf) {
    let log = dir.join("check.log");
    #[cfg(windows)]
    {
        let omp = dir.join("omp.cmd");
        let mut text = String::from(
            "@echo off\r\nfor /f \"tokens=1 delims=;\" %%a in (\"%PATH%\") do >>\"%CHECK_LOG%\" echo %*^|%%a^|%NO_COLOR%\r\n",
        );
        for line in lines {
            match line.strip_prefix("!") {
                Some(error) => text.push_str(&format!("echo {error} 1>&2\r\n")),
                None => text.push_str(&format!("echo {line}\r\n")),
            }
        }
        text.push_str(&format!("exit /b {code}\r\n"));
        std::fs::write(&omp, text).unwrap();
        (omp.to_string_lossy().into_owned(), log)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let omp = dir.join("omp");
        let mut text =
            String::from("#!/bin/sh\necho \"$*|${PATH%%:*}|$NO_COLOR\" >> \"$CHECK_LOG\"\n");
        for line in lines {
            match line.strip_prefix("!") {
                Some(error) => text.push_str(&format!("printf '%s\\n' '{error}' >&2\n")),
                None => text.push_str(&format!("printf '%s\\n' '{line}'\n")),
            }
        }
        text.push_str(&format!("exit {code}\n"));
        std::fs::write(&omp, text).unwrap();
        std::fs::set_permissions(&omp, std::fs::Permissions::from_mode(0o755)).unwrap();
        (omp.to_string_lossy().into_owned(), log)
    }
}

async fn checking(dir: &Path, lines: &[&str], code: i32) -> (H, String, PathBuf) {
    let (omp, log) = checking_omp(dir, lines, code);
    let mut env: Env = std::env::vars().collect();
    env.insert("CHECK_LOG".into(), log.to_string_lossy().into_owned());
    let h = harness(
        dir,
        machine(&[("omp", present("18.8.7"))]),
        Options {
            platform: if cfg!(windows) { "win32" } else { "darwin" },
            automatic: false,
            omp_bin: omp.clone(),
            spawn_env: Some(env),
            ..Options::default()
        },
    );
    h.start().await;
    (h, omp, log)
}

/// latestOmp: "is stock `omp update --check` on the detected omp, with that omp's folder first on PATH"
#[test]
fn latest_omp_is_stocks_check_on_the_detected_omp() {
    local(|dir| async move {
        let (h, omp, log) = checking(
            &dir,
            &["Current version: 18.8.7", "New version available: 18.9.0"],
            0,
        )
        .await;
        assert_eq!(latest_omp(&h.tools).await, Ok("18.9.0".into()));
        let line = std::fs::read_to_string(log).unwrap();
        let fields: Vec<&str> = line.trim().split('|').collect();
        assert!(
            fields[0].contains("update") && fields[0].contains("--check"),
            "{line}"
        );
        assert_eq!(fields[1].trim(), paths::dirname(cfg!(windows), &omp));
        assert_eq!(fields[2].trim(), "1");
    });
}

/// latestOmp: "answers the installed version when stock says it is up to date"
#[test]
fn latest_omp_answers_the_installed_version_when_up_to_date() {
    local(|dir| async move {
        let (h, _, _) = checking(&dir, &["Current version: 18.8.7", "Already up to date"], 0).await;
        assert_eq!(latest_omp(&h.tools).await, Ok("18.8.7".into()));
    });
}

/// latestOmp: "keeps setup's cleaned error detail when stock exits zero without an update verdict"
#[test]
fn latest_omp_keeps_the_cleaned_detail_without_a_verdict() {
    local(|dir| async move {
        let (h, _, _) = checking(
            &dir,
            &[
                "Current version: 18.8.7",
                "\u{1b}[33m  no verdict  \u{1b}[0m",
            ],
            0,
        )
        .await;
        assert_eq!(
            latest_omp(&h.tools).await,
            Err("Current version: 18.8.7\nno verdict".into())
        );
    });
}

/// latestOmp: "rejects with stock's own reason when the check fails, and while omp is missing"
#[test]
fn latest_omp_rejects_with_stocks_reason_and_while_omp_is_missing() {
    local(|dir| async move {
        let (h, _, _) = checking(&sub(&dir, "a"), &["Current version: 18.8.7", "!Failed to check for updates: 401 Unauthorized; check the registry credentials in your .npmrc"], 1).await;
        assert!(
            latest_omp(&h.tools)
                .await
                .unwrap_err()
                .contains("401 Unauthorized; check the registry credentials")
        );
        let none = harness(
            &sub(&dir, "b"),
            machine(&[("omp", Presence::Missing)]),
            Options {
                automatic: false,
                ..Options::default()
            },
        );
        none.start().await;
        assert_eq!(
            latest_omp(&none.tools).await,
            Err("omp is not installed".into())
        );
    });
}

// ---- runToolUpdate ---------------------------------------------------------------------------------------------------

fn codex() -> Value {
    json!({"tool": "codex", "method": "npm", "spawn": null, "env": {}})
}

/// "runs the fake installer as `cli-<tool> <method> update` under the supervisor, with the request's env on top, and leaves every setup item alone"
#[test]
fn run_tool_update_runs_the_test_installer_and_leaves_the_items_alone() {
    local(|dir| async move {
        let h = harness(&dir, machine(&[]), Options::default());
        let before: Vec<Value> = h.state()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["phase"].clone())
            .collect();
        let mut request = codex();
        request["env"] = json!({"BUN_INSTALL": "/x/.bun"});
        assert_eq!(
            h.tool_update(request).await,
            Ok(json!({"kind": "succeeded"}))
        );
        assert_eq!(
            h.specs(),
            [SpawnSpec {
                file: "/fake/installer".into(),
                args: ["cli-codex", "npm", "update"].map(str::to_owned).to_vec(),
                ..SpawnSpec::default()
            }]
        );
        assert_eq!(h.env(0).get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(
            h.env(0).get("BUN_INSTALL").map(String::as_str),
            Some("/x/.bun")
        );
        let after: Vec<Value> = h.state()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["phase"].clone())
            .collect();
        assert_eq!(after, before);
        assert!(!dir.join("setup-state.json").exists());
        assert_eq!(h.main.omp_ready.get(), 0);
    });
}

/// "runs the owner's own command when no test installer is set"
#[test]
fn run_tool_update_runs_the_owners_command() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[]),
            Options {
                test_installer: None,
                ..Options::default()
            },
        );
        let spawn = json!({"file": "/opt/homebrew/bin/brew", "args": ["cli-upgrade", "gh"], "shell": false});
        let outcome = h.tool_update(json!({"tool": "gh", "method": "brew", "spawn": spawn, "env": {"HOMEBREW_NO_AUTO_UPDATE": "1"}})).await;
        assert_eq!(outcome, Ok(json!({"kind": "succeeded"})));
        assert_eq!(
            h.specs(),
            [SpawnSpec {
                file: "/opt/homebrew/bin/brew".into(),
                args: vec!["cli-upgrade".into(), "gh".into()],
                ..SpawnSpec::default()
            }]
        );
        assert_eq!(
            h.env(0).get("HOMEBREW_NO_AUTO_UPDATE").map(String::as_str),
            Some("1")
        );
    });
}

/// "reports the exit code and the last output of a failing update"
#[test]
fn run_tool_update_reports_the_exit_code_and_last_output() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[]),
            Options {
                tool_exit: 1,
                tool_output: "EACCES: permission denied",
                ..Options::default()
            },
        );
        let outcome = h.tool_update(codex()).await.unwrap();
        assert_eq!(outcome["kind"], "failed");
        let detail = outcome["detail"].as_str().unwrap();
        assert!(
            detail.starts_with("exit 1 — ") && detail.contains("EACCES: permission denied"),
            "{detail}"
        );
    });
}

/// "waits behind a running install and runs when it ends"
#[test]
fn run_tool_update_waits_behind_a_running_install() {
    local(|dir| async move {
        let h = Rc::new(harness(
            &dir,
            machine(&[("gh", Presence::Missing)]),
            Options {
                hold: Some("gh"),
                ..Options::default()
            },
        ));
        let connect = {
            let h = Rc::clone(&h);
            tokio::task::spawn_local(async move { h.connect("gh").await })
        };
        until("gh runs", || h.phase("gh") == "running").await;
        let run = {
            let h = Rc::clone(&h);
            tokio::task::spawn_local(async move { h.tool_update(codex()).await })
        };
        tokio::task::yield_now().await;
        assert!(h.cancel());
        assert_eq!(run.await.unwrap(), Ok(json!({"kind": "succeeded"})));
        connect.await.unwrap().unwrap();
        let firsts: Vec<String> = h.args().iter().map(|args| args[0].clone()).collect();
        assert_eq!(firsts, ["gh", "cli-codex"]);
    });
}

/// "a cancel from This computer ends the running update as cancelled"
#[test]
fn run_tool_update_ends_as_cancelled_on_a_cancel() {
    local(|dir| async move {
        let h = Rc::new(harness(
            &dir,
            machine(&[]),
            Options {
                hold_tool: true,
                ..Options::default()
            },
        ));
        let run = {
            let h = Rc::clone(&h);
            tokio::task::spawn_local(async move { h.tool_update(codex()).await })
        };
        until("the update runs", || h.items().len() == 1).await;
        assert!(h.cancel());
        assert_eq!(run.await.unwrap(), Ok(json!({"kind": "cancelled"})));
    });
}

/// "a step that never ends is stopped, and the next queued call runs" (the bound, short here)
#[test]
fn a_step_that_never_ends_is_stopped_and_the_next_call_runs() {
    local(|dir| async move {
        let h = Rc::new(harness(
            &dir,
            machine(&[("gh", Presence::Missing)]),
            Options {
                hold_tool: true,
                bound_ms: 300,
                ..Options::default()
            },
        ));
        let hung = {
            let h = Rc::clone(&h);
            tokio::task::spawn_local(async move { h.tool_update(codex()).await })
        };
        until("the update runs", || h.items().len() == 1).await;
        let next = h.connect("gh").await.unwrap();
        let fault = hung.await.unwrap().unwrap_err();
        assert_eq!(fault.code, "step_stalled");
        assert!(fault.message.contains("was stopped"));
        assert_eq!(next["id"], "gh");
    });
}

/// "a stopped step that resumes later starts no installer and writes no state": the stopped step is dropped, so the
/// lookup that answers after the next step ran leads to nothing.
#[test]
fn a_stopped_step_starts_no_installer_and_writes_no_state_after() {
    local(|dir| async move {
        let mirror = Mirror::start().await;
        let sha = "a".repeat(64);
        let lookup = Arc::new(tokio::sync::Notify::new());
        let latest = json!({"tag_name": "v2.99.0"}).to_string();
        mirror.serve({
            let lookup = Arc::clone(&lookup);
            move |url| {
                if url.ends_with("/releases/latest") {
                    return Some(Answer::Held {
                        length: latest.len(),
                        first: Vec::new(),
                        gate: Some(Arc::clone(&lookup)),
                        rest: latest.clone().into_bytes(),
                    });
                }
                url.ends_with("_checksums.txt")
                    .then(|| Answer::Text(format!("{sha}  gh_2.99.0_macOS_arm64.zip\n")))
            }
        });
        let h = harness_in(
            &dir,
            machine(&[]),
            Options {
                test_installer: None,
                bound_ms: 300,
                ..Options::default()
            },
            Some(&mirror),
        );
        let stale = h.tool_update(json!({"tool": "gh", "method": "managed", "spawn": null, "managed": "gh", "env": {}})).await;
        assert_eq!(stale.unwrap_err().code, "step_stalled");
        h.later("setup.gitAslr", json!({"action": "fix"}))
            .await
            .unwrap();
        let before = h.states().len();
        lookup.notify_one();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!mirror.asked().iter().any(|url| url.ends_with(".zip")));
        assert!(h.items().is_empty());
        assert_eq!(h.states().len(), before);
    });
}

/// The fence repro of `service.test.ts` (it.fails there, Finding 4): "an updater step stopped by its own bound cancels
/// the update it started, so the next install starts". In the one queue the update runs inline in the pass's step and
/// its installer is that step's stop.
#[test]
fn an_updater_step_stopped_by_its_bound_cancels_its_update_and_the_next_install_starts() {
    local(|dir| async move {
        let h = Rc::new(harness(
            &dir,
            machine(&[("gh", Presence::Missing)]),
            Options {
                hold_tool: true,
                bound_ms: 500,
                ..Options::default()
            },
        ));
        let pass = {
            let h = Rc::clone(&h);
            tokio::task::spawn_local(async move {
                h.in_step(StepKind::CliPass, |tools, ctx| {
                    Box::pin(async move {
                        // The pass checks for a while before it updates, so its bound comes in the update.
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        run_tool_update(&tools, &ctx, serde_json::from_value(codex()).unwrap())
                            .await
                            .to_json()
                    })
                })
                .await
            })
        };
        until("the update runs", || h.items().len() == 1).await;
        let install = h.connect("gh").await.unwrap();
        let fault = pass.await.unwrap().unwrap_err();
        assert!(fault.message.contains("was stopped"), "{}", fault.message);
        assert_eq!(
            (install["id"].clone(), install["phase"].clone()),
            (json!("gh"), json!("present"))
        );
        assert_eq!(h.items(), ["tool", "gh"]);
    });
}

/// "skips after quitting and on a platform without setup"
#[test]
fn run_tool_update_skips_after_the_close_and_where_setup_cannot_run() {
    local(|dir| async move {
        let quit = harness(&sub(&dir, "a"), machine(&[]), Options::default());
        let ctx = Ctx::default();
        quit.tools.close();
        let request: ToolUpdateRequest = serde_json::from_value(codex()).unwrap();
        assert_eq!(
            run_tool_update(&quit.tools, &ctx, request.clone()).await,
            ToolUpdateOutcome::Skipped
        );
        let other = harness(
            &sub(&dir, "b"),
            machine(&[]),
            Options {
                platform: "other",
                ..Options::default()
            },
        );
        assert_eq!(
            other.tool_update(codex()).await,
            Ok(json!({"kind": "skipped"}))
        );
        assert!(quit.items().is_empty() && other.items().is_empty());
    });
}

/// "updates the managed copy from machine setup's archive release, failing readably when the lookup fails"
#[test]
fn run_tool_update_fails_readably_when_the_managed_lookup_fails() {
    local(|dir| async move {
        let mirror = Mirror::start().await;
        let h = harness_in(
            &dir,
            machine(&[]),
            Options {
                test_installer: None,
                ..Options::default()
            },
            Some(&mirror),
        );
        let outcome = h.tool_update(json!({"tool": "gh", "method": "managed", "spawn": null, "managed": "gh", "env": {}})).await.unwrap();
        assert_eq!(outcome["kind"], "failed");
        assert!(outcome["detail"].as_str().unwrap().contains("answered 404"));
        assert!(h.items().is_empty());
    });
}

/// "updates the managed agent-desktop from its own release: the verified archive, then the swap script"
#[test]
fn run_tool_update_installs_the_managed_agent_desktop_from_its_release() {
    local(|dir| async move {
        let mirror = Mirror::start().await;
        let bytes = b"agent-desktop archive".to_vec();
        let sha = sha256(&bytes);
        mirror.serve({
            let (bytes, sha) = (bytes.clone(), sha.clone());
            move |url| {
                if url == "https://api.github.com/repos/vercel-labs/agent-desktop/releases/latest" {
                    return Some(Answer::Text(json!({"tag_name": "v1.2.0"}).to_string()));
                }
                if url.ends_with("/v1.2.0/checksums.txt") {
                    return Some(Answer::Text(format!(
                        "{sha}  agent-desktop-v1.2.0-aarch64-apple-darwin.tar.gz\n"
                    )));
                }
                url.ends_with("/v1.2.0/agent-desktop-v1.2.0-aarch64-apple-darwin.tar.gz")
                    .then(|| Answer::Status(200, bytes.clone()))
            }
        });
        let h = harness_in(
            &dir,
            machine(&[]),
            Options {
                test_installer: None,
                ..Options::default()
            },
            Some(&mirror),
        );
        let outcome = h.tool_update(json!({"tool": "agent-desktop", "method": "managed", "spawn": null, "managed": "agent-desktop", "env": {}})).await;
        assert_eq!(outcome, Ok(json!({"kind": "succeeded"})));
        let spec = h.specs()[0].clone();
        assert_eq!(spec.file, "/bin/bash");
        assert!(spec.args[1].contains(&format!("(SHA-256 {sha})")));
        assert!(spec.args[1].contains("agent-desktop-macos-helper"));
        assert_eq!(
            std::fs::read_dir(dir.join("tools").join(".downloads"))
                .unwrap()
                .count(),
            0
        );
    });
}

// ---- latestManaged ---------------------------------------------------------------------------------------------------

/// latestManaged: "is the version of the verified archive release machine setup would download", "rejects with the
/// lookup's reason", "is agent-desktop's own newest release, and refuses a platform it has no release for"
#[test]
fn latest_managed_is_the_verified_archive_release() {
    local(|dir| async move {
        let mirror = Mirror::start().await;
        let sha = "a".repeat(64);
        mirror.serve({
            let sha = sha.clone();
            move |url| {
                if url == "https://api.github.com/repos/vercel-labs/agent-desktop/releases/latest" {
                    return Some(Answer::Text(json!({"tag_name": "v1.3.1"}).to_string()));
                }
                if url.ends_with("/v1.3.1/checksums.txt") {
                    return Some(Answer::Text(format!(
                        "{sha}  agent-desktop-v1.3.1-aarch64-apple-darwin.tar.gz\n"
                    )));
                }
                if url.ends_with("/releases/latest") {
                    return Some(Answer::Text(json!({"tag_name": "v2.99.0"}).to_string()));
                }
                url.ends_with("_checksums.txt")
                    .then(|| Answer::Text(format!("{sha}  gh_2.99.0_macOS_arm64.zip\n")))
            }
        });
        let h = harness_in(
            &sub(&dir, "a"),
            machine(&[]),
            Options::default(),
            Some(&mirror),
        );
        assert_eq!(latest_managed(&h.tools, "gh").await, Ok("2.99.0".into()));
        assert_eq!(
            latest_managed(&h.tools, "node").await,
            Err("https://nodejs.org/dist/index.json answered 404".into())
        );
        assert_eq!(
            latest_managed(&h.tools, "agent-desktop").await,
            Ok("1.3.1".into())
        );
        let other = harness_in(
            &sub(&dir, "b"),
            machine(&[]),
            Options {
                platform: "other",
                ..Options::default()
            },
            Some(&mirror),
        );
        assert!(
            latest_managed(&other.tools, "agent-desktop")
                .await
                .unwrap_err()
                .contains("no release for this platform")
        );
    });
}

// ---- the Tailscale item ------------------------------------------------------------------------------------------

/// "is optional, never installed at launch or in the background pass, and has no back-off"
#[test]
fn tailscale_is_never_installed_on_its_own() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("tailscale", Presence::Missing)]),
            Options::default(),
        );
        h.start().await;
        assert!(h.items().is_empty());
        assert_eq!(h.phase("tailscale"), "idle");
        assert_eq!(h.item("tailscale")["required"], false);
        assert_eq!(h.ledger(), json!({}));
        h.retry("omp").await.unwrap();
        assert!(h.items().is_empty());
    });
}

/// "installs on `installForConnection` and on an explicit Retry, through the test installer"
#[test]
fn tailscale_installs_on_a_connection_and_on_a_retry() {
    local(|dir| async move {
        let h = harness(
            &sub(&dir, "a"),
            machine(&[("tailscale", Presence::Missing)]),
            Options::default(),
        );
        h.start().await;
        let item = h.connect("tailscale").await.unwrap();
        assert_eq!(
            h.specs(),
            [SpawnSpec {
                file: "/fake/installer".into(),
                args: vec!["tailscale".into(), "tailscale-zip".into()],
                ..SpawnSpec::default()
            }]
        );
        assert_eq!(
            (item["phase"].clone(), item["method"].clone()),
            (json!("present"), json!("tailscale-zip"))
        );
        let again = harness(
            &sub(&dir, "b"),
            machine(&[("tailscale", Presence::Missing)]),
            Options {
                exits: exits(&[("tailscale", 1)]),
                ..Options::default()
            },
        );
        again.start().await;
        again.connect("tailscale").await.unwrap();
        assert_eq!(again.phase("tailscale"), "failed");
        again.retry("tailscale").await.unwrap();
        assert_eq!(again.items(), ["tailscale", "tailscale"]);
    });
}

/// "keeps no attempt record: three failures later it still installs on request and never reads as paused"
#[test]
fn tailscale_keeps_no_attempt_record() {
    local(|dir| async move {
        let h = harness(
            &dir,
            machine(&[("tailscale", Presence::Missing)]),
            Options {
                exits: exits(&[("tailscale", 1)]),
                ..Options::default()
            },
        );
        h.start().await;
        for _ in 0..4 {
            h.connect("tailscale").await.unwrap();
        }
        assert_eq!(h.items().len(), 4);
        assert_eq!(h.ledger(), json!({}));
        h.start().await;
        assert_eq!(h.phase("tailscale"), "failed");
        let fresh = harness(
            &dir,
            machine(&[("tailscale", Presence::Missing)]),
            Options::default(),
        );
        fresh.start().await;
        assert_eq!(fresh.phase("tailscale"), "idle");
    });
}

/// "plans winget on Windows when it exists and the MSI when it does not; only detects when setup is not automatic"
#[test]
fn tailscale_plans_winget_or_the_msi_on_windows() {
    local(|dir| async move {
        let mut found = machine(&[("tailscale", Presence::Missing)]);
        found.winget = Some("C:\\winget.exe".into());
        let winget = harness(
            &sub(&dir, "a"),
            found,
            Options {
                platform: "win32",
                ..Options::default()
            },
        );
        winget.start().await;
        winget.connect("tailscale").await.unwrap();
        assert_eq!(winget.args()[0], ["tailscale", "winget"]);
        let msi = harness(
            &sub(&dir, "b"),
            machine(&[("tailscale", Presence::Missing)]),
            Options {
                platform: "win32",
                ..Options::default()
            },
        );
        msi.start().await;
        msi.connect("tailscale").await.unwrap();
        assert_eq!(msi.args()[0], ["tailscale", "tailscale-msi"]);
        let manual = harness(
            &sub(&dir, "c"),
            machine(&[("tailscale", Presence::Missing)]),
            Options {
                automatic: false,
                ..Options::default()
            },
        );
        manual.start().await;
        manual.connect("tailscale").await.unwrap();
        assert!(manual.items().is_empty());
    });
}

fn tailscale_index() -> String {
    json!({"MacZips": {"universal": "Tailscale-1.104.1-macos.zip"}, "MacZipsVersion": "1.104.1", "Version": "1.104.1"}).to_string()
}

/// "refuses a download whose SHA-256 does not match the published one, and runs nothing"
#[test]
fn tailscale_refuses_a_download_with_another_hash() {
    local(|dir| async move {
        let mirror = Mirror::start().await;
        mirror.serve(|url| {
            Some(if url.ends_with(".sha256") {
                Answer::Text(format!("{}\n", "ab".repeat(32)))
            } else if url.ends_with(".zip") {
                Answer::Status(200, vec![1, 2, 3])
            } else {
                Answer::Text(tailscale_index())
            })
        });
        let h = harness_in(
            &dir,
            machine(&[("tailscale", Presence::Missing)]),
            Options {
                test_installer: None,
                ..Options::default()
            },
            Some(&mirror),
        );
        h.start().await;
        let item = h.connect("tailscale").await.unwrap();
        assert_eq!(
            (
                item["phase"].clone(),
                item["failure"]["reason"].clone(),
                item["method"].clone()
            ),
            (json!("failed"), json!("checksum"), json!("tailscale-zip"))
        );
        assert!(h.items().is_empty());
        assert!(
            !dir.join("tools")
                .join(".downloads")
                .join("Tailscale-1.104.1-macos.zip")
                .exists()
        );
    });
}

/// "fails as a download problem when Tailscale's index cannot be read"
#[test]
fn tailscale_fails_as_a_download_problem_without_its_index() {
    local(|dir| async move {
        let mirror = Mirror::start().await;
        let h = harness_in(
            &dir,
            machine(&[("tailscale", Presence::Missing)]),
            Options {
                test_installer: None,
                ..Options::default()
            },
            Some(&mirror),
        );
        h.start().await;
        let item = h.connect("tailscale").await.unwrap();
        assert_eq!(
            (item["phase"].clone(), item["failure"]["reason"].clone()),
            (json!("failed"), json!("download"))
        );
        assert!(h.items().is_empty());
    });
}

/// "runs the real macOS plan after a verified download"
#[test]
fn tailscale_runs_the_real_macos_plan_after_a_verified_download() {
    local(|dir| async move {
        let mirror = Mirror::start().await;
        let bytes = vec![9u8, 8, 7];
        let sha = sha256(&bytes);
        mirror.serve(move |url| {
            Some(if url.ends_with(".sha256") {
                Answer::Text(sha.clone())
            } else if url.ends_with(".zip") {
                Answer::Status(200, bytes.clone())
            } else {
                Answer::Text(json!({"MacZips": {"universal": "Tailscale-1.104.1-macos.zip"}, "Version": "1.104.1"}).to_string())
            })
        });
        let h = harness_in(
            &dir,
            machine(&[("tailscale", Presence::Missing)]),
            Options {
                test_installer: None,
                ..Options::default()
            },
            Some(&mirror),
        );
        h.start().await;
        let _ = h.connect("tailscale").await;
        let spec = h.specs()[0].clone();
        assert_eq!(spec.file, "/bin/bash");
        assert!(spec.args[1].contains("codesign --verify --deep --strict"));
    });
}

// ---- the Git ASLR override -----------------------------------------------------------------------------------------

/// `gitAslr` off Windows or without Git answers its refusal; an Undo without a record is refused.
#[test]
fn git_aslr_refuses_without_git_for_windows_or_a_record() {
    local(|dir| async move {
        let h = harness(&sub(&dir, "a"), machine(&[]), Options::default());
        assert_eq!(
            h.later("setup.gitAslr", json!({"action": "fix"})).await,
            Ok(json!({"ok": false, "detail": "Git for Windows was not found"}))
        );
        assert!(
            h.later("setup.gitAslr", json!({"action": "rm"}))
                .await
                .is_err()
        );
        let mut found = machine(&[]);
        found.presence.insert(
            "git",
            Presence::Present {
                version: Some("2.56.0".into()),
                path: Some("C:\\Git".into()),
                git_shell: None,
                git_aslr_override: None,
                git_aslr_undoable: None,
            },
        );
        let win = harness(
            &sub(&dir, "b"),
            found,
            Options {
                platform: "win32",
                ..Options::default()
            },
        );
        win.start().await;
        assert_eq!(
            win.later("setup.gitAslr", json!({"action": "undo"})).await,
            Ok(
                json!({"ok": false, "detail": "No record of what Fix changed, so there is nothing to undo exactly"})
            )
        );
        assert!(win.items().is_empty());
    });
}

/// `gitAslr` Fix records what the elevated step changed, logs it, and a fresh detection offers Undo.
#[test]
fn git_aslr_fix_records_what_it_changed_and_undo_puts_it_back() {
    local(|dir| async move {
        let root = "C:\\Program Files\\Git";
        let mut found = machine(&[]);
        found.presence.insert(
            "git",
            Presence::Present {
                version: Some("2.56.0".into()),
                path: Some(root.into()),
                git_shell: None,
                git_aslr_override: Some(true),
                git_aslr_undoable: None,
            },
        );
        let h = harness(
            &dir,
            found,
            Options {
                platform: "win32",
                ..Options::default()
            },
        );
        let out = dir.join("git-aslr-out.json");
        let sh = format!("{root}\\usr\\bin\\sh.exe");
        let written = json!([{"path": sh, "prior": 1}]).to_string();
        h.tools.setup.borrow_mut().seams.run = Some(Rc::new(move |_, _, _, output| {
            std::fs::write(&out, &written).unwrap();
            output("done\n");
            Box::pin(async { ran(0, "done\n".into()) })
        }));
        h.start().await;
        assert_eq!(
            h.later("setup.gitAslr", json!({"action": "fix"})).await,
            Ok(json!({"ok": true, "images": 1}))
        );
        let record = git_aslr::read_record(&dir.join(git_aslr::RECORD).to_string_lossy());
        assert_eq!(
            git_aslr::recorded_images(&record, root),
            [git_aslr::Image {
                path: sh.clone(),
                prior: "on".into()
            }]
        );
        assert_eq!(h.item("git")["presence"]["gitAslrUndoable"], true);
        let line = h
            .main
            .items
            .borrow()
            .iter()
            .find(|item| item["source"] == "setup")
            .cloned()
            .unwrap();
        assert_eq!(
            line["message"],
            "Git Mandatory ASLR override fix: succeeded"
        );
        assert_eq!(line["details"]["images"], json!([sh]));
        assert!(!dir.join("git-aslr-out.json").exists());
    });
}

// ---- compiled-launcher.test.ts ---------------------------------------------------------------------------------------

/// "holds the next install until a stalled rename has restored its launcher": a `bun install -g` step stopped by its
/// bound puts the compiled omp back before the next step starts.
#[test]
fn a_stopped_package_install_restores_the_launcher_before_the_next_step() {
    local(|dir| async move {
        let root = dir.join("bun");
        let launcher = root
            .join("bin")
            .join(if cfg!(windows) { "omp.exe" } else { "omp" });
        std::fs::create_dir_all(launcher.parent().unwrap()).unwrap();
        let platform = if cfg!(windows) { "win32" } else { "darwin" };
        std::fs::write(&launcher, compiled_bytes(platform)).unwrap();
        let h = harness(
            &dir,
            machine(&[("omp", broken(COMPILED, None))]),
            Options {
                platform,
                bun_install: root.to_string_lossy().into_owned(),
                hold: Some("omp"),
                bound_ms: 300,
                automatic: false,
                ..Options::default()
            },
        );
        h.start().await;
        let retry = h.retry("omp").await;
        assert_eq!(retry.unwrap_err().code, "step_stalled");
        let seen = h
            .in_step(StepKind::Install, {
                let launcher = launcher.clone();
                move |_, _| Box::pin(async move { std::fs::read(&launcher).unwrap() })
            })
            .await
            .unwrap();
        assert_eq!(seen, json!(compiled_bytes(platform)));
        assert_eq!(
            std::fs::read_dir(launcher.parent().unwrap())
                .unwrap()
                .count(),
            1
        );
    });
}

// ---- detect-*.test.ts -----------------------------------------------------------------------------------------------

/// detect-bun: "calls a Bun below the omp package's engines.bun outdated", "leaves a Bun that meets it, an unknown
/// version, a missing Bun and an omp naming no minimum as found"
#[test]
fn bun_below_omps_engines_is_outdated() {
    let bun = |version: Option<&str>| Presence::Present {
        version: version.map(str::to_owned),
        path: Some("/u/.bun/bin/bun".into()),
        git_shell: None,
        git_aslr_override: None,
        git_aslr_undoable: None,
    };
    assert_eq!(
        bun_for_omp(bun(Some("1.4.2")), Some("1.4.4")),
        outdated("1.4.2", "1.4.4", "/u/.bun/bin/bun")
    );
    for found in [
        bun(Some("1.4.4")),
        bun(Some("1.5.0")),
        bun(None),
        Presence::Missing,
    ] {
        assert_eq!(bun_for_omp(found.clone(), Some("1.4.4")), found);
    }
    assert_eq!(bun_for_omp(bun(Some("1.0.0")), None), bun(Some("1.0.0")));
}

/// detect-git-shell: "names Mandatory ASLR from its fork failure, keeps any other failure's last line, and passes a started child"
#[test]
fn names_mandatory_aslr_from_its_fork_failure() {
    let aslr = "      0 [main] sh 244 dofork: child -1 - forked process 56652 died unexpectedly, retry 0, exit code 0xC0000142, errno 11\nsh: fork: retry: Resource temporarily unavailable\nsh: fork: Resource temporarily unavailable\n";
    assert_eq!(git_shell_problem(Some(0), ""), None);
    assert_eq!(
        git_shell_problem(Some(254), aslr),
        Some(json!({"kind": "mandatory-aslr"}))
    );
    assert_eq!(
        git_shell_problem(Some(127), "sh: /usr/bin/true: No such file or directory\n"),
        Some(
            json!({"kind": "spawn-failed", "detail": "sh: /usr/bin/true: No such file or directory"})
        )
    );
    assert_eq!(
        git_shell_problem(Some(1), ""),
        Some(json!({"kind": "spawn-failed", "detail": "exit 1"}))
    );
}

/// detect-git-shell: "reads the selected Apple developer directory without starting git"
#[test]
fn reads_the_apple_developer_directory() {
    local(|_| async move {
        let env: Env = std::env::vars().collect();
        let dir = crate::setup::developer_dir(".", env, 5_000, crate::server::Scope::detached())
            .await
            .unwrap();
        if !cfg!(target_os = "macos") {
            assert_eq!(dir, None);
        }
    });
}

/// detect-agent-desktop (POSIX): the managed copy only, its version, outdated below 1.2.0, broken, the bundle.
#[cfg(unix)]
#[test]
fn detects_the_managed_agent_desktop_and_the_bundle() {
    use super::detect::detect_agent_desktop;
    use std::os::unix::fs::PermissionsExt;
    local(|dir| async move {
        let tools = dir.join("tools").to_string_lossy().into_owned();
        let env: Env = std::env::vars().collect();
        let exe = paths::managed_agent_desktop(false, &tools);
        let install = |body: &str| {
            std::fs::create_dir_all(Path::new(&exe).parent().unwrap()).unwrap();
            std::fs::write(&exe, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        assert_eq!(
            detect_agent_desktop("darwin", &tools, &env, None).await,
            Presence::Missing
        );
        assert_eq!(
            detect_agent_desktop("other", &tools, &env, None).await,
            Presence::Missing
        );
        install("echo 'agent-desktop 1.2.3'");
        assert_eq!(
            detect_agent_desktop("darwin", &tools, &env, None)
                .await
                .version(),
            Some("1.2.3")
        );
        install("echo 'agent-desktop 1.1.9'");
        assert_eq!(
            detect_agent_desktop("darwin", &tools, &env, None).await,
            outdated("1.1.9", "1.2.0", &exe)
        );
        install("echo 'dyld: Library not loaded' >&2; exit 1");
        assert_eq!(
            detect_agent_desktop("darwin", &tools, &env, None).await,
            broken("dyld: Library not loaded", Some(&exe))
        );
        install("echo 'hello'");
        assert_eq!(
            detect_agent_desktop("darwin", &tools, &env, None).await,
            broken("agent-desktop printed no version", Some(&exe))
        );
        let bundle = dir.join("bundle");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("agent-desktop"), "").unwrap();
        std::fs::write(
            bundle.join("agent-desktop.build.json"),
            json!({"version": "1.2.0"}).to_string(),
        )
        .unwrap();
        let bundled = Presence::Present {
            version: Some("1.2.0".into()),
            path: Some(bundle.join("agent-desktop").to_string_lossy().into_owned()),
            git_shell: None,
            git_aslr_override: None,
            git_aslr_undoable: None,
        };
        let bundle_dir = bundle.to_string_lossy().into_owned();
        assert_eq!(
            detect_agent_desktop("darwin", &tools, &env, Some(&bundle_dir)).await,
            bundled
        );
        install("echo 'agent-desktop 1.1.0'");
        assert_eq!(
            detect_agent_desktop("darwin", &tools, &env, Some(&bundle_dir)).await,
            bundled
        );
        install("echo 'agent-desktop 1.3.0'");
        assert_eq!(
            detect_agent_desktop("darwin", &tools, &env, Some(&bundle_dir))
                .await
                .version(),
            Some("1.3.0")
        );
    });
}

// ---- the ledger rules ------------------------------------------------------------------------------------------------

#[test]
fn the_ledger_counts_per_app_version_and_takes_a_stopped_attempt_back() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir
        .path()
        .join("setup-state.json")
        .to_string_lossy()
        .into_owned();
    std::fs::write(&file, json!({"gh": {"failures": 2, "lastAttempt": 5}, "nope": {"failures": 9, "lastAttempt": 1}, "node": {"failures": "x", "lastAttempt": 1}}).to_string()).unwrap();
    let any = ledger::Ledger {
        file: &file,
        app: "",
    };
    assert!(any.allows("gh", 10));
    any.record("gh", 100);
    assert!(!any.allows("gh", 100 + BACKOFF_MS - 1));
    assert!(any.allows("gh", 100 + BACKOFF_MS));
    any.uncount("gh");
    assert_eq!(
        any.attempts("gh"),
        Some(ledger::Attempts {
            failures: 2,
            last_attempt: 100
        })
    );
    let versioned = ledger::Ledger {
        file: &file,
        app: "0.90.0",
    };
    assert_eq!(
        versioned.attempts("gh"),
        None,
        "another version's misses do not count"
    );
    versioned.record("omp", 7);
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "{\n\t\"omp\": {\n\t\t\"failures\": 1,\n\t\t\"lastAttempt\": 7,\n\t\t\"app\": \"0.90.0\"\n\t}\n}\n"
    );
    versioned.uncount("omp");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "{}\n");
}

// ---- plans.test.ts ---------------------------------------------------------------------------------------------------

/// What `plans.ts` built for every item × method in the two contexts below (`plans-captured.json`, captured on
/// Windows with the darwin rows' host separator turned back into `/`), compared whole, scripts included.
fn captured_plans() -> Value {
    serde_json::from_str(include_str!("plans-captured.json")).unwrap()
}

fn mac_ctx() -> PlanContext {
    PlanContext {
        platform: "darwin".into(),
        arch: "arm64".into(),
        bun_install: "/home/u/.bun".into(),
        tools_dir: "/data/tools".into(),
        bun: Some("/home/u/.bun/bin/bun".into()),
        omp: Some("/home/u/.bun/bin/omp".into()),
        omp_specs: vec![
            format!("{OMP_PACKAGE}@18.22.2"),
            "@oh-my-pi/pi-natives@18.22.2".into(),
        ],
        omp_npm: Some(OmpNpm {
            npm: "/usr/local/bin/npm".into(),
            prefix: "/usr/local".into(),
        }),
        omp_version: "18.22.2".into(),
        brew: Some("/opt/homebrew/bin/brew".into()),
        winget: None,
        system_root: "C:\\Windows".into(),
    }
}

fn win_ctx() -> PlanContext {
    let home = "C:\\Users\\O'Brien Last";
    PlanContext {
        platform: "win32".into(),
        arch: "x64".into(),
        bun_install: format!("{home}\\.bun"),
        tools_dir: format!("{home}\\AppData\\Local\\ompdesk\\tools"),
        bun: Some(format!("{home}\\.bun\\bin\\bun.exe")),
        omp: Some(format!("{home}\\AppData\\Roaming\\npm\\omp.cmd")),
        omp_specs: vec![format!("{OMP_PACKAGE}@18.22.2")],
        omp_npm: Some(OmpNpm {
            npm: "C:\\Program Files\\nodejs\\npm.cmd".into(),
            prefix: format!("{home}\\AppData\\Roaming\\npm"),
        }),
        omp_version: "18.22.2".into(),
        brew: None,
        winget: Some("C:\\winget.exe".into()),
        system_root: "C:\\Windows".into(),
    }
}

const METHODS: [&str; 13] = [
    "bun-script",
    "bun-upgrade",
    "bun-global",
    "agent-desktop-archive",
    "npm-global",
    "omp-update",
    "portable-git",
    "xcode-select",
    "brew",
    "winget",
    "archive",
    "tailscale-zip",
    "tailscale-msi",
];

fn decode_powershell(args: &[String]) -> String {
    use base64::Engine;
    let at = args
        .iter()
        .position(|arg| arg == "-EncodedCommand")
        .unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&args[at + 1])
        .unwrap();
    let units: Vec<u16> = bytes
        .chunks(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).unwrap()
}

/// Every plan `buildPlan` builds, compared whole with the TypeScript's (every script string included).
#[test]
fn builds_every_plan_the_typescript_built() {
    let captured = captured_plans();
    let rows = captured["plans"].as_array().unwrap();
    assert!(rows.len() > 100);
    for row in rows {
        let ctx = if row["ctx"] == "mac" {
            mac_ctx()
        } else {
            win_ctx()
        };
        let item = row["item"].as_str().unwrap();
        let method = METHODS
            .into_iter()
            .find(|method| row["method"] == *method)
            .unwrap();
        let file = match item {
            "agent-desktop" if row["ctx"] == "mac" => "ad-mac.tar.gz".to_owned(),
            "agent-desktop" => "ad-win.tar.gz".to_owned(),
            _ => format!("{item}.tgz"),
        };
        let release = Release {
            item: item.into(),
            version: "1.2.0".into(),
            url: format!("https://example.test/{file}"),
            file,
            sha256: "a".repeat(64),
        };
        let tail = if row["ctx"] == "mac" {
            "Tailscale-1.104.1-macos.zip"
        } else {
            "tailscale-setup-1.104.1-amd64.msi"
        };
        let tailscale = Release {
            item: "tailscale".into(),
            version: "1.104.1".into(),
            file: tail.into(),
            url: format!("https://pkgs.tailscale.com/stable/{tail}"),
            sha256: "b".repeat(64),
        };
        let plan = plans::build_plan(item, method, &ctx, Some(&release), Some(&tailscale));
        let mut built = serde_json::to_value(&plan).unwrap();
        if let Some(plan) = &plan
            && plan.spawn.args.iter().any(|arg| arg == "-EncodedCommand")
        {
            assert_eq!(
                decode_powershell(&plan.spawn.args),
                plan.command,
                "{item} {method}"
            );
            let last = plan.spawn.args.len() - 1;
            built["spawn"]["args"][last] = json!("<command, UTF-16LE base64>");
        }
        assert_eq!(built, row["plan"], "{} {item} {method}", row["ctx"]);
    }
}

/// manualSteps: "gives the per-platform command and the official page", "asks nobody to run a command for Bun or omp"
/// (and every other row, captured).
#[test]
fn gives_the_manual_steps_the_typescript_gave() {
    for row in captured_plans()["manual"].as_array().unwrap() {
        let (commands, url) = plans::manual_steps(
            row["item"].as_str().unwrap(),
            row["platform"].as_str().unwrap(),
        );
        assert_eq!(
            json!({"commands": commands, "url": url}),
            row["steps"],
            "{row}"
        );
    }
}

/// selectMethod: "never plans an install for something present, or on an unsupported platform", "picks Bun's script
/// and an exact-version install for omp, npm's for an omp npm owns, never stock's update", "upgrades a Bun older than
/// omp's engines", "installs Git through the Xcode tools on macOS and PortableGit on Windows", "uses Homebrew or an
/// archive on macOS, winget or nothing on Windows", agent-desktop's and Tailscale's rows.
#[test]
fn selects_the_method_the_typescript_selected() {
    use plans::select_method as select;
    let (mut mac, mut win) = (mac_ctx(), win_ctx());
    mac.omp_npm = None;
    win.omp_npm = None;
    let other = PlanContext {
        platform: "other".into(),
        ..mac.clone()
    };
    for item in ["bun", "omp", "git", "gh", "node"] {
        assert_eq!(select(item, &present("1.0.0"), &mac), None);
        assert_eq!(select(item, &Presence::Missing, &other), None);
    }
    let too_old_omp = outdated("18.0.0", "18.8.7", "/home/u/.bun/bin/omp");
    assert_eq!(select("bun", &Presence::Missing, &mac), Some("bun-script"));
    assert_eq!(select("bun", &Presence::Missing, &win), Some("bun-script"));
    assert_eq!(select("omp", &Presence::Missing, &mac), Some("bun-global"));
    assert_eq!(
        select("omp", &broken("x", Some("/x")), &mac),
        Some("bun-global")
    );
    assert_eq!(select("omp", &too_old_omp, &mac), Some("bun-global"));
    let npm = PlanContext {
        omp_npm: Some(OmpNpm {
            npm: "/usr/local/bin/npm".into(),
            prefix: "/usr/local".into(),
        }),
        ..mac.clone()
    };
    assert_eq!(select("omp", &too_old_omp, &npm), Some("npm-global"));
    assert_eq!(
        select("omp", &broken("x", Some("/x")), &npm),
        Some("npm-global")
    );
    let bun_too_old = outdated("1.4.2", "1.4.4", "/home/u/.bun/bin/bun");
    assert_eq!(select("bun", &bun_too_old, &mac), Some("bun-upgrade"));
    assert_eq!(select("bun", &bun_too_old, &win), Some("bun-upgrade"));
    assert_eq!(
        select(
            "bun",
            &bun_too_old,
            &PlanContext {
                bun: None,
                ..mac.clone()
            }
        ),
        Some("bun-script")
    );
    assert_eq!(
        select("git", &Presence::Missing, &mac),
        Some("xcode-select")
    );
    assert_eq!(
        select("git", &Presence::Missing, &win),
        Some("portable-git")
    );
    assert_eq!(
        select(
            "git",
            &Presence::Missing,
            &PlanContext {
                winget: None,
                ..win.clone()
            }
        ),
        Some("portable-git")
    );
    for item in ["gh", "node"] {
        assert_eq!(select(item, &Presence::Missing, &mac), Some("brew"));
        assert_eq!(
            select(
                item,
                &Presence::Missing,
                &PlanContext {
                    brew: None,
                    ..mac.clone()
                }
            ),
            Some("archive")
        );
        assert_eq!(select(item, &Presence::Missing, &win), Some("winget"));
        assert_eq!(
            select(
                item,
                &Presence::Missing,
                &PlanContext {
                    winget: None,
                    ..win.clone()
                }
            ),
            None
        );
    }
    let arm = PlanContext {
        arch: "arm64".into(),
        ..win.clone()
    };
    for ctx in [
        &mac,
        &win,
        &PlanContext {
            brew: None,
            ..mac.clone()
        },
        &PlanContext {
            winget: None,
            ..win.clone()
        },
        &arm,
    ] {
        for found in [
            Presence::Missing,
            outdated("1.1.0", "1.2.0", "/x"),
            broken("x", Some("/x")),
        ] {
            assert_eq!(
                select("agent-desktop", &found, ctx),
                Some("agent-desktop-archive")
            );
        }
        assert_eq!(select("agent-desktop", &present("1.0.0"), ctx), None);
    }
    assert_eq!(
        select(
            "agent-desktop",
            &Presence::Missing,
            &PlanContext {
                arch: "ia32".into(),
                ..win.clone()
            }
        ),
        None
    );
    assert_eq!(select("agent-desktop", &Presence::Missing, &other), None);
    assert_eq!(
        select("tailscale", &Presence::Missing, &mac),
        Some("tailscale-zip")
    );
    assert_eq!(
        select(
            "tailscale",
            &Presence::Missing,
            &PlanContext {
                brew: None,
                ..mac.clone()
            }
        ),
        Some("tailscale-zip")
    );
    assert_eq!(
        select("tailscale", &Presence::Missing, &win),
        Some("winget")
    );
    let no_winget = PlanContext {
        winget: None,
        ..win.clone()
    };
    assert_eq!(
        select("tailscale", &Presence::Missing, &no_winget),
        Some("tailscale-msi")
    );
    assert_eq!(
        select(
            "tailscale",
            &Presence::Missing,
            &PlanContext {
                arch: "ia32".into(),
                ..no_winget.clone()
            }
        ),
        Some("tailscale-msi")
    );
    assert_eq!(
        select(
            "tailscale",
            &Presence::Missing,
            &PlanContext {
                arch: "riscv64".into(),
                ..no_winget
            }
        ),
        None
    );
    assert_eq!(select("tailscale", &present("1.0.0"), &mac), None);
    assert_eq!(select("tailscale", &Presence::Missing, &other), None);
    assert_eq!(
        ["x64", "arm64", "ia32", "ppc"].map(plans::tailscale_msi_arch),
        [Some("amd64"), Some("arm64"), Some("x86"), None]
    );
}

/// buildPlan: "installs Bun on Windows over a running or missing bun.exe, and fails when no Bun answers"
#[test]
fn installs_bun_on_windows_over_a_running_or_missing_bun_exe() {
    let script = plans::build_plan("bun", "bun-script", &win_ctx(), None, None)
        .unwrap()
        .command;
    let at = |text: &str| script.find(text).unwrap_or_else(|| panic!("{text}"));
    assert!(script.contains("$exe = Join-Path 'C:\\Users\\O''Brien Last\\.bun' 'bin\\bun.exe'"));
    let order = [
        at("Move-Item -LiteralPath $exe -Destination $aside"),
        at("Invoke-RestMethod -Uri 'https://bun.sh/install.ps1' | Invoke-Expression"),
        at("& $exe --version"),
        at("Move-Item -LiteralPath $aside -Destination $exe"),
        at("throw 'Bun was not installed"),
    ];
    assert!(order.is_sorted());
    assert!(script.contains("if (Test-Path -LiteralPath $exe) {"));
}

/// buildPlan: "is a script Windows PowerShell parses" (Windows only)
#[cfg(windows)]
#[test]
fn bun_script_is_a_script_windows_powershell_parses() {
    let script = plans::build_plan("bun", "bun-script", &win_ctx(), None, None)
        .unwrap()
        .command;
    let check = "$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:OMPDESK_SCRIPT, [ref]$null, [ref]$errors); $errors | ForEach-Object { $_.Message }; exit $errors.Count";
    let parsed = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", check])
        .env("OMPDESK_SCRIPT", script)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&parsed.stdout).trim(), "");
    assert!(parsed.status.success());
}

/// buildPlan: "installs omp at the versions it is handed, with the absolute bun path, and refuses without Bun",
/// "upgrades Bun with the absolute bun path", "updates omp through its own bin, quoting a Windows .cmd shim for
/// cmd.exe", "downloads nothing itself for the other methods", "passes winget the exact id and both agreement flags",
/// "has main download the pinned PortableGit … extracts it without admin", "unpacks an archive … only after its
/// SHA-256 matched", the agent-desktop and Tailscale plans: whole in `builds_every_plan_the_typescript_built`; what
/// those cases assert beyond the captured contexts is here.
#[test]
fn refuses_the_plans_a_context_cannot_run() {
    let mac = mac_ctx();
    let no_bun = PlanContext {
        bun: None,
        ..mac.clone()
    };
    assert!(plans::build_plan("omp", "bun-global", &no_bun, None, None).is_none());
    assert!(plans::build_plan("bun", "bun-upgrade", &no_bun, None, None).is_none());
    assert!(
        plans::build_plan(
            "omp",
            "omp-update",
            &PlanContext {
                omp: None,
                ..mac.clone()
            },
            None,
            None
        )
        .is_none()
    );
    assert!(
        plans::build_plan(
            "omp",
            "npm-global",
            &PlanContext {
                omp_npm: None,
                ..win_ctx()
            },
            None,
            None
        )
        .is_none()
    );
    assert!(plans::build_plan("node", "archive", &mac, None, None).is_none());
    assert!(
        plans::build_plan("agent-desktop", "agent-desktop-archive", &mac, None, None).is_none()
    );
    let ad = Release {
        item: "agent-desktop".into(),
        version: "1.2.0".into(),
        file: "x.tar.gz".into(),
        url: "https://x/x.tar.gz".into(),
        sha256: "a".repeat(64),
    };
    assert!(plans::build_plan("gh", "agent-desktop-archive", &mac, Some(&ad), None).is_none());
    assert!(plans::build_plan("agent-desktop", "archive", &mac, Some(&ad), None).is_none());
    assert!(
        plans::build_plan(
            "agent-desktop",
            "agent-desktop-archive",
            &PlanContext {
                platform: "other".into(),
                ..mac.clone()
            },
            Some(&ad),
            None
        )
        .is_none()
    );
    assert!(plans::build_plan("tailscale", "tailscale-zip", &mac, None, None).is_none());
    assert!(plans::build_plan("tailscale", "tailscale-msi", &win_ctx(), None, None).is_none());
    let arm = plans::build_plan(
        "git",
        "portable-git",
        &PlanContext {
            arch: "arm64".into(),
            ..win_ctx()
        },
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        arm.download.unwrap().sha256,
        "0f21e681bd33e006e0348dfa1a2be6769efd77e3bfdb247320314facde23a46c"
    );
    let quoted = plans::build_plan(
        "git",
        "portable-git",
        &PlanContext {
            tools_dir: "C:\\Users\\O'Brien\\tools".into(),
            ..win_ctx()
        },
        None,
        None,
    )
    .unwrap();
    assert!(quoted.command.contains("'C:\\Users\\O''Brien\\tools\\git'"));
    assert!(!quoted.command.contains("Invoke-WebRequest") && !quoted.command.contains("RunAs"));
}

/// "names the omp package at one exact version, and with it the natives packages Bun's global manifest pins"
#[test]
fn names_omp_and_the_natives_its_root_pins() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    assert_eq!(
        plans::omp_install_specs(&root, "18.22.2"),
        [format!("{OMP_PACKAGE}@18.22.2")]
    );
    let global = dir.path().join("install").join("global");
    std::fs::create_dir_all(&global).unwrap();
    let manifest = global.join("package.json");
    std::fs::write(&manifest, json!({"dependencies": {OMP_PACKAGE: "18.22.0", "@oh-my-pi/pi-natives": "18.22.0", "@oh-my-pi/pi-natives-darwin-arm64": "18.22.0", "@oh-my-pi/pi-natively-other": "1.0.0", "typescript": "5.9.0"}}).to_string()).unwrap();
    assert_eq!(
        plans::omp_install_specs(&root, "18.22.2"),
        [
            format!("{OMP_PACKAGE}@18.22.2"),
            "@oh-my-pi/pi-natives@18.22.2".into(),
            "@oh-my-pi/pi-natives-darwin-arm64@18.22.2".into()
        ]
    );
    std::fs::write(&manifest, "not json").unwrap();
    assert_eq!(
        plans::omp_install_specs(&root, "18.22.2"),
        [format!("{OMP_PACKAGE}@18.22.2")]
    );
}

/// "installs a too-old omp npm owns at the one version it is handed, into that npm's prefix" (POSIX)
#[cfg(unix)]
#[tokio::test]
async fn finds_the_npm_that_owns_a_posix_omp() {
    let dir = tempfile::tempdir().unwrap();
    let (prefix, omp, npm) = npm_prefix(dir.path());
    let owner = plans::omp_npm_owner(&omp, "darwin", "/data/tools", "").await;
    assert_eq!(
        owner,
        Some(OmpNpm {
            npm: npm.clone(),
            prefix: prefix.clone()
        })
    );
    let ctx = PlanContext {
        omp: Some(omp.clone()),
        omp_npm: owner,
        ..mac_ctx()
    };
    assert_eq!(
        plans::select_method("omp", &outdated("18.0.0", "18.8.7", &omp), &ctx),
        Some("npm-global")
    );
    let plan = plans::build_plan("omp", "npm-global", &ctx, None, None).unwrap();
    assert_eq!(
        plan.spawn,
        SpawnSpec {
            file: npm.clone(),
            args: [
                "install",
                "-g",
                "--prefix",
                &prefix,
                &format!("{OMP_PACKAGE}@18.22.2")
            ]
            .map(str::to_owned)
            .to_vec(),
            ..SpawnSpec::default()
        }
    );
    assert_eq!(
        plan.command,
        format!("\"{npm}\" install -g --prefix \"{prefix}\" {OMP_PACKAGE}@18.22.2")
    );
    let other = Path::new(&prefix)
        .join("lib")
        .join("node_modules")
        .join("other")
        .join("cli.js");
    std::fs::create_dir_all(other.parent().unwrap()).unwrap();
    std::fs::write(&other, "").unwrap();
    assert_eq!(
        plans::omp_npm_owner(&other.to_string_lossy(), "darwin", "/data/tools", "").await,
        None
    );
    assert_eq!(
        plans::omp_npm_owner("/opt/checkout/bin/omp", "darwin", "/data/tools", "").await,
        None
    );
}

/// "follows a Windows npm .cmd shim to the prefix that holds omp, and runs npm.cmd from PATH through cmd.exe"
#[tokio::test]
async fn follows_a_windows_npm_shim_to_its_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let root = PathBuf::from(root.to_string_lossy().trim_start_matches(r"\\?\"));
    let (prefix, node) = (root.join("npm"), root.join("nodejs"));
    std::fs::create_dir_all(&prefix).unwrap();
    std::fs::create_dir_all(&node).unwrap();
    std::fs::write(node.join("npm.cmd"), "").unwrap();
    let shim = prefix.join("omp.cmd");
    std::fs::write(
        &shim,
        "@ECHO off\r\n\"%dp0%\\node_modules\\@oh-my-pi\\pi-coding-agent\\src\\cli.ts\" %*\r\n",
    )
    .unwrap();
    let text = |path: &Path| path.to_string_lossy().into_owned();
    let owner = plans::omp_npm_owner(&text(&shim), "win32", "C:\\tools", &text(&node)).await;
    assert_eq!(
        owner,
        Some(OmpNpm {
            npm: text(&node.join("npm.cmd")),
            prefix: crate::fs::path::normalize_win32(&text(&prefix))
        })
    );
    assert_eq!(
        plans::omp_npm_owner(&text(&shim), "win32", "C:\\tools", "").await,
        None
    );
    let local = root.join("proj").join("node_modules").join(".bin");
    std::fs::create_dir_all(&local).unwrap();
    std::fs::write(
        local.join("omp.cmd"),
        "\"%dp0%\\..\\@oh-my-pi\\pi-coding-agent\\src\\cli.ts\" %*\r\n",
    )
    .unwrap();
    assert_eq!(
        plans::omp_npm_owner(
            &text(&local.join("omp.cmd")),
            "win32",
            "C:\\tools",
            &text(&node)
        )
        .await,
        None
    );
}

// ---- git-aslr.test.ts --------------------------------------------------------------------------------------------

/// gitAslrSpawn: "elevates one step that turns only ForceRelocateImages off …", "undoes only the recorded images'
/// ForceRelocateImages bits", "quotes a path with a quote in it": both scripts compared whole with the TypeScript's.
#[test]
fn elevates_the_scripts_the_typescript_elevated() {
    for row in captured_plans()["aslr"].as_array().unwrap() {
        let action = row["action"].as_str().unwrap();
        let spec = git_aslr::spawn(
            "C:\\Windows",
            "C:\\O'Brien\\Git",
            action,
            "C:\\u\\in.json",
            "C:\\u\\out.json",
        );
        let outer = decode_powershell(&spec.args);
        assert_eq!(outer, row["outer"], "{action}");
        assert_eq!(
            git_aslr::elevated_script(
                "C:\\O'Brien\\Git",
                action,
                "C:\\u\\in.json",
                "C:\\u\\out.json"
            ),
            row["elevated"],
            "{action}"
        );
        assert_eq!(
            spec.file,
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        );
    }
    let fix = git_aslr::elevated_script("C:\\Program Files\\Git", "fix", "in", "out");
    assert!(fix.contains(
        "Get-ChildItem -LiteralPath 'C:\\Program Files\\Git\\usr' -Recurse -File -Filter *.exe"
    ));
    assert!(
        fix.contains("if ($prior -eq 2) { continue }") && !fix.contains("Set-ProcessMitigation")
    );
    let undo = git_aslr::elevated_script("C:\\Program Files\\Git", "undo", "in", "out");
    assert!(undo.contains("-eq 2) { Set-Relocate $entry $options ([int]$e.prior) }"));
    assert!(!undo.contains("Remove-Item") && !undo.contains("-Remove"));
}

/// "reads the step's output: prior nibble 0/1/3 as notset/on/on-require-relocs, anything else dropped"
#[test]
fn reads_the_elevated_steps_output() {
    let sh = "C:\\Program Files\\Git\\usr\\bin\\sh.exe";
    let output = format!(
        "\u{feff}{}",
        json!([{"path": sh, "prior": 0}, {"path": "a", "prior": 1}, {"path": "b", "prior": 3}, {"path": "c", "prior": 2}])
    );
    let image = |path: &str, prior: &str| git_aslr::Image {
        path: path.into(),
        prior: prior.into(),
    };
    assert_eq!(
        git_aslr::parse_fix_output(&output),
        [
            image(sh, "notset"),
            image("a", "on"),
            image("b", "on-require-relocs")
        ]
    );
    assert_eq!(
        git_aslr::parse_fix_output("{\"path\":\"a\",\"prior\":1}"),
        [image("a", "on")]
    );
    assert!(git_aslr::parse_fix_output("").is_empty());
    assert_eq!(git_aslr::parse_undo_output("[\"a\",\"b\"]"), ["a", "b"]);
    assert_eq!(git_aslr::parse_undo_output("\"a\""), ["a"]);
}

/// "keeps the state before OMPdesk across a second Fix and drops only what Undo restored"
#[test]
fn keeps_the_state_before_ompdesk_across_a_second_fix() {
    let root = "C:\\Program Files\\Git";
    let sh = "C:\\Program Files\\Git\\usr\\bin\\sh.exe";
    let ls = "C:\\Program Files\\Git\\usr\\bin\\ls.exe";
    let image = |path: &str, prior: &str| git_aslr::Image {
        path: path.into(),
        prior: prior.into(),
    };
    let first = git_aslr::with_fixed(&git_aslr::Record::default(), root, &[image(sh, "on")]);
    let second = git_aslr::with_fixed(
        &first,
        "c:\\program files\\git\\",
        &[image(&sh.to_uppercase(), "notset"), image(ls, "notset")],
    );
    assert_eq!(
        git_aslr::recorded_images(&second, root),
        [image(sh, "on"), image(ls, "notset")]
    );
    let file = tempfile::tempdir().unwrap();
    let path = file
        .path()
        .join(git_aslr::RECORD)
        .to_string_lossy()
        .into_owned();
    git_aslr::write_record(&path, &second).unwrap();
    let round = git_aslr::read_record(&path);
    assert_eq!(round, second);
    let input: Value = serde_json::from_str(&git_aslr::undo_input(&git_aslr::recorded_images(
        &round, root,
    )))
    .unwrap();
    assert_eq!(
        input,
        json!([{"path": sh, "prior": 1}, {"path": ls, "prior": 0}])
    );
    let partly = git_aslr::with_restored(&round, root, &[sh.to_owned()]);
    assert_eq!(
        git_aslr::recorded_images(&partly, root),
        [image(ls, "notset")]
    );
    let none = git_aslr::with_restored(&partly, root, &[ls.to_owned()]);
    assert!(none.roots.is_empty());
    git_aslr::write_record(&path, &none).unwrap();
    assert!(!Path::new(&path).exists(), "an empty record is removed");
}

/// "reads a missing or damaged record as empty, so Undo is not offered"
#[test]
fn reads_a_missing_or_damaged_record_as_empty() {
    assert!(git_aslr::parse_record("").roots.is_empty());
    assert!(
        git_aslr::parse_record("{\"version\":2,\"roots\":{}}")
            .roots
            .is_empty()
    );
    assert!(
        git_aslr::parse_record(
            "{\"version\":1,\"roots\":{\"x\":[{\"path\":\"a\",\"prior\":\"off\"}]}}"
        )
        .roots
        .is_empty()
    );
}

/// gitAslrOverridden: "finds the override on that Git's sh.exe only, with Force randomization off whatever else is set"
#[test]
fn finds_the_override_on_that_gits_sh_only() {
    let query = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\sh.exe\r\n    UseFilter    REG_DWORD    0x1\r\n\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\sh.exe\\{7a215fff-e151-d290-08ca-af287bbaf5fb}\r\n    FilterFullPath    REG_SZ    C:\\Program Files\\Git\\usr\\bin\\sh.exe\r\n    MitigationOptions    REG_BINARY    010200000000000000000000000000000000000000000000\r\n";
    assert!(git_aslr::overridden(query, "C:\\Program Files\\Git"));
    assert!(git_aslr::overridden(query, "c:\\program files\\git"));
    assert!(!git_aslr::overridden(query, "D:\\PortableGit"));
    assert!(!git_aslr::overridden(
        &query.replace("0102", "0101"),
        "C:\\Program Files\\Git"
    ));
    assert!(!git_aslr::overridden("", "C:\\Program Files\\Git"));
}
