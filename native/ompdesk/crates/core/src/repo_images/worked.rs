//! Where a session started in a folder above several repositories really worked: the folders its newest tool calls
//! named (`arguments.path`, `arguments.cwd`) below that folder, newest first. Only the journal's tail is read, and
//! only folders that exist below the session's folder count, so a path a call merely mentioned elsewhere never
//! becomes the session's repository.
use std::io::SeekFrom;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// How much of the journal's end is read: the last few dozen tool calls of a long session.
const TAIL: u64 = 512 * 1024;
/// Distinct folders tried, newest first.
const FOLDERS: usize = 4;
/// Folders climbed from a named file to one that exists.
const CLIMB: usize = 32;

/// The tail's lines, newest first, the cut first line of a partial read left out.
async fn tail_lines(session: &Path) -> Option<Vec<String>> {
    let mut file = tokio::fs::File::open(session).await.ok()?;
    let len = file.metadata().await.ok()?.len();
    let start = len.saturating_sub(TAIL);
    file.seek(SeekFrom::Start(start)).await.ok()?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.take(TAIL).read_to_end(&mut bytes).await.ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    Some(lines.into_iter().rev().map(str::to_owned).collect())
}

/// The path-like arguments of one journal line's tool calls, last call first.
fn named_paths(line: &str) -> Vec<String> {
    let Ok(entry) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    let Some(content) = entry["message"]["content"].as_array() else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    for part in content.iter().rev() {
        if part["type"] != "toolCall" {
            continue;
        }
        for key in ["path", "cwd"] {
            if let Some(value) = part["arguments"][key].as_str()
                && !value.is_empty()
                && !value.contains("://")
            {
                paths.push(value.to_owned());
            }
        }
    }
    paths
}

/// The nearest existing folder of `named` (relative to `under`), canonical, strictly below `under`.
async fn folder_below(under: &Path, named: &str) -> Option<PathBuf> {
    let mut path = under.join(named);
    for _ in 0..CLIMB {
        if let Ok(meta) = tokio::fs::metadata(&path).await {
            let dir = if meta.is_dir() {
                path
            } else {
                path.parent()?.to_path_buf()
            };
            let dir = tokio::fs::canonicalize(dir).await.ok()?;
            return (dir.starts_with(under) && dir != under).then_some(dir);
        }
        path = path.parent()?.to_path_buf();
    }
    None
}

/// The folders below `under` the session's newest tool calls worked in, newest first, at most `FOLDERS`.
pub(super) async fn worked_folders(session: &Path, under: &Path) -> Vec<PathBuf> {
    let Some(lines) = tail_lines(session).await else {
        return Vec::new();
    };
    let mut folders: Vec<PathBuf> = Vec::new();
    for line in lines {
        for named in named_paths(&line) {
            if let Some(dir) = folder_below(under, &named).await
                && !folders.contains(&dir)
            {
                folders.push(dir);
                if folders.len() == FOLDERS {
                    return folders;
                }
            }
        }
    }
    folders
}
