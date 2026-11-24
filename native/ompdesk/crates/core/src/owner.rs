//! The owner of `ompdesk-core` processes (docs/rust-node-removal.md, "the shell owns the core", revision for (b)). It
//! is the mechanism only: main decides when a core starts, mints its generation and endpoints, and sends the
//! environment it runs with; the owner spawns it, holds its stdio, and reports when it ended and when its process group
//! is gone. Linked into the Tauri shell (`#[path]`), which serves main on a connection of its own (`serve_lines`), and
//! run as `ompdesk-core --own` (`serve_stdio`) where no shell exists (vitest), so both run this one file. Main speaks
//! to it from a worker thread: a thread blocked in a hub wait can send one pipe write on Windows, not the abandon and
//! the next start a lost hub call needs.
//!
//! Requests: `core.start {generation, binary, cwd, env}` (answers `{pid}` once spawned), `core.abandon {generation}`
//! (kills its tree at once), `core.stop {generation}` (closes its stdin; killed 5 s later if it still runs). Events:
//! `core.stderr {generation, line}`, `core.ended {generation, code, signal}` when the process exited, then
//! `core.gone {generation, empty}` once what is left of its process group is killed and gone (`empty`), or 3 s passed.
//! Windows has no group to wait on: the core's own kill-on-close job ended its children (`sys.rs`).
//!
//! The core's stdout is drained and unread: main speaks to it over its own connection (`clients.rs`). The core is told
//! (`OMPDESK_STDIO_OWNER`) that its stdio is the owner's, not main's.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// How long a stopped core may take to end before it is killed with what it started.
const STOP_KILL: Duration = Duration::from_secs(5);
/// The longest the owner waits, after a core ended, for its process group to be gone.
#[cfg(unix)]
const GROUP_GONE: Duration = Duration::from_secs(3);
/// How often a running core is checked for its exit.
const EXIT_POLL: Duration = Duration::from_millis(20);

/// Where events go: the shell's host connection, or `--own`'s stdout.
pub type Sink = Arc<dyn Fn(&str, Value) + Send + Sync>;
/// A request's answer: its result, or a `(code, message)` refusal.
pub type Reply = Box<dyn FnOnce(Result<Value, (String, String)>) + Send>;

struct Core {
    pid: u32,
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
}

pub struct Owner {
    sink: Sink,
    cores: Mutex<HashMap<u64, Arc<Core>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Owner {
    pub fn new(sink: Sink) -> Arc<Owner> {
        Arc::new(Owner {
            sink,
            cores: Mutex::default(),
        })
    }

    /// Runs `method` if it is the owner's and answers through `reply`; false (and `reply` dropped) when it is not.
    pub fn handle(self: &Arc<Self>, method: &str, params: &Value, reply: Reply) -> bool {
        let generation = params["generation"].as_u64();
        let invalid = |message: &str| Err(("invalid".to_owned(), message.to_owned()));
        match method {
            "core.start" => {
                let (Some(generation), Some(binary)) = (generation, params["binary"].as_str())
                else {
                    reply(invalid("core.start needs a generation and a binary"));
                    return true;
                };
                let env: Vec<(String, String)> = params["env"]
                    .as_object()
                    .map(|env| {
                        env.iter()
                            .filter_map(|(key, value)| {
                                Some((key.clone(), value.as_str()?.to_owned()))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                self.start(generation, binary, params["cwd"].as_str(), &env, reply);
            }
            "core.abandon" | "core.stop" => {
                let Some(generation) = generation else {
                    reply(invalid("needs a generation"));
                    return true;
                };
                if let Some(core) = lock(&self.cores).get(&generation).cloned() {
                    if method == "core.abandon" {
                        kill_tree(&core);
                    } else {
                        stop(core);
                    }
                }
                reply(Ok(json!({})));
            }
            _ => return false,
        }
        true
    }

    /// The owner's own end: closes every core's stdin and returns once each is gone (killed with its tree when it
    /// still ran 5 s later, so a core that stopped answering cannot outlive its owner with what it runs).
    pub fn end_all(&self) {
        for core in lock(&self.cores).values() {
            stop(Arc::clone(core));
        }
        while !lock(&self.cores).is_empty() {
            thread::sleep(EXIT_POLL);
        }
    }

    /// Spawns the core and answers `{pid}` once it said `ready` (its listeners are bound by then) or ended before;
    /// a core that could not run is answered with why.
    fn start(
        self: &Arc<Self>,
        generation: u64,
        binary: &str,
        cwd: Option<&str>,
        env: &[(String, String)],
        reply: Reply,
    ) {
        if lock(&self.cores).contains_key(&generation) {
            reply(Err((
                "failed".into(),
                format!("generation {generation} already runs"),
            )));
            return;
        }
        let mut command = Command::new(binary);
        command
            .env_clear()
            .envs(env.iter().map(|(key, value)| (key, value)))
            .env("OMPDESK_STDIO_OWNER", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Main's working folder, as a core main spawned had it.
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        // POSIX: the core leads a process group of its own, which every git it starts joins. Windows: a console of its
        // own with no window (`CREATE_NO_WINDOW`: a console its children share, none the person sees, and none the
        // owner's Ctrl+C reaches) in a process group of its own (`CREATE_NEW_PROCESS_GROUP`).
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(
            &mut command,
            0x0800_0000 | 0x0000_0200,
        );
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                reply(Err((
                    "failed".into(),
                    format!("ompdesk-core could not run: {error}"),
                )));
                return;
            }
        };
        let pid = child.id();
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            let _ = child.kill();
            reply(Err(("failed".into(), "ompdesk-core has no stdio".into())));
            return;
        };
        let core = Arc::new(Core {
            pid,
            child: Mutex::new(child),
            stdin: Mutex::new(Some(stdin)),
        });
        lock(&self.cores).insert(generation, Arc::clone(&core));
        thread::spawn(move || {
            // Its first line is `ready`, written after its listeners are bound: main connects on this answer.
            let mut stdout = BufReader::new(stdout);
            let mut ready = String::new();
            let _ = stdout.read_line(&mut ready);
            reply(Ok(json!({ "pid": pid })));
            let _ = std::io::copy(&mut stdout, &mut std::io::sink());
        });
        let sink = Arc::clone(&self.sink);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                sink(
                    "core.stderr",
                    json!({"generation": generation, "line": line}),
                );
            }
        });
        let owner = Arc::clone(self);
        thread::spawn(move || owner.watch(generation, core));
    }

    /// Waits for the core's exit, reports it, then settles its process group and reports that.
    fn watch(&self, generation: u64, core: Arc<Core>) {
        let status = loop {
            // The guard is dropped before the sleep: held across it, this loop starved `stop`'s and `kill_tree`'s
            // lock of the child on Linux, so a stopped core was never killed.
            let polled = lock(&core.child).try_wait();
            match polled {
                Ok(Some(status)) => break Some(status),
                Ok(None) => thread::sleep(EXIT_POLL),
                Err(_) => break None,
            }
        };
        let code = status.and_then(|status| status.code());
        #[cfg(unix)]
        let signal =
            status.and_then(|status| std::os::unix::process::ExitStatusExt::signal(&status));
        #[cfg(not(unix))]
        let signal: Option<i32> = None;
        (self.sink)(
            "core.ended",
            json!({"generation": generation, "code": code, "signal": signal.map(signal_name)}),
        );
        let empty = group_gone(core.pid);
        lock(&self.cores).remove(&generation);
        (self.sink)(
            "core.gone",
            json!({"generation": generation, "empty": empty}),
        );
    }
}

/// Closes the core's stdin (it answers what it holds and exits) and kills its tree if it still runs 5 s later.
fn stop(core: Arc<Core>) {
    if lock(&core.stdin).take().is_none() {
        return;
    }
    thread::spawn(move || {
        let deadline = Instant::now() + STOP_KILL;
        while Instant::now() < deadline {
            if !matches!(lock(&core.child).try_wait(), Ok(None)) {
                return;
            }
            thread::sleep(EXIT_POLL);
        }
        kill_tree(&core);
    });
}

/// Kills the core and every process it started: its process group on POSIX, the core alone (its job) on Windows.
fn kill_tree(core: &Core) {
    #[cfg(unix)]
    {
        // SAFETY: signals a process group this owner made; ESRCH (nothing left) is fine.
        #[allow(unsafe_code)]
        unsafe {
            libc::kill(-(core.pid as i32), libc::SIGKILL)
        };
    }
    #[cfg(not(unix))]
    {
        let _ = lock(&core.child).kill();
    }
}

/// After the core exited: kills what is left of its group and waits until none of it exists (true), or false after
/// `GROUP_GONE`. Windows: true at once.
fn group_gone(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let pgid = -(pid as i32);
        // SAFETY: signals a process group this owner made.
        #[allow(unsafe_code)]
        let alive = || unsafe {
            libc::kill(pgid, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        };
        // SAFETY: as above.
        #[allow(unsafe_code)]
        unsafe {
            libc::kill(pgid, libc::SIGKILL)
        };
        let started = Instant::now();
        let mut pause = Duration::from_millis(5);
        while alive() {
            if started.elapsed() >= GROUP_GONE {
                return false;
            }
            thread::sleep(pause);
            pause = (pause * 2).min(Duration::from_millis(200));
        }
        true
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

/// Node's name for a signal, as `ChildProcess`' `close` gave it.
fn signal_name(signal: i32) -> String {
    #[cfg(unix)]
    {
        match signal {
            libc::SIGHUP => "SIGHUP",
            libc::SIGINT => "SIGINT",
            libc::SIGQUIT => "SIGQUIT",
            libc::SIGILL => "SIGILL",
            libc::SIGABRT => "SIGABRT",
            libc::SIGBUS => "SIGBUS",
            libc::SIGFPE => "SIGFPE",
            libc::SIGKILL => "SIGKILL",
            libc::SIGSEGV => "SIGSEGV",
            libc::SIGPIPE => "SIGPIPE",
            libc::SIGTERM => "SIGTERM",
            _ => return format!("SIG{signal}"),
        }
        .to_owned()
    }
    #[cfg(not(unix))]
    {
        format!("SIG{signal}")
    }
}

/// Where a connection's frames go: one writer thread over `out` with an unbounded queue, so a reader that stops reading
/// (main blocked in a hub wait) never stalls the threads that drain a core's stderr, or the core blocks on its next
/// diagnostic line. `None` ends the writer.
pub type Frames = std::sync::mpsc::Sender<Option<Value>>;

pub fn writer(mut out: impl Write + Send + 'static) -> (Frames, thread::JoinHandle<()>) {
    let (frames, queue) = std::sync::mpsc::channel::<Option<Value>>();
    let writer = thread::spawn(move || {
        while let Ok(Some(frame)) = queue.recv() {
            if writeln!(out, "{frame}").and_then(|()| out.flush()).is_err() {
                break;
            }
        }
    });
    (frames, writer)
}

/// An event as a frame.
pub fn event(event: &str, data: Value) -> Value {
    json!({"event": event, "data": data})
}

/// Main's requests over one connection, one JSON object per line both ways, until `input` ends.
pub fn serve_lines(owner: &Arc<Owner>, input: impl BufRead, frames: &Frames) {
    for line in input.lines() {
        let Ok(line) = line else { break };
        let Ok(request) = serde_json::from_str::<Value>(line.trim_end()) else {
            eprintln!("ompdesk core owner: skipped a line that is not a request");
            continue;
        };
        let id = request["id"].clone();
        let answer = frames.clone();
        let reply: Reply = Box::new(move |result| {
            let _ = answer.send(Some(match result {
                Ok(value) => json!({"id": id, "ok": true, "result": value}),
                Err((code, message)) => {
                    json!({"id": id, "ok": false, "error": {"code": code, "message": message}})
                }
            }));
        });
        let method = request["method"].as_str().unwrap_or_default();
        if !owner.handle(method, &request["params"], reply) {
            let _ = frames.send(Some(json!({
                "id": request["id"],
                "ok": false,
                "error": {"code": "unsupported", "message": format!("unknown method {method}")},
            })));
        }
    }
}

/// `ompdesk-core --own`: the owner over this process's stdio. Its stdin's end stops every core and returns once all
/// are gone.
pub fn serve_stdio() -> i32 {
    let (frames, writer) = writer(std::io::stdout());
    let events = frames.clone();
    let owner = Owner::new(Arc::new(move |name: &str, data: Value| {
        let _ = events.send(Some(event(name, data)));
    }));
    serve_lines(&owner, BufReader::new(std::io::stdin()), &frames);
    owner.end_all();
    let _ = frames.send(None);
    let _ = writer.join();
    0
}
