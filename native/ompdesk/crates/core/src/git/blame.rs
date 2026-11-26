//! Who last changed each line of a file in the working tree, for the Files viewer's Blame toggle (FR87). Orca reads
//! `git blame --incremental` (`src/main/git/source-control/blame/git-blame-read.ts:108-169`,
//! `src/shared/git/blame/git-blame-incremental-parser.ts:1-55`); this reads `--porcelain`, whose records come in line
//! order, and keeps each commit once with the lines pointing at it. Lines the working tree changed carry git's all-zero
//! id and are marked uncommitted.

use std::collections::HashMap;

use serde::Serialize;

use super::run::{Git, failure};
use crate::server::Fault;

/// Lines answered; a longer file is cut here and marked `truncated`.
const MAX_LINES: usize = 20_000;
/// git's output read at most (a porcelain record per line, a commit's header once).
const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    sha: String,
    short_sha: String,
    author: String,
    /// Author time, epoch milliseconds.
    date: u64,
    summary: String,
    /// The working tree's own change, not yet committed.
    uncommitted: bool,
}

#[derive(Serialize, Default)]
pub struct Blame {
    commits: Vec<BlameCommit>,
    /// `lines[i]` is the index in `commits` of line `i + 1`.
    lines: Vec<usize>,
    truncated: bool,
}

/// `git blame --porcelain -- <path>` run in `cwd`, `path` relative to it (main checked it). blame takes one literal
/// path, not a pathspec, so `--` is what keeps it from being read as an option.
pub async fn blame(git: &Git, cwd: &str, path: &str) -> Result<Blame, Fault> {
    let args = ["blame", "--porcelain", "--", path];
    let output = git.capped(cwd, &args, MAX_BYTES).await?;
    if output.code != 0 && !output.truncated {
        return Err(failure(&args, &output));
    }
    let mut answer = parse(&output.text());
    answer.truncated |= output.truncated;
    Ok(answer)
}

fn is_sha(text: &str) -> bool {
    matches!(text.len(), 40 | 64) && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Porcelain: a `<sha> <orig> <final> [<count>]` header, the commit's `key value` lines the first time it shows, then
/// the line's content after a tab.
fn parse(output: &str) -> Blame {
    let mut answer = Blame::default();
    let mut index: HashMap<&str, usize> = HashMap::new();
    let mut current: Option<usize> = None;
    for line in output.split('\n') {
        if line.starts_with('\t') {
            if let Some(commit) = current.take() {
                if answer.lines.len() == MAX_LINES {
                    answer.truncated = true;
                    break;
                }
                answer.lines.push(commit);
            }
            continue;
        }
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        let Some(at) = current else {
            if is_sha(key) {
                let next = answer.commits.len();
                let at = *index.entry(key).or_insert(next);
                if at == next {
                    answer.commits.push(BlameCommit {
                        sha: key.to_owned(),
                        short_sha: key[..7].to_owned(),
                        uncommitted: key.bytes().all(|byte| byte == b'0'),
                        ..BlameCommit::default()
                    });
                }
                current = Some(at);
            }
            continue;
        };
        let commit = &mut answer.commits[at];
        match key {
            "author" => commit.author = value.to_owned(),
            "author-time" => commit.date = value.parse::<u64>().unwrap_or(0) * 1000,
            "summary" => commit.summary = value.to_owned(),
            _ => {}
        }
    }
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `git blame --porcelain` of a two-line commit whose second line the working tree changed and a third it added.
    const SAMPLE: &str = "3591e1cb5449010c5bc0e61a5e92669b6303bb50 1 1 1
author Ada
author-mail <a@x>
author-time 1795652895
author-tz +0900
committer Ada
committer-mail <a@x>
committer-time 1795652895
committer-tz +0900
summary first line
boundary
filename sub/f.txt
\ta
0000000000000000000000000000000000000000 2 2 2
author Not Committed Yet
author-mail <not.committed.yet>
author-time 1795652895
author-tz +0900
committer Not Committed Yet
committer-mail <not.committed.yet>
committer-time 1795652895
committer-tz +0900
summary Version of sub/f.txt from sub/f.txt
previous 3591e1cb5449010c5bc0e61a5e92669b6303bb50 sub/f.txt
filename sub/f.txt
\tB
0000000000000000000000000000000000000000 3 3
\tc
3591e1cb5449010c5bc0e61a5e92669b6303bb50 1 4
\tauthor looks like a header
";

    #[test]
    fn parses_porcelain_with_each_commit_once() {
        let blame = parse(SAMPLE);
        assert_eq!(blame.lines, vec![0, 1, 1, 0]);
        assert_eq!(blame.commits.len(), 2);
        let first = &blame.commits[0];
        assert_eq!(first.short_sha, "3591e1c");
        assert_eq!(first.author, "Ada");
        assert_eq!(first.date, 1_795_652_895_000);
        assert_eq!(first.summary, "first line");
        assert!(!first.uncommitted);
        assert!(blame.commits[1].uncommitted);
        assert!(!blame.truncated);
    }

    #[test]
    fn cuts_a_long_file() {
        let record = "3591e1cb5449010c5bc0e61a5e92669b6303bb50 1 1\n\tx\n";
        let blame = parse(&record.repeat(MAX_LINES + 1));
        assert_eq!(blame.lines.len(), MAX_LINES);
        assert!(blame.truncated);
    }

    #[tokio::test]
    async fn blames_the_working_tree() {
        let dir = crate::git::scm::tests::repo("blame");
        std::fs::write(dir.join("README.md"), "hello\nmore\n").unwrap();
        let git = crate::git::run::tests::git();
        let root = dir.to_str().unwrap();
        let answer = blame(&git, root, "README.md").await.unwrap();
        assert_eq!(answer.lines.len(), 2);
        assert_eq!(answer.commits[answer.lines[0]].summary, "init");
        assert!(answer.commits[answer.lines[1]].uncommitted);
        assert!(blame(&git, root, "missing.txt").await.is_err());
    }
}
