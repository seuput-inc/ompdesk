//! Machine setup's part (T2.2 ports `src/main/setup/service.ts` and `plans.ts`): `SetupState` and the calls
//! `setup.retry`, `setup.installForConnection`, `setup.cancel`. T2.1 holds the state's shape and the calls' checks;
//! the items and the install pipeline are T2.2's.

use std::collections::BTreeMap;
use std::path::Path;
use std::rc::Rc;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::queue::{Ctx, StepKind};
use super::runner::{RunOutcome, SpawnSpec};
use super::spawn::spawn_spec;
use super::{Tools, queued, unported};
use crate::control::js::string_of_value;
use crate::hub::{Outcome, params};
use crate::server::Fault;

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

#[derive(Default)]
pub struct Part {
    /// `SetupItemState` of each item, in `ITEMS` order (T2.2 types them).
    pub items: Vec<Value>,
    pub required_running: bool,
}

/// `SetupState`.
pub fn state(tools: &Tools) -> Value {
    let part = tools.setup.borrow();
    let omp_ready = part
        .items
        .iter()
        .any(|item| item["id"] == "omp" && item["presence"]["kind"] == "present");
    json!({
        "platform": tools.opts.platform,
        "automatic": tools.opts.automatic,
        "ompReady": omp_ready,
        "requiredRunning": part.required_running,
        "items": part.items,
    })
}

#[derive(Deserialize)]
struct ItemParams {
    #[serde(default)]
    item: Value,
}

fn setup_item(item: &Value) -> Option<&str> {
    item.as_str().filter(|item| ITEMS.contains(item))
}

pub fn call(tools: &Rc<Tools>, method: &str, args: &RawValue) -> Option<Outcome> {
    Some(match method {
        "cancel" => Outcome::ok(&tools.queue.cancel()),
        "retry" => {
            let item = match params::<ItemParams>(args) {
                Ok(params) => params.item,
                Err(fault) => return Some(Outcome::Now(Err(fault))),
            };
            if setup_item(&item).is_none() {
                return Some(Outcome::fault(
                    "setup_item",
                    format!("Unknown setup item: {}", string_of_value(&item)),
                ));
            }
            if tools.opts.platform == "other" {
                return Some(Outcome::fault(
                    "setup_item",
                    "Setup is not available on this platform",
                ));
            }
            queued(tools.enqueue("retry", StepKind::Install, unported))
        }
        "installForConnection" => {
            let item = match params::<ItemParams>(args) {
                Ok(params) => params.item,
                Err(fault) => return Some(Outcome::Now(Err(fault))),
            };
            match setup_item(&item).filter(|item| !required(item, &tools.opts.platform)) {
                Some(_) => {
                    queued(tools.enqueue("install for a connection", StepKind::Install, unported))
                }
                None => Outcome::Now(Err(Fault::new(
                    "setup_item",
                    format!("Not an optional setup item: {}", string_of_value(&item)),
                ))),
            }
        }
        _ => return None,
    })
}

// ---- What the updaters ask of setup (T2.4's stand-ins; T2.2 replaces their bodies) ---------------------------------

/// One vendor CLI's update (`ToolUpdateRequest` of `setup/service.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolUpdateRequest {
    /// The tool and its update method; the test installer is called `<installer> cli-<tool> <method> update`.
    pub tool: String,
    pub method: String,
    /// The owner's update command; none with `managed`.
    pub spawn: Option<SpawnSpec>,
    /// Machine setup's own archive of this item again (the copy in the managed tools dir).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed: Option<String>,
    /// Added to the installer environment (`BUN_INSTALL`, `HOMEBREW_NO_AUTO_UPDATE`).
    pub env: BTreeMap<String, String>,
}

/// `ToolUpdateOutcome`: `skipped` when the hub is closing or setup cannot run here.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolUpdateOutcome {
    Succeeded,
    Failed {
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    Cancelled,
    Skipped,
}

/// `runToolUpdate`, run inline in the caller's step (`ctx`), so whoever stops that step stops the installer. Stand-in:
/// the owner's command (or the test installer's `cli-<tool> <method> update`) under the supervisor; machine setup's
/// archive install of a managed copy is T2.2's and fails here.
pub async fn run_tool_update(
    tools: &Rc<Tools>,
    ctx: &Ctx,
    request: ToolUpdateRequest,
) -> ToolUpdateOutcome {
    let platform = tools.opts.platform.as_str();
    if tools.is_closed() || !matches!(platform, "darwin" | "win32") {
        return ToolUpdateOutcome::Skipped;
    }
    let spec = match (&tools.opts.test_installer, request.spawn) {
        (Some(installer), _) => spawn_spec(
            installer,
            &[
                format!("cli-{}", request.tool),
                request.method.clone(),
                "update".to_owned(),
            ],
            platform,
        ),
        (None, Some(spec)) => spec,
        (None, None) => {
            return ToolUpdateOutcome::Failed {
                detail: Some(format!("no archive install of {} here", request.tool)),
            };
        }
    };
    let mut env = match tools.spawn_env().await {
        Ok(env) => env,
        Err(fault) => {
            return ToolUpdateOutcome::Failed {
                detail: Some(fault.message),
            };
        }
    };
    env.extend(request.env);
    match tools
        .runner
        .run(ctx, &spec, &env, None, &mut |_| {})
        .await
        .outcome
    {
        RunOutcome::Succeeded => ToolUpdateOutcome::Succeeded,
        RunOutcome::Cancelled => ToolUpdateOutcome::Cancelled,
        RunOutcome::Failed { detail, .. } => ToolUpdateOutcome::Failed { detail },
    }
}

/// `latestManaged`: the newest release of machine setup's verified archive for gh, Node or agent-desktop. Stand-in:
/// the release lookup is T2.2's.
pub async fn latest_managed(_tools: &Rc<Tools>, item: &str) -> Result<String, String> {
    Err(format!("no release lookup of {item} here"))
}

/// `managedBinDirs`: the directories of the managed tools dir that belong on a spawned process's PATH.
pub(crate) fn managed_bin_dirs(tools_dir: &str, platform: &str) -> Vec<String> {
    let at = |parts: &[&str]| {
        parts
            .iter()
            .fold(Path::new(tools_dir).to_path_buf(), |path, part| {
                path.join(part)
            })
            .to_string_lossy()
            .into_owned()
    };
    if platform == "win32" {
        vec![at(&["git", "cmd"]), at(&["agent-desktop"])]
    } else {
        vec![
            at(&["node", "bin"]),
            at(&["gh", "bin"]),
            at(&["agent-desktop"]),
        ]
    }
}

/// `pickAgentDesktop`: the agent-desktop a session runs, `(path, version)`. Stand-in for T2.2's
/// `setup::desktop::pick_copy`: only the app's bundled copy (its `agent-desktop.build.json` version, the executable
/// beside it), which is all the CLI updater asks it (`managed` none).
pub(crate) async fn pick_copy(
    win32: bool,
    bundle_dir: Option<&Path>,
    _managed: Option<(String, String)>,
    _minimum: &str,
) -> Option<(String, String)> {
    let dir = bundle_dir?;
    let record: Value = serde_json::from_slice(
        &tokio::fs::read(dir.join("agent-desktop.build.json"))
            .await
            .ok()?,
    )
    .ok()?;
    let version = record["version"].as_str()?.to_owned();
    let path = dir.join(if win32 {
        "agent-desktop.exe"
    } else {
        "agent-desktop"
    });
    tokio::fs::metadata(&path).await.ok()?;
    Some((path.to_string_lossy().into_owned(), version))
}
