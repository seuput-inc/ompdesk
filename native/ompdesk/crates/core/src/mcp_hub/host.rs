//! The app core owns the MCP child. Only a binding already handed to an omp outlives this core.

use std::io;
use std::num::NonZeroU16;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};

use crate::restart::RestartBudget;
use crate::server::{Call, Events, Fault, Registry, Reply};

#[derive(Deserialize, Serialize)]
struct Binding<S> {
    port: NonZeroU16,
    secret: S,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Open {
    memory_state_file: PathBuf,
    binding: Option<Binding<String>>,
}

#[derive(Serialize)]
#[serde(
    tag = "message",
    content = "details",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Notice<'a> {
    Listening {
        port: NonZeroU16,
        pid: u32,
    },
    Exited {
        reason: &'a str,
        restart_in_ms: Option<u128>,
    },
}

struct App {
    events: Events,
    memory_state_file: PathBuf,
    secret: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Control {
    Demand,
    Stop,
}

struct Running {
    app: Arc<App>,
    port: watch::Receiver<u16>,
    control: watch::Sender<Control>,
    task: JoinHandle<io::Result<()>>,
}

// One per serve connection. The binary has one; independent in-process servers have separate lifetimes.
static HUBS: Mutex<Vec<Running>> = Mutex::new(Vec::new());

fn spawn(app: &App, port: u16) -> io::Result<Child> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--mcp-hub")
        .env_remove("OMPDESK_HUB")
        .env_remove("OMPDESK_HUB_TOKEN")
        .env("OMP_GUI_MCP_HUB_PORT", port.to_string())
        .env("OMP_GUI_MCP_HUB_SECRET", &app.secret)
        .env("OMP_GUI_MEMORY", &app.memory_state_file)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    crate::sys::spawn_low_priority(&mut command).map(|(child, _)| child)
}

async fn child(
    app: &App,
    port: &watch::Sender<u16>,
    control: &mut watch::Receiver<Control>,
    budget: &mut RestartBudget,
) -> io::Result<ExitStatus> {
    let requested = *port.borrow();
    let mut child = spawn(app, requested)?;
    let pid = child.id().expect("unreaped child");
    // Child::wait closes its own stdin. Hold this writer until an actual stop.
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let announcement = tokio::select! {
        biased;
        _ = control.wait_for(|c| *c == Control::Stop) => Ok(()),
        result = async {
            let bound = {
                let mut banner = String::new();
                let mut output = BufReader::with_capacity(128, stdout).take(512);
                if output.read_line(&mut banner).await? == 0 {
                    return Ok(None);
                }
                banner.trim_end().strip_prefix(super::LISTENING)
                    .and_then(|s| s.parse::<NonZeroU16>().ok())
                    .filter(|p| requested == 0 || requested == p.get())
                    .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Unexpected MCP hub address"))?
            };
            budget.note_ready();
            port.send_replace(bound.get());
            app.events.send("mcpHub.log", &Notice::Listening { port: bound, pid });
            child.wait().await.map(Some)
        } => match result {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => Ok(()),
            Err(error) => Err(error),
        }
    };
    drop(stdin);
    let status = match timeout(Duration::from_secs(5), child.wait()).await {
        Ok(result) => result?,
        Err(_) => {
            child.start_kill()?;
            child.wait().await?
        }
    };
    announcement.map(|()| status)
}

async fn supervise(
    app: Arc<App>,
    port: watch::Sender<u16>,
    mut control: watch::Receiver<Control>,
) -> io::Result<()> {
    let mut budget = RestartBudget::default();
    while *control.borrow() != Control::Stop {
        let result = child(&app, &port, &mut control, &mut budget).await;
        // Ignore demand from before this exit. Only a new request can revive a spent ladder.
        if *control.borrow_and_update() == Control::Stop {
            return result.map(drop);
        }
        let delay = budget.next_delay();
        let reason = match result {
            Ok(status) => match status.code() {
                Some(code) => format!("exit code {code}"),
                None => status.to_string(),
            },
            Err(error) => error.to_string(),
        };
        app.events.send(
            "mcpHub.log",
            &Notice::Exited {
                reason: &reason,
                restart_in_ms: delay.map(|delay| delay.as_millis()),
            },
        );
        if let Some(delay) = delay {
            tokio::select! {
                biased;
                _ = control.wait_for(|c| *c == Control::Stop) => break,
                _ = sleep(delay) => {}
            }
        } else {
            loop {
                if control.changed().await.is_err() || *control.borrow_and_update() == Control::Stop
                {
                    return Ok(());
                }
                if budget.revive(Instant::now()) == "scheduled" {
                    break;
                }
            }
        }
    }
    Ok(())
}

fn connect(call: &Call) -> Result<(Arc<App>, watch::Receiver<u16>), Fault> {
    let mut hubs = HUBS.lock().unwrap();
    if let Some(running) = hubs
        .iter()
        .find(|h| !h.app.events.reaches_another(&call.events))
    {
        running.control.send_replace(Control::Demand);
        return Ok((running.app.clone(), running.port.clone()));
    }
    let invalid = || Fault::new("invalid_params", "Invalid MCP hub launch settings");
    // A serde error may quote its input. Never echo the launch credential in a fault.
    let open: Open = call.params().map_err(|_| invalid())?;
    let (port, secret) = match open.binding {
        Some(binding) => {
            if binding.secret.len() != 64 || !binding.secret.bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err(invalid());
            }
            (binding.port.get(), binding.secret)
        }
        None => {
            let mut bytes = [0; 32];
            crate::sys::random(&mut bytes)
                .map_err(|e| Fault::new("mcp_hub_start", e.to_string()))?;
            (0, crate::hex(&bytes))
        }
    };
    let app = Arc::new(App {
        events: call.events.clone(),
        memory_state_file: open.memory_state_file,
        secret,
    });
    let (bound, port) = watch::channel(port);
    let (control, requests) = watch::channel(Control::Demand);
    let task = tokio::spawn(supervise(app.clone(), bound, requests));
    hubs.push(Running {
        app: app.clone(),
        port: port.clone(),
        control,
        task,
    });
    Ok((app, port))
}

fn stop(events: &Events) -> Option<JoinHandle<io::Result<()>>> {
    let mut hubs = HUBS.lock().unwrap();
    let index = hubs
        .iter()
        .position(|h| !h.app.events.reaches_another(events))?;
    let running = hubs.swap_remove(index);
    running.control.send_replace(Control::Stop);
    Some(running.task)
}

async fn joined(task: Option<JoinHandle<io::Result<()>>>) -> io::Result<()> {
    if let Some(task) = task {
        task.await.map_err(io::Error::other)??;
    }
    Ok(())
}

pub(crate) fn close_all(events: &Events) -> impl Future<Output = ()> {
    let stopped = stop(events);
    async move {
        if let Err(error) = joined(stopped).await {
            eprintln!("[mcp-hub] stop failed: {error}");
        }
    }
}

pub(crate) fn register(registry: &mut Registry) {
    registry.add("mcpHub.env", |call| {
        // Start/revive before the next wire frame, so a following stop cannot overtake the launch.
        let connected = connect(&call);
        Box::pin(async move {
            let (app, mut port) = connected?;
            let bound = tokio::select! {
                result = port.wait_for(|p| *p != 0) => result.ok().and_then(|p| NonZeroU16::new(*p)),
                _ = call.scope.on_cancel() => return Err(Fault::cancelled()),
            };
            Reply::json(&bound.map(|port| Binding {
                port,
                secret: app.secret.as_str(),
            }))
        })
    });
    registry.add("mcpHub.stop", |call| {
        let stopped = stop(&call.events);
        Box::pin(async move {
            joined(stopped)
                .await
                .map_err(|e| Fault::new("mcp_hub_stop", e.to_string()))?;
            Reply::json(&())
        })
    });
}
