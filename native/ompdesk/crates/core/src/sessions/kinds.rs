//! Which sessions are chats (was `src/main/session-kinds.ts`). Stock omp has no session kind: a chat tab is plain omp
//! started in the GUI's default workspace, so the GUI remembers the ids of the sessions its chat tabs created, and the
//! session list (`sessions.listed`, `sessions.kind`) labels them for the sidebar's Chats section. Sessions the old
//! forked agent wrote carry the label in their header instead (`legacy_chat`).
//!
//! Kept in `<userData>/session-kinds.json` (`{"chat":[id, …]}`, oldest first). Main marks a chat through the hub kind
//! `kinds`, a synchronous call, so a new chat is labelled before the next list is read. Saved through `write_kept`: on a
//! full disk the mark stays in memory and is saved when there is room.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use crate::disk::saves::{waiting_content, write_kept};
use crate::hub::{Kind, Outcome, params};

#[derive(Default)]
struct Chats {
    order: Vec<String>,
    ids: HashSet<String>,
}

impl Chats {
    fn load(file: &Path) -> Chats {
        let mut chats = Chats::default();
        // No record yet, or a damaged one: no chats. What waits for room on a full disk is newer than the file.
        let ids = waiting_content(file)
            .or_else(|| std::fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.get("chat")?.as_array().cloned())
            .unwrap_or_default();
        for id in ids {
            if let Some(id) = id.as_str() {
                chats.add(id);
            }
        }
        chats
    }

    fn add(&mut self, id: &str) -> bool {
        if !self.ids.insert(id.to_owned()) {
            return false;
        }
        self.order.push(id.to_owned());
        true
    }
}

static FILES: LazyLock<Mutex<HashMap<PathBuf, Chats>>> = LazyLock::new(Default::default);

fn files() -> MutexGuard<'static, HashMap<PathBuf, Chats>> {
    FILES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn with<T>(file: &Path, work: impl FnOnce(&mut Chats) -> T) -> T {
    let mut files = files();
    let chats = files
        .entry(file.to_path_buf())
        .or_insert_with(|| Chats::load(file));
    work(chats)
}

/// Which of `ids` the record at `file` names as chats, in order; all false without a record.
pub(crate) fn which(file: Option<&Path>, ids: &[&str]) -> Vec<bool> {
    match file {
        Some(file) => with(file, |chats| {
            ids.iter().map(|id| chats.ids.contains(*id)).collect()
        }),
        None => vec![false; ids.len()],
    }
}

fn mark(file: &Path, id: &str) {
    with(file, |chats| {
        if !chats.add(id) {
            return;
        }
        let bytes = json!({ "chat": chats.order }).to_string();
        if let Err(fault) = write_kept(file, bytes.as_bytes(), None, 0o700) {
            eprintln!("[session-kinds] not saved: {}", fault.message);
        }
    });
}

// ---- the hub kind -------------------------------------------------------------------------------------------------

pub const KIND: Kind = Kind {
    name: "kinds",
    open: |_, _, _| Ok(()),
    call,
    close: |_| {},
};

#[derive(Deserialize)]
struct Marked {
    file: PathBuf,
    id: String,
}

fn call(_: u64, method: &str, raw: &RawValue) -> Outcome {
    match method {
        "mark" => match params::<Marked>(raw) {
            Ok(marked) => {
                mark(&marked.file, &marked.id);
                Outcome::Now(Ok(Value::Null))
            }
            Err(fault) => Outcome::Now(Err(fault)),
        },
        _ => Outcome::fault("no_method", format!("kinds has no {method}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ompdesk-kinds-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("session-kinds.json")
    }

    #[test]
    fn a_marked_chat_is_saved_in_order_and_read_back_by_a_new_core() {
        let file = file("kept");
        std::fs::write(&file, r#"{"chat":["old"]}"#).unwrap();
        mark(&file, "new");
        mark(&file, "old");
        assert_eq!(
            which(Some(&file), &["old", "new", "other"]),
            [true, true, false]
        );
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            r#"{"chat":["old","new"]}"#
        );
        files().remove(&file);
        assert_eq!(which(Some(&file), &["new"]), [true]);
    }

    #[test]
    fn a_damaged_or_missing_record_names_no_chat() {
        let file = file("damaged");
        assert_eq!(which(Some(&file), &["a"]), [false]);
        files().remove(&file);
        std::fs::write(&file, r#"{"chat":"a"}"#).unwrap();
        assert_eq!(which(Some(&file), &["a"]), [false]);
        assert_eq!(which(None, &["a"]), [false]);
    }
}
