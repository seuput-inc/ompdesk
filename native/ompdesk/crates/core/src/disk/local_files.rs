//! Ignored files a worktree's removal would lose. `git worktree remove` deletes what `.gitignore` hides (`.env.local`,
//! a local database) without a word, forced or not. The files counted are disk care's own private files
//! (`saved::private_files`: every ignored file the project cannot make again by `regenerable`'s evidence); one is safe
//! when it is a link (removal unlinks it, its target stays) or the main checkout holds the same bytes at the same path
//! (worktree seeding copies `.env` files from there). One the budget does not reach counts as unchecked, never as safe.
//! Idea from Orca's `worktree-at-risk-local-files.ts:89-149,213-300` (MIT), re-implemented.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::git::read::blocking;
use crate::git::run::Git;
use crate::server::Fault;

/// Files compared before the rest counts as unchecked.
const MAX_FILES: usize = 1_000;
/// Bytes read for comparisons (both copies) before the rest counts as unchecked.
const MAX_BYTES: u64 = 32 * 1024 * 1024;
/// A file larger than this is not read: it counts as unchecked.
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Paths a refusal names.
const NAMED: usize = 3;

/// What removing a worktree would lose of the files git ignores.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct LocalFiles {
    /// The lost files, `.env` files first, then shallow before deep.
    pub paths: Vec<String>,
    /// Every file was listed and judged.
    pub complete: bool,
}

impl LocalFiles {
    /// Nothing would be lost, as far as the check could tell.
    pub(crate) fn safe(&self) -> bool {
        self.paths.is_empty() && self.complete
    }

    /// One sentence for a refusal: how many files and the first few names.
    pub(crate) fn describe(&self) -> String {
        let mut sentence = String::new();
        if !self.paths.is_empty() {
            let named: Vec<&str> = self.paths.iter().take(NAMED).map(String::as_str).collect();
            let more = if self.paths.len() > NAMED {
                ", …"
            } else {
                ""
            };
            sentence = format!(
                "{} local file(s) git ignores exist nowhere else and would be deleted ({}{more})",
                self.paths.len(),
                named.join(", ")
            );
        }
        if !self.complete {
            if !sentence.is_empty() {
                sentence.push_str("; ");
            }
            sentence.push_str("some files git ignores could not be checked for a copy");
        }
        sentence
    }
}

enum Verdict {
    Saved,
    Lost,
    Unchecked,
}

/// The ignored files of `worktree` its removal would lose, judged against the main checkout at `main`.
pub(crate) async fn unsaved(git: &Git, worktree: &str, main: &str) -> Result<LocalFiles, Fault> {
    let files = super::facts::files(git, worktree).await?;
    let regenerable = files.regenerable_ignored();
    let Some(listed) = super::saved::private_files(git, worktree, &regenerable).await? else {
        return Ok(LocalFiles::default());
    };
    let names: Vec<String> = String::from_utf8_lossy(&listed)
        .split_terminator('\0')
        .map(str::to_owned)
        .collect();
    let (worktree, main) = (PathBuf::from(worktree), PathBuf::from(main));
    blocking(move || judge(&worktree, &main, names)).await
}

fn judge(worktree: &Path, main: &Path, names: Vec<String>) -> LocalFiles {
    let own = std::fs::canonicalize(worktree).unwrap_or_else(|_| worktree.to_owned());
    let (mut files, mut bytes) = (MAX_FILES, MAX_BYTES);
    let mut lost = Vec::new();
    let mut complete = true;
    for name in names {
        if files == 0 {
            complete = false;
            break;
        }
        files -= 1;
        match verdict(&worktree.join(&name), &main.join(&name), &own, &mut bytes) {
            Verdict::Saved => {}
            Verdict::Lost => lost.push(name),
            Verdict::Unchecked => complete = false,
        }
    }
    let rank = |path: &str| {
        let name = path.rsplit('/').next().unwrap_or(path);
        u8::from(!name.starts_with(".env"))
    };
    lost.sort_by(|a, b| {
        rank(a.as_str())
            .cmp(&rank(b.as_str()))
            .then(a.split('/').count().cmp(&b.split('/').count()))
            .then(a.cmp(b))
    });
    LocalFiles {
        paths: lost,
        complete,
    }
}

fn verdict(file: &Path, copy: &Path, own: &Path, bytes: &mut u64) -> Verdict {
    let Ok(meta) = std::fs::symlink_metadata(file) else {
        return Verdict::Unchecked;
    };
    // Removing a link deletes no content. Anything else that is no regular file (an ignored nested repository or a
    // folder git lists as one entry, a file replaced by a folder since the listing) may hold the only copy of its
    // contents, which this check does not walk: unchecked, never saved.
    if meta.file_type().is_symlink() {
        return Verdict::Saved;
    }
    if !meta.is_file() {
        return Verdict::Unchecked;
    }
    let resolved = match std::fs::canonicalize(copy) {
        Ok(resolved) => resolved,
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            return Verdict::Lost;
        }
        Err(_) => return Verdict::Unchecked,
    };
    // A main-checkout link into this worktree is no copy: the removal deletes what it points at.
    if resolved.starts_with(own) {
        return Verdict::Lost;
    }
    let Ok(other) = std::fs::metadata(&resolved) else {
        return Verdict::Unchecked;
    };
    let size = meta.len();
    if !other.is_file() || other.len() != size {
        return Verdict::Lost;
    }
    if size > MAX_FILE_BYTES || size * 2 > *bytes {
        return Verdict::Unchecked;
    }
    *bytes -= size * 2;
    match (std::fs::read(file), std::fs::read(&resolved)) {
        (Ok(mine), Ok(theirs)) if mine == theirs => Verdict::Saved,
        (Ok(_), Ok(_)) => Verdict::Lost,
        _ => Verdict::Unchecked,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, text) in files {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        dir
    }

    #[test]
    fn a_file_counts_as_lost_unless_the_main_checkout_has_the_same_bytes() {
        let worktree = tree(&[
            (".env.local", "SECRET=1"),
            ("data/dev.db", "rows"),
            ("copied.env", "same"),
            ("changed.txt", "mine"),
        ]);
        let main = tree(&[("copied.env", "same"), ("changed.txt", "main")]);
        let names = ["copied.env", "data/dev.db", "changed.txt", ".env.local"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        let judged = judge(worktree.path(), main.path(), names);
        assert_eq!(
            judged,
            LocalFiles {
                paths: vec![
                    ".env.local".into(),
                    "changed.txt".into(),
                    "data/dev.db".into()
                ],
                complete: true,
            }
        );
        assert!(!judged.safe());
        assert_eq!(
            judged.describe(),
            "3 local file(s) git ignores exist nowhere else and would be deleted (.env.local, changed.txt, data/dev.db)"
        );
    }

    #[test]
    fn a_file_past_the_budget_is_unchecked_never_safe() {
        let worktree = tree(&[("a", "x")]);
        let main = tree(&[("a", "x")]);
        let names: Vec<String> = std::iter::repeat_n("a".to_owned(), MAX_FILES + 1).collect();
        let judged = judge(worktree.path(), main.path(), names);
        assert!(judged.paths.is_empty());
        assert!(!judged.complete);
        assert!(!judged.safe());
    }

    #[test]
    fn an_ignored_folder_is_unchecked_never_safe() {
        let worktree = tree(&[
            ("nested/.git/HEAD", "ref"),
            ("nested/only-here.txt", "mine"),
        ]);
        let main = tree(&[]);
        let judged = judge(worktree.path(), main.path(), vec!["nested/".into()]);
        assert!(judged.paths.is_empty());
        assert!(!judged.complete);
        assert!(!judged.safe());
        assert_eq!(
            judged.describe(),
            "some files git ignores could not be checked for a copy"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_saved_its_target_stays() {
        let worktree = tree(&[("target.txt", "mine")]);
        std::os::unix::fs::symlink("/nowhere/else", worktree.path().join("link")).unwrap();
        let main = tree(&[]);
        let judged = judge(worktree.path(), main.path(), vec!["link".into()]);
        assert_eq!(
            judged,
            LocalFiles {
                paths: vec![],
                complete: true,
            }
        );
    }
}
