//! The installer runner (was `src/main/setup/runner.ts`): one supervised command at a time (`ompdesk-core
//! --supervise`, `supervise.rs`, as `schedules/launch.rs` starts it), its output passed on as it comes and its last
//! [`OUTPUT_TAIL`] kept. Stopping it closes the supervisor's stdin; the supervisor ends the command's whole tree and
//! exits 130, and the run is `cancelled`.
//!
//! The stop is registered with the step that runs it ([`Ctx::on_stop`]), so whoever stops that step (its bound, the
//! person's Cancel, the quit) stops the installer. The supervisor is owned by a task of its own until it exited, and
//! the next run waits for that: an installer a dropped step left behind is ended and gone before the next starts.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{Semaphore, mpsc, oneshot};

use super::queue::Ctx;
use crate::aimemory::service::text::without_csi;
use crate::fs::order::js_trim;

/// `SETUP_OUTPUT_TAIL`: the output kept, in UTF-16 units as JavaScript counts a string.
pub const OUTPUT_TAIL: usize = 64 * 1024;
/// The variable the supervisor reads its command from (`SPEC_ENV` in `supervise.rs`).
const SPEC_ENV: &str = "OMPDESK_SETUP_SPEC";
/// The supervisor's exit status when it could not start the command, as a shell's.
const NOT_STARTED: i32 = 127;
/// How long output may still arrive after the supervisor exited (a descendant may hold the pipes open).
const DRAIN: Duration = Duration::from_millis(500);

/// `SpawnSpec` of `src/main/setup/plans.ts` (an installer is never `isolated`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSpec {
    pub file: String,
    pub args: Vec<String>,
    /// Only for a Windows `.cmd` shim; the args are then already quoted for cmd.exe.
    #[serde(default)]
    pub shell: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_file: Option<String>,
}

/// `RunOutcome` of `runner.ts`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunOutcome {
    Succeeded,
    Cancelled,
    #[serde(rename_all = "camelCase")]
    Failed {
        reason: FailedBy,
        exit_code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailedBy {
    Exit,
    Spawn,
}

#[derive(Debug)]
pub struct Ran {
    pub outcome: RunOutcome,
    /// The output's last [`OUTPUT_TAIL`] UTF-16 units, colors kept.
    pub output: String,
}

/// How the supervisor starts: this binary with `--supervise`, or a test's stand-in.
pub struct Supervisor {
    pub file: PathBuf,
    pub args: Vec<String>,
}

impl Supervisor {
    pub fn this_binary() -> Supervisor {
        Supervisor {
            file: std::env::current_exe().unwrap_or_else(|_| PathBuf::from("ompdesk-core")),
            args: vec!["--supervise".to_owned()],
        }
    }
}

pub struct Runner {
    supervisor: Supervisor,
    /// One installer at a time: held by the task that owns the supervisor until it exited.
    slot: Arc<Semaphore>,
}

/// Appends `chunk` to `tail` and keeps its last `OUTPUT_TAIL` UTF-16 units (`(tail + chunk).slice(-N)`).
pub fn push_tail(tail: &mut String, chunk: &str) {
    tail.push_str(chunk);
    let mut units: usize = tail.chars().map(char::len_utf16).sum();
    let mut cut = 0;
    for c in tail.chars() {
        if units <= OUTPUT_TAIL {
            break;
        }
        units -= c.len_utf16();
        cut += c.len_utf8();
    }
    tail.drain(..cut);
}

/// The last line with text, without color codes (`lastLine` of `runner.ts`).
fn last_line(output: &str) -> Option<String> {
    without_csi(output)
        .split(['\r', '\n'])
        .map(js_trim)
        .rfind(|line| !line.is_empty())
        .map(str::to_owned)
}

impl Runner {
    pub fn new(supervisor: Supervisor) -> Runner {
        Runner {
            supervisor,
            slot: Arc::new(Semaphore::new(1)),
        }
    }

    /// Runs `spec` with exactly `env` (in `cwd`) under the supervisor, once no other installer runs. `output` hears
    /// each chunk as it comes.
    pub async fn run(
        &self,
        ctx: &Ctx,
        spec: &SpawnSpec,
        env: &BTreeMap<String, String>,
        cwd: Option<&str>,
        output: &mut dyn FnMut(&str),
    ) -> Ran {
        let failed = |detail: String| Ran {
            outcome: RunOutcome::Failed {
                reason: FailedBy::Spawn,
                exit_code: None,
                detail: Some(detail),
            },
            output: String::new(),
        };
        let Ok(slot) = Arc::clone(&self.slot).acquire_owned().await else {
            return failed("the runner closed".to_owned());
        };
        let spec_json = match serde_json::to_string(spec) {
            Ok(json) => json,
            Err(error) => return failed(error.to_string()),
        };
        let mut env = env.clone();
        env.insert(SPEC_ENV.to_owned(), spec_json);
        let mut command = Command::new(&self.supervisor.file);
        command
            .args(&self.supervisor.args)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::run::Runner::apply_environment(&env, &mut command);
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        #[cfg(unix)]
        crate::sys::own_group(command.as_std_mut());
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => return failed(error.to_string()),
        };
        // Stopping closes the supervisor's stdin; once the run ended there is nothing left to close.
        let stdin = Rc::new(RefCell::new(child.stdin.take()));
        let stopped = Rc::new(std::cell::Cell::new(false));
        ctx.on_stop({
            let (stdin, stopped) = (Rc::clone(&stdin), Rc::clone(&stopped));
            move || {
                let live = stdin.borrow_mut().take().is_some();
                stopped.set(stopped.get() || live);
                live
            }
        });
        let (chunks, mut read) = mpsc::unbounded_channel::<String>();
        let (exit, exited) = oneshot::channel();
        let pipes = [
            child
                .stdout
                .take()
                .map(|pipe| forward(pipe, chunks.clone())),
            child
                .stderr
                .take()
                .map(|pipe| forward(pipe, chunks.clone())),
        ];
        drop(chunks);
        // Owns the supervisor and the slot until it exited, also when the step that started it is dropped.
        tokio::spawn(async move {
            let status = child.wait().await;
            let drained = tokio::time::Instant::now() + DRAIN;
            for mut pipe in pipes.into_iter().flatten() {
                if tokio::time::timeout_at(drained, &mut pipe).await.is_err() {
                    pipe.abort();
                }
            }
            drop(slot);
            let _ = exit.send(status.ok().and_then(|status| status.code()));
        });
        let mut tail = String::new();
        while let Some(chunk) = read.recv().await {
            push_tail(&mut tail, &chunk);
            output(&chunk);
        }
        let code = exited.await.ok().flatten();
        stdin.borrow_mut().take();
        let outcome = if stopped.get() {
            RunOutcome::Cancelled
        } else {
            match code {
                Some(0) => RunOutcome::Succeeded,
                Some(NOT_STARTED) => RunOutcome::Failed {
                    reason: FailedBy::Spawn,
                    exit_code: code,
                    detail: Some(last_line(&tail).unwrap_or_default()),
                },
                _ => RunOutcome::Failed {
                    reason: FailedBy::Exit,
                    exit_code: code,
                    detail: last_line(&tail),
                },
            }
        };
        Ran {
            outcome,
            output: tail,
        }
    }
}

/// Passes a pipe's text on in chunks until it closes.
fn forward(
    mut pipe: impl AsyncRead + Unpin + Send + 'static,
    chunks: mpsc::UnboundedSender<String>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut buffer = vec![0; 8192];
        let mut pending = Vec::new();
        while let Ok(read) = pipe.read(&mut buffer).await {
            if read == 0 {
                break;
            }
            pending.extend_from_slice(&buffer[..read]);
            // A character split across reads waits for its rest, as node's `setEncoding("utf8")` decoder does.
            let whole = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(error) if error.error_len().is_none() => error.valid_up_to(),
                Err(_) => pending.len(),
            };
            let text = String::from_utf8_lossy(&pending[..whole]).into_owned();
            pending.drain(..whole);
            if !text.is_empty() && chunks.send(text).is_err() {
                break;
            }
        }
        if !pending.is_empty() {
            let _ = chunks.send(String::from_utf8_lossy(&pending).into_owned());
        }
    })
}
