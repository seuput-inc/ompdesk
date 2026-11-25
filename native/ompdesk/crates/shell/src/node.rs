//! The Node process that runs the TypeScript main (`out/main/index.js`), started with an open stdin pipe the shell
//! holds: Node exits when the shell dies and the pipe closes (the repo's child-process rule).

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde_json::json;

use crate::log::log;

pub struct NodeChild {
    child: Child,
    _stdin: ChildStdin,
}

static NODE: Mutex<Option<NodeChild>> = Mutex::new(None);

/// Where `node` is: packaged `<resources>/node/node(.exe)`, else env `OMPDESK_NODE`, else `node` on PATH.
pub fn node_program(packaged: bool, resources: &Path) -> PathBuf {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    if packaged {
        return resources.join("node").join(exe);
    }
    match std::env::var("OMPDESK_NODE") {
        Ok(path) if !path.is_empty() => PathBuf::from(path),
        _ => PathBuf::from("node"),
    }
}

/// The main script: env `OMPDESK_APP_ENTRY` (an absolute path; the e2e harness runs pinned snapshots), else
/// `<appDir>/out/main/index.js`.
pub fn entry_script(app_dir: &Path) -> PathBuf {
    match std::env::var("OMPDESK_APP_ENTRY") {
        Ok(path) if !path.is_empty() => PathBuf::from(path),
        _ => app_dir.join("out").join("main").join("index.js"),
    }
}

pub fn spawn(
    program: &Path,
    entry: &Path,
    args: &[String],
    socket: &str,
    token: &str,
) -> io::Result<()> {
    let mut command = Command::new(program);
    if std::env::var("OMP_GUI_TEST_NODE_INSPECT").as_deref() == Ok("1") {
        command.arg("--inspect=127.0.0.1:0");
    }
    command
        .arg(entry)
        .args(args)
        .env("OMPDESK_SHELL_SOCKET", socket)
        .env("OMPDESK_SHELL_TOKEN", token)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window for the console-subsystem node.exe of a GUI app (CREATE_NO_WINDOW).
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn()?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("no stdin pipe"))?;
    log(
        "node.spawned",
        json!({ "pid": child.id(), "program": program.display().to_string(), "entry": entry.display().to_string() }),
    );
    *NODE.lock().unwrap() = Some(NodeChild {
        child,
        _stdin: stdin,
    });
    Ok(())
}

/// Waits for Node to end (on its own thread); `on_exit` gets its exit code (`None` when killed by a signal).
pub fn watch(on_exit: impl FnOnce(Option<i32>) + Send + 'static) {
    std::thread::Builder::new()
        .name("node-watch".into())
        .spawn(move || {
            // The child stays in NODE while we wait on a clone-free handle: poll its status.
            loop {
                let status = {
                    let mut guard = NODE.lock().unwrap();
                    match guard.as_mut() {
                        Some(node) => node.child.try_wait(),
                        None => return,
                    }
                };
                match status {
                    Ok(Some(status)) => {
                        log("node.exited", exit_fields(&status));
                        return on_exit(status.code());
                    }
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                    Err(error) => {
                        log("node.exited", json!({ "error": error.to_string() }));
                        return on_exit(None);
                    }
                }
            }
        })
        .expect("node watch thread");
}

/// How Node ended, for the log: its exit code, or on POSIX the signal that ended it.
fn exit_fields(status: &std::process::ExitStatus) -> serde_json::Value {
    #[cfg(unix)]
    let signal = std::os::unix::process::ExitStatusExt::signal(status);
    #[cfg(not(unix))]
    let signal: Option<i32> = None;
    json!({ "code": status.code(), "signal": signal })
}

/// Waits for an accepted exit without closing stdin ahead of its reply; otherwise asks Node to stop through stdin.
pub fn stop(grace: std::time::Duration) {
    let Some(mut node) = NODE.lock().unwrap().take() else {
        return;
    };
    let _stdin = if crate::lifecycle::EXITING.load(std::sync::atomic::Ordering::SeqCst) {
        Some(node._stdin)
    } else {
        drop(node._stdin);
        None
    };
    let deadline = std::time::Instant::now() + grace;
    while std::time::Instant::now() < deadline {
        if let Ok(Some(status)) = node.child.try_wait() {
            log("node.stopped", exit_fields(&status));
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let _ = node.child.kill();
    let status = node.child.wait();
    log(
        "node.killed",
        json!({ "graceMs": grace.as_millis() as u64, "exit": status.as_ref().map(exit_fields).ok() }),
    );
}
