//! gh, the GitHub CLI. The PR Center (`pr.rs`, was the logic of `src/main/local/git/pr.ts` and of `parse.ts`'s
//! `parsePrUnifiedDiff`, `rollupChecks`, `rollupCounts`), the GitHub center (`center.rs`, was `github.ts`'s
//! operations), the GitHub sign-in's gh and git runs (`auth.rs`, was `src/main/github-auth/cli.ts`) and a routine's
//! GitHub reads (`routines/github.rs`) run their whole sequence of gh and git runs here, each one request. gh's other
//! callers keep their logic in main (autopilot's release poll) and reach gh through the two contracts `exec.ts` had:
//! `gh.run` (`gh()`: stdout as text, a failure on a non-zero exit or a cut output) and `gh.text` (`ghText()`: 30 s,
//! every exit code answered).
//!
//! Main decides how gh runs (`ghRunner` in `exec.ts`: the binary `resolveBin("gh")` found, gh's non-interactive
//! environment over the one git gets, the timeout and the output cap) and hands it over with every request, `null` when
//! gh is not installed (the request then answers `gh_missing` where the TypeScript threw it); git's runner comes along
//! for the checkout root and a PR draft's commits. A file gh reads a body from (`--body-file`, `--notes-file`) is made
//! here and removed once its gh exited, also when the request failed or was cancelled.
//!
//! A token never leaves through a message: the values of gh's token variables in the environment main sent are
//! replaced by `***` in every fault this module answers and in the stderr `gh.text` answers (stdout is data its callers
//! read, and passes as gh printed it). Nothing here logs a request or its environment.

mod auth;
mod center;
mod draft;
pub(crate) mod gate;
mod json;
mod pr;
mod review;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::fs::disk;
use crate::fs::error::{Codes, NodeError};
use crate::fs::order::js_trim;
use crate::git::run::Git;
use crate::run::{Exec, Opts, Output, Runner};
use crate::server::{Fault, Registry, Reply, Scope};

/// What a request answers where `requireGithubRepo` and `githubCommand` threw `gh_missing`.
const MISSING: &str = "GitHub CLI (gh) is not installed — see https://cli.github.com";
/// `ghText`'s fixed timeout.
const TEXT_TIMEOUT_MS: u64 = 30_000;
/// The variables gh reads a token from.
const TOKEN_VARIABLES: [&str; 4] = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
];
/// Shorter values are no token, and replacing them would mangle ordinary words.
const SHORTEST_SECRET: usize = 8;

/// The gh runs of one request: main's runner (none when gh is not installed), held to the request's scope and to
/// the host's gate (`gate.rs`): a background request is the page's or a timer's, never the person's own.
pub struct Gh {
    exec: Option<Exec>,
    secrets: Vec<String>,
    background: bool,
    /// The gate's key with the host: the command (binary and its fixed arguments), since each gh install has its own
    /// sign-in, so its own quota on a host.
    command: String,
    /// The request's first gated run happened (its pace is counted once).
    admitted: AtomicBool,
    /// The gate refused or tripped in this request: the time it waits until (0 when it did not).
    paused_until: AtomicU64,
}

/// What `ghText` answered.
#[derive(Serialize)]
pub struct TextOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Gh {
    pub fn new(runner: Option<Runner>, scope: Scope) -> Gh {
        Gh::paced(runner, scope, false)
    }

    /// `new` for a request that is not the person's own (`background: true`).
    pub fn paced(runner: Option<Runner>, scope: Scope, background: bool) -> Gh {
        let secrets = runner
            .iter()
            .flat_map(|runner| &runner.env)
            .filter(|(name, value)| {
                value.len() >= SHORTEST_SECRET
                    && TOKEN_VARIABLES
                        .iter()
                        .any(|token| name.eq_ignore_ascii_case(token))
            })
            .map(|(_, value)| value.clone())
            .collect();
        Gh {
            command: runner
                .as_ref()
                .map(|runner| {
                    [std::slice::from_ref(&runner.bin), runner.args.as_slice()]
                        .concat()
                        .join("\n")
                })
                .unwrap_or_default(),
            exec: runner.map(|runner| Exec::new(runner, scope, "gh")),
            secrets,
            background,
            admitted: AtomicBool::new(false),
            paused_until: AtomicU64::new(0),
        }
    }

    fn exec(&self) -> Result<&Exec, Fault> {
        self.exec
            .as_ref()
            .ok_or_else(|| Fault::new("gh_missing", MISSING))
    }

    /// Fails `gh_missing` when gh is not installed.
    pub fn require(&self) -> Result<(), Fault> {
        self.exec().map(|_| ())
    }

    /// The GitHub host a run reaches: the one its arguments name (`gate::named_host`), else `GH_HOST` of the run, else
    /// of main's environment, else github.com.
    fn host<'a>(exec: &'a Exec, args: &[&'a str], opts: &Opts<'a>) -> &'a str {
        gate::named_host(args)
            .or_else(|| {
                opts.env
                    .iter()
                    .find(|(name, _)| *name == "GH_HOST")
                    .map(|(_, value)| *value)
            })
            .or_else(|| exec.env("GH_HOST"))
            .filter(|host| !host.is_empty())
            .unwrap_or("github.com")
    }

    /// The gh guard's shared reading of the account's quota (`resources/gui-bridge/gh-guard.ts` `budgetDir`):
    /// `$OMPDESK_GH_BUDGET_DIR`, else `~/.cache/ompdesk/gh-budget`, `rate-limit.json`. Only github.com's: an Enterprise
    /// host has a quota of its own.
    fn budget_file(exec: &Exec, host: &str) -> Option<PathBuf> {
        if host != "github.com" {
            return None;
        }
        let dir = match exec
            .env("OMPDESK_GH_BUDGET_DIR")
            .filter(|dir| !dir.is_empty())
        {
            Some(dir) => PathBuf::from(dir),
            None => {
                let home = exec
                    .env(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .filter(|home| !home.is_empty())?;
                Path::new(home)
                    .join(".cache")
                    .join("ompdesk")
                    .join("gh-budget")
            }
        };
        Some(dir.join("rate-limit.json"))
    }

    /// `gh api rate_limit` on `host` (it costs no quota), read as the gate reads it, and stored where the gh guard
    /// reads it; `None` when it fails.
    async fn quota(
        exec: &Exec,
        cwd: &str,
        host: &str,
        opts: Opts<'_>,
        shared: Option<&Path>,
    ) -> Option<gate::Quota> {
        let opts = Opts {
            timeout_ms: Some(gate::QUOTA_READ_MS),
            env: opts.env,
            ..Opts::default()
        };
        let output = exec
            .run(cwd, &["api", "--hostname", host, "rate_limit"], opts)
            .await
            .ok()?;
        if output.code != 0 {
            return None;
        }
        let text = output.text();
        if let (Some(file), Some(reading)) = (shared, gate::reading_of(&text, gate::now_ms())) {
            // Written as the guard writes it (a temp file renamed over); a failed write only costs a later read.
            let temp = file.with_extension(format!("json.{}.tmp", std::process::id()));
            let _ = file
                .parent()
                .map(std::fs::create_dir_all)
                .transpose()
                .and_then(|_| std::fs::write(&temp, reading))
                .and_then(|()| std::fs::rename(&temp, file));
        }
        gate::read_quota(&text, gate::QUOTA_FLOOR)
    }

    /// One gh run through the gate of its host and quota: refused while they wait (`gh_paused`), a read run again on a
    /// GitHub server error or a dropped connection, and gh's "rate limit" trips the gate for every request of the host.
    async fn run(&self, cwd: &str, args: &[&str], opts: Opts<'_>) -> Result<Output, Fault> {
        let exec = self.exec()?;
        if !gate::gated(args) {
            return exec.run(cwd, args, opts).await;
        }
        let host = Gh::host(exec, args, &opts);
        let bucket = gate::bucket(args);
        let key = format!("{}\n{host}", self.command);
        let shared = Gh::budget_file(exec, host);
        let first = !self.admitted.swap(true, Ordering::SeqCst);
        if self.background && first {
            let stored = shared
                .as_deref()
                .and_then(|file| std::fs::read_to_string(file).ok())
                .and_then(|text| gate::stored_quota(&text, gate::now_ms()));
            if stored.is_some() {
                gate::learn(&key, stored.as_ref());
            } else if gate::quota_due(&key, gate::now_ms()) {
                gate::learn(
                    &key,
                    Gh::quota(exec, cwd, host, opts, shared.as_deref())
                        .await
                        .as_ref(),
                );
            }
        }
        if let Err(wait) = gate::admit(&key, bucket, self.background, first, gate::now_ms()) {
            self.paused_until.store(wait.until(), Ordering::SeqCst);
            return Err(wait.fault(host));
        }
        let mut retries = gate::RETRY_DELAYS_MS.iter();
        loop {
            let output = exec.run(cwd, args, opts).await?;
            if output.code == 0 {
                return Ok(output);
            }
            if gate::rate_limited(&output.stderr) {
                let quota = Gh::quota(exec, cwd, host, opts, shared.as_deref()).await;
                let until = gate::trip(&key, bucket, quota.as_ref(), gate::now_ms());
                self.paused_until.store(until, Ordering::SeqCst);
                return Ok(output);
            }
            match retries.next() {
                Some(&delay) if gate::is_read(args) && gate::transient(&output.stderr) => {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
                _ => return Ok(output),
            }
        }
    }

    /// ` (paused until …)` after gh's own words when this request tripped the gate.
    fn pause_note(&self) -> String {
        match self.paused_until.load(Ordering::SeqCst) {
            0 => String::new(),
            until => format!(
                " (GitHub paused until {})",
                crate::aimemory::value::iso(until)
            ),
        }
    }

    /// `gh()`: stdout as text; a non-zero exit fails with gh's stderr (else `gh <a> <b> exited with code <n>`), an
    /// output past the cap with `gh <a> <b> output exceeded the size cap`.
    pub async fn call(&self, cwd: &str, args: &[&str], opts: Opts<'_>) -> Result<String, Fault> {
        let output = self.run(cwd, args, opts).await?;
        let command = args[..args.len().min(2)].join(" ");
        // A cut output is told as such whatever the exit: the cap's own SIGTERM ends a gh still writing with a
        // non-zero code, which a gh that exited first does not have (node's maxBuffer error came first the same way).
        if output.truncated {
            return Err(Fault::new(
                "gh_exit",
                format!("gh {command} output exceeded the size cap"),
            ));
        }
        if output.code != 0 {
            let stderr = js_trim(&output.stderr);
            let message = if stderr.is_empty() {
                format!("gh {command} exited with code {}", output.code)
            } else {
                stderr.to_owned()
            };
            return Err(Fault::new("gh_exit", message + &self.pause_note()));
        }
        Ok(output.text())
    }

    /// `ghText()`: run to completion in 30 s and answer whatever the exit code.
    pub async fn text(&self, cwd: &str, args: &[&str]) -> Result<TextOutput, Fault> {
        let opts = Opts {
            timeout_ms: Some(TEXT_TIMEOUT_MS),
            ..Opts::default()
        };
        let output = self.run(cwd, args, opts).await?;
        Ok(TextOutput {
            code: output.code,
            stdout: output.text(),
            stderr: self.scrub(output.stderr),
        })
    }

    pub(crate) fn scrub(&self, mut text: String) -> String {
        for secret in &self.secrets {
            if text.contains(secret.as_str()) {
                text = text.replace(secret.as_str(), "***");
            }
        }
        text
    }

    /// The request's answer, no fault carrying a token; a request the gate refused or tripped is `gh_paused`
    /// whatever code its rules gave the failure, so the page and main read the wait.
    fn answer(&self, outcome: Result<Reply, Fault>) -> Result<Reply, Fault> {
        outcome.map_err(|fault| {
            let paused =
                self.paused_until.load(Ordering::SeqCst) != 0 && fault != Fault::cancelled();
            Fault {
                code: if paused {
                    "gh_paused".into()
                } else {
                    fault.code
                },
                message: self.scrub(fault.message),
            }
        })
    }
}

/// gh and git for one request: git finds the checkout root (`repoRoot`) and a draft's commits.
pub struct Tools {
    pub gh: Gh,
    git: Option<Git>,
}

impl Tools {
    fn new(runners: Runners, scope: Scope) -> Tools {
        Tools {
            gh: Gh::paced(runners.gh, scope.clone(), runners.background),
            git: runners.git.map(|runner| Git::new(runner, scope)),
        }
    }

    /// `gitRunner()`'s refusal when git is missing.
    pub fn git(&self) -> Result<&Git, Fault> {
        self.git
            .as_ref()
            .ok_or_else(|| Fault::new("git_missing", "git is not installed or not on PATH"))
    }
}

/// A private file gh reads a text from: `<temp>/omp-pr-body-XXXXXX/body.md` (`withBodyFile`), removed with its folder
/// when dropped.
pub struct BodyFile {
    dir: PathBuf,
    path: String,
}

impl BodyFile {
    pub async fn new(text: &str) -> Result<BodyFile, Fault> {
        let text = text.to_owned();
        tokio::task::spawn_blocking(move || {
            let dir = disk::make_temp_dir("omp-pr-body-")?;
            let file = dir.join("body.md");
            let path = file.to_string_lossy().into_owned();
            let body = BodyFile { dir, path };
            std::fs::write(&file, text)
                .map_err(|error| NodeError::new(&error, "open", Some(&body.path)))?;
            Ok(body)
        })
        .await
        .map_err(|_| Fault::new("internal", "The body file's disk work panicked"))?
        .map_err(|error: NodeError| error.fault(Codes::None))
    }

    pub fn path(&self) -> &str {
        &self.path
    }
}

impl Drop for BodyFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// How gh and git run, as main hands them over; none for a tool that is not installed. `background`: the request is
/// not the person's own (`gate.rs`).
#[derive(Deserialize)]
struct Runners {
    gh: Option<Runner>,
    #[serde(default)]
    git: Option<Runner>,
    #[serde(default)]
    background: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunParams {
    gh: Runner,
    cwd: String,
    args: Vec<String>,
    timeout_ms: Option<u64>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    background: bool,
}

#[derive(Deserialize)]
struct TextParams {
    gh: Runner,
    cwd: String,
    args: Vec<String>,
    #[serde(default)]
    background: bool,
}

#[derive(Deserialize)]
struct At {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
}

/// A PR number the page sent: JSON carries no NaN or infinity, which arrive as `null`.
#[derive(Deserialize)]
struct Numbered {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    number: Option<f64>,
}

#[derive(Deserialize)]
struct ListParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    state: Option<String>,
    limit: Option<f64>,
    #[serde(default)]
    view: pr::View,
    #[serde(default)]
    filter: pr::Filter,
}

#[derive(Deserialize)]
struct DiffParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    number: Option<f64>,
    path: String,
}

/// `timeoutMs`: `gh pr create`'s or `gh pr merge`'s timeout, main's to choose.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    #[serde(flatten)]
    input: pr::CreateInput,
    timeout_ms: u64,
}

/// A PR number main checked (a safe positive integer).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    number: u64,
    method: pr::MergeMethod,
    #[serde(default)]
    delete_branch: bool,
    timeout_ms: u64,
}

/// `body`: trimmed by main, which refused an empty one where the event needs text.
#[derive(Deserialize)]
struct ReviewParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    number: u64,
    event: pr::ReviewEvent,
    body: String,
}

#[derive(Deserialize)]
struct CommentParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    number: u64,
    body: String,
}

#[derive(Deserialize)]
struct CommentsParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    number: u64,
}

#[derive(Deserialize)]
struct EditParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    number: u64,
    title: Option<String>,
    body: Option<String>,
    base: Option<String>,
}

/// `request`: what `parseGithubRequest` passed; `cloneTimeoutMs`, `logTimeoutMs`: main's timeouts of a clone and of a
/// run log.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CenterParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    request: serde_json::Value,
    clone_timeout_ms: u64,
    log_timeout_ms: u64,
}

pub fn register(registry: &mut Registry) {
    auth::register(registry);
    registry.add("gh.run", |call| {
        Box::pin(async move {
            let RunParams {
                gh,
                cwd,
                args,
                timeout_ms,
                env,
                background,
            } = call.params()?;
            let gh = Gh::paced(Some(gh), call.scope, background);
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            let env: Vec<(&str, &str)> =
                env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            let opts = Opts {
                timeout_ms,
                env: &env,
                ..Opts::default()
            };
            let outcome = gh.call(&cwd, &args, opts).await;
            gh.answer(outcome.and_then(|stdout| Reply::json(&stdout)))
        })
    });
    registry.add("gh.text", |call| {
        Box::pin(async move {
            let TextParams {
                gh,
                cwd,
                args,
                background,
            } = call.params()?;
            let gh = Gh::paced(Some(gh), call.scope, background);
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            let outcome = gh.text(&cwd, &args).await;
            gh.answer(outcome.and_then(|output| Reply::json(&output)))
        })
    });
    registry.add("gh.repo", |call| {
        Box::pin(async move {
            let At { runners, cwd } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::repo(&tools, &cwd).await;
            tools.gh.answer(outcome.and_then(|repo| Reply::json(&repo)))
        })
    });
    registry.add("gh.prRepo", |call| {
        Box::pin(async move {
            let At { runners, cwd } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::availability(&tools, &cwd).await;
            tools.gh.answer(outcome.and_then(|repo| Reply::json(&repo)))
        })
    });
    registry.add("gh.prList", |call| {
        Box::pin(async move {
            let ListParams {
                runners,
                cwd,
                state,
                limit,
                view,
                filter,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::list(&tools, &cwd, state.as_deref(), limit, view, &filter).await;
            tools.gh.answer(outcome.and_then(|rows| Reply::json(&rows)))
        })
    });
    registry.add("gh.prGet", |call| {
        Box::pin(async move {
            let Numbered {
                runners,
                cwd,
                number,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::detail(&tools, &cwd, number).await;
            tools
                .gh
                .answer(outcome.and_then(|detail| Reply::json(&detail)))
        })
    });
    registry.add("gh.prDiff", |call| {
        Box::pin(async move {
            let DiffParams {
                runners,
                cwd,
                number,
                path,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::diff(&tools, &cwd, number, &path).await;
            tools.gh.answer(outcome.and_then(|diff| Reply::json(&diff)))
        })
    });
    draft::register(registry);
    registry.add("gh.prCreate", |call| {
        Box::pin(async move {
            let CreateParams {
                runners,
                cwd,
                input,
                timeout_ms,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::create(&tools, &cwd, &input, timeout_ms).await;
            tools
                .gh
                .answer(outcome.and_then(|created| Reply::json(&created)))
        })
    });
    registry.add("gh.prMerge", |call| {
        Box::pin(async move {
            let MergeParams {
                runners,
                cwd,
                number,
                method,
                delete_branch,
                timeout_ms,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::merge(&tools, &cwd, number, method, delete_branch, timeout_ms).await;
            tools
                .gh
                .answer(outcome.and_then(|merged| Reply::json(&merged)))
        })
    });
    registry.add("gh.prReview", |call| {
        Box::pin(async move {
            let ReviewParams {
                runners,
                cwd,
                number,
                event,
                body,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::review(&tools, &cwd, number, event, &body).await;
            tools
                .gh
                .answer(outcome.and_then(|submitted| Reply::json(&submitted)))
        })
    });
    registry.add("gh.prComment", |call| {
        Box::pin(async move {
            let CommentParams {
                runners,
                cwd,
                number,
                body,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::comment(&tools, &cwd, number, &body).await;
            tools
                .gh
                .answer(outcome.and_then(|submitted| Reply::json(&submitted)))
        })
    });
    registry.add("gh.prComments", |call| {
        Box::pin(async move {
            let CommentsParams {
                runners,
                cwd,
                number,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::comments(&tools, &cwd, number).await;
            tools
                .gh
                .answer(outcome.and_then(|comments| Reply::json(&comments)))
        })
    });
    registry.add("gh.prEdit", |call| {
        Box::pin(async move {
            let EditParams {
                runners,
                cwd,
                number,
                title,
                body,
                base,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let edit = pr::Edit {
                title: title.as_deref(),
                body: body.as_deref(),
                base: base.as_deref(),
            };
            let outcome = pr::edit(&tools, &cwd, number, edit).await;
            tools
                .gh
                .answer(outcome.and_then(|edited| Reply::json(&edited)))
        })
    });
    registry.add("gh.github", |call| {
        Box::pin(async move {
            let CenterParams {
                runners,
                cwd,
                request,
                clone_timeout_ms,
                log_timeout_ms,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let timeouts = center::Timeouts {
                clone_ms: clone_timeout_ms,
                log_ms: log_timeout_ms,
            };
            let outcome = center::command(&tools, &cwd, &request, timeouts).await;
            tools.gh.answer(outcome)
        })
    });
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::run::tests::shell;

    const TOKEN: &str = "ghp_Z9y8Z9y8Z9y8Z9y8Z9y8Z9y8Z9y8Z9y8Z9y8";

    /// A gh that is `/bin/sh -c` with a token in its environment, as main hands one over when the person exported it.
    fn gh_with_token(timeout_ms: u64, max_bytes: usize) -> Gh {
        let mut runner = shell(timeout_ms, max_bytes);
        runner.env.insert("GH_TOKEN".into(), TOKEN.into());
        runner.env.insert("github_token".into(), TOKEN.into());
        runner.env.insert("PATH".into(), "/usr/bin:/bin".into());
        Gh::new(Some(runner), Scope::detached())
    }

    #[tokio::test]
    async fn answers_gh_s_failures_as_the_typescript_threw_them() {
        let gh = gh_with_token(10_000, 1024);
        let silent = gh.call("/", &["exit 3", "b", "c"], Opts::default()).await;
        assert_eq!(
            silent.unwrap_err().message,
            "gh exit 3 b exited with code 3"
        );
        let said = gh
            .call("/", &["echo ' no such pr ' >&2; exit 1"], Opts::default())
            .await;
        assert_eq!(said.unwrap_err().message, "no such pr");
        let cut = Gh::new(Some(shell(10_000, 4)), Scope::detached())
            .call("/", &["printf 0123456789"], Opts::default())
            .await;
        assert_eq!(
            cut.unwrap_err().message,
            "gh printf 0123456789 output exceeded the size cap"
        );
        let text = gh
            .text("/", &["echo out; echo err >&2; exit 4"])
            .await
            .unwrap();
        assert_eq!(
            (text.code, text.stdout.as_str(), text.stderr.as_str()),
            (4, "out\n", "err\n")
        );
        let missing = Gh::new(None, Scope::detached())
            .call("/", &["x"], Opts::default())
            .await;
        assert_eq!(missing.unwrap_err(), Fault::new("gh_missing", MISSING));
    }

    /// Every way a gh run fails, with a token in its environment that the stand-in prints: no message, no stderr the
    /// core answers and nothing the core writes to its own stderr carries it.
    #[tokio::test]
    async fn a_failing_gh_reports_nothing_of_a_token_in_its_environment() {
        let gh = gh_with_token(300, 8);
        let failed = gh
            .call(
                "/",
                &["echo \"bad credentials $GH_TOKEN\" >&2; exit 1"],
                Opts::default(),
            )
            .await
            .unwrap_err();
        let timed_out = gh
            .call("/", &["sleep 5 # $GH_TOKEN"], Opts::default())
            .await
            .unwrap_err();
        let cut = gh
            .call("/", &["echo \"$GH_TOKEN\""], Opts::default())
            .await
            .unwrap_err();
        let text = gh
            .text("/", &["echo \"$GH_TOKEN\" >&2; exit 2"])
            .await
            .unwrap();
        let mut runner = shell(1_000, 8);
        runner.bin = "/no/such/gh".into();
        runner.env.insert("GH_TOKEN".into(), TOKEN.into());
        let spawn = Gh::new(Some(runner), Scope::detached())
            .call("/", &["x"], Opts::default())
            .await
            .unwrap_err();
        let answered = |fault: Fault| gh.answer(Err(fault)).err().unwrap().message;
        let messages = [
            answered(failed),
            answered(timed_out),
            answered(cut),
            answered(spawn),
            text.stderr.clone(),
        ];
        assert_eq!(messages[0], "bad credentials ***");
        assert_eq!(text.stderr, "***\n");
        for message in &messages {
            assert!(!message.contains(TOKEN), "{message}");
            assert!(!message.contains(&TOKEN[4..20]), "{message}");
        }
    }

    /// gh says "rate limit" once: that request answers `gh_paused` with the reset GitHub names, and every later run of
    /// the host that spends the spent quota (GraphQL here) is refused without starting gh, while a REST read and a
    /// sign-in check still run and another host is not held. An Enterprise host named in argv is held, not github.com.
    #[tokio::test]
    async fn a_rate_limit_holds_every_run_of_its_host_and_quota_until_the_reset() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("ompdesk-core-gh-gate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let runs = dir.join("runs");
        let script = dir.join("gh");
        let reset = gate::now_ms() / 1_000 + 3_600;
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\ncase \" $* \" in *\" rate_limit \"*) echo '{{\"resources\":{{\"core\":{{\"remaining\":4000,\"reset\":{reset}}},\"graphql\":{{\"remaining\":0,\"reset\":{reset}}}}}}}'; exit 0;; esac\necho \"$1\" >> \"{runs}\"\necho 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' >&2\nexit 1\n",
                runs = runs.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let runner = |host: &str| {
            let mut runner = shell(10_000, 1024);
            runner.bin = script.to_string_lossy().into_owned();
            runner.args = Vec::new();
            runner.env.insert("GH_HOST".into(), host.into());
            runner
        };
        let gh = Gh::new(Some(runner("gate.test")), Scope::detached());
        let fault = gh
            .call("/", &["pr", "list"], Opts::default())
            .await
            .unwrap_err();
        let answered = gh.answer(Err(fault)).err().unwrap();
        let until = crate::aimemory::value::iso(reset * 1_000);
        assert_eq!(answered.code, "gh_paused");
        assert_eq!(
            answered.message,
            format!(
                "gh: API rate limit exceeded for user ID 1. (HTTP 403) (GitHub paused until {until})"
            )
        );
        let later = Gh::new(Some(runner("gate.test")), Scope::detached());
        let refused = later
            .call("/", &["repo", "view"], Opts::default())
            .await
            .unwrap_err();
        assert_eq!(refused.code, "gh_paused");
        assert!(
            refused.message.ends_with(&format!("paused until {until}")),
            "{}",
            refused.message
        );
        let _ = later.text("/", &["auth", "status"]).await.unwrap();
        let _ = later.call("/", &["run", "list"], Opts::default()).await;
        let other = Gh::new(Some(runner("other-gate.test")), Scope::detached());
        let _ = other.call("/", &["issue", "list"], Opts::default()).await;
        let github = Gh::new(Some(runner("")), Scope::detached());
        let _ = github
            .call(
                "/",
                &["issue", "list", "--repo", "ghe-gate.test/o/r"],
                Opts::default(),
            )
            .await;
        let held = github
            .call(
                "/",
                &["api", "--hostname", "ghe-gate.test", "graphql"],
                Opts::default(),
            )
            .await
            .unwrap_err();
        assert_eq!(held.code, "gh_paused");
        assert!(
            held.message.contains("for ghe-gate.test"),
            "{}",
            held.message
        );
        let _ = github.call("/", &["label", "list"], Opts::default()).await;
        assert_eq!(
            std::fs::read_to_string(&runs).unwrap(),
            "pr\nauth\nrun\nissue\nissue\nlabel\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn removes_a_body_file_with_its_folder() {
        let body = BodyFile::new("Body 한").await.unwrap();
        let file = PathBuf::from(body.path());
        let dir = file.parent().unwrap().to_path_buf();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "Body 한");
        assert!(
            dir.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("omp-pr-body-")
        );
        assert_eq!(file.file_name().unwrap(), "body.md");
        drop(body);
        assert!(!dir.exists());
    }

    /// A cancelled request's gh is ended before the call returns, and only then is its body file removed: the file
    /// outlives the process that reads it, and nothing outlives the request.
    #[tokio::test]
    async fn a_cancelled_gh_has_exited_before_its_body_file_goes() {
        let marker =
            std::env::temp_dir().join(format!("ompdesk-core-gh-body-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let scope = Scope::detached();
        let gh = Gh::new(Some(shell(60_000, 1024)), scope.clone());
        let body = BodyFile::new("text").await.unwrap();
        let dir = PathBuf::from(body.path()).parent().unwrap().to_path_buf();
        let script = format!(
            "trap 'cat \"$0\" > \"{marker}\"; exit 1' TERM; touch \"{marker}.up\"; while :; do sleep 0.05; done",
            marker = marker.display()
        );
        let args = [script.as_str(), body.path()];
        let started = format!("{}.up", marker.display());
        let (outcome, ()) = tokio::join!(gh.call("/", &args, Opts::default()), async {
            while !std::path::Path::new(&started).exists() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            scope.cancel();
        });
        assert_eq!(outcome.unwrap_err(), Fault::cancelled());
        // The process read the body after the cancel's SIGTERM: the file was there until it exited.
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "text");
        drop(body);
        assert!(!dir.exists());
        let _ = std::fs::remove_file(&marker);
        let _ = std::fs::remove_file(started);
    }
}
