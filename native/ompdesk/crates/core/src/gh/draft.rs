//! Collect/render the prompt before main checks the live credit policy and launches the model.

use std::borrow::Cow;

use serde::{Deserialize, Serialize};

use super::{Runners, Tools, pr};
use crate::fs::order::js_trim;
use crate::git::run::Git;
use crate::json::utf16_prefix;
use crate::server::{Fault, Registry, Reply};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    base: Option<String>,
    head: Option<String>,
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("gh.prDraftPrompt", |call| {
        Box::pin(async move {
            let Params {
                runners,
                cwd,
                base,
                head,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = draft(&tools, &cwd, base, head).await;
            tools.gh.answer(outcome)
        })
    });
}

async fn resolve_rev(git: &Git, root: &str, name: &str) -> Result<String, Fault> {
    for candidate in [name.to_owned(), format!("origin/{name}")] {
        let spec = format!("{candidate}^{{commit}}");
        if git
            .raw(root, &["rev-parse", "--verify", "--quiet", &spec])
            .await?
            .code
            == 0
        {
            return Ok(candidate);
        }
    }
    Err(Fault::new(
        "pr_draft_failed",
        format!("Unknown revision: {name}"),
    ))
}

#[derive(Serialize)]
struct Prepared {
    root: String,
    prompt: String,
}

async fn draft(
    tools: &Tools,
    cwd: &str,
    base: Option<String>,
    head: Option<String>,
) -> Result<Reply, Fault> {
    let found = pr::repo(tools, cwd).await?;
    let git = tools.git()?;
    let root = found.root;
    let base = base
        .or(found.default_branch)
        .unwrap_or_else(|| "HEAD~1".into());
    let current = git
        .raw(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await?
        .text();
    let current = js_trim(&current);
    let head = head
        .as_deref()
        .unwrap_or(if current.is_empty() { "HEAD" } else { current });
    let range = format!(
        "{}...{}",
        resolve_rev(git, &root, &base).await?,
        resolve_rev(git, &root, head).await?
    );
    let log_args = ["log", "--no-merges", "--format=%s", "-n", "50", &range];
    let name_args = ["diff", "--name-only", &range];
    let stat_args = ["diff", "--numstat", &range];
    let (log, names, stat) = tokio::try_join!(
        git.text(&root, &log_args),
        git.text(&root, &name_args),
        git.text(&root, &stat_args)
    )?;
    let prompt = prompt(&base, head, &log, &names, &stat)?;
    Reply::json(&Prepared { root, prompt })
}

fn nonempty_lines(text: &str) -> Cow<'_, str> {
    let text = text.trim_matches('\n');
    if text.contains("\n\n") {
        Cow::Owned(
            text.split('\n')
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
        )
    } else {
        Cow::Borrowed(text)
    }
}

fn prompt(base: &str, head: &str, log: &str, names: &str, stat: &str) -> Result<String, Fault> {
    let commits = nonempty_lines(log);
    let names = nonempty_lines(names);
    if commits.is_empty() && names.is_empty() {
        return Err(Fault::new(
            "pr_draft_failed",
            format!("No changes between {base} and {head}"),
        ));
    }
    let stat = js_trim(stat);
    Ok(format!(
        concat!("{system}\n\n---\n\n", include_str!("pr-draft-user.md")),
        system = js_trim(include_str!("pr-draft-system.md")),
        base = base,
        head = head,
        commit_count = commits.lines().count(),
        commits = commits,
        file_count = names.lines().count(),
        files = utf16_prefix(&names, 6000),
        diff_stat = if stat.is_empty() {
            String::new()
        } else {
            format!("\nDiff stat:\n{}\n", utf16_prefix(stat, 3000))
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renders_only_template_placeholders_with_optional_stats() {
        for (stat, rendered) in [("", ""), (" $& {{head}} ", "\nDiff stat:\n$& {{head}}\n")] {
            let output = prompt("main", "topic", "$1 {{files}}\n", "a\n\nb\n", stat).unwrap();
            let expected = format!(
                "Base: main — Head: topic\n\nCommits (1):\n$1 {{{{files}}}}\n\nChanged files (2):\na\nb\n\n{rendered}\n\nDraft the PR title and body as the JSON object.\n"
            );
            assert_eq!(output.split_once("\n\n---\n\n").unwrap().1, expected);
        }
        let names = "a".repeat(5999);
        let stat = "b".repeat(2999);
        let output = prompt(
            "m",
            "h",
            "",
            &format!("{names}😀\nnext"),
            &format!("{stat}😀"),
        )
        .unwrap();
        assert!(output.contains(&format!("Commits (0):\n\n\nChanged files (2):\n{names}�\n")));
        assert!(output.contains(&format!("Diff stat:\n{stat}�\n")));
        assert_eq!(
            prompt("m", "h", "\n", "", "").unwrap_err(),
            Fault::new("pr_draft_failed", "No changes between m and h")
        );
    }
}
