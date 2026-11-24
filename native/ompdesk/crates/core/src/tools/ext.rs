//! The extension updater's part (T2.5 ports `src/main/ext-update/`): `ExtensionUpdateState` and the call
//! `ext.now {key?}`. T2.1 holds the state's shape and the queuing; the rows and the pass are T2.5's.

use std::rc::Rc;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::queue::{Answer, StepKind};
use super::{Tools, queued, unported};
use crate::control::js::string_of_value;
use crate::hub::{LocalFuture, Outcome, params};
use crate::server::Fault;

#[derive(Default)]
pub struct Part {
    /// `ExtensionRow`s in display order (T2.5 types them); `key` is a row's only handle.
    pub rows: Vec<Value>,
}

/// `ExtensionUpdateState`.
pub fn state(tools: &Tools) -> Value {
    json!({
        "enabled": tools.auto_update(),
        "scheduled": tools.opts.scheduled.ext,
        "rows": tools.ext.borrow().rows,
    })
}

/// The timer's pass.
pub fn tick(tools: &Rc<Tools>) -> Result<LocalFuture<Answer>, Fault> {
    tools.enqueue("extension update", StepKind::ExtPass, unported)
}

#[derive(Deserialize)]
struct NowParams {
    #[serde(default)]
    key: Value,
}

pub fn call(tools: &Rc<Tools>, method: &str, args: &RawValue) -> Option<Outcome> {
    if method != "now" {
        return None;
    }
    let key = match params::<NowParams>(args) {
        Ok(params) => params.key,
        Err(fault) => return Some(Outcome::Now(Err(fault))),
    };
    // Only a row of the current state is a handle; anything else (a path, a command) never reaches the updater.
    let known = key.is_null()
        || key
            .as_str()
            .is_some_and(|key| tools.ext.borrow().rows.iter().any(|row| row["key"] == key));
    if !known {
        return Some(Outcome::fault(
            "extension_key",
            format!("Unknown extension: {}", string_of_value(&key)),
        ));
    }
    Some(queued(tools.enqueue(
        "extension update",
        StepKind::ExtPass,
        unported,
    )))
}
