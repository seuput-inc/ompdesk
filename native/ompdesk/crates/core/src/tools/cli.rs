//! The tool CLI updater's part (T2.4 ports `src/main/cli-tools/`): `CliUpdateState` and the call `cli.now {id?}`.
//! T2.1 holds the state's shape and the queuing; the rows and the pass are T2.4's.

use std::rc::Rc;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::queue::{Answer, StepKind};
use super::{Tools, queued, unported};
use crate::control::js::string_of_value;
use crate::hub::{LocalFuture, Outcome, params};
use crate::server::Fault;

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

#[derive(Default)]
pub struct Part {
    /// `CliToolState` of each installed tool, in `TOOLS` order (T2.4 types them).
    pub tools: Vec<Value>,
}

/// `CliUpdateState`.
pub fn state(tools: &Tools) -> Value {
    json!({
        "enabled": tools.auto_update(),
        "scheduled": tools.opts.scheduled.cli,
        "tools": tools.cli.borrow().tools,
    })
}

/// The timer's pass.
pub fn tick(tools: &Rc<Tools>) -> Result<LocalFuture<Answer>, Fault> {
    tools.enqueue("tool CLI update", StepKind::CliPass, unported)
}

#[derive(Deserialize)]
struct NowParams {
    #[serde(default)]
    id: Value,
}

pub fn call(tools: &Rc<Tools>, method: &str, args: &RawValue) -> Option<Outcome> {
    if method != "now" {
        return None;
    }
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
    Some(queued(tools.enqueue(
        "tool CLI update",
        StepKind::CliPass,
        unported,
    )))
}
