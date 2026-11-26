//! `ompdesk-core --own` keeps none of the pipes its starter happened to hand it. On Windows a process starts with every
//! inheritable handle of its parent, and libuv's spawn makes a child's pipe ends inheritable until its CreateProcess
//! returned: main's worker spawning `--own` beside a spawn of main's thread handed `--own` that other child's pipe ends,
//! so that child's output never ended while main lived (`sys::close_inherited_handles`).
#![cfg(windows)]
#![allow(unsafe_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::io::AsRawHandle;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn SetHandleInformation(handle: *mut std::ffi::c_void, mask: u32, flags: u32) -> i32;
}

/// A pipe whose write end is inheritable, as another child's is while its spawn runs, and its read end's EOF.
fn stray_pipe() -> (mpsc::Receiver<()>, std::io::PipeWriter) {
    let (mut read, write) = std::io::pipe().expect("a pipe");
    // SAFETY: `write` is a live handle of this process; only its inherit flag changes.
    assert_ne!(
        unsafe { SetHandleInformation(write.as_raw_handle(), 1, 1) },
        0
    );
    let (ended, end) = mpsc::channel();
    std::thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = read.read_to_end(&mut sink);
        let _ = ended.send(());
    });
    (end, write)
}

/// An owner started as main starts it, with `extra` after `--own`; its stdout as lines.
fn owner(extra: &[&str]) -> (Child, BufReader<ChildStdout>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_ompdesk-core"))
        .arg("--own")
        .args(extra)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("ompdesk-core --own starts");
    let stdout = BufReader::new(child.stdout.take().expect("stdout"));
    (child, stdout)
}

/// The owner still serves: a request gets its answer.
fn answers(owner: &mut Child, stdout: &mut BufReader<ChildStdout>) {
    let stdin = owner.stdin.as_mut().expect("stdin");
    stdin
        .write_all(b"{\"id\":1,\"method\":\"no.such\"}\n")
        .expect("the owner reads");
    let mut line = String::new();
    stdout.read_line(&mut line).expect("the owner answers");
    assert!(
        line.contains("\"unsupported\""),
        "unexpected answer {line:?}"
    );
}

/// Ends an owner through its stdin and waits until its stdout ends.
fn end(mut owner: Child, mut stdout: BufReader<ChildStdout>) {
    drop(owner.stdin.take());
    let mut sink = Vec::new();
    stdout.read_to_end(&mut sink).expect("its stdout ends");
    owner.wait().expect("exits");
}

#[test]
fn a_pipe_inheritable_while_the_owner_starts_is_not_held_by_the_owner() {
    // One test, not two: a pipe made inheritable here would reach any process another test thread starts meanwhile.

    // The control: an owner that keeps what it inherited (`keep-inherited`) holds the stray pipe open.
    let (ended, write) = stray_pipe();
    let (mut held, mut out) = owner(&["keep-inherited"]);
    drop(write);
    answers(&mut held, &mut out);
    assert!(
        ended.recv_timeout(Duration::from_millis(500)).is_err(),
        "the control owner did not hold the inheritable pipe: the test no longer reproduces the leak"
    );
    end(held, out);
    ended
        .recv_timeout(Duration::from_secs(10))
        .expect("the pipe ends with the owner that held it");

    // `--own` as main starts it: the pipe ends while the owner runs on.
    let (ended, write) = stray_pipe();
    let (mut running, mut out) = owner(&[]);
    drop(write);
    ended
        .recv_timeout(Duration::from_secs(10))
        .expect("the owner kept another process's pipe open");
    answers(&mut running, &mut out);
    end(running, out);
}
