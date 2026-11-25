//! The side panel's terminal history (`<userData>/terminal-history/`), so a terminal comes back after the app ends:
//! its scrollback tail and folder. The terminals worker's stdout reader writes it from the scrollback it keeps
//! (`stock/scrollback.rs`) when the worker hands it a checkpoint (`src/main/terminal/history.ts` asks while a terminal
//! changes and at quit), and removes a closed terminal's file. One file per terminal, `<session>-<id>.json`, 0600 in a
//! 0700 folder, where `<session>` is the first 16 hex digits of the SHA-256 of the session file the terminal's tab is
//! on, so a tab finds its terminals by one directory read. Scrollback can hold secrets: a closed terminal's file goes
//! at once (`remove_kept`, with whatever still waited for disk space), and a file nobody saved for 30 days is removed
//! the next time a tab looks.
//!
//! Request: `terminalHistory.list` `{userData, session}` → `[record]` of that session, oldest terminal first.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::disk::saves::{remove_kept, write_kept};
use crate::server::{Fault, Registry, Reply};

pub(crate) const FOLDER: &str = "terminal-history";
/// A file not saved for this long belongs to a tab that never came back.
const STALE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// One terminal as it was last seen; `exited` ones come back exited, never as a running shell. The worker sends it
/// without `history`, which the scrollback adds.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Record {
    pub(crate) session: String,
    pub(crate) id: String,
    /// When the terminal was first opened (ms), which orders a tab's terminals.
    pub(crate) order: f64,
    pub(crate) cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) shell: Option<String>,
    #[serde(default)]
    pub(crate) exited: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
    #[serde(default)]
    pub(crate) history: String,
}

fn session_key(session: &str) -> String {
    crate::hex(&Sha256::digest(session.as_bytes()))[..16].to_owned()
}

/// A terminal id is the worker's UUID; anything else could name a path outside the folder.
fn checked_id(id: &str) -> Result<&str, Fault> {
    if !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        Ok(id)
    } else {
        Err(Fault::new(
            "invalid_params",
            format!("Not a terminal id: {id:?}"),
        ))
    }
}

fn io_fault(error: &std::io::Error, path: &Path) -> Fault {
    Fault::new("io", format!("{error}, '{}'", path.display()))
}

/// Every file of the folder, with its name; none when the folder is not there yet.
fn files(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| Some((entry.file_name().into_string().ok()?, entry.path())))
        .filter(|(name, _)| name.ends_with(".json"))
        .collect()
}

fn remove_id(dir: &Path, id: &str, keep: Option<&Path>) -> Result<(), Fault> {
    let suffix = format!("-{id}.json");
    for (name, path) in files(dir) {
        if name.ends_with(&suffix) && Some(path.as_path()) != keep {
            remove_kept(&path).map_err(|error| io_fault(&error, &path))?;
        }
    }
    Ok(())
}

/// Writes each record, and removes the same terminal's file under another session (its tab moved to another one).
pub(crate) fn save(dir: &Path, records: &[Record]) -> Result<(), Fault> {
    for record in records {
        let id = checked_id(&record.id)?;
        let file = dir.join(format!("{}-{id}.json", session_key(&record.session)));
        let text = serde_json::to_string(record)
            .map_err(|error| Fault::new("internal", error.to_string()))?;
        // A full disk keeps the content and writes it when there is room: the save is not refused for it.
        if let Err(fault) = write_kept(&file, text.as_bytes(), Some(0o600), 0o700)
            && !crate::disk::saves::disk_full(&fault)
        {
            return Err(fault);
        }
        remove_id(dir, id, Some(&file))?;
    }
    Ok(())
}

pub(crate) fn list(dir: &Path, session: &str, now: SystemTime) -> Vec<Record> {
    let prefix = format!("{}-", session_key(session));
    let mut records = Vec::new();
    for (name, path) in files(dir) {
        let saved = fs::metadata(&path).and_then(|meta| meta.modified()).ok();
        if saved.is_some_and(|saved| now.duration_since(saved).is_ok_and(|age| age > STALE)) {
            let _ = remove_kept(&path);
            continue;
        }
        if !name.starts_with(&prefix) {
            continue;
        }
        let record = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Record>(&bytes).ok());
        // The hash names the session; the record says it exactly.
        if let Some(record) = record.filter(|record| record.session == session) {
            records.push(record);
        }
    }
    records.sort_by(|a, b| a.order.total_cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    records
}

pub(crate) fn drop_ids(dir: &Path, ids: &[String]) -> Result<(), Fault> {
    for id in ids {
        remove_id(dir, checked_id(id)?, None)?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    user_data: PathBuf,
    session: String,
}

pub fn register(registry: &mut Registry) {
    registry.add("terminalHistory.list", |call| {
        // Files of up to 256 K each are read on the blocking pool, as `fs.*` does, never holding the core's requests.
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let params: ListParams = call.params()?;
                let dir = params.user_data.join(FOLDER);
                Reply::json(&list(&dir, &params.session, SystemTime::now()))
            })
            .await
            .map_err(|_| Fault::new("internal", "The terminal history call panicked"))?
        })
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ompdesk-core-termhistory-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir.join(FOLDER)
    }

    fn record(session: &str, id: &str, order: f64, history: &str) -> Record {
        Record {
            session: session.into(),
            id: id.into(),
            order,
            cwd: "/work/app".into(),
            shell: Some("/bin/zsh".into()),
            exited: false,
            exit_code: None,
            error: None,
            history: history.into(),
        }
    }

    #[test]
    fn a_session_lists_its_own_terminals_oldest_first_with_cwd_and_history() {
        let dir = temp("list");
        let a2 = record("/s/a.jsonl", "id-2", 20.0, "second\r\n");
        let a1 = record("/s/a.jsonl", "id-1", 10.0, "first\r\n$ ");
        save(
            &dir,
            &[
                a2.clone(),
                a1.clone(),
                record("/s/b.jsonl", "id-3", 5.0, "other"),
            ],
        )
        .unwrap();
        assert_eq!(list(&dir, "/s/a.jsonl", SystemTime::now()), vec![a1, a2]);
        assert!(list(&dir, "/s/none.jsonl", SystemTime::now()).is_empty());
        assert!(list(&temp("missing"), "/s/a.jsonl", SystemTime::now()).is_empty());
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn a_save_replaces_the_terminal_and_follows_its_tab_to_another_session() {
        let dir = temp("move");
        save(&dir, &[record("/s/a.jsonl", "id-1", 1.0, "old")]).unwrap();
        save(&dir, &[record("/s/a.jsonl", "id-1", 1.0, "new")]).unwrap();
        assert_eq!(
            list(&dir, "/s/a.jsonl", SystemTime::now())[0].history,
            "new"
        );
        save(&dir, &[record("/s/b.jsonl", "id-1", 1.0, "moved")]).unwrap();
        assert!(list(&dir, "/s/a.jsonl", SystemTime::now()).is_empty());
        assert_eq!(
            list(&dir, "/s/b.jsonl", SystemTime::now())[0].history,
            "moved"
        );
        assert_eq!(files(&dir).len(), 1);
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn a_dropped_terminal_is_gone_from_disk_and_others_stay() {
        let dir = temp("drop");
        save(
            &dir,
            &[
                record("/s/a.jsonl", "id-1", 1.0, "secret"),
                record("/s/a.jsonl", "id-2", 2.0, "keep"),
            ],
        )
        .unwrap();
        drop_ids(&dir, &["id-1".into(), "never-saved".into()]).unwrap();
        let left = list(&dir, "/s/a.jsonl", SystemTime::now());
        assert_eq!(
            left.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["id-2"]
        );
        assert_eq!(files(&dir).len(), 1);
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn an_exited_terminal_comes_back_exited() {
        let dir = temp("exited");
        let mut gone = record("/s/a.jsonl", "id-1", 1.0, "bye");
        gone.exited = true;
        gone.error = Some("spawn failed".into());
        save(&dir, &[gone.clone()]).unwrap();
        assert_eq!(list(&dir, "/s/a.jsonl", SystemTime::now()), vec![gone]);
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn an_id_that_could_leave_the_folder_is_refused() {
        let dir = temp("ids");
        for id in ["", "../x", "a/b", "a.json", &"x".repeat(65)] {
            assert!(
                save(&dir, &[record("/s/a.jsonl", id, 1.0, "")]).is_err(),
                "{id}"
            );
            assert!(drop_ids(&dir, &[id.to_owned()]).is_err(), "{id}");
        }
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn a_file_nobody_saved_for_thirty_days_is_removed_when_a_tab_looks() {
        let dir = temp("stale");
        save(
            &dir,
            &[
                record("/s/a.jsonl", "id-1", 1.0, "x"),
                record("/s/b.jsonl", "id-2", 1.0, "y"),
            ],
        )
        .unwrap();
        let later = SystemTime::now() + STALE + Duration::from_secs(60);
        assert!(list(&dir, "/s/a.jsonl", later).is_empty());
        assert!(files(&dir).is_empty());
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn files_and_folder_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("mode");
        save(&dir, &[record("/s/a.jsonl", "id-1", 1.0, "x")]).unwrap();
        let (_, file) = files(&dir).remove(0);
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }
}
