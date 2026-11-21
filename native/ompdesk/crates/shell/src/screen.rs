//! `screen.cursorPoint` and `screen.changed`.

use std::cell::RefCell;

use serde_json::{Value, json};
use shell_core::desk_state::displays_change;

use crate::host::{self, Call};
use crate::system;

thread_local! {
    static LAST: RefCell<(Vec<Value>, i64)> = const { RefCell::new((Vec::new(), 0)) };
}

/// UI thread.
pub fn init() {
    LAST.with(|l| *l.borrow_mut() = system::displays());
}

/// Borrow the display facts on the UI thread, without asking the OS again.
pub fn with_displays<R>(read: impl FnOnce(&(Vec<Value>, i64)) -> R) -> R {
    LAST.with_borrow(read)
}

/// Pushes `screen.changed` when the display list moved. UI thread.
pub fn refresh() {
    let now = system::displays();
    if let Some(reason) = with_displays(|last| displays_change(last, &now)) {
        let data = json!({ "displays": now.0, "primaryDisplayId": now.1, "reason": reason });
        LAST.with(|last| last.replace(now));
        host::event("screen.changed", data);
    }
}

pub fn handle(call: Call) {
    match call.method.as_str() {
        "screen.cursorPoint" => match system::cursor_point() {
            Ok((x, y)) => call.ok(json!({ "x": x.round() as i64, "y": y.round() as i64 })),
            Err(message) => call.err("failed", message),
        },
        _ => call.unsupported(),
    }
}
