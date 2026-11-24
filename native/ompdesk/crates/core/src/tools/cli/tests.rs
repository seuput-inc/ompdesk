//! `cli-tools/updater.test.ts` (fake detection, a fake check and a fake installer: only installed tools are listed and
//! updated, check → update → re-detect, current tools are left alone, a running Node CLI's update waits on macOS but
//! a Windows lock is only a recorded failure, failures back off, skipped copies carry their reason, the pref gates
//! scheduled passes but not "Update now", and the calls take tool ids only), `detect.test.ts` and the CLI-only cases of
//! `plans.test.ts`, on a `tools` instance with main's timers.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::Notify;
use tokio::task::LocalSet;

use super::catalog::relevant_tools;
use super::detect::{DetectDeps, gh_copilot_version};
use super::*;
use crate::tools::queue::STEP_MAX_MS;
use crate::tools::runner::Supervisor;
use crate::tools::{CHECK_INTERVAL_MS, Main, call_tools};

const START: u64 = 1_000_000;

/// Main as these tests see it: the items, `env` and the stock worker's providers.
#[derive(Default)]
struct Host {
    items: RefCell<Vec<Value>>,
    providers: RefCell<Option<Vec<String>>>,
    env_fails: Cell<bool>,
}

impl Main for Host {
    fn push(&self, item: Value) {
        self.items.borrow_mut().push(item);
    }

    fn ask(&self, q: &str, payload: Value) -> LocalFuture<Result<Value, Fault>> {
        let answer = match q {
            "env" if self.env_fails.get() => Err(Fault::new("no_env", "no shell env")),
            "env" => Ok(json!({"PATH": "/nowhere"})),
            "stock" if payload["method"] == "accounts.providers" => match &*self.providers.borrow()
            {
                Some(providers) => Ok(json!({"providers": providers})),
                None => Err(Fault::new("stock", "omp is not installed")),
            },
            _ => Err(Fault::new("no_answer", q.to_owned())),
        };
        Box::pin(async move { answer })
    }
}

/// The machine as these tests see it.
struct Fake {
    detections: RefCell<HashMap<&'static str, Detection>>,
    checks: RefCell<Vec<Vec<String>>>,
    latest: RefCell<Result<String, String>>,
    managed: RefCell<Vec<String>>,
    updates: RefCell<Vec<ToolUpdateRequest>>,
    outcome: RefCell<ToolUpdateOutcome>,
    /// What `detect` finds once an update ran (the install it models).
    installs: RefCell<Option<Detection>>,
    /// An update that never answers.
    hangs: Cell<bool>,
    processes: RefCell<String>,
    running_fails: Cell<bool>,
    /// The first check waits for it.
    gate: RefCell<Option<Rc<Notify>>>,
    order: RefCell<Vec<String>>,
}

impl Default for Fake {
    fn default() -> Fake {
        Fake {
            detections: RefCell::new(HashMap::from([("codex", codex("0.50.1"))])),
            checks: RefCell::default(),
            latest: RefCell::new(Ok("0.51.0".into())),
            managed: RefCell::default(),
            updates: RefCell::default(),
            outcome: RefCell::new(ToolUpdateOutcome::Succeeded),
            installs: RefCell::default(),
            hangs: Cell::new(false),
            processes: RefCell::default(),
            running_fails: Cell::new(false),
            gate: RefCell::default(),
            order: RefCell::default(),
        }
    }
}

struct Faked(Rc<Fake>);

impl Io for Faked {
    fn detect(&self, id: &'static str, _: &DetectDeps) -> LocalFuture<Option<Detection>> {
        let found = self.0.detections.borrow().get(id).cloned();
        Box::pin(async move { found })
    }

    fn run_check(&self, command: &CliCommand, _: &Env) -> LocalFuture<Result<String, String>> {
        let fake = Rc::clone(&self.0);
        let mut line = vec![command.spawn.file.clone()];
        line.extend(command.spawn.args.iter().cloned());
        Box::pin(async move {
            fake.checks.borrow_mut().push(line);
            let n = fake.checks.borrow().len();
            fake.order.borrow_mut().push(format!("check {n}"));
            let gate = if n == 1 {
                fake.gate.borrow().clone()
            } else {
                None
            };
            if let Some(gate) = gate {
                gate.notified().await;
            }
            fake.order.borrow_mut().push(format!("end {n}"));
            fake.latest
                .borrow()
                .clone()
                .map(|latest| format!("{latest}\n"))
        })
    }

    fn running(
        &self,
        detection: &Detection,
        owner: &Value,
        _: Option<String>,
    ) -> LocalFuture<Result<bool, String>> {
        if self.0.running_fails.get() {
            return Box::pin(async { Err("ompdesk-core ended".to_owned()) });
        }
        System.running(detection, owner, Some(self.0.processes.borrow().clone()))
    }

    fn latest_managed(&self, _: &Rc<Tools>, item: &str) -> LocalFuture<Result<String, String>> {
        self.0.managed.borrow_mut().push(item.to_owned());
        let answer = if item == "agent-desktop" {
            "1.3.0"
        } else {
            "2.99.0"
        };
        Box::pin(async move { Ok(answer.to_owned()) })
    }

    fn run_update(
        &self,
        _: &Rc<Tools>,
        _: &Ctx,
        request: ToolUpdateRequest,
    ) -> LocalFuture<ToolUpdateOutcome> {
        let fake = Rc::clone(&self.0);
        Box::pin(async move {
            fake.updates.borrow_mut().push(request.clone());
            if fake.hangs.get() {
                std::future::pending::<()>().await;
            }
            if let Some(after) = fake.installs.borrow_mut().take() {
                fake.detections.borrow_mut().insert(after.id, after);
            }
            fake.outcome.borrow().clone()
        })
    }
}

fn npm() -> Value {
    json!({"method": "npm", "name": "@openai/codex", "prefix": "/p", "root": "/p/lib/node_modules/@openai/codex"})
}

fn codex(installed: &str) -> Detection {
    Detection {
        id: "codex",
        path: "/p/bin/codex".into(),
        real: "/p/lib/node_modules/@openai/codex/bin/codex.js".into(),
        owner: Some(npm()),
        skip: None,
        installed: Some(installed.into()),
    }
}

fn found(id: &'static str, installed: &str, owner: Value) -> Detection {
    Detection {
        id,
        owner: Some(owner),
        ..codex(installed)
    }
}

struct H {
    tools: Rc<Tools>,
    host: Rc<Host>,
    fake: Rc<Fake>,
    prefs: String,
    fired: RefCell<Vec<u64>>,
    _dir: TempDir,
}

fn spawn_local(task: LocalFuture<()>) {
    tokio::task::spawn_local(task);
}

fn harness_with(scheduled: bool, platform: &str, installer: Option<&str>, bound_ms: u64) -> H {
    let dir = tempfile::tempdir().unwrap();
    let prefs = dir.path().join("prefs.json").to_string_lossy().into_owned();
    // A proxy of its own: no test asks the system's.
    crate::prefs::set(&prefs, "proxyUrl", json!("http://proxy.test:3128")).unwrap();
    let opts = serde_json::from_value(json!({
        "platform": platform,
        "arch": "x64",
        "toolsDir": "/tools",
        "userData": dir.path().to_string_lossy(),
        "appVersion": "0.0.0",
        "automatic": false,
        "scheduled": {"omp": false, "cli": scheduled, "ext": false},
        "testInstaller": installer,
        "manual": true,
        "now": START,
    }))
    .unwrap();
    let host = Rc::new(Host::default());
    *host.providers.borrow_mut() = Some(vec!["openai-codex".into()]);
    let tools = Tools::new(
        opts,
        host.clone(),
        spawn_local,
        Supervisor::this_binary(),
        bound_ms,
    );
    let fake = Rc::new(Fake::default());
    tools.cli.borrow_mut().io = Rc::new(Faked(Rc::clone(&fake)));
    H {
        tools,
        host,
        fake,
        prefs,
        fired: RefCell::default(),
        _dir: dir,
    }
}

fn harness(scheduled: bool) -> H {
    harness_with(scheduled, "darwin", Some("/fake/installer"), STEP_MAX_MS)
}

async fn later(outcome: Outcome) -> Answer {
    match outcome {
        Outcome::Later(answer) => answer.await,
        Outcome::Now(answer) => answer,
    }
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

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

impl H {
    fn call(&self, method: &str, params: Value) -> Outcome {
        call_tools(
            &self.tools,
            method,
            &serde_json::value::to_raw_value(&params).unwrap(),
        )
    }

    async fn now(&self, id: Option<&str>) -> Answer {
        later(self.call("cli.now", json!({"id": id}))).await
    }

    async fn rescan(&self) -> Answer {
        later(self.call("cli.rescan", json!({}))).await
    }

    fn pref_changed(&self) {
        assert!(matches!(
            self.call("cli.prefChanged", json!({})),
            Outcome::Now(Ok(Value::Null))
        ));
    }

    async fn start(&self) {
        assert!(self.tools.start());
        settle().await;
    }

    fn state(&self) -> Value {
        state(&self.tools)
    }

    fn tool(&self, id: &str) -> Value {
        self.state()["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["id"] == id)
            .cloned()
            .unwrap_or(Value::Null)
    }

    fn ids(&self) -> Vec<String> {
        self.state()["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["id"].as_str().unwrap().to_owned())
            .collect()
    }

    fn states(&self) -> Vec<Value> {
        self.host
            .items
            .borrow()
            .iter()
            .filter(|item| item["k"] == "state" && item["part"] == "cli")
            .map(|item| item["state"].clone())
            .collect()
    }

    fn checks(&self) -> usize {
        self.fake.checks.borrow().len()
    }

    fn updates(&self) -> usize {
        self.fake.updates.borrow().len()
    }

    fn set_pref(&self, on: bool) {
        crate::prefs::set(&self.prefs, "toolsAutoUpdate", json!(on)).unwrap();
    }

    /// Main's clock moves on by `ms` (no timer fires).
    fn advance(&self, ms: u64) {
        let now = self.tools.clock.now_ms() + ms;
        self.tools.clock.fire(u64::MAX, Some(now));
    }

    /// The newest timer of `ms` main holds (not cleared, not fired).
    fn timer(&self, ms: u64) -> Option<u64> {
        let items = self.host.items.borrow();
        let gone: Vec<Value> = items
            .iter()
            .filter(|item| item["k"] == "clearTimer")
            .map(|item| item["timer"].clone())
            .chain(self.fired.borrow().iter().map(|timer| json!(timer)))
            .collect();
        items
            .iter()
            .filter(|item| {
                item["k"] == "timer" && item["ms"] == ms && !gone.contains(&item["timer"])
            })
            .filter_map(|item| item["timer"].as_u64())
            .next_back()
    }

    /// Main fires the 4 h timer `after` ms past the clock now.
    async fn tick(&self, after: u64) {
        until(|| self.timer(CHECK_INTERVAL_MS).is_some()).await;
        let timer = self.timer(CHECK_INTERVAL_MS).unwrap();
        self.fired.borrow_mut().push(timer);
        let now = self.tools.clock.now_ms() + after;
        assert!(self.tools.clock.fire(timer, Some(now)));
        settle().await;
    }
}

async fn local(test: impl Future<Output = ()>) {
    LocalSet::new().run_until(test).await;
}

#[tokio::test]
async fn lists_only_installed_tools_of_the_connected_providers_plus_setups_and_installs_nothing() {
    // "lists only installed tools of the connected providers, plus machine setup's, and installs nothing"
    local(async {
        let h = harness(false);
        *h.host.providers.borrow_mut() = Some(vec!["openai-codex".into(), "anthropic".into()]);
        h.fake.detections.borrow_mut().insert(
            "gh",
            Detection {
                id: "gh",
                path: "/opt/homebrew/bin/gh".into(),
                real: "/opt/homebrew/Cellar/gh/2.96.0/bin/gh".into(),
                owner: Some(json!({"method": "brew", "name": "gh", "brew": "/opt/homebrew/bin/brew"})),
                skip: None,
                installed: Some("2.96.0".into()),
            },
        );
        // claude is connected but not installed: it is not listed, and nothing runs for it.
        h.start().await;
        h.rescan().await.unwrap();
        assert_eq!(h.ids(), ["codex", "gh"]);
        assert_eq!(
            h.tool("codex"),
            json!({"id": "codex", "providers": ["openai-codex"], "installed": "0.50.1", "path": "/p/lib/node_modules/@openai/codex/bin/codex.js", "method": "npm", "skip": null, "phase": "idle", "latest": null, "checkedAt": null, "last": null})
        );
        assert_eq!((h.tool("gh")["providers"].clone(), h.tool("gh")["method"].clone()), (json!([]), json!("brew")));
        assert_eq!((h.updates(), h.checks()), (0, 0));
    })
    .await;
}

#[tokio::test]
async fn still_lists_machine_setups_tools_when_the_provider_list_cannot_be_read() {
    // "still lists machine setup's tools when the provider list cannot be read"
    local(async {
        let h = harness(false);
        *h.host.providers.borrow_mut() = None;
        *h.fake.detections.borrow_mut() = HashMap::from([(
            "node",
            found(
                "node",
                "24.11.0",
                json!({"method": "managed", "item": "node"}),
            ),
        )]);
        h.start().await;
        h.rescan().await.unwrap();
        assert_eq!(h.ids(), ["node"]);
    })
    .await;
}

#[tokio::test]
async fn checks_updates_through_the_setup_supervisor_and_detects_again() {
    // "checks, updates through the setup supervisor and detects again: codex 0.50.1 → 0.51.0"
    local(async {
        let h = harness(true);
        *h.fake.installs.borrow_mut() = Some(codex("0.51.0"));
        h.now(Some("codex")).await.unwrap();
        // The test installer is asked for the newest version with the tool and its method.
        assert_eq!(
            *h.fake.checks.borrow(),
            [["/fake/installer", "cli-codex", "npm", "check"]]
        );
        assert_eq!(
            *h.fake.updates.borrow(),
            [ToolUpdateRequest {
                tool: "codex".into(),
                method: "npm".into(),
                spawn: None,
                managed: None,
                env: Env::new()
            }]
        );
        let tool = h.tool("codex");
        assert_eq!(
            (
                &tool["phase"],
                &tool["installed"],
                &tool["latest"],
                &tool["last"]
            ),
            (
                &json!("idle"),
                &json!("0.51.0"),
                &json!("0.51.0"),
                &json!({"kind": "updated", "from": "0.50.1", "to": "0.51.0"})
            )
        );
        // The phases the UI shows, in order.
        let phases: Vec<Value> = h
            .states()
            .iter()
            .filter_map(|state| {
                state["tools"]
                    .as_array()?
                    .iter()
                    .find(|t| t["id"] == "codex")
                    .map(|t| t["phase"].clone())
            })
            .collect();
        assert!(
            phases.contains(&json!("checking")) && phases.contains(&json!("updating")),
            "{phases:?}"
        );
        assert_eq!(phases.last(), Some(&json!("idle")));
    })
    .await;
}

#[tokio::test]
async fn leaves_a_current_tool_alone() {
    // "leaves a current tool alone"
    local(async {
        let h = harness(true);
        *h.fake.latest.borrow_mut() = Ok("0.50.1".into());
        h.now(Some("codex")).await.unwrap();
        assert_eq!(h.updates(), 0);
        assert_eq!(
            (
                h.tool("codex")["last"].clone(),
                h.tool("codex")["latest"].clone()
            ),
            (json!({"kind": "current"}), json!("0.50.1"))
        );
    })
    .await;
}

#[tokio::test]
async fn compares_versions_as_numbers() {
    // "compares versions as numbers: 0.9.0 installed is older than 0.10.0"
    local(async {
        let h = harness(true);
        h.fake
            .detections
            .borrow_mut()
            .insert("codex", codex("0.9.0"));
        *h.fake.latest.borrow_mut() = Ok("0.10.0".into());
        h.now(Some("codex")).await.unwrap();
        assert_eq!(h.updates(), 1);
        let newer = harness(true);
        newer
            .fake
            .detections
            .borrow_mut()
            .insert("codex", codex("0.10.0"));
        *newer.fake.latest.borrow_mut() = Ok("0.9.0".into());
        newer.now(Some("codex")).await.unwrap();
        assert_eq!(newer.updates(), 0);
        assert_eq!(newer.tool("codex")["last"], json!({"kind": "current"}));
    })
    .await;
}

#[tokio::test]
async fn does_not_update_when_the_running_check_cannot_answer() {
    // "does not update when core fails to answer the running check"
    local(async {
        let h = harness(true);
        h.fake.running_fails.set(true);
        h.now(Some("codex")).await.unwrap();
        assert_eq!(h.updates(), 0);
        assert_eq!(h.tool("codex")["last"]["failure"]["reason"], "check");
    })
    .await;
}

#[tokio::test]
async fn on_macos_waits_while_the_node_cli_runs_and_updates_at_the_next_check_after_it_quits() {
    // "on macOS waits while the Node CLI runs, and updates at the next check after it quits"
    local(async {
        let h = harness(true);
        *h.fake.processes.borrow_mut() =
            "node /p/lib/node_modules/@openai/codex/bin/codex.js --model gpt-5\n".into();
        h.now(Some("codex")).await.unwrap();
        assert_eq!(h.updates(), 0);
        assert_eq!(
            h.tool("codex")["last"],
            json!({"kind": "deferred", "latest": "0.51.0"})
        );
        assert_eq!(h.tool("codex")["installed"], "0.50.1");
        // A deferral is no failure: no back-off.
        *h.fake.processes.borrow_mut() = "/sbin/launchd\n".into();
        *h.fake.installs.borrow_mut() = Some(codex("0.51.0"));
        h.now(Some("codex")).await.unwrap();
        assert_eq!(h.updates(), 1);
        assert_eq!(h.tool("codex")["last"]["to"], "0.51.0");
    })
    .await;
}

#[tokio::test]
async fn never_defers_an_update_the_vendors_own_updater_runs() {
    // "never defers an update the vendor's own updater runs (a single binary keeps its old inode)"
    local(async {
        let h = harness(true);
        let claude = Detection {
            id: "claude",
            path: "/u/.local/bin/claude".into(),
            real: "/u/.local/share/claude/v1".into(),
            ..found("claude", "2.0.1", json!({"method": "self"}))
        };
        *h.fake.detections.borrow_mut() = HashMap::from([("claude", claude)]);
        *h.host.providers.borrow_mut() = Some(vec!["anthropic".into()]);
        *h.fake.latest.borrow_mut() = Ok("2.1.0".into());
        *h.fake.processes.borrow_mut() = "/u/.local/bin/claude --resume\n".into();
        h.now(Some("claude")).await.unwrap();
        let updates = h.fake.updates.borrow();
        assert_eq!(updates.len(), 1);
        assert_eq!(
            (updates[0].tool.as_str(), updates[0].method.as_str()),
            ("claude", "self")
        );
    })
    .await;
}

#[tokio::test]
async fn on_windows_a_locked_file_is_only_a_recorded_failure_the_next_scheduled_check_retries() {
    // "on Windows a locked file is only a recorded failure that the next scheduled check retries"
    local(async {
        let h = harness_with(true, "win32", Some("/fake/installer"), STEP_MAX_MS);
        *h.fake.processes.borrow_mut() = "codex.exe\n".into();
        let busy = "exit 1 — EBUSY: resource busy or locked";
        *h.fake.outcome.borrow_mut() = ToolUpdateOutcome::Failed {
            detail: Some(busy.into()),
        };
        h.now(Some("codex")).await.unwrap();
        assert_eq!(h.updates(), 1);
        assert_eq!(
            h.tool("codex")["last"],
            json!({"kind": "failed", "failure": {"reason": "install", "detail": busy}})
        );
        // Scheduled passes honor the back-off: 4 h × 2 after one failure.
        h.start().await;
        h.rescan().await.unwrap();
        h.fake.updates.borrow_mut().clear();
        h.advance(CHECK_INTERVAL_MS);
        h.pref_changed();
        h.rescan().await.unwrap();
        assert_eq!(h.updates(), 0);
        h.advance(CHECK_INTERVAL_MS);
        *h.fake.outcome.borrow_mut() = ToolUpdateOutcome::Succeeded;
        *h.fake.installs.borrow_mut() = Some(codex("0.51.0"));
        h.pref_changed();
        h.rescan().await.unwrap();
        assert_eq!(h.updates(), 1);
        assert_eq!(h.tool("codex")["last"]["to"], "0.51.0");
    })
    .await;
}

#[tokio::test]
async fn records_a_failed_check_a_failed_or_cancelled_update_and_one_that_left_the_old_version() {
    // "records a failed check, a failed or cancelled update and an update that left the old version"
    local(async {
        let h = harness(true);
        *h.fake.latest.borrow_mut() = Err("npm ERR! network request failed".into());
        h.now(Some("codex")).await.unwrap();
        assert_eq!(
            h.tool("codex")["last"],
            json!({"kind": "failed", "failure": {"reason": "check", "detail": "npm ERR! network request failed"}})
        );
        *h.fake.latest.borrow_mut() = Ok("0.51.0".into());
        *h.fake.outcome.borrow_mut() = ToolUpdateOutcome::Cancelled;
        h.now(Some("codex")).await.unwrap();
        assert_eq!(h.tool("codex")["last"], json!({"kind": "failed", "failure": {"reason": "cancelled"}}));
        *h.fake.outcome.borrow_mut() = ToolUpdateOutcome::Succeeded;
        h.now(Some("codex")).await.unwrap();
        assert_eq!(h.tool("codex")["last"], json!({"kind": "failed", "failure": {"reason": "not-updated"}}));
        assert_eq!((h.tool("codex")["installed"].clone(), h.tool("codex")["phase"].clone()), (json!("0.50.1"), json!("idle")));
    })
    .await;
}

#[tokio::test]
async fn skips_a_system_bundled_or_admin_owned_copy_with_its_reason() {
    // "skips a system, bundled or admin-owned copy with its reason, and never checks or updates it"
    local(async {
        let h = harness(true);
        let app = "/Applications/ChatGPT.app/Contents/Resources/codex";
        h.fake.detections.borrow_mut().insert(
            "codex",
            Detection {
                path: app.into(),
                real: app.into(),
                owner: None,
                skip: Some("bundled".into()),
                ..codex("0.46.0")
            },
        );
        h.now(None).await.unwrap();
        let tool = h.tool("codex");
        assert_eq!(
            (
                &tool["skip"],
                &tool["method"],
                &tool["installed"],
                &tool["last"]
            ),
            (
                &json!("bundled"),
                &Value::Null,
                &json!("0.46.0"),
                &Value::Null
            )
        );
        assert_eq!((h.checks(), h.updates()), (0, 0));
        h.fake.detections.borrow_mut().insert(
            "codex",
            Detection {
                owner: None,
                skip: Some("not-writable".into()),
                ..codex("0.50.1")
            },
        );
        h.now(Some("codex")).await.unwrap();
        assert_eq!(h.tool("codex")["skip"], "not-writable");
        assert_eq!(h.updates(), 0);
    })
    .await;
}

#[tokio::test]
async fn lets_the_tools_own_updater_decide_when_it_has_no_registry_to_ask() {
    // "lets the tool's own updater decide when it has no registry to ask (Cursor Agent)"
    local(async {
        let h = harness(true);
        *h.host.providers.borrow_mut() = Some(vec!["cursor".into()]);
        *h.fake.detections.borrow_mut() = HashMap::from([(
            "cursor-agent",
            Detection {
                id: "cursor-agent",
                path: "/u/.local/bin/cursor-agent".into(),
                real: "/u/.local/share/cursor-agent/v1/cursor-agent".into(),
                owner: Some(json!({"method": "self"})),
                skip: None,
                installed: Some("2026.01.01".into()),
            },
        )]);
        // The test installer answers its check with nothing newer, so the tool's own `update` is the check.
        *h.fake.latest.borrow_mut() = Ok("2026.01.01".into());
        h.now(Some("cursor-agent")).await.unwrap();
        assert_eq!(h.updates(), 0);
        assert_eq!(h.tool("cursor-agent")["last"], json!({"kind": "current"}));
    })
    .await;
}

#[tokio::test]
async fn asks_the_real_owners_check_without_an_installer_and_updates_setups_copy_through_its_archive()
 {
    // "asks the real owner's check when no installer is set, and updates machine setup's copy through its archive"
    local(async {
        let dir = tempfile::tempdir().unwrap();
        let prefix = std::fs::canonicalize(dir.path()).unwrap();
        let npm = prefix.join("bin").join("npm");
        std::fs::create_dir_all(npm.parent().unwrap()).unwrap();
        std::fs::write(&npm, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&npm, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let (prefix, npm) = (prefix.to_string_lossy().into_owned(), npm.to_string_lossy().into_owned());
        let h = harness_with(true, "darwin", None, STEP_MAX_MS);
        let owner = json!({"method": "npm", "name": "@openai/codex", "prefix": prefix, "root": format!("{prefix}/lib/node_modules/@openai/codex")});
        h.fake.detections.borrow_mut().insert("codex", found("codex", "0.50.1", owner));
        h.now(Some("codex")).await.unwrap();
        assert_eq!(*h.fake.checks.borrow(), [[npm.as_str(), "view", "@openai/codex", "version"]]);
        let spawn = h.fake.updates.borrow()[0].spawn.clone().unwrap();
        assert_eq!((spawn.file, spawn.args), (npm.clone(), vec!["install".to_owned(), "-g".into(), "--prefix".into(), prefix.clone(), "@openai/codex@0.51.0".into()]));

        let managed = harness_with(true, "darwin", None, STEP_MAX_MS);
        *managed.host.providers.borrow_mut() = Some(vec![]);
        *managed.fake.detections.borrow_mut() =
            HashMap::from([("gh", found("gh", "2.90.0", json!({"method": "managed", "item": "gh"})))]);
        managed.now(Some("gh")).await.unwrap();
        assert_eq!(managed.checks(), 0);
        assert_eq!(
            *managed.fake.updates.borrow(),
            [ToolUpdateRequest { tool: "gh".into(), method: "managed".into(), spawn: None, managed: Some("gh".into()), env: Env::new() }]
        );
    })
    .await;
}

#[tokio::test]
async fn updates_the_managed_agent_desktop_to_its_newest_release_at_once() {
    // "updates the managed agent-desktop to its own newest release at once, never waiting for a running server"
    local(async {
        let h = harness_with(true, "darwin", None, STEP_MAX_MS);
        *h.host.providers.borrow_mut() = Some(vec![]);
        *h.fake.processes.borrow_mut() = "/tools/agent-desktop/agent-desktop mcp\n".into();
        let desktop = Detection {
            path: "/tools/agent-desktop/agent-desktop".into(),
            ..found(
                "agent-desktop",
                "1.2.0",
                json!({"method": "managed", "item": "agent-desktop"}),
            )
        };
        *h.fake.detections.borrow_mut() = HashMap::from([("agent-desktop", desktop)]);
        h.now(Some("agent-desktop")).await.unwrap();
        assert_eq!(*h.fake.managed.borrow(), ["agent-desktop"]);
        assert_eq!(h.checks(), 0);
        assert_eq!(
            *h.fake.updates.borrow(),
            [ToolUpdateRequest {
                tool: "agent-desktop".into(),
                method: "managed".into(),
                spawn: None,
                managed: Some("agent-desktop".into()),
                env: Env::new()
            }]
        );
    })
    .await;
}

#[tokio::test]
async fn checks_scheduled_passes_only_while_the_pref_is_on_and_update_now_ignores_it() {
    // "checks scheduled passes only while the pref is on, lists tools either way, and 'Update now' ignores the pref"
    local(async {
        let h = harness(true);
        h.set_pref(false);
        h.start().await;
        h.rescan().await.unwrap();
        assert_eq!(
            (h.state()["enabled"].clone(), h.state()["scheduled"].clone()),
            (json!(false), json!(true))
        );
        assert_eq!(h.ids().len(), 1);
        assert_eq!(h.checks(), 0);
        h.pref_changed();
        h.rescan().await.unwrap();
        assert_eq!(h.checks(), 0);
        *h.fake.latest.borrow_mut() = Ok("0.50.1".into());
        h.now(Some("codex")).await.unwrap();
        assert_eq!(h.checks(), 1);
        // Turning it on checks right away.
        h.set_pref(true);
        h.pref_changed();
        h.rescan().await.unwrap();
        assert_eq!(h.checks(), 2);
    })
    .await;
}

#[tokio::test]
async fn runs_on_the_4_h_cadence_from_launch() {
    // "runs on the 4 h cadence from launch"
    local(async {
        let h = harness(true);
        *h.fake.latest.borrow_mut() = Ok("0.50.1".into());
        h.start().await;
        until(|| h.checks() == 1).await;
        h.tick(CHECK_INTERVAL_MS).await;
        until(|| h.checks() == 2).await;
        until(|| h.timer(CHECK_INTERVAL_MS).is_some()).await;
        h.tools.close();
        settle().await;
        assert_eq!(
            h.timer(CHECK_INTERVAL_MS),
            None,
            "the quit clears main's timer"
        );
        assert_eq!(h.checks(), 2);
    })
    .await;
}

#[tokio::test]
async fn a_launch_that_does_not_schedule_lists_tools_but_checks_only_on_request() {
    // "a launch that does not schedule (a dev or test build) lists tools but checks only on request"
    local(async {
        let h = harness(false);
        h.start().await;
        until(|| h.ids() == ["codex"]).await;
        h.rescan().await.unwrap();
        assert_eq!(h.checks(), 0);
        assert_eq!(h.state()["scheduled"], false);
        h.now(None).await.unwrap();
        assert_eq!(h.checks(), 1);
    })
    .await;
}

#[tokio::test]
async fn keeps_the_4_h_timer_after_a_failure_and_the_failed_tool_waits_out_its_own_back_off() {
    // "keeps the 4 h timer after a failure; the failed tool waits out its own back-off (8 h)"
    local(async {
        let h = harness(true);
        *h.fake.latest.borrow_mut() = Err("offline".into());
        h.start().await;
        until(|| h.checks() == 1).await;
        let scans = h.states().len();
        h.tick(CHECK_INTERVAL_MS).await;
        // The tick ran (it listed the tools again) but skipped the tool still backing off.
        assert!(h.states().len() > scans);
        assert_eq!(h.checks(), 1);
        *h.fake.latest.borrow_mut() = Ok("0.50.1".into());
        h.tick(CHECK_INTERVAL_MS).await;
        assert_eq!(h.checks(), 2);
        h.tick(CHECK_INTERVAL_MS).await;
        assert_eq!(h.checks(), 3);
        h.tools.close();
    })
    .await;
}

#[tokio::test]
async fn a_cancelled_update_does_not_back_off() {
    // "a cancelled update does not back off"
    local(async {
        let h = harness(true);
        *h.fake.outcome.borrow_mut() = ToolUpdateOutcome::Cancelled;
        h.start().await;
        h.rescan().await.unwrap();
        assert_eq!(h.updates(), 1);
        h.tick(CHECK_INTERVAL_MS).await;
        h.rescan().await.unwrap();
        assert_eq!(h.updates(), 2);
        h.tools.close();
    })
    .await;
}

#[tokio::test]
async fn runs_one_pass_at_a_time_and_a_failed_one_does_not_stop_the_queue() {
    // "runs one pass at a time: a request during a pass waits for it, and a failed one does not stop the queue"
    local(async {
        let h = harness(true);
        *h.fake.latest.borrow_mut() = Ok("0.50.1".into());
        let gate = Rc::new(Notify::new());
        *h.fake.gate.borrow_mut() = Some(Rc::clone(&gate));
        let one = later(h.call("cli.now", json!({"id": "codex"})));
        let two = later(h.call("cli.now", json!({"id": "codex"})));
        gate.notify_one();
        let (one, two) = tokio::join!(one, two);
        assert_eq!((one, two), (Ok(Value::Null), Ok(Value::Null)));
        assert_eq!(
            *h.fake.order.borrow(),
            ["check 1", "end 1", "check 2", "end 2"]
        );

        let failing = harness(true);
        *failing.fake.latest.borrow_mut() = Ok("0.50.1".into());
        failing.host.env_fails.set(true);
        assert_eq!(
            failing.now(Some("codex")).await.unwrap_err().message,
            "no shell env"
        );
        failing.host.env_fails.set(false);
        failing.now(Some("codex")).await.unwrap();
        assert_eq!(failing.checks(), 1);
    })
    .await;
}

#[tokio::test]
async fn a_throw_from_a_dependency_does_not_end_the_schedule() {
    // "a throw from a dependency does not end the schedule"
    local(async {
        let h = harness(true);
        *h.fake.latest.borrow_mut() = Ok("0.50.1".into());
        h.host.env_fails.set(true);
        h.start().await;
        assert_eq!(h.checks(), 0);
        h.host.env_fails.set(false);
        h.tick(CHECK_INTERVAL_MS).await;
        assert_eq!(h.checks(), 1);
        h.tools.close();
    })
    .await;
}

#[tokio::test]
async fn never_runs_after_the_close_drops_work_queued_before_it_and_a_pref_change_before_start_does_nothing()
 {
    // "never runs after dispose, drops work queued before it, and a pref change before start does nothing"
    local(async {
        let h = harness(true);
        *h.fake.latest.borrow_mut() = Ok("0.50.1".into());
        let gate = Rc::new(Notify::new());
        *h.fake.gate.borrow_mut() = Some(Rc::clone(&gate));
        h.pref_changed();
        h.rescan().await.unwrap();
        assert_eq!(h.checks(), 0);
        let one = tokio::task::spawn_local(later(h.call("cli.now", json!({"id": "codex"}))));
        let two = tokio::task::spawn_local(later(h.call("cli.now", json!({"id": "codex"}))));
        until(|| h.checks() == 1).await;
        h.tools.close();
        let states = h.states().len();
        gate.notify_one();
        assert_eq!(one.await.unwrap().unwrap_err().code, "tools_closed");
        assert_eq!(two.await.unwrap().unwrap_err().code, "tools_closed");
        assert_eq!(h.checks(), 1);
        // A closed instance tells main nothing more.
        assert_eq!(h.states().len(), states);
        assert!(!h.tools.start());
        assert_eq!(h.now(None).await.unwrap_err().code, "tools_closed");
        assert_eq!(h.checks(), 1);
    })
    .await;
}

#[tokio::test]
async fn a_pass_that_never_ends_is_stopped_leaves_its_tool_idle_and_writes_nothing_after() {
    // "CliUpdater, a pass that never ends": "is stopped, leaves its tool idle, and when it resumes later writes nothing"
    local(async {
        let h = harness_with(false, "darwin", Some("/fake/installer"), 1_000);
        h.fake.hangs.set(true);
        let stale = tokio::task::spawn_local(later(h.call("cli.now", json!({"id": "codex"}))));
        until(|| h.tool("codex")["phase"] == "updating").await;
        let next = later(h.call("cli.rescan", json!({})));
        let bound = h.timer(1_000).unwrap();
        assert!(h.tools.clock.fire(bound, None));
        assert_eq!(stale.await.unwrap().unwrap_err().code, "step_stalled");
        next.await.unwrap();
        assert_eq!(h.tool("codex")["phase"], "idle");
        let stalls: Vec<Value> = h.host.items.borrow().iter().filter(|item| item["k"] == "stalled").cloned().collect();
        assert_eq!(stalls, [json!({"k": "stalled", "chain": "update scheduler", "label": "tool CLI update", "ms": 1_000})]);
        let (emitted, before) = (h.states().len(), h.state());
        // The stopped pass's installer can no longer answer: no re-detect, no result, no state.
        h.fake.detections.borrow_mut().insert("codex", codex("9.9.9"));
        settle().await;
        assert_eq!((h.states().len(), h.state()), (emitted, before));
    })
    .await;
}

#[tokio::test]
async fn takes_a_tool_id_or_nothing_for_update_now_and_refuses_anything_else() {
    // "registerCliUpdateIpc": "takes a tool id or nothing for 'Update now', and refuses anything else" and "serves the
    // snapshot (and looks for newly installed tools) without taking an argument"
    local(async {
        let h = harness(false);
        for bad in [
            json!("rm -rf /"),
            json!("/usr/bin/codex"),
            json!("codex --version"),
            json!(5),
            json!({"id": "codex"}),
        ] {
            let Outcome::Now(Err(fault)) = h.call("cli.now", json!({"id": bad})) else {
                panic!("{bad} is refused at once");
            };
            assert!(
                fault.message.starts_with("Unknown tool: "),
                "{}",
                fault.message
            );
        }
        assert_eq!(h.checks(), 0);
        assert!(matches!(
            h.call("cli.now", json!({"id": "codex"})),
            Outcome::Later(_)
        ));
        assert!(matches!(h.call("cli.now", json!({})), Outcome::Later(_)));
        assert!(matches!(h.call("cli.rescan", json!({})), Outcome::Later(_)));
    })
    .await;
}

// ---- detect.test.ts ------------------------------------------------------------------------------------------------

#[test]
fn maps_each_connected_provider_to_its_vendor_cli_and_always_lists_machine_setups_tools() {
    // relevantTools: "maps each connected provider to its vendor CLI and always lists machine setup's tools"
    let keys = |connected: &[&str]| -> Vec<&str> {
        let connected: Vec<String> = connected.iter().map(|c| (*c).to_owned()).collect();
        relevant_tools(&connected)
            .into_iter()
            .map(|(id, _)| id)
            .collect()
    };
    assert_eq!(keys(&[]), ["gh", "node", "agent-desktop"]);
    assert_eq!(
        keys(&["anthropic"]),
        ["claude", "gh", "node", "agent-desktop"]
    );
    let using = relevant_tools(&["openai-codex".into(), "openai".into(), "cursor".into()]);
    assert_eq!(
        using.iter().find(|(id, _)| *id == "codex").unwrap().1,
        ["openai-codex", "openai"]
    );
    assert!(keys(&["google-gemini-cli"]).contains(&"gemini"));
    assert!(keys(&["cursor"]).contains(&"cursor-agent"));
    assert_eq!(
        keys(&["github-copilot"]),
        ["copilot", "gh", "gh-copilot", "node", "agent-desktop"]
    );
    // A provider with no vendor CLI adds nothing.
    assert_eq!(keys(&["openrouter"]), ["gh", "node", "agent-desktop"]);
}

#[test]
fn reads_the_gh_copilot_extensions_version_and_says_absent_when_gh_lists_none() {
    // ghCopilotVersion: "reads the gh-copilot extension's version, and says absent when gh lists none"
    assert_eq!(
        gh_copilot_version("gh copilot\tgithub/gh-copilot\tv1.0.5\n"),
        Some(Some("1.0.5".into()))
    );
    assert_eq!(
        gh_copilot_version("gh dash\tdlvhdr/gh-dash\tv4.1.0\n"),
        None
    );
    // `\b` as JavaScript reads it: a `-` ends the word, a letter does not.
    assert_eq!(
        gh_copilot_version("x\tgithub/gh-copilot-next\tv1.0.0\n"),
        Some(Some("1.0.0".into()))
    );
    assert_eq!(gh_copilot_version("x\tgithub/gh-copilotx\tv1.0.0\n"), None);
    assert_eq!(gh_copilot_version(""), None);
}

fn deps(path_env: &Path, tools_dir: &Path, platform: &str, bundle: Option<&Path>) -> DetectDeps {
    DetectDeps {
        path_env: path_env.to_string_lossy().into_owned(),
        env: Env::new(),
        ctx: InstallContext {
            platform: platform.into(),
            tools_dir: tools_dir.to_string_lossy().into_owned(),
            brew: None,
        },
        agent_desktop_bundle: bundle.map(|bundle| bundle.to_string_lossy().into_owned()),
        // Not the developer's own Homebrew: its claude or gh would answer for a PATH that holds none.
        brew_dirs: Vec::new(),
    }
}

fn answers(
    output: &'static str,
) -> impl Fn(&str, &[String]) -> LocalFuture<Result<String, String>> {
    move |_: &str, _: &[String]| -> LocalFuture<Result<String, String>> {
        Box::pin(async move { Ok(output.to_owned()) })
    }
}

fn never(_: &str, _: &[String]) -> LocalFuture<Result<String, String>> {
    Box::pin(async { Err("the version comes from the package manifest".to_owned()) })
}

fn sandbox() -> (TempDir, PathBuf) {
    let root = tempfile::Builder::new()
        .prefix("omp-cli-detect-")
        .tempdir()
        .unwrap();
    let bin = std::fs::canonicalize(root.path()).unwrap().join("bin");
    std::fs::create_dir(&bin).unwrap();
    (root, bin)
}

#[tokio::test]
async fn finds_nothing_for_a_tool_that_is_not_installed() {
    // detectCliTool: "finds nothing for a tool that is not installed (a vendor CLI is never installed here)"
    let (root, bin) = sandbox();
    let platform = if cfg!(windows) { "win32" } else { "darwin" };
    let found = detect::detect_cli_tool(
        "claude",
        &deps(&bin, &root.path().join("tools"), platform, None),
        &never,
    )
    .await;
    assert_eq!(found, None);
}

#[cfg(windows)]
mod windows {
    use super::*;

    /// What npm's cmd-shim writes for `npm install -g @openai/codex` on Windows (a JS bin with a node shebang).
    const NPM_CMD_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n";

    /// A `.bunx` as bun encodes one (BinLinkingShim.zig): the target, `"`, a 0 char, shebang data, the flags.
    fn bunx(target: &str) -> Vec<u8> {
        let launcher = "node ";
        let mut bytes: Vec<u8> = format!("{target}\"\0{launcher}")
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        bytes.extend((target.len() as u32 * 2).to_le_bytes());
        bytes.extend((launcher.len() as u32 * 2).to_le_bytes());
        bytes.extend((0b111u16 | (5478 << 3)).to_le_bytes());
        bytes
    }

    fn manifest(pkg: &Path, version: &str) {
        std::fs::create_dir_all(pkg.join("bin")).unwrap();
        std::fs::write(pkg.join("bin").join("codex.js"), "").unwrap();
        std::fs::write(
            pkg.join("package.json"),
            json!({"name": "@openai/codex", "version": version}).to_string(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn follows_an_npm_globals_cmd_shim_to_its_package_and_never_takes_the_bare_posix_script()
    {
        // "follows an npm global's .cmd shim to its package, and never takes the bare POSIX script beside it"
        let (root, bin) = sandbox();
        let pkg = bin.join("node_modules").join("@openai").join("codex");
        manifest(&pkg, "0.50.1");
        std::fs::write(bin.join("codex"), "#!/bin/sh\n").unwrap();
        let deps = deps(&bin, &root.path().join("tools"), "win32", None);
        assert_eq!(detect::detect_cli_tool("codex", &deps, &never).await, None);
        std::fs::write(bin.join("codex.cmd"), NPM_CMD_SHIM).unwrap();
        let found = detect::detect_cli_tool("codex", &deps, &never)
            .await
            .unwrap();
        let s = |path: &Path| path.to_string_lossy().into_owned();
        assert_eq!(
            (found.path, found.real, found.installed, found.skip),
            (
                s(&bin.join("codex.cmd")),
                s(&pkg.join("bin").join("codex.js")),
                Some("0.50.1".into()),
                None
            )
        );
        assert_eq!(
            found.owner,
            Some(
                json!({"method": "npm", "name": "@openai/codex", "prefix": s(&bin), "root": s(&pkg)})
            )
        );
    }

    #[tokio::test]
    async fn follows_a_bun_globals_shim_exe_and_its_bunx_to_the_package() {
        // "follows a Bun global's shim .exe and its .bunx to the package, so Bun's install owns it"
        let (root, _) = sandbox();
        let home = std::fs::canonicalize(root.path()).unwrap().join(".bun");
        let bin = home.join("bin");
        let pkg = home
            .join("install")
            .join("global")
            .join("node_modules")
            .join("@openai")
            .join("codex");
        manifest(&pkg, "0.51.0");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("codex.exe"), "MZ").unwrap();
        std::fs::write(
            bin.join("codex.bunx"),
            bunx("install\\global\\node_modules\\@openai\\codex\\bin\\codex.js"),
        )
        .unwrap();
        let deps = deps(&bin, &root.path().join("tools"), "win32", None);
        let found = detect::detect_cli_tool("codex", &deps, &never)
            .await
            .unwrap();
        let s = |path: &Path| path.to_string_lossy().into_owned();
        assert_eq!(
            (found.path, found.real, found.installed, found.skip),
            (
                s(&bin.join("codex.exe")),
                s(&pkg.join("bin").join("codex.js")),
                Some("0.51.0".into()),
                None
            )
        );
        assert_eq!(
            found.owner,
            Some(
                json!({"method": "bun", "name": "@openai/codex", "bunRoot": s(&home), "root": s(&pkg)})
            )
        );
    }
}

#[cfg(unix)]
mod unix {
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::*;

    fn script(file: &Path) -> PathBuf {
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, "#!/bin/sh\necho fake\n").unwrap();
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
        file.to_owned()
    }

    fn s(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn follows_the_symlink_to_a_homebrew_keg_and_reads_its_version_from_the_tool() {
        // "follows the symlink to a Homebrew keg and reads its version from the tool"
        let (root, bin) = sandbox();
        let prefix = bin.parent().unwrap().join("homebrew");
        let real = script(&prefix.join("Cellar/gh/2.96.0/bin/gh"));
        symlink(&real, bin.join("gh")).unwrap();
        let brew = script(&prefix.join("bin/brew"));
        let mut deps = deps(&bin, &root.path().join("tools"), "darwin", None);
        deps.ctx.brew = Some(s(&brew));
        let probe = |_: &str, args: &[String]| -> LocalFuture<Result<String, String>> {
            assert_eq!(args, ["--version"]);
            Box::pin(async { Ok("gh version 2.96.0 (2026-01-01)\n".to_owned()) })
        };
        let found = detect::detect_cli_tool("gh", &deps, &probe).await.unwrap();
        assert_eq!(
            (found.path, found.real, found.installed, found.skip),
            (s(&bin.join("gh")), s(&real), Some("2.96.0".into()), None)
        );
        assert_eq!(
            found.owner,
            Some(json!({"method": "brew", "name": "gh", "brew": s(&brew)}))
        );
    }

    #[tokio::test]
    async fn reads_an_npm_global_packages_version_from_its_manifest_and_names_its_prefix() {
        // "reads an npm global package's version from its manifest and names its prefix"
        let (root, bin) = sandbox();
        let prefix = bin.parent().unwrap().join("node-prefix");
        let pkg = prefix.join("lib/node_modules/@openai/codex");
        let real = script(&pkg.join("bin/codex.js"));
        std::fs::write(
            pkg.join("package.json"),
            json!({"name": "@openai/codex", "version": "0.50.1"}).to_string(),
        )
        .unwrap();
        symlink(&real, bin.join("codex")).unwrap();
        let found = detect::detect_cli_tool(
            "codex",
            &deps(&bin, &root.path().join("tools"), "darwin", None),
            &never,
        )
        .await
        .unwrap();
        assert_eq!((found.installed, found.skip), (Some("0.50.1".into()), None));
        assert_eq!(
            found.owner,
            Some(
                json!({"method": "npm", "name": "@openai/codex", "prefix": s(&prefix), "root": s(&pkg)})
            )
        );
    }

    #[tokio::test]
    async fn skips_an_npm_prefix_only_an_administrator_can_write() {
        // "skips an npm prefix only an administrator can write, and never asks for admin rights"
        let (root, bin) = sandbox();
        let modules = bin.parent().unwrap().join("locked-prefix/lib/node_modules");
        let pkg = modules.join("@openai/codex");
        let real = script(&pkg.join("bin/codex.js"));
        std::fs::write(
            pkg.join("package.json"),
            json!({"version": "0.50.1"}).to_string(),
        )
        .unwrap();
        symlink(&real, bin.join("codex")).unwrap();
        let locked = modules.join("@openai");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        let found = detect::detect_cli_tool(
            "codex",
            &deps(&bin, &root.path().join("tools"), "darwin", None),
            &never,
        )
        .await;
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        let found = found.unwrap();
        assert_eq!(
            (found.owner, found.skip, found.installed),
            (None, Some("not-writable".into()), Some("0.50.1".into()))
        );
    }

    #[tokio::test]
    async fn skips_a_codex_shipped_inside_another_apps_bundle_but_still_reports_its_version() {
        // "skips a Codex shipped inside another app's bundle but still reports its version"
        let (root, bin) = sandbox();
        let real = script(
            &bin.parent()
                .unwrap()
                .join("Applications/ChatGPT.app/Contents/Resources/codex"),
        );
        symlink(&real, bin.join("codex")).unwrap();
        let probe = answers("codex-cli 0.46.0\n");
        let found = detect::detect_cli_tool(
            "codex",
            &deps(&bin, &root.path().join("tools"), "darwin", None),
            &probe,
        )
        .await
        .unwrap();
        assert_eq!(
            (found.owner, found.skip, found.installed),
            (None, Some("bundled".into()), Some("0.46.0".into()))
        );
    }

    #[tokio::test]
    async fn lists_node_only_as_the_copy_in_the_managed_tools_dir() {
        // "lists Node only as the copy in the managed tools dir"
        let (root, bin) = sandbox();
        let tools = bin.parent().unwrap().join("tools");
        symlink(
            script(&bin.parent().unwrap().join("elsewhere/node")),
            bin.join("node"),
        )
        .unwrap();
        assert_eq!(
            detect::detect_cli_tool("node", &deps(&bin, &tools, "darwin", None), &never).await,
            None
        );
        let managed = script(&tools.join("node/bin/node"));
        let probe = answers("v24.11.0\n");
        let found = detect::detect_cli_tool(
            "node",
            &deps(managed.parent().unwrap(), &tools, "darwin", None),
            &probe,
        )
        .await
        .unwrap();
        assert_eq!(
            (found.owner, found.installed, found.skip),
            (
                Some(json!({"method": "managed", "item": "node"})),
                Some("24.11.0".into()),
                None
            )
        );
        drop(root);
    }

    #[tokio::test]
    async fn lists_agent_desktop_as_the_managed_copy_even_when_the_users_own_sits_earlier_on_path()
    {
        // "lists agent-desktop as the managed copy even when the user's own sits earlier on PATH"
        let (root, bin) = sandbox();
        let tools = bin.parent().unwrap().join("tools");
        symlink(
            script(&bin.parent().unwrap().join("npm-bin/agent-desktop")),
            bin.join("agent-desktop"),
        )
        .unwrap();
        // Only the user's copy: nothing of OMPdesk's to list.
        assert_eq!(
            detect::detect_cli_tool("agent-desktop", &deps(&bin, &tools, "darwin", None), &never)
                .await,
            None
        );
        let managed = script(&tools.join("agent-desktop/agent-desktop"));
        let probe = answers("agent-desktop 1.2.0\n");
        let found =
            detect::detect_cli_tool("agent-desktop", &deps(&bin, &tools, "darwin", None), &probe)
                .await
                .unwrap();
        assert_eq!(
            (found.path, found.owner, found.installed, found.skip),
            (
                s(&managed),
                Some(json!({"method": "managed", "item": "agent-desktop"})),
                Some("1.2.0".into()),
                None
            )
        );
        drop(root);
    }

    #[tokio::test]
    async fn lists_the_apps_bundled_agent_desktop_until_a_managed_copy_is_newer() {
        // "lists the app's bundled agent-desktop for an update into the managed tools dir until a managed copy is newer"
        let (root, bin) = sandbox();
        let tools = bin.parent().unwrap().join("tools");
        let bundle = bin.parent().unwrap().join("bundle");
        let bundled = script(&bundle.join("agent-desktop"));
        std::fs::write(
            bundle.join("agent-desktop.build.json"),
            json!({"version": "1.2.0"}).to_string(),
        )
        .unwrap();
        let owner = Some(json!({"method": "managed", "item": "agent-desktop"}));
        let deps = deps(&bin, &tools, "darwin", Some(&bundle));
        // No managed copy yet, and its tools dir does not exist: the bundle's version is what the update starts from.
        let found = detect::detect_cli_tool("agent-desktop", &deps, &never)
            .await
            .unwrap();
        assert_eq!(
            (found.path, found.owner.clone(), found.installed, found.skip),
            (s(&bundled), owner.clone(), Some("1.2.0".into()), None)
        );
        let managed = script(&tools.join("agent-desktop/agent-desktop"));
        let older = detect::detect_cli_tool("agent-desktop", &deps, &answers("1.1.0"))
            .await
            .unwrap();
        assert_eq!(
            (older.path, older.owner, older.installed),
            (s(&bundled), owner.clone(), Some("1.2.0".into()))
        );
        let newer = detect::detect_cli_tool("agent-desktop", &deps, &answers("1.3.0"))
            .await
            .unwrap();
        assert_eq!(
            (newer.path, newer.owner, newer.installed),
            (s(&managed), owner, Some("1.3.0".into()))
        );
        drop(root);
    }

    #[tokio::test]
    async fn detects_the_gh_copilot_extension_through_gh_and_nothing_when_gh_lists_none() {
        // "detects the gh-copilot extension through gh, and nothing when gh lists none"
        let (root, bin) = sandbox();
        symlink(
            script(&bin.parent().unwrap().join("gh-real/gh")),
            bin.join("gh"),
        )
        .unwrap();
        let deps = deps(&bin, &root.path().join("tools"), "darwin", None);
        let probe = |_: &str, args: &[String]| -> LocalFuture<Result<String, String>> {
            assert_eq!(args, ["extension", "list"]);
            Box::pin(async { Ok("gh copilot\tgithub/gh-copilot\tv1.0.5\n".to_owned()) })
        };
        let present = detect::detect_cli_tool("gh-copilot", &deps, &probe)
            .await
            .unwrap();
        assert_eq!(
            (present.id, present.installed, present.owner, present.skip),
            (
                "gh-copilot",
                Some("1.0.5".into()),
                Some(json!({"method": "self"})),
                None
            )
        );
        assert_eq!(
            detect::detect_cli_tool("gh-copilot", &deps, &answers("")).await,
            None
        );
    }
}

// ---- plans.test.ts, the CLI's own commands ---------------------------------------------------------------------------

fn detection(id: &'static str, owner: Value) -> Detection {
    Detection {
        id,
        path: format!("/opt/bin/{}", if id == "gh-copilot" { "gh" } else { id }),
        real: format!("/opt/real/{id}"),
        owner: Some(owner),
        skip: None,
        installed: Some("1.0.0".into()),
    }
}

fn plan(platform: &str, path_env: &Path) -> PlanTools {
    PlanTools {
        platform: platform.into(),
        path_env: path_env.to_string_lossy().into_owned(),
    }
}

fn bin_with(names: &[&str]) -> TempDir {
    let dir = tempfile::tempdir().unwrap();
    for name in names {
        let file = dir.path().join(name);
        std::fs::write(&file, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    dir
}

#[test]
fn looks_claude_code_up_in_the_npm_registry_and_leaves_the_others_own_updaters_and_managed_copies()
{
    // checkCommand: "looks Claude Code up in the npm registry, and leaves the others' own updaters and managed copies to run"
    let bin = bin_with(&["npm"]);
    let mac = plan("darwin", bin.path());
    let selfish = json!({"method": "self"});
    let check = check_command(&detection("claude", selfish.clone()), &selfish, &mac).unwrap();
    assert_eq!(
        check.spawn.args,
        ["view", "@anthropic-ai/claude-code", "version"]
    );
    assert_eq!(
        check_command(&detection("cursor-agent", selfish.clone()), &selfish, &mac),
        None
    );
    assert_eq!(
        check_command(&detection("gh-copilot", selfish.clone()), &selfish, &mac),
        None
    );
    let managed = json!({"method": "managed", "item": "gh"});
    assert_eq!(
        check_command(&detection("gh", managed.clone()), &managed, &mac),
        None
    );
    // Bun answers for a self-updating tool when no npm is on PATH: in a package dir.
    let bun = bin_with(&["bun"]);
    let via_bun = check_command(
        &detection("claude", selfish.clone()),
        &selfish,
        &plan("darwin", bun.path()),
    )
    .unwrap();
    assert_eq!(
        via_bun.spawn.args,
        ["pm", "view", "@anthropic-ai/claude-code", "version"]
    );
    assert!(via_bun.package_dir);
    // Windows never runs the bare POSIX `npm`.
    let bare = bin_with(&["npm"]);
    assert_eq!(
        check_command(
            &detection("claude", selfish.clone()),
            &selfish,
            &plan("win32", bare.path())
        ),
        None
    );
}

#[test]
fn runs_the_tools_own_updater_from_the_executable_it_found_and_ghs_extension_upgrade_through_gh() {
    // updateCommand: "runs the tool's own updater from the executable it found, and gh's extension upgrade through gh"
    let selfish = json!({"method": "self"});
    let mac = plan("darwin", Path::new(""));
    let claude = update_command(
        &detection("claude", selfish.clone()),
        &selfish,
        Some("2.2.0"),
        &mac,
    )
    .unwrap();
    assert_eq!(
        (claude.spawn.file.as_str(), claude.spawn.args),
        ("/opt/bin/claude", vec!["update".to_owned()])
    );
    assert_eq!(
        update_command(
            &detection("cursor-agent", selfish.clone()),
            &selfish,
            None,
            &mac
        )
        .unwrap()
        .spawn
        .args,
        ["update"]
    );
    let gh = update_command(
        &detection("gh-copilot", selfish.clone()),
        &selfish,
        None,
        &mac,
    )
    .unwrap();
    assert_eq!(
        (gh.spawn.file.as_str(), gh.spawn.args),
        (
            "/opt/bin/gh",
            vec![
                "extension".to_owned(),
                "upgrade".into(),
                "gh-copilot".into()
            ]
        )
    );
}

#[test]
fn waits_for_npm_and_bun_globals_and_a_homebrew_node_cli_but_not_for_single_binaries() {
    // waitsForIdle: "waits for npm and Bun globals, and for a Homebrew Node CLI, but not for single binaries or a vendor's updater"
    let waits =
        |id: &'static str, owner: Value| waits_for_idle(&detection(id, owner.clone()), &owner);
    assert!(waits("codex", npm()));
    assert!(waits(
        "gemini",
        json!({"method": "bun", "name": "x", "bunRoot": "/b", "root": "/b/x"})
    ));
    assert!(waits(
        "gemini",
        json!({"method": "brew", "name": "gemini-cli", "brew": "brew"})
    ));
    assert!(waits(
        "codex",
        json!({"method": "brew-cask", "name": "codex", "brew": "brew"})
    ));
    // gh is one native binary: a running gh keeps its old inode.
    assert!(!waits(
        "gh",
        json!({"method": "brew", "name": "gh", "brew": "brew"})
    ));
    assert!(!waits("claude", json!({"method": "self"})));
    assert!(!waits("cursor-agent", json!({"method": "self"})));
    assert!(!waits("gh", json!({"method": "managed", "item": "gh"})));
    assert!(!waits(
        "gh",
        json!({"method": "winget", "id": "GitHub.cli"})
    ));
}

async fn running_in(detection: &Detection, owner: &Value, commands: &str) -> bool {
    System
        .running(detection, owner, Some(commands.to_owned()))
        .await
        .unwrap()
}

#[tokio::test]
async fn sees_a_running_tool_through_its_package_dir_a_keg_or_its_name() {
    // runningIn: "sees a process of the tool through its package dir", "sees a Homebrew keg's process and a process
    // named after the tool", "answers false when no process of the tool runs"
    let ps = [
        "/sbin/launchd",
        "/usr/bin/vim notes.txt",
        "node /Users/u/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js --model gpt-5",
        "/opt/homebrew/Cellar/gemini-cli/0.4.0/libexec/bin/node /opt/homebrew/Cellar/gemini-cli/0.4.0/libexec/lib/node_modules/@google/gemini-cli/dist/index.js",
        "",
    ]
    .join("\n");
    let prefix = "/Users/u/.nvm/versions/node/v22";
    let owner = json!({"method": "npm", "name": "@openai/codex", "prefix": prefix, "root": format!("{prefix}/lib/node_modules/@openai/codex")});
    let codex = Detection {
        path: format!("{prefix}/bin/codex"),
        ..detection("codex", owner.clone())
    };
    assert!(running_in(&codex, &owner, &ps).await);
    assert!(running_in(&codex, &owner, &format!("node {}-neighbour", codex.path)).await);
    let brew = json!({"method": "brew", "name": "gemini-cli", "brew": "brew"});
    assert!(running_in(&detection("gemini", brew.clone()), &brew, &ps).await);
    let selfish = json!({"method": "self"});
    let claude = detection("claude", selfish.clone());
    assert!(running_in(&claude, &selfish, "/Users/u/.local/bin/claude --resume\n").await);
    assert!(running_in(&claude, &selfish, "claude\n").await);
    let other = "/Users/u/other-prefix";
    let elsewhere = json!({"method": "npm", "name": "@openai/codex", "prefix": other, "root": format!("{other}/lib/node_modules/@openai/codex")});
    let away = Detection {
        path: format!("{other}/bin/codex"),
        real: format!("{other}/x"),
        ..detection("codex", elsewhere.clone())
    };
    assert!(!running_in(&away, &elsewhere, &ps).await);
    assert!(!running_in(&claude, &selfish, "/usr/bin/vim notes.txt\n/sbin/launchd\n").await);
    assert!(!running_in(&claude, &selfish, "").await);
}
