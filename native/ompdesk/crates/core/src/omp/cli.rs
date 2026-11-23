//! Shared supervisor for fixed stock CLI operations. No request supplies an argument list.

use std::collections::BTreeMap;
use std::fmt::Arguments;
use std::time::Duration;

use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::fs::error::uv_code;
use crate::fs::order::js_trim;
use crate::run::{KILL_GRACE, terminate};
use crate::server::{Fault, Scope};
use crate::sidecar::omp_command;

#[derive(Deserialize)]
pub(crate) struct Launch {
    pub bin: String,
    pub env: BTreeMap<String, String>,
    pub cwd: String,
}

pub(crate) struct Output {
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
    execute(launch, args, scope, timeout, Input::Report).await
}

pub(crate) async fn pr_draft(
    launch: &Launch,
    scope: Scope,
    timeout: Duration,
    prompt: &str,
) -> Result<Output, Fault> {
    execute(
        launch,
        ["-p", "--no-session", "--no-tools", "--no-lsp"],
        scope,
        timeout,
        Input::Draft(prompt),
    )
    .await
}

pub(super) async fn rename(
    launch: &Launch,
    session_path: &str,
    input: &str,
    default_model: bool,
    scope: Scope,
) -> Result<Output, Fault> {
    let args = [
        "--mode",
        "rpc",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--no-lsp",
        "--no-title",
        "--session",
        session_path,
    ];
    execute(
        launch,
        args,
        scope,
        Duration::from_secs(30),
        Input::Rename {
            frame: input,
            default_model,
        },
    )
    .await
}

#[derive(Clone, Copy)]
enum Input<'a> {
    Report,
    Draft(&'a str),
    Rename { frame: &'a str, default_model: bool },
}

async fn execute<const N: usize>(
    launch: &Launch,
    args: [&str; N],
    scope: Scope,
    timeout: Duration,
    input: Input<'_>,
) -> Result<Output, Fault> {
    if scope.cancelled() {
        return Err(Fault::cancelled());
    }
    let Launch { bin, cwd, env } = launch;
    #[cfg(windows)]
    // A rename carries a path, not just fixed flags. Let std escape it for a batch shim.
    let shell = !matches!(input, Input::Rename { .. })
        && std::path::Path::new(bin)
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
    let text = match input {
        Input::Report => {
            cmd.env("NO_COLOR", "1").env("FORCE_COLOR", "0");
            None
        }
        Input::Draft(prompt) => Some(prompt),
        Input::Rename {
            frame,
            default_model,
        } => {
            if default_model {
                cmd.args(["--model", "@default"]);
            }
            cmd.env("PI_NOTIFICATIONS", "off");
            Some(frame)
        }
    };
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd
        .spawn()
        .map_err(|e| Fault::new("spawn_failed", format!("spawn {bin} {}", uv_code(&e))))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let feed = async move {
        if let Some(text) = text
            && let Err(error) = stdin.write_all(text.as_bytes()).await
            && error.kind() != std::io::ErrorKind::BrokenPipe
        {
            return Err(error);
        }
        Ok(())
    };
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let mut out = Vec::new();
    let mut err = Vec::new();
    // Node waited for close, not just exit: a child of stock can still hold an output pipe.
    let closed = async {
        tokio::try_join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))?;
        child.wait().await
    };
    // A descendant holding only stdin did not delay Node's close event.
    let finished = async {
        tokio::pin!(closed);
        tokio::select! {
            status = &mut closed => status,
            wrote = feed => { wrote?; closed.await }
        }
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
    if fault.code == "omp_timeout" && !matches!(input, Input::Draft(_)) {
        // Only a draft holds its repository step until reaped.
        tokio::spawn(cleanup);
    } else {
        cleanup.await;
    }
    Err(fault)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_draft_timeout_holds_the_request_until_its_child_exits() {
        let dir = crate::fs::disk::make_temp_dir("ompdesk-draft-timeout-").unwrap();
        let launch = Launch {
            bin: "/bin/sh".into(),
            cwd: dir.to_string_lossy().into_owned(),
            env: BTreeMap::new(),
        };
        let (scope, gone) = Scope::watched();
        let outcome = execute(
            &launch,
            ["-c", "trap '' TERM; echo $$ > started; exec /bin/sleep 30"],
            scope,
            Duration::from_millis(500),
            Input::Draft("a draft"),
        )
        .await;
        gone.wait().await;
        let pid = std::fs::read_to_string(dir.join("started")).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
        assert_eq!(outcome.err().unwrap().code, "omp_timeout");
        assert!(!crate::sys::alive(pid.trim().parse().unwrap()));
    }

    #[tokio::test]
    async fn an_omp_that_closes_stdin_still_returns_its_own_result() {
        let launch = Launch {
            bin: "/bin/sh".into(),
            cwd: "/".into(),
            env: BTreeMap::new(),
        };
        let output = execute(
            &launch,
            ["-c", "exec 0<&-; printf refused >&2; exit 9"],
            Scope::detached(),
            Duration::from_secs(10),
            Input::Draft(&"a".repeat(1024 * 1024)),
        )
        .await
        .unwrap();
        assert_eq!(output.code, 9);
        assert_eq!(output.stderr, b"refused");
    }

    #[tokio::test]
    async fn cancellation_reaps_omp_while_a_prompt_write_is_blocked() {
        let dir = crate::fs::disk::make_temp_dir("ompdesk-draft-cancel-").unwrap();
        let launch = Launch {
            bin: "/bin/sh".into(),
            cwd: dir.to_string_lossy().into_owned(),
            env: BTreeMap::new(),
        };
        let scope = Scope::detached();
        let prompt = "a".repeat(1024 * 1024);
        let (outcome, pid) = tokio::join!(
            execute(
                &launch,
                ["-c", "echo $$ > started; exec /bin/sleep 30"],
                scope.clone(),
                Duration::from_secs(10),
                Input::Draft(&prompt),
            ),
            async {
                let marker = dir.join("started");
                let pid = tokio::time::timeout(Duration::from_secs(5), async {
                    loop {
                        if let Ok(text) = std::fs::read_to_string(&marker)
                            && let Ok(pid) = text.trim().parse::<u32>()
                        {
                            break pid;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await;
                scope.cancel();
                pid
            }
        );
        std::fs::remove_dir_all(dir).unwrap();
        assert_eq!(outcome.err(), Some(Fault::cancelled()));
        assert!(!crate::sys::alive(pid.expect("omp did not start")));
    }
}
