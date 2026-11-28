//! Routine triggers' reads and rules. The schedules service owns their timers, watches, marks and live generations.
//!
//! - `routines.github`: one read of one kind of a GitHub trigger (`github.rs`), gh run as main's `ghRunner` says.
//! - `routines.filesScan`: a files trigger's listing and what changed while OMPdesk was closed (`files.rs`).
//! - `routines.readMailbox`: the read-only IMAP exchange and MIME decoding (`imap`).
//! - The git trigger's two reads are `git.routineHead` and `git.routineCommits` (`git/triggers.rs`), whose line is
//!   `text.rs`' `describe_commits`.
//!
//! Nothing here logs a request: a GitHub read's failure carries gh's words with the values of gh's token variables
//! replaced (`Gh::scrub`).

pub(crate) mod connectors;
mod files;
pub(crate) mod github;
pub(crate) mod google;
mod imap;
pub(crate) mod ipc;
pub(crate) mod runtime;
pub(crate) mod slack_mirror;
pub(crate) mod text;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::gh::Gh;
use crate::json::whole_surrogates;
use crate::run::{Opts, Runner};
use crate::server::{Fault, Registry, Reply};

/// What a GitHub read answers where `ghApi` threw it.
const GH_MISSING: &str = "the GitHub CLI (gh) is not installed";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubParams {
    /// Main's runner, `null` when gh is not installed.
    gh: Option<Runner>,
    /// Where gh runs: an endpoint names its repository, so no repository folder is needed.
    home: String,
    /// `owner/name`, checked by main (`usableRepo`).
    repo: String,
    kind: String,
    /// What the last read answered, when there was one; else `mark`, the last launch's.
    state: Option<github::State>,
    mark: Option<Value>,
    /// How long one `gh api` may take.
    timeout_ms: u64,
}

#[derive(Serialize)]
struct GithubAnswer {
    state: github::State,
    /// What to keep for the next launch (only after a read that did not fail).
    #[serde(skip_serializing_if = "Option::is_none")]
    mark: Option<Value>,
    lines: Vec<String>,
    error: Option<String>,
}

struct GhApi<'a> {
    gh: &'a Gh,
    home: &'a str,
    timeout_ms: u64,
}

impl github::Api for GhApi<'_> {
    async fn get(&self, endpoint: &str) -> Result<Value, String> {
        let opts = Opts {
            timeout_ms: Some(self.timeout_ms),
            ..Opts::default()
        };
        let stdout = match self.gh.call(self.home, &["api", endpoint], opts).await {
            Ok(stdout) => stdout,
            Err(fault) if fault.code == "gh_missing" => return Err(GH_MISSING.into()),
            Err(fault) => return Err(self.gh.scrub(fault.message)),
        };
        serde_json::from_str(&whole_surrogates(&stdout)).map_err(|error| error.to_string())
    }
}

#[derive(Deserialize)]
struct ScanParams {
    path: String,
    ignored: Vec<String>,
    mark: Option<Value>,
}

pub fn register(registry: &mut Registry) {
    imap::register(registry);
    google::register(registry);
    ipc::register(registry);
    // The computer woke or came back online: a bot's Slack socket waiting to reconnect goes at once.
    registry.add("routines.wake", |_call| {
        Box::pin(async move {
            runtime::wake_sockets();
            Reply::json(&Value::Null)
        })
    });
    // Settings' check of a bot's Slack app before main keeps its tokens: whose workspace and bot user the bot token
    // is (Slack's `auth.test`). The tokens come with the request and go nowhere else.
    registry.add("connectors.slackCheck", |call| {
        Box::pin(async move {
            let params: Value = call.params()?;
            let token = params["botToken"].as_str().unwrap_or_default();
            if !token.starts_with("xoxb-") {
                return Err(Fault::new(
                    "invalid_params",
                    "The bot token starts with xoxb-",
                ));
            }
            let app = params["appToken"].as_str().unwrap_or_default();
            if !app.is_empty() && !app.starts_with("xapp-") {
                return Err(Fault::new(
                    "invalid_params",
                    "The app-level token starts with xapp-",
                ));
            }
            let said = connectors::slack_api(token, "auth.test", &serde_json::json!({}))
                .await
                .map_err(|error| Fault::new("slack_refused", error))?;
            let text = |key: &str| said[key].as_str().unwrap_or_default().to_owned();
            Reply::json(&serde_json::json!({
                "teamId": text("team_id"),
                "team": text("team"),
                "userId": text("user_id"),
                "botId": text("bot_id"),
                "url": text("url"),
            }))
        })
    });
    registry.add("routines.github", |call| {
        Box::pin(async move {
            let params: GithubParams = call.params()?;
            let kind = github::Kind::parse(&params.kind)
                .ok_or_else(|| Fault::new("invalid_params", "unknown GitHub event kind"))?;
            let mut state = match params.state {
                Some(state) => state,
                None => github::State::restore(params.mark.as_ref()),
            };
            // A trigger's read is never the person's own: it waits behind the GitHub gate (`gh/gate.rs`).
            let gh = Gh::paced(params.gh, call.scope, true);
            let api = GhApi {
                gh: &gh,
                home: &params.home,
                timeout_ms: params.timeout_ms,
            };
            let outcome = github::read(&api, &params.repo, kind, &mut state).await;
            let (lines, error) = match outcome {
                Ok(lines) => (lines, None),
                Err(message) => (Vec::new(), Some(message)),
            };
            Reply::json(&GithubAnswer {
                mark: error.is_none().then(|| state.mark()),
                state,
                lines,
                error,
            })
        })
    });
    registry.add("routines.filesScan", |call| {
        Box::pin(async move {
            let ScanParams {
                path,
                ignored,
                mut mark,
            } = call.params()?;
            let scan = tokio::task::spawn_blocking(move || files::scan(&path, &ignored, &mut mark))
                .await
                .map_err(|error| Fault::new("internal", error.to_string()))??;
            Reply::json(&scan)
        })
    });
}

/// A table of `captured.json`: what the TypeScript answered for the same inputs before it was deleted (commit
/// `b0c90dd3`).
#[cfg(test)]
fn captured(table: &str) -> Vec<Value> {
    let rows: Value = serde_json::from_str(include_str!("captured.json")).unwrap();
    rows[table].as_array().unwrap().clone()
}
