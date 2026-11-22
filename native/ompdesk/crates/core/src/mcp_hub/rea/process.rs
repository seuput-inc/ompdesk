//! One stdio transport, including the process tree that owns its pipes.

use std::ffi::OsString;
use std::io;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use super::Event;

pub(super) struct Process {
    pub input: mpsc::UnboundedSender<Value>,
    stop: Option<oneshot::Sender<()>>,
}

impl Process {
    pub fn start(
        argv: &[OsString],
        cwd: Option<&Path>,
        events: mpsc::UnboundedSender<Event>,
    ) -> io::Result<Self> {
        let (program, args) = argv
            .split_first()
            .ok_or_else(|| io::Error::other("No REA command"))?;
        let mut cmd = Command::new(program);
        cmd.args(args)
            .env_remove("OMP_GUI_MCP_HUB_SECRET")
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        #[cfg(unix)]
        crate::sys::own_group(cmd.as_std_mut());
        #[cfg(windows)]
        cmd.creation_flags(0x0000_0004 | 0x0800_0000); // CREATE_SUSPENDED | CREATE_NO_WINDOW
        let mut child = cmd.spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("REA child exited"))?;
        #[cfg(windows)]
        let tree = {
            let handle = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("REA child exited"))?;
            let tree = crate::sys::ProcessTree::of(handle)?;
            // Enroll the suspended child before it can start any descendants.
            crate::sys::resume_process(pid)?;
            tree
        };
        let mut stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let (input, mut writes) = mpsc::unbounded_channel::<Value>();
        let (stop, mut stopped) = oneshot::channel();
        tokio::spawn(async move {
            let mut read = std::pin::pin!(async {
                let mut reader = BufReader::new(stdout);
                let mut line = Vec::new();
                while matches!(reader.read_until(b'\n', &mut line).await, Ok(n) if n > 0) {
                    let Ok(frame) = serde_json::from_slice::<Value>(&line) else {
                        break;
                    };
                    if frame.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
                        || events.send(Event::Frame(frame)).is_err()
                    {
                        break;
                    }
                    line.clear();
                }
            });
            let (exited, drain) = {
                let write = async move {
                    let mut line = Vec::new();
                    while let Some(msg) = writes.recv().await {
                        line.clear();
                        if serde_json::to_writer(&mut line, &msg).is_err() {
                            break;
                        }
                        line.push(b'\n');
                        if stdin.write_all(&line).await.is_err() {
                            break;
                        }
                    }
                };
                tokio::select! {
                    status = child.wait() => (status.is_ok(), true),
                    () = &mut read => (false, false),
                    () = write => (false, true),
                    _ = &mut stopped => (false, false),
                }
            };
            #[cfg(unix)]
            {
                if !exited {
                    crate::sys::signal_group(pid, false);
                    if tokio::time::timeout(Duration::from_secs(2), child.wait())
                        .await
                        .is_err()
                    {
                        crate::sys::signal_group(pid, true);
                        let _ = child.wait().await;
                    }
                }
                // Descendants can ignore TERM, drop their pipes, and outlive the group leader.
                crate::sys::signal_group(pid, true);
            }
            #[cfg(windows)]
            {
                tree.end();
                if !exited {
                    let _ = child.wait().await;
                }
                while tree.alive() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
            // On natural exit stdout may still contain the reply immediately preceding it.
            if drain {
                tokio::select! { () = &mut read => {}, _ = stopped => {} }
            }
            let _ = events.send(Event::Ended);
        });
        Ok(Self {
            input,
            stop: Some(stop),
        })
    }

    pub fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}
