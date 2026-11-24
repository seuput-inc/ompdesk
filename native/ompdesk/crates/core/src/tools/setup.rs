//! Machine setup's part (T2.2 ports `src/main/setup/service.ts` and `plans.ts`): `SetupState` and the calls
//! `setup.retry`, `setup.installForConnection`, `setup.cancel`. T2.1 holds the state's shape and the calls' checks;
//! the items and the install pipeline are T2.2's.

use std::rc::Rc;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::queue::StepKind;
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

/// `ToolUpdateRequest` of `setup/service.ts`: one tool's update (an updater's MCP binary or vendor CLI).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolUpdateRequest {
    /// The tool and its update method; the test installer is called `<installer> cli-<tool> <method> update`.
    pub tool: String,
    pub method: String,
    /// The owner's update command; none with `managed`.
    pub spawn: Option<super::runner::SpawnSpec>,
    /// Machine setup's own archive of this item again (`gh`, `node`, `agent-desktop`).
    pub managed: Option<String>,
    /// Added to the installer environment.
    pub env: std::collections::BTreeMap<String, String>,
}

/// `ToolUpdateOutcome` of `setup/service.ts`.
#[derive(Clone, Debug, PartialEq)]
pub enum ToolUpdateOutcome {
    Succeeded,
    Failed(Option<String>),
    Cancelled,
    Skipped,
}

/// `runToolUpdate`: the update under the supervisor, inline in the caller's step (its `ctx` stops the installer).
/// Stand-in until T2.2 writes it: it runs nothing.
pub async fn run_tool_update(
    _tools: &Rc<Tools>,
    _ctx: &super::queue::Ctx,
    _request: ToolUpdateRequest,
) -> ToolUpdateOutcome {
    ToolUpdateOutcome::Skipped
}
