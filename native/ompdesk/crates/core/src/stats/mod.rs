//! The core owns the dashboard listener, child and retry budget. The installed stock modules run only in Bun.
mod front;
mod page;

use std::collections::HashMap;
use std::io;
use std::net::Ipv4Addr;
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{Notify, mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use crate::restart::RestartBudget;
use crate::server::{Call, Events, Fault, Registry, Reply, at_once};
use crate::sidecar::{MAX_RESTART_ATTEMPTS, strip_vt_control_characters};

#[derive(Deserialize)]
struct Launch {
    id: u64,
    command: String,
    args: Vec<String>,
    env: std::collections::BTreeMap<String, String>,
}

struct Endpoint {
    listener: TcpListener,
    queries: mpsc::Sender<page::Query>,
}

impl Endpoint {
    async fn fetch(&self, p: front::Fetch) -> Result<Box<serde_json::value::RawValue>, Fault> {
        let port = self
            .listener
            .local_addr()
            .map_err(|e| Fault::new("stats_api_error", e.to_string()))?
            .port();
        // Pin the port against reuse, but don't wait on its backlog after the serving task ends.
        tokio::select! {
            result = front::fetch(port, p) => result,
            _ = self.queries.closed() => Err(Fault::new("stats_api_error", "Stats server is not answering")),
        }
    }
}

#[derive(Default)]
enum Phase {
    #[default]
    Pending,
    Ready(Arc<Endpoint>),
    Idle,
}

#[derive(Default)]
struct State {
    phase: Phase,
    budget: RestartBudget,
}

impl State {
    fn revive(&mut self, now: Instant) -> &'static str {
        if !matches!(self.phase, Phase::Idle) {
            return "already-pending";
        }
        let verdict = self.budget.revive(now);
        if verdict == "scheduled" {
            self.phase = Phase::Pending;
        }
        verdict
    }

    fn exited(&mut self, clean: bool) -> Option<Duration> {
        let delay = if clean {
            None
        } else {
            self.budget.next_delay()
        };
        self.phase = if delay.is_some() {
            Phase::Pending
        } else {
            Phase::Idle
        };
        delay
    }
}

#[derive(Default)]
struct Host {
    state: Mutex<State>,
    demand: Notify,
}

struct Running {
    host: Arc<Host>,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
    events: Events,
}

static HOSTS: LazyLock<Mutex<HashMap<u64, Running>>> = LazyLock::new(Mutex::default);

fn ready_port(line: &str) -> Option<u16> {
    let line = strip_vt_control_characters(line);
    let address = line.trim().strip_prefix("ompdesk-stats-ready http://")?;
    let port = address
        .strip_prefix("127.0.0.1:")
        .or_else(|| address.strip_prefix("localhost:"))?
        .trim_end_matches('/');
    if !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    port.parse::<u16>().ok().filter(|p| *p != 0)
}

async fn line(
    reader: &mut BufReader<ChildStdout>,
    buf: &mut Vec<u8>,
    max: usize,
) -> io::Result<bool> {
    let mut bounded = reader.take((max - buf.len()) as u64);
    let n = bounded.read_until(b'\n', buf).await?;
    if bounded.limit() == 0 && !buf.ends_with(b"\n") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "stats worker frame too large",
        ));
    }
    Ok(n != 0)
}

// One ordered exchange at a time over the worker's private pipes. A dropped HTTP reader never consumes the next reader's reply.
async fn database(
    mut input: ChildStdin,
    mut output: BufReader<ChildStdout>,
    mut queries: mpsc::Receiver<page::Query>,
) -> io::Result<()> {
    let mut pending: Option<oneshot::Sender<Vec<u8>>> = None;
    let mut buf = Vec::new();
    loop {
        tokio::select! {
            read = line(&mut output, &mut buf, crate::http::BODY_MAX) => {
                if !read? { return Ok(()); }
                if buf.starts_with(page::RECORDS) && let Some(reply) = pending.take() {
                    let _ = reply.send(std::mem::take(&mut buf));
                }
                buf.clear();
            }
            query = queries.recv(), if pending.is_none() => {
                let Some(mut query) = query else { return Ok(()); };
                if query.reply.is_closed() { continue; }
                query.line.push('\n');
                input.write_all(query.line.as_bytes()).await?;
                pending = Some(query.reply);
            }
        }
    }
}

async fn serving(host: &Host, input: ChildStdin, output: ChildStdout) -> io::Result<()> {
    let mut output = BufReader::new(output);
    let mut buf = Vec::new();
    let upstream = loop {
        if !line(&mut output, &mut buf, 4096).await? {
            return Ok(());
        }
        if let Some(port) = ready_port(&String::from_utf8_lossy(&buf)) {
            break port;
        }
        buf.clear();
    };
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    eprintln!("[stats-server] ready on http://{}", listener.local_addr()?);
    let (queries, rx) = mpsc::channel(16);
    let endpoint = Arc::new(Endpoint { listener, queries });
    {
        let mut state = host.state.lock().unwrap();
        state.budget.note_ready();
        state.phase = Phase::Ready(endpoint.clone());
    }
    tokio::select! {
        result = front::serve(&endpoint.listener, upstream, &endpoint.queries) => result,
        result = database(input, output, rx) => result,
    }
}

async fn child(launch: &Launch, host: &Host, stop: &mut watch::Receiver<bool>) -> io::Result<bool> {
    let mut cmd = Command::new(&launch.command);
    cmd.args(&launch.args).env_clear();
    crate::run::Runner::apply_environment(&launch.env, &mut cmd);
    cmd.env("PI_NOTIFICATIONS", "off")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn()?;
    let input = child.stdin.take().expect("piped stdin");
    let output = child.stdout.take().expect("piped stdout");
    tokio::select! {
        biased;
        _ = stop.changed() => {}
        status = child.wait() => return status.map(|s| s.success()),
        result = serving(host, input, output) => {
            if let Err(e) = result { eprintln!("[stats-server] {e}"); }
            // EOF can precede wait() on a clean exit. Let the process report its actual status.
        }
    }
    // Dropping serving closed stdin, including when the worker never finished its imports or bound a port.
    host.state.lock().unwrap().phase = Phase::Pending;
    if let Ok(status) = tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        return status.map(|s| s.success());
    }
    child.kill().await?;
    Ok(false)
}

async fn supervise(launch: Launch, host: Arc<Host>, mut stop: watch::Receiver<bool>) {
    while !*stop.borrow() {
        let clean = match child(&launch, &host, &mut stop).await {
            Ok(clean) => clean,
            Err(e) => {
                eprintln!("[stats-server] {e}");
                false
            }
        };
        if *stop.borrow() {
            break;
        }
        let delay = host.state.lock().unwrap().exited(clean);
        if !clean {
            match delay {
                Some(d) => eprintln!("[stats-server] restart in {}ms", d.as_millis()),
                None => eprintln!("[stats-server] failed after {MAX_RESTART_ATTEMPTS} attempts"),
            }
        }
        tokio::select! {
            _ = stop.changed() => break,
            _ = async { match delay { Some(delay) => tokio::time::sleep(delay).await, None => host.demand.notified().await } } => {}
        }
    }
}

fn start(call: Call) -> Result<Reply, Fault> {
    let launch: Launch = call.params()?;
    HOSTS.lock().unwrap().entry(launch.id).or_insert_with(|| {
        let host = Arc::new(Host::default());
        let (stop, rx) = watch::channel(false);
        let task = tokio::spawn(supervise(launch, host.clone(), rx));
        Running {
            host,
            stop,
            task,
            events: call.events,
        }
    });
    Reply::json(&())
}

async fn fetch(call: Call) -> Result<Reply, Fault> {
    let p: front::Fetch = call.params()?;
    let endpoint = {
        let hosts = HOSTS.lock().unwrap();
        let Some(running) = hosts.get(&p.id) else {
            return Reply::json(&json!({"ready": false, "exhausted": true}));
        };
        let mut state = running.host.state.lock().unwrap();
        if let Phase::Ready(endpoint) = &state.phase {
            endpoint.clone()
        } else {
            let revive = state.revive(Instant::now());
            if revive == "scheduled" {
                running.host.demand.notify_one();
            }
            return Reply::json(&json!({"ready": false, "exhausted": revive == "exhausted"}));
        }
    };
    let data = tokio::select! {
        result = endpoint.fetch(p) => result?,
        _ = call.scope.on_cancel() => return Err(Fault::cancelled()),
    };
    #[derive(serde::Serialize)]
    struct Available {
        ready: bool,
        data: Box<serde_json::value::RawValue>,
    }
    Reply::json(&Available { ready: true, data })
}

pub(super) async fn close_all(events: &Events) {
    let tasks: Vec<_> = HOSTS
        .lock()
        .unwrap()
        .extract_if(|_, running| !running.events.reaches_another(events))
        .map(|(_, running)| {
            running.stop.send_replace(true);
            running.task
        })
        .collect();
    for task in tasks {
        let _ = task.await;
    }
}

#[derive(Deserialize)]
struct Id {
    id: u64,
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("stats.start", |c| at_once(start(c)));
    registry.add("stats.fetch", |c| Box::pin(fetch(c)));
    registry.add("stats.stop", |c| {
        let running = c
            .params::<Id>()
            .map(|p| HOSTS.lock().unwrap().remove(&p.id));
        if let Ok(Some(host)) = &running {
            host.stop.send_replace(true);
        }
        Box::pin(async move {
            if let Some(host) = running? {
                host.task
                    .await
                    .map_err(|e| Fault::new("stats_stop", e.to_string()))?;
            }
            Reply::json(&())
        })
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_accepts_only_the_workers_loopback_announcement() {
        assert_eq!(
            ready_port("\x1b[32mompdesk-stats-ready http://127.0.0.1:54321\x1b[39m"),
            Some(54321)
        );
        for line in [
            "http://localhost:9",
            "ompdesk-stats-ready http://example.com:9",
            "ompdesk-stats-ready http://127.0.0.1:0",
            "ompdesk-stats-ready http://localhost",
        ] {
            assert_eq!(ready_port(line), None);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_read_pinning_the_old_listener_ends_when_its_worker_exits() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let (queries, worker) = mpsc::channel(1);
        let endpoint = Endpoint { listener, queries };
        let p = serde_json::from_value(json!({"id": 1, "path": "/api/status"})).unwrap();
        let read = endpoint.fetch(p);
        tokio::pin!(read);
        tokio::select! {
            biased;
            result = &mut read => panic!("read finished before accept: {result:?}"),
            _ = std::future::ready(()) => {}
        }
        drop(worker);
        assert_eq!(
            read.await.unwrap_err(),
            Fault::new("stats_api_error", "Stats server is not answering")
        );
    }

    #[test]
    fn a_clean_exit_waits_for_demand_and_concurrent_readers_revive_only_once() {
        let mut state = State::default();
        let now = Instant::now();
        assert_eq!(state.exited(true), None);
        assert_eq!(state.revive(now), "scheduled");
        assert_eq!(state.revive(now), "already-pending");
        assert_eq!(state.exited(false), Some(Duration::from_secs(1)));
        assert_eq!(state.revive(now), "already-pending");
    }
}
