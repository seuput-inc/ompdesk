mod feedback;
mod files;
mod log_tail;
mod reader;
mod recent;

use crate::host::Call;
use reader::Selection;
use serde_json::Value;
use std::path::Path;

pub(crate) use feedback::{FeedbackRead, feedback_profile};

pub(crate) fn previous_run_end(profile: &Path, own_pid: u32) -> Value {
    let profile = if profile.as_os_str().is_empty() {
        Path::new(".")
    } else {
        profile
    };
    log_tail::previous_run_end(files::open(profile, false), own_pid)
}

pub(crate) fn handle(call: Call, profile: &'static Path) {
    let read: fn(&Path) -> Vec<String> = match call.params.as_str() {
        Some("recent") => recent::read,
        Some("probes") => |profile| reader::lines(profile, Selection::Probes),
        _ => return call.err("invalid", "unknown diagnostic log selection"),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let lines = read(profile);
        call.ok(Value::Array(lines.into_iter().map(Value::String).collect()));
    });
}
