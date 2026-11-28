//! The only WSL command surface for a registered tab. Neither Win32 process exit nor pipe EOF is a guest stop.
mod command;
#[cfg(all(test, unix))]
mod tests;

use std::io;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::time::timeout;

use crate::wsl_copy::reference::valid_key;
use crate::wsl_copy::{Receipt, Registration, TurnDisposition, Writer};
use command::Target;

const DEADLINE: Duration = Duration::from_secs(20);
const CONTROL: usize = 4096;
const MINIMUM: &str = include_str!("../../../../../../src/shared/omp-minimum.json");

fn invalid(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}

fn timed_out(_: tokio::time::error::Elapsed) -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "WSL did not answer in time")
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Witness {
    pub invocation_id: String,
    pub uid: u32,
}

#[derive(Clone)]
pub(super) struct Guest {
    target: Target,
    pub home: String,
    uid: u32,
    bridge_dir: String,
    package: String,
    project: String,
    cwd: String,
    registration: Registration,
}

pub(super) struct Stock {
    pub child: Child,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    pub stderr: BufReader<ChildStderr>,
    pub witness: Witness,
}

pub(super) struct Bridge {
    pub child: Child,
    pub stdin: ChildStdin,
    pub stdout: BufReader<ChildStdout>,
}

// Keep the same reader after the preamble: relay or stock bytes can share its last kernel read.
async fn record<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    line: &mut Vec<u8>,
) -> io::Result<()> {
    let left = (CONTROL + 1).saturating_sub(line.len());
    let n = reader.take(left as u64).read_until(b'\n', line).await?;
    if n == 0 || line.len() > CONTROL || !line.ends_with(b"\n") {
        return Err(invalid("Invalid WSL control record"));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum Control {
    #[serde(rename = "ompdesk-wsl-attached")]
    Attached {
        #[serde(rename = "invocationId")]
        invocation_id: String,
        uid: u32,
    },
    #[serde(rename = "ompdesk-wsl-ready")]
    Ready {
        #[serde(rename = "spawnId")]
        spawn_id: String,
    },
}

fn witnessed(writer: &Writer, w: &Witness) -> io::Result<bool> {
    Ok(writer.prior()?.is_some_and(|i| {
        i.spawn == writer.spawn_id()
            && i.receipt
                .is_some_and(|(id, uid)| id == w.invocation_id && uid == w.uid)
    }))
}

fn attached(line: &[u8]) -> io::Result<Witness> {
    match serde_json::from_slice(line) {
        Ok(Control::Attached { invocation_id, uid }) if uid > 0 && valid_key(&invocation_id) => {
            Ok(Witness { invocation_id, uid })
        }
        _ => Err(invalid(
            "Missing WSL invocation witness; guest state unknown",
        )),
    }
}

// If the caller withdraws while the service is attaching, close its input and keep reading the
// SAME partial receipt. Stopping a named unit without this receipt could stop a different launch.
struct Pending<'a> {
    guest: &'a Guest,
    spawn: &'a str,
    child: Option<Child>,
    stderr: Option<BufReader<ChildStderr>>,
    partial: Vec<u8>,
    witness: Option<Witness>,
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let guest = self.guest.clone();
        let spawn = self.spawn.to_owned();
        let mut stderr = self.stderr.take();
        let mut line = std::mem::take(&mut self.partial);
        let witness = self.witness.take();
        drop(child.stdin.take());
        tokio::spawn(async move {
            let witness = match witness {
                Some(w) => Some(w),
                None => match stderr.as_mut() {
                    Some(reader) if !line.ends_with(b"\n") && line.len() < CONTROL => {
                        match timeout(DEADLINE, record(reader, &mut line)).await {
                            Ok(Ok(())) => attached(&line).ok(),
                            _ => None,
                        }
                    }
                    _ => None,
                },
            };
            if let Some(w) = witness {
                let _ = guest.stop(&spawn, &w).await;
            }
            // Release the local stdio process, never use this result to release the durable registration.
            let _ = child.kill().await;
        });
    }
}

impl Guest {
    #[cfg(all(test, unix))]
    pub(super) fn fixture(exe: std::path::PathBuf, registration: Registration) -> Self {
        Self {
            target: Target {
                exe,
                id: registration.distro.clone(),
            },
            home: "/home/fiction".into(),
            uid: 1001,
            bridge_dir: "/mnt/c/Pack aged/gui-bridge".into(),
            package: r"C:\Pack aged\gui-bridge".into(),
            project: registration.cwd.clone(),
            cwd: "/mnt/c/assigned project".into(),
            registration,
        }
    }

    /// Only the host supplies these paths. The package must be the sibling of the installed/staged core.
    pub(super) async fn prepare(
        registration: &Registration,
        bridge_dir: &Path,
    ) -> io::Result<Self> {
        #[cfg(windows)]
        {
            let reg = registration.clone();
            let bridge = bridge_dir.to_owned();
            timeout(DEADLINE, async move {
                let (target, project, bridge) =
                    tokio::task::spawn_blocking(move || command::resolve(&reg, &bridge))
                        .await
                        .map_err(io::Error::other)??;
                Self::from_paths(target, project, bridge, registration.clone()).await
            })
            .await
            .map_err(timed_out)?
        }
        #[cfg(not(windows))]
        {
            let _ = (registration, bridge_dir);
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "The WSL host requires Windows",
            ))
        }
    }

    #[cfg(any(windows, all(test, unix)))]
    async fn from_paths(
        target: Target,
        project: String,
        package: String,
        registration: Registration,
    ) -> io::Result<Self> {
        let out = command::output(target.prepare(&project, &package), 16 * 1024).await?;
        let text = std::str::from_utf8(&out).map_err(|_| invalid("Invalid WSL path report"))?;
        let mut fields = text.strip_suffix('\n').unwrap_or("").split('\n');
        let uid = fields
            .next()
            .and_then(|s| s.parse::<u32>().ok())
            .filter(|u| *u != 0);
        let (Some(uid), Some(home), Some(cwd), Some(bridge_dir), None) = (
            uid,
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            return Err(invalid("Missing WSL paths or non-root user"));
        };
        if home == "/"
            || bridge_dir == "/"
            || ![home, cwd, bridge_dir].into_iter().all(command::guest_path)
        {
            return Err(invalid("Invalid WSL path"));
        }
        Ok(Self {
            target,
            home: home.into(),
            uid,
            bridge_dir: bridge_dir.into(),
            cwd: cwd.into(),
            project,
            package,
            registration,
        })
    }

    fn verify(&self, spawn: &str, witness: &Witness) -> io::Result<()> {
        if !valid_key(spawn)
            || !valid_key(&witness.invocation_id)
            || witness.uid == 0
            || witness.uid != self.uid
        {
            return Err(invalid(
                "WSL invocation or default user changed; guest state unknown",
            ));
        }
        Ok(())
    }

    /// Reconciliation is the caller's job. A still-issued prior service prevents even running the supervisor.
    /// The first possible stock input is gated on a successful durable witness write.
    pub(super) async fn launch(
        &self,
        writer: &Writer,
        tab_tag: &str,
        basename: Option<&str>,
        persist: impl FnOnce(&Witness) -> io::Result<()>,
    ) -> io::Result<Stock> {
        if writer.registration() != &self.registration
            || !valid_key(tab_tag)
            || basename.is_some_and(|s| !command::basename(s))
            || writer.original()?.as_deref() != basename
        {
            return Err(invalid("Invalid registered WSL launch"));
        }
        let spawn = writer.spawn_id();
        let minimum: &str = serde_json::from_str(MINIMUM)?;
        let mut header = serde_json::json!({ "spawnId": spawn, "tabTag": tab_tag,
            "sessionKey": writer.session_key(), "cwd": self.cwd, "bridgeDir": self.bridge_dir,
            "minimumOmpVersion": minimum });
        if let Some(basename) = basename {
            header["sessionBasename"] = basename.into();
        }
        let mut header = serde_json::to_vec(&header)?;
        if header.len() > 16 * 1024 {
            return Err(invalid("WSL launch header too large"));
        }
        header.push(b'\n');
        let mut cmd = Command::from(self.command("run", &[spawn, &self.project, &self.cwd]));
        writer.issue()?;
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let stderr = BufReader::new(child.stderr.take().expect("piped stderr"));
        let mut pending = Pending {
            guest: self,
            spawn,
            child: Some(child),
            stderr: Some(stderr),
            partial: Vec::new(),
            witness: None,
        };
        let handshake = async {
            let reader = pending.stderr.as_mut().expect("pending stderr");
            record(reader, &mut pending.partial).await?;
            let witness = attached(&pending.partial)?;
            pending.witness = Some(witness);
            let w = pending.witness.as_ref().expect("attached witness");
            self.verify(spawn, w)?;
            persist(w)?;
            if !witnessed(writer, w)? {
                return Err(invalid("WSL invocation was not durably witnessed"));
            }
            pending
                .child
                .as_mut()
                .unwrap()
                .stdin
                .as_mut()
                .expect("piped stdin")
                .write_all(&header)
                .await?;
            pending.partial.clear();
            record(reader, &mut pending.partial).await?;
            match serde_json::from_slice(&pending.partial) {
                Ok(Control::Ready { spawn_id }) if spawn_id == spawn => Ok(()),
                _ => Err(invalid("WSL stock did not acknowledge this spawn")),
            }
        };
        let result = timeout(DEADLINE, handshake)
            .await
            .map_err(timed_out)
            .and_then(|r| r);
        if let Err(e) = result {
            if let Some(w) = &pending.witness {
                let stopped = self.stop(spawn, w).await;
                drop(pending.child.take());
                stopped?;
            }
            return Err(e);
        }
        let mut child = pending.child.take().expect("pending child");
        Ok(Stock {
            stdin: child.stdin.take().expect("piped stdin"),
            stdout: child.stdout.take().expect("piped stdout"),
            child,
            stderr: pending.stderr.take().expect("pending stderr"),
            witness: pending.witness.take().expect("attached witness"),
        })
    }

    pub(super) async fn stop(&self, spawn: &str, witness: &Witness) -> io::Result<()> {
        self.verify(spawn, witness)?;
        let command = self.command(
            "stop",
            &[spawn, &witness.invocation_id, &witness.uid.to_string()],
        );
        let reply = timeout(DEADLINE, command::output(command, CONTROL))
            .await
            .map_err(timed_out)??;
        if reply != b"stopped\n" {
            return Err(invalid("WSL stop not confirmed; guest state unknown"));
        }
        Ok(())
    }

    pub(super) async fn bridge(&self, spawn: &str, witness: &Witness) -> io::Result<Bridge> {
        self.verify(spawn, witness)?;
        let mut cmd = Command::from(self.command(
            "bridge",
            &[spawn, &witness.invocation_id, &witness.uid.to_string()],
        ));
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        let mut line = Vec::new();
        timeout(DEADLINE, record(&mut stdout, &mut line))
            .await
            .map_err(timed_out)??;
        if line != b"OK\n" {
            return Err(invalid("WSL bridge did not connect"));
        }
        Ok(Bridge {
            stdin: child.stdin.take().expect("piped stdin"),
            stdout,
            child,
        })
    }

    /// Runs on the writer's blocking worker. One deadline covers both the wire and process exit,
    /// including a hung Windows launcher that never got far enough for the guest timeout.
    pub(super) fn checkpoint(
        &self,
        writer: &mut Writer,
        witness: &Witness,
        basename: &str,
        stock_id: &str,
        turn: TurnDisposition<'_>,
    ) -> io::Result<Receipt> {
        self.verify(writer.spawn_id(), witness)?;
        if writer.registration() != &self.registration
            || !command::basename(basename)
            || stock_id.is_empty()
            || stock_id.len() > 128
            || stock_id.chars().any(char::is_control)
            || !witnessed(writer, witness)?
            || writer.original()?.as_deref() != Some(basename)
        {
            return Err(invalid("Invalid WSL checkpoint binding"));
        }
        let cmd = self.command(
            "checkpoint",
            &[
                writer.spawn_id(),
                &witness.invocation_id,
                &witness.uid.to_string(),
                writer.session_key(),
                basename,
                stock_id,
            ],
        );
        let runtime = tokio::runtime::Handle::try_current().map_err(io::Error::other)?;
        let mut child = Command::from(cmd)
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(125);
        let reader = CheckpointPipe {
            pipe: child.stdout.take().expect("piped stdout"),
            runtime: &runtime,
            deadline,
        };
        writer.receive(
            reader,
            || {
                runtime.block_on(async {
                    tokio::time::timeout_at(deadline, child.wait())
                        .await
                        .map_err(timed_out)?
                        .map(|s| s.success())
                })
            },
            turn,
        )
    }

    fn command(&self, op: &str, args: &[&str]) -> std::process::Command {
        self.target
            .operation(&self.home, self.uid, &self.package, op, args)
    }
}

struct CheckpointPipe<'a> {
    pipe: ChildStdout,
    runtime: &'a tokio::runtime::Handle,
    deadline: tokio::time::Instant,
}

impl io::Read for CheckpointPipe<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.runtime.block_on(async {
            tokio::time::timeout_at(self.deadline, self.pipe.read(bytes))
                .await
                .map_err(timed_out)?
        })
    }
}
