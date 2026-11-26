//! The Changes panel's "against base" range: everything the checkout holds that its base does not (committed,
//! staged, unstaged and untracked), measured from the merge-base, with how far the branch is ahead of and behind that
//! base. The base is, first match wins (FR28, FS86): the repository's own pick (`ompdesk.baseRef` in its config, shared
//! by every worktree), the upstream when the branch tracks another branch than its own name (`git checkout -b x
//! origin/main`), else the remote's default branch (`unlanded::landing_target`). A tracked copy of the branch itself is
//! the push target, which Pull and Push already count. Ideas from Orca's `branch-compare.ts:31-163`,
//! `change-scope.ts:8-25`, `BaseRefPicker.tsx` and `CompareAgainstUpstreamSetting.tsx` (MIT), re-implemented.

use serde::Serialize;

use super::parse::{self, MAX_FILES};
use super::read::{self, ChangedFile, Changes};
use super::run::Git;
use crate::fs::order::js_trim;
use crate::server::Fault;

/// The repository config key that holds the person's base.
const PINNED: &str = "ompdesk.baseRef";
/// Times the range is read again when HEAD moved while it was read.
const READS: usize = 3;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Compare {
    /// The ref compared against, as git names it (`origin/main`).
    base_ref: String,
    /// `pinned`, `upstream` or `default`: why this base.
    source: &'static str,
    /// The repository's own pick, also when it no longer resolves (then `source` says what stood in).
    #[serde(skip_serializing_if = "Option::is_none")]
    pinned: Option<String>,
    /// HEAD when the range was read: a page that sees another HEAD reads again.
    head_oid: String,
    /// Commits of HEAD the base lacks, and of the base HEAD lacks.
    ahead: u64,
    behind: u64,
    /// The files that would conflict when the base's commits come in (a rebase onto it, a merge of it): `merge-tree`
    /// in a scratch store, only when both sides moved; empty when clean or unknown.
    conflicts: Vec<String>,
    /// The files, with `base` the merge-base they are measured from.
    #[serde(flatten)]
    changes: Changes,
}

/// Trimmed stdout of a git that succeeded with some.
async fn answer(git: &Git, root: &str, args: &[&str]) -> Result<Option<String>, Fault> {
    let output = git.raw(root, args).await?;
    let text = output.text();
    let text = js_trim(&text);
    Ok((output.code == 0 && !text.is_empty()).then(|| text.to_owned()))
}

/// The commit `reference` names, none when it names none (or looks like an option).
async fn commit_of(git: &Git, root: &str, reference: &str) -> Result<Option<String>, Fault> {
    if reference.starts_with('-') {
        return Ok(None);
    }
    let spec = format!("{reference}^{{commit}}");
    answer(git, root, &["rev-parse", "--verify", "--quiet", &spec]).await
}

/// The base and why, and the repository's pick.
async fn base_of(
    git: &Git,
    root: &str,
    branch: &str,
) -> Result<Option<(String, &'static str, Option<String>)>, Fault> {
    let pinned = answer(git, root, &["config", "--get", PINNED]).await?;
    if let Some(pinned) = &pinned
        && commit_of(git, root, pinned).await?.is_some()
    {
        return Ok(Some((pinned.clone(), "pinned", Some(pinned.clone()))));
    }
    let reference = format!("refs/heads/{branch}");
    let tracked = answer(
        git,
        root,
        &[
            "for-each-ref",
            "--format=%(upstream:short)%00%(upstream:remoteref)",
            &reference,
        ],
    )
    .await?;
    if let Some((upstream, remote_ref)) = tracked.as_deref().and_then(|t| t.split_once('\0'))
        && !upstream.is_empty()
        && remote_ref.strip_prefix("refs/heads/") != Some(branch)
        && commit_of(git, root, upstream).await?.is_some()
    {
        return Ok(Some((upstream.to_owned(), "upstream", pinned)));
    }
    Ok(super::unlanded::landing_target(git, root)
        .await?
        .map(|(reference, _)| (reference, "default", pinned)))
}

/// The checkout's changes since `commit` (a merge-base): committed, staged, unstaged and untracked, as `read::diff`
/// finds a path among them.
pub async fn changes_since(git: &Git, cwd: &str, commit: &str) -> Result<Changes, Fault> {
    let Some(root) = read::repo_root(git, cwd).await? else {
        return Err(Fault::new(
            "not_a_repo",
            format!("Not a git repository: {cwd}"),
        ));
    };
    let Some(commit) = commit_of(git, &root, commit).await? else {
        return Err(Fault::new(
            "not_changed",
            "The base this range was measured from is gone. Refresh to continue.",
        ));
    };
    let diff = ["--find-renames", "--no-ext-diff", "-z", commit.as_str()];
    let names = [&["diff", "--name-status"][..], &diff].concat();
    let counts = [&["diff", "--numstat"][..], &diff].concat();
    let (names, counts, status, head) = tokio::try_join!(
        git.text(&root, &names),
        git.text(&root, &counts),
        git.text(
            &root,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"]
        ),
        read::head(git, &root),
    )?;
    let mut files: Vec<ChangedFile> = parse::landing_files(&names, &counts)
        .into_iter()
        .map(|file| ChangedFile {
            path: file.path,
            old_path: file.old_path,
            status: file.status,
            added: file.added,
            removed: file.removed,
        })
        .collect();
    files.extend(
        parse::untracked_v1(&status)
            .into_iter()
            .map(|path| ChangedFile {
                path,
                old_path: None,
                status: "??".into(),
                added: None,
                removed: None,
            }),
    );
    let truncated = files.len() > MAX_FILES;
    files.truncate(MAX_FILES);
    Ok(Changes {
        is_repo: true,
        root: Some(root),
        base: Some(commit),
        files,
        truncated,
        head: Some(head),
    })
}

/// The range against the base, none outside a repository, on a detached or unborn HEAD, or without a base that shares
/// history with HEAD. A HEAD that moved while the range was read (a commit, a checkout) is read again, so the page
/// never pairs one HEAD's files with another's counts (Orca `git-branch-compare-actions.ts:47-60`).
pub async fn compare(git: &Git, cwd: &str) -> Result<Option<Compare>, Fault> {
    let Some(root) = read::repo_root(git, cwd).await? else {
        return Ok(None);
    };
    let mut last = None;
    for _ in 0..READS {
        let Some(head_oid) =
            answer(git, &root, &["rev-parse", "--verify", "--quiet", "HEAD"]).await?
        else {
            return Ok(None);
        };
        let Some(branch) = answer(git, &root, &["symbolic-ref", "--short", "-q", "HEAD"]).await?
        else {
            return Ok(None);
        };
        let Some((base_ref, source, pinned)) = base_of(git, &root, &branch).await? else {
            return Ok(None);
        };
        let Some(merge_base) = answer(git, &root, &["merge-base", "HEAD", &base_ref]).await? else {
            return Ok(None);
        };
        let range = format!("{base_ref}...HEAD");
        let counts = answer(git, &root, &["rev-list", "--left-right", "--count", &range])
            .await?
            .unwrap_or_default();
        let mut counted = counts
            .split_whitespace()
            .map(|n| n.parse::<u64>().unwrap_or(0));
        let (behind, ahead) = (counted.next().unwrap_or(0), counted.next().unwrap_or(0));
        let changes = changes_since(git, &root, &merge_base).await?;
        let conflicts = if ahead > 0 && behind > 0 {
            match super::branches::predict_between(git, &root, "HEAD", &base_ref, &base_ref).await?
            {
                super::branches::Prediction::Conflict { files } => files,
                _ => Vec::new(),
            }
        } else {
            Vec::new()
        };
        let now = answer(git, &root, &["rev-parse", "--verify", "--quiet", "HEAD"]).await?;
        let settled = now.as_deref() == Some(head_oid.as_str());
        last = Some(Compare {
            base_ref,
            source,
            pinned,
            head_oid,
            ahead,
            behind,
            conflicts,
            changes,
        });
        if settled {
            break;
        }
    }
    Ok(last)
}

/// Pins the repository's base to `base` (a ref that names a commit), or unpins it.
pub async fn set_base(git: &Git, root: &str, base: Option<&str>) -> Result<(), Fault> {
    let Some(base) = base else {
        // Exit 5: nothing was set, which is what was asked.
        let output = git.raw(root, &["config", "--unset", PINNED]).await?;
        if output.code != 0 && output.code != 5 {
            return Err(super::run::failure(&["config", "--unset", PINNED], &output));
        }
        return Ok(());
    };
    if commit_of(git, root, base).await?.is_none() {
        return Err(Fault::new(
            "invalid_name",
            format!("{base} names no commit in this repository"),
        ));
    }
    git.text(root, &["config", PINNED, base]).await?;
    Ok(())
}

/// The largest picture the image diff reads from git.
const BLOB_MAX_BYTES: usize = 8 * 1024 * 1024;

/// A picture as `rev` holds it, for the image diff's before side.
#[derive(Serialize)]
pub struct Picture {
    /// Its type, sniffed from its bytes as the Files viewer's pictures are (`fs::mime::image`); none when `rev` holds
    /// no such file, it is no picture or it is over `BLOB_MAX_BYTES`. Its bytes follow the answer.
    mime: Option<&'static str>,
}

/// The picture at `path` in `rev` (a commit the checkout's repository resolves).
pub async fn picture(
    git: &Git,
    cwd: &str,
    rev: &str,
    path: &str,
) -> Result<(Picture, Vec<u8>), Fault> {
    let none = || Ok((Picture { mime: None }, Vec::new()));
    let Some(commit) = commit_of(git, cwd, rev).await? else {
        return none();
    };
    let spec = format!("{commit}:{path}");
    let output = git
        .capped(cwd, &["cat-file", "blob", &spec], BLOB_MAX_BYTES)
        .await?;
    if output.code != 0 || output.truncated {
        return none();
    }
    match crate::fs::mime::image(&output.stdout) {
        Some(mime) => Ok((Picture { mime: Some(mime) }, output.stdout)),
        None => none(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::run::tests::git;
    use crate::git::scm::tests::{repo, sh};

    #[tokio::test]
    async fn measures_from_the_merge_base_with_the_pinned_or_default_base() {
        let dir = repo("compare");
        let root = dir.to_str().unwrap();
        let git = git();
        sh(&dir, &["branch", "trunk"]);
        sh(&dir, &["checkout", "-q", "-b", "work"]);
        std::fs::write(dir.join("new.txt"), "new\n").unwrap();
        sh(&dir, &["add", "."]);
        sh(&dir, &["commit", "-qm", "work"]);
        std::fs::write(dir.join("loose.txt"), "loose\n").unwrap();
        // No remote and no pick: the local `main`/`master` stands in.
        let default = compare(&git, root).await.unwrap().unwrap();
        assert_eq!(default.source, "default");
        assert_eq!(default.ahead, 1);
        let paths: Vec<&str> = default
            .changes
            .files
            .iter()
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(paths, ["new.txt", "loose.txt"]);

        set_base(&git, root, Some("trunk")).await.unwrap();
        let pinned = compare(&git, root).await.unwrap().unwrap();
        assert_eq!(
            (pinned.source, pinned.base_ref.as_str()),
            ("pinned", "trunk")
        );
        assert!(set_base(&git, root, Some("--evil")).await.is_err());
        set_base(&git, root, None).await.unwrap();
        set_base(&git, root, None).await.unwrap();
        assert_eq!(
            compare(&git, root).await.unwrap().unwrap().source,
            "default"
        );
        let diff = read::diff(&git, root, "new.txt", default.changes.base.as_deref())
            .await
            .unwrap();
        let diff = serde_json::to_value(diff).unwrap();
        assert!(diff["diff"].as_str().unwrap().contains("+new"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
