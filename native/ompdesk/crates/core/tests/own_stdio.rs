//! `ompdesk-core --own` keeps only its stdio of what its starter handed it. On Windows a process starts with every
//! inheritable handle of its parent, and libuv's spawn makes a child's pipe ends inheritable until its CreateProcess
//! returned: main's worker spawning `--own` beside a spawn of main's thread handed `--own` that other child's pipe
//! ends, so that child's output never ended while main lived (`sys::relaunch_with_only_stdio`).
#![cfg(windows)]
#![allow(unsafe_code)]

use std::io::Read;
use std::os::windows::io::AsRawHandle;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn SetHandleInformation(handle: *mut std::ffi::c_void, mask: u32, flags: u32) -> i32;
}

/// A pipe whose write end is inheritable, as another child's is while its spawn runs, and the read end's EOF.
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

fn owner(args: &[&str]) -> Child {
    Command::new(env!("CARGO_BIN_EXE_ompdesk-core"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("ompdesk-core --own starts")
}

/// Ends an owner through its stdin and waits until its stdout ends: the owner itself, wherever it runs, is gone.
fn end(mut owner: Child) {
    drop(owner.stdin.take());
    let mut sink = Vec::new();
    owner
        .stdout
        .take()
        .expect("stdout")
        .read_to_end(&mut sink)
        .expect("its stdout ends");
    owner.wait().expect("exits");
}

#[test]
fn a_pipe_inheritable_while_the_owner_starts_is_not_held_by_the_owner() {
    // One test, not two: a pipe made inheritable here would reach any process another test thread starts meanwhile.

    // The control: an owner served where it started (`stdio-only` skips the relaunch) holds the stray pipe it got.
    let (ended, write) = stray_pipe();
    let held = owner(&["--own", "stdio-only"]);
    drop(write);
    assert!(
        ended.recv_timeout(Duration::from_millis(500)).is_err(),
        "the control owner did not hold the inheritable pipe: the test no longer reproduces the leak"
    );
    end(held);
    ended
        .recv_timeout(Duration::from_secs(10))
        .expect("the pipe ends with the owner that held it");

    // `--own` as main starts it: the relaunched owner runs on, and the pipe ends while it does.
    let (ended, write) = stray_pipe();
    let running = owner(&["--own"]);
    drop(write);
    // Its stdin is still open, so the owner still runs while the pipe ends.
    ended
        .recv_timeout(Duration::from_secs(10))
        .expect("the owner main started kept another process's pipe open");
    end(running);
}
