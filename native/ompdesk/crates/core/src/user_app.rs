use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

use crate::server::Fault;

/// A user app must neither die with the core's job nor hold main's pipes open. If an outer job
/// forbids breakaway, fail rather than silently tying the app's lifetime to the core.
pub(crate) fn launch(command: &mut Command) -> Result<(), Fault> {
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    static PIPES_KEPT: std::sync::Once = std::sync::Once::new();
    PIPES_KEPT.call_once(crate::sys::stdio_not_inherited);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
        .map(drop)
        .map_err(|error| {
            Fault::new(
                "spawn_failed",
                format!(
                    "spawn {} {}",
                    command.get_program().to_string_lossy(),
                    crate::fs::error::uv_code(&error)
                ),
            )
        })
}
