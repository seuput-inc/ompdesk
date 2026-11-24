//! `<userData>/window-state.json`: the geometry every new app window starts from, written when an app window closes.
//! The shape is the Node app's electron-store file (`{"windowState": {x, y, width, height, isMaximized}}`, other keys
//! kept), so a file either app wrote opens in the other. It is read once; from then on the copy here is what new windows
//! start from. A save that finds the disk or its quota full keeps that copy, leaves the old file as it is and tries
//! again on the 5 s doubling to a minute of `disk::saves` and `atomic-file.ts`; Node hears `store.saveFailed` and
//! `store.saved` for the one disk-full notice, as SafeStore told it.

use serde::Serialize;
use serde_json::{Value, json};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use crate::{host, log, profile_file};

const DEFAULT_WIDTH: f64 = 1400.0;
const DEFAULT_HEIGHT: f64 = 900.0;
pub const MIN_WIDTH: f64 = 800.0;
pub const MIN_HEIGHT: f64 = 600.0;
/// Each further live app window opens this much further down and right: all of them share one saved geometry, and N
/// windows on the same rectangle look like one.
const CASCADE: f64 = 28.0;
/// Waits between tries while the disk stays full; the last one repeats.
const RETRY_MS: [u64; 5] = [5_000, 10_000, 20_000, 40_000, 60_000];

#[derive(Debug, PartialEq)]
pub struct Saved {
    pub position: Option<(f64, f64)>,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

/// What the file says, as electron-store's `get("windowState", {width: 1400, height: 900})` read it.
fn saved(doc: &Value) -> Saved {
    let state = &doc["windowState"];
    Saved {
        position: state["x"].as_f64().zip(state["y"].as_f64()),
        width: state["width"].as_f64().unwrap_or(DEFAULT_WIDTH),
        height: state["height"].as_f64().unwrap_or(DEFAULT_HEIGHT),
        maximized: state["isMaximized"] == true,
    }
}

/// The `win.create` geometry `window_bounds::for_create` places on the displays, for a window opened while `live` app
/// windows are open.
pub fn create_options(saved: &Saved, live: usize) -> Value {
    let mut options = json!({"width": saved.width, "height": saved.height});
    if let Some((x, y)) = saved.position {
        let offset = live as f64 * CASCADE;
        options["x"] = json!(x + offset);
        options["y"] = json!(y + offset);
        options["restoreBounds"] = json!(true);
    }
    options
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Closed {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(rename = "isMaximized")]
    pub maximized: bool,
}

#[derive(Debug, PartialEq)]
enum Outcome {
    /// On disk; `waited` when an earlier save had been waiting for space.
    Written { waited: bool },
    /// The disk is full; `first` when nothing waited before.
    Full { first: bool },
    /// Any other failure: nothing waits any more, as SafeStore gave up on it.
    Failed { waited: bool, error: String },
}

struct Store {
    file: PathBuf,
    doc: Value,
    /// Tries made while the disk stays full; `None` when nothing waits.
    waiting: Option<usize>,
}

fn disk_full(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded
    )
}

impl Store {
    fn open(file: PathBuf) -> Store {
        // conf's `clearInvalidConfig`: an unreadable file starts empty.
        let doc = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        Store {
            file,
            doc,
            waiting: None,
        }
    }

    fn set(&mut self, closed: &Closed, write: &dyn Fn(&Path, &[u8]) -> io::Result<()>) -> Outcome {
        self.doc["windowState"] = json!(closed);
        self.write(write)
    }

    fn write(&mut self, write: &dyn Fn(&Path, &[u8]) -> io::Result<()>) -> Outcome {
        let mut bytes = Vec::new();
        let mut serializer = serde_json::Serializer::with_formatter(
            &mut bytes,
            serde_json::ser::PrettyFormatter::with_indent(b"\t"),
        );
        self.doc
            .serialize(&mut serializer)
            .expect("a JSON value serializes");
        match write(&self.file, &bytes) {
            Ok(()) => Outcome::Written {
                waited: self.waiting.take().is_some(),
            },
            Err(error) if disk_full(&error) => {
                let first = self.waiting.is_none();
                self.waiting.get_or_insert(0);
                Outcome::Full { first }
            }
            Err(error) => Outcome::Failed {
                waited: self.waiting.take().is_some(),
                error: error.to_string(),
            },
        }
    }

    /// How long to wait before the next try, counting this one; `None` when nothing waits.
    fn next_wait(&mut self) -> Option<Duration> {
        let tries = self.waiting.as_mut()?;
        let ms = RETRY_MS[(*tries).min(RETRY_MS.len() - 1)];
        *tries += 1;
        Some(Duration::from_millis(ms))
    }
}

/// Replaces `file` in one step: a temp file beside it, renamed over it.
fn write_file(file: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = file.parent().ok_or_else(|| io::Error::other("no folder"))?;
    std::fs::create_dir_all(dir)?;
    let mut temp = tempfile::NamedTempFile::new_in(dir)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    profile_file::persist(temp, file)
}

static STORE: LazyLock<Mutex<Store>> = LazyLock::new(|| {
    Mutex::new(Store::open(
        crate::runtime().user_data.join("window-state.json"),
    ))
});

fn store() -> MutexGuard<'static, Store> {
    STORE.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn read() -> Saved {
    saved(&store().doc)
}

/// Saves the geometry of an app window that closes.
pub fn save(closed: &Closed) {
    let mut store = store();
    let outcome = store.set(closed, &write_file);
    let file = store.file.clone();
    drop(store);
    report(&file, outcome);
}

fn report(file: &Path, outcome: Outcome) {
    let named = json!({"file": file.to_string_lossy()});
    match outcome {
        Outcome::Written { waited: false } => {}
        Outcome::Written { waited: true } => host::event("store.saved", named),
        Outcome::Full { first: false } => {}
        Outcome::Full { first: true } => {
            host::event("store.saveFailed", named);
            std::thread::spawn(retry);
        }
        Outcome::Failed { waited, error } => {
            log::log(
                "window_state.save_failed",
                json!({"file": file.to_string_lossy(), "error": error}),
            );
            if waited {
                host::event("store.saved", named);
            }
        }
    }
}

/// Tries the waiting content again until it lands or a newer save, or a failure, ends the wait. One lock covers each
/// write, so a retry never lands older content over a newer save.
fn retry() {
    loop {
        let Some(wait) = store().next_wait() else {
            return;
        };
        std::thread::sleep(wait);
        let mut store = store();
        if store.waiting.is_none() {
            return;
        }
        let outcome = store.write(&write_file);
        let file = store.file.clone();
        drop(store);
        if matches!(outcome, Outcome::Full { .. }) {
            continue;
        }
        return report(&file, outcome);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn closed(maximized: bool) -> Closed {
        Closed {
            x: 10.0,
            y: 20.0,
            width: 1000.0,
            height: 700.0,
            maximized,
        }
    }

    #[test]
    fn a_file_the_node_app_wrote_opens_as_it_was_saved() {
        let doc = json!({"windowState": {"x": 30, "y": 40, "width": 1200, "height": 800, "isMaximized": true}});
        assert_eq!(
            saved(&doc),
            Saved {
                position: Some((30.0, 40.0)),
                width: 1200.0,
                height: 800.0,
                maximized: true
            }
        );
        assert_eq!(
            saved(&json!({})),
            Saved {
                position: None,
                width: 1400.0,
                height: 900.0,
                maximized: false
            }
        );
    }

    #[test]
    fn each_live_window_moves_the_next_one_28_px_down_and_right() {
        let at = saved(&json!({"windowState": {"x": 100, "y": 50, "width": 1200, "height": 800}}));
        assert_eq!(
            create_options(&at, 0),
            json!({"width": 1200.0, "height": 800.0, "x": 100.0, "y": 50.0, "restoreBounds": true})
        );
        assert_eq!(create_options(&at, 2)["x"], 156.0);
        assert_eq!(create_options(&at, 2)["y"], 106.0);
        // Never placed: the OS places it, whatever else is open.
        assert_eq!(
            create_options(&saved(&json!({})), 3),
            json!({"width": 1400.0, "height": 900.0})
        );
    }

    #[test]
    fn a_save_keeps_the_files_other_keys_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("window-state.json");
        std::fs::write(
            &file,
            r#"{"other": 1, "windowState": {"width": 5, "height": 5}}"#,
        )
        .unwrap();
        let mut store = Store::open(file.clone());
        assert_eq!(
            store.set(&closed(true), &write_file),
            Outcome::Written { waited: false }
        );
        let doc: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(doc["other"], 1);
        assert_eq!(
            saved(&doc),
            Saved {
                position: Some((10.0, 20.0)),
                width: 1000.0,
                height: 700.0,
                maximized: true
            }
        );
        std::fs::write(&file, "not json").unwrap();
        assert_eq!(Store::open(file).doc, json!({}));
    }

    #[test]
    fn a_full_disk_keeps_the_newest_geometry_and_tries_on_the_backoff() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("window-state.json");
        let mut store = Store::open(file.clone());
        let full =
            |_: &Path, _: &[u8]| -> io::Result<()> { Err(io::ErrorKind::StorageFull.into()) };
        assert_eq!(
            store.set(&closed(false), &full),
            Outcome::Full { first: true }
        );
        assert_eq!(
            store.set(&closed(true), &full),
            Outcome::Full { first: false }
        );
        assert!(!file.exists());
        assert!(saved(&store.doc).maximized);
        let waits: Vec<u64> = (0..6)
            .map(|_| store.next_wait().unwrap().as_millis() as u64)
            .collect();
        assert_eq!(waits, [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
        let written = Cell::new(0);
        let lands = |path: &Path, bytes: &[u8]| {
            written.set(written.get() + 1);
            write_file(path, bytes)
        };
        assert_eq!(store.write(&lands), Outcome::Written { waited: true });
        assert_eq!(written.get(), 1);
        assert_eq!(store.next_wait(), None);
        let doc: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(doc["windowState"]["isMaximized"], true);
        let broken = |_: &Path, _: &[u8]| -> io::Result<()> { Err(io::Error::other("denied")) };
        assert_eq!(
            store.set(&closed(false), &full),
            Outcome::Full { first: true }
        );
        assert!(matches!(
            store.set(&closed(false), &broken),
            Outcome::Failed { waited: true, .. }
        ));
        assert_eq!(store.next_wait(), None);
    }
}
