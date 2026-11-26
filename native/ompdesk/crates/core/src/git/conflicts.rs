//! One conflicted file of a stopped merge, rebase, cherry-pick or revert, settled from the Changes panel's conflict
//! review (FR85): keep HEAD's side, keep the incoming side, or keep both (each side's lines, in order, with no
//! markers), then stage it so git counts it resolved. Orca's `conflict-review/*` and `open-conflict-review.ts` (MIT),
//! re-implemented on git's own stages (`:1:` base, `:2:` HEAD, `:3:` incoming) and `merge-file --union`.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::parse;
use super::read::blocking;
use super::run::{Git, failure};
use crate::fs::disk;
use crate::fs::error::Codes;
use crate::server::Fault;

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Ours,
    Theirs,
    Both,
}

/// A scratch folder for the stages, gone with the request.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn refuse(message: impl Into<String>) -> Fault {
    Fault::new("git_failed", message)
}

/// The blob of stage `n` of `path`, none when that stage is absent (one side added or deleted the file).
async fn stage(git: &Git, root: &str, n: u8, path: &str) -> Result<Option<Vec<u8>>, Fault> {
    let spec = format!(":{n}:{path}");
    let output = git.raw(root, &["cat-file", "blob", &spec]).await?;
    if output.truncated {
        return Err(refuse(format!("{path} is too large to merge here")));
    }
    Ok((output.code == 0).then_some(output.stdout))
}

/// Settles the conflicted `path` (relative to the checkout `root`) as `side` says, then stages it.
pub async fn resolve(git: &Git, root: &str, path: &str, side: Side) -> Result<(), Fault> {
    let unmerged = git
        .text(
            root,
            &["ls-files", "--unmerged", "--", &parse::literal(path)],
        )
        .await?;
    if unmerged.trim().is_empty() {
        return Err(refuse(format!("{path} has no conflict to resolve")));
    }
    let target = Path::new(root).join(path);
    let held = target.clone();
    let is_link = blocking(move || {
        std::fs::symlink_metadata(&held).is_ok_and(|meta| meta.file_type().is_symlink())
    })
    .await?;
    if is_link {
        return Err(refuse(format!("{path} is a link; resolve it with git")));
    }
    let literal = parse::literal(path);
    match side {
        Side::Ours | Side::Theirs => {
            let flag = if side == Side::Ours {
                "--ours"
            } else {
                "--theirs"
            };
            let args = ["checkout", flag, "--", literal.as_str()];
            let output = git.raw(root, &args).await?;
            if output.code != 0 {
                return Err(failure(&args, &output));
            }
        }
        Side::Both => {
            let (base, ours, theirs) = tokio::try_join!(
                stage(git, root, 1, path),
                stage(git, root, 2, path),
                stage(git, root, 3, path),
            )?;
            let (Some(ours), Some(theirs)) = (ours, theirs) else {
                return Err(refuse(format!(
                    "One side deleted {path}: keep HEAD's or the incoming side"
                )));
            };
            let dir = blocking(|| disk::make_temp_dir("ompdesk-conflict-"))
                .await?
                .map_err(|error| error.fault(Codes::None))?;
            let scratch = Scratch(dir);
            let files = [
                (scratch.0.join("ours"), ours),
                (scratch.0.join("base"), base.unwrap_or_default()),
                (scratch.0.join("theirs"), theirs),
            ];
            let names: Vec<String> = files
                .iter()
                .map(|(file, _)| file.to_string_lossy().into_owned())
                .collect();
            blocking(move || {
                files
                    .iter()
                    .try_for_each(|(file, bytes)| std::fs::write(file, bytes))
            })
            .await?
            .map_err(|error| refuse(format!("Could not stage the merge of {path}: {error}")))?;
            let args = [
                "merge-file",
                "-p",
                "--union",
                names[0].as_str(),
                names[1].as_str(),
                names[2].as_str(),
            ];
            let merged = git.raw(root, &args).await?;
            // `merge-file` exits with the count of conflicts it left, none with `--union`; a negative is an error.
            if merged.code < 0 || merged.truncated {
                return Err(failure(&args, &merged));
            }
            let bytes = merged.stdout;
            blocking(move || std::fs::write(&target, bytes))
                .await?
                .map_err(|error| refuse(format!("Could not write {path}: {error}")))?;
            drop(scratch);
        }
    }
    let args = ["add", "--", literal.as_str()];
    let added = git.raw(root, &args).await?;
    if added.code != 0 {
        return Err(failure(&args, &added));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::run::tests::git;
    use crate::git::scm::tests::{repo, sh};

    /// A merge of two branches that both changed `a.txt`'s one line.
    fn conflicted(name: &str) -> PathBuf {
        let dir = repo(name);
        std::fs::write(dir.join("a.txt"), "base\n").unwrap();
        sh(&dir, &["add", "."]);
        sh(&dir, &["commit", "-qm", "base"]);
        sh(&dir, &["checkout", "-q", "-b", "other"]);
        std::fs::write(dir.join("a.txt"), "theirs\n").unwrap();
        sh(&dir, &["commit", "-qam", "theirs"]);
        sh(&dir, &["checkout", "-q", "main"]);
        std::fs::write(dir.join("a.txt"), "ours\n").unwrap();
        sh(&dir, &["commit", "-qam", "ours"]);
        let merged = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@example.com",
                "merge",
                "other",
            ])
            .current_dir(&dir)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .output()
            .unwrap();
        assert!(!merged.status.success());
        dir
    }

    #[tokio::test]
    async fn keeps_one_side_or_both_and_stages_the_file() {
        for (side, want) in [
            (Side::Ours, "ours\n"),
            (Side::Theirs, "theirs\n"),
            (Side::Both, "ours\ntheirs\n"),
        ] {
            let dir = conflicted("conflict-side");
            let root = dir.to_str().unwrap();
            resolve(&git(), root, "a.txt", side).await.unwrap();
            assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), want);
            assert_eq!(sh(&dir, &["ls-files", "--unmerged"]), "");
            assert!(resolve(&git(), root, "a.txt", side).await.is_err());
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }
}
