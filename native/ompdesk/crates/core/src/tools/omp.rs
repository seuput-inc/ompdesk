//! The omp updater's part (T2.3 ports `src/main/omp-updater.ts`, `omp-auto-takeover.ts`, `omp-compat-source.ts`
//! and `omp-hold-notice.ts`): `OmpUpdateState` and the call `omp.now`. A pass is one step of kind `OmpPass`, so a
//! second one asked meanwhile joins it; T2.1 holds the state's shape and the queuing, the pass is T2.3's.

use std::rc::Rc;

use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::queue::{Answer, StepKind};
use super::{Tools, queued, unported};
use crate::hub::{LocalFuture, Outcome};
use crate::server::Fault;

pub struct Part {
    /// Failed checks in a row: the timer's back-off.
    pub failures: u32,
    pub phase: &'static str,
    pub installed: Option<String>,
    pub latest: Option<String>,
    pub checked_at: Option<u64>,
    pub updated_to: Option<String>,
    /// `OmpUpdateFailure` (T2.3 types it).
    pub failure: Option<Value>,
    /// `OmpUpdateHold`, null while nothing is held.
    pub held: Option<Value>,
    pub stock_auto_taken: bool,
}

impl Default for Part {
    fn default() -> Part {
        Part {
            failures: 0,
            phase: "idle",
            installed: None,
            latest: None,
            checked_at: None,
            updated_to: None,
            failure: None,
            held: None,
            stock_auto_taken: false,
        }
    }
}

/// `OmpUpdateState`.
pub fn state(tools: &Tools) -> Value {
    let part = tools.omp.borrow();
    json!({
        "enabled": tools.auto_update(),
        "scheduled": tools.opts.scheduled.omp,
        "phase": part.phase,
        "installed": part.installed,
        "latest": part.latest,
        "checkedAt": part.checked_at,
        "updatedTo": part.updated_to,
        "failure": part.failure,
        "held": part.held,
        "stockAutoTaken": part.stock_auto_taken,
    })
}

/// A pass, queued (or joined to the one that runs or waits).
fn pass(tools: &Tools) -> Result<LocalFuture<Answer>, Fault> {
    tools.enqueue("omp update", StepKind::OmpPass, unported)
}

/// The timer's check.
pub fn tick(tools: &Rc<Tools>) -> Result<LocalFuture<Answer>, Fault> {
    pass(tools)
}

pub fn call(tools: &Rc<Tools>, method: &str, _: &RawValue) -> Option<Outcome> {
    match method {
        "now" => Some(queued(pass(tools))),
        _ => None,
    }
}
