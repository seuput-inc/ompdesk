//! Machine setup's part (T2.2; was `src/main/setup/service.ts` with `plans.ts`, `detect.ts`, `git-aslr.ts` and
//! `compiled-launcher.ts`): what OMPdesk needs on this computer, what it is doing about it, and why an install failed.
//! At start it detects every item; when automatic it installs the missing required items in order (Bun, Git for
//! Windows on Windows, omp at the tested version), then, once the first tab is ready (`firstTab`), the missing
//! optional ones. Nothing asks first: the renderer only shows the state and may retry or cancel by item id.
//!
//! Back-off (`ledger.rs`): each item is attempted automatically at most once per launch, and after three automatic
//! attempts that left it missing, at most once a day. A retry or a connection's install always runs.
//!
//! **Calls** (the module header of `tools/mod.rs`): `setup.retry {item}`, `setup.installForConnection {item}` (answers
//! the item's state once that attempt ended), `setup.cancel`, `setup.gitAslr {action}` (answers `GitAslrResult`).
//!
//! **Contract to the other parts**, each run inline in the caller's own step (`ctx`), so the install it starts is
//! stopped with that step and writes nothing after:
//! - [`run_tool_update`]`(tools, ctx, request) -> ToolUpdateOutcome`: one vendor CLI's update (`cli-<tool> <method>
//!   update` under the test installer, after the test download; the owner's `spawn`; or machine setup's own verified
//!   archive again for `managed`), never touching the items; `skipped` after the close or where setup cannot run;
//! - [`update_omp`]`(tools, ctx, target, exact_only, before_install) -> OmpUpdateOutcome`: omp moved to exactly
//!   `target` (Bun's or npm's package install; stock `omp update` only when not `exact_only`), Bun upgraded first when
//!   the release's `engines.bun` needs it, a compiled omp the update left put back as the package; `before_install`
//!   runs just before the installer starts (the omp part releases the helpers there);
//! - [`latest_omp`]`(tools) -> Result<String, String>`: stock `omp update --check` on the detected omp in its update's
//!   environment; [`newest_omp_in`]`(tools, major) -> Result<Option<String>, String>`: the newest release of one major
//!   in that registry, none for an omp Bun does not manage; [`latest_managed`]`(tools, item) -> Result<String,
//!   String>`: the newest verified archive release of gh, Node or agent-desktop;
//! - [`installed_omp`]`(tools) -> Option<String>` and [`omp_present`]`(tools) -> bool`, read in the same tick.
//!
//! What only main has is asked: `env` (the spawn environment; the proxy is the core's), `ompResolution {fresh}`
//! (main's omp resolution, refreshed after an install: `OmpResolution`), `refreshPath` (main's PATH after an
//! install), `ompReady` (omp became usable), `firstTab`. `log` items carry the `setup` lines and, for an omp install of
//! setup's own, the `omp-update` lines with `path: "setup"`.

mod detect;
mod git_aslr;
mod ledger;
mod paths;
mod plans;
#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::collections::{BTreeMap, HashSet};
use std::rc::Rc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::queue::{Ctx, StepKind};
use super::runner::{FailedBy, Ran, RunOutcome, SpawnSpec, push_tail};
use super::spawn::{is_newer, spawn_spec};
use super::{Opts, Tools, queued};
use crate::control::js::string_of_value;
use crate::hub::{LocalFuture, Outcome, params};
use crate::server::{Fault, Scope};
pub use detect::Detection;
use ledger::Ledger;
pub(crate) use paths::managed_bin_dirs;
use plans::{OmpNpm, PlanContext, PlanDownload, Release};

pub type Env = BTreeMap<String, String>;

/// `SETUP_ITEMS` of `src/shared/setup.ts`, in order.
pub const ITEMS: [&str; 7] = [
    "bun",
    "git",
    "omp",
    "gh",
    "node",
    "agent-desktop",
    "tailscale",
];

/// `setupItemRequired`: Bun and omp everywhere, Git only on Windows.
pub fn required(item: &str, platform: &str) -> bool {
    item == "bun" || item == "omp" || (item == "git" && platform == "win32")
}

/// `setupItemAutomatic`: Tailscale is only ever asked for.
pub fn automatic(item: &str) -> bool {
    item != "tailscale"
}

/// Coalesced output and progress pushes (`OUTPUT_EMIT_MS`).
const EMIT_EVERY: Duration = Duration::from_millis(100);
/// Lines of installer output kept as a reason (`UPDATE_DETAIL_LINES`).
const DETAIL_LINES: usize = 6;
/// `omp update --check` and `bun pm view` (`UPDATE_CHECK_TIMEOUT_MS`).
const CHECK_TIMEOUT_MS: u64 = 60_000;

/// `SetupPresence`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Presence {
    Present {
        version: Option<String>,
        path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        git_shell: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        git_aslr_override: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        git_aslr_undoable: Option<bool>,
    },
    Missing,
    Outdated {
        version: String,
        minimum: String,
        path: Option<String>,
    },
    Broken {
        detail: String,
        path: Option<String>,
    },
}

impl Presence {
    pub fn present(version: &str) -> Presence {
        Presence::Present {
            version: Some(version.to_owned()),
            path: None,
            git_shell: None,
            git_aslr_override: None,
            git_aslr_undoable: None,
        }
    }

    fn is_present(&self) -> bool {
        matches!(self, Presence::Present { .. })
    }

    fn version(&self) -> Option<&str> {
        match self {
            Presence::Present { version, .. } => version.as_deref(),
            _ => None,
        }
    }
}

/// `SetupFailure`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<Option<i32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Failure {
    fn new(reason: &'static str, detail: Option<String>) -> Failure {
        Failure {
            reason,
            exit_code: None,
            detail,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct DownloadProgress {
    pub received: u64,
    pub total: Option<u64>,
}

/// `SetupProgress`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub step: usize,
    pub steps: usize,
    pub started_at: u64,
    pub download: Option<DownloadProgress>,
}

/// `SetupItemState`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: &'static str,
    pub required: bool,
    pub phase: &'static str,
    pub presence: Option<Presence>,
    pub method: Option<&'static str>,
    pub command: Option<String>,
    pub location: Option<String>,
    pub prompt: Option<&'static str>,
    pub progress: Option<Progress>,
    pub output: String,
    pub failure: Option<Failure>,
    pub manual_commands: Vec<String>,
    pub manual_url: &'static str,
}

/// An installer run, as the runner does it: what a test puts in its place.
pub type RunFn = Rc<dyn Fn(Ctx, SpawnSpec, Env, Rc<dyn Fn(&str)>) -> LocalFuture<Ran>>;

/// What a test puts in place of the machine (`SetupServiceDeps`' seams); empty in production.
#[derive(Default, Clone)]
pub struct Seams {
    pub detect: Option<Rc<dyn Fn() -> LocalFuture<Detection>>>,
    pub run: Option<RunFn>,
    /// The registry's manifest of omp `version`, asked by `bun` in `env` (`ompRelease`).
    #[allow(clippy::type_complexity)]
    pub omp_release: Option<Rc<dyn Fn(String, String, Env) -> LocalFuture<Result<Value, String>>>>,
}

#[cfg(test)]
impl Seams {
    /// A machine with nothing on it whose installers never start: the other parts' tests run setup without touching
    /// this computer.
    pub fn offline() -> Seams {
        Seams {
            detect: Some(Rc::new(|| Box::pin(async { Detection::default() }))),
            run: Some(Rc::new(|_, _, _, _| {
                Box::pin(async {
                    Ran {
                        outcome: RunOutcome::Failed {
                            reason: FailedBy::Spawn,
                            exit_code: None,
                            detail: Some("no installer in this test".to_owned()),
                        },
                        output: String::new(),
                    }
                })
            })),
            omp_release: None,
        }
    }
}

pub struct Part {
    pub items: Vec<Item>,
    pub required_running: bool,
    detection: Option<Detection>,
    attempted: HashSet<&'static str>,
    /// The item whose attempt is in the ledger and has not ended yet.
    installing: Option<&'static str>,
    emit_armed: bool,
    /// The first detection used main's launch resolution of omp.
    launch_resolution_used: bool,
    pub seams: Seams,
}

impl Part {
    pub fn new(opts: &Opts) -> Part {
        Part {
            items: ITEMS
                .into_iter()
                .map(|id| {
                    let (manual_commands, manual_url) = plans::manual_steps(id, &opts.platform);
                    Item {
                        id,
                        required: required(id, &opts.platform),
                        phase: "checking",
                        presence: None,
                        method: None,
                        command: None,
                        location: None,
                        prompt: None,
                        progress: None,
                        output: String::new(),
                        failure: None,
                        manual_commands,
                        manual_url,
                    }
                })
                .collect(),
            required_running: false,
            detection: None,
            attempted: HashSet::new(),
            installing: None,
            emit_armed: false,
            launch_resolution_used: false,
            seams: Seams::default(),
        }
    }

    fn item(&mut self, id: &str) -> &mut Item {
        let at = ITEMS.iter().position(|item| *item == id).unwrap_or(0);
        &mut self.items[at]
    }
}

/// `SetupState`.
pub fn state(tools: &Tools) -> Value {
    let part = tools.setup.borrow();
    json!({
        "platform": tools.opts.platform,
        "automatic": tools.opts.automatic,
        "ompReady": part.items[2].presence.as_ref().is_some_and(Presence::is_present),
        "requiredRunning": part.required_running,
        "items": part.items,
    })
}

/// JSON as `JSON.stringify(value, null, "\t")` writes it.
pub(crate) fn tabbed(value: &Value) -> String {
    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    let _ = value.serialize(&mut serializer);
    String::from_utf8(out).unwrap_or_default()
}

// ---- the state and what it tells main ----------------------------------------------------------------------------

fn with_item<T>(tools: &Tools, id: &str, change: impl FnOnce(&mut Item) -> T) -> T {
    change(tools.setup.borrow_mut().item(id))
}

fn phase(tools: &Tools, id: &str) -> &'static str {
    with_item(tools, id, |item| item.phase)
}

fn presence(tools: &Tools, id: &str) -> Option<Presence> {
    with_item(tools, id, |item| item.presence.clone())
}

fn emit(tools: &Tools) {
    tools.setup.borrow_mut().emit_armed = false;
    tools.changed("setup");
}

/// A push within [`EMIT_EVERY`] (output and download progress), unless one is due already.
fn emit_soon(tools: &Rc<Tools>) {
    if std::mem::replace(&mut tools.setup.borrow_mut().emit_armed, true) {
        return;
    }
    let weak = Rc::downgrade(tools);
    tools.spawn_task(async move {
        tokio::time::sleep(EMIT_EVERY).await;
        if let Some(tools) = weak.upgrade()
            && tools.setup.borrow().emit_armed
        {
            emit(&tools);
        }
    });
}

fn fail(tools: &Tools, id: &str, failure: Failure) {
    with_item(tools, id, |item| {
        item.phase = "failed";
        item.failure = Some(failure);
    });
    emit(tools);
}

fn now(tools: &Tools) -> u64 {
    tools.clock.now_ms()
}

fn ledger(tools: &Tools) -> (String, String) {
    (
        paths::host_join(&[&tools.opts.user_data, "setup-state.json"]),
        tools.opts.app_version.clone(),
    )
}

fn with_ledger<T>(tools: &Tools, read: impl FnOnce(&Ledger<'_>) -> T) -> T {
    let (file, app) = ledger(tools);
    read(&Ledger {
        file: &file,
        app: &app,
    })
}

/// `#mayAttempt`: once per launch; daily after three misses.
fn may_attempt(tools: &Tools, id: &'static str) -> bool {
    if tools.setup.borrow().attempted.contains(id) {
        return false;
    }
    with_ledger(tools, |ledger| ledger.allows(id, now(tools)))
}

/// `#uncountRunning`: a stop the person asked for (Cancel, quitting) says nothing about the machine.
fn uncount_running(tools: &Tools) {
    let Some(id) = tools.setup.borrow_mut().installing.take() else {
        return;
    };
    with_ledger(tools, |ledger| ledger.uncount(id));
}

/// The quit: the attempt that runs is taken back out of the ledger (`dispose`).
pub fn closing(tools: &Tools) {
    uncount_running(tools);
}

// ---- what runs ---------------------------------------------------------------------------------------------------

/// What an exec ended with: its code (none when it did not exit by itself or could not start), its output, and the
/// error text node's `execFile` would have given.
pub struct Exec {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
}

/// `execFile` of `file` with exactly `env`, ended after `timeout_ms`; a Windows shim (`shell`) through cmd.exe.
pub async fn exec(file: &str, args: &[String], shell: bool, env: &Env, timeout_ms: u64) -> Exec {
    let cwd = std::env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_owned());
    let mut command = crate::sidecar::omp_command(file, args, shell, &cwd, env);
    command.kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Exec {
                code: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some(format!("spawn {file} {error}")),
            };
        }
    };
    match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let code = output.status.code().or(Some(1));
            Exec {
                code,
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                error: (code != Some(0))
                    .then(|| format!("Command failed: {file} {}", args.join(" "))),
            }
        }
        Ok(Err(error)) => Exec {
            code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some(error.to_string()),
        },
        Err(_) => Exec {
            code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some(format!("Command failed: {file} {}", args.join(" "))),
        },
    }
}

/// `updateDetail`: the last lines of an installer's output without color codes.
pub fn update_detail(output: &str) -> Option<String> {
    let clean = crate::aimemory::service::text::without_csi(output);
    let lines: Vec<&str> = clean
        .split(['\r', '\n'])
        .map(crate::fs::order::js_trim)
        .filter(|line| !line.is_empty())
        .collect();
    let kept = lines[lines.len().saturating_sub(DETAIL_LINES)..].join("\n");
    (!kept.is_empty()).then_some(kept)
}

/// `OFFLINE_OUTPUT`: installer output that says the machine could not reach the internet.
fn offline(output: &str) -> bool {
    let lower = output.to_lowercase();
    [
        "enotfound",
        "eai_again",
        "etimedout",
        "econnrefused",
        "econnreset",
        "enetunreach",
        "connectionrefused",
        "connectionclosed",
        "failedtoopensocket",
        "getaddrinfo",
        "could not resolve host",
        "couldn't resolve host",
        "temporary failure in name resolution",
        "network is unreachable",
        "curl: (6)",
        "curl: (7)",
        "curl: (28)",
        "remote name could not be resolved",
        "unable to connect to the remote server",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// Runs `spec` under the supervisor (or the test's stand-in), registered with `ctx`'s stops.
async fn run(
    tools: &Rc<Tools>,
    ctx: &Ctx,
    spec: SpawnSpec,
    env: Env,
    output: Rc<dyn Fn(&str)>,
) -> Ran {
    let fake = tools.setup.borrow().seams.run.clone();
    match fake {
        Some(run) => run(ctx.clone(), spec, env, output).await,
        None => {
            tools
                .runner
                .run(ctx, &spec, &env, None, &mut |chunk| output(chunk))
                .await
        }
    }
}

fn target_platform(tools: &Tools) -> &'static str {
    if tools.opts.platform == "win32" {
        "win32"
    } else {
        "darwin"
    }
}

/// `#spec`: under the test installer every plan runs `<installer> <item> <method>`.
fn spec_for(tools: &Tools, spawn: SpawnSpec, id: &str, method: &str) -> SpawnSpec {
    match &tools.opts.test_installer {
        Some(installer) => spawn_spec(
            installer,
            &[id.to_owned(), method.to_owned()],
            target_platform(tools),
        ),
        None => spawn,
    }
}

/// `#installEnv`: main's spawn environment with the proxy, `BUN_INSTALL`, and on Windows no inherited `PSModulePath`.
async fn install_env(tools: &Rc<Tools>) -> Result<Env, Fault> {
    let mut env = tools.spawn_env().await?;
    env.insert("BUN_INSTALL".to_owned(), tools.opts.bun_install.clone());
    if tools.opts.platform == "win32" {
        env.retain(|key, _| !key.eq_ignore_ascii_case("PSModulePath"));
    }
    Ok(env)
}

/// `#updateEnv`: `omp update` and its `--check` for `omp`: its own folder first on PATH, its own Bun root, one PATH key.
async fn update_env(tools: &Rc<Tools>, omp: &str) -> Result<Env, Fault> {
    let mut env = install_env(tools).await?;
    let win = tools.opts.platform == "win32";
    let is_path = |key: &String| {
        if win {
            key.eq_ignore_ascii_case("PATH")
        } else {
            key == "PATH"
        }
    };
    let base = env
        .get("PATH")
        .filter(|path| !path.is_empty())
        .cloned()
        .or_else(|| {
            env.iter()
                .filter(|(key, _)| is_path(key))
                .map(|(_, value)| value.clone())
                .find(|value| !value.is_empty())
        })
        .unwrap_or_default();
    env.retain(|key, _| !is_path(key));
    let (path, root) = paths::omp_update_env(omp, &base, &tools.opts.bun_install);
    env.insert("PATH".to_owned(), path);
    if let Some(root) = root {
        env.insert("BUN_INSTALL".to_owned(), root);
    }
    Ok(env)
}

/// What the core's lookups and downloads are told beyond their request: a test's mirror, else the proxy it picks.
async fn lookup(tools: &Tools) -> (Option<String>, Option<String>) {
    if let Some(mirror) = &tools.opts.mirror {
        return (Some(mirror.clone()), None);
    }
    let system = async {
        tokio::task::spawn_blocking(|| ompdesk_sysproxy::resolve(crate::proxy::PROBE_URL))
            .await
            .ok()
    };
    let pick = crate::proxy::pick(
        &tools.pref("proxyUrl").unwrap_or(Value::Null),
        |name| std::env::var(name).ok(),
        system,
    )
    .await;
    (None, pick.url)
}

fn release_of(release: crate::setup::archives::ArchiveRelease) -> Release {
    Release {
        item: release.item.to_owned(),
        version: release.version,
        file: release.file,
        url: release.url,
        sha256: release.sha256,
    }
}

/// `#resolveManaged`: the release machine setup's verified archive install of `item` downloads.
async fn resolve_managed(tools: &Tools, item: &str) -> Result<Release, String> {
    use crate::setup::archives::{Platform, resolve_agent_desktop, resolve_archive};
    let (mirror, proxy) = lookup(tools).await;
    let pages = crate::setup::net::Http {
        mirror: mirror.as_deref(),
        token: None,
        proxy: proxy.as_deref(),
    };
    if item != "agent-desktop" {
        return resolve_archive(&pages, item, &tools.opts.arch)
            .await
            .map(release_of);
    }
    let platform = match tools.opts.platform.as_str() {
        "win32" => Platform::Win32,
        "darwin" => Platform::Darwin,
        _ => return Err("agent-desktop has no release for this platform".to_owned()),
    };
    resolve_agent_desktop(&pages, platform, &tools.opts.arch)
        .await
        .map(release_of)
}

async fn resolve_tailscale(tools: &Tools, method: &str) -> Result<Release, String> {
    use crate::setup::archives::Platform;
    let (mirror, proxy) = lookup(tools).await;
    let pages = crate::setup::net::Http {
        mirror: mirror.as_deref(),
        token: None,
        proxy: proxy.as_deref(),
    };
    let platform = if method == "tailscale-zip" {
        Platform::Darwin
    } else {
        Platform::Win32
    };
    let release = crate::setup::archives::resolve_tailscale(
        &pages,
        platform,
        plans::tailscale_msi_arch(&tools.opts.arch),
    )
    .await?;
    Ok(Release {
        item: "tailscale".to_owned(),
        version: release.version,
        file: release.file,
        url: release.url,
        sha256: release.sha256,
    })
}

/// A placeholder release for archive plans under the test installer, which never downloads it (`TEST_RELEASE`).
fn test_release(item: &str, file: &str) -> Release {
    Release {
        item: item.to_owned(),
        version: "0.0.0".to_owned(),
        file: file.to_owned(),
        url: "https://example.invalid/test".to_owned(),
        sha256: "0".repeat(64),
    }
}

/// `#testDownload`: the download every plan runs first under the test installer, if one is set.
fn test_download(tools: &Tools) -> Option<PlanDownload> {
    tools.opts.test_download.as_ref().map(|test| PlanDownload {
        url: test.url.clone(),
        sha256: test.sha256.clone(),
        file: paths::host_join(&[&tools.opts.tools_dir, ".downloads", "test-download"]),
    })
}

/// Removes a downloaded file when the install that used it ended, however it ended.
struct Downloaded(Option<String>);

impl Drop for Downloaded {
    fn drop(&mut self) {
        if let Some(file) = &self.0 {
            let _ = std::fs::remove_file(file);
        }
    }
}

/// A download the core runs itself, stopped with `ctx`; `progress(received, total)` hears its bytes.
async fn download(
    tools: &Tools,
    ctx: &Ctx,
    file: &PlanDownload,
    progress: &dyn Fn(u64, Option<u64>),
) -> Result<(), Fault> {
    let (mirror, proxy) = lookup(tools).await;
    let scope = Scope::detached();
    let running = Rc::new(std::cell::Cell::new(true));
    ctx.on_stop({
        let (scope, running) = (scope.clone(), Rc::clone(&running));
        move || {
            let live = running.replace(false);
            if live {
                scope.cancel();
            }
            live
        }
    });
    let done = crate::setup::download::fetch(
        &file.url,
        &file.sha256,
        &file.file,
        mirror.as_deref(),
        proxy.as_deref(),
        &scope,
        progress,
    )
    .await;
    // A cancel that came after the bytes were all in still ends nothing.
    let cancelled = !running.replace(false) || scope.cancelled();
    match done {
        Err(fault) if cancelled || fault.code == "cancelled" => Err(Fault::cancelled()),
        done => done,
    }
}

// ---- detection and the pipelines -------------------------------------------------------------------------------

/// `#detect`: every item again; a found item forgets its misses, a missing one not yet tried reads idle or backoff.
async fn detect(tools: &Rc<Tools>) {
    let fake = tools.setup.borrow().seams.detect.clone();
    let mut detection = match fake {
        Some(detect) => detect().await,
        None => detect::machine(tools).await,
    };
    if let Some(Presence::Present {
        path: Some(root),
        git_aslr_override: Some(true),
        git_aslr_undoable,
        ..
    }) = detection.presence.get_mut("git")
    {
        let record = git_aslr::read_record(&paths::host_join(&[
            &tools.opts.user_data,
            git_aslr::RECORD,
        ]));
        if !git_aslr::recorded_images(&record, root).is_empty() {
            *git_aslr_undoable = Some(true);
        }
    }
    let mut found = Vec::new();
    {
        let mut part = tools.setup.borrow_mut();
        for id in ITEMS {
            let presence = detection.presence(id);
            let item = part.item(id);
            if presence.is_present() {
                // An Xcode-tools request (or a Settings retry) that finished meanwhile.
                if item.phase != "running" {
                    item.phase = "present";
                    item.failure = None;
                }
                found.push(id);
            }
            item.presence = Some(presence);
        }
        part.detection = Some(detection);
    }
    for id in &found {
        with_ledger(tools, |ledger| ledger.clear(id));
    }
    for id in ITEMS {
        if phase(tools, id) == "checking" && !found.contains(&id) {
            let back_off = automatic(id) && tools.opts.automatic && !may_attempt(tools, id);
            with_item(tools, id, |item| {
                item.phase = if back_off { "backoff" } else { "idle" };
            });
        }
    }
    emit(tools);
}

fn required_items(tools: &Tools) -> Vec<&'static str> {
    ITEMS
        .into_iter()
        .filter(|id| required(id, &tools.opts.platform))
        .collect()
}

/// The optional items setup installs on its own; Tailscale waits for a click.
fn optional_items(tools: &Tools) -> Vec<&'static str> {
    ITEMS
        .into_iter()
        .filter(|id| !required(id, &tools.opts.platform) && automatic(id))
        .collect()
}

/// `#markQueued`.
fn mark_queued(tools: &Tools, items: &[&'static str], manual: bool) {
    for id in items {
        let skip = with_item(tools, id, |item| {
            item.presence.as_ref().is_some_and(Presence::is_present) || item.phase == "running"
        });
        if skip || (!manual && !may_attempt(tools, id)) {
            continue;
        }
        with_item(tools, id, |item| item.phase = "queued");
    }
    if items.iter().any(|id| required(id, &tools.opts.platform)) {
        tools.setup.borrow_mut().required_running = true;
    }
    emit(tools);
}

fn idle_queued(tools: &Tools, items: &[&'static str]) {
    for id in items {
        with_item(tools, id, |item| {
            if item.phase == "queued" {
                item.phase = "idle";
            }
        });
    }
}

fn omp_present_now(tools: &Tools) -> bool {
    presence(tools, "omp").is_some_and(|presence| presence.is_present())
}

/// `#runRequired`; `announce`: tell main omp became usable (an omp update's repair leaves that to the omp part).
async fn run_required(tools: &Rc<Tools>, ctx: &Ctx, manual: bool, announce: bool) {
    let was_ready = omp_present_now(tools);
    let items = required_items(tools);
    install_each(tools, ctx, &items, manual).await;
    tools.setup.borrow_mut().required_running = false;
    idle_queued(tools, &items);
    emit(tools);
    if announce && !was_ready && omp_present_now(tools) && !tools.is_closed() {
        let ready = tools.ask("ompReady", json!({}));
        tools.spawn_task(async move {
            let _ = ready.await;
        });
    }
}

/// `#runOptionalAfterRequired`: optional items install once omp works.
async fn run_optional_after_required(tools: &Rc<Tools>, ctx: &Ctx) {
    if !tools.opts.automatic || !omp_present_now(tools) {
        return;
    }
    let items = optional_items(tools);
    run_optional(tools, ctx, &items, false).await;
}

async fn run_optional(tools: &Rc<Tools>, ctx: &Ctx, items: &[&'static str], manual: bool) {
    install_each(tools, ctx, items, manual).await;
    idle_queued(tools, items);
    emit(tools);
}

/// `#installEach`: queue `items`, then install them in order; each knows its place among the queued ones.
async fn install_each(tools: &Rc<Tools>, ctx: &Ctx, items: &[&'static str], manual: bool) {
    mark_queued(tools, items, manual);
    let run: Vec<&str> = items
        .iter()
        .copied()
        .filter(|id| phase(tools, id) == "queued")
        .collect();
    for id in items {
        if ctx.cancelled() || tools.is_closed() {
            break;
        }
        let step = run
            .iter()
            .position(|queued| queued == id)
            .map_or(0, |at| at + 1);
        ensure(tools, ctx, id, manual, (step, run.len())).await;
    }
}

/// The ompNpm of a detected omp Bun does not manage (`#ompNpm`).
async fn omp_npm(tools: &Tools, detection: &Detection) -> Option<OmpNpm> {
    let omp = detection.omp.as_deref()?;
    if paths::omp_bun_root(omp).is_some() {
        return None;
    }
    plans::omp_npm_owner(
        omp,
        &tools.opts.platform,
        &tools.opts.tools_dir,
        &detection.path_env,
    )
    .await
}

/// `#planContext`: setup's own install is the omp this OMPdesk was tested with.
fn plan_context(tools: &Tools, detection: &Detection, omp_npm: Option<OmpNpm>) -> PlanContext {
    let opts = &tools.opts;
    PlanContext {
        platform: opts.platform.clone(),
        arch: opts.arch.clone(),
        bun_install: opts.bun_install.clone(),
        tools_dir: opts.tools_dir.clone(),
        bun: detection.bun.clone(),
        omp: detection.omp.clone(),
        omp_specs: plans::omp_install_specs(&opts.bun_install, &opts.tested_omp),
        omp_npm,
        omp_version: opts.tested_omp.clone(),
        brew: detection.brew.clone(),
        winget: detection.winget.clone(),
        system_root: opts.system_root.clone(),
    }
}

fn log_omp_install(tools: &Tools, step: &str, details: Value) {
    let mut details = details;
    details["path"] = json!("setup");
    let mut ordered = json!({"path": "setup"});
    if let (Some(ordered), Some(rest)) = (ordered.as_object_mut(), details.as_object()) {
        ordered.extend(rest.clone());
    }
    tools.log("omp-update", step, ordered);
}

/// `#ensure`: install `id` if it is missing and allowed to run now; a `bun upgrade` that failed is followed by Bun's
/// own installer as the same attempt.
async fn ensure(
    tools: &Rc<Tools>,
    ctx: &Ctx,
    id: &'static str,
    manual: bool,
    place: (usize, usize),
) {
    if ensure_once(tools, ctx, id, manual, place, None).await == Some("bun-upgrade")
        && phase(tools, id) == "failed"
        && !tools.is_closed()
    {
        ensure_once(tools, ctx, id, manual, place, Some("bun-script")).await;
    }
}

/// One attempt of `#ensure`; the method it ran.
async fn ensure_once(
    tools: &Rc<Tools>,
    ctx: &Ctx,
    id: &'static str,
    manual: bool,
    (step, steps): (usize, usize),
    fallback: Option<&'static str>,
) -> Option<&'static str> {
    let detection = tools.setup.borrow().detection.clone()?;
    let found = presence(tools, id).filter(|found| !found.is_present())?;
    if !manual && fallback.is_none() && !may_attempt(tools, id) {
        with_item(tools, id, |item| item.phase = "backoff");
        emit(tools);
        return None;
    }
    let npm = if id == "omp" {
        omp_npm(tools, &detection).await
    } else {
        None
    };
    let plan_ctx = plan_context(tools, &detection, npm);
    if ctx.cancelled() || tools.is_closed() {
        return None;
    }
    let Some(method) = fallback.or_else(|| plans::select_method(id, &found, &plan_ctx)) else {
        with_item(tools, id, |item| {
            item.phase = "unavailable";
            item.method = None;
        });
        emit(tools);
        return None;
    };
    with_item(tools, id, |item| item.method = Some(method));
    let test = tools.opts.test_installer.is_some();
    let mut release = None;
    if (method == "archive" && (id == "gh" || id == "node"))
        || (method == "agent-desktop-archive" && id == "agent-desktop")
    {
        release = Some(if test {
            test_release(id, "test")
        } else {
            match resolve_managed(tools, id).await {
                Ok(release) => release,
                Err(detail) => {
                    fail(tools, id, Failure::new("download", Some(detail)));
                    return Some(method);
                }
            }
        });
    }
    let mut tailscale = None;
    if method == "tailscale-zip" || method == "tailscale-msi" {
        tailscale = Some(if test {
            let file = if method == "tailscale-zip" {
                "test.zip"
            } else {
                "test.msi"
            };
            test_release("tailscale", file)
        } else {
            match resolve_tailscale(tools, method).await {
                Ok(release) => release,
                Err(detail) => {
                    fail(tools, id, Failure::new("download", Some(detail)));
                    return Some(method);
                }
            }
        });
    }
    let Some(plan) = plans::build_plan(id, method, &plan_ctx, release.as_ref(), tailscale.as_ref())
    else {
        // Only omp has a prerequisite (Bun). Without Bun omp stays as it is: nothing else installs a named version.
        if id == "omp" {
            log_omp_install(
                tools,
                "skipped",
                json!({"method": method, "reason": "no-bun"}),
            );
        }
        fail(
            tools,
            id,
            Failure::new("prerequisite", Some("bun".to_owned())),
        );
        return Some(method);
    };
    let fetched = if test {
        test_download(tools)
    } else {
        plan.download.clone()
    };
    let started_at = now(tools);
    with_item(tools, id, |item| {
        item.command = Some(plan.command.clone());
        item.location = Some(plan.location.clone());
        item.prompt = plan.prompt;
        item.output.clear();
        item.failure = None;
        item.phase = "running";
        item.progress = Some(Progress {
            step,
            steps,
            started_at,
            download: fetched.as_ref().map(|_| DownloadProgress {
                received: 0,
                total: None,
            }),
        });
    });
    // Tailscale is only ever installed on the person's click: no once-per-launch rule, no back-off ledger.
    if automatic(id) && fallback.is_none() {
        tools.setup.borrow_mut().attempted.insert(id);
        with_ledger(tools, |ledger| ledger.record(id, started_at));
    }
    tools.setup.borrow_mut().installing = Some(id);
    emit(tools);
    let _remove = Downloaded(fetched.as_ref().map(|file| file.file.clone()));
    let omp_target = (id == "omp").then(|| json!({"method": method, "command": plan.command}));
    let install = async {
        if let Some(file) = &fetched
            && !fetch(tools, ctx, id, file).await
        {
            return None;
        }
        let env = match install_env(tools).await {
            Ok(env) => env,
            Err(fault) => {
                fail(tools, id, Failure::new("spawn", Some(fault.message)));
                return None;
            }
        };
        if let Some(target) = &omp_target {
            log_omp_install(tools, "started", target.clone());
        }
        let output: Rc<dyn Fn(&str)> = {
            let tools = Rc::clone(tools);
            Rc::new(move |chunk: &str| {
                with_item(&tools, id, |item| push_tail(&mut item.output, chunk));
                emit_soon(&tools);
            })
        };
        let ran = run(
            tools,
            ctx,
            spec_for(tools, plan.spawn.clone(), id, method),
            env,
            output,
        )
        .await;
        with_item(tools, id, |item| item.progress = None);
        Some(ran.outcome)
    };
    let outcome = if method == "bun-global" {
        with_compiled_launcher_aside(tools, install).await
    } else {
        install.await
    };
    if let Some(outcome) = outcome {
        settle(tools, ctx, id, outcome).await;
        if let Some(target) = omp_target {
            let presence = presence(tools, id);
            let mut details = target;
            match presence {
                Some(Presence::Present { version, .. }) => {
                    details["version"] = json!(version);
                    log_omp_install(tools, "finished", details);
                }
                _ => {
                    let reason =
                        with_item(tools, id, |item| item.failure.as_ref().map(|f| f.reason));
                    details["reason"] = json!(reason.unwrap_or("failed"));
                    log_omp_install(tools, "failed", details);
                }
            }
        }
    }
    tools.setup.borrow_mut().installing = None;
    with_item(tools, id, |item| item.progress = None);
    Some(method)
}

/// Stock's compiled omp in the place of Bun's launcher, moved aside while `bun install -g` links the package's own and
/// put back unless the install succeeded (`withCompiledLauncherAside`). The settle runs however the step ends: a
/// dropped step settles before the next one starts.
async fn with_compiled_launcher_aside(
    tools: &Tools,
    install: impl Future<Output = Option<RunOutcome>>,
) -> Option<RunOutcome> {
    struct Aside {
        bun_install: std::path::PathBuf,
        windows: bool,
        now: i64,
        nonce: u64,
        moved: bool,
        installed: bool,
    }
    impl Drop for Aside {
        fn drop(&mut self) {
            if self.moved {
                crate::setup::launcher::settle(
                    &self.bun_install,
                    self.windows,
                    self.now,
                    self.nonce,
                    self.installed,
                );
            }
        }
    }
    let mut nonce = [0u8; 8];
    let _ = crate::sys::random(&mut nonce[..6]);
    let mut aside = Aside {
        bun_install: std::path::absolute(&tools.opts.bun_install)
            .unwrap_or_else(|_| tools.opts.bun_install.clone().into()),
        windows: tools.opts.platform == "win32",
        now: now(tools) as i64,
        nonce: u64::from_le_bytes(nonce),
        moved: false,
        installed: false,
    };
    aside.moved = crate::setup::launcher::set_aside(
        &aside.bun_install,
        aside.windows,
        aside.now,
        aside.nonce,
    );
    let outcome = install.await;
    aside.installed = outcome == Some(RunOutcome::Succeeded);
    outcome
}

/// `#fetch`: the plan's file, downloaded with byte progress; false when it failed or was cancelled (already said).
async fn fetch(tools: &Rc<Tools>, ctx: &Ctx, id: &'static str, file: &PlanDownload) -> bool {
    let progress = |received, total| {
        with_item(tools, id, |item| {
            if let Some(progress) = &mut item.progress {
                progress.download = Some(DownloadProgress { received, total });
            }
        });
        emit_soon(tools);
    };
    match download(tools, ctx, file, &progress).await {
        Ok(()) => {
            with_item(tools, id, |item| {
                if let Some(progress) = &mut item.progress {
                    progress.download = None;
                }
            });
            emit(tools);
            true
        }
        Err(fault) => {
            with_item(tools, id, |item| item.progress = None);
            if fault.code == "cancelled" {
                uncount_running(tools);
                with_item(tools, id, |item| {
                    item.phase = "cancelled";
                    item.failure = None;
                });
                emit(tools);
            } else {
                let reason = if fault.code == "checksum" {
                    "checksum"
                } else {
                    "download"
                };
                fail(tools, id, Failure::new(reason, Some(fault.message)));
            }
            false
        }
    }
}

/// `#settle`: how an installer ended, as the item's phase.
async fn settle(tools: &Rc<Tools>, _ctx: &Ctx, id: &'static str, outcome: RunOutcome) {
    match outcome {
        RunOutcome::Cancelled => {
            uncount_running(tools);
            with_item(tools, id, |item| {
                item.phase = "cancelled";
                item.failure = None;
            });
            emit(tools);
        }
        RunOutcome::Failed {
            reason,
            exit_code,
            detail,
        } => {
            let output = with_item(tools, id, |item| item.output.clone());
            let checksum = output.contains("SHA-256 mismatch") || output.contains(": FAILED");
            let reason = if checksum {
                "checksum"
            } else if reason == FailedBy::Exit && offline(&output) {
                "network"
            } else if reason == FailedBy::Exit {
                "exit"
            } else {
                "spawn"
            };
            fail(
                tools,
                id,
                Failure {
                    reason,
                    exit_code: Some(exit_code),
                    detail: detail.filter(|detail| !detail.is_empty()),
                },
            );
        }
        RunOutcome::Succeeded => {
            refresh_path(tools).await;
            with_item(tools, id, |item| item.phase = "checking");
            detect(tools).await;
            if presence(tools, id).is_some_and(|presence| presence.is_present()) {
                return;
            }
            if with_item(tools, id, |item| item.method) == Some("xcode-select") {
                // macOS took over with its own dialog; the next check (launch or retry) sees the result.
                with_item(tools, id, |item| item.phase = "requested");
                emit(tools);
                return;
            }
            fail(tools, id, Failure::new("not-detected", None));
        }
    }
}

async fn refresh_path(tools: &Tools) {
    let _ = tools.ask("refreshPath", json!({})).await;
}

// ---- the calls ----------------------------------------------------------------------------------------------------

/// `start`: detect, then (when automatic) install the required items; once main's first tab is ready (or its grace
/// passed), the optional ones. Ends when that first pass ended, the updaters' cue.
pub async fn start(tools: &Rc<Tools>) {
    let installs = tools.opts.automatic && tools.opts.platform != "other";
    let first = tools.enqueue("machine setup", StepKind::Detect, {
        let tools = Rc::clone(tools);
        move |ctx| {
            Box::pin(async move {
                detect(&tools).await;
                if installs {
                    run_required(&tools, &ctx, false, true).await;
                }
                Ok(Value::Null)
            })
        }
    });
    let Ok(first) = first else { return };
    let _ = first.await;
    if !installs || tools.is_closed() {
        return;
    }
    let _ = tools.ask("firstTab", json!({})).await;
    let optional = tools.enqueue("optional installs", StepKind::Install, {
        let tools = Rc::clone(tools);
        move |ctx| {
            Box::pin(async move {
                run_optional_after_required(&tools, &ctx).await;
                Ok(Value::Null)
            })
        }
    });
    if let Ok(optional) = optional {
        let _ = optional.await;
    }
}

#[derive(Deserialize)]
struct ItemParams {
    #[serde(default)]
    item: Value,
}

#[derive(Deserialize)]
struct AslrParams {
    #[serde(default)]
    action: Value,
}

fn setup_item(item: &Value) -> Option<&'static str> {
    let item = item.as_str()?;
    ITEMS.into_iter().find(|known| *known == item)
}

/// `retry`: a required item retries every missing required item in order, then the optional pass.
fn retry(
    tools: &Rc<Tools>,
    item: &'static str,
) -> Result<LocalFuture<Result<Value, Fault>>, Fault> {
    let is_required = required(item, &tools.opts.platform);
    if is_required {
        mark_queued(tools, &required_items(tools), true);
    } else {
        mark_queued(tools, &[item], true);
    }
    let tools = Rc::clone(tools);
    let enqueue = Rc::clone(&tools);
    enqueue.enqueue("retry", StepKind::Install, move |ctx| {
        Box::pin(async move {
            detect(&tools).await;
            if is_required {
                run_required(&tools, &ctx, true, true).await;
                run_optional_after_required(&tools, &ctx).await;
            } else {
                run_optional(&tools, &ctx, &[item], true).await;
            }
            Ok(Value::Null)
        })
    })
}

/// `installForConnection`: a connection the person started needs optional `item` (gh, Tailscale): detected again and,
/// when missing, installed now past the back-off; answers the item's state once that attempt ended. Without automatic
/// setup it only detects.
fn install_for_connection(
    tools: &Rc<Tools>,
    item: &'static str,
) -> Result<LocalFuture<Result<Value, Fault>>, Fault> {
    let install = tools.opts.automatic && tools.opts.platform != "other";
    if install {
        mark_queued(tools, &[item], true);
    }
    let tools = Rc::clone(tools);
    let enqueue = Rc::clone(&tools);
    enqueue.enqueue("install for a connection", StepKind::Install, move |ctx| {
        Box::pin(async move {
            detect(&tools).await;
            if install {
                run_optional(&tools, &ctx, &[item], true).await;
            }
            serde_json::to_value(with_item(&tools, item, |item| item.clone()))
                .map_err(|error| Fault::new("internal", error.to_string()))
        })
    })
}

pub fn call(tools: &Rc<Tools>, method: &str, args: &RawValue) -> Option<Outcome> {
    Some(match method {
        "cancel" => Outcome::ok(&tools.queue.cancel()),
        "retry" => {
            let item = match params::<ItemParams>(args) {
                Ok(params) => params.item,
                Err(fault) => return Some(Outcome::Now(Err(fault))),
            };
            let Some(id) = setup_item(&item) else {
                return Some(Outcome::fault(
                    "setup_item",
                    format!("Unknown setup item: {}", string_of_value(&item)),
                ));
            };
            if tools.opts.platform == "other" {
                return Some(Outcome::fault(
                    "setup_item",
                    "Setup is not available on this platform",
                ));
            }
            queued(retry(tools, id))
        }
        "installForConnection" => {
            let item = match params::<ItemParams>(args) {
                Ok(params) => params.item,
                Err(fault) => return Some(Outcome::Now(Err(fault))),
            };
            match setup_item(&item).filter(|item| !required(item, &tools.opts.platform)) {
                Some(id) => queued(install_for_connection(tools, id)),
                None => Outcome::Now(Err(Fault::new(
                    "setup_item",
                    format!("Not an optional setup item: {}", string_of_value(&item)),
                ))),
            }
        }
        "gitAslr" => {
            let action = match params::<AslrParams>(args) {
                Ok(params) => params.action,
                Err(fault) => return Some(Outcome::Now(Err(fault))),
            };
            let Some(action) = action.as_str().filter(|a| *a == "fix" || *a == "undo") else {
                return Some(Outcome::fault(
                    "setup_item",
                    format!("Unknown Git ASLR action: {}", string_of_value(&action)),
                ));
            };
            let action = if action == "fix" { "fix" } else { "undo" };
            let step = {
                let tools = Rc::clone(tools);
                tools
                    .clone()
                    .enqueue("Git ASLR override", StepKind::Install, move |ctx| {
                        Box::pin(async move { Ok(git_aslr_step(&tools, &ctx, action).await) })
                    })
            };
            match step {
                // A refused or stopped step answers as the action's failure, as the TypeScript's `.catch` did.
                Ok(answer) => Outcome::Later(Box::pin(async move {
                    Ok(answer
                        .await
                        .unwrap_or_else(|fault| json!({"ok": false, "detail": fault.message})))
                })),
                Err(fault) => Outcome::ok(&json!({"ok": false, "detail": fault.message})),
            }
        }
        _ => return None,
    })
}

/// `gitAslr`: one elevated step for the MSYS executables of the Git detected, then a fresh detection.
async fn git_aslr_step(tools: &Rc<Tools>, ctx: &Ctx, action: &'static str) -> Value {
    let root = match presence(tools, "git") {
        Some(Presence::Present {
            path: Some(root), ..
        }) if tools.opts.platform == "win32" => root,
        _ => return json!({"ok": false, "detail": "Git for Windows was not found"}),
    };
    let dir = tools.opts.user_data.clone();
    let record_file = paths::host_join(&[&dir, git_aslr::RECORD]);
    let input = paths::host_join(&[&dir, "git-aslr-in.json"]);
    let output_file = paths::host_join(&[&dir, "git-aslr-out.json"]);
    let recorded = git_aslr::recorded_images(&git_aslr::read_record(&record_file), &root);
    if action == "undo" {
        if recorded.is_empty() {
            return json!({"ok": false, "detail": "No record of what Fix changed, so there is nothing to undo exactly"});
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let written = options.open(&input).and_then(|mut file| {
            std::io::Write::write_all(&mut file, git_aslr::undo_input(&recorded).as_bytes())
        });
        if let Err(error) = written {
            return json!({"ok": false, "detail": error.to_string()});
        }
    }
    let _ = std::fs::remove_file(&output_file);
    let env = match tools.spawn_env().await {
        Ok(env) => env,
        Err(fault) => return json!({"ok": false, "detail": fault.message}),
    };
    let tail = Rc::new(RefCell::new(String::new()));
    let output: Rc<dyn Fn(&str)> = {
        let tail = Rc::clone(&tail);
        Rc::new(move |chunk: &str| push_tail(&mut tail.borrow_mut(), chunk))
    };
    let spec = git_aslr::spawn(&tools.opts.system_root, &root, action, &input, &output_file);
    let ran = run(tools, ctx, spec, env, output).await;
    // Read even after a failure: the step writes its output after every image it changed.
    let written = std::fs::read_to_string(&output_file).unwrap_or_default();
    let _ = std::fs::remove_file(&output_file);
    let _ = std::fs::remove_file(&input);
    let record = git_aslr::read_record(&record_file);
    let (record, images) = if action == "fix" {
        let fixed = git_aslr::parse_fix_output(&written);
        let images: Vec<String> = fixed.iter().map(|image| image.path.clone()).collect();
        (git_aslr::with_fixed(&record, &root, &fixed), images)
    } else {
        let restored = git_aslr::parse_undo_output(&written);
        (git_aslr::with_restored(&record, &root, &restored), restored)
    };
    let _ = git_aslr::write_record(&record_file, &record);
    let kind = match &ran.outcome {
        RunOutcome::Succeeded => "succeeded",
        RunOutcome::Cancelled => "cancelled",
        RunOutcome::Failed { .. } => "failed",
    };
    let detail = update_detail(&tail.borrow());
    tools.log(
        "setup",
        &format!("Git Mandatory ASLR override {action}: {kind}"),
        json!({
            "level": if kind == "succeeded" { "info" } else { "warn" },
            "root": root,
            "action": action,
            "outcome": kind,
            "images": images,
            "output": detail,
        }),
    );
    detect(tools).await;
    match ran.outcome {
        RunOutcome::Succeeded => json!({"ok": true, "images": images.len()}),
        RunOutcome::Failed { detail: failed, .. } => {
            json!({"ok": false, "detail": detail.or(failed).unwrap_or_default()})
        }
        RunOutcome::Cancelled => json!({"ok": false, "detail": detail.unwrap_or_default()}),
    }
}

// ---- the contract to the other parts -----------------------------------------------------------------------------

/// `OmpUpdateFailure` of `src/shared/omp-update.ts`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct OmpUpdateFailure {
    pub reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// How [`update_omp`] ended (`OmpUpdateOutcome`). `Skipped`: omp is missing, outdated or broken (the install pipeline
/// owns that), only a named version may be installed and none can be, or the app is quitting.
#[derive(Clone, Debug, PartialEq)]
pub enum OmpUpdateOutcome {
    /// The omp that runs now.
    Updated(String),
    /// `OmpUpdateFailure`: `{reason, detail?}`.
    Failed(Value),
    Skipped,
}

impl OmpUpdateOutcome {
    /// The TypeScript's `OmpUpdateOutcome` (`{kind, version}`, `{kind, failure}`, `{kind}`).
    pub fn to_json(&self) -> Value {
        match self {
            OmpUpdateOutcome::Updated(version) => json!({"kind": "updated", "version": version}),
            OmpUpdateOutcome::Failed(failure) => json!({"kind": "failed", "failure": failure}),
            OmpUpdateOutcome::Skipped => json!({"kind": "skipped"}),
        }
    }
}

fn omp_failed(reason: &'static str, detail: Option<String>) -> OmpUpdateOutcome {
    OmpUpdateOutcome::Failed(json!(OmpUpdateFailure { reason, detail }))
}

/// Runs just before the installer starts (the omp part stops what reads omp's files); awaited inside the step, as
/// `beforeInstall` ran inside setup's. Its failure does not stop the install.
pub type BeforeInstall = Box<dyn FnOnce() -> LocalFuture<Result<(), Fault>>>;

/// A short `omp …` run to its end ([`run_omp`]).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OmpRun {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// One vendor CLI update (`ToolUpdateRequest`).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUpdateRequest {
    /// The tool and its update method; the test installer is called `<installer> cli-<tool> <method> update`.
    pub tool: String,
    pub method: String,
    /// The owner's update command; none with `managed`.
    #[serde(default)]
    pub spawn: Option<SpawnSpec>,
    /// Machine setup's own archive of this item again: `gh`, `node` or `agent-desktop`.
    #[serde(default)]
    pub managed: Option<String>,
    /// Added to the installer's environment (`BUN_INSTALL`, `HOMEBREW_NO_AUTO_UPDATE`).
    #[serde(default)]
    pub env: Env,
}

/// How [`run_tool_update`] ended (`ToolUpdateOutcome`); `Skipped`: the app is quitting, or setup cannot run here.
#[derive(Clone, Debug, PartialEq)]
pub enum ToolUpdateOutcome {
    Succeeded,
    /// Why, when it says.
    Failed(Option<String>),
    Cancelled,
    Skipped,
}

impl ToolUpdateOutcome {
    /// The TypeScript's `ToolUpdateOutcome` (`{kind, detail?}`).
    pub fn to_json(&self) -> Value {
        match self {
            ToolUpdateOutcome::Succeeded => json!({"kind": "succeeded"}),
            ToolUpdateOutcome::Failed(Some(detail)) => json!({"kind": "failed", "detail": detail}),
            ToolUpdateOutcome::Failed(None) => json!({"kind": "failed"}),
            ToolUpdateOutcome::Cancelled => json!({"kind": "cancelled"}),
            ToolUpdateOutcome::Skipped => json!({"kind": "skipped"}),
        }
    }
}

/// The installed omp's version, as the omp part reads it (`installed`).
pub fn installed_omp(tools: &Tools) -> Option<String> {
    presence(tools, "omp").and_then(|presence| presence.version().map(str::to_owned))
}

/// Whether omp is found and new enough (BridgeHealth's repair asks before an omp update).
pub fn omp_present(tools: &Tools) -> bool {
    omp_present_now(tools)
}

/// One vendor CLI's update inline in the caller's step (`runToolUpdate`).
pub async fn run_tool_update(
    tools: &Rc<Tools>,
    ctx: &Ctx,
    request: ToolUpdateRequest,
) -> ToolUpdateOutcome {
    if tools.is_closed() || tools.opts.platform == "other" {
        return ToolUpdateOutcome::Skipped;
    }
    let (spawn, fetched) = if let Some(installer) = &tools.opts.test_installer {
        let args = [
            format!("cli-{}", request.tool),
            request.method.clone(),
            "update".to_owned(),
        ];
        (
            spawn_spec(installer, &args, target_platform(tools)),
            test_download(tools),
        )
    } else if let Some(spawn) = request.spawn.clone() {
        (spawn, None)
    } else if let Some(managed) = request.managed.as_deref() {
        if tools.setup.borrow().detection.is_none() {
            detect(tools).await;
        }
        let release = match resolve_managed(tools, managed).await {
            Ok(release) => release,
            Err(detail) => {
                return ToolUpdateOutcome::Failed(Some(detail));
            }
        };
        let method = if managed == "agent-desktop" {
            "agent-desktop-archive"
        } else {
            "archive"
        };
        let detection = tools.setup.borrow().detection.clone();
        let plan = detection.and_then(|detection| {
            plans::build_plan(
                managed,
                method,
                &plan_context(tools, &detection, None),
                Some(&release),
                None,
            )
        });
        let Some(plan) = plan else {
            return ToolUpdateOutcome::Failed(Some(format!("no {method} plan for {managed}")));
        };
        (plan.spawn, plan.download)
    } else {
        return ToolUpdateOutcome::Skipped;
    };
    let _remove = Downloaded(fetched.as_ref().map(|file| file.file.clone()));
    if let Some(file) = &fetched {
        match download(tools, ctx, file, &|_, _| {}).await {
            Ok(()) => {}
            Err(fault) if fault.code == "cancelled" => return ToolUpdateOutcome::Cancelled,
            Err(fault) => {
                return ToolUpdateOutcome::Failed(Some(fault.message));
            }
        }
    }
    let mut env = match install_env(tools).await {
        Ok(env) => env,
        Err(fault) => {
            return ToolUpdateOutcome::Failed(Some(fault.message));
        }
    };
    env.extend(request.env);
    let tail = Rc::new(RefCell::new(String::new()));
    let output: Rc<dyn Fn(&str)> = {
        let tail = Rc::clone(&tail);
        Rc::new(move |chunk: &str| push_tail(&mut tail.borrow_mut(), chunk))
    };
    match run(tools, ctx, spawn, env, output).await.outcome {
        RunOutcome::Succeeded => ToolUpdateOutcome::Succeeded,
        RunOutcome::Cancelled => ToolUpdateOutcome::Cancelled,
        RunOutcome::Failed {
            exit_code, detail, ..
        } => {
            let exit = exit_code.map(|code| format!("exit {code}"));
            let reason = update_detail(&tail.borrow()).or(detail);
            let joined = [exit, reason]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" — ");
            ToolUpdateOutcome::Failed((!joined.is_empty()).then_some(joined))
        }
    }
}

/// `#viewRelease`: the registry's manifest of `<omp>@<version>` (an exact version, or a major for its newest).
async fn view_release(tools: &Tools, bun: &str, version: &str, env: &Env) -> Result<Value, String> {
    let fake = tools.setup.borrow().seams.omp_release.clone();
    if let Some(view) = fake {
        return view(bun.to_owned(), version.to_owned(), env.clone()).await;
    }
    if tools.opts.test_installer.is_some() {
        return Ok(Value::Null);
    }
    let spec = format!("{}@{version}", plans::OMP_PACKAGE);
    let args = [
        "pm".to_owned(),
        "view".to_owned(),
        spec.clone(),
        "--json".to_owned(),
    ];
    let ran = exec(bun, &args, false, env, CHECK_TIMEOUT_MS).await;
    if ran.code != Some(0) {
        let said = if ran.stderr.is_empty() {
            &ran.stdout
        } else {
            &ran.stderr
        };
        return Err(update_detail(said)
            .or(ran.error)
            .unwrap_or_else(|| format!("bun pm view failed for {spec}")));
    }
    serde_json::from_str(&ran.stdout)
        .map_err(|_| format!("bun pm view printed no manifest for {spec}"))
}

/// `#readyForRelease`: what must hold before `target` is installed, or why it must not be: a release published only
/// as a standalone build is never installed, and a Bun below its `engines.bun` is upgraded first.
async fn ready_for_release(
    tools: &Rc<Tools>,
    ctx: &Ctx,
    target: &str,
    env: &Env,
    bun: Option<&str>,
) -> Option<OmpUpdateFailure> {
    let bun = bun?;
    let manifest = match view_release(tools, bun, target, env).await {
        Ok(manifest) => manifest,
        Err(message) => {
            return Some(OmpUpdateFailure {
                reason: "check",
                detail: Some(format!("omp {target}'s requirements: {message}")),
            });
        }
    };
    if manifest["omp"]["dist"] == "binary" {
        return Some(OmpUpdateFailure {
            reason: "install",
            detail: Some(format!(
                "omp {target} ships only as a standalone build, which OMPdesk cannot run"
            )),
        });
    }
    let minimum = paths::manifest_bun_minimum(&manifest)?;
    let meets = || match presence(tools, "bun") {
        Some(Presence::Present {
            version: Some(version),
            ..
        }) => !is_newer(&minimum, Some(&version)),
        _ => false,
    };
    if meets() {
        return None;
    }
    let version = presence(tools, "bun").and_then(|presence| presence.version().map(str::to_owned));
    with_item(tools, "bun", |item| {
        item.presence = Some(Presence::Outdated {
            version: version.unwrap_or_else(|| "unknown".to_owned()),
            minimum: minimum.clone(),
            path: Some(bun.to_owned()),
        });
    });
    ensure(tools, ctx, "bun", true, (1, 1)).await;
    if meets() {
        return None;
    }
    let failure = with_item(tools, "bun", |item| {
        update_detail(&item.output).or_else(|| item.failure.as_ref().and_then(|f| f.detail.clone()))
    });
    Some(OmpUpdateFailure {
        reason: "install",
        detail: Some(format!(
            "omp {target} needs Bun {minimum} or newer; Bun could not be upgraded to it{}",
            failure
                .map(|failure| format!(" — {failure}"))
                .unwrap_or_default()
        )),
    })
}

/// `updateOmp`: omp moved to `target` under the supervisor, inline in the caller's step. A package manager's omp is
/// installed as a package at exactly `target`; an omp neither Bun nor npm owns only by stock `omp update`, which picks
/// its own version, so only when not `exact_only`. `before_install` runs once omp is known present, just before the
/// installer starts. After it omp is detected again; an omp still older than `target` is a failure.
pub async fn update_omp(
    tools: &Rc<Tools>,
    ctx: &Ctx,
    target: &str,
    before: BeforeInstall,
    exact_only: bool,
) -> OmpUpdateOutcome {
    detect(tools).await;
    let detection = tools.setup.borrow().detection.clone();
    let skip = tools.opts.platform == "other"
        || tools.is_closed()
        || !omp_present_now(tools)
        || phase(tools, "omp") == "running";
    let Some(detection) = detection.filter(|_| !skip) else {
        return OmpUpdateOutcome::Skipped;
    };
    let Some(omp) = detection.omp.clone() else {
        return OmpUpdateOutcome::Skipped;
    };
    let npm = omp_npm(tools, &detection).await;
    let mut plan_ctx = plan_context(tools, &detection, npm);
    if tools.is_closed() {
        return OmpUpdateOutcome::Skipped;
    }
    let root = detection
        .bun
        .as_ref()
        .and_then(|_| paths::omp_bun_root(&omp));
    let has_npm = root.is_none() && plan_ctx.omp_npm.is_some();
    if root.is_none() && !has_npm && exact_only {
        return OmpUpdateOutcome::Skipped;
    }
    let method = if root.is_some() {
        "bun-global"
    } else if has_npm {
        "npm-global"
    } else {
        "omp-update"
    };
    match &root {
        Some(root) => {
            plan_ctx.bun_install = root.clone();
            plan_ctx.omp_specs = plans::omp_install_specs(root, target);
        }
        None => plan_ctx.omp_version = target.to_owned(),
    }
    let Some(plan) = plans::build_plan("omp", method, &plan_ctx, None, None) else {
        return OmpUpdateOutcome::Skipped;
    };
    let env = match update_env(tools, &omp).await {
        Ok(env) => env,
        Err(fault) => return omp_failed("install", Some(fault.message)),
    };
    if let Some(blocked) =
        ready_for_release(tools, ctx, target, &env, detection.bun.as_deref()).await
    {
        return OmpUpdateOutcome::Failed(json!(blocked));
    }
    let _ = before().await;
    let started_at = now(tools);
    with_item(tools, "omp", |item| {
        item.method = Some(method);
        item.command = Some(plan.command.clone());
        item.location = Some(plan.location.clone());
        item.prompt = None;
        item.output.clear();
        item.failure = None;
        item.phase = "running";
        item.progress = Some(Progress {
            step: 1,
            steps: 1,
            started_at,
            download: None,
        });
    });
    emit(tools);
    let output: Rc<dyn Fn(&str)> = {
        let tools = Rc::clone(tools);
        Rc::new(move |chunk: &str| {
            with_item(&tools, "omp", |item| push_tail(&mut item.output, chunk));
            emit_soon(&tools);
        })
    };
    let ran = run(
        tools,
        ctx,
        spec_for(tools, plan.spawn, "omp", method),
        env,
        output,
    )
    .await;
    with_item(tools, "omp", |item| {
        item.progress = None;
        item.phase = "checking";
    });
    refresh_path(tools).await;
    detect(tools).await;
    let reason = with_item(tools, "omp", |item| update_detail(&item.output));
    let detail = |parts: &[Option<String>]| {
        let joined = parts
            .iter()
            .flatten()
            .cloned()
            .collect::<Vec<_>>()
            .join(" — ");
        (!joined.is_empty()).then_some(joined)
    };
    if ran.outcome == RunOutcome::Cancelled {
        return omp_failed("cancelled", None);
    }
    // Stock's update can leave an omp OMPdesk cannot run (its launcher repair's compiled omp, a package that needs a
    // newer Bun): the package goes back (Bun first when it is too old) before any tab restarts on it.
    if !omp_present_now(tools) {
        Box::pin(run_required(tools, ctx, true, false)).await;
    }
    if let RunOutcome::Failed { exit_code, .. } = ran.outcome {
        let exit = exit_code.map(|code| format!("exit {code}"));
        return omp_failed("install", detail(&[exit, reason]));
    }
    match presence(tools, "omp") {
        Some(Presence::Present {
            version: Some(version),
            ..
        }) if !is_newer(target, Some(&version)) => OmpUpdateOutcome::Updated(version),
        Some(Presence::Present { .. }) => omp_failed("not-updated", detail(&[reason])),
        other => {
            let broken = match other {
                Some(Presence::Broken { detail, .. }) => Some(detail),
                _ => None,
            };
            omp_failed("unusable", detail(&[reason, broken]))
        }
    }
}

/// `newestOmpIn`: the newest omp release of `major` in the registry the update installs from; none when nothing here
/// can install a named version or the registry has none.
pub async fn newest_omp_in(tools: &Rc<Tools>, major: u64) -> Result<Option<String>, String> {
    let detection = tools.setup.borrow().detection.clone();
    let (Some(omp), Some(bun)) = (
        detection.as_ref().and_then(|d| d.omp.clone()),
        detection.as_ref().and_then(|d| d.bun.clone()),
    ) else {
        return Ok(None);
    };
    if !omp_present_now(tools) || paths::omp_bun_root(&omp).is_none() {
        return Ok(None);
    }
    let env = update_env(tools, &omp)
        .await
        .map_err(|fault| fault.message)?;
    let manifest = view_release(tools, &bun, &major.to_string(), &env).await?;
    Ok(manifest["version"]
        .as_str()
        .filter(|version| paths::major_of(version) == Some(major))
        .map(str::to_owned))
}

/// `latestOmp`: stock `omp update --check` on the detected omp, in the environment its update gets, so the check
/// follows the same registry, channel and install method; fails while omp is missing and with stock's own reason.
pub async fn latest_omp(tools: &Rc<Tools>) -> Result<String, String> {
    let detected = tools
        .setup
        .borrow()
        .detection
        .as_ref()
        .and_then(|detection| detection.omp.clone());
    let omp = detected
        .filter(|_| omp_present_now(tools))
        .ok_or_else(|| "omp is not installed".to_owned())?;
    let mut env = update_env(tools, &omp)
        .await
        .map_err(|fault| fault.message)?;
    env.insert("NO_COLOR".to_owned(), "1".to_owned());
    env.insert("FORCE_COLOR".to_owned(), "0".to_owned());
    let spec = spawn_spec(
        &omp,
        &["update".to_owned(), "--check".to_owned()],
        target_platform(tools),
    );
    let ran = exec(&spec.file, &spec.args, spec.shell, &env, CHECK_TIMEOUT_MS).await;
    let code = ran.code.unwrap_or(1);
    let output = if code == 0 {
        ran.stdout
    } else if !ran.stderr.is_empty() {
        ran.stderr
    } else if !ran.stdout.is_empty() {
        ran.stdout
    } else {
        ran.error.unwrap_or_default()
    };
    let parsed = (code == 0)
        .then(|| crate::omp::update_check_latest(&output))
        .flatten();
    parsed.ok_or_else(|| {
        update_detail(&output)
            .unwrap_or_else(|| format!("omp update --check exited with code {code}"))
    })
}

/// `omp <args>` on the detected omp (the takeover's `omp config get/set update.auto`), in its update's environment
/// with `NO_COLOR=1` and `FORCE_COLOR=0`, ended after `timeout`; why it could not run. Dropping the future ends it.
pub async fn run_omp(
    tools: &Rc<Tools>,
    args: &[&str],
    timeout: Duration,
) -> Result<OmpRun, String> {
    let detected = tools
        .setup
        .borrow()
        .detection
        .as_ref()
        .and_then(|detection| detection.omp.clone());
    let omp = detected
        .filter(|_| omp_present_now(tools))
        .ok_or_else(|| "omp is not installed".to_owned())?;
    let mut env = update_env(tools, &omp)
        .await
        .map_err(|fault| fault.message)?;
    env.insert("NO_COLOR".to_owned(), "1".to_owned());
    env.insert("FORCE_COLOR".to_owned(), "0".to_owned());
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    let spec = spawn_spec(&omp, &args, target_platform(tools));
    let ran = exec(
        &spec.file,
        &spec.args,
        spec.shell,
        &env,
        timeout.as_millis() as u64,
    )
    .await;
    match ran.code {
        Some(code) => Ok(OmpRun {
            code,
            stdout: ran.stdout,
            stderr: ran.stderr,
        }),
        None => Err(ran.error.unwrap_or_else(|| "omp did not run".to_owned())),
    }
}

/// `latestManaged`: the newest release of machine setup's verified archive of gh, Node or agent-desktop.
pub async fn latest_managed(tools: &Rc<Tools>, item: &str) -> Result<String, String> {
    resolve_managed(tools, item)
        .await
        .map(|release| release.version)
}
