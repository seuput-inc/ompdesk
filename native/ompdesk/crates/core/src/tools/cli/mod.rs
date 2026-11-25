//! The tool CLI updater's part (`src/main/cli-tools/updater.ts`, contract `src/shared/cli-update.ts`): keeps the
//! vendor CLIs of connected accounts current. A scheduled pass (at launch after setup's first pass, every 4 h, with a
//! longer wait per tool after failures in a row) lists the providers with a stored credential (stock's own store,
//! through main's stock worker), finds each relevant tool that is installed, asks its owner for the newest version and,
//! when that is newer, runs the owner's update under the setup supervisor ([`setup::run_tool_update`], inline in the
//! pass's step), then detects the tool again. A tool that is not installed is never installed here; a system,
//! app-bundled or admin-owned copy is listed with the reason it is left alone. On macOS an update that would replace a
//! running Node CLI's package dir waits for the next check instead; on Windows a file a running tool holds fails the
//! update, which is recorded and retried later.
//!
//! Calls: `cli.now {id?}` (Update now: one tool or all, whatever the pref and the back-off say), `cli.rescan` (list the
//! tools again without checking: Settings opened, a provider connected), `cli.prefChanged` (`toolsAutoUpdate`
//! changed: the state again, and a check now when it turned on in a scheduled launch).

mod catalog;
mod detect;
#[cfg(test)]
mod tests;

use std::rc::Rc;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::queue::{Answer, Ctx, StepKind};
use super::setup::{self, ToolUpdateOutcome, ToolUpdateRequest};
use super::spawn::{
    CliCommand, Env, InstallContext, PlanTools, bun_view, command, executable_name, find_brew,
    find_on_path, is_newer, npm_bin, off_hub, off_hub_async, owner_check_command,
    owner_update_command, parse_latest, parse_omp_version, probe_output, run_check, spawn_spec,
};
use super::{Backoff, Tools, queued};
use crate::control::js::string_of_value;
use crate::hub::{LocalFuture, Outcome, params};
use crate::server::Fault;
use catalog::spec;
pub use detect::DetectDeps;

/// `CLI_TOOLS` of `src/shared/cli-update.ts`, in order.
pub const TOOLS: [&str; 9] = [
    "claude",
    "codex",
    "gemini",
    "cursor-agent",
    "copilot",
    "gh",
    "gh-copilot",
    "node",
    "agent-desktop",
];

/// The step every pass and listing of this part runs as.
const LABEL: &str = "tool CLI update";
/// The stock worker's default bound (`stockHelperRequest`).
const STOCK_TIMEOUT_MS: u64 = 30_000;

/// `CliDetection`: where a tool was found and who owns it (`owner` is the `CliOwner` JSON).
#[derive(Clone, Debug, PartialEq)]
pub struct Detection {
    pub id: &'static str,
    /// As found on PATH.
    pub path: String,
    /// Links and shims followed.
    pub real: String,
    pub owner: Option<Value>,
    pub skip: Option<String>,
    pub installed: Option<String>,
}

/// `CliToolState`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolState {
    id: &'static str,
    providers: Vec<String>,
    installed: Option<String>,
    path: Option<String>,
    method: Option<String>,
    skip: Option<String>,
    phase: &'static str,
    latest: Option<String>,
    checked_at: Option<u64>,
    /// `CliUpdateResult`.
    last: Option<Value>,
}

struct Record {
    state: ToolState,
    detection: Detection,
    backoff: Backoff,
}

/// What a pass does outside the process: the seam tests answer themselves.
pub trait Io {
    fn detect(&self, id: &'static str, deps: &DetectDeps) -> LocalFuture<Option<Detection>>;
    fn run_check(&self, command: &CliCommand, env: &Env) -> LocalFuture<Result<String, String>>;
    /// Whether a process of the tool runs (`runningIn`: the core's `ps` scan on macOS; `commands` for a test launch).
    fn running(
        &self,
        detection: &Detection,
        owner: &Value,
        commands: Option<String>,
    ) -> LocalFuture<Result<bool, String>>;
    fn latest_managed(&self, tools: &Rc<Tools>, item: &str) -> LocalFuture<Result<String, String>>;
    fn run_update(
        &self,
        tools: &Rc<Tools>,
        ctx: &Ctx,
        request: ToolUpdateRequest,
    ) -> LocalFuture<ToolUpdateOutcome>;
}

/// The machine.
struct System;

impl Io for System {
    fn detect(&self, id: &'static str, deps: &DetectDeps) -> LocalFuture<Option<Detection>> {
        let deps = deps.clone();
        Box::pin(async move {
            let (env, platform) = (deps.env.clone(), deps.ctx.platform.clone());
            let probe = move |bin: &str, args: &[String]| -> LocalFuture<Result<String, String>> {
                let (bin, args, env, platform) =
                    (bin.to_owned(), args.to_vec(), env.clone(), platform.clone());
                Box::pin(async move { probe_output(&bin, &args, &env, &platform).await })
            };
            detect::detect_cli_tool(id, &deps, &probe).await
        })
    }

    fn run_check(&self, command: &CliCommand, env: &Env) -> LocalFuture<Result<String, String>> {
        let (command, env) = (command.clone(), env.clone());
        Box::pin(async move { run_check(&command, &env).await })
    }

    fn running(
        &self,
        detection: &Detection,
        owner: &Value,
        commands: Option<String>,
    ) -> LocalFuture<Result<bool, String>> {
        let params = running_params(detection, owner, commands);
        Box::pin(async move {
            let params = serde_json::from_value(params).map_err(|error| error.to_string())?;
            Ok(off_hub_async(move || crate::ext::running::update_running(params)).await)
        })
    }

    fn latest_managed(&self, tools: &Rc<Tools>, item: &str) -> LocalFuture<Result<String, String>> {
        let (tools, item) = (Rc::clone(tools), item.to_owned());
        Box::pin(async move { setup::latest_managed(&tools, &item).await })
    }

    fn run_update(
        &self,
        tools: &Rc<Tools>,
        ctx: &Ctx,
        request: ToolUpdateRequest,
    ) -> LocalFuture<ToolUpdateOutcome> {
        let (tools, ctx) = (Rc::clone(tools), ctx.clone());
        Box::pin(async move { setup::run_tool_update(&tools, &ctx, request).await })
    }
}

/// A machine with no vendor CLI on it: the other parts' tests list the tools without reading this computer (a
/// Homebrew prefix or `/usr/local/bin` holding `gh` or `node` would add rows and a file read off the test's thread).
#[cfg(test)]
pub fn offline(tools: &Tools) {
    struct Offline;
    impl Io for Offline {
        fn detect(&self, _: &'static str, _: &DetectDeps) -> LocalFuture<Option<Detection>> {
            Box::pin(async { None })
        }
        fn run_check(
            &self,
            command: &CliCommand,
            env: &Env,
        ) -> LocalFuture<Result<String, String>> {
            System.run_check(command, env)
        }
        fn running(
            &self,
            detection: &Detection,
            owner: &Value,
            commands: Option<String>,
        ) -> LocalFuture<Result<bool, String>> {
            System.running(detection, owner, commands)
        }
        fn latest_managed(
            &self,
            tools: &Rc<Tools>,
            item: &str,
        ) -> LocalFuture<Result<String, String>> {
            System.latest_managed(tools, item)
        }
        fn run_update(
            &self,
            tools: &Rc<Tools>,
            ctx: &Ctx,
            request: ToolUpdateRequest,
        ) -> LocalFuture<ToolUpdateOutcome> {
            System.run_update(tools, ctx, request)
        }
    }
    tools.cli.borrow_mut().io = Rc::new(Offline);
}

/// `ext.updateRunning`'s params for a tool (`runningIn`).
fn running_params(detection: &Detection, owner: &Value, commands: Option<String>) -> Value {
    json!({
        "kind": "cli",
        "command": spec(detection.id).bin,
        "binary": {"real": detection.real, "path": detection.path, "owner": owner},
        "commands": commands,
    })
}

pub struct Part {
    /// The installed relevant tools, in `TOOLS` order.
    records: Vec<Record>,
    io: Rc<dyn Io>,
}

impl Default for Part {
    fn default() -> Part {
        Part {
            records: Vec::new(),
            io: Rc::new(System),
        }
    }
}

impl Part {
    fn record(&mut self, id: &str) -> Option<&mut Record> {
        self.records.iter_mut().find(|record| record.state.id == id)
    }
}

/// `CliUpdateState`.
pub fn state(tools: &Tools) -> Value {
    let part = tools.cli.borrow();
    let rows: Vec<&ToolState> = part.records.iter().map(|record| &record.state).collect();
    json!({
        "enabled": tools.auto_update(),
        "scheduled": tools.opts.scheduled.cli,
        "tools": rows,
    })
}

/// `CliPlatform`: Windows, else macOS's rules.
fn platform(tools: &Tools) -> &'static str {
    if tools.opts.platform == "win32" {
        "win32"
    } else {
        "darwin"
    }
}

fn emit(tools: &Tools) {
    if !tools.is_closed() {
        tools.changed("cli");
    }
}

/// Changes `id`'s state and tells main.
fn set(tools: &Tools, id: &str, change: impl FnOnce(&mut ToolState)) {
    {
        let mut part = tools.cli.borrow_mut();
        let Some(record) = part.record(id) else {
            return;
        };
        change(&mut record.state);
    }
    emit(tools);
}

/// How a check of `id` ended: the back-off settles (a cancel, the person's or the quit's, is no failure) and the tool
/// is idle again with its result.
fn finish(tools: &Tools, id: &str, last: Value) {
    let failed = last["kind"] == "failed" && last["failure"]["reason"] != "cancelled";
    let now = tools.clock.now_ms();
    set(tools, id, |state| {
        state.phase = "idle";
        state.last = Some(last);
    });
    if let Some(record) = tools.cli.borrow_mut().record(id) {
        record.backoff.settle(failed, now);
    }
}

fn fail(tools: &Tools, id: &str, reason: &str, detail: Option<String>) {
    let mut failure = json!({"reason": reason});
    if let Some(detail) = detail {
        failure["detail"] = json!(detail);
    }
    finish(tools, id, json!({"kind": "failed", "failure": failure}));
}

/// A step that was stopped (its bound, the quit) can no longer write: whatever it left checking or updating is idle
/// again (`onStall`). A step that ended left nothing to change.
struct IdleWhenDropped(Rc<Tools>);

impl Drop for IdleWhenDropped {
    fn drop(&mut self) {
        let changed = {
            let Ok(mut part) = self.0.cli.try_borrow_mut() else {
                return;
            };
            let mut changed = false;
            for record in &mut part.records {
                if record.state.phase != "idle" {
                    record.state.phase = "idle";
                    changed = true;
                }
            }
            changed
        };
        if changed {
            emit(&self.0);
        }
    }
}

/// The environment a pass detects and checks with: main's spawn environment (with the proxy only when it checks: a
/// listing reaches no network), its PATH and Homebrew.
async fn detect_deps(tools: &Tools, checks: bool) -> Result<DetectDeps, Fault> {
    let env = if checks {
        tools.spawn_env().await?
    } else {
        tools.base_env().await?
    };
    let platform = platform(tools);
    let path_env = env
        .get("PATH")
        .or_else(|| {
            env.iter()
                .find(|(name, _)| platform == "win32" && name.eq_ignore_ascii_case("PATH"))
                .map(|(_, value)| value)
        })
        .cloned()
        .unwrap_or_default();
    let brew = {
        let (path_env, platform) = (path_env.clone(), platform.to_owned());
        off_hub(move || find_brew(&path_env, &platform)).await
    };
    Ok(DetectDeps {
        ctx: InstallContext {
            platform: platform.to_owned(),
            tools_dir: tools.opts.tools_dir.clone(),
            brew,
        },
        path_env,
        env,
        agent_desktop_bundle: tools.opts.agent_desktop_bundle.clone(),
        brew_dirs: super::spawn::brew_bin_dirs(),
    })
}

/// Stock provider ids with a stored credential (`accounts.providers`); a failure lists none, so machine setup's tools
/// still count.
async fn connected_providers(tools: &Tools) -> Vec<String> {
    let asked = tools.ask(
        "stock",
        json!({"method": "accounts.providers", "params": {}, "timeoutMs": STOCK_TIMEOUT_MS}),
    );
    asked
        .await
        .ok()
        .and_then(|answer| serde_json::from_value(answer["providers"].clone()).ok())
        .unwrap_or_default()
}

/// Lists the relevant installed tools again (a provider connected or left, a tool installed or removed).
async fn refresh(tools: &Rc<Tools>, checks: bool) -> Result<DetectDeps, Fault> {
    let deps = detect_deps(tools, checks).await?;
    let providers = connected_providers(tools).await;
    let relevant = catalog::relevant_tools(&providers);
    let io = Rc::clone(&tools.cli.borrow().io);
    let found = futures_util::future::join_all(relevant.into_iter().map(|(id, using)| {
        let detected = io.detect(id, &deps);
        async move { (id, using, detected.await) }
    }))
    .await;
    {
        let mut part = tools.cli.borrow_mut();
        let mut records = std::mem::take(&mut part.records);
        for (id, using, detection) in found {
            let Some(detection) = detection else { continue };
            let fields = |state: &mut ToolState| {
                state.providers = using.clone();
                state.installed = detection.installed.clone();
                state.path = Some(detection.real.clone());
                state.method = detection
                    .owner
                    .as_ref()
                    .and_then(|owner| owner["method"].as_str())
                    .map(str::to_owned);
                state.skip = detection.skip.clone();
            };
            let record = match records.iter().position(|record| record.state.id == id) {
                Some(at) => {
                    let mut record = records.swap_remove(at);
                    fields(&mut record.state);
                    record.detection = detection.clone();
                    record
                }
                None => {
                    let mut state = ToolState {
                        id,
                        providers: Vec::new(),
                        installed: None,
                        path: None,
                        method: None,
                        skip: None,
                        phase: "idle",
                        latest: None,
                        checked_at: None,
                        last: None,
                    };
                    fields(&mut state);
                    Record {
                        state,
                        detection: detection.clone(),
                        backoff: Backoff::default(),
                    }
                }
            };
            part.records.push(record);
        }
    }
    emit(tools);
    Ok(deps)
}

/// A check (and update) of every listed tool, or of `only`; a scheduled pass skips a tool still backing off.
async fn pass(tools: Rc<Tools>, ctx: Ctx, only: Option<String>, scheduled: bool) -> Answer {
    let _idle = IdleWhenDropped(Rc::clone(&tools));
    let deps = refresh(&tools, true).await?;
    let now = tools.clock.now_ms();
    for id in TOOLS {
        if tools.is_closed() {
            break;
        }
        if only.as_deref().is_some_and(|only| only != id) {
            continue;
        }
        let due = tools.cli.borrow_mut().record(id).is_some_and(|record| {
            record.detection.skip.is_none()
                && record.detection.owner.is_some()
                && !(scheduled && now < record.backoff.next_at)
        });
        if due {
            check(&tools, &ctx, id, &deps).await;
        }
    }
    Ok(Value::Null)
}

/// The listing alone.
async fn rescan(tools: Rc<Tools>) -> Answer {
    let _idle = IdleWhenDropped(Rc::clone(&tools));
    refresh(&tools, false).await.map(|_| Value::Null)
}

/// The read-only check that prints the newest version, or none when only the tool's own updater can tell (cursor-agent,
/// gh-copilot) or the owner is machine setup's archive (checked through its release feed).
pub fn check_command(
    detection: &Detection,
    owner: &Value,
    tools: &PlanTools,
) -> Option<CliCommand> {
    match owner["method"].as_str() {
        Some("self") => {
            let spec = spec(detection.id);
            let package = spec
                .npm
                .filter(|_| spec.update.as_ref().is_some_and(|update| update.registry))?;
            let found = |name: String| find_on_path(&[name], &tools.path_env, &tools.platform, &[]);
            if let Some(npm) = found(npm_bin(&tools.platform).to_owned()) {
                return Some(command(
                    &npm,
                    &["view".into(), package.into(), "version".into()],
                ));
            }
            found(executable_name("bun", &tools.platform)).map(|bun| bun_view(&bun, package))
        }
        Some("managed") => None,
        _ => owner_check_command(owner, tools),
    }
}

/// The update itself, for every owner but machine setup's archive (setup runs that one).
pub fn update_command(
    detection: &Detection,
    owner: &Value,
    latest: Option<&str>,
    tools: &PlanTools,
) -> Option<CliCommand> {
    if owner["method"] == "self" {
        let update = spec(detection.id).update.as_ref()?;
        let args: Vec<String> = update.args.iter().map(|arg| (*arg).to_owned()).collect();
        return Some(command(&detection.path, &args));
    }
    owner_update_command(owner, latest, tools)
}

/// Whether an update must wait while a process of the tool runs (`waitsForIdle`, `ext.cliWaitsForIdle`): npm and Bun
/// replace the whole package dir and Homebrew removes the old keg, so a running Node CLI could load a file of the
/// other version or find it missing; a single native binary keeps running from its old inode, and the vendors' own
/// updaters install into a new versioned dir and switch a link.
pub fn waits_for_idle(detection: &Detection, owner: &Value) -> bool {
    serde_json::from_value(
        json!({"method": owner["method"], "lazyLoads": spec(detection.id).lazy_loads}),
    )
    .is_ok_and(crate::ext::running::cli_defers)
}

/// The test installer's check: `<installer> cli-<tool> <method> check` prints the newest version.
fn installer_check(installer: &str, id: &str, method: &str, platform: &str) -> CliCommand {
    CliCommand {
        spawn: spawn_spec(
            installer,
            &[format!("cli-{id}"), method.to_owned(), "check".to_owned()],
            platform,
        ),
        ..CliCommand::default()
    }
}

/// The newest version of `detection` as its owner (or the test installer) tells it; none when only its own updater
/// knows.
async fn latest_of(
    tools: &Rc<Tools>,
    io: &Rc<dyn Io>,
    detection: &Detection,
    owner: &Value,
    deps: &DetectDeps,
) -> Result<Option<String>, String> {
    let method = owner["method"].as_str().unwrap_or("self");
    if let Some(installer) = &tools.opts.test_installer {
        let check = installer_check(installer, detection.id, method, platform(tools));
        let output = io.run_check(&check, &deps.env).await?;
        return Ok(parse_omp_version(&output).or_else(|| detection.installed.clone()));
    }
    if method == "managed" {
        let item = owner["item"].as_str().unwrap_or_default();
        return Ok(parse_omp_version(&io.latest_managed(tools, item).await?));
    }
    let plan = PlanTools {
        platform: deps.ctx.platform.clone(),
        path_env: deps.path_env.clone(),
    };
    let check = {
        let (detection, owner) = (detection.clone(), owner.clone());
        off_hub(move || check_command(&detection, &owner, &plan)).await
    };
    match check {
        Some(check) => {
            let output = io.run_check(&check, &deps.env).await?;
            parse_latest(owner, &output, detection.installed.as_deref()).map(Some)
        }
        None => Ok(None),
    }
}

async fn check(tools: &Rc<Tools>, ctx: &Ctx, id: &'static str, deps: &DetectDeps) {
    let Some(detection) = tools
        .cli
        .borrow_mut()
        .record(id)
        .map(|record| record.detection.clone())
    else {
        return;
    };
    let Some(owner) = detection.owner.clone() else {
        return;
    };
    let io = Rc::clone(&tools.cli.borrow().io);
    set(tools, id, |state| state.phase = "checking");
    let latest = match latest_of(tools, &io, &detection, &owner, deps).await {
        Ok(latest) => latest,
        Err(detail) => return fail(tools, id, "check", Some(detail)),
    };
    let checked_at = tools.clock.now_ms();
    set(tools, id, |state| {
        state.latest = latest.clone();
        state.checked_at = Some(checked_at);
    });
    let installed = detection.installed.clone();
    if let (Some(latest), Some(installed)) = (&latest, &installed)
        && !is_newer(latest, Some(installed))
    {
        return finish(tools, id, json!({"kind": "current"}));
    }
    if platform(tools) == "darwin" && waits_for_idle(&detection, &owner) {
        // A test launch never scans the real processes.
        let commands = tools.opts.test_installer.as_ref().map(|_| String::new());
        match io.running(&detection, &owner, commands).await {
            Ok(true) => {
                let latest = latest.clone().unwrap_or_default();
                return finish(tools, id, json!({"kind": "deferred", "latest": latest}));
            }
            Ok(false) => {}
            Err(detail) => return fail(tools, id, "check", Some(detail)),
        }
    }
    let method = owner["method"].as_str().unwrap_or_default().to_owned();
    let request = if method == "managed" {
        ToolUpdateRequest {
            tool: id.to_owned(),
            method,
            spawn: None,
            managed: owner["item"].as_str().map(str::to_owned),
            env: Env::new(),
        }
    } else {
        let plan = PlanTools {
            platform: deps.ctx.platform.clone(),
            path_env: deps.path_env.clone(),
        };
        let update = {
            let (detection, owner, latest) = (detection.clone(), owner.clone(), latest.clone());
            off_hub(move || update_command(&detection, &owner, latest.as_deref(), &plan)).await
        };
        if update.is_none() && tools.opts.test_installer.is_none() {
            let detail = format!("no {method} to run the update with");
            return fail(tools, id, "install", Some(detail));
        }
        let (spawn, env) = update.map_or((None, Env::new()), |update| {
            (Some(update.spawn), update.env)
        });
        ToolUpdateRequest {
            tool: id.to_owned(),
            method,
            spawn,
            managed: None,
            env,
        }
    };
    set(tools, id, |state| state.phase = "updating");
    match io.run_update(tools, ctx, request).await {
        ToolUpdateOutcome::Skipped => return set(tools, id, |state| state.phase = "idle"),
        ToolUpdateOutcome::Cancelled => return fail(tools, id, "cancelled", None),
        ToolUpdateOutcome::Failed(detail) => return fail(tools, id, "install", detail),
        ToolUpdateOutcome::Succeeded => {}
    }
    let after = io.detect(id, deps).await;
    let now = after.as_ref().and_then(|after| after.installed.clone());
    if let Some(after) = after {
        let path = after.real.clone();
        if let Some(record) = tools.cli.borrow_mut().record(id) {
            record.detection = after;
        }
        set(tools, id, |state| {
            state.installed = now.clone();
            state.path = Some(path);
        });
    }
    let moved = now
        .as_deref()
        .is_some_and(|now| is_newer(now, installed.as_deref()));
    if let Some(now) = now.as_deref().filter(|_| moved)
        && latest
            .as_deref()
            .is_none_or(|latest| !is_newer(latest, Some(now)))
    {
        return finish(
            tools,
            id,
            json!({"kind": "updated", "from": installed, "to": now}),
        );
    }
    // The tool's own updater checks by itself: a clean run that changed nothing means it was current.
    if latest.is_none() && !moved {
        return finish(tools, id, json!({"kind": "current"}));
    }
    fail(tools, id, "not-updated", None);
}

fn enqueue_pass(
    tools: &Rc<Tools>,
    only: Option<String>,
    scheduled: bool,
) -> Result<LocalFuture<Answer>, Fault> {
    let owner = Rc::clone(tools);
    tools.enqueue(LABEL, StepKind::CliPass, move |ctx| {
        Box::pin(pass(owner, ctx, only, scheduled))
    })
}

fn enqueue_rescan(tools: &Rc<Tools>) -> Result<LocalFuture<Answer>, Fault> {
    let owner = Rc::clone(tools);
    tools.enqueue(LABEL, StepKind::CliPass, move |_| Box::pin(rescan(owner)))
}

/// Setup's first pass ended in a launch that does not check on a timer: the tools are listed, not checked.
pub fn start(tools: &Rc<Tools>) {
    // Its answer goes nowhere: the listing reaches main as state.
    let _ = enqueue_rescan(tools);
}

/// The timer's tick: a scheduled pass while the pref is on, else the listing alone (read when the step runs).
pub fn tick(tools: &Rc<Tools>) -> Result<LocalFuture<Answer>, Fault> {
    let owner = Rc::clone(tools);
    tools.enqueue(LABEL, StepKind::CliPass, move |ctx| {
        if owner.auto_update() {
            Box::pin(pass(owner, ctx, None, true))
        } else {
            Box::pin(rescan(owner))
        }
    })
}

#[derive(Deserialize)]
struct NowParams {
    #[serde(default)]
    id: Value,
}

pub fn call(tools: &Rc<Tools>, method: &str, args: &RawValue) -> Option<Outcome> {
    match method {
        "now" => {
            let id = match params::<NowParams>(args) {
                Ok(params) => params.id,
                Err(fault) => return Some(Outcome::Now(Err(fault))),
            };
            if !id.is_null() && !id.as_str().is_some_and(|id| TOOLS.contains(&id)) {
                return Some(Outcome::fault(
                    "cli_tool",
                    format!("Unknown tool: {}", string_of_value(&id)),
                ));
            }
            Some(queued(enqueue_pass(
                tools,
                id.as_str().map(str::to_owned),
                false,
            )))
        }
        "rescan" => Some(queued(enqueue_rescan(tools))),
        "prefChanged" => {
            emit(tools);
            if tools.is_started() && tools.opts.scheduled.cli && tools.auto_update() {
                // Its answer goes nowhere: what it does reaches main as state.
                let _ = enqueue_pass(tools, None, true);
            }
            Some(Outcome::done())
        }
        _ => None,
    }
}
