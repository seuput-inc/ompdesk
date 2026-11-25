//! Sessions the user deleted, a tombstone per session file (was `src/main/deleted-sessions.ts`). A deleted session is
//! gone for good: every path that could bring it back as a tab or a row asks here first: a saved layout
//! (`pool::layout`), a turn-resume marker (`resume`), a reopen or a paired device's `tab.open` (`pool`'s `blocked`),
//! the session index and a paired device's question (main, through the hub kind `deleted`).
//!
//! Distinct from a session that was never written: a new session's first turn cut off before stock wrote its file has
//! no file either, but it was never deleted, so its marker still continues it. Only a file someone deleted lands here.
//!
//! Kept in `<userData>/deleted-sessions.json` (0600, a JSON array of `{path, device?, at}`, oldest first); session paths
//! are never reused (each holds its own id), so a tombstone can never hide a different session. Bounded by count; the
//! oldest go first. A tombstone of this computer names its file as node's `path.resolve` spells it, and a question is
//! read the same way; a paired device's path is compared as it came. Saved through `write_kept`: on a full disk the
//! tombstone stays in memory and is saved when there is room.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use crate::agentctl::service::host::node_resolve;
use crate::disk::saves::{waiting_content, write_kept};
use crate::hub::{Kind, Out, Outcome, params};
use crate::server::Fault;

pub const MAX_TOMBSTONES: usize = 2000;

#[derive(Clone, Debug, PartialEq)]
struct Tombstone {
    path: String,
    /// The paired host the session lived on; `None`: this computer.
    device: Option<String>,
    /// When it was deleted, epoch milliseconds.
    at: f64,
}

impl Tombstone {
    fn json(&self) -> Value {
        // An integral time is written as an integer, as `JSON.stringify` wrote `Date.now()`.
        let at = if self.at.fract() == 0.0 && self.at.abs() < 9e15 {
            json!(self.at as i64)
        } else {
            json!(self.at)
        };
        match &self.device {
            Some(device) => json!({ "path": self.path, "device": device, "at": at }),
            None => json!({ "path": self.path, "at": at }),
        }
    }
}

fn key(path: &str, device: Option<&str>) -> String {
    match device {
        Some(device) => format!("{device}\0{path}"),
        None => format!("\0{}", node_resolve(path)),
    }
}

/// One file's tombstones, oldest first.
#[derive(Default)]
struct Store {
    file: Option<PathBuf>,
    order: Vec<String>,
    entries: HashMap<String, Tombstone>,
}

impl Store {
    fn load(file: Option<PathBuf>) -> Store {
        let mut store = Store {
            file,
            ..Store::default()
        };
        let Some(file) = &store.file else {
            return store;
        };
        // No record yet, or a damaged one: nothing was deleted as far as this core knows.
        // What waits for room on a full disk is newer than the file.
        let Some(items) = waiting_content(file)
            .or_else(|| std::fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.as_array().cloned())
        else {
            return store;
        };
        for item in items {
            let Some(path) = item
                .get("path")
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty())
            else {
                continue;
            };
            let device = item
                .get("device")
                .and_then(Value::as_str)
                .filter(|device| !device.is_empty());
            let at = item.get("at").and_then(Value::as_f64).unwrap_or(0.0);
            let key = key(path, device);
            if !store.entries.contains_key(&key) {
                store.order.push(key.clone());
            }
            store.entries.insert(
                key,
                Tombstone {
                    path: path.to_owned(),
                    device: device.map(str::to_owned),
                    at,
                },
            );
        }
        store
    }

    fn get(&self, path: &str, device: Option<&str>) -> Option<&Tombstone> {
        self.entries.get(&key(path, device))
    }

    fn add(&mut self, path: &str, device: Option<&str>, at: f64) {
        let key = key(path, device);
        self.order.retain(|known| *known != key);
        self.order.push(key.clone());
        let path = match device {
            Some(_) => path.to_owned(),
            None => node_resolve(path),
        };
        self.entries.insert(
            key,
            Tombstone {
                path,
                device: device.map(str::to_owned),
                at,
            },
        );
        while self.order.len() > MAX_TOMBSTONES {
            let oldest = self.order.remove(0);
            self.entries.remove(&oldest);
        }
        self.save();
    }

    fn list(&self) -> Vec<Value> {
        self.order
            .iter()
            .filter_map(|key| self.entries.get(key))
            .map(Tombstone::json)
            .collect()
    }

    fn save(&self) {
        let Some(file) = &self.file else { return };
        let bytes = Value::Array(self.list()).to_string();
        if let Err(fault) = write_kept(file, bytes.as_bytes(), Some(0o600), 0o700) {
            eprintln!("[deleted-sessions] not saved: {}", fault.message);
        }
    }
}

struct Stores {
    /// Each file a caller named, read once.
    files: HashMap<Option<PathBuf>, Store>,
    /// The profile's file (`initDeletedSessions`): the one the pool, the layout restore and the resume consult.
    current: Option<PathBuf>,
}

static STORES: LazyLock<Mutex<Stores>> = LazyLock::new(|| {
    Mutex::new(Stores {
        files: HashMap::new(),
        current: None,
    })
});

fn stores() -> MutexGuard<'static, Stores> {
    STORES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn with<T>(file: Option<&Path>, work: impl FnOnce(&mut Store) -> T) -> T {
    let mut stores = stores();
    let file = file.map(Path::to_path_buf);
    let store = stores
        .files
        .entry(file.clone())
        .or_insert_with(|| Store::load(file));
    work(store)
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |since| since.as_millis() as f64)
}

/// Whether the profile's record names the session at `path` (on `device`, or this computer).
pub(crate) fn has(path: &str, device: Option<&str>) -> bool {
    let current = stores().current.clone();
    with(current.as_deref(), |store| {
        store.get(path, device).is_some()
    })
}

/// Records a deletion in the profile's record.
pub(crate) fn add(path: &str, device: Option<&str>) {
    let current = stores().current.clone();
    with(current.as_deref(), |store| {
        store.add(path, device, now_ms())
    });
}

// ---- the hub kind -------------------------------------------------------------------------------------------------

pub const KIND: Kind = Kind {
    name: "deleted",
    open,
    call,
    close: |_| {},
};

#[derive(Deserialize)]
struct Opened {
    /// The profile's file; `null`: memory only.
    current: Option<PathBuf>,
}

/// Main opens the kind naming the profile's record (`initDeletedSessions`), so a core that started again knows it before
/// anything asks. The record is read again (a memory-only one starts empty), as a new `DeletedSessions` read it.
fn open(_: u64, opts: &RawValue, _: Out) -> Result<(), Fault> {
    let opened: Opened = params(opts)?;
    let mut stores = stores();
    stores.files.remove(&opened.current);
    stores.current = opened.current;
    Ok(())
}

#[derive(Deserialize)]
struct Of {
    file: Option<PathBuf>,
    #[serde(default)]
    path: String,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    device: Option<String>,
    #[serde(default)]
    id: String,
    #[serde(default)]
    at: Option<f64>,
}

fn call(_: u64, method: &str, raw: &RawValue) -> Outcome {
    let of: Of = match params(raw) {
        Ok(of) => of,
        Err(fault) => return Outcome::Now(Err(fault)),
    };
    let device = of.device.as_deref();
    let file = of.file.as_deref();
    let value = match method {
        "has" => json!(with(file, |store| store.get(&of.path, device).is_some())),
        // Which of `paths` are deleted: one answer per path, in order (a session list's filter in one call).
        "which" => json!(with(file, |store| of
            .paths
            .iter()
            .map(|path| store.get(path, device).is_some())
            .collect::<Vec<_>>())),
        "at" => with(file, |store| {
            store
                .get(&of.path, device)
                .map_or(Value::Null, |entry| Tombstone::json(entry)["at"].clone())
        }),
        // When the saved session `id` was deleted, on any device (stock names a session file `<time>_<id>.jsonl`).
        "atOfId" => {
            if of.id.is_empty() || of.id.contains(['/', '\\']) {
                Value::Null
            } else {
                let tail = format!("_{}.jsonl", of.id);
                with(file, |store| {
                    store
                        .order
                        .iter()
                        .filter_map(|key| store.entries.get(key))
                        .find(|entry| entry.path.ends_with(&tail))
                        .map_or(Value::Null, |entry| entry.json()["at"].clone())
                })
            }
        }
        "list" => Value::Array(with(file, |store| store.list())),
        "add" => {
            let at = of.at.unwrap_or_else(now_ms);
            with(file, |store| store.add(&of.path, device, at));
            Value::Null
        }
        _ => return Outcome::fault("no_method", format!("deleted has no {method}")),
    };
    Outcome::Now(Ok(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-deleted-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_tombstone_is_kept_per_computer_and_read_back_by_a_new_store() {
        let file = folder("kept").join("deleted-sessions.json");
        let mut store = Store::load(Some(file.clone()));
        store.add("/work/./a.jsonl", None, 1.0);
        store.add("/remote/b.jsonl", Some("dev1"), 2.0);
        assert!(store.get("/work/a.jsonl", None).is_some());
        assert!(store.get("/remote/b.jsonl", None).is_none());
        assert!(store.get("/remote/b.jsonl", Some("dev1")).is_some());
        // A paired device's path is compared as it came, never resolved.
        assert!(store.get("/remote/./b.jsonl", Some("dev1")).is_none());
        let again = Store::load(Some(file.clone()));
        assert_eq!(again.list(), store.list());
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(
            text.contains("\"at\":1,") || text.contains("\"at\":1}"),
            "{text}"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn the_oldest_go_first_and_a_second_delete_is_the_newest() {
        let mut store = Store::load(None);
        for index in 0..MAX_TOMBSTONES {
            store.add(&format!("/s/{index}.jsonl"), Some("d"), index as f64);
        }
        store.add("/s/0.jsonl", Some("d"), 9e9);
        store.add("/s/new.jsonl", Some("d"), 9e9);
        assert_eq!(store.order.len(), MAX_TOMBSTONES);
        assert!(store.get("/s/0.jsonl", Some("d")).is_some());
        assert!(store.get("/s/1.jsonl", Some("d")).is_none());
        assert!(store.get("/s/2.jsonl", Some("d")).is_some());
    }

    #[test]
    fn a_damaged_record_is_an_empty_one_and_bad_entries_are_skipped() {
        let dir = folder("damaged");
        let file = dir.join("deleted-sessions.json");
        std::fs::write(&file, "{not json").unwrap();
        assert!(Store::load(Some(file.clone())).list().is_empty());
        std::fs::write(&file, r#"[{"path":""},{"at":3},7,{"path":"/x/a.jsonl","device":"","at":"late"},{"path":"/x/b.jsonl","device":"d","at":5}]"#).unwrap();
        let store = Store::load(Some(file));
        assert_eq!(
            store.list(),
            [
                json!({ "path": "/x/a.jsonl", "at": 0 }),
                json!({ "path": "/x/b.jsonl", "device": "d", "at": 5 })
            ]
        );
    }
}
