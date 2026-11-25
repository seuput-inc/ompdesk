//! The person's queued messages, kept across their omp's death and an app relaunch (Orca's held queue; MapSessionsWire
//! U2 and U3). Stock omp holds its steering and follow-up lanes in memory only, so a crash, a restart or a quit with
//! messages still queued lost them silently.
//!
//! Each running omp keeps one entry: the texts of its last non-empty `queue_update` (per lane, oldest first), the
//! session it belongs to and when. The lane notes every `queue_update` of its live omp; only stock's queue no longer
//! listing a message while that omp lives lets it go (delivered, removed, or withdrawn by Stop, whose
//! `abort_and_restore_queue` the renderer restores itself). A turn's end or an exit proves nothing: once the lane tore
//! its omp down (`cleanup`: a crash, a restart, a sleep, a close, the quit) the omp's owner is released, and nothing it
//! says afterwards changes its entry, because a shutdown that empties the queue is exactly the loss kept here.
//!
//! An entry whose owner is gone is offered once: the first `queue_take_held` of a tab on that session takes it out
//! (and the file with it), so another window, device, a late exit or the next relaunch never offers it again. The
//! taker holds it in the restored tray; nothing is sent by itself.
//!
//! A queued message the field is editing (U3) is held the same way under the owner `edit:<token>` with a lease the
//! editor renews (`EDIT_LEASE_MS`, Orca's 120 s): taken out of stock's queue it would be lost with a window that
//! closed mid-edit; once the lease lapses it is offered like any other entry.
//!
//! Picture-only messages (stock's `[Image]` chip) carry no content and are left out; a message's pictures are not kept
//! (stock's lanes are text only).
//!
//! Kept in `<userData>/held-queue.json` (0600, a JSON array, newest `MAX_ENTRIES`, none older than `MAX_AGE_MS`),
//! written whenever an entry changes, off the lane (`spawn_blocking`), so a save never delays a Stop, and through
//! `write_kept`: a full disk keeps the content and tries again. Never written in a quit hook.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::queue_commands::Step;
use crate::disk::saves::{waiting_content, write_kept};
use crate::server::Fault;

pub(super) const MAX_ENTRIES: usize = 100;
pub(super) const MAX_AGE_MS: u64 = 3 * 24 * 60 * 60 * 1000;
pub(super) const EDIT_LEASE_MS: u64 = 120_000;
/// Stock's text for a picture-only queued message: no content of its own.
const IMAGE_ONLY: &str = "[Image]";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Lanes {
    #[serde(default)]
    pub steering: Vec<String>,
    #[serde(default)]
    pub follow_up: Vec<String>,
}

impl Lanes {
    fn is_empty(&self) -> bool {
        self.steering.is_empty() && self.follow_up.is_empty()
    }

    fn without_pictures(mut self) -> Lanes {
        self.steering.retain(|text| text != IMAGE_ONLY);
        self.follow_up.retain(|text| text != IMAGE_ONLY);
        self
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    session: String,
    owner: String,
    #[serde(flatten)]
    lanes: Lanes,
    at: u64,
    /// An edit's lease: not offered before this time. 0 for a running omp's entry.
    #[serde(default)]
    until: u64,
}

#[derive(Default)]
struct Store {
    entries: Vec<Entry>,
    /// Owners whose omp runs now (in memory: after a relaunch every entry's omp is gone).
    live: HashSet<String>,
    /// Owners whose omp the lane let go: nothing they say changes their entry any more.
    released: HashSet<String>,
    /// A save is scheduled and has not read the entries yet.
    saving: bool,
}

impl Store {
    fn load(file: Option<&Path>, now: u64) -> Store {
        let mut store = Store::default();
        if let Some(file) = file {
            // What waits for room on a full disk is newer than the file; a damaged file holds nothing.
            store.entries = waiting_content(file)
                .or_else(|| std::fs::read(file).ok())
                .and_then(|bytes| serde_json::from_slice::<Vec<Value>>(&bytes).ok())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|item| serde_json::from_value::<Entry>(item).ok())
                .collect();
        }
        store.prune(now);
        store
    }

    fn prune(&mut self, now: u64) -> bool {
        let before = self.entries.len();
        self.entries
            .retain(|entry| now.saturating_sub(entry.at) < MAX_AGE_MS && !entry.lanes.is_empty());
        let over = self.entries.len().saturating_sub(MAX_ENTRIES);
        self.entries.drain(..over);
        self.entries.len() != before
    }

    fn position(&self, owner: &str) -> Option<usize> {
        self.entries.iter().position(|entry| entry.owner == owner)
    }

    /// Replaces `owner`'s entry (it becomes the newest); true when anything changed.
    fn put(&mut self, entry: Entry) -> bool {
        if let Some(at) = self.position(&entry.owner) {
            let old = &self.entries[at];
            if old.session == entry.session && old.lanes == entry.lanes && old.until == entry.until {
                return false;
            }
            self.entries.remove(at);
        }
        self.entries.push(entry);
        true
    }

    fn remove(&mut self, owner: &str) -> bool {
        self.position(owner)
            .map(|at| self.entries.remove(at))
            .is_some()
    }

    fn note(&mut self, session: &str, owner: &str, lanes: Lanes, now: u64) -> bool {
        if self.released.contains(owner) {
            return false;
        }
        self.live.insert(owner.to_owned());
        let lanes = lanes.without_pictures();
        if lanes.is_empty() {
            return self.remove(owner);
        }
        self.put(Entry {
            session: session.to_owned(),
            owner: owner.to_owned(),
            lanes,
            at: now,
            until: 0,
        })
    }

    fn release(&mut self, owner: &str) {
        self.live.remove(owner);
        self.released.insert(owner.to_owned());
    }

    fn take(&mut self, session: &str, now: u64) -> Lanes {
        let mut taken = Lanes::default();
        let live = &self.live;
        self.entries.retain(|entry| {
            let offered = entry.session == session && !live.contains(&entry.owner) && entry.until <= now;
            if offered {
                taken.steering.extend(entry.lanes.steering.iter().cloned());
                taken.follow_up.extend(entry.lanes.follow_up.iter().cloned());
            }
            !offered
        });
        taken
    }
}

static STORES: LazyLock<Mutex<HashMap<Option<PathBuf>, Store>>> = LazyLock::new(Mutex::default);
/// One save at a time, each reading the entries when it writes: the last write holds the newest state.
static WRITES: Mutex<()> = Mutex::new(());

fn stores() -> MutexGuard<'static, HashMap<Option<PathBuf>, Store>> {
    STORES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Runs `work` on `file`'s store and saves it when `work` says it changed.
fn with<T>(file: Option<&Path>, now: u64, work: impl FnOnce(&mut Store) -> (T, bool)) -> T {
    let key = file.map(Path::to_path_buf);
    let (value, save) = {
        let mut stores = stores();
        let store = stores
            .entry(key.clone())
            .or_insert_with(|| Store::load(file, now));
        let (value, changed) = work(store);
        let changed = store.prune(now) || changed;
        let save = changed && !store.saving && key.is_some();
        if save {
            store.saving = true;
        }
        (value, save)
    };
    if let (true, Some(file)) = (save, key) {
        let flush = move || flush(&file);
        // The lane never waits on the disk: a slow or full one must not hold a Stop behind it.
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => drop(runtime.spawn_blocking(flush)),
            Err(_) => flush(),
        }
    }
    value
}

fn flush(file: &Path) {
    let _turn = WRITES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let bytes = {
        let mut stores = stores();
        let Some(store) = stores.get_mut(&Some(file.to_path_buf())) else {
            return;
        };
        store.saving = false;
        serde_json::to_vec(&store.entries).unwrap_or_default()
    };
    if let Err(fault) = write_kept(file, &bytes, Some(0o600), 0o700) {
        eprintln!("[held-queue] not saved: {}", fault.message);
    }
}

/// This core process: an owner from an earlier one (a relaunch) is never live.
static BOOT: LazyLock<String> = LazyLock::new(|| {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    format!("{}-{nanos:x}", std::process::id())
});

/// The owner of a running omp's entry.
pub(super) fn spawn_owner(tab: &str, spawn_id: u64) -> String {
    format!("omp:{}:{tab}:{spawn_id}", *BOOT)
}

/// The running omp's queue changed (`queue_update`).
pub(super) fn note(file: Option<&Path>, session: &str, owner: &str, lanes: Lanes, now: u64) {
    with(file, now, |store| ((), store.note(session, owner, lanes, now)));
}

/// The lane tore `owner`'s omp down: its entry is offered from now on.
pub(super) fn release(file: Option<&Path>, owner: &str, now: u64) {
    with(file, now, |store| {
        store.release(owner);
        ((), false)
    });
}

/// The `queue_take_held` and `queue_hold` commands; `None` for any other.
pub(super) fn command(
    command: &Value,
    file: Option<&Path>,
    session: Option<&str>,
    now: u64,
) -> Option<Step> {
    let error = |message: &str| Some(Step::Fail(Fault::new("queue_error", message)));
    match command["type"].as_str()? {
        "queue_take_held" => {
            let taken = session.map_or_else(Lanes::default, |session| {
                with(file, now, |store| {
                    let taken = store.take(session, now);
                    let changed = !taken.is_empty();
                    (taken, changed)
                })
            });
            let wire = |texts: Vec<String>| {
                Value::Array(texts.into_iter().map(|text| json!({ "text": text })).collect())
            };
            Some(Step::Done(
                json!({ "steering": wire(taken.steering), "followUp": wire(taken.follow_up) }),
            ))
        }
        "queue_hold" => {
            let Some(token) = command["token"].as_str().filter(|token| !token.is_empty()) else {
                return error("token must be a non-empty string");
            };
            let owner = format!("edit:{token}");
            // No text: the edit ended (saved or cancelled) and let the message go.
            let Some(text) = command["text"].as_str() else {
                with(file, now, |store| ((), store.remove(&owner)));
                return Some(Step::Done(json!({ "held": false })));
            };
            let lanes = match command["lane"].as_str() {
                Some("steering") => Lanes {
                    steering: vec![text.to_owned()],
                    ..Lanes::default()
                },
                Some("followUp") => Lanes {
                    follow_up: vec![text.to_owned()],
                    ..Lanes::default()
                },
                _ => return error("lane must be \"steering\" or \"followUp\""),
            };
            let Some(session) = session else {
                return error("The tab has no session yet");
            };
            with(file, now, |store| {
                let changed = store.put(Entry {
                    session: session.to_owned(),
                    owner,
                    lanes,
                    at: now,
                    until: now + EDIT_LEASE_MS,
                });
                ((), changed)
            });
            Some(Step::Done(json!({ "held": true })))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lanes(steering: &[&str], follow_up: &[&str]) -> Lanes {
        Lanes {
            steering: steering.iter().map(|text| (*text).to_owned()).collect(),
            follow_up: follow_up.iter().map(|text| (*text).to_owned()).collect(),
        }
    }

    fn folder(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-held-queue-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn take(file: Option<&Path>, session: &str, now: u64) -> Value {
        match command(&json!({"type": "queue_take_held"}), file, Some(session), now) {
            Some(Step::Done(value)) => value,
            _ => panic!("take must answer"),
        }
    }

    #[test]
    fn an_exit_keeps_the_last_queue_and_it_is_offered_once_also_after_a_relaunch() {
        let path = folder("exit").join("held-queue.json");
        let file = Some(path.as_path());
        let owner = spawn_owner("t1", 1);
        note(file, "/s/a.jsonl", &owner, lanes(&["one", "[Image]"], &["two"]), 10);
        // While the omp lives its queue is stock's: nothing is offered.
        assert_eq!(take(file, "/s/a.jsonl", 11)["steering"], json!([]));
        release(file, &owner, 12);
        // A shutdown that empties the queue after the lane let the omp go changes nothing.
        note(file, "/s/a.jsonl", &owner, Lanes::default(), 13);
        // A relaunch reads the file: no owner of an earlier process is live.
        let relaunched = Store::load(file, 14);
        assert_eq!(relaunched.entries.len(), 1);
        assert_eq!(relaunched.entries[0].lanes, lanes(&["one"], &["two"]));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(take(file, "/s/other.jsonl", 15)["steering"], json!([]));
        let taken = take(file, "/s/a.jsonl", 15);
        assert_eq!(
            taken,
            json!({"steering": [{"text": "one"}], "followUp": [{"text": "two"}]})
        );
        // Once: a second window, a late exit or the next relaunch finds nothing.
        assert_eq!(take(file, "/s/a.jsonl", 16)["steering"], json!([]));
        note(file, "/s/a.jsonl", &owner, lanes(&["one"], &[]), 17);
        assert_eq!(take(file, "/s/a.jsonl", 18)["steering"], json!([]));
        assert!(Store::load(file, 19).entries.is_empty());
    }

    #[test]
    fn delivery_while_the_omp_lives_clears_the_entry() {
        let mut store = Store::default();
        store.note("/s/a.jsonl", "o1", lanes(&["one", "two"], &[]), 1);
        store.note("/s/a.jsonl", "o1", lanes(&["two"], &[]), 2);
        assert_eq!(store.entries[0].lanes, lanes(&["two"], &[]));
        store.note("/s/a.jsonl", "o1", Lanes::default(), 3);
        assert!(store.entries.is_empty());
        store.note("/s/a.jsonl", "o1", lanes(&["[Image]"], &[]), 4);
        assert!(store.entries.is_empty(), "a picture-only message carries nothing to keep");
        store.release("o1");
        assert!(store.take("/s/a.jsonl", 5).is_empty());
    }

    #[test]
    fn an_edit_hold_waits_for_its_lease_and_goes_with_its_release() {
        let hold = |text: Option<&str>, now| {
            let mut request = json!({"type": "queue_hold", "token": "k1", "lane": "followUp"});
            if let Some(text) = text {
                request["text"] = json!(text);
            }
            assert!(matches!(
                command(&request, None, Some("/s/e.jsonl"), now),
                Some(Step::Done(_))
            ));
        };
        hold(Some("draft"), 1_000);
        assert_eq!(take(None, "/s/e.jsonl", 1_000 + EDIT_LEASE_MS - 1)["followUp"], json!([]));
        // Renewed: the lease runs from the renewal.
        hold(Some("draft"), 60_000);
        assert_eq!(take(None, "/s/e.jsonl", 1_000 + EDIT_LEASE_MS)["followUp"], json!([]));
        assert_eq!(
            take(None, "/s/e.jsonl", 60_000 + EDIT_LEASE_MS)["followUp"],
            json!([{"text": "draft"}])
        );
        hold(Some("again"), 200_000);
        hold(None, 200_001);
        assert_eq!(take(None, "/s/e.jsonl", 900_000)["followUp"], json!([]));
        assert!(matches!(
            command(&json!({"type": "queue_hold", "token": "k1", "lane": "x", "text": "t"}), None, Some("/s"), 1),
            Some(Step::Fail(_))
        ));
        assert!(command(&json!({"type": "queue_remove"}), None, Some("/s"), 1).is_none());
    }

    #[test]
    fn the_journal_is_bounded_by_count_and_age() {
        let mut store = Store::default();
        for index in 0..=MAX_ENTRIES {
            store.note("/s/a.jsonl", &format!("o{index}"), lanes(&["m"], &[]), 1_000);
        }
        store.prune(1_000);
        assert_eq!(store.entries.len(), MAX_ENTRIES);
        assert_eq!(store.entries[0].owner, "o1");
        store.note("/s/a.jsonl", "fresh", lanes(&["m"], &[]), MAX_AGE_MS + 1_000);
        store.prune(MAX_AGE_MS + 1_000);
        assert_eq!(store.entries.len(), 1);
        assert_eq!(store.entries[0].owner, "fresh");
    }
}
