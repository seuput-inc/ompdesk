//! Sparse checkout presets (Orca FB83/FS120d, `src/main/git/worktrees/creation/worktree-sparse-add.ts:16-86` and
//! `src/main/ipc/repos/sparse-preset-validation.ts`, MIT, re-implemented): the repository's `.ompdesk/sparse` in its
//! main checkout names sets of folders a new worktree may check out alone, so a large monorepo's worktree holds only
//! the part a task needs. No setting: the file is the project's, as `.worktreeinclude` is.
//!
//! ```text
//! # comments
//! [web]
//! apps/web
//! packages/ui
//! ```
//!
//! A `[name]` line starts a preset; folders before the first one form the preset `default`. A folder is relative to
//! the checkout's root, cone mode (no globs); an absolute path, `.`/`..`, a leading `-` or `!`, a drive letter or a
//! glob is skipped. `worktree::add` checks the chosen preset out with `sparse-checkout set` (`worktree.rs`).

use std::fs;

use serde::Serialize;

use super::read::{self, blocking};
use super::run::Git;
use crate::disk::tree;
use crate::server::Fault;

pub(super) const PRESETS_FILE: &str = ".ompdesk/sparse";
const MAX_BYTES: u64 = 64 * 1024;
const MAX_FOLDERS: usize = 200;
const DEFAULT_NAME: &str = "default";

#[derive(Serialize, Debug, PartialEq)]
pub struct Preset {
    pub(super) name: String,
    pub(super) folders: Vec<String>,
}

/// One folder line as cone mode takes it, none when it may not be one.
fn folder(line: &str) -> Option<String> {
    let spelled = line.replace('\\', "/");
    let trimmed = spelled.trim_start_matches("./").trim_end_matches('/');
    let refused = trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.starts_with('-')
        || trimmed.starts_with('!')
        || trimmed.contains(':')
        || trimmed.contains(['*', '?', '[', '\0'])
        || trimmed
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..");
    (!refused).then(|| trimmed.to_owned())
}

/// The presets `text` names, in file order; a name given twice keeps its first set, a preset without folders is left
/// out.
pub(super) fn parse(text: &str) -> Vec<Preset> {
    let mut presets: Vec<Preset> = Vec::new();
    let mut current = DEFAULT_NAME.to_owned();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
        {
            let name = name.trim();
            if !name.is_empty() {
                current = name.to_owned();
            }
            continue;
        }
        let Some(folder) = folder(line) else {
            continue;
        };
        let at = match presets.iter().position(|preset| preset.name == current) {
            Some(at) => at,
            None => {
                presets.push(Preset {
                    name: current.clone(),
                    folders: Vec::new(),
                });
                presets.len() - 1
            }
        };
        let folders = &mut presets[at].folders;
        if folders.len() < MAX_FOLDERS && !folders.contains(&folder) {
            folders.push(folder);
        }
    }
    presets
}

fn read_file(primary: &str) -> Vec<Preset> {
    let file = tree::under(&read::native(primary), PRESETS_FILE);
    let fits = fs::metadata(&file).is_ok_and(|meta| meta.is_file() && meta.len() <= MAX_BYTES);
    if !fits {
        return Vec::new();
    }
    fs::read_to_string(&file)
        .map(|text| parse(&text))
        .unwrap_or_default()
}

/// The presets of the main checkout `primary`.
pub(super) async fn of_primary(primary: &str) -> Result<Vec<Preset>, Fault> {
    let primary = primary.to_owned();
    blocking(move || read_file(&primary)).await
}

/// The presets of the repository `cwd` is in; none outside one.
pub async fn presets(git: &Git, cwd: &str) -> Result<Vec<Preset>, Fault> {
    if read::repo_root(git, cwd).await?.is_none() {
        return Ok(Vec::new());
    }
    of_primary(&read::primary_root(git, cwd).await?).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(name: &str, folders: &[&str]) -> Preset {
        Preset {
            name: name.into(),
            folders: folders.iter().map(|folder| (*folder).into()).collect(),
        }
    }

    #[test]
    fn reads_named_presets_and_a_default_before_the_first_header() {
        let text =
            "# folders\nshared\n\n[web]\napps/web/\n./packages/ui\n[docs]\ndocs\n[web]\napps/api\n";
        assert_eq!(
            parse(text),
            [
                named("default", &["shared"]),
                named("web", &["apps/web", "packages/ui", "apps/api"]),
                named("docs", &["docs"]),
            ]
        );
    }

    #[test]
    fn skips_folders_cone_mode_cannot_take_or_that_leave_the_checkout() {
        let text = "[x]\n/abs\n../up\na/../b\n-flag\n!neg\nC:/drive\nsrc/*.rs\na//b\n.\nok\\win\n";
        assert_eq!(parse(text), [named("x", &["ok/win"])]);
    }

    #[test]
    fn a_preset_without_folders_is_left_out() {
        assert_eq!(parse("[empty]\n# none\n[x]\nsrc\n"), [named("x", &["src"])]);
    }
}
