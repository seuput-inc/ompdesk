//! The extension updater's part (was `src/main/ext-update/updater.ts`): keeps the marketplaces, plugins, skills and
//! MCP servers of this computer's omp current. A pass reads the inventory (the stock helper's `extensions` worker,
//! asked through main), has the core's rules classify it (`crate::ext`), then works through marketplaces → plugins
//! → skills → MCP servers one row at a time: the first so plugin checks see fresh catalogs; the plugin, skill and
//! marketplace work is stock's own, run in that worker; an MCP server's global binary is updated by the package
//! manager that owns it, run as setup's `run_tool_update` inline in the pass's step. A pinned version (a plugin or
//! skill pin, an MCP package `pkg@1.2.3`) is checked and shown, never changed, not even by "Update now". The user's
//! MCP config is never written. What changed is handed to the live tabs once per pass as one `ExtensionApplyPlan`
//! (`ask applyExtensionUpdate {plan}`).
//!
//! The schedule is the hub's: a scheduled launch ticks at start and 4 h after each pass (with the pref off a tick
//! only lists), each row backs off by its own failures; a launch that does not schedule lists once at start. While
//! omp's part is not idle a pass asks nothing and defers its rows without a back-off. A pass is one step of the one
//! queue: a pass stopped by its bound or the quit is dropped where it stood, so it neither starts the next call nor
//! writes what the next pass owns (TypeScript's `fencedCall`/`throwIfStepStalled`, among them the missing check
//! after `runUpdate` in `#binary`); a row it left checking or updating is idle again.
//!
//! Calls: `ext.now {key?}` (Update now: a row key of the current state, or every row, whatever the pref and back-off
//! say), `ext.rescan` (list again without checking), `ext.prefChanged` (`toolsAutoUpdate` changed: turning it on
//! checks at once).

mod owner;
#[cfg(test)]
mod tests;

use std::rc::{Rc, Weak};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::queue::{Answer, Ctx, StepKind};
use super::setup::{ToolUpdateOutcome, ToolUpdateRequest, run_tool_update};
use super::spawn::{
    self, CliCommand, Env, InstallContext, PlanTools, find_brew, is_newer, off_hub, off_hub_async,
    parse_omp_version, spawn_spec,
};
use super::{Backoff, Tools, queued};
use crate::control::js::string_of_value;
use crate::ext::plan;
use crate::hub::{LocalFuture, Outcome, params};
use crate::server::Fault;
use owner::{McpBinary, OwnerDeps, RunnerPackage};

/// Inventory, check and refresh: local files or one registry round trip.
const CHECK_TIMEOUT_MS: u64 = 120_000;
/// An upgrade or update runs `bun install`/`npm install` and may take minutes.
const UPGRADE_TIMEOUT_MS: u64 = 600_000;
/// `EXTENSION_KINDS`: the display order.
const KINDS: [&str; 4] = ["marketplace", "plugin", "skill", "mcp"];
const LABEL: &str = "extension update";

/// The stock helper's `EXTENSION_HELPER_METHODS`.
mod helper {
    pub const INVENTORY: &str = "extensions.inventory";
    pub const MARKETPLACE_REFRESH: &str = "extensions.marketplace.refresh";
    pub const PLUGIN_CHECK: &str = "extensions.plugin.check";
    pub const PLUGIN_UPGRADE: &str = "extensions.plugin.upgrade";
    pub const SKILL_CHECK: &str = "extensions.skill.check";
    pub const SKILL_UPDATE: &str = "extensions.skill.update";
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Checking,
    Updating,
}

/// `ExtensionFailure`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Failure {
    pub reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// `ExtensionResult`: the last check's outcome.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Last {
    Current,
    Refreshed,
    Updated {
        from: Option<String>,
        to: String,
    },
    Available {
        latest: String,
    },
    Deferred {
        latest: Option<String>,
        why: &'static str,
    },
    Failed {
        failure: Failure,
    },
}

/// The fields of a row classification decides (`SeedRow`).
#[derive(Clone, Debug, Deserialize)]
struct SeedRow {
    key: String,
    kind: String,
    name: String,
    detail: Option<String>,
    count: Option<Value>,
    installed: Option<String>,
    method: Option<String>,
    skip: Option<String>,
}

/// `ExtensionRow`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub key: String,
    pub kind: String,
    pub name: String,
    pub detail: Option<String>,
    pub count: Option<Value>,
    pub installed: Option<String>,
    pub latest: Option<String>,
    pub method: Option<String>,
    pub skip: Option<String>,
    pub phase: Phase,
    pub checked_at: Option<u64>,
    pub last: Option<Last>,
}

/// A target as the rules answer it: a binary's names its command; the updater joins the binary it resolved.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum SeedTarget {
    None,
    Marketplace { name: String },
    Plugin { selector: Value },
    Skill { selector: Value },
    Runner { runner: RunnerPackage },
    Binary { command: String },
}

#[derive(Deserialize)]
struct Seed {
    row: SeedRow,
    target: SeedTarget,
}

/// What a check or update of the row acts on (`SeedTarget`).
#[derive(Clone, Debug)]
enum Target {
    None,
    Marketplace(String),
    Plugin(Value),
    Skill(Value),
    /// A pinned runner package: checked against its registry, never changed.
    Runner(RunnerPackage),
    /// A direct command's binary, updated by its owner.
    Binary {
        command: String,
        binary: Box<McpBinary>,
        owner: Value,
    },
}

struct Record {
    row: Row,
    target: Target,
    /// What classification says (a skip the check cannot lift).
    seed_skip: Option<String>,
    /// What the last check found out: a plugin or skill the user pinned, or a catalog without versions.
    derived_skip: Option<&'static str>,
    backoff: Backoff,
}

type Detect = Rc<dyn Fn(String, Rc<OwnerDeps>) -> LocalFuture<Result<Option<McpBinary>, Fault>>>;
type RunCheck = Rc<dyn Fn(CliCommand, Env) -> LocalFuture<Result<String, String>>>;
type RunUpdate = Rc<dyn Fn(Rc<Tools>, Ctx, ToolUpdateRequest) -> LocalFuture<ToolUpdateOutcome>>;
/// Whether a process of the server runs: `(command, binary, ps text a test installer pins)`.
type Running = Rc<dyn Fn(String, McpBinary, Option<String>) -> LocalFuture<Result<bool, Fault>>>;

/// What the part runs outside itself (`ExtensionUpdaterDeps`' seams): tests replace them.
#[derive(Clone)]
pub struct Deps {
    pub detect: Detect,
    pub run_check: RunCheck,
    pub run_update: RunUpdate,
    pub running: Running,
}

impl Default for Deps {
    fn default() -> Deps {
        Deps {
            detect: Rc::new(|command, deps| {
                Box::pin(async move { owner::detect(command, &deps).await })
            }),
            run_check: Rc::new(|command, env| {
                Box::pin(async move { spawn::run_check(&command, &env).await })
            }),
            run_update: Rc::new(|tools, ctx, request| {
                Box::pin(async move { run_tool_update(&tools, &ctx, request).await })
            }),
            running: Rc::new(|command, binary, commands| {
                Box::pin(async move {
                    let params = serde_json::from_value(json!({
                        "kind": "mcp", "command": command, "binary": binary, "commands": commands,
                    }))
                    .map_err(|error| Fault::new("invalid_params", error.to_string()))?;
                    Ok(off_hub_async(move || crate::ext::running::update_running(params)).await)
                })
            }),
        }
    }
}

#[derive(Default)]
pub struct Part {
    /// In display order (kinds, then name); a refresh rebuilds it from the classification.
    records: Vec<Record>,
    pub deps: Deps,
}

/// `ExtensionUpdateState`.
pub fn state(tools: &Tools) -> Value {
    let part = tools.ext.borrow();
    let rows: Vec<&Row> = part.records.iter().map(|record| &record.row).collect();
    json!({
        "enabled": tools.auto_update(),
        "scheduled": tools.opts.scheduled.ext,
        "rows": rows,
    })
}

// ---- the rows -------------------------------------------------------------------------------------------------

/// The platform the install layouts and commands are read for (`CliPlatform`).
fn platform(tools: &Tools) -> &'static str {
    if tools.opts.platform == "win32" {
        "win32"
    } else {
        "darwin"
    }
}

/// omp is being installed or checked (its part is not idle): the stock helper may be stopped for it, so a pass asks
/// nothing. Read in the tick the pass decides.
fn omp_busy(tools: &Tools) -> bool {
    tools.omp.borrow().phase != "idle"
}

fn read<T>(tools: &Tools, key: &str, f: impl FnOnce(&Record) -> T) -> Option<T> {
    tools
        .ext
        .borrow()
        .records
        .iter()
        .find(|record| record.row.key == key)
        .map(f)
}

/// Changes the row `key` and tells main (`#set`).
fn set(tools: &Tools, key: &str, patch: impl FnOnce(&mut Record)) {
    let found = {
        let mut part = tools.ext.borrow_mut();
        let record = part.records.iter_mut().find(|record| record.row.key == key);
        record.map(patch).is_some()
    };
    if found {
        tools.changed("ext");
    }
}

fn set_phase(tools: &Tools, key: &str, phase: Phase) {
    set(tools, key, |record| record.row.phase = phase);
}

/// The row's skip: classification's, else what the last check found (`#setDerived`).
fn set_derived(tools: &Tools, key: &str, derived: Option<&'static str>) {
    set(tools, key, |record| {
        record.derived_skip = derived;
        record.row.skip = record
            .seed_skip
            .clone()
            .or_else(|| derived.map(str::to_owned));
    });
}

/// The check ended (`#finish`): a failure pushes the row's next scheduled check out; a cancel (the person's, or a
/// quit) is no failure.
fn finish(tools: &Tools, key: &str, last: Last) {
    let now = tools.clock.now_ms();
    let failed = matches!(&last, Last::Failed { failure } if failure.reason != "cancelled");
    set(tools, key, |record| {
        record.backoff.settle(failed, now);
        record.row.phase = Phase::Idle;
        record.row.last = Some(last);
    });
}

fn fail(tools: &Tools, key: &str, reason: &'static str, detail: Option<String>) {
    finish(
        tools,
        key,
        Last::Failed {
            failure: Failure { reason, detail },
        },
    );
}

fn defer_for_omp(tools: &Tools, key: &str) {
    set(tools, key, |record| {
        record.row.last = Some(Last::Deferred {
            latest: record.row.latest.clone(),
            why: "omp-busy",
        });
    });
}

/// A row skipped after its check (pinned, no versions): the newer version is shown, nothing changes (`#settle`).
fn settle(tools: &Tools, key: &str, latest: Option<String>) {
    let newer = read(tools, key, |record| {
        record.row.skip.as_deref() == Some("pinned")
            && latest
                .as_deref()
                .is_some_and(|latest| is_newer(latest, record.row.installed.as_deref()))
    })
    .unwrap_or(false);
    let last = match latest {
        Some(latest) if newer => Last::Available { latest },
        _ => Last::Current,
    };
    finish(tools, key, last);
}

/// A row a dropped pass left checking or updating is idle again (the `onStall` of `updater.ts`); a pass the quit
/// dropped tells main nothing more.
struct IdleOnDrop {
    tools: Weak<Tools>,
    armed: bool,
}

impl Drop for IdleOnDrop {
    fn drop(&mut self) {
        let Some(tools) = self.tools.upgrade().filter(|_| self.armed) else {
            return;
        };
        let changed = {
            let Ok(mut part) = tools.ext.try_borrow_mut() else {
                return;
            };
            let mut changed = false;
            for record in &mut part.records {
                if record.row.phase != Phase::Idle {
                    record.row.phase = Phase::Idle;
                    changed = true;
                }
            }
            changed
        };
        if changed && !tools.is_closed() {
            tools.changed("ext");
        }
    }
}

// ---- the pass -------------------------------------------------------------------------------------------------

/// What one pass runs its checks with: the spawn environment and the lookups along its PATH.
struct Environment {
    env: Env,
    plan: PlanTools,
    owner: Rc<OwnerDeps>,
}

/// A stock helper request in its `extensions` worker, asked through main.
async fn helper(
    tools: &Tools,
    method: &str,
    params: Value,
    timeout_ms: u64,
) -> Result<Value, Fault> {
    tools
        .ask(
            "stock",
            json!({"method": method, "params": params, "timeoutMs": timeout_ms}),
        )
        .await
}

async fn environment(tools: &Tools) -> Result<Environment, Fault> {
    let env = tools.spawn_env().await?;
    let path_env = env
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| value.clone())
        .unwrap_or_default();
    let platform = platform(tools);
    let brew = {
        let (path_env, platform) = (path_env.clone(), platform.to_owned());
        off_hub(move || find_brew(&path_env, &platform)).await
    };
    let ctx = InstallContext {
        platform: platform.to_owned(),
        tools_dir: tools.opts.tools_dir.clone(),
        brew,
    };
    Ok(Environment {
        plan: PlanTools {
            platform: platform.to_owned(),
            path_env: path_env.clone(),
        },
        owner: Rc::new(OwnerDeps {
            path_env,
            ctx,
            env: env.clone(),
        }),
        env,
    })
}

fn invalid(error: serde_json::Error) -> Fault {
    Fault::new("invalid_params", error.to_string())
}

/// Reads the inventory again and rebuilds the rows, keeping each row's state across scans (`#refresh`). None when
/// the inventory cannot be read (omp missing, the helper stopped): the rows stay as they were. A fault when the
/// install rules gave no answer for a server's binary: the pass fails and the rows stay.
async fn refresh(tools: &Rc<Tools>) -> Result<Option<Environment>, Fault> {
    if omp_busy(tools) {
        return Ok(None);
    }
    // The inventory first: when it cannot be read, nothing else is asked.
    let read = async {
        let cwds = tools.ask("workspaceDirs", json!({})).await?;
        let inventory = helper(
            tools,
            helper::INVENTORY,
            json!({"cwds": cwds}),
            CHECK_TIMEOUT_MS,
        )
        .await?;
        let environment = environment(tools).await?;
        Ok::<_, Fault>((environment, inventory))
    };
    let Ok((environment, inventory)) = read.await else {
        return Ok(None);
    };
    let servers: Vec<Value> = inventory["mcpServers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut binaries: Vec<(String, Option<McpBinary>)> = Vec::new();
    let detect = Rc::clone(&tools.ext.borrow().deps.detect);
    for server in &servers {
        let class =
            crate::ext::mcp::classify(&serde_json::from_value(server.clone()).map_err(invalid)?);
        if let crate::ext::mcp::McpClass::Direct { command } = class {
            let name = server["name"].as_str().unwrap_or_default().to_owned();
            binaries.push((name, detect(command, Rc::clone(&environment.owner)).await?));
        }
    }
    let seeds = crate::ext::seeds::seeds(
        serde_json::from_value(json!({
            "inventory": inventory,
            "kinds": KINDS,
            "locale": tools.opts.locale,
            "binaries": binaries,
        }))
        .map_err(invalid)?,
    );
    let seeds: Vec<Seed> =
        serde_json::from_value(serde_json::to_value(seeds).map_err(invalid)?).map_err(invalid)?;
    {
        let mut part = tools.ext.borrow_mut();
        let mut existing = std::mem::take(&mut part.records);
        part.records = seeds
            .into_iter()
            .map(|seed| {
                let target = join(seed.target, &seed.row, &binaries);
                let at = existing
                    .iter()
                    .position(|record| record.row.key == seed.row.key);
                merge(at.map(|at| existing.swap_remove(at)), seed.row, target)
            })
            .collect();
    }
    tools.changed("ext");
    Ok(Some(environment))
}

/// The binary a direct command resolved to joins its target; one without an owner has nothing to update.
fn join(target: SeedTarget, row: &SeedRow, binaries: &[(String, Option<McpBinary>)]) -> Target {
    match target {
        SeedTarget::None => Target::None,
        SeedTarget::Marketplace { name } => Target::Marketplace(name),
        SeedTarget::Plugin { selector } => Target::Plugin(selector),
        SeedTarget::Skill { selector } => Target::Skill(selector),
        SeedTarget::Runner { runner } => Target::Runner(runner),
        SeedTarget::Binary { command } => binaries
            .iter()
            .find(|(name, _)| *name == row.name)
            .and_then(|(_, binary)| binary.clone())
            .and_then(|binary| {
                let owner = binary.owner.clone()?;
                Some(Target::Binary {
                    command,
                    binary: Box::new(binary),
                    owner,
                })
            })
            .unwrap_or(Target::None),
    }
}

/// A row as classified now, with what the last scans found (`#merge`).
fn merge(existing: Option<Record>, seed: SeedRow, target: Target) -> Record {
    let Some(existing) = existing else {
        return Record {
            row: Row {
                key: seed.key,
                kind: seed.kind,
                name: seed.name,
                detail: seed.detail,
                count: seed.count,
                installed: seed.installed,
                latest: None,
                method: seed.method,
                skip: seed.skip.clone(),
                phase: Phase::Idle,
                checked_at: None,
                last: None,
            },
            target,
            seed_skip: seed.skip,
            derived_skip: None,
            backoff: Backoff::default(),
        };
    };
    // A plugin the check found pinned stays pinned until the next check says otherwise.
    let skip = seed
        .skip
        .clone()
        .or_else(|| existing.derived_skip.map(str::to_owned));
    Record {
        row: Row {
            key: seed.key,
            kind: seed.kind,
            name: seed.name,
            detail: seed.detail,
            count: seed.count,
            installed: seed.installed,
            method: seed.method,
            skip,
            ..existing.row
        },
        target,
        seed_skip: seed.skip,
        ..existing
    }
}

/// One pass (`#pass`): `only` a row's key or every row; `scheduled` honours each row's back-off.
async fn pass(tools: Rc<Tools>, ctx: Ctx, only: Option<String>, scheduled: bool) -> Answer {
    let mut guard = IdleOnDrop {
        tools: Rc::downgrade(&tools),
        armed: true,
    };
    let answer = run_pass(&tools, &ctx, only.as_deref(), scheduled).await;
    guard.armed = false;
    answer
}

async fn run_pass(tools: &Rc<Tools>, ctx: &Ctx, only: Option<&str>, scheduled: bool) -> Answer {
    let wanted = |record: &Record, now: u64| {
        only.is_none_or(|only| record.row.key == only)
            && !matches!(record.target, Target::None)
            && !(scheduled && now < record.backoff.next_at)
    };
    // While omp is being installed the stock helper is stopped: a request would start it again, so ask nothing.
    if omp_busy(tools) {
        let now = tools.clock.now_ms();
        let keys = keys(tools, |record| wanted(record, now));
        for key in keys {
            defer_for_omp(tools, &key);
        }
        return Ok(Value::Null);
    }
    let Some(environment) = refresh(tools).await? else {
        return Ok(Value::Null);
    };
    let now = tools.clock.now_ms();
    let mut plan = plan::empty();
    for key in keys(tools, |record| wanted(record, now)) {
        if omp_busy(tools) {
            // omp is being installed: wait without a back-off, the next pass tries again.
            defer_for_omp(tools, &key);
            continue;
        }
        plan = plan::merge(&plan, &work(tools, ctx, &key, &environment).await);
    }
    if !plan::is_empty(&plan) {
        // A tab that cannot apply it loads the new files at its next start.
        let _ = tools
            .ask("applyExtensionUpdate", json!({"plan": plan}))
            .await;
    }
    Ok(Value::Null)
}

fn keys(tools: &Tools, keep: impl Fn(&Record) -> bool) -> Vec<String> {
    tools
        .ext
        .borrow()
        .records
        .iter()
        .filter(|record| keep(record))
        .map(|record| record.row.key.clone())
        .collect()
}

async fn work(tools: &Rc<Tools>, ctx: &Ctx, key: &str, environment: &Environment) -> Value {
    let Some(target) = read(tools, key, |record| record.target.clone()) else {
        return plan::empty();
    };
    match target {
        Target::Marketplace(name) => {
            marketplace(tools, key, &name).await;
            plan::empty()
        }
        Target::Plugin(selector) => plugin(tools, key, selector).await,
        Target::Skill(selector) => skill(tools, key, selector).await,
        Target::Runner(runner) => {
            run_runner(tools, key, &runner, environment).await;
            plan::empty()
        }
        Target::Binary {
            command,
            binary,
            owner,
        } => update_binary(tools, ctx, key, command, *binary, owner, environment).await,
        Target::None => plan::empty(),
    }
}

fn reload() -> Value {
    json!({"reload": true, "restart": false, "reconnect": []})
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn installed(tools: &Tools, key: &str) -> Option<String> {
    read(tools, key, |record| record.row.installed.clone()).flatten()
}

fn skipped(tools: &Tools, key: &str) -> bool {
    read(tools, key, |record| record.row.skip.is_some()).unwrap_or(false)
}

async fn marketplace(tools: &Tools, key: &str, name: &str) {
    set_phase(tools, key, Phase::Checking);
    let refreshed = helper(
        tools,
        helper::MARKETPLACE_REFRESH,
        json!({"name": name}),
        CHECK_TIMEOUT_MS,
    )
    .await;
    if let Err(fault) = refreshed {
        return fail(tools, key, "check", Some(fault.message));
    }
    let now = tools.clock.now_ms();
    set(tools, key, |record| record.row.checked_at = Some(now));
    finish(tools, key, Last::Refreshed);
}

async fn plugin(tools: &Tools, key: &str, selector: Value) -> Value {
    set_phase(tools, key, Phase::Checking);
    let check = match helper(
        tools,
        helper::PLUGIN_CHECK,
        selector.clone(),
        CHECK_TIMEOUT_MS,
    )
    .await
    {
        Ok(check) => check,
        Err(fault) => {
            fail(tools, key, "check", Some(fault.message));
            return plan::empty();
        }
    };
    let latest = text(&check["latest"]);
    let now = tools.clock.now_ms();
    set(tools, key, |record| {
        record.row.installed = text(&check["installed"]).or(record.row.installed.take());
        record.row.latest = latest.clone();
        record.row.checked_at = Some(now);
    });
    let derived = if check["pinned"] == true {
        Some("pinned")
    } else if check["unversioned"] == true {
        Some("unversioned")
    } else {
        None
    };
    set_derived(tools, key, derived);
    // Pinned and unversioned rows never reach an upgrade call.
    if skipped(tools, key) {
        settle(tools, key, latest);
        return plan::empty();
    }
    let installed = installed(tools, key);
    // A git plugin has no latest to read: stock's upgrade re-resolves its ref and says whether anything moved.
    // Every other channel upgrades only to a version strictly newer than the installed one.
    let wanted = match &latest {
        None => selector["channel"] == "git",
        Some(latest) => is_newer(latest, installed.as_deref()),
    };
    if !wanted {
        finish(tools, key, Last::Current);
        return plan::empty();
    }
    set_phase(tools, key, Phase::Updating);
    let upgraded = match helper(tools, helper::PLUGIN_UPGRADE, selector, UPGRADE_TIMEOUT_MS).await {
        Ok(upgraded) => upgraded,
        Err(fault) => {
            fail(tools, key, "install", Some(fault.message));
            return plan::empty();
        }
    };
    if upgraded["changed"] != true {
        finish(tools, key, Last::Current);
        return plan::empty();
    }
    let moved_to = text(&upgraded["to"]);
    let to = moved_to
        .clone()
        .or(latest)
        .or_else(|| installed.clone())
        .unwrap_or_default();
    set(tools, key, |record| {
        if moved_to.is_some() {
            record.row.installed = moved_to;
        }
    });
    finish(
        tools,
        key,
        Last::Updated {
            from: text(&upgraded["from"]).or(installed),
            to,
        },
    );
    // Extensions, tools and hooks bind at session creation: a plugin that ships them restarts the tab.
    if upgraded["activation"] == "restart-required" {
        json!({"reload": false, "restart": true, "reconnect": []})
    } else {
        reload()
    }
}

async fn skill(tools: &Tools, key: &str, selector: Value) -> Value {
    set_phase(tools, key, Phase::Checking);
    let check = match helper(
        tools,
        helper::SKILL_CHECK,
        selector.clone(),
        CHECK_TIMEOUT_MS,
    )
    .await
    {
        Ok(check) => check,
        Err(fault) => {
            fail(tools, key, "check", Some(fault.message));
            return plan::empty();
        }
    };
    let within = text(&check["within"]);
    let latest = text(&check["latest"]).or_else(|| within.clone());
    let now = tools.clock.now_ms();
    set(tools, key, |record| {
        record.row.installed = text(&check["installed"]).or(record.row.installed.take());
        record.row.latest = latest.clone();
        record.row.checked_at = Some(now);
    });
    set_derived(tools, key, (check["pinned"] == true).then_some("pinned"));
    if skipped(tools, key) {
        settle(tools, key, latest);
        return plan::empty();
    }
    // What an update installs is what the recorded range resolves to, not the registry's newest.
    let installed = installed(tools, key);
    let Some(within) = within.filter(|within| is_newer(within, installed.as_deref())) else {
        finish(tools, key, Last::Current);
        return plan::empty();
    };
    set_phase(tools, key, Phase::Updating);
    let updated = match helper(tools, helper::SKILL_UPDATE, selector, UPGRADE_TIMEOUT_MS).await {
        Ok(updated) => updated,
        Err(fault) => {
            fail(tools, key, "install", Some(fault.message));
            return plan::empty();
        }
    };
    if !updated["blocked"].is_null() {
        // The new version ships scripts: stock asks a human, OMPdesk never approves for them.
        fail(tools, key, "needs-approval", text(&updated["version"]));
        return plan::empty();
    }
    if updated["changed"] != true {
        finish(tools, key, Last::Current);
        return plan::empty();
    }
    let to = text(&updated["to"]).unwrap_or(within);
    set(tools, key, |record| record.row.installed = Some(to.clone()));
    finish(
        tools,
        key,
        Last::Updated {
            from: text(&updated["from"]).or(installed),
            to,
        },
    );
    reload()
}

/// `<installer> cli-mcp-<name> <method> check`: a test installer's check of an MCP server.
fn installer_check(tools: &Tools, installer: &str, key: &str) -> CliCommand {
    let (name, method) = read(tools, key, |record| {
        (record.row.name.clone(), record.row.method.clone())
    })
    .unwrap_or_default();
    let args = [
        format!("cli-mcp-{name}"),
        method.unwrap_or_else(|| "self".to_owned()),
        "check".to_owned(),
    ];
    CliCommand {
        spawn: spawn_spec(installer, &args, platform(tools)),
        env: Env::new(),
        package_dir: false,
    }
}

async fn run(
    tools: &Tools,
    command: CliCommand,
    environment: &Environment,
) -> Result<String, String> {
    let run_check = Rc::clone(&tools.ext.borrow().deps.run_check);
    run_check(command, environment.env.clone()).await
}

/// A pinned runner package (`npx pkg@1.2.3`): look up the newest version, change nothing (`#runner`).
async fn run_runner(tools: &Tools, key: &str, runner: &RunnerPackage, environment: &Environment) {
    set_phase(tools, key, Phase::Checking);
    let installer = tools.opts.test_installer.clone();
    let looked_up = async {
        let check = match &installer {
            Some(installer) => Some(installer_check(tools, installer, key)),
            None => {
                let (runner, plan) = (runner.clone(), environment.plan.clone());
                off_hub(move || owner::runner_check(&runner, &plan)).await
            }
        };
        let Some(check) = check else {
            return Ok(None);
        };
        let output = run(tools, check, environment).await?;
        match installer {
            Some(_) => Ok(parse_omp_version(&output)),
            None => owner::runner_latest(runner, &output).map(Some),
        }
    };
    let latest = match looked_up.await {
        Ok(latest) => latest,
        Err(detail) => return fail(tools, key, "check", Some(detail)),
    };
    let now = tools.clock.now_ms();
    set(tools, key, |record| {
        record.row.latest = latest.clone();
        record.row.checked_at = Some(now);
    });
    // A range or a tag has no installed version to compare: only an exact pin can be "behind".
    let installed = installed(tools, key);
    let last = match latest {
        Some(latest) if installed.is_some() && is_newer(&latest, installed.as_deref()) => {
            Last::Available { latest }
        }
        _ => Last::Current,
    };
    finish(tools, key, last);
}

/// A direct MCP command's binary: ask its owner, update it inline under the setup supervisor, read the version again
/// (`#binary`).
async fn update_binary(
    tools: &Rc<Tools>,
    ctx: &Ctx,
    key: &str,
    command: String,
    binary: McpBinary,
    owner: Value,
    environment: &Environment,
) -> Value {
    if skipped(tools, key) {
        return plan::empty();
    }
    let method = owner["method"].as_str().unwrap_or_default().to_owned();
    let installer = tools.opts.test_installer.clone();
    set_phase(tools, key, Phase::Checking);
    let looked_up = async {
        if let Some(installer) = &installer {
            let output = run(tools, installer_check(tools, installer, key), environment).await?;
            return Ok(parse_omp_version(&output).or_else(|| binary.installed.clone()));
        }
        let check = {
            let (owner, plan) = (owner.clone(), environment.plan.clone());
            off_hub(move || owner::owner_check(&owner, &plan)).await
        };
        match check {
            Some(check) => {
                let output = run(tools, check, environment).await?;
                owner::owner_latest(&owner, &output, binary.installed.as_deref()).map(Some)
            }
            None => Ok(None),
        }
    };
    let latest = match looked_up.await {
        Ok(latest) => latest,
        Err(detail) => {
            fail(tools, key, "check", Some(detail));
            return plan::empty();
        }
    };
    let now = tools.clock.now_ms();
    set(tools, key, |record| {
        record.row.latest = latest.clone();
        record.row.checked_at = Some(now);
    });
    let installed = binary.installed.clone();
    if let (Some(latest), Some(installed)) = (&latest, &installed)
        && !is_newer(latest, Some(installed))
    {
        finish(tools, key, Last::Current);
        return plan::empty();
    }
    // Only macOS scans its processes; on Windows a file a running server holds just fails the update.
    if platform(tools) == "darwin" && crate::ext::running::defers(Some(&method), binary.script) {
        let running = Rc::clone(&tools.ext.borrow().deps.running);
        // A test installer never scans the real `ps`.
        let commands = installer.as_ref().map(|_| String::new());
        match running(command.clone(), binary.clone(), commands).await {
            Ok(true) => {
                finish(
                    tools,
                    key,
                    Last::Deferred {
                        latest,
                        why: "running",
                    },
                );
                return plan::empty();
            }
            Ok(false) => {}
            // The running rule got no answer: the update never runs without it.
            Err(fault) => {
                fail(tools, key, "check", Some(fault.message));
                return plan::empty();
            }
        }
    }
    let update = {
        let (owner, latest, plan) = (owner.clone(), latest.clone(), environment.plan.clone());
        off_hub(move || owner::owner_update(&owner, latest.as_deref(), &plan)).await
    };
    if update.is_none() && installer.is_none() {
        fail(
            tools,
            key,
            "install",
            Some(format!("no {method} to run the update with")),
        );
        return plan::empty();
    }
    set_phase(tools, key, Phase::Updating);
    let name = read(tools, key, |record| record.row.name.clone()).unwrap_or_default();
    let (spawn, env) = match update {
        Some(update) => (Some(update.spawn), update.env),
        None => (None, Env::new()),
    };
    let run_update = Rc::clone(&tools.ext.borrow().deps.run_update);
    let request = ToolUpdateRequest {
        tool: format!("mcp-{name}"),
        method,
        spawn,
        managed: None,
        env,
    };
    match run_update(Rc::clone(tools), ctx.clone(), request).await {
        ToolUpdateOutcome::Succeeded => {}
        ToolUpdateOutcome::Skipped => {
            set_phase(tools, key, Phase::Idle);
            return plan::empty();
        }
        ToolUpdateOutcome::Cancelled => {
            fail(tools, key, "cancelled", None);
            return plan::empty();
        }
        ToolUpdateOutcome::Failed(detail) => {
            fail(tools, key, "install", detail);
            return plan::empty();
        }
    }
    let detect = Rc::clone(&tools.ext.borrow().deps.detect);
    let after = match detect(command.clone(), Rc::clone(&environment.owner)).await {
        Ok(after) => after,
        // The update ran, and what it left cannot be read: neither "updated" nor "not updated" is known.
        Err(fault) => {
            fail(tools, key, "check", Some(fault.message));
            return plan::empty();
        }
    };
    let now = after.as_ref().and_then(|after| after.installed.clone());
    if let Some(after) = after {
        let found = now.clone();
        set(tools, key, |record| {
            if let Some(owner) = after.owner.clone() {
                record.target = Target::Binary {
                    command,
                    binary: Box::new(after),
                    owner,
                };
            }
            record.row.installed = found;
        });
    }
    let moved = now
        .as_deref()
        .is_some_and(|now| installed.is_none() || is_newer(now, installed.as_deref()));
    if let Some(to) = now.filter(|now| {
        moved
            && latest
                .as_deref()
                .is_none_or(|latest| !is_newer(latest, Some(now)))
    }) {
        finish(
            tools,
            key,
            Last::Updated {
                from: installed,
                to,
            },
        );
        return json!({"reload": false, "restart": false, "reconnect": [name]});
    }
    // The owner's own upgrade (uv tool, pipx) checks by itself: a clean run that changed nothing means it was current.
    if latest.is_none() && !moved {
        finish(tools, key, Last::Current);
        return plan::empty();
    }
    fail(tools, key, "not-updated", None);
    plan::empty()
}

// ---- the calls ------------------------------------------------------------------------------------------------

fn enqueue_pass(
    tools: &Rc<Tools>,
    only: Option<String>,
    scheduled: bool,
) -> Result<LocalFuture<Answer>, Fault> {
    let weak = Rc::downgrade(tools);
    tools.enqueue(LABEL, StepKind::ExtPass, move |ctx| {
        Box::pin(async move {
            let Some(tools) = weak.upgrade() else {
                return Ok(Value::Null);
            };
            pass(tools, ctx, only, scheduled).await
        })
    })
}

/// Lists what is installed again without checking or updating (`rescan`; Settings opened, a launch that does not
/// schedule).
pub fn rescan(tools: &Rc<Tools>) -> Result<LocalFuture<Answer>, Fault> {
    let weak = Rc::downgrade(tools);
    tools.enqueue(LABEL, StepKind::ExtPass, move |_| {
        Box::pin(async move {
            let Some(tools) = weak.upgrade() else {
                return Ok(Value::Null);
            };
            // A listing changes no row's phase: a stopped one has nothing to set idle.
            refresh(&tools).await.map(|_| Value::Null)
        })
    })
}

/// The timer's pass: with the pref off it only lists.
pub fn tick(tools: &Rc<Tools>) -> Result<LocalFuture<Answer>, Fault> {
    if tools.auto_update() {
        enqueue_pass(tools, None, true)
    } else {
        rescan(tools)
    }
}

#[derive(Deserialize)]
struct NowParams {
    #[serde(default)]
    key: Value,
}

pub fn call(tools: &Rc<Tools>, method: &str, args: &RawValue) -> Option<Outcome> {
    match method {
        "now" => Some(now(tools, args)),
        "rescan" => Some(queued(rescan(tools))),
        "prefChanged" => {
            // The pref changed: the windows hear it; turning it on checks right away.
            tools.changed("ext");
            if tools.started.get() && tools.opts.scheduled.ext && tools.auto_update() {
                let _ = enqueue_pass(tools, None, true);
            }
            Some(Outcome::done())
        }
        _ => None,
    }
}

fn now(tools: &Rc<Tools>, args: &RawValue) -> Outcome {
    let key = match params::<NowParams>(args) {
        Ok(params) => params.key,
        Err(fault) => return Outcome::Now(Err(fault)),
    };
    // Only a row of the current state is a handle; anything else (a path, a command) never reaches the updater.
    let known = key.is_null()
        || key.as_str().is_some_and(|key| {
            tools
                .ext
                .borrow()
                .records
                .iter()
                .any(|record| record.row.key == key)
        });
    if !known {
        return Outcome::fault(
            "extension_key",
            format!("Unknown extension: {}", string_of_value(&key)),
        );
    }
    queued(enqueue_pass(tools, key.as_str().map(str::to_owned), false))
}
