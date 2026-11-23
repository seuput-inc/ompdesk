//! `ompdesk keep`: a command that outlives the process that started it and OMPdesk itself, so an app relaunch never
//! cuts it (B1 of the owner's 20 Nov 2026 list). The bridge uses it for a session's background bash jobs: their
//! command runs here, its output goes to a file the job reads, and after a relaunch the next omp reads the same file.
//!
//! A run is a folder the caller made, holding `spec.json` (`{"argv": [...], "cwd": "..."}`). `keep start DIR` starts
//! the runner detached (its own session on Unix; on Windows outside the caller's console, process group and job, as
//! `ompdesk check`'s runner) and returns once the command started. The runner writes `pid`, appends the command's
//! stdout and stderr to `output.log`, and writes `exit` (the exit code, `-1` without one) when it ends. `keep cancel
//! DIR` asks the runner to end the command and its children (`cancel`); a cancelled run's `exit` is `-1`.

use std::fs;
use std::io;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::sys::child_command;

/// How often the runner looks for the command's end and a cancel.
const POLL: Duration = Duration::from_millis(100);
/// How long `start` waits for the runner to start the command.
const START_WAIT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
struct Spec {
    argv: Vec<String>,
    cwd: Option<String>,
}

pub fn command(rest: &[String]) -> i32 {
    match (rest.first().map(String::as_str), rest.get(1)) {
        (Some("start"), Some(dir)) => start(Path::new(dir)),
        (Some("cancel"), Some(dir)) => {
            let _ = fs::write(Path::new(dir).join("cancel"), "");
            0
        }
        (Some("--runner"), Some(dir)) => run(Path::new(dir)),
        _ => {
            eprintln!(
                "usage: ompdesk keep start DIR | keep cancel DIR (DIR holds spec.json: argv, cwd)"
            );
            crate::cli::EXIT_USAGE
        }
    }
}

/// Writes `text` to `dir/name` so a reader never sees half of it.
fn write_whole(dir: &Path, name: &str, text: &str) -> io::Result<()> {
    let part = dir.join(format!("{name}.part"));
    fs::write(&part, text)?;
    fs::rename(part, dir.join(name))
}

fn start(dir: &Path) -> i32 {
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => {
            eprintln!("ompdesk keep: {error}");
            return 1;
        }
    };
    let args = vec![
        "keep".to_owned(),
        "--runner".to_owned(),
        dir.to_string_lossy().into_owned(),
    ];
    #[cfg(unix)]
    let started = {
        let mut command = child_command(&exe);
        command
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::sys::child_defaults(&mut command, true);
        command.spawn().map(|_| ())
    };
    #[cfg(windows)]
    let started = crate::sys::spawn_detached(&exe, &args, None).map(drop);
    if let Err(error) = started {
        eprintln!("ompdesk keep: cannot start the runner: {error}");
        return 1;
    }
    let until = Instant::now() + START_WAIT;
    while Instant::now() < until {
        if dir.join("pid").exists() || dir.join("exit").exists() {
            return 0;
        }
        std::thread::sleep(POLL);
    }
    eprintln!("ompdesk keep: the runner did not start the command within {START_WAIT:?}");
    1
}

/// The runner: starts the command, waits for its end or a cancel, and writes how it ended.
fn run(dir: &Path) -> i32 {
    let code = match run_command(dir) {
        Ok(code) => code,
        Err(error) => {
            let _ = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("output.log"))
                .and_then(|mut log| {
                    io::Write::write_all(&mut log, format!("ompdesk keep: {error}\n").as_bytes())
                });
            -1
        }
    };
    let _ = write_whole(dir, "exit", &code.to_string());
    0
}

fn run_command(dir: &Path) -> io::Result<i32> {
    let spec: Spec = serde_json::from_str(&fs::read_to_string(dir.join("spec.json"))?)
        .map_err(|error| io::Error::other(format!("spec.json: {error}")))?;
    let (program, args) = spec
        .argv
        .split_first()
        .ok_or_else(|| io::Error::other("spec.json: argv is empty"))?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("output.log"))?;
    let mut command = child_command(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    if let Some(cwd) = &spec.cwd {
        command.current_dir(cwd);
    }
    #[cfg(unix)]
    crate::sys::child_defaults(&mut command, true);
    let mut child = command.spawn()?;
    write_whole(dir, "pid", &child.id().to_string())?;
    let mut cancelled = false;
    loop {
        if let Some(status) = child.try_wait()? {
            if cancelled {
                return Ok(-1);
            }
            #[cfg(unix)]
            if let Some(signal) = std::os::unix::process::ExitStatusExt::signal(&status) {
                return Ok(128 + signal);
            }
            return Ok(status.code().unwrap_or(-1));
        }
        if !cancelled && dir.join("cancel").exists() {
            cancelled = true;
            end_tree(child.id());
        }
        std::thread::sleep(POLL);
    }
}

/// Ends the command and what it started.
#[cfg(unix)]
fn end_tree(pid: u32) {
    crate::sys::signal_group(pid, libc::SIGTERM);
    std::thread::sleep(Duration::from_secs(2));
    crate::sys::signal_group(pid, libc::SIGKILL);
}

#[cfg(windows)]
fn end_tree(pid: u32) {
    let _ = child_command("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ompdesk-keep-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn spec(dir: &Path, script: &str) {
        let argv: Vec<&str> = if cfg!(windows) {
            vec!["cmd", "/c", script]
        } else {
            vec!["sh", "-c", script]
        };
        fs::write(
            dir.join("spec.json"),
            serde_json::json!({ "argv": argv }).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn keeps_the_output_and_the_exit_code() {
        let dir = folder("exit");
        spec(&dir, "echo kept-output && exit 3");
        assert_eq!(run(&dir), 0);
        assert_eq!(fs::read_to_string(dir.join("exit")).unwrap(), "3");
        assert!(
            fs::read_to_string(dir.join("output.log"))
                .unwrap()
                .contains("kept-output")
        );
        assert!(dir.join("pid").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cancel_ends_the_command_and_reads_as_no_exit_code() {
        let dir = folder("cancel");
        spec(
            &dir,
            if cfg!(windows) {
                "ping -n 60 127.0.0.1 >NUL"
            } else {
                "sleep 60"
            },
        );
        let runner = {
            let dir = dir.clone();
            std::thread::spawn(move || run(&dir))
        };
        while !dir.join("pid").exists() {
            std::thread::sleep(POLL);
        }
        let asked = Instant::now();
        assert_eq!(
            command(&["cancel".into(), dir.to_string_lossy().into_owned()]),
            0
        );
        runner.join().unwrap();
        assert!(asked.elapsed() < Duration::from_secs(30));
        assert_eq!(fs::read_to_string(dir.join("exit")).unwrap(), "-1");
        let _ = fs::remove_dir_all(&dir);
    }
}
