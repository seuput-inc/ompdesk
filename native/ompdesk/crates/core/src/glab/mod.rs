//! Agents › GitHub › GitLab: merge requests over the GitLab CLI (`glab`), after Orca's GitLab sources
//! (`main/gitlab/requests/*`, `main/gitlab/merge-requests/*` at stablyai/orca 02cecc98). Main decides how glab runs
//! (`glabRunner` in `src/main/local/git/exec.ts`: the binary `resolveBin("glab")` found and stock omp's non-interactive
//! environment for it, `utils/gitlab.ts` `GLAB_SPEC`) and hands it over with every request, `null` when glab is not
//! installed (`glab_missing`).
//!
//! - At most four glab runs at once with a 30 s wait for a slot (Orca `glab-request-admission.ts:4-58`; the slots are
//!   `trackers::admit`'s). A read is never run twice on its own; a write never is.
//! - A token in the environment (`GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN`, `OAUTH_TOKEN`) goes to whatever host glab talks
//!   to, so a project named on another host is refused unless that host is gitlab.com, `GITLAB_HOST` (or `GITLAB_URI`,
//!   `GL_HOST`), a host glab is signed in to, or the checkout's own: stock omp's rule for its `glab-mr` tool
//!   (`tools/glab-mr.ts:40-78` `assertGitlabHostTrustedForEnvToken`), whose config-file hosts are read here from
//!   `glab auth status`.
//! - The rate-limit headers of the last list come back with it (`gitlab-auth-and-rate-limit.ts:84-129`).
//!
//! A token never leaves through a message: the environment's token values and a sign-in's token are replaced by
//! `***` in every fault.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::fs::order::js_trim;
use crate::run::{Exec, Opts, Runner};
use crate::server::{Fault, Registry, Reply, Scope};
use crate::trackers::{Service, admit};

const MISSING: &str = "GitLab CLI (glab) is not installed";
const TOKEN_VARIABLES: [&str; 3] = ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"];
const HOST_VARIABLES: [&str; 3] = ["GITLAB_HOST", "GITLAB_URI", "GL_HOST"];
const SHORTEST_SECRET: usize = 8;
const PER_PAGE: u32 = 30;

/// A host with an optional port (stock `GITLAB_HOST_PATTERN`).
fn valid_host(host: &str) -> bool {
    let (name, port) = host.split_once(':').unwrap_or((host, ""));
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
        && port.bytes().all(|byte| byte.is_ascii_digit())
}

/// `<host>/<namespace…>/<project>`, each segment stock's `GITLAB_PATH_SEGMENT_PATTERN`.
fn split_project(project: &str) -> Option<(&str, &str)> {
    let (host, path) = project.split_once('/')?;
    let segments: Vec<&str> = path.split('/').collect();
    let valid = segments.len() >= 2
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
        });
    (valid_host(host) && valid).then_some((host, path))
}

/// A project's web address as `<host>/<path>` (stock `parseGitlabProjectWebUrl`).
fn project_of_url(web_url: &str) -> Option<String> {
    let url = url::Url::parse(web_url.trim().trim_end_matches(".git")).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = match url.port() {
        Some(port) => format!("{}:{port}", url.host_str()?),
        None => url.host_str()?.to_owned(),
    };
    let project = format!(
        "{}/{}",
        host.to_ascii_lowercase(),
        url.path().trim_matches('/')
    );
    split_project(&project).is_some().then_some(project)
}

/// The hosts `glab auth status` names: each line that is a bare host (Orca `parseGlabAuthStatusHosts`).
fn status_hosts(output: &str) -> Vec<String> {
    let mut hosts = BTreeSet::new();
    for line in output.lines() {
        let bare = line.trim();
        let host = bare.strip_suffix(':').unwrap_or(bare);
        if line == bare && host.contains('.') && valid_host(host) {
            hosts.insert(host.to_ascii_lowercase());
        }
        // `✓ Logged in to gitlab.example.com as jin`
        if let Some(rest) = bare.split("Logged in to ").nth(1)
            && let Some(host) = rest.split_whitespace().next()
            && valid_host(host)
        {
            hosts.insert(host.to_ascii_lowercase());
        }
    }
    hosts.into_iter().collect()
}

/// `glab api -i`'s answer: its status, its headers (names in lowercase) and its body.
struct ApiAnswer {
    headers: Vec<(String, String)>,
    body: String,
}

impl ApiAnswer {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// Headers end at the first empty line, CRLF or LF (Orca `glab-api-response.ts:7-24`).
fn parse_api(stdout: &str) -> ApiAnswer {
    let mut headers = Vec::new();
    let mut rest = stdout;
    loop {
        let (line, after) = match rest.find('\n') {
            Some(at) => (&rest[..at], &rest[at + 1..]),
            None => {
                return ApiAnswer {
                    headers: Vec::new(),
                    body: stdout.to_owned(),
                };
            }
        };
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            return ApiAnswer {
                headers,
                body: after.to_owned(),
            };
        }
        if let Some((name, value)) = line.split_once(':')
            && !name.contains(' ')
        {
            headers.push((name.to_ascii_lowercase(), value.trim().to_owned()));
        }
        rest = after;
    }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Rate {
    limit: Option<u64>,
    remaining: Option<u64>,
    /// Epoch seconds.
    reset_at: Option<u64>,
}

fn rate(answer: &ApiAnswer) -> Option<Rate> {
    let number = |names: &[&str]| {
        names.iter().find_map(|name| {
            answer
                .header(name)
                .and_then(|value| value.trim().parse::<u64>().ok())
        })
    };
    let rate = Rate {
        limit: number(&["ratelimit-limit", "x-ratelimit-limit"]),
        remaining: number(&["ratelimit-remaining", "x-ratelimit-remaining"]),
        reset_at: number(&["ratelimit-reset", "x-ratelimit-reset"]),
    };
    (rate.limit.is_some() || rate.remaining.is_some() || rate.reset_at.is_some()).then_some(rate)
}

/// A glab failure by its words (Orca `glab-error-classification.ts:5-29`).
fn classify(words: &str) -> &'static str {
    let lower = words.to_ascii_lowercase();
    if lower.contains("401")
        || lower.contains("glab auth login")
        || lower.contains("not logged in")
        || lower.contains("has not been authenticated")
    {
        "glab_unauthenticated"
    } else if lower.contains("403")
        || lower.contains("forbidden")
        || lower.contains("insufficient_scope")
    {
        "gitlab_forbidden"
    } else if lower.contains("404") || lower.contains("not found") {
        "gitlab_not_found"
    } else if lower.contains("429") || lower.contains("rate limit") {
        "gitlab_rate_limited"
    } else {
        "gitlab_failed"
    }
}

struct Glab {
    exec: Exec,
    cwd: String,
    secrets: Vec<String>,
    /// A token in the environment, which glab sends to any host.
    env_token: bool,
}

impl Glab {
    fn new(runner: Runner, scope: Scope, cwd: String) -> Glab {
        let exec = Exec::new(runner, scope, "glab");
        let secrets: Vec<String> = TOKEN_VARIABLES
            .iter()
            .filter_map(|name| exec.env(name))
            .filter(|value| value.len() >= SHORTEST_SECRET)
            .map(str::to_owned)
            .collect();
        Glab {
            env_token: TOKEN_VARIABLES
                .iter()
                .any(|name| exec.env(name).is_some_and(|value| !value.is_empty())),
            exec,
            cwd,
            secrets,
        }
    }

    fn scrub(&self, mut text: String) -> String {
        for secret in &self.secrets {
            text = text.replace(secret.as_str(), "***");
        }
        text
    }

    /// One glab run in a slot; stdout, or a classified fault with glab's words.
    async fn run(&self, args: &[&str], input: Option<&[u8]>) -> Result<String, Fault> {
        let _slot = admit(Service::Gitlab).await?;
        let output = self
            .exec
            .run(
                &self.cwd,
                args,
                Opts {
                    input,
                    ..Opts::default()
                },
            )
            .await?;
        if output.code == 0 {
            return Ok(output.text());
        }
        let stderr = js_trim(&output.stderr);
        let words = if stderr.is_empty() {
            format!(
                "glab {} exited with code {}",
                args.first().copied().unwrap_or_default(),
                output.code
            )
        } else {
            stderr.to_owned()
        };
        Err(Fault::new(classify(&words), self.scrub(words)))
    }

    async fn api(
        &self,
        host: &str,
        method: &str,
        path: &str,
        fields: &[(&str, &str)],
    ) -> Result<ApiAnswer, Fault> {
        let mut args: Vec<String> =
            vec!["api".into(), "-i".into(), "--hostname".into(), host.into()];
        if method != "GET" {
            args.extend(["-X".into(), method.into()]);
        }
        args.push(path.into());
        for (name, value) in fields {
            args.extend(["-f".into(), format!("{name}={value}")]);
        }
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let answer = parse_api(&self.run(&args, None).await?);
        Ok(answer)
    }

    /// The checkout's GitLab project (`glab repo view`), none outside one.
    async fn checkout_project(&self) -> Option<String> {
        let text = self.run(&["repo", "view", "-F", "json"], None).await.ok()?;
        let view: Value = serde_json::from_str(&text).ok()?;
        ["web_url", "http_url_to_repo"].iter().find_map(|key| {
            view.get(*key)
                .and_then(Value::as_str)
                .and_then(project_of_url)
        })
    }

    async fn hosts(&self) -> Result<(Vec<String>, String), Fault> {
        let _slot = admit(Service::Gitlab).await?;
        let output = self
            .exec
            .run(&self.cwd, &["auth", "status"], Opts::default())
            .await?;
        let text = format!("{}\n{}", output.text(), output.stderr);
        Ok((status_hosts(&text), text))
    }

    /// The project a request reaches: the one named, after the token rule, else the checkout's.
    async fn project(&self, named: Option<&str>) -> Result<String, Fault> {
        let checkout = self.checkout_project().await;
        let Some(named) = named else {
            return checkout.ok_or_else(|| {
                Fault::new(
                    "gitlab_no_project",
                    "This folder has no GitLab project; name one as host/group/project",
                )
            });
        };
        let (host, _) = split_project(named).ok_or_else(|| {
            Fault::new("invalid_params", "A GitLab project is host/group/project")
        })?;
        let host = host.to_ascii_lowercase();
        if self.env_token {
            let mut trusted: BTreeSet<String> = BTreeSet::from(["gitlab.com".to_owned()]);
            for name in HOST_VARIABLES {
                if let Some(value) = self
                    .exec
                    .env(name)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    let address = if value.contains("://") {
                        value.to_owned()
                    } else {
                        format!("https://{value}")
                    };
                    if let Some(found) = url::Url::parse(&address).ok().and_then(|url| {
                        let host = url.host_str()?.to_ascii_lowercase();
                        Some(
                            url.port()
                                .map_or(host.clone(), |port| format!("{host}:{port}")),
                        )
                    }) {
                        trusted.insert(found);
                    }
                }
            }
            trusted.extend(
                self.hosts()
                    .await
                    .map(|(hosts, _)| hosts)
                    .unwrap_or_default(),
            );
            if let Some(own) = checkout.as_deref().and_then(|own| own.split('/').next()) {
                trusted.insert(own.to_owned());
            }
            if !trusted.contains(&host) {
                return Err(Fault::new(
                    "gitlab_untrusted_host",
                    format!(
                        "A GitLab token in the environment would be sent to {host}, which is not gitlab.com, GITLAB_HOST, a host glab is signed in to or this checkout's host"
                    ),
                ));
            }
        }
        Ok(named.to_owned())
    }
}

/// `projects/<url-encoded path>`.
fn project_path(project: &str) -> (String, String) {
    let (host, path) = project.split_once('/').unwrap_or((project, ""));
    (
        host.to_owned(),
        format!("projects/{}", path.replace('/', "%2F")),
    )
}

fn text(value: &Value, path: &str) -> String {
    value
        .pointer(path)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn merge_request(row: &Value) -> Value {
    json!({
        "iid": row.get("iid").and_then(Value::as_u64).unwrap_or(0),
        "title": text(row, "/title"),
        "state": text(row, "/state"),
        "draft": row.get("draft").and_then(Value::as_bool).unwrap_or(false),
        "author": text(row, "/author/username"),
        "sourceBranch": text(row, "/source_branch"),
        "targetBranch": text(row, "/target_branch"),
        "url": text(row, "/web_url"),
        "updatedAt": text(row, "/updated_at"),
        "labels": row.get("labels").cloned().unwrap_or_else(|| json!([])),
        "notes": row.get("user_notes_count").and_then(Value::as_u64).unwrap_or(0),
        "mergeStatus": text(row, "/detailed_merge_status"),
    })
}

fn parse_json(body: &str) -> Result<Value, Fault> {
    let value: Value = serde_json::from_str(body)
        .map_err(|error| Fault::new("gitlab_failed", error.to_string()))?;
    // glab can exit 0 with an error object (Orca `glab-api-response.ts:47-61`).
    if let Some(message) = ["message", "error"]
        .iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .filter(|_| !value.is_array() && value.get("iid").is_none() && value.get("id").is_none())
    {
        return Err(Fault::new(
            classify(message),
            message.chars().take(300).collect::<String>(),
        ));
    }
    Ok(value)
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
enum Op {
    /// Which hosts glab is signed in to, and the checkout's project.
    Status,
    /// Signs glab in to `host` with a personal access token (on glab's stdin).
    Login {
        host: String,
        token: String,
    },
    MrList {
        state: String,
        search: Option<String>,
        /// `authored` or `reviewing`: the signed-in user's.
        mine: Option<String>,
    },
    MrGet {
        iid: u64,
    },
    /// `close`, `reopen`, `merge` or `approve`.
    MrAction {
        iid: u64,
        action: String,
    },
    MrComment {
        iid: u64,
        body: String,
    },
    RateLimit,
}

#[derive(Deserialize)]
struct Params {
    glab: Option<Runner>,
    cwd: String,
    request: Value,
}

async fn command(glab: &Glab, request: &Value) -> Result<Reply, Fault> {
    let invalid = |error: serde_json::Error| Fault::new("invalid_params", error.to_string());
    let op = Op::deserialize(request).map_err(invalid)?;
    let named = request.get("project").and_then(Value::as_str);
    match op {
        Op::Status => {
            let (hosts, words) = glab.hosts().await?;
            let signed_in =
                !hosts.is_empty() && !words.to_ascii_lowercase().contains("not logged in");
            Reply::json(&json!({
                "hosts": hosts,
                "signedIn": signed_in,
                "project": glab.checkout_project().await,
                "envToken": TOKEN_VARIABLES.iter().find(|name| glab.exec.env(name).is_some_and(|value| !value.is_empty())),
            }))
        }
        Op::Login { host, token } => {
            if !valid_host(&host) {
                return Err(Fault::new(
                    "invalid_params",
                    "A GitLab host is a name with an optional port",
                ));
            }
            glab.run(
                &["auth", "login", "--hostname", &host, "--stdin"],
                Some(token.as_bytes()),
            )
            .await
            .map_err(|fault| Fault {
                message: fault.message.replace(token.as_str(), "***"),
                code: fault.code,
            })?;
            Reply::json(&json!({ "ok": true }))
        }
        Op::MrList {
            state,
            search,
            mine,
        } => {
            let project = glab.project(named).await?;
            let (host, base) = project_path(&project);
            let mut query = format!(
                "{base}/merge_requests?per_page={PER_PAGE}&order_by=updated_at&sort=desc&with_merge_status_recheck=false"
            );
            if matches!(state.as_str(), "opened" | "closed" | "merged") {
                query.push_str(&format!("&state={state}"));
            }
            if let Some(search) = search
                .as_deref()
                .map(str::trim)
                .filter(|search| !search.is_empty())
            {
                let encoded: String =
                    url::form_urlencoded::byte_serialize(search.as_bytes()).collect();
                query.push_str(&format!("&search={encoded}"));
            }
            if let Some(mine) = mine.as_deref() {
                // A list filtered to the signed-in user needs who that is (Orca `merge-request-list.ts:39-51`).
                let viewer = glab.api(&host, "GET", "user", &[]).await?;
                let id = parse_json(&viewer.body)?
                    .get("id")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        Fault::new(
                            "glab_unauthenticated",
                            "GitLab did not say who is signed in",
                        )
                    })?;
                let param = if mine == "reviewing" {
                    "reviewer_id"
                } else {
                    "author_id"
                };
                query.push_str(&format!("&{param}={id}"));
            }
            let answer = glab.api(&host, "GET", &query, &[]).await?;
            let rows = parse_json(&answer.body)?;
            Reply::json(&json!({
                "project": project,
                "items": rows.as_array().map_or(&[][..], Vec::as_slice).iter().map(merge_request).collect::<Vec<_>>(),
                "total": answer.header("x-total").and_then(|value| value.parse::<u64>().ok()),
                "rate": rate(&answer),
            }))
        }
        Op::MrGet { iid } => {
            let project = glab.project(named).await?;
            let (host, base) = project_path(&project);
            let detail = parse_json(
                &glab
                    .api(&host, "GET", &format!("{base}/merge_requests/{iid}"), &[])
                    .await?
                    .body,
            )?;
            let notes = parse_json(
                &glab
                    .api(&host, "GET", &format!("{base}/merge_requests/{iid}/notes?sort=asc&order_by=created_at&per_page=50"), &[])
                    .await?
                    .body,
            )?;
            let approvals = glab
                .api(
                    &host,
                    "GET",
                    &format!("{base}/merge_requests/{iid}/approvals"),
                    &[],
                )
                .await
                .ok()
                .and_then(|answer| parse_json(&answer.body).ok());
            let mut out = merge_request(&detail);
            out["description"] = json!(text(&detail, "/description"));
            out["pipeline"] = json!({ "status": text(&detail, "/head_pipeline/status"), "url": text(&detail, "/head_pipeline/web_url") });
            out["approvedBy"] = json!(
                approvals
                    .as_ref()
                    .and_then(|approvals| approvals.get("approved_by"))
                    .and_then(Value::as_array)
                    .map(|rows| rows
                        .iter()
                        .map(|row| text(row, "/user/username"))
                        .collect::<Vec<_>>())
                    .unwrap_or_default()
            );
            out["comments"] = json!(
                notes
                    .as_array()
                    .map_or(&[][..], Vec::as_slice)
                    .iter()
                    .filter(|note| note.get("system") != Some(&Value::Bool(true)))
                    .map(|note| json!({
                        "id": note.get("id").cloned().unwrap_or(Value::Null),
                        "author": text(note, "/author/username"),
                        "body": text(note, "/body"),
                        "createdAt": text(note, "/created_at"),
                    }))
                    .collect::<Vec<_>>()
            );
            Reply::json(&out)
        }
        Op::MrAction { iid, action } => {
            let project = glab.project(named).await?;
            let (host, base) = project_path(&project);
            let at = format!("{base}/merge_requests/{iid}");
            match action.as_str() {
                "close" | "reopen" => {
                    glab.api(&host, "PUT", &at, &[("state_event", &action)])
                        .await?
                }
                "merge" => glab.api(&host, "PUT", &format!("{at}/merge"), &[]).await?,
                "approve" => {
                    glab.api(&host, "POST", &format!("{at}/approve"), &[])
                        .await?
                }
                _ => {
                    return Err(Fault::new(
                        "invalid_params",
                        "action is close, reopen, merge or approve",
                    ));
                }
            };
            Reply::json(&json!({ "ok": true }))
        }
        Op::MrComment { iid, body } => {
            let project = glab.project(named).await?;
            let (host, base) = project_path(&project);
            glab.api(
                &host,
                "POST",
                &format!("{base}/merge_requests/{iid}/notes"),
                &[("body", &body)],
            )
            .await?;
            Reply::json(&json!({ "ok": true }))
        }
        Op::RateLimit => {
            let project = glab.project(named).await?;
            let (host, _) = project_path(&project);
            let answer = glab.api(&host, "GET", "user", &[]).await?;
            Reply::json(&json!({ "rate": rate(&answer) }))
        }
    }
}

pub fn register(registry: &mut Registry) {
    registry.add("glab.request", |call| {
        Box::pin(async move {
            let Params { glab, cwd, request } = call.params()?;
            let runner = glab.ok_or_else(|| Fault::new("glab_missing", MISSING))?;
            let glab = Glab::new(runner, call.scope, cwd);
            command(&glab, &request).await.map_err(|fault| Fault {
                message: glab.scrub(fault.message),
                code: fault.code,
            })
        })
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_is_read_from_its_web_address() {
        assert_eq!(
            project_of_url("https://GitLab.example.com:8443/group/sub/app.git").as_deref(),
            Some("gitlab.example.com:8443/group/sub/app")
        );
        assert_eq!(project_of_url("https://gitlab.com/solo"), None);
        assert_eq!(project_of_url("ssh://gitlab.com/a/b"), None);
        assert_eq!(
            project_path("gitlab.com/group/sub/app"),
            ("gitlab.com".into(), "projects/group%2Fsub%2Fapp".into())
        );
    }

    #[test]
    fn auth_status_names_its_hosts() {
        let output = "gitlab.com\n  ✓ Logged in to gitlab.com as jin (/home/jin/.config/glab-cli/config.yml)\n\
                      git.example.org:8443\n  x git.example.org:8443: API call failed\n  Some words here\n";
        assert_eq!(status_hosts(output), ["git.example.org:8443", "gitlab.com"]);
    }

    #[test]
    fn api_answers_split_at_the_first_empty_line() {
        let answer = parse_api(
            "HTTP/2.0 200 OK\r\nRateLimit-Remaining: 1999\r\nX-Total: 42\r\n\r\n[{\"iid\": 1}]",
        );
        assert_eq!(answer.header("x-total"), Some("42"));
        assert_eq!(answer.body, "[{\"iid\": 1}]");
        assert_eq!(rate(&answer).and_then(|rate| rate.remaining), Some(1999));
        assert_eq!(parse_api("[]").body, "[]");
    }

    #[test]
    fn failures_are_named_by_their_words() {
        assert_eq!(classify("glab: 401 Unauthorized"), "glab_unauthenticated");
        assert_eq!(classify("HTTP 404 Project Not Found"), "gitlab_not_found");
        assert_eq!(classify("429 Too Many Requests"), "gitlab_rate_limited");
        assert_eq!(classify("boom"), "gitlab_failed");
    }

    #[test]
    fn an_error_object_is_a_failure_and_data_is_not() {
        assert!(parse_json("{\"message\": \"404 Not found\"}").is_err());
        assert!(parse_json("{\"iid\": 3, \"message\": \"x\"}").is_ok());
        assert!(parse_json("[]").is_ok());
    }
}
