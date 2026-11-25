//! The preference files (`<userData>/prefs.json` and `sidebar-device-order.json`; was
//! `src/main/safe-store.ts` over `electron-store`): the core is their one owner. Main reads and changes them through
//! the hub (`src/main/prefs-store.ts`), so a read in the same tick as a change sees it, as conf's did.
//!
//! - **Memory first.** A file is read once and held; every call answers from what is held. A file that changed on
//!   disk since the core last read or wrote it (a person's edit while OMPdesk runs, as conf read the file on every
//!   call) is read again before the call, unless a change of the core's own is still on its way to disk.
//! - **Writes leave the caller's thread.** A change marks the file and hands it to one writer thread, which writes
//!   the newest whole content (`JSON.stringify(store, undefined, "\t")`, conf's format) through
//!   `disk::saves::write_kept`: a full disk or quota keeps the content and tries again, and main hears
//!   `store.saveFailed`/`store.saved` (`core-saves.ts`). A rename Windows holds back never holds main's thread or the
//!   hub's. Another failure is logged; the next change writes the whole content again.
//! - **Exit.** `flush` waits for the writer before the core exits, so a change main made before it closed the core's
//!   stdin is on disk.
//! - **Migrations.** `prefs.json` is migrated each time it is read from disk (`retired.rs`), before any caller sees
//!   it; a migration that changed something is written like any change.
//!
//! Hub kind `prefs` (no state per instance): `get {file, key}` → `{value}` or `{}` when nothing is there, `has`,
//! `set {file, key, value}`, `delete {file, key}`, `store {file}` → the whole store, `replace {file, value}`.
//! The owners of single keys, each a read, change and write under the file's one lock (`launch_profile.rs`,
//! `sidebar.rs`): `launchProfile {file, cwd}` → the profile, `updateLaunchProfile {file, cwd, patch}` → the profile
//! stored, `launchFlags {file, cwd}` → a spawn's flags, `updateSidebar {file, change, from}` → `{change, log}` (both
//! null when nothing moved), `moveSidebarPin {file, from, to}` → whether a pin moved.

mod launch_profile;
mod path;
mod powers;
mod retired;
mod sidebar;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard, mpsc};
use std::time::{Duration, Instant, SystemTime};

use serde::Deserialize;
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};

use crate::disk::saves::{disk_full, waiting_content, write_kept};
use crate::hub::{Kind, Out, Outcome, params, post};
use crate::server::Fault;

pub use path::{Part, parts_of};

/// A file's length and change time, to tell that someone else wrote it.
type Stamp = (u64, Option<SystemTime>);

struct State {
    store: Map<String, Value>,
    /// What the file was when the core last read or wrote it; `None` before the first read.
    seen: Option<Option<Stamp>>,
    /// A change not yet handed to the disk.
    dirty: bool,
    writing: bool,
}

struct Prefs {
    file: PathBuf,
    state: Mutex<State>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn stamp(file: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(file).ok()?;
    Some((meta.len(), meta.modified().ok()))
}

/// The store a file holds: nothing for a file that is not there, a fault for one that is not a JSON object.
fn read(file: &Path) -> Result<Map<String, Value>, Fault> {
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => {
            return Err(Fault::new("io", format!("{}: {error}", file.display())));
        }
    };
    match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
        Ok(Value::Object(store)) => Ok(store),
        _ => Err(Fault::new(
            "invalid_json",
            format!("The config file `{}` is not valid JSON.", file.display()),
        )),
    }
}

impl Prefs {
    /// The held store, read again when the file changed under the core.
    fn current(self: &Arc<Self>) -> Result<MutexGuard<'_, State>, Fault> {
        let mut state = lock(&self.state);
        let now = stamp(&self.file);
        let settled = !state.dirty && !state.writing && waiting_content(&self.file).is_none();
        if state.seen.is_none() || (settled && state.seen != Some(now)) {
            state.store = read(&self.file)?;
            state.seen = Some(now);
            let migrated = self.file.file_name() == Some(std::ffi::OsStr::new("prefs.json"))
                && self
                    .file
                    .parent()
                    .is_some_and(|dir| retired::migrate(&mut state.store, dir));
            if migrated && !state.dirty {
                state.dirty = true;
                hand_to_writer(Arc::clone(self));
            }
        }
        Ok(state)
    }

    fn changed(self: &Arc<Self>, mut state: MutexGuard<'_, State>) {
        if state.dirty {
            return;
        }
        state.dirty = true;
        drop(state);
        hand_to_writer(Arc::clone(self));
    }

    fn save(&self) {
        let mut state = lock(&self.state);
        if !state.dirty {
            return;
        }
        let text = document(&state.store);
        state.dirty = false;
        state.writing = true;
        drop(state);
        let result = write_kept(&self.file, text.as_bytes(), None, 0o777);
        let mut state = lock(&self.state);
        state.writing = false;
        state.seen = Some(stamp(&self.file));
        drop(state);
        if let Err(fault) = result
            && !disk_full(&fault)
        {
            eprintln!(
                "ompdesk-core: {} could not be saved: {}",
                self.file.display(),
                fault.message
            );
        }
    }
}

/// `JSON.stringify(store, undefined, "\t")`.
fn document(store: &Map<String, Value>) -> String {
    let mut bytes = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
    let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, formatter);
    store
        .serialize(&mut serializer)
        .expect("a JSON map always serializes");
    String::from_utf8(bytes).expect("serde_json writes UTF-8")
}

static FILES: LazyLock<Mutex<HashMap<PathBuf, Arc<Prefs>>>> = LazyLock::new(Mutex::default);

fn prefs(file: &str) -> Result<Arc<Prefs>, Fault> {
    let file = PathBuf::from(file);
    if !file.is_absolute() {
        return Err(Fault::new(
            "invalid_params",
            "a preference file is named by its absolute path",
        ));
    }
    let mut files = lock(&FILES);
    Ok(Arc::clone(files.entry(file.clone()).or_insert_with(|| {
        Arc::new(Prefs {
            file,
            state: Mutex::new(State {
                store: Map::new(),
                seen: None,
                dirty: false,
                writing: false,
            }),
        })
    })))
}

/// Files handed to the writer and not yet saved, to wait for at exit.
static OWED: LazyLock<(Mutex<usize>, Condvar)> = LazyLock::new(Default::default);

static WRITER: LazyLock<Mutex<mpsc::Sender<Arc<Prefs>>>> = LazyLock::new(|| {
    let (send, receive) = mpsc::channel::<Arc<Prefs>>();
    std::thread::Builder::new()
        .name("prefs-writer".into())
        .spawn(move || {
            for prefs in receive {
                prefs.save();
                let (owed, settled) = &*OWED;
                *lock(owed) -= 1;
                settled.notify_all();
            }
        })
        .expect("the prefs writer thread starts");
    Mutex::new(send)
});

fn hand_to_writer(prefs: Arc<Prefs>) {
    *lock(&OWED.0) += 1;
    if lock(&WRITER).send(prefs).is_err() {
        *lock(&OWED.0) -= 1;
    }
}

/// Waits until every change handed to the writer is saved (or kept for a full disk), at most `limit`.
pub fn flush(limit: Duration) {
    let deadline = Instant::now() + limit;
    let (owed, settled) = &*OWED;
    let mut owed = lock(owed);
    while *owed > 0 {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return;
        }
        owed = settled
            .wait_timeout(owed, left)
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .0;
    }
}

// ---- operations ---------------------------------------------------------------------------------------------------

/// `conf.get(key)` on `store`: the value, `None` when nothing is there.
fn read_key(store: &Map<String, Value>, key: &str) -> Result<Option<Value>, Fault> {
    Ok(parts_of(key)?.and_then(|parts| {
        if parts.first() == Some(&Part::Key(path::INTERNAL_KEY.into())) {
            return None;
        }
        path::get(store, &parts).cloned()
    }))
}

/// `conf.set(key, value)` on `store`.
fn write_key(store: &mut Map<String, Value>, key: &str, value: Value) -> Result<(), Fault> {
    if path::is_reserved(key) {
        return Err(path::reserved_fault());
    }
    match parts_of(key)? {
        Some(parts) => path::set(store, key, &parts, value),
        None => Ok(()),
    }
}

/// `conf.delete(key)` on `store`.
fn remove_key(store: &mut Map<String, Value>, key: &str) -> Result<(), Fault> {
    if path::is_reserved(key) {
        return Err(path::reserved_fault());
    }
    if let Some(parts) = parts_of(key)? {
        path::delete(store, &parts);
    }
    Ok(())
}

pub fn get(file: &str, key: &str) -> Result<Option<Value>, Fault> {
    read_key(&prefs(file)?.current()?.store, key)
}

pub fn set(file: &str, key: &str, value: Value) -> Result<(), Fault> {
    let prefs = prefs(file)?;
    let mut state = prefs.current()?;
    write_key(&mut state.store, key, value)?;
    prefs.changed(state);
    Ok(())
}

pub fn delete(file: &str, key: &str) -> Result<(), Fault> {
    let prefs = prefs(file)?;
    let mut state = prefs.current()?;
    remove_key(&mut state.store, key)?;
    prefs.changed(state);
    Ok(())
}

/// Reads the value at `key`, lets `change` decide the next one (`None`: leave it), writes it and answers the value now
/// held, all under the file's one lock: no other change of this file lands between the read and the write. For a
/// native caller that patches a stored blob (the sidebar's `moveSidebarPin`/`updateSidebarPrefs` once they move).
/// Main's own patches already read and write in one tick of its thread, which nothing else writes in.
pub fn update(
    file: &str,
    key: &str,
    change: impl FnOnce(Option<&Value>) -> Option<Value>,
) -> Result<Option<Value>, Fault> {
    let prefs = prefs(file)?;
    let mut state = prefs.current()?;
    let current = read_key(&state.store, key)?;
    let Some(next) = change(current.as_ref()) else {
        return Ok(current);
    };
    write_key(&mut state.store, key, next.clone())?;
    prefs.changed(state);
    let (file, key) = (file.to_string(), key.to_string());
    post(move || tell_changed(&file, &key));
    Ok(Some(next))
}

/// The whole store, without conf's bookkeeping.
pub fn store(file: &str) -> Result<Map<String, Value>, Fault> {
    let prefs = prefs(file)?;
    let mut store = prefs.current()?.store.clone();
    store.shift_remove(path::INTERNAL_KEY);
    Ok(store)
}

/// Replaces the whole store; conf's bookkeeping, if the file has any, stays.
pub fn replace(file: &str, mut value: Map<String, Value>) -> Result<(), Fault> {
    let prefs = prefs(file)?;
    let mut state = prefs.current()?;
    value.shift_remove(path::INTERNAL_KEY);
    if let Some(internal) = state.store.get(path::INTERNAL_KEY).cloned() {
        value.insert(path::INTERNAL_KEY.into(), internal);
    }
    state.store = value;
    prefs.changed(state);
    Ok(())
}

/// The agent-power migration (`powers.rs`) on `file`, once per profile; its report, or `None` when it had run.
pub fn migrate_powers(file: &str, agent_dir: &Path) -> Result<Option<powers::Report>, Fault> {
    let prefs = prefs(file)?;
    let mut state = prefs.current()?;
    let report = powers::migrate(&mut state.store, agent_dir)?;
    if report.is_some() {
        prefs.changed(state);
    }
    Ok(report)
}

// ---- the hub kind -------------------------------------------------------------------------------------------------

thread_local! {
    /// Main's open prefs instances (on the hub thread): told of a change main did not make, so its copies of the core's
    /// answers (`prefs-store.ts`) drop what the change reached.
    static LISTENERS: std::cell::RefCell<Vec<Out>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn tell_changed(file: &str, key: &str) {
    LISTENERS.with(|listeners| {
        for out in listeners.borrow().iter() {
            out.push(&json!({ "k": "changed", "file": file, "key": key }));
        }
    });
}

pub const KIND: Kind = Kind {
    name: "prefs",
    open: |_, _, out| {
        LISTENERS.with(|listeners| listeners.borrow_mut().push(out));
        Ok(())
    },
    call,
    close: |id| LISTENERS.with(|listeners| listeners.borrow_mut().retain(|out| out.id() != id)),
};

#[derive(Deserialize)]
struct Of {
    file: String,
    #[serde(default)]
    key: String,
}

#[derive(Deserialize)]
struct Write {
    file: String,
    key: String,
    value: Value,
}

#[derive(Deserialize)]
struct Replace {
    file: String,
    value: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Powers {
    file: String,
    agent_dir: PathBuf,
}

/// A key owner's call: what the page or a peer sent stays raw, for its owner to check.
#[derive(Deserialize)]
struct Owned {
    file: String,
    #[serde(default)]
    cwd: Value,
    #[serde(default)]
    patch: Value,
    #[serde(default)]
    change: Value,
    #[serde(default)]
    from: String,
    #[serde(default)]
    to: String,
}

fn call(_: u64, method: &str, raw: &RawValue) -> Outcome {
    let done = match method {
        "get" => params::<Of>(raw).and_then(|of| {
            get(&of.file, &of.key).map(|value| match value {
                Some(value) => json!({ "value": value }),
                None => json!({}),
            })
        }),
        "has" => {
            params::<Of>(raw).and_then(|of| get(&of.file, &of.key).map(|v| json!(v.is_some())))
        }
        "set" => {
            params::<Write>(raw).and_then(|w| set(&w.file, &w.key, w.value).map(|()| Value::Null))
        }
        "delete" => {
            params::<Of>(raw).and_then(|of| delete(&of.file, &of.key).map(|()| Value::Null))
        }
        "store" => params::<Of>(raw).and_then(|of| store(&of.file).map(Value::Object)),
        "replace" => {
            params::<Replace>(raw).and_then(|r| replace(&r.file, r.value).map(|()| Value::Null))
        }
        "migratePowers" => params::<Powers>(raw)
            .and_then(|p| migrate_powers(&p.file, &p.agent_dir).map(|report| json!(report))),
        "launchProfile" => params::<Owned>(raw)
            .and_then(|o| launch_profile::get(&o.file, &o.cwd).map(Value::Object)),
        "updateLaunchProfile" => params::<Owned>(raw)
            .and_then(|o| launch_profile::update(&o.file, &o.cwd, &o.patch).map(Value::Object)),
        "launchFlags" => params::<Owned>(raw).and_then(|o| {
            launch_profile::flags(&o.file, o.cwd.as_str().unwrap_or_default())
                .map(|flags| json!(flags))
        }),
        "updateSidebar" => params::<Owned>(raw).and_then(|o| {
            sidebar::update(&o.file, &o.change, &o.from).map(|applied| json!(applied))
        }),
        "moveSidebarPin" => params::<Owned>(raw)
            .and_then(|o| sidebar::move_pin(&o.file, &o.from, &o.to).map(|moved| json!(moved))),
        _ => Err(Fault::new("no_method", format!("prefs has no {method}"))),
    };
    Outcome::Now(done)
}
