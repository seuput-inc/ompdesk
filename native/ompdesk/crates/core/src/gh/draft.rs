//! Draft a PR from the checkout's commits and changed files. Only the installed stock omp writes the draft.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use super::{Gh, Runners, Tools, pr};
use crate::fs::order::js_trim;
use crate::git::run::Git;
use crate::json::{utf16_prefix, whole_surrogates};
use crate::omp::cli::{Launch, pr_draft};
use crate::server::{Fault, Registry, Reply, Scope};

#[derive(Deserialize)]
struct Model {
    bin: String,
    env: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    base: Option<String>,
    head: Option<String>,
    omp: Option<Model>,
    timeout_ms: u64,
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("gh.prDraft", |call| {
        Box::pin(async move {
            let Params {
                runners,
                cwd,
                base,
                head,
                omp,
                timeout_ms,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope.clone());
            let outcome = draft(
                &tools,
                &cwd,
                base,
                head,
                omp,
                call.scope,
                Duration::from_millis(timeout_ms),
            )
            .await;
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

async fn draft(
    tools: &Tools,
    cwd: &str,
    base: Option<String>,
    head: Option<String>,
    omp: Option<Model>,
    scope: Scope,
    timeout: Duration,
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
    let Model { bin, env } = omp.ok_or_else(|| {
        Fault::new(
            "pr_draft_failed",
            "Draft failed: No resolved omp launcher for pr_draft",
        )
    })?;
    let launch = Launch {
        bin,
        env,
        cwd: root,
    };
    let output = pr_draft(&launch, scope, timeout, &prompt)
        .await
        .map_err(|fault| {
            if fault == Fault::cancelled() {
                fault
            } else {
                Fault::new(
                    "pr_draft_failed",
                    format!("Draft failed: {}", fault.message),
                )
            }
        })?;
    answer(&tools.gh, output.code, &output.stdout, &output.stderr)
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

#[derive(Serialize)]
struct Draft<'a> {
    title: &'a str,
    body: &'a str,
}

fn answer(gh: &Gh, code: i32, stdout: &[u8], stderr: &[u8]) -> Result<Reply, Fault> {
    if code == 0 {
        let text = String::from_utf8_lossy(stdout);
        let text = whole_surrogates(&text);
        // Try each opening, even inside an earlier malformed object or a valid wrapper without a draft.
        for (start, _) in text.match_indices('{') {
            // Leave extra fields raw. Their nesting and numeric range do not constrain a title or body.
            let mut objects = serde_json::Deserializer::from_str(&text[start..])
                .into_iter::<BTreeMap<String, &RawValue>>();
            let Some(Ok(row)) = objects.next() else {
                continue;
            };
            let string = |key: &str| serde_json::from_str::<String>(row.get(key)?.get()).ok();
            if let (Some(title), Some(body)) = (string("title"), string("body")) {
                return Reply::json(&Draft {
                    title: js_trim(&title),
                    body: js_trim(&body),
                });
            }
        }
    }
    let detail = gh.scrub(
        String::from_utf8_lossy(if stderr.is_empty() { stdout } else { stderr }).into_owned(),
    );
    let detail = utf16_prefix(js_trim(&detail), 300);
    Err(Fault::new(
        "pr_draft_failed",
        if detail.is_empty() {
            "The model did not return a draft".to_owned()
        } else {
            format!("The model did not return a draft: {detail}")
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn read(code: i32, out: &str, err: &str) -> Result<Value, Fault> {
        let gh = Gh::new(None, Scope::detached());
        answer(&gh, code, out.as_bytes(), err.as_bytes())
            .map(|reply| serde_json::from_str(reply.result.get()).unwrap())
    }

    #[test]
    fn first_draft_in_noisy_model_output() {
        let object = r###"{"title":"t {x}","body":"## S\n- a"}"###;
        let expected = json!({"title":"t {x}","body":"## S\n- a"});
        for text in [
            format!("Working...\n```json\n{object}\n```"),
            format!("{{broken [{object}"),
            format!("{{\"wrapped\":{object}}}more"),
        ] {
            assert_eq!(read(0, &text, "ignored").unwrap(), expected);
        }
        for (out, title, body) in [
            (
                r#"{"title":null,"body":"x"} {"title":"a\"b","body":"\\}"}"#,
                "a\"b",
                "\\}",
            ),
            (r#"{"title":"A","body":"B","title":"Z"}"#, "Z", "B"),
            (r#"{"title":" ","body":""}"#, "", ""),
            (
                r#"{"title":"\ufeff A ","body":"\nB ","nested":{"title":"x","body":"y"}}"#,
                "A",
                "B",
            ),
        ] {
            assert_eq!(
                read(0, out, "").unwrap(),
                json!({ "title": title, "body": body })
            );
        }
        let deep = format!(
            r#"{{"trace":{}1e999{},"title":"t","body":"b"}}"#,
            "[".repeat(200),
            "]".repeat(200)
        );
        assert_eq!(read(0, &deep, "").unwrap(), json!({"title":"t","body":"b"}));
    }

    #[test]
    fn reports_stderr_before_stdout_and_never_accepts_a_failed_models_draft() {
        for (code, out, err, detail) in [
            (0, "null", "", ": null"),
            (0, "{bad} nothing", "", ": {bad} nothing"),
            (1, r#"{"title":"A","body":"B"}"#, " err ", ": err"),
            (1, r#"{"title":"A","body":"B"}"#, "  ", ""),
            (0, "", "", ""),
        ] {
            assert_eq!(
                read(code, out, err),
                Err(Fault::new(
                    "pr_draft_failed",
                    format!("The model did not return a draft{detail}")
                ))
            );
        }
        let long = "x".repeat(299);
        assert_eq!(
            read(0, &format!("{long}😀!"), "").unwrap_err().message,
            format!("The model did not return a draft: {long}�")
        );
    }

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
