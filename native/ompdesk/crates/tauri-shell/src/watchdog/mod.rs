//! Observes Node without calling it or the UI thread, including while either is blocked.
mod engine;
mod marker;
mod sample;

use crate::{host::Call, lifecycle::EXITING};
use engine::Engine;
use serde::Deserialize;
use serde_json::Value;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const INTERVAL: Duration = Duration::from_secs(1);
const MARKER: &str = "main-thread-hang.json";

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Signal {
    Start { pid: std::num::NonZeroU32 },
    Heartbeat,
    Step { phase: String, step: String },
    Suspend,
    Resume,
    Shutdown,
}

// One authenticated Node connection and one main per shell lifetime. Shutdown is terminal.
static SENDER: OnceLock<Sender<Signal>> = OnceLock::new();

fn marker_path(profile: &Path) -> PathBuf {
    profile.join("logs").join(MARKER)
}

pub(crate) fn consume_reports(profile: &Path) -> Value {
    marker::consume_reports(&marker_path(profile))
}

pub(crate) fn handle(mut call: Call, profile: &Path) {
    let Ok(signal) = serde_json::from_value(std::mem::take(&mut call.params)) else {
        return call.err("invalid", "invalid watchdog signal");
    };
    if let Signal::Start { pid } = signal {
        if SENDER.get().is_none() {
            let marker = marker_path(profile);
            let (tx, rx) = mpsc::channel();
            // The host socket has a single reader. Neither sampling nor file writes run on it.
            if let Err(error) = std::thread::Builder::new()
                .name("main-watchdog".into())
                .spawn(move || watch(pid.get(), &marker, rx))
            {
                return call.err("failed", error.to_string());
            }
            let _ = SENDER.set(tx);
        }
    } else if let Some(tx) = SENDER.get() {
        let _ = tx.send(signal);
    }
    call.ok(Value::Null);
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn record(engine: &Engine, path: &Path) -> io::Result<()> {
    let logs = path.parent().expect("watchdog marker parent");
    std::fs::create_dir_all(logs)?;
    let mut temp = tempfile::NamedTempFile::new_in(logs)?;
    serde_json::to_writer(temp.as_file_mut(), &engine.marker(epoch_ms()))?;
    // Unlike tempfile's MoveFileExW, std::fs::rename can replace a marker open for reading.
    let temp = temp.into_temp_path().keep()?;
    std::fs::rename(&temp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

fn watch(pid: u32, path: &Path, rx: Receiver<Signal>) {
    let mut engine = Engine::new(epoch_ms(), pid);
    let mut tick = Instant::now() + INTERVAL;
    let mut before: Option<(Instant, sample::Sample)> = None;
    loop {
        let deadline = before
            .as_ref()
            .map_or(tick, |(start, _)| tick.min(*start + INTERVAL));
        let signal = rx.recv_timeout(deadline.saturating_duration_since(Instant::now()));
        if EXITING.load(Ordering::Acquire) {
            return;
        }
        let now = epoch_ms();
        match signal {
            Ok(Signal::Shutdown) | Err(RecvTimeoutError::Disconnected) => return,
            Ok(Signal::Step { phase, step }) => engine.step(&phase, &step),
            Ok(Signal::Heartbeat) if engine.heartbeat(now) => {
                let _ = record(&engine, path);
            }
            Ok(Signal::Suspend) => engine.suspend(),
            Ok(Signal::Resume) => engine.resume(now),
            _ => {}
        }
        let instant = Instant::now();
        if instant >= tick {
            tick = instant + INTERVAL;
            if engine.tick(now) {
                let _ = record(&engine, path);
                before = sample::read(pid).map(|s| (Instant::now(), s));
            }
        }
        if before
            .as_ref()
            .is_some_and(|(start, _)| start.elapsed() >= INTERVAL)
            && let Some((start, first)) = before.take()
            && let Some(last) = sample::read(pid)
        {
            engine.machine(sample::facts(&first, &last, start.elapsed()));
            let _ = record(&engine, path);
        }
    }
}

#[cfg(all(test, any(target_os = "macos", windows)))]
mod tests;
