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
//!
//! A session handed to a paired computer (`remote::handoff` on the receiving side) is a tombstone here too, carrying
//! the transfer: pending from before the first byte crosses until the other computer confirms it took the session
//! (the tombstone then names its path there) or durably refused it (the entry goes). Pending blocks every revival
//! like any tombstone, so this computer never runs a writer on a session the other one may own.

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
    /// The session was handed to a paired computer (`session-mutations.ts` `handOffSession`), not deleted.
    handoff: Option<Handoff>,
}

/// A hand-over of this computer's session to the paired computer `device`, under the transfer `id`. While `to` is
/// `None` the transfer is pending: who owns the session is not known yet, so it blocks every revival as a tombstone
/// does (the file stays here) until that computer confirms it took it (`to`, its path there) or durably refused it
/// (the entry goes and the session is this computer's again).
#[derive(Clone, Debug, PartialEq)]
struct Handoff {
    id: String,
    device: String,
    to: Option<String>,
}

impl Tombstone {
    fn json(&self) -> Value {
        // An integral time is written as an integer, as `JSON.stringify` wrote `Date.now()`.
        let at = if self.at.fract() == 0.0 && self.at.abs() < 9e15 {
            json!(self.at as i64)
        } else {
            json!(self.at)
        };
        let mut value = match &self.device {
            Some(device) => json!({ "path": self.path, "device": device, "at": at }),
            None => json!({ "path": self.path, "at": at }),
        };
        if let Some(handoff) = &self.handoff {
            let mut moved = json!({ "id": handoff.id, "device": handoff.device });
            if let Some(to) = &handoff.to {
                moved["to"] = json!(to);
            }
            value["handoff"] = moved;
        }
        value
    }
}

fn handoff_of(item: &Value) -> Option<Handoff> {
    let handoff = item.get("handoff")?;
    let text = |name: &str| {
        handoff
            .get(name)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    Some(Handoff {
        id: text("id")?,
        device: text("device")?,
        to: text("to"),
    })
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
                    handoff: handoff_of(&item),
                },
            );
        }
        store
    }

    fn get(&self, path: &str, device: Option<&str>) -> Option<&Tombstone> {
        self.entries.get(&key(path, device))
    }

    fn add(&mut self, path: &str, device: Option<&str>, at: f64) {
        self.insert(path, device, at, None);
        self.save();
    }

    fn insert(&mut self, path: &str, device: Option<&str>, at: f64, handoff: Option<Handoff>) {
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
                handoff,
            },
        );
        // A pending hand-over never ages out: forgetting it would let the session run here while the other computer
        // may own it.
        while self.order.len() > MAX_TOMBSTONES {
            let Some(at) = self.order.iter().position(|key| {
                !self
                    .entries
                    .get(key)
                    .is_some_and(|entry| entry.handoff.as_ref().is_some_and(|h| h.to.is_none()))
            }) else {
                break;
            };
            let oldest = self.order.remove(at);
            self.entries.remove(&oldest);
        }
    }

    /// Records that this computer's session at `path` is being handed to `device` under the transfer `id`, saved
    /// before anything crosses: an error leaves no record, and the hand-over must not start.
    fn begin_handoff(&mut self, path: &str, id: &str, device: &str, at: f64) -> Result<(), Fault> {
        if self.get(path, None).is_some() {
            return Err(Fault::new(
                "session_deleted",
                "The session was deleted or handed to another computer",
            ));
        }
        let handoff = Handoff {
            id: id.to_owned(),
            device: device.to_owned(),
            to: None,
        };
        self.insert(path, None, at, Some(handoff));
        if let Err(fault) = self.save_checked() {
            self.remove(path, None);
            return Err(fault);
        }
        Ok(())
    }

    /// Ends the pending transfer `id` of `path`: `to` (the other computer's path) when it took the session, which then
    /// stays a tombstone here; `None` when it durably refused it, which gives the session back. False when `path`
    /// has no pending transfer `id`.
    fn settle_handoff(&mut self, path: &str, id: &str, to: Option<&str>) -> bool {
        let Some(entry) = self.entries.get_mut(&key(path, None)) else {
            return false;
        };
        let Some(handoff) = entry
            .handoff
            .as_mut()
            .filter(|h| h.id == id && h.to.is_none())
        else {
            return false;
        };
        match to {
            Some(to) => {
                handoff.to = Some(to.to_owned());
                self.save();
            }
            None => self.remove(path, None),
        }
        true
    }

    /// The transfers still pending, oldest first.
    fn pending_handoffs(&self) -> Vec<Value> {
        self.order
            .iter()
            .filter_map(|key| self.entries.get(key))
            .filter_map(|entry| {
                let handoff = entry.handoff.as_ref().filter(|h| h.to.is_none())?;
                Some(json!({ "path": entry.path, "id": handoff.id, "device": handoff.device }))
            })
            .collect()
    }

    /// Forgets the tombstone of `path`: a session handed to this computer back at a path it once left from.
    fn remove(&mut self, path: &str, device: Option<&str>) {
        let key = key(path, device);
        if self.entries.remove(&key).is_some() {
            self.order.retain(|known| *known != key);
            self.save();
        }
    }

    fn list(&self) -> Vec<Value> {
        self.order
            .iter()
            .filter_map(|key| self.entries.get(key))
            .map(Tombstone::json)
            .collect()
    }

    fn save(&self) {
        if let Err(fault) = self.save_checked() {
            eprintln!("[deleted-sessions] not saved: {}", fault.message);
        }
    }

    fn save_checked(&self) -> Result<(), Fault> {
        let Some(file) = &self.file else {
            return Ok(());
        };
        let bytes = Value::Array(self.list()).to_string();
        write_kept(file, bytes.as_bytes(), Some(0o600), 0o700).map(|_| ())
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

/// Forgets this computer's tombstone of `path` in the profile's record: a session handed here
/// (`remote::handoff`) lands at a path this computer may once have handed away or deleted, and its index must list it.
pub(crate) fn clear(path: &str) {
    let current = stores().current.clone();
    with(current.as_deref(), |store| store.remove(path, None));
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
    /// A hand-over's paired computer (`handoffBegin`).
    #[serde(default)]
    host: String,
    /// Where that computer keeps the session it took (`handoffSettle`); absent: it refused it.
    #[serde(default)]
    to: Option<String>,
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
            // This computer's session takes its links along; a paired host's file keeps them there.
            if let (Some(file), None) = (file, device) {
                crate::prefs::session_links::drop_session(
                    &crate::prefs::session_links::file_beside(file),
                    &of.path,
                );
            }
            Value::Null
        }
        "handoffBegin" => {
            if of.id.is_empty() || of.host.is_empty() || of.path.is_empty() {
                return Outcome::fault(
                    "invalid_params",
                    "A hand-over needs a path, an id and a computer",
                );
            }
            let at = of.at.unwrap_or_else(now_ms);
            if let Err(fault) = with(file, |store| {
                store.begin_handoff(&of.path, &of.id, &of.host, at)
            }) {
                return Outcome::Now(Err(fault));
            }
            Value::Null
        }
        "handoffSettle" => json!(with(file, |store| store.settle_handoff(
            &of.path,
            &of.id,
            of.to.as_deref()
        ))),
        "handoffsPending" => Value::Array(with(file, |store| store.pending_handoffs())),
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

    #[test]
    fn a_pending_hand_over_blocks_revival_from_disk_until_it_settles() {
        let file = folder("handoff").join("deleted-sessions.json");
        let mut store = Store::load(Some(file.clone()));
        store
            .begin_handoff("/work/a.jsonl", "t1", "mini", 7.0)
            .unwrap();
        // A restart reads the pending transfer back: the session is still blocked here, its file kept.
        let again = Store::load(Some(file.clone()));
        assert!(again.get("/work/a.jsonl", None).is_some());
        let path = node_resolve("/work/a.jsonl");
        assert_eq!(
            again.pending_handoffs(),
            [json!({ "path": path, "id": "t1", "device": "mini" })]
        );
        // A second hand-over or a stale id changes nothing.
        assert!(
            store
                .begin_handoff("/work/a.jsonl", "t2", "mini", 8.0)
                .is_err()
        );
        assert!(!store.settle_handoff("/work/a.jsonl", "t2", None));
        // Refused by the other computer: the session is this computer's again.
        assert!(store.settle_handoff("/work/a.jsonl", "t1", None));
        assert!(store.get("/work/a.jsonl", None).is_none());
        assert!(Store::load(Some(file.clone())).list().is_empty());
        // Taken: a tombstone that names where it went, no longer pending, settled once.
        store
            .begin_handoff("/work/a.jsonl", "t3", "mini", 9.0)
            .unwrap();
        assert!(store.settle_handoff("/work/a.jsonl", "t3", Some("/m/a.jsonl")));
        assert!(!store.settle_handoff("/work/a.jsonl", "t3", None));
        let moved = Store::load(Some(file));
        assert!(moved.get("/work/a.jsonl", None).is_some());
        assert!(moved.pending_handoffs().is_empty());
        assert_eq!(
            moved.list(),
            [
                json!({ "path": path, "at": 9, "handoff": { "id": "t3", "device": "mini", "to": "/m/a.jsonl" } })
            ]
        );
    }

    #[test]
    fn a_pending_hand_over_never_ages_out() {
        let mut store = Store::load(None);
        store
            .begin_handoff("/s/pending.jsonl", "t", "mini", 0.0)
            .unwrap();
        for index in 0..MAX_TOMBSTONES + 5 {
            store.add(&format!("/s/{index}.jsonl"), None, index as f64);
        }
        assert_eq!(store.order.len(), MAX_TOMBSTONES);
        assert!(store.get("/s/pending.jsonl", None).is_some());
        assert!(store.get("/s/0.jsonl", None).is_none());
    }

    #[test]
    fn a_session_handed_back_clears_its_old_tombstone() {
        let mut store = Store::load(None);
        store.add("/work/a.jsonl", None, 1.0);
        store.remove("/work/./a.jsonl", None);
        assert!(store.get("/work/a.jsonl", None).is_none());
    }
}
