//! The extension updater's rules with a fake stock helper, a fake installer and fake processes (was
//! `src/main/ext-update/updater.test.ts`; each test names the cases it carries in a comment): what each kind of row
//! does, the order of a pass, the one apply at its end, pins no call can move, the running rule, back-off per row,
//! omp-busy, the pref, the schedule on main's timers, and a pass stopped by its bound or the quit.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio::task::LocalSet;

use super::super::queue::STEP_MAX_MS;
use super::super::runner::{SpawnSpec, Supervisor};
use super::super::setup::{ToolUpdateOutcome, ToolUpdateRequest};
use super::super::spawn;
use super::super::{CHECK_INTERVAL_MS, Main, Tools, call_tools, next_check_delay};
use super::Deps;
use super::owner::McpBinary;
use crate::hub::{LocalFuture, Outcome};
use crate::server::Fault;

type OnCall = Box<dyn Fn(&str)>;

type Answers = RefCell<HashMap<String, Result<Value, String>>>;

/// Main and every dependency of the part, as a test sets them.
struct Fake {
    items: RefCell<Vec<Value>>,
    /// Stock helper calls in order: `<method> <id or name>`.
    calls: RefCell<Vec<String>>,
    /// Every question and helper call in order (`env`, the helper methods).
    order: RefCell<Vec<String>>,
    inventory: RefCell<Value>,
    inventory_error: RefCell<Option<String>>,
    plugin_checks: Answers,
    upgrades: Answers,
    skill_checks: Answers,
    skill_updates: Answers,
    refresh_error: RefCell<Option<String>>,
    cwds: RefCell<Vec<Value>>,
    applied: RefCell<Vec<Value>>,
    path: RefCell<String>,
    env_error: RefCell<Option<String>>,
    env_calls: Cell<u32>,
    /// The env question of this call (1-based) waits for `gate`.
    env_gate: Cell<u32>,
    gate: Rc<Notify>,
    /// Runs on every helper call with its method.
    on_call: RefCell<Option<OnCall>>,
    /// The next helper call of this method never answers.
    hold: RefCell<Option<String>>,
    binaries: RefCell<HashMap<String, Option<McpBinary>>>,
    detect_error: RefCell<Option<String>>,
    /// Detections that answer before `detect_error` applies.
    detect_ok: Cell<u32>,
    checks: RefCell<Vec<Vec<String>>>,
    check_output: RefCell<Result<String, String>>,
    updates: RefCell<Vec<ToolUpdateRequest>>,
    outcome: RefCell<ToolUpdateOutcome>,
    /// The binary an update leaves behind.
    after_update: RefCell<Option<McpBinary>>,
    processes: RefCell<String>,
    process_calls: Cell<u32>,
}

impl Default for Fake {
    fn default() -> Fake {
        Fake {
            items: RefCell::default(),
            calls: RefCell::default(),
            order: RefCell::default(),
            inventory: RefCell::new(inventory()),
            inventory_error: RefCell::default(),
            plugin_checks: RefCell::default(),
            upgrades: RefCell::default(),
            skill_checks: RefCell::default(),
            skill_updates: RefCell::default(),
            refresh_error: RefCell::default(),
            cwds: RefCell::default(),
            applied: RefCell::default(),
            path: RefCell::new("/nowhere".to_owned()),
            env_error: RefCell::default(),
            env_calls: Cell::new(0),
            env_gate: Cell::new(0),
            gate: Rc::new(Notify::new()),
            on_call: RefCell::default(),
            hold: RefCell::default(),
            binaries: RefCell::default(),
            detect_error: RefCell::default(),
            detect_ok: Cell::new(u32::MAX),
            checks: RefCell::default(),
            check_output: RefCell::new(Ok("1.1.0\n".to_owned())),
            updates: RefCell::default(),
            outcome: RefCell::new(ToolUpdateOutcome::Succeeded),
            after_update: RefCell::default(),
            processes: RefCell::default(),
            process_calls: Cell::new(0),
        }
    }
}

fn pick(table: &Answers, id: &str) -> Result<Value, Fault> {
    match table.borrow().get(id) {
        Some(Ok(answer)) => Ok(answer.clone()),
        Some(Err(message)) => Err(Fault::new("helper", message.clone())),
        None => Err(Fault::new("helper", format!("no fake for {id}"))),
    }
}

impl Fake {
    fn stock(&self, method: &str, params: &Value) -> LocalFuture<Result<Value, Fault>> {
        let id = params["name"]
            .as_str()
            .or(params["id"].as_str())
            .unwrap_or("");
        let short = method.trim_start_matches("extensions.");
        self.calls
            .borrow_mut()
            .push(format!("{short} {id}").trim().to_owned());
        self.order.borrow_mut().push(short.to_owned());
        if let Some(on_call) = &*self.on_call.borrow() {
            on_call(method);
        }
        if self.hold.borrow().as_deref() == Some(method) {
            self.hold.borrow_mut().take();
            return Box::pin(std::future::pending());
        }
        let answer = match short {
            "inventory" => {
                self.cwds.borrow_mut().push(params.clone());
                match &*self.inventory_error.borrow() {
                    Some(error) => Err(Fault::new("helper", error.clone())),
                    None => Ok(self.inventory.borrow().clone()),
                }
            }
            "marketplace.refresh" => match &*self.refresh_error.borrow() {
                Some(error) => Err(Fault::new("helper", error.clone())),
                None => Ok(json!({"updatedAt": "now"})),
            },
            "plugin.check" => pick(&self.plugin_checks, id),
            "plugin.upgrade" => pick(&self.upgrades, id),
            "skill.check" => pick(&self.skill_checks, id),
            "skill.update" => pick(&self.skill_updates, id),
            _ => Err(Fault::new("helper", format!("unexpected {method}"))),
        };
        Box::pin(async move { answer })
    }

    fn env(&self) -> LocalFuture<Result<Value, Fault>> {
        let call = self.env_calls.get() + 1;
        self.env_calls.set(call);
        self.order.borrow_mut().push("env".to_owned());
        let answer = match &*self.env_error.borrow() {
            Some(error) => Err(Fault::new("env", error.clone())),
            None => Ok(json!({"PATH": *self.path.borrow()})),
        };
        let gate = (self.env_gate.get() == call).then(|| Rc::clone(&self.gate));
        Box::pin(async move {
            if let Some(gate) = gate {
                gate.notified().await;
            }
            answer
        })
    }

    fn of(&self, k: &str) -> Vec<Value> {
        self.items
            .borrow()
            .iter()
            .filter(|item| item["k"] == k)
            .cloned()
            .collect()
    }

    fn count(&self, call: &str) -> usize {
        self.calls.borrow().iter().filter(|c| *c == call).count()
    }

    fn calls_starting(&self, prefix: &str) -> usize {
        self.calls
            .borrow()
            .iter()
            .filter(|c| c.starts_with(prefix))
            .count()
    }
}

impl Main for Fake {
    fn push(&self, item: Value) {
        self.items.borrow_mut().push(item);
    }

    fn ask(&self, q: &str, payload: Value) -> LocalFuture<Result<Value, Fault>> {
        match q {
            "env" => self.env(),
            "workspaceDirs" => Box::pin(async { Ok(json!(["/w/proj"])) }),
            // The tool CLI listing of a launch that does not schedule it: not this part's ask.
            "stock" if payload["method"] == "accounts.providers" => {
                Box::pin(async { Ok(json!({"providers": []})) })
            }
            "stock" => self.stock(payload["method"].as_str().unwrap_or(""), &payload["params"]),
            "applyExtensionUpdate" => {
                self.applied.borrow_mut().push(payload["plan"].clone());
                Box::pin(async { Ok(Value::Null) })
            }
            _ => {
                let q = q.to_owned();
                Box::pin(async move { Err(Fault::new("no_answer", q)) })
            }
        }
    }
}

fn spawn_local(task: LocalFuture<()>) {
    tokio::task::spawn_local(task);
}

fn inventory() -> Value {
    json!({"marketplaces": [], "plugins": [], "registrySkills": [], "pluginSkills": 0, "localSkills": 0, "mcpServers": []})
}

fn marketplace(name: &str) -> Value {
    json!({"name": name, "source": "o/r", "updatedAt": ""})
}

fn plugin(over: Value) -> Value {
    merged(
        json!({"channel": "marketplace", "id": "tools@official", "scope": "user", "cwd": null, "installed": "1.0.0", "spec": null, "enabled": true}),
        over,
    )
}

fn skill(over: Value) -> Value {
    merged(
        json!({"id": "@s/skill", "scope": "user", "cwd": null, "range": "^1.0.0", "installed": "1.0.0"}),
        over,
    )
}

fn server(name: &str, command: &str, args: &[&str]) -> Value {
    json!({"name": name, "type": "stdio", "command": command, "args": args, "url": null, "enabled": true, "origin": "user"})
}

fn plugin_check(over: Value) -> Value {
    merged(
        json!({"installed": "1.0.0", "latest": "1.1.0", "pinned": false, "unversioned": false}),
        over,
    )
}

fn upgrade(over: Value) -> Value {
    merged(
        json!({"from": "1.0.0", "to": "1.1.0", "changed": true, "activation": "live"}),
        over,
    )
}

fn skill_check(over: Value) -> Value {
    merged(
        json!({"installed": "1.0.0", "latest": "1.2.0", "within": "1.2.0", "pinned": false}),
        over,
    )
}

fn merged(mut base: Value, over: Value) -> Value {
    if let (Some(base), Some(over)) = (base.as_object_mut(), over.as_object()) {
        for (key, value) in over {
            base.insert(key.clone(), value.clone());
        }
    }
    base
}

fn npm_owner() -> Value {
    json!({"method": "npm", "name": "@s/pkg", "prefix": "/p", "root": "/p/lib/node_modules/@s/pkg"})
}

fn binary(installed: Option<&str>, owner: Option<Value>) -> McpBinary {
    McpBinary {
        command: "pkg".to_owned(),
        path: "/p/bin/pkg".to_owned(),
        real: "/p/lib/node_modules/@s/pkg/bin/cli.js".to_owned(),
        owner,
        skip: None,
        installed: installed.map(str::to_owned),
        script: true,
    }
}

fn npm_binary(installed: &str) -> McpBinary {
    binary(Some(installed), Some(npm_owner()))
}

const NOW: u64 = 1_000_000;

struct Harness {
    tools: Rc<Tools>,
    fake: Rc<Fake>,
}

/// A fresh user-data folder: its prefs hold a proxy so no test waits on the system's proxy lookup.
fn user_data() -> String {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "ompdesk-tools-ext-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let dir = dir.to_string_lossy().into_owned();
    let prefs = format!("{dir}/prefs.json");
    crate::prefs::set(&prefs, "proxyUrl", json!("http://127.0.0.1:9")).unwrap();
    dir
}

fn harness_with(scheduled: bool, platform: &str, installer: Option<&str>) -> Harness {
    let fake = Rc::new(Fake::default());
    let opts = serde_json::from_value(json!({
        "platform": platform,
        "arch": "x64",
        "toolsDir": "/tools",
        "userData": user_data(),
        "appVersion": "0.0.0",
        "automatic": false,
        "scheduled": {"omp": false, "cli": false, "ext": scheduled},
        "testInstaller": installer,
        "manual": true,
        "now": NOW,
        "locale": "en-US",
    }))
    .unwrap();
    let tools = Tools::new(
        opts,
        fake.clone(),
        spawn_local,
        Supervisor::this_binary(),
        STEP_MAX_MS,
    );
    tools.ext.borrow_mut().deps = fake_deps(&fake);
    tools.setup.borrow_mut().seams = crate::tools::setup::Seams::offline();
    super::super::cli::offline(&tools);
    Harness { tools, fake }
}

fn harness(scheduled: bool) -> Harness {
    harness_with(scheduled, "darwin", Some("/fake/installer"))
}

fn fake_deps(fake: &Rc<Fake>) -> Deps {
    let (detect, check, update, running) = (fake.clone(), fake.clone(), fake.clone(), fake.clone());
    Deps {
        detect: Rc::new(move |command, _| {
            let ok = detect.detect_ok.get();
            detect.detect_ok.set(ok.saturating_sub(1));
            let answer = match &*detect.detect_error.borrow() {
                Some(error) if ok == 0 => Err(Fault::new("internal", error.clone())),
                _ => Ok(detect.binaries.borrow().get(&command).cloned().flatten()),
            };
            Box::pin(async move { answer })
        }),
        run_check: Rc::new(move |command, _| {
            let mut line = vec![command.spawn.file.clone()];
            line.extend(command.spawn.args.iter().cloned());
            check.checks.borrow_mut().push(line);
            let answer = check.check_output.borrow().clone();
            Box::pin(async move { answer })
        }),
        run_update: Rc::new(move |_, _, request| {
            update.updates.borrow_mut().push(request.clone());
            if let Some(after) = update.after_update.borrow().clone() {
                update.binaries.borrow_mut().insert(
                    request.tool.trim_start_matches("mcp-").to_owned(),
                    Some(after),
                );
            }
            let outcome = update.outcome.borrow().clone();
            Box::pin(async move { outcome })
        }),
        running: Rc::new(move |command, binary, _| {
            running.process_calls.set(running.process_calls.get() + 1);
            let params = serde_json::from_value(json!({
                "kind": "mcp", "command": command, "binary": binary, "commands": *running.processes.borrow(),
            }))
            .unwrap();
            Box::pin(async move { Ok(crate::ext::running::update_running(params).await) })
        }),
    }
}

impl Harness {
    fn call(&self, method: &str, params: Value) -> Outcome {
        let params = serde_json::value::to_raw_value(&params).unwrap();
        call_tools(&self.tools, method, &params)
    }

    async fn later(&self, method: &str, params: Value) -> Result<Value, Fault> {
        match self.call(method, params) {
            Outcome::Later(answer) => answer.await,
            Outcome::Now(answer) => answer,
        }
    }

    /// Update now, as Settings asks it: a key names a row of the listing (listed first when it is not yet).
    async fn now(&self, key: Option<&str>) -> Result<Value, Fault> {
        if let Some(key) = key
            && !self.keys().iter().any(|listed| listed == key)
        {
            self.rescan().await?;
        }
        self.later("ext.now", json!({"key": key})).await
    }

    async fn rescan(&self) -> Result<Value, Fault> {
        self.later("ext.rescan", json!({})).await
    }

    fn pref_changed(&self) {
        assert!(matches!(
            self.call("ext.prefChanged", json!({})),
            Outcome::Now(Ok(_))
        ));
    }

    fn start(&self) -> bool {
        match self.call("start", json!({})) {
            Outcome::Now(Ok(started)) => started == true,
            _ => panic!("start answers at once"),
        }
    }

    /// A scheduled launch: started, and its first pass ended (it armed main's 4 h timer). The pass reads PATH on the
    /// blocking pool, so it ends after the calls a test makes next.
    async fn launch(&self) {
        assert!(self.start());
        until(|| self.timers(CHECK_INTERVAL_MS).len() == 1).await;
    }

    fn set_pref(&self, on: bool) {
        let prefs = format!("{}/prefs.json", self.tools.opts.user_data);
        crate::prefs::set(&prefs, "toolsAutoUpdate", json!(on)).unwrap();
    }

    fn advance(&self, ms: u64) {
        let now = self.tools.clock.now_ms();
        self.tools.clock.fire(u64::MAX, Some(now + ms));
    }

    fn state(&self) -> Value {
        super::state(&self.tools)
    }

    fn row(&self, key: &str) -> Value {
        self.state()["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["key"] == key)
            .cloned()
            .unwrap_or_else(|| panic!("no row {key}"))
    }

    fn keys(&self) -> Vec<String> {
        self.state()["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["key"].as_str().unwrap().to_owned())
            .collect()
    }

    fn set_inventory(&self, key: &str, value: Value) {
        self.fake.inventory.borrow_mut()[key] = value;
    }

    fn answer(table: &Answers, id: &str, answer: Value) {
        table.borrow_mut().insert(id.to_owned(), Ok(answer));
    }

    fn with_server(&self, found: Option<McpBinary>) {
        self.set_inventory("mcpServers", json!([server("pkg", "pkg", &[])]));
        self.fake
            .binaries
            .borrow_mut()
            .insert("pkg".to_owned(), found);
    }

    fn omp_busy(&self, busy: bool) {
        self.tools.omp.borrow_mut().phase = if busy { "updating" } else { "idle" };
    }

    /// Main's armed timers of `ms`, oldest first.
    fn timers(&self, ms: u64) -> Vec<Value> {
        self.fake
            .of("timer")
            .into_iter()
            .filter(|timer| timer["ms"] == ms)
            .map(|timer| timer["timer"].clone())
            .collect()
    }

    fn fire(&self, timer: &Value, ms: u64) {
        let now = self.tools.clock.now_ms() + ms;
        assert!(self.tools.clock.fire(timer.as_u64().unwrap(), Some(now)));
    }
}

fn helper_key(table: &Answers, id: &str, error: &str) {
    table
        .borrow_mut()
        .insert(id.to_owned(), Err(error.to_owned()));
}

/// Lets the spawned tasks and the blocking pool run until `done` holds.
async fn until(done: impl Fn() -> bool) {
    for _ in 0..2_000 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("never came");
}

fn run(test: impl Future<Output = ()>) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(LocalSet::new().run_until(test));
}

// ---- listing ---------------------------------------------------------------------------------------------------

#[test]
fn a_launch_that_does_not_schedule_lists_everything_and_asks_for_nothing() {
    // "a launch that does not schedule lists everything and asks for nothing"
    run(async {
        let h = harness(false);
        h.set_inventory("marketplaces", json!([marketplace("official")]));
        h.set_inventory("plugins", json!([plugin(json!({}))]));
        h.set_inventory("registrySkills", json!([skill(json!({}))]));
        h.set_inventory("pluginSkills", json!(3));
        h.set_inventory("mcpServers", json!([server("web", "npx", &["-y", "pkg"])]));
        assert!(h.start());
        h.rescan().await.unwrap();
        // The launch's own listing is queued behind this one.
        until(|| h.fake.calls.borrow().len() == 2).await;
        assert_eq!(h.state()["enabled"], true);
        assert_eq!(h.state()["scheduled"], false);
        assert_eq!(
            h.keys(),
            [
                "marketplace:official",
                "plugin:tools@official:user",
                "skill:@s/skill:user",
                "skill:plugin",
                "mcp:web"
            ]
        );
        assert_eq!(*h.fake.calls.borrow(), ["inventory", "inventory"]);
        assert!(h.fake.checks.borrow().is_empty());
        assert!(h.fake.updates.borrow().is_empty());
        assert!(h.fake.applied.borrow().is_empty());
    });
}

#[test]
fn lists_with_the_open_workspaces_keeps_results_across_scans_and_keeps_rows_it_cannot_read() {
    // "passes the workspaces of the open tabs to the inventory, and keeps a row's result across scans"
    // "keeps the rows it has when the inventory cannot be read"
    run(async {
        let h = harness(true);
        h.set_inventory("marketplaces", json!([marketplace("m")]));
        h.now(None).await.unwrap();
        assert_eq!(h.fake.cwds.borrow()[0], json!({"cwds": ["/w/proj"]}));
        assert_eq!(h.row("marketplace:m")["last"], json!({"kind": "refreshed"}));
        h.rescan().await.unwrap();
        assert_eq!(h.row("marketplace:m")["last"], json!({"kind": "refreshed"}));
        *h.fake.inventory_error.borrow_mut() = Some("omp is not installed".to_owned());
        h.rescan().await.unwrap();
        h.now(None).await.unwrap();
        assert_eq!(h.keys(), ["marketplace:m"]);
        assert_eq!(h.row("marketplace:m")["last"], json!({"kind": "refreshed"}));
    });
}

// ---- a pass ----------------------------------------------------------------------------------------------------

#[test]
fn goes_marketplaces_plugins_skills_mcp_and_applies_once_at_the_end() {
    // "goes marketplaces → plugins → skills → MCP servers and applies once at the end"
    run(async {
        let h = harness(true);
        h.set_inventory("marketplaces", json!([marketplace("official")]));
        h.set_inventory(
            "plugins",
            json!([plugin(json!({})), plugin(json!({"channel": "npm", "id": "live-plug", "installed": "2.0.0", "spec": "^2.0.0"}))]),
        );
        h.set_inventory("registrySkills", json!([skill(json!({}))]));
        h.with_server(Some(npm_binary("1.0.0")));
        let f = &h.fake;
        Harness::answer(&f.plugin_checks, "tools@official", plugin_check(json!({})));
        Harness::answer(
            &f.plugin_checks,
            "live-plug",
            plugin_check(json!({"installed": "2.0.0", "latest": "2.1.0"})),
        );
        Harness::answer(
            &f.upgrades,
            "tools@official",
            upgrade(json!({"activation": "restart-required"})),
        );
        Harness::answer(
            &f.upgrades,
            "live-plug",
            upgrade(json!({"from": "2.0.0", "to": "2.1.0"})),
        );
        Harness::answer(&f.skill_checks, "@s/skill", skill_check(json!({})));
        Harness::answer(
            &f.skill_updates,
            "@s/skill",
            json!({"blocked": null, "from": "1.0.0", "to": "1.2.0", "changed": true}),
        );
        *f.after_update.borrow_mut() = Some(npm_binary("1.1.0"));
        h.now(None).await.unwrap();
        assert_eq!(
            *f.calls.borrow(),
            [
                "inventory",
                "marketplace.refresh official",
                "plugin.check live-plug",
                "plugin.upgrade live-plug",
                "plugin.check tools@official",
                "plugin.upgrade tools@official",
                "skill.check @s/skill",
                "skill.update @s/skill",
            ]
        );
        assert_eq!(
            h.row("marketplace:official")["last"],
            json!({"kind": "refreshed"})
        );
        let tools = h.row("plugin:tools@official:user");
        assert_eq!(tools["installed"], "1.1.0");
        assert_eq!(tools["latest"], "1.1.0");
        assert_eq!(
            tools["last"],
            json!({"kind": "updated", "from": "1.0.0", "to": "1.1.0"})
        );
        let skill = h.row("skill:@s/skill:user");
        assert_eq!(skill["installed"], "1.2.0");
        assert_eq!(skill["last"]["to"], "1.2.0");
        assert_eq!(
            h.row("mcp:pkg")["last"],
            json!({"kind": "updated", "from": "1.0.0", "to": "1.1.0"})
        );
        // One plan for the whole pass: a restart (one plugin binds at session creation), the reload, the reconnect.
        assert_eq!(
            *f.applied.borrow(),
            [json!({"reload": true, "restart": true, "reconnect": ["pkg"]})]
        );
    });
}

#[test]
fn a_refreshed_marketplace_or_a_plugin_that_changes_nothing_applies_nothing() {
    // "a refreshed marketplace alone changes nothing in a live tab"
    // "a plugin that is current, or only changes nothing, applies nothing"
    run(async {
        let h = harness(true);
        h.set_inventory("marketplaces", json!([marketplace("m")]));
        h.set_inventory(
            "plugins",
            json!([plugin(json!({})), plugin(json!({"id": "same@official"}))]),
        );
        let f = &h.fake;
        Harness::answer(
            &f.plugin_checks,
            "tools@official",
            plugin_check(json!({"latest": "1.0.0"})),
        );
        Harness::answer(
            &f.plugin_checks,
            "same@official",
            plugin_check(json!({"latest": "1.1.0"})),
        );
        Harness::answer(
            &f.upgrades,
            "same@official",
            upgrade(json!({"changed": false})),
        );
        h.now(None).await.unwrap();
        let market = h.row("marketplace:m");
        assert_eq!(market["last"], json!({"kind": "refreshed"}));
        assert_eq!(market["phase"], "idle");
        assert_eq!(market["method"], "catalog");
        assert_eq!(market["checkedAt"], NOW);
        assert_eq!(
            h.row("plugin:tools@official:user")["last"],
            json!({"kind": "current"})
        );
        assert_eq!(
            h.row("plugin:same@official:user")["last"],
            json!({"kind": "current"})
        );
        assert_eq!(f.count("plugin.upgrade tools@official"), 0);
        assert!(f.applied.borrow().is_empty());
    });
}

#[test]
fn never_upgrades_to_a_version_that_is_not_strictly_newer_and_a_git_plugin_lets_the_upgrade_decide()
{
    // "never upgrades an npm plugin to a version that is not strictly newer (a prerelease user stays)"
    // "a git plugin has no latest to read: the upgrade decides"
    run(async {
        let h = harness(true);
        h.set_inventory(
            "plugins",
            json!([plugin(json!({"channel": "npm", "id": "beta-plug", "installed": "2.0.0-beta.1", "spec": "^2.0.0-beta.1"}))]),
        );
        let f = &h.fake;
        Harness::answer(
            &f.plugin_checks,
            "beta-plug",
            plugin_check(json!({"installed": "2.0.0-beta.1", "latest": "1.9.0"})),
        );
        h.now(None).await.unwrap();
        assert_eq!(f.count("plugin.upgrade beta-plug"), 0);
        assert_eq!(
            h.row("plugin:beta-plug:user")["last"],
            json!({"kind": "current"})
        );
        // …but the release after the prerelease is newer.
        Harness::answer(
            &f.plugin_checks,
            "beta-plug",
            plugin_check(json!({"installed": "2.0.0-beta.1", "latest": "2.0.0"})),
        );
        Harness::answer(
            &f.upgrades,
            "beta-plug",
            upgrade(json!({"from": "2.0.0-beta.1", "to": "2.0.0"})),
        );
        h.now(None).await.unwrap();
        assert_eq!(h.row("plugin:beta-plug:user")["last"]["to"], "2.0.0");

        let h = harness(true);
        h.set_inventory(
            "plugins",
            json!([plugin(
                json!({"channel": "git", "id": "git-plug", "installed": null, "spec": "github:o/r"})
            )]),
        );
        let f = &h.fake;
        Harness::answer(
            &f.plugin_checks,
            "git-plug",
            plugin_check(json!({"installed": null, "latest": null})),
        );
        Harness::answer(
            &f.upgrades,
            "git-plug",
            upgrade(json!({"changed": false, "from": null, "to": null})),
        );
        h.now(None).await.unwrap();
        assert_eq!(f.count("plugin.upgrade git-plug"), 1);
        assert_eq!(
            h.row("plugin:git-plug:user")["last"],
            json!({"kind": "current"})
        );
        Harness::answer(
            &f.upgrades,
            "git-plug",
            upgrade(json!({"from": null, "to": "abc1234"})),
        );
        h.now(None).await.unwrap();
        let row = h.row("plugin:git-plug:user");
        assert_eq!(row["installed"], "abc1234");
        assert_eq!(
            row["last"],
            json!({"kind": "updated", "from": null, "to": "abc1234"})
        );
        assert_eq!(
            *f.applied.borrow(),
            [json!({"reload": true, "restart": false, "reconnect": []})]
        );
    });
}

#[test]
fn a_failed_check_or_upgrade_is_recorded_and_a_linked_plugin_is_never_asked_about() {
    // "a plugin's failed check or upgrade is a recorded failure, never a throw"
    // "a linked plugin is listed and never asked about"
    run(async {
        let h = harness(true);
        h.set_inventory(
            "plugins",
            json!([
                plugin(json!({"id": "a@official"})),
                plugin(json!({"id": "b@official"}))
            ]),
        );
        let f = &h.fake;
        helper_key(&f.plugin_checks, "a@official", "catalog unreachable");
        Harness::answer(&f.plugin_checks, "b@official", plugin_check(json!({})));
        helper_key(&f.upgrades, "b@official", "bun install failed");
        h.now(None).await.unwrap();
        assert_eq!(
            h.row("plugin:a@official:user")["last"],
            json!({"kind": "failed", "failure": {"reason": "check", "detail": "catalog unreachable"}})
        );
        assert_eq!(
            h.row("plugin:b@official:user")["last"],
            json!({"kind": "failed", "failure": {"reason": "install", "detail": "bun install failed"}})
        );
        assert_eq!(h.row("plugin:b@official:user")["phase"], "idle");
        assert!(f.applied.borrow().is_empty());

        let h = harness(true);
        h.set_inventory(
            "plugins",
            json!([plugin(json!({"channel": "linked", "id": "dev"}))]),
        );
        h.now(None).await.unwrap();
        let row = h.row("plugin:dev:user");
        assert_eq!(
            (&row["skip"], &row["method"], &row["last"]),
            (&json!("linked"), &Value::Null, &Value::Null)
        );
        assert_eq!(*h.fake.calls.borrow(), ["inventory"]);
    });
}

#[test]
fn a_pass_past_its_bound_is_dropped_leaves_its_row_idle_and_writes_nothing_more() {
    // "a pass that never ends: is stopped, leaves its row idle, and when it resumes later applies and writes
    // nothing". The stopped pass is dropped where it stood: its held upgrade can never answer into it.
    run(async {
        let h = harness(false);
        h.set_inventory("plugins", json!([plugin(json!({}))]));
        let f = &h.fake;
        Harness::answer(&f.plugin_checks, "tools@official", plugin_check(json!({})));
        Harness::answer(&f.upgrades, "tools@official", upgrade(json!({})));
        *f.hold.borrow_mut() = Some("extensions.plugin.upgrade".to_owned());
        let Outcome::Later(stale) = h.call("ext.now", json!({})) else {
            panic!("answers later")
        };
        let Outcome::Later(next) = h.call("ext.now", json!({})) else {
            panic!("answers later")
        };
        let stale = tokio::task::spawn_local(stale);
        until(|| {
            h.tools.ext.borrow().records.first().map(|r| r.row.phase)
                == Some(super::Phase::Updating)
        })
        .await;
        let bound = h.timers(STEP_MAX_MS);
        h.fire(bound.last().unwrap(), STEP_MAX_MS);
        assert_eq!(stale.await.unwrap().unwrap_err().code, "step_stalled");
        assert_eq!(
            h.fake.of("stalled"),
            [
                json!({"k": "stalled", "chain": "update scheduler", "label": "extension update", "ms": STEP_MAX_MS})
            ]
        );
        assert_eq!(h.row("plugin:tools@official:user")["phase"], "idle");
        next.await.unwrap();
        assert_eq!(h.row("plugin:tools@official:user")["phase"], "idle");
        assert_eq!(
            h.row("plugin:tools@official:user")["last"]["kind"],
            "updated"
        );
    });
}

// ---- pins ------------------------------------------------------------------------------------------------------

#[test]
fn a_pinned_plugin_is_checked_and_shown_and_never_upgraded_not_even_by_update_now() {
    // "a pinned plugin is checked and shown as available, and is never upgraded, not even by Update now"
    run(async {
        let h = harness(true);
        h.set_inventory(
            "plugins",
            json!([plugin(
                json!({"channel": "npm", "id": "pin-plug", "installed": "1.0.0", "spec": "1.0.0"})
            )]),
        );
        let f = &h.fake;
        Harness::answer(
            &f.plugin_checks,
            "pin-plug",
            plugin_check(json!({"latest": "1.5.0", "pinned": true})),
        );
        Harness::answer(&f.upgrades, "pin-plug", upgrade(json!({})));
        h.launch().await;
        h.rescan().await.unwrap();
        h.now(Some("plugin:pin-plug:user")).await.unwrap();
        h.now(None).await.unwrap();
        assert_eq!(f.calls_starting("plugin.upgrade"), 0);
        let row = h.row("plugin:pin-plug:user");
        assert_eq!(row["skip"], "pinned");
        assert_eq!(row["latest"], "1.5.0");
        assert_eq!(row["last"], json!({"kind": "available", "latest": "1.5.0"}));
        // The pin survives a rescan between checks.
        h.rescan().await.unwrap();
        assert_eq!(h.row("plugin:pin-plug:user")["skip"], "pinned");
        // A pinned plugin that is not behind is just current.
        Harness::answer(
            &f.plugin_checks,
            "pin-plug",
            plugin_check(json!({"latest": "1.0.0", "pinned": true})),
        );
        h.now(None).await.unwrap();
        assert_eq!(
            h.row("plugin:pin-plug:user")["last"],
            json!({"kind": "current"})
        );
        // Unpinned by the user: it follows again.
        Harness::answer(
            &f.plugin_checks,
            "pin-plug",
            plugin_check(json!({"latest": "1.5.0"})),
        );
        Harness::answer(&f.upgrades, "pin-plug", upgrade(json!({"to": "1.5.0"})));
        h.now(None).await.unwrap();
        let row = h.row("plugin:pin-plug:user");
        assert_eq!(row["skip"], Value::Null);
        assert_eq!(row["last"]["to"], "1.5.0");
    });
}

#[test]
fn an_unversioned_plugin_and_a_skill_pinned_by_an_exact_range_are_never_changed() {
    // "an unversioned marketplace plugin is not upgraded"
    // "a skill pinned by an exact range is checked, shown, and never updated"
    run(async {
        let h = harness(true);
        h.set_inventory("plugins", json!([plugin(json!({"installed": "0.0.0"}))]));
        h.set_inventory("registrySkills", json!([skill(json!({"range": "1.0.0"}))]));
        let f = &h.fake;
        Harness::answer(
            &f.plugin_checks,
            "tools@official",
            plugin_check(json!({"installed": "0.0.0", "latest": null, "unversioned": true})),
        );
        Harness::answer(
            &f.skill_checks,
            "@s/skill",
            skill_check(json!({"pinned": true})),
        );
        h.now(None).await.unwrap();
        assert_eq!(h.row("plugin:tools@official:user")["skip"], "unversioned");
        assert_eq!(f.calls_starting("plugin.upgrade"), 0);
        h.now(Some("skill:@s/skill:user")).await.unwrap();
        let skill = h.row("skill:@s/skill:user");
        assert_eq!(skill["skip"], "pinned");
        assert_eq!(
            skill["last"],
            json!({"kind": "available", "latest": "1.2.0"})
        );
        assert_eq!(f.calls_starting("skill.update"), 0);
    });
}

#[test]
fn a_pinned_runner_package_is_checked_and_never_changed_and_an_unpinned_one_follows_latest() {
    // "a pinned MCP runner package is checked against the registry and never changed"
    // "an unpinned runner package follows latest: no check at all"
    run(async {
        let h = harness(true);
        h.set_inventory(
            "mcpServers",
            json!([server("s", "npx", &["-y", "@scope/pkg@1.2.3"])]),
        );
        let f = &h.fake;
        *f.check_output.borrow_mut() = Ok("1.4.0\n".to_owned());
        h.now(Some("mcp:s")).await.unwrap();
        assert_eq!(
            *f.checks.borrow(),
            [["/fake/installer", "cli-mcp-s", "npm", "check"]]
        );
        let row = h.row("mcp:s");
        assert_eq!(row["skip"], "pinned");
        assert_eq!(row["method"], "npm");
        assert_eq!(row["installed"], "1.2.3");
        assert_eq!(row["detail"], "@scope/pkg@1.2.3");
        assert_eq!(row["latest"], "1.4.0");
        assert_eq!(row["last"], json!({"kind": "available", "latest": "1.4.0"}));
        assert!(f.updates.borrow().is_empty());
        assert!(f.applied.borrow().is_empty());
        *f.check_output.borrow_mut() = Ok("1.2.3\n".to_owned());
        h.now(Some("mcp:s")).await.unwrap();
        assert_eq!(h.row("mcp:s")["last"], json!({"kind": "current"}));
        // A tag or range has no installed version to be behind.
        h.set_inventory("mcpServers", json!([server("t", "npx", &["pkg@next"])]));
        *f.check_output.borrow_mut() = Ok("9.0.0\n".to_owned());
        h.rescan().await.unwrap();
        h.now(Some("mcp:t")).await.unwrap();
        assert_eq!(h.row("mcp:t")["latest"], "9.0.0");
        assert_eq!(h.row("mcp:t")["last"], json!({"kind": "current"}));
        assert!(f.updates.borrow().is_empty());

        let h = harness(true);
        h.set_inventory("mcpServers", json!([server("s", "npx", &["-y", "pkg"])]));
        h.now(None).await.unwrap();
        let row = h.row("mcp:s");
        assert_eq!(
            (&row["skip"], &row["method"], &row["last"]),
            (&json!("follows-latest"), &Value::Null, &Value::Null)
        );
        assert!(h.fake.checks.borrow().is_empty());
        assert!(h.fake.updates.borrow().is_empty());
    });
}

/// A folder holding executables named `names` (on Windows, the `.cmd`/`.exe` names the platform looks up).
fn bin_dir(names: &[&str]) -> std::path::PathBuf {
    let dir = std::path::PathBuf::from(user_data()).join("bin");
    std::fs::create_dir_all(&dir).unwrap();
    for name in names {
        let file = dir.join(name);
        std::fs::write(&file, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    dir
}

fn host() -> &'static str {
    if cfg!(windows) { "win32" } else { "darwin" }
}

#[test]
fn checks_a_pinned_runner_package_through_the_real_registry_command_when_no_installer_is_set() {
    // "checks a pinned runner package through the real registry command when no installer is set"
    run(async {
        let (npm, python) = if cfg!(windows) {
            ("npm.cmd", "python.exe")
        } else {
            ("npm", "python3")
        };
        let dir = bin_dir(&[npm, python]);
        let h = harness_with(true, host(), None);
        *h.fake.path.borrow_mut() = dir.to_string_lossy().into_owned();
        h.set_inventory(
            "mcpServers",
            json!([
                server("n", "npx", &["pkg@1.0.0"]),
                server("p", "uvx", &["mcp-thing==1.0.0"])
            ]),
        );
        let f = &h.fake;
        *f.check_output.borrow_mut() = Ok("1.0.1\n".to_owned());
        h.now(Some("mcp:n")).await.unwrap();
        *f.check_output.borrow_mut() =
            Ok("mcp-thing (1.0.2)\nAvailable versions: 1.0.2, 1.0.0\n".to_owned());
        h.now(Some("mcp:p")).await.unwrap();
        let npm = spawn::command(
            &dir.join(npm).to_string_lossy(),
            &["view".into(), "pkg".into(), "version".into()],
        );
        let pip = spawn::command(
            &dir.join(python).to_string_lossy(),
            &["-m", "pip", "index", "versions", "mcp-thing"].map(str::to_owned),
        );
        let line = |spawn: &SpawnSpec| [vec![spawn.file.clone()], spawn.args.clone()].concat();
        assert_eq!(*f.checks.borrow(), [line(&npm.spawn), line(&pip.spawn)]);
        assert_eq!(
            h.row("mcp:n")["last"],
            json!({"kind": "available", "latest": "1.0.1"})
        );
        assert_eq!(h.row("mcp:p")["method"], "uv");
        assert_eq!(
            h.row("mcp:p")["last"],
            json!({"kind": "available", "latest": "1.0.2"})
        );
        // No python and no npm: nothing to ask, the row stays pinned.
        *f.path.borrow_mut() = "/nowhere".to_owned();
        h.now(Some("mcp:n")).await.unwrap();
        assert_eq!(h.row("mcp:n")["skip"], "pinned");
        assert_eq!(h.row("mcp:n")["last"], json!({"kind": "current"}));
    });
}

// ---- skills ----------------------------------------------------------------------------------------------------

#[test]
fn a_skill_updates_within_its_range_and_reloads_never_outside_it_and_never_approves_scripts() {
    // "updates to what the range resolves to when that is newer, and reloads"
    // "a newer version outside the range is not installed"
    // "a new version that ships scripts needs the user: a failure, never an approval"
    run(async {
        let h = harness(true);
        h.set_inventory("registrySkills", json!([skill(json!({}))]));
        let f = &h.fake;
        Harness::answer(
            &f.skill_checks,
            "@s/skill",
            skill_check(json!({"latest": "2.0.0", "within": "1.2.0"})),
        );
        Harness::answer(
            &f.skill_updates,
            "@s/skill",
            json!({"blocked": null, "from": "1.0.0", "to": "1.2.0", "changed": true}),
        );
        h.now(None).await.unwrap();
        let row = h.row("skill:@s/skill:user");
        assert_eq!(
            (&row["latest"], &row["installed"]),
            (&json!("2.0.0"), &json!("1.2.0"))
        );
        assert_eq!(
            row["last"],
            json!({"kind": "updated", "from": "1.0.0", "to": "1.2.0"})
        );
        assert_eq!(
            *f.applied.borrow(),
            [json!({"reload": true, "restart": false, "reconnect": []})]
        );

        let h = harness(true);
        h.set_inventory("registrySkills", json!([skill(json!({}))]));
        let f = &h.fake;
        Harness::answer(
            &f.skill_checks,
            "@s/skill",
            skill_check(json!({"latest": "2.0.0", "within": "1.0.0"})),
        );
        h.now(None).await.unwrap();
        assert_eq!(f.count("skill.update @s/skill"), 0);
        assert_eq!(
            h.row("skill:@s/skill:user")["last"],
            json!({"kind": "current"})
        );

        let h = harness(true);
        h.set_inventory("registrySkills", json!([skill(json!({}))]));
        let f = &h.fake;
        Harness::answer(&f.skill_checks, "@s/skill", skill_check(json!({})));
        Harness::answer(
            &f.skill_updates,
            "@s/skill",
            json!({"blocked": "needs-approval", "version": "1.2.0"}),
        );
        h.now(None).await.unwrap();
        assert_eq!(
            h.row("skill:@s/skill:user")["last"],
            json!({"kind": "failed", "failure": {"reason": "needs-approval", "detail": "1.2.0"}})
        );
        assert!(f.applied.borrow().is_empty());
    });
}

#[test]
fn plugin_skills_and_local_skills_are_rows_with_a_count_and_a_reason_never_asked_about() {
    // "plugin skills and local skills are rows with a count and a reason, never asked about"
    run(async {
        let h = harness(true);
        h.set_inventory("pluginSkills", json!(3));
        h.set_inventory("localSkills", json!(5));
        h.now(None).await.unwrap();
        let plugin = h.row("skill:plugin");
        assert_eq!(
            (&plugin["count"], &plugin["skip"], &plugin["method"]),
            (&json!(3), &json!("follows-plugin"), &Value::Null)
        );
        let local = h.row("skill:local");
        assert_eq!(
            (&local["count"], &local["skip"], &local["method"]),
            (&json!(5), &json!("local"), &Value::Null)
        );
        assert_eq!(*h.fake.calls.borrow(), ["inventory"]);
    });
}

// ---- MCP binaries ----------------------------------------------------------------------------------------------

#[test]
fn checks_through_the_installer_updates_inline_reads_the_version_again_and_reconnects() {
    // "checks through the installer, updates under the setup supervisor, reads the version again, reconnects"
    run(async {
        let h = harness(true);
        h.with_server(Some(npm_binary("1.0.0")));
        *h.fake.after_update.borrow_mut() = Some(npm_binary("1.1.0"));
        h.now(Some("mcp:pkg")).await.unwrap();
        let f = &h.fake;
        assert_eq!(
            *f.checks.borrow(),
            [["/fake/installer", "cli-mcp-pkg", "npm", "check"]]
        );
        assert_eq!(
            *f.updates.borrow(),
            [ToolUpdateRequest {
                tool: "mcp-pkg".to_owned(),
                method: "npm".to_owned(),
                ..Default::default()
            }]
        );
        let row = h.row("mcp:pkg");
        assert_eq!(
            (
                &row["method"],
                &row["detail"],
                &row["installed"],
                &row["latest"]
            ),
            (
                &json!("npm"),
                &json!("@s/pkg"),
                &json!("1.1.0"),
                &json!("1.1.0")
            )
        );
        assert_eq!(
            row["last"],
            json!({"kind": "updated", "from": "1.0.0", "to": "1.1.0"})
        );
        assert_eq!(
            *f.applied.borrow(),
            [json!({"reload": false, "restart": false, "reconnect": ["pkg"]})]
        );
    });
}

#[test]
fn a_binary_the_install_rules_cannot_read_fails_the_listing_and_after_an_update_fails_the_check() {
    // "a core that cannot answer during a refresh fails the pass and leaves the rows as they were" (and an owned
    // server whose file could not be read is never listed as an unknown install)
    // "a core that cannot answer after an update records a failed check: what the update left is not known"
    // "a core that cannot answer on the running rule…": the rule runs in process and always answers; the one way it
    // gives no answer (a binary it cannot read) still fails the row's check, which `running_rule_without_an_answer`
    // pins.
    run(async {
        let h = harness(true);
        h.with_server(Some(npm_binary("1.0.0")));
        h.rescan().await.unwrap();
        let before = h.state();
        *h.fake.detect_error.borrow_mut() = Some("the file read panicked".to_owned());
        h.fake.detect_ok.set(0);
        let fault = h.now(None).await.unwrap_err();
        assert_eq!(fault.message, "the file read panicked");
        assert_eq!(h.state(), before);
        assert!(h.fake.checks.borrow().is_empty());

        let blind = harness(true);
        blind.with_server(Some(npm_binary("1.0.0")));
        *blind.fake.detect_error.borrow_mut() = Some("the file read panicked".to_owned());
        blind.fake.detect_ok.set(0);
        assert!(blind.rescan().await.is_err());
        assert_eq!(blind.state()["rows"], json!([]));

        let h = harness(true);
        h.with_server(Some(npm_binary("1.0.0")));
        h.rescan().await.unwrap();
        // The pass's listing reads the binary; what the update left cannot be read.
        *h.fake.detect_error.borrow_mut() = Some("the file read panicked".to_owned());
        h.fake.detect_ok.set(1);
        h.now(Some("mcp:pkg")).await.unwrap();
        assert_eq!(h.fake.updates.borrow().len(), 1);
        let row = h.row("mcp:pkg");
        assert_eq!(
            (&row["phase"], &row["installed"]),
            (&json!("idle"), &json!("1.0.0"))
        );
        assert_eq!(
            row["last"],
            json!({"kind": "failed", "failure": {"reason": "check", "detail": "the file read panicked"}})
        );
        assert!(h.fake.applied.borrow().is_empty());
    });
}

#[test]
fn running_rule_without_an_answer_fails_the_check_runs_no_update_and_the_pass_goes_on() {
    // "on the running rule fails that row's check, runs no update and lets the pass go on"
    run(async {
        let h = harness(true);
        h.with_server(Some(npm_binary("1.0.0")));
        h.set_inventory("plugins", json!([plugin(json!({}))]));
        Harness::answer(
            &h.fake.plugin_checks,
            "tools@official",
            plugin_check(json!({})),
        );
        Harness::answer(&h.fake.upgrades, "tools@official", upgrade(json!({})));
        h.tools.ext.borrow_mut().deps.running =
            Rc::new(|_, _, _| Box::pin(async { Err(Fault::new("invalid_params", "no answer")) }));
        h.now(None).await.unwrap();
        let row = h.row("mcp:pkg");
        assert_eq!(row["phase"], "idle");
        assert_eq!(
            row["last"],
            json!({"kind": "failed", "failure": {"reason": "check", "detail": "no answer"}})
        );
        assert!(h.fake.updates.borrow().is_empty());
        assert_eq!(
            *h.fake.applied.borrow(),
            [json!({"reload": true, "restart": false, "reconnect": []})]
        );
    });
}

#[test]
fn without_an_installer_it_asks_the_owner_and_runs_the_owners_own_update() {
    // "without an installer it asks the owner and runs the owner's own update"
    // "an owner with no tool to run the update with is a recorded failure"
    run(async {
        let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
        let dir = bin_dir(&[npm]);
        let h = harness_with(true, host(), None);
        *h.fake.path.borrow_mut() = dir.to_string_lossy().into_owned();
        h.with_server(Some(npm_binary("1.0.0")));
        *h.fake.after_update.borrow_mut() = Some(npm_binary("1.1.0"));
        h.now(Some("mcp:pkg")).await.unwrap();
        let npm = dir.join(npm).to_string_lossy().into_owned();
        let view = spawn::command(&npm, &["view", "@s/pkg", "version"].map(str::to_owned));
        assert_eq!(
            *h.fake.checks.borrow(),
            [[vec![view.spawn.file.clone()], view.spawn.args].concat()]
        );
        let install = spawn::command(
            &npm,
            &["install", "-g", "--prefix", "/p", "@s/pkg@1.1.0"].map(str::to_owned),
        );
        let update = h.fake.updates.borrow()[0].clone();
        assert_eq!(
            (update.tool.as_str(), update.method.as_str()),
            ("mcp-pkg", "npm")
        );
        assert_eq!(update.spawn, Some(install.spawn));

        let h = harness_with(true, "darwin", None);
        h.with_server(Some(npm_binary("1.0.0")));
        h.now(Some("mcp:pkg")).await.unwrap();
        // No npm on PATH: no check either, so the latest is unknown; the update has no command.
        assert_eq!(
            h.row("mcp:pkg")["last"],
            json!({"kind": "failed", "failure": {"reason": "install", "detail": "no npm to run the update with"}})
        );
        assert!(h.fake.updates.borrow().is_empty());
    });
}

#[test]
fn leaves_a_current_server_alone_and_records_an_update_that_changed_nothing_failed_or_was_cancelled()
 {
    // "leaves a current server alone, and compares versions as numbers"
    // "an update that leaves the old version, a failure and a cancel are recorded"
    run(async {
        let h = harness(true);
        h.with_server(Some(npm_binary("1.10.0")));
        *h.fake.check_output.borrow_mut() = Ok("1.9.0\n".to_owned());
        h.now(Some("mcp:pkg")).await.unwrap();
        assert!(h.fake.updates.borrow().is_empty());
        assert_eq!(h.row("mcp:pkg")["last"], json!({"kind": "current"}));

        let h = harness(true);
        h.with_server(Some(npm_binary("1.0.0")));
        h.now(Some("mcp:pkg")).await.unwrap();
        assert_eq!(
            h.row("mcp:pkg")["last"],
            json!({"kind": "failed", "failure": {"reason": "not-updated"}})
        );
        assert!(h.fake.applied.borrow().is_empty());
        *h.fake.outcome.borrow_mut() = ToolUpdateOutcome::Failed(Some("EACCES".to_owned()));
        h.now(Some("mcp:pkg")).await.unwrap();
        assert_eq!(
            h.row("mcp:pkg")["last"],
            json!({"kind": "failed", "failure": {"reason": "install", "detail": "EACCES"}})
        );
        *h.fake.outcome.borrow_mut() = ToolUpdateOutcome::Cancelled;
        h.now(Some("mcp:pkg")).await.unwrap();
        assert_eq!(
            h.row("mcp:pkg")["last"],
            json!({"kind": "failed", "failure": {"reason": "cancelled"}})
        );
        *h.fake.check_output.borrow_mut() = Err("registry down".to_owned());
        h.now(Some("mcp:pkg")).await.unwrap();
        assert_eq!(
            h.row("mcp:pkg")["last"],
            json!({"kind": "failed", "failure": {"reason": "check", "detail": "registry down"}})
        );
        // A skipped update (setup closed, or no platform for it) changes nothing and records nothing.
        *h.fake.check_output.borrow_mut() = Ok("1.1.0\n".to_owned());
        *h.fake.outcome.borrow_mut() = ToolUpdateOutcome::Skipped;
        h.now(Some("mcp:pkg")).await.unwrap();
        assert_eq!(h.row("mcp:pkg")["phase"], "idle");
        assert_eq!(
            h.row("mcp:pkg")["last"]["failure"]["detail"],
            "registry down"
        );
    });
}

#[test]
fn disabled_system_bundled_unwritable_and_unknown_binaries_are_listed_and_never_touched() {
    // "a disabled server is listed, not checked"
    // "system, bundled, not-writable and unknown binaries are listed with their reason and never touched"
    run(async {
        let h = harness(true);
        h.set_inventory(
            "mcpServers",
            json!([merged(server("pkg", "pkg", &[]), json!({"enabled": false}))]),
        );
        h.fake
            .binaries
            .borrow_mut()
            .insert("pkg".to_owned(), Some(npm_binary("1.0.0")));
        h.now(None).await.unwrap();
        assert_eq!(
            (
                h.row("mcp:pkg")["method"].clone(),
                h.row("mcp:pkg")["last"].clone()
            ),
            (json!("npm"), Value::Null)
        );
        assert!(h.fake.checks.borrow().is_empty());
        for skip in ["system", "bundled", "not-writable", "unknown-install"] {
            let h = harness(true);
            let mut found = binary(Some("1.0.0"), None);
            found.skip = Some(skip.to_owned());
            h.with_server(Some(found));
            h.now(None).await.unwrap();
            let row = h.row("mcp:pkg");
            assert_eq!(
                (&row["skip"], &row["method"], &row["last"]),
                (&json!(skip), &Value::Null, &Value::Null),
                "{skip}"
            );
            assert!(h.fake.checks.borrow().is_empty());
            assert!(h.fake.updates.borrow().is_empty());
        }
    });
}

const RUNNING: &str = "node /p/lib/node_modules/@s/pkg/bin/cli.js --stdio\n";

#[test]
fn a_script_waits_while_its_server_runs_then_updates_at_the_next_check() {
    // "the running rule: a script waits while its server runs, then updates at the next check; a deferral is no
    // failure"
    run(async {
        let h = harness(true);
        h.with_server(Some(npm_binary("1.0.0")));
        *h.fake.processes.borrow_mut() = RUNNING.to_owned();
        h.now(Some("mcp:pkg")).await.unwrap();
        assert!(h.fake.updates.borrow().is_empty());
        let row = h.row("mcp:pkg");
        assert_eq!(
            row["last"],
            json!({"kind": "deferred", "latest": "1.1.0", "why": "running"})
        );
        assert_eq!(row["installed"], "1.0.0");
        assert!(h.fake.applied.borrow().is_empty());
        // Scheduled passes are not held back by it.
        h.launch().await;
        h.rescan().await.unwrap();
        assert!(h.fake.updates.borrow().is_empty());
        assert!(h.fake.process_calls.get() > 1);
        *h.fake.processes.borrow_mut() = "/sbin/launchd\n".to_owned();
        *h.fake.after_update.borrow_mut() = Some(npm_binary("1.1.0"));
        h.pref_changed();
        h.rescan().await.unwrap();
        assert_eq!(h.row("mcp:pkg")["last"]["to"], "1.1.0");
    });
}

#[test]
fn a_native_binary_updates_at_once_and_a_pipx_uv_or_pip_script_waits_too() {
    // "a native binary keeps its old inode: it updates at once, running or not"
    // "a script owned by pipx, uv or pip waits too; a missing process updates"
    run(async {
        let brew = json!({"method": "brew", "name": "thing", "brew": "/opt/homebrew/bin/brew"});
        let h = harness(true);
        let mut native = binary(Some("1.0.0"), Some(brew.clone()));
        native.script = false;
        h.with_server(Some(native.clone()));
        *h.fake.processes.borrow_mut() = "/p/lib/node_modules/@s/pkg/bin/cli.js\n".to_owned();
        native.installed = Some("1.1.0".to_owned());
        *h.fake.after_update.borrow_mut() = Some(native);
        h.now(Some("mcp:pkg")).await.unwrap();
        assert_eq!(h.fake.process_calls.get(), 0);
        assert_eq!(h.fake.updates.borrow().len(), 1);
        assert_eq!(h.row("mcp:pkg")["last"]["kind"], "updated");

        for owner in [
            json!({"method": "pipx", "name": "t", "venv": "/h/pipx/venvs/t"}),
            json!({"method": "uv", "name": "t", "dir": "/h/uv/tools/t"}),
            json!({"method": "pip", "name": "t", "python": "/py/python3"}),
        ] {
            let h = harness(true);
            let mut found = binary(Some("1.0.0"), Some(owner.clone()));
            found.real = "/h/tools/t/bin/t".to_owned();
            found.path = "/h/bin/pkg".to_owned();
            h.with_server(Some(found));
            *h.fake.processes.borrow_mut() = "/usr/bin/python3 /h/tools/t/bin/t\n".to_owned();
            h.now(Some("mcp:pkg")).await.unwrap();
            assert!(h.fake.updates.borrow().is_empty(), "{owner}");
            assert_eq!(h.row("mcp:pkg")["last"]["why"], "running", "{owner}");
            h.fake.processes.borrow_mut().clear();
            h.now(Some("mcp:pkg")).await.unwrap();
            assert_eq!(h.fake.updates.borrow().len(), 1, "{owner}");
        }
    });
}

#[test]
fn on_windows_nothing_is_scanned_a_held_file_just_fails_the_update() {
    // "on Windows nothing is scanned: a held file just fails the update, recorded and retried"
    run(async {
        let h = harness_with(true, "win32", Some("/fake/installer"));
        h.with_server(Some(npm_binary("1.0.0")));
        *h.fake.processes.borrow_mut() = RUNNING.to_owned();
        *h.fake.outcome.borrow_mut() =
            ToolUpdateOutcome::Failed(Some("EBUSY: resource busy or locked".to_owned()));
        h.now(Some("mcp:pkg")).await.unwrap();
        assert_eq!(h.fake.process_calls.get(), 0);
        assert_eq!(
            h.row("mcp:pkg")["last"],
            json!({"kind": "failed", "failure": {"reason": "install", "detail": "EBUSY: resource busy or locked"}})
        );
    });
}

#[test]
fn uv_has_no_read_only_check_its_own_upgrade_is_the_check() {
    // "uv has no read-only check: the owner's own upgrade is the check, compared before and after"
    run(async {
        let uv_bin = if cfg!(windows) { "uv.exe" } else { "uv" };
        let dir = bin_dir(&[uv_bin]);
        let h = harness_with(true, host(), None);
        *h.fake.path.borrow_mut() = dir.to_string_lossy().into_owned();
        let uv = json!({"method": "uv", "name": "mcp-thing", "dir": "/h/uv/tools/mcp-thing"});
        let mut found = binary(Some("1.0.0"), Some(uv.clone()));
        found.script = false;
        h.with_server(Some(found.clone()));
        h.now(Some("mcp:pkg")).await.unwrap();
        assert!(h.fake.checks.borrow().is_empty());
        let spawn = h.fake.updates.borrow()[0].spawn.clone().unwrap();
        assert_eq!(spawn.file, dir.join(uv_bin).to_string_lossy());
        assert_eq!(spawn.args, ["tool", "upgrade", "mcp-thing"]);
        // Nothing moved and nothing was newer: it was current.
        assert_eq!(h.row("mcp:pkg")["latest"], Value::Null);
        assert_eq!(h.row("mcp:pkg")["last"], json!({"kind": "current"}));
        found.installed = Some("1.3.0".to_owned());
        *h.fake.after_update.borrow_mut() = Some(found);
        h.now(Some("mcp:pkg")).await.unwrap();
        assert_eq!(
            h.row("mcp:pkg")["last"],
            json!({"kind": "updated", "from": "1.0.0", "to": "1.3.0"})
        );
    });
}

// ---- schedule --------------------------------------------------------------------------------------------------

#[test]
fn runs_on_the_four_hour_cadence_from_launch_and_a_failed_row_waits_out_its_own_back_off() {
    // "runs on the 4 h cadence from launch"
    // "keeps the 4 h timer after a row fails; that row waits out its own back-off (8 h)"
    run(async {
        let h = harness(true);
        h.set_inventory("marketplaces", json!([marketplace("m")]));
        h.set_inventory("plugins", json!([plugin(json!({}))]));
        helper_key(
            &h.fake.plugin_checks,
            "tools@official",
            "catalog unreachable",
        );
        let f = &h.fake;
        let tally = || {
            (
                f.count("inventory"),
                f.count("marketplace.refresh m"),
                f.count("plugin.check tools@official"),
            )
        };
        assert!(h.start());
        until(|| h.timers(CHECK_INTERVAL_MS).len() == 1).await;
        assert_eq!(tally(), (1, 1, 1));
        h.fire(&h.timers(CHECK_INTERVAL_MS)[0], CHECK_INTERVAL_MS);
        until(|| h.timers(CHECK_INTERVAL_MS).len() == 2).await;
        // The failed row waits 8 h; the healthy one is checked every time.
        assert_eq!(tally(), (2, 2, 1));
        Harness::answer(
            &f.plugin_checks,
            "tools@official",
            plugin_check(json!({"latest": "1.0.0"})),
        );
        h.fire(&h.timers(CHECK_INTERVAL_MS)[1], CHECK_INTERVAL_MS);
        until(|| h.timers(CHECK_INTERVAL_MS).len() == 3).await;
        assert_eq!(tally(), (3, 3, 2));
        h.fire(&h.timers(CHECK_INTERVAL_MS)[2], CHECK_INTERVAL_MS);
        until(|| h.timers(CHECK_INTERVAL_MS).len() == 4).await;
        assert_eq!(tally(), (4, 4, 3));
        // The quit ends the schedule.
        let armed = h.timers(CHECK_INTERVAL_MS)[3].clone();
        assert!(matches!(h.call("close", json!({})), Outcome::Now(Ok(_))));
        until(|| {
            h.fake
                .of("clearTimer")
                .iter()
                .any(|clear| clear["timer"] == armed)
        })
        .await;
        assert_eq!(tally(), (4, 4, 3));
    });
}

#[test]
fn each_row_backs_off_by_itself_update_now_ignores_it_and_a_cancel_does_not_count() {
    // "each row backs off by itself after failures; Update now and other rows are not held"
    // "a cancelled update does not back off"
    run(async {
        let h = harness(true);
        h.set_inventory(
            "plugins",
            json!([
                plugin(json!({"id": "bad@official"})),
                plugin(json!({"id": "good@official"}))
            ]),
        );
        let f = &h.fake;
        helper_key(&f.plugin_checks, "bad@official", "catalog unreachable");
        Harness::answer(
            &f.plugin_checks,
            "good@official",
            plugin_check(json!({"latest": "1.0.0"})),
        );
        h.launch().await;
        h.rescan().await.unwrap();
        let counts = || {
            (
                f.count("plugin.check bad@official"),
                f.count("plugin.check good@official"),
            )
        };
        assert_eq!(counts(), (1, 1));
        // One failure: 4 h × 2 before the next scheduled try; the healthy row is checked every time.
        h.advance(CHECK_INTERVAL_MS);
        h.pref_changed();
        h.rescan().await.unwrap();
        assert_eq!(counts(), (1, 2));
        h.advance(next_check_delay(1));
        h.pref_changed();
        h.rescan().await.unwrap();
        assert_eq!(counts(), (2, 3));
        // Update now ignores the back-off.
        h.now(Some("plugin:bad@official:user")).await.unwrap();
        assert_eq!(counts().0, 3);
        // A good run clears it.
        Harness::answer(
            &f.plugin_checks,
            "bad@official",
            plugin_check(json!({"latest": "1.0.0"})),
        );
        h.now(Some("plugin:bad@official:user")).await.unwrap();
        h.advance(CHECK_INTERVAL_MS);
        h.pref_changed();
        h.rescan().await.unwrap();
        assert_eq!(counts().0, 5);

        let h = harness(true);
        h.with_server(Some(npm_binary("1.0.0")));
        *h.fake.outcome.borrow_mut() = ToolUpdateOutcome::Cancelled;
        h.launch().await;
        h.rescan().await.unwrap();
        h.fake.updates.borrow_mut().clear();
        h.pref_changed();
        h.rescan().await.unwrap();
        assert_eq!(h.fake.updates.borrow().len(), 1);
    });
}

#[test]
fn while_omp_installs_a_pass_asks_nothing_and_defers_without_a_back_off() {
    // "while omp is being installed a pass asks nothing, defers without a back-off, and the next pass goes ahead"
    // "omp becoming busy mid-pass defers the rows still to do"
    run(async {
        let h = harness(true);
        h.set_inventory("plugins", json!([plugin(json!({}))]));
        let f = &h.fake;
        Harness::answer(
            &f.plugin_checks,
            "tools@official",
            plugin_check(json!({"latest": "1.0.0"})),
        );
        h.launch().await;
        h.rescan().await.unwrap();
        f.calls.borrow_mut().clear();
        h.omp_busy(true);
        h.now(None).await.unwrap();
        assert!(f.calls.borrow().is_empty());
        assert_eq!(
            h.row("plugin:tools@official:user")["last"],
            json!({"kind": "deferred", "latest": "1.0.0", "why": "omp-busy"})
        );
        h.pref_changed();
        h.rescan().await.unwrap();
        h.rescan().await.unwrap();
        assert!(f.calls.borrow().is_empty());
        h.omp_busy(false);
        h.pref_changed();
        h.rescan().await.unwrap();
        assert_eq!(f.count("plugin.check tools@official"), 1);
        assert_eq!(
            h.row("plugin:tools@official:user")["last"],
            json!({"kind": "current"})
        );

        let h = harness(true);
        h.set_inventory("marketplaces", json!([marketplace("m")]));
        h.set_inventory("plugins", json!([plugin(json!({}))]));
        Harness::answer(
            &h.fake.plugin_checks,
            "tools@official",
            plugin_check(json!({})),
        );
        let busy = Rc::downgrade(&h.tools);
        *h.fake.on_call.borrow_mut() = Some(Box::new(move |method| {
            if method == "extensions.marketplace.refresh"
                && let Some(tools) = busy.upgrade()
            {
                tools.omp.borrow_mut().phase = "updating";
            }
        }));
        h.now(None).await.unwrap();
        assert_eq!(h.row("marketplace:m")["last"], json!({"kind": "refreshed"}));
        assert_eq!(
            h.row("plugin:tools@official:user")["last"],
            json!({"kind": "deferred", "latest": null, "why": "omp-busy"})
        );
        assert_eq!(h.fake.count("plugin.check tools@official"), 0);
    });
}

#[test]
fn the_pref_gates_scheduled_passes_not_update_now_and_turning_it_on_checks_at_once() {
    // "with the pref off a scheduled launch only lists; Update now ignores the pref; turning it on checks at once"
    // "a launch that does not schedule checks only on request, even with the pref on"
    run(async {
        let h = harness(true);
        h.set_pref(false);
        h.set_inventory("plugins", json!([plugin(json!({}))]));
        let f = &h.fake;
        Harness::answer(
            &f.plugin_checks,
            "tools@official",
            plugin_check(json!({"latest": "1.0.0"})),
        );
        h.launch().await;
        h.rescan().await.unwrap();
        assert_eq!(
            (h.state()["enabled"].clone(), h.state()["scheduled"].clone()),
            (json!(false), json!(true))
        );
        assert_eq!(h.keys().len(), 1);
        h.pref_changed();
        h.rescan().await.unwrap();
        assert_eq!(f.calls_starting("plugin.check"), 0);
        h.now(Some("plugin:tools@official:user")).await.unwrap();
        assert_eq!(f.calls_starting("plugin.check"), 1);
        h.set_pref(true);
        h.pref_changed();
        h.rescan().await.unwrap();
        assert_eq!(f.calls_starting("plugin.check"), 2);
        // The pref change was told to the windows.
        assert_eq!(f.of("state").last().unwrap()["state"]["enabled"], true);

        let h = harness(false);
        h.set_inventory("plugins", json!([plugin(json!({}))]));
        Harness::answer(
            &h.fake.plugin_checks,
            "tools@official",
            plugin_check(json!({"latest": "1.0.0"})),
        );
        h.start();
        h.pref_changed();
        h.rescan().await.unwrap();
        assert_eq!(h.fake.calls_starting("plugin.check"), 0);
        h.now(None).await.unwrap();
        assert_eq!(h.fake.calls_starting("plugin.check"), 1);
    });
}

#[test]
fn tells_the_ui_each_phase_ending_idle() {
    // "tells the UI each phase, ending idle"
    run(async {
        let h = harness(true);
        h.set_inventory("plugins", json!([plugin(json!({}))]));
        Harness::answer(
            &h.fake.plugin_checks,
            "tools@official",
            plugin_check(json!({})),
        );
        Harness::answer(&h.fake.upgrades, "tools@official", upgrade(json!({})));
        h.now(None).await.unwrap();
        let phases: Vec<Value> = h
            .fake
            .of("state")
            .iter()
            .filter(|item| item["part"] == "ext")
            .filter_map(|item| {
                item["state"]["rows"]
                    .as_array()
                    .and_then(|rows| {
                        rows.iter()
                            .find(|row| row["key"] == "plugin:tools@official:user")
                    })
                    .map(|row| row["phase"].clone())
            })
            .collect();
        assert!(phases.contains(&json!("checking")));
        assert!(phases.contains(&json!("updating")));
        assert_eq!(phases.last(), Some(&json!("idle")));
    });
}

#[test]
fn one_pass_at_a_time_and_a_failed_one_does_not_stop_the_queue_or_the_schedule() {
    // "runs one pass at a time: a request during a pass waits for it, and a failed one does not stop the queue"
    // "a rejected scheduled pass keeps the timer going"
    // "a throw from a dependency does not end the schedule, and dispose stops it"
    run(async {
        let h = harness(true);
        h.set_inventory("plugins", json!([plugin(json!({}))]));
        Harness::answer(
            &h.fake.plugin_checks,
            "tools@official",
            plugin_check(json!({"latest": "1.0.0"})),
        );
        h.fake.env_gate.set(1);
        let Outcome::Later(one) = h.call("ext.now", json!({})) else {
            panic!()
        };
        let Outcome::Later(two) = h.call("ext.now", json!({})) else {
            panic!()
        };
        let gate = Rc::clone(&h.fake.gate);
        let (one, two) = (tokio::task::spawn_local(one), tokio::task::spawn_local(two));
        until(|| h.fake.env_calls.get() == 1).await;
        gate.notify_one();
        one.await.unwrap().unwrap();
        two.await.unwrap().unwrap();
        assert_eq!(
            *h.fake.order.borrow(),
            [
                "inventory",
                "env",
                "plugin.check",
                "inventory",
                "env",
                "plugin.check"
            ]
        );

        // A pass whose listing fails answers its fault; the next one runs, on request and on the timer.
        let h = harness(true);
        h.with_server(Some(npm_binary("1.0.0")));
        *h.fake.detect_error.borrow_mut() = Some("the file read panicked".to_owned());
        h.fake.detect_ok.set(0);
        assert!(h.now(None).await.is_err());
        h.start();
        until(|| h.timers(CHECK_INTERVAL_MS).len() == 1).await;
        h.fake.detect_error.borrow_mut().take();
        h.fire(&h.timers(CHECK_INTERVAL_MS)[0], CHECK_INTERVAL_MS);
        until(|| h.timers(CHECK_INTERVAL_MS).len() == 2).await;
        assert_eq!(h.fake.updates.borrow().len(), 1);

        // An environment that cannot be read lists nothing new; the schedule goes on until the quit.
        let h = harness(true);
        *h.fake.env_error.borrow_mut() = Some("no shell env".to_owned());
        h.start();
        until(|| h.timers(CHECK_INTERVAL_MS).len() == 1).await;
        // The launch's tool CLI listing asks `env` too; the timer's pass asks it once more.
        let asked = h.fake.env_calls.get();
        h.fire(&h.timers(CHECK_INTERVAL_MS)[0], CHECK_INTERVAL_MS);
        until(|| h.timers(CHECK_INTERVAL_MS).len() == 2).await;
        assert_eq!(h.fake.env_calls.get(), asked + 1);
        assert!(matches!(h.call("close", json!({})), Outcome::Now(Ok(_))));
        assert_eq!(h.now(None).await.unwrap_err().code, "tools_closed");
        assert_eq!(h.fake.env_calls.get(), asked + 1);
    });
}

#[test]
fn the_quit_drops_the_running_pass_and_what_was_queued_and_a_pref_change_before_start_does_nothing()
{
    // "drops work queued before dispose, and a pref change before start does nothing"
    run(async {
        let h = harness(true);
        h.set_inventory("plugins", json!([plugin(json!({}))]));
        Harness::answer(
            &h.fake.plugin_checks,
            "tools@official",
            plugin_check(json!({"latest": "1.0.0"})),
        );
        h.pref_changed();
        h.rescan().await.unwrap();
        assert_eq!(h.fake.env_calls.get(), 1);
        assert_eq!(*h.fake.calls.borrow(), ["inventory"]);
        h.fake.env_gate.set(2);
        let Outcome::Later(one) = h.call("ext.now", json!({})) else {
            panic!()
        };
        let Outcome::Later(two) = h.call("ext.now", json!({})) else {
            panic!()
        };
        let (one, two) = (tokio::task::spawn_local(one), tokio::task::spawn_local(two));
        until(|| h.fake.env_calls.get() == 2).await;
        let told = h.fake.of("state").len();
        assert!(matches!(h.call("close", json!({})), Outcome::Now(Ok(_))));
        assert_eq!(one.await.unwrap().unwrap_err().code, "tools_closed");
        assert_eq!(two.await.unwrap().unwrap_err().code, "tools_closed");
        h.fake.gate.notify_one();
        tokio::task::yield_now().await;
        assert_eq!(h.fake.env_calls.get(), 2);
        assert_eq!(h.fake.count("plugin.check tools@official"), 0);
        assert_eq!(
            h.fake.of("state").len(),
            told,
            "a pass the quit dropped tells nothing"
        );
        assert!(!h.start());
    });
}

// ---- Update now's key ------------------------------------------------------------------------------------------

#[test]
fn update_now_takes_a_row_key_of_the_current_state_or_nothing_and_refuses_anything_else() {
    // registerExtensionUpdateIpc: "takes a row key of the current state or nothing for 'Update now', and refuses
    // anything else"; "serves the snapshot and looks for what was installed since" is `state` plus `ext.rescan`.
    run(async {
        let h = harness(true);
        h.set_inventory("plugins", json!([plugin(json!({"id": "a@m"}))]));
        Harness::answer(
            &h.fake.plugin_checks,
            "a@m",
            plugin_check(json!({"latest": "1.0.0"})),
        );
        h.rescan().await.unwrap();
        assert_eq!(h.keys(), ["plugin:a@m:user"]);
        for bad in [
            json!("rm -rf /"),
            json!("/usr/bin/tool"),
            json!("plugin:b@m:user"),
            json!("plugin:a@m:user --force"),
            json!(5),
            json!({"key": "plugin:a@m:user"}),
            json!(""),
        ] {
            let Outcome::Now(Err(fault)) = h.call("ext.now", json!({"key": bad})) else {
                panic!("{bad} is refused at once")
            };
            assert!(fault.message.starts_with("Unknown extension"), "{bad}");
        }
        let checks = || h.fake.count("plugin.check a@m");
        h.now(Some("plugin:a@m:user")).await.unwrap();
        h.later("ext.now", json!({})).await.unwrap();
        h.later("ext.now", json!({"key": null})).await.unwrap();
        assert_eq!(checks(), 3);
    });
}

// ---- owners and commands (mcp-plans.test.ts, mcp-owner.test.ts) -----------------------------------------------

#[test]
fn pipx_uv_and_pip_have_their_own_check_and_update_commands() {
    // mcp-plans.test.ts: "pipx checks through its venv's pip when it has one, and upgrades through pipx",
    // "uv has no read-only check and upgrades through uv tool", "pip asks and upgrades through the python its script
    // names"
    let platform = host();
    let venv = std::path::PathBuf::from(user_data()).join("venv");
    let scripts = venv.join(if cfg!(windows) { "Scripts" } else { "bin" });
    std::fs::create_dir_all(&scripts).unwrap();
    let python = scripts.join(spawn::executable_name("python", platform));
    std::fs::write(&python, "").unwrap();
    let names = [
        spawn::executable_name("pipx", platform),
        spawn::executable_name("uv", platform),
    ];
    let bin = bin_dir(&names.iter().map(String::as_str).collect::<Vec<_>>());
    let tools = spawn::PlanTools {
        platform: platform.to_owned(),
        path_env: bin.to_string_lossy().into_owned(),
    };
    let args = |command: &spawn::CliCommand| command.spawn.args.clone();
    let pipx = json!({"method": "pipx", "name": "t", "venv": venv.to_string_lossy()});
    let check = super::owner::owner_check(&pipx, &tools).unwrap();
    assert_eq!(check.spawn.file, python.to_string_lossy());
    assert_eq!(args(&check), ["-m", "pip", "index", "versions", "t"]);
    let gone = json!({"method": "pipx", "name": "t", "venv": "/nowhere/venv"});
    assert!(super::owner::owner_check(&gone, &tools).is_none());
    let update = super::owner::owner_update(&pipx, Some("2.0.0"), &tools).unwrap();
    assert_eq!(update.spawn.file, bin.join(&names[0]).to_string_lossy());
    assert_eq!(args(&update), ["upgrade", "t"]);

    let uv = json!({"method": "uv", "name": "t", "dir": "/h/uv/tools/t"});
    assert!(super::owner::owner_check(&uv, &tools).is_none());
    assert_eq!(
        args(&super::owner::owner_update(&uv, None, &tools).unwrap()),
        ["tool", "upgrade", "t"]
    );
    assert_eq!(
        super::owner::owner_latest(&uv, "", None).unwrap_err(),
        "uv has no read-only check"
    );

    let pip = json!({"method": "pip", "name": "t", "python": "/py/python3"});
    let check = super::owner::owner_check(&pip, &tools).unwrap();
    assert_eq!(
        (check.spawn.file.as_str(), args(&check)),
        (
            "/py/python3",
            ["-m", "pip", "index", "versions", "t"]
                .map(str::to_owned)
                .to_vec()
        )
    );
    let update = super::owner::owner_update(&pip, None, &tools).unwrap();
    assert_eq!(args(&update), ["-m", "pip", "install", "--upgrade", "t"]);

    // mcp-plans.test.ts "owner outputs: pip family here, the package managers through cli-tools' parser"
    let listed = "t (1.2.3)\nAvailable versions: 1.2.3, 1.2.2\n";
    assert_eq!(
        super::owner::owner_latest(&pip, listed, None).unwrap(),
        "1.2.3"
    );
    assert_eq!(
        super::owner::owner_latest(&pipx, listed, None).unwrap(),
        "1.2.3"
    );
    assert_eq!(
        super::owner::owner_latest(&npm_owner(), "2.0.0\n", None).unwrap(),
        "2.0.0"
    );
}

#[test]
fn runner_packages_ask_their_registry_through_the_first_tool_found() {
    // mcp-plans.test.ts: "npx-family packages ask npm view, bunx asks Bun first, each falling back to the other",
    // "uvx and pipx run packages ask pip through the first python", "a git URL or path has nothing to ask",
    // "pip index versions", "npm view keeps a prerelease tag"
    let platform = host();
    let (npm, bun, python) = (
        spawn::npm_bin(platform).to_owned(),
        spawn::executable_name("bun", platform),
        if cfg!(windows) {
            "python.exe".to_owned()
        } else {
            "python3".to_owned()
        },
    );
    let bin = bin_dir(&[npm.as_str(), bun.as_str(), python.as_str()]);
    let tools = spawn::PlanTools {
        platform: platform.to_owned(),
        path_env: bin.to_string_lossy().into_owned(),
    };
    let runner = |runner: &str, ecosystem: &str, checkable: bool| super::owner::RunnerPackage {
        runner: runner.to_owned(),
        ecosystem: ecosystem.to_owned(),
        pkg: "pkg".to_owned(),
        checkable,
    };
    let npx = super::owner::runner_check(&runner("npx", "npm", true), &tools).unwrap();
    assert!(npx.spawn.file.contains(&npm) || npx.spawn.args.iter().any(|a| a.contains("view")));
    assert!(!npx.package_dir);
    let bunx = super::owner::runner_check(&runner("bunx", "npm", true), &tools).unwrap();
    assert!(bunx.package_dir, "bun pm view runs in a folder of its own");
    let uvx = super::owner::runner_check(&runner("uvx", "pypi", true), &tools).unwrap();
    assert_eq!(uvx.spawn.file, bin.join(&python).to_string_lossy());
    assert!(super::owner::runner_check(&runner("npx", "npm", false), &tools).is_none());
    // Only Bun on PATH: npx falls back to it.
    let only_bun = bin_dir(&[bun.as_str()]);
    let tools = spawn::PlanTools {
        platform: platform.to_owned(),
        path_env: only_bun.to_string_lossy().into_owned(),
    };
    assert!(
        super::owner::runner_check(&runner("npx", "npm", true), &tools)
            .unwrap()
            .package_dir
    );

    let pypi = runner("uvx", "pypi", true);
    assert_eq!(
        super::owner::runner_latest(&pypi, "pkg (1.0.2)\nAvailable versions: 1.0.2\n").unwrap(),
        "1.0.2"
    );
    let npm_runner = runner("npx", "npm", true);
    assert_eq!(
        super::owner::runner_latest(&npm_runner, "2.0.0-beta.3\n").unwrap(),
        "2.0.0-beta.3"
    );
    assert!(super::owner::runner_latest(&npm_runner, "npm ERR! 404\n").is_err());
}
