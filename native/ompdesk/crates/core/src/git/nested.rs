//! The repositories inside a folder that is not one itself (FR40, FB45): a project folder holding several checkouts gets a
//! Changes section per repository, and its repositories can be added to the sidebar from the same list. One bounded
//! walk: folders up to `MAX_DEPTH` below the folder, never into a repository found (its submodules and nested clones are
//! its own), a dependency or build folder, or a hidden one; it stops after `MAX_VISITS` folders or `MAX_REPOS`
//! repositories and says so. Orca's `project-admission/nested-import`, `NestedRepoChecklist.tsx` and
//! `NestedRepoScanLimitNotice.tsx` (MIT), re-implemented.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::read::{self, blocking};
use super::run::Git;
use crate::server::Fault;

const MAX_DEPTH: usize = 3;
const MAX_VISITS: usize = 2_000;
const MAX_REPOS: usize = 50;
/// Folders a project makes or fetches, never a repository of the person's.
const SKIPPED: [&str; 8] = [
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "Pods",
    "__pycache__",
];

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Nested {
    /// Each repository's folder relative to the scanned one, `/`-separated, in walk order (shallow first).
    repos: Vec<String>,
    /// The walk stopped at a limit: more may exist.
    truncated: bool,
}

/// The walk itself, on the disk alone.
fn walk(root: &Path) -> Nested {
    let mut repos = Vec::new();
    let mut queue = VecDeque::from([(PathBuf::new(), 0usize)]);
    let mut visits = 0;
    let mut truncated = false;
    while let Some((relative, depth)) = queue.pop_front() {
        visits += 1;
        if visits > MAX_VISITS || repos.len() >= MAX_REPOS {
            truncated = true;
            break;
        }
        let Ok(entries) = std::fs::read_dir(root.join(&relative)) else {
            continue;
        };
        let mut children: Vec<String> = entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| !name.starts_with('.') && !SKIPPED.contains(&name.as_str()))
            .collect();
        children.sort();
        for name in children {
            let child = relative.join(&name);
            if std::fs::symlink_metadata(root.join(&child).join(".git")).is_ok() {
                repos.push(child.to_string_lossy().replace('\\', "/"));
            } else if depth + 1 < MAX_DEPTH {
                queue.push_back((child, depth + 1));
            }
        }
    }
    Nested { repos, truncated }
}

/// The repositories under `cwd`; none when `cwd` is inside a repository itself.
pub async fn nested(git: &Git, cwd: &str) -> Result<Nested, Fault> {
    if read::repo_root(git, cwd).await?.is_some() {
        return Ok(Nested {
            repos: Vec::new(),
            truncated: false,
        });
    }
    let root = PathBuf::from(cwd);
    blocking(move || walk(&root)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_repositories_without_entering_them_or_dependency_folders() {
        let dir = tempfile::tempdir().unwrap();
        for folder in [
            "app/.git",
            "app/inner/.git",
            "libs/core/.git",
            "node_modules/pkg/.git",
            ".hidden/repo/.git",
            "a/b/c/deep/.git",
        ] {
            std::fs::create_dir_all(dir.path().join(folder)).unwrap();
        }
        assert_eq!(
            walk(dir.path()),
            Nested {
                repos: vec!["app".into(), "libs/core".into()],
                truncated: false,
            }
        );
    }
}
