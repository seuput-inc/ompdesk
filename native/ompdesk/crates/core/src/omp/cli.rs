//! Shared supervisor for stock CLI actions. The caller supplies fixed arguments, never arguments from a request.

use std::collections::BTreeMap;
use std::fmt::Arguments;
use std::time::Duration;

use serde::Deserialize;
use tokio::io::AsyncReadExt;

use crate::fs::error::uv_code;
use crate::fs::order::js_trim;
use crate::run::{KILL_GRACE, terminate};
use crate::server::{Fault, Scope};
use crate::sidecar::omp_command;

#[derive(Deserialize)]
pub(super) struct Launch {
    pub bin: String,
    pub env: BTreeMap<String, String>,
    pub cwd: String,
}

pub(super) struct Output {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl Output {
    pub fn failure(&self, code: &'static str, command: Arguments<'_>) -> Fault {
        let bytes = if self.stderr.is_empty() {
            &self.stdout
        } else {
            &self.stderr
        };
        let text = String::from_utf8_lossy(bytes);
        let detail = js_trim(&text);
        let message = if detail.is_empty() {
            format!("omp {command} exited with code {}", self.code)
        } else {
            let start = detail.rmatch_indices('\n').nth(5).map_or(0, |(i, _)| i + 1);
            detail[start..].replace("\r\n", "\n")
        };
        Fault::new(code, message)
    }
}

pub(super) async fn run<const N: usize>(
    launch: &Launch,
    args: [&'static str; N],
    scope: Scope,
    timeout: Duration,
) -> Result<Output, Fault> {
    if scope.cancelled() {
        return Err(Fault::cancelled());
    }
    let Launch { bin, cwd, env } = launch;
    #[cfg(windows)]
    let shell = std::path::Path::new(bin)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));
    #[cfg(not(windows))]
    let shell = false;
    let mut cmd = if shell {
        let quoted = args.map(|arg| format!("\"{arg}\""));
        omp_command(&format!("\"{bin}\""), &quoted, true, cwd, env)
    } else {
        omp_command(bin, &args, false, cwd, env)
    };
    cmd.env("NO_COLOR", "1").env("FORCE_COLOR", "0");
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd
        .spawn()
        .map_err(|e| Fault::new("spawn_failed", format!("spawn {bin} {}", uv_code(&e))))?;
    drop(child.stdin.take());
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let mut out = Vec::new();
    let mut err = Vec::new();
    // Node waited for close, not just exit: a child of stock can still hold an output pipe.
    let finished = async {
        tokio::try_join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))?;
        child.wait().await
    };
    let fault = tokio::select! {
        status = finished => match status {
            Ok(status) => return Ok(Output { code: status.code().unwrap_or(1), stdout: out, stderr: err }),
            Err(e) => Fault::new("io_error", e.to_string()),
        },
        () = scope.on_cancel() => Fault::cancelled(),
        () = tokio::time::sleep(timeout) => Fault::new("omp_timeout", format!("omp {} timed out after {}ms", args[0], timeout.as_millis())),
    };
    terminate(&mut child);
    let cleanup = async move {
        if tokio::time::timeout(KILL_GRACE, child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    };
    if fault.code == "omp_timeout" {
        // A shim may ignore TERM or leave a descendant holding a pipe. Neither delays the timeout reply.
        tokio::spawn(cleanup);
    } else {
        cleanup.await;
    }
    Err(fault)
}
