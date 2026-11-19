//! Folders a worktree removal left behind (Windows). git empties a removed worktree and drops it from its list, then
//! fails to delete the folder while a process has it as its working folder; omp 19's per-user daemon keeps the folder
//! of the first session that started it for as long as any omp stays connected (`git_remove` in `worktree.rs`). Such
//! a removal is done for git, and the empty folder is written here (`OMPDESK_LEFT_BEHIND`, the file main names when it
//! starts the core: `<userData>/left-behind-worktrees.json`) so a later pass removes it: disk care, under a fresh
//! removal claim of main's for the path, calls `git.leftBehindRemove`, which deletes only an empty folder git still
//! does not list.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::parse;
use super::read::blocking;
use super::run::Git;
use super::worktree::real;
use crate::server::Fault;

/// The variable naming the file; unset (a core started without main), nothing is left behind and git's failure stands.
pub const FILE_ENV: &str = "OMPDESK_LEFT_BEHIND";

/// One writer at a time over the file's read, change and write.
static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    /// The folder, as the removal named it.
    pub path: String,
    /// The main checkout whose worktree it was: its list says whether the path became a worktree again.
    pub primary: String,
}

pub fn file() -> Option<PathBuf> {
    std::env::var_os(FILE_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub fn list(file: &Path) -> Vec<Entry> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn change(file: &Path, edit: impl FnOnce(&mut Vec<Entry>)) -> Result<(), String> {
    let _held = FILE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut entries = list(file);
    edit(&mut entries);
    let text = serde_json::to_string(&entries).map_err(|error| error.to_string())?;
    crate::disk::saves::write_kept(file, text.as_bytes(), Some(0o600), 0o700)
        .map(|_| ())
        .map_err(|fault| fault.message)
}

/// Only Windows leaves folders behind (`git_remove`).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn record(file: &Path, entry: Entry) -> Result<(), String> {
    change(file, |entries| {
        entries.retain(|kept| kept.path != entry.path);
        entries.push(entry);
    })
}

fn forget(file: &Path, path: &str) {
    if let Err(error) = change(file, |entries| entries.retain(|kept| kept.path != path)) {
        eprintln!("[left-behind] not saved: {error}");
    }
}

/// A folder with nothing in it (false when it cannot be read).
pub fn is_empty_folder(folder: &Path) -> bool {
    std::fs::read_dir(folder).is_ok_and(|mut entries| entries.next().is_none())
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum Swept {
    /// Deleted (it was empty and no worktree).
    Removed,
    /// Already gone.
    Gone,
    /// Not touched and no longer tracked: a listed worktree again, or something is in it now.
    Kept { reason: String },
    /// Still held by a process: tracked for the next pass.
    Held,
}

/// The deferred pass for one recorded `path`, run under main's removal claim for it: never a recursive delete, so a
/// worktree or files that took the path since stay as they are.
pub async fn sweep_one(git: &Git, file: &Path, path: &str) -> Result<Swept, Fault> {
    let Some(entry) = list(file).into_iter().find(|entry| entry.path == path) else {
        return Ok(Swept::Kept {
            reason: "not left behind".into(),
        });
    };
    let listed = git
        .raw(&entry.primary, &["worktree", "list", "--porcelain", "-z"])
        .await?;
    let listed: Vec<String> = if listed.code == 0 {
        parse::worktree_paths(&listed.text())
            .into_iter()
            .map(str::to_owned)
            .collect()
    } else {
        Vec::new()
    };
    let target = entry.path.clone();
    let swept = blocking(move || {
        let folder = Path::new(&target);
        if !folder.exists() {
            return Swept::Gone;
        }
        let own = real(&target).ok();
        if own.is_some() && listed.iter().any(|listed| real(listed).ok() == own) {
            return Swept::Kept {
                reason: "a worktree again".into(),
            };
        }
        match std::fs::remove_dir(folder) {
            Ok(()) => Swept::Removed,
            Err(_) if !folder.exists() => Swept::Gone,
            Err(_) if !is_empty_folder(folder) => Swept::Kept {
                reason: "not empty".into(),
            },
            Err(_) => Swept::Held,
        }
    })
    .await?;
    if swept != Swept::Held {
        forget(file, path);
    }
    Ok(swept)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::run::tests::git;
    use crate::git::scm::tests::{repo, sh};

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-left-behind-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn left(file: &Path, primary: &Path, folder: &Path) {
        record(
            file,
            Entry {
                path: folder.to_string_lossy().into_owned(),
                primary: primary.to_string_lossy().into_owned(),
            },
        )
        .unwrap();
    }

    #[tokio::test]
    async fn removes_an_empty_folder_left_behind_and_forgets_it() {
        let primary = repo("left-behind-empty");
        let dir = scratch("empty");
        let file = dir.join("left.json");
        let folder = dir.join("tree");
        std::fs::create_dir(&folder).unwrap();
        left(&file, &primary, &folder);
        let path = folder.to_string_lossy().into_owned();
        assert_eq!(
            sweep_one(&git(), &file, &path).await.unwrap(),
            Swept::Removed
        );
        assert!(!folder.exists());
        assert!(list(&file).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&primary);
    }

    /// The claim was released when the removal answered: by the pass, the path may hold the user's files.
    #[tokio::test]
    async fn keeps_files_that_took_the_path_since() {
        let primary = repo("left-behind-files");
        let dir = scratch("files");
        let file = dir.join("left.json");
        let folder = dir.join("tree");
        std::fs::create_dir(&folder).unwrap();
        left(&file, &primary, &folder);
        std::fs::write(folder.join("sentinel.txt"), "user work").unwrap();
        let path = folder.to_string_lossy().into_owned();
        assert!(matches!(
            sweep_one(&git(), &file, &path).await.unwrap(),
            Swept::Kept { .. }
        ));
        assert_eq!(
            std::fs::read_to_string(folder.join("sentinel.txt")).unwrap(),
            "user work"
        );
        assert!(list(&file).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&primary);
    }

    #[tokio::test]
    async fn keeps_a_worktree_made_again_at_the_path() {
        let primary = repo("left-behind-again");
        let dir = scratch("again");
        let file = dir.join("left.json");
        let folder = dir.join("tree");
        std::fs::create_dir(&folder).unwrap();
        left(&file, &primary, &folder);
        std::fs::remove_dir(&folder).unwrap();
        sh(
            &primary,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "again",
                folder.to_str().unwrap(),
            ],
        );
        let path = folder.to_string_lossy().into_owned();
        assert_eq!(
            sweep_one(&git(), &file, &path).await.unwrap(),
            Swept::Kept {
                reason: "a worktree again".into()
            }
        );
        assert!(folder.join(".git").exists());
        sh(
            &primary,
            &["worktree", "remove", "--force", folder.to_str().unwrap()],
        );
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&primary);
    }
}
