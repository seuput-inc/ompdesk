//! Jira over its REST API: Cloud with an email and API token (Basic, REST v3), Cloud with a scoped token through the
//! `api.atlassian.com/ex/jira/<cloudId>` gateway, Server/Data Center with a personal access token (Bearer) or a user and
//! password (Basic, REST v2). Main builds the `authorization` header and names the REST base; this side verifies a
//! connection, searches, reads one issue, its transitions, and moves or comments on it (Orca `jira/client.ts`,
//! `credential-verification.ts:57-93`, `jira-issue-search.ts`, `jira-transition-queries.ts`,
//! `jira-issue-mutations.ts:120-153`).
//!
//! A search over several sites answers what the sites that answered found; it fails only when every site failed, with
//! a failure other than a refused credential when there is one (`jira-issue-search.ts:157-209`).

use futures_util::future::join_all;
use serde::Serialize;
use serde_json::{Value, json};

use super::{
    Account, Category, Child, Comment, Container, Ctx, Detail, Exchange, Item, List, ListError,
    Person, Priority, Service, State, StateOption, adf, newest, send, time_ms,
};
use crate::server::Fault;

const FIELDS: [&str; 8] = [
    "summary",
    "status",
    "priority",
    "assignee",
    "labels",
    "project",
    "updated",
    "issuetype",
];
/// One site's search may take this long (`ISSUE_SEARCH_TIMEOUT_MS`).
const SEARCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// Projects per `project in (…)` of Cloud's "all" list (`PROJECTS_PER_QUERY`).
const PROJECTS_PER_QUERY: usize = 100;
const PAGES_MAX: usize = 100;

fn api_path(server: bool) -> &'static str {
    if server { "/rest/api/2" } else { "/rest/api/3" }
}

/// Jira's own words for a refusal: `errorMessages`, `errors`' values and `message` (`jira-api-error.ts:13-38`).
fn jira_words(body: &Value) -> Option<String> {
    let mut words: Vec<String> = Vec::new();
    if let Some(messages) = body.get("errorMessages").and_then(Value::as_array) {
        words.extend(messages.iter().filter_map(Value::as_str).map(str::to_owned));
    }
    if let Some(errors) = body.get("errors").and_then(Value::as_object) {
        words.extend(errors.values().filter_map(Value::as_str).map(str::to_owned));
    }
    if let Some(message) = body.get("message").and_then(Value::as_str) {
        words.push(message.to_owned());
    }
    (!words.is_empty()).then(|| words.join("; "))
}

/// A refusal's status and words.
struct Refused {
    status: u16,
    fault: Fault,
}

async fn call(
    ctx: &Ctx,
    key: &str,
    base: &str,
    path: &str,
    authorization: Option<&str>,
    body: Option<&Value>,
    read: bool,
) -> Result<Value, Refused> {
    let url = format!("{}{path}", base.trim_end_matches('/'));
    let bytes = body.map(|body| serde_json::to_vec(body).unwrap_or_default());
    let answer = send(
        ctx,
        Exchange {
            service: Service::Jira,
            key,
            url: &url,
            authorization,
            body: bytes.as_deref(),
            read,
        },
    )
    .await
    .map_err(|fault| Refused { status: 0, fault })?;
    let reply = answer.json();
    if (200..300).contains(&answer.status) {
        return Ok(reply);
    }
    let words = jira_words(&reply);
    let target = url::Url::parse(&url).ok();
    let where_ = target
        .as_ref()
        .map(|url| format!("{}{}", url.host_str().unwrap_or_default(), url.path()))
        .unwrap_or_default();
    let gateway = base.starts_with("https://api.atlassian.com/");
    let scope = gateway
        && matches!(answer.status, 401 | 403)
        && [
            "scope does not match",
            "insufficient_scope",
            "scope mismatch",
        ]
        .iter()
        .any(|phrase| {
            format!(
                "{} {}",
                words.clone().unwrap_or_default(),
                answer.www_authenticate
            )
            .to_ascii_lowercase()
            .contains(phrase)
        });
    let fault = if scope {
        let needed = if path.contains("/myself") || path.contains("/user") {
            "read:jira-user"
        } else {
            "read:jira-work for reads or write:jira-work for edits"
        };
        Fault::new(
            "tracker_forbidden",
            format!(
                "Jira refused this API token's scopes at {where_} (HTTP {}). Add {needed}.",
                answer.status
            ),
        )
    } else if answer.status == 401 {
        Fault::new(
            "tracker_auth",
            format!(
                "Jira refused the credential at {where_} (HTTP 401). Check the email, the token's expiry and access to this site."
            ),
        )
    } else {
        // A 403 is a missing permission, never a refused credential (`client.ts:245-248`).
        let code = if answer.status == 403 {
            "tracker_forbidden"
        } else {
            "tracker_failed"
        };
        Fault::new(
            code,
            words.unwrap_or_else(|| format!("Jira answered HTTP {} at {where_}", answer.status)),
        )
    };
    Err(Refused {
        status: answer.status,
        fault,
    })
}

async fn rest(
    ctx: &Ctx,
    account: &Account,
    path: &str,
    body: Option<&Value>,
    read: bool,
) -> Result<Value, Refused> {
    let path = format!("{}{path}", api_path(account.server));
    call(
        ctx,
        &account.id,
        &account.base,
        &path,
        Some(&account.authorization),
        body,
        read,
    )
    .await
}

#[derive(Serialize)]
struct Viewer {
    id: String,
    name: String,
    email: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Verified {
    viewer: Viewer,
    /// The Cloud gateway REST goes through, when the site refused the token itself.
    api_base_url: Option<String>,
}

fn viewer(data: &Value) -> Option<Viewer> {
    let field = |name: &str| data.get(name).and_then(Value::as_str).unwrap_or_default();
    // Server/DC's `/myself` has no accountId; its login and key are its stable ids (`site-identity.ts:36-58`).
    let id = [field("accountId"), field("name"), field("key")]
        .into_iter()
        .find(|id| !id.is_empty())?
        .to_owned();
    Some(Viewer {
        id,
        name: field("displayName").to_owned(),
        email: field("emailAddress").to_owned(),
    })
}

async fn myself(
    ctx: &Ctx,
    base: &str,
    authorization: &str,
    server: bool,
) -> Result<Viewer, Refused> {
    let path = format!("{}/myself", api_path(server));
    let data = call(
        ctx,
        &format!("verify:{base}"),
        base,
        &path,
        Some(authorization),
        None,
        true,
    )
    .await?;
    viewer(&data).ok_or_else(|| Refused {
        status: 200,
        fault: Fault::new(
            "tracker_failed",
            "Jira did not answer with an account; check that the site address includes Jira's base path",
        ),
    })
}

/// `https://api.atlassian.com/ex/jira/<cloudId>` from the site's `/_edge/tenant_info` (`cloud-gateway.ts`).
async fn gateway(ctx: &Ctx, site_url: &str) -> Result<String, Fault> {
    let info = call(
        ctx,
        &format!("verify:{site_url}"),
        site_url,
        "/_edge/tenant_info",
        None,
        None,
        true,
    )
    .await
    .map_err(|refused| refused.fault)?;
    let cloud_id = info
        .get("cloudId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if cloud_id.is_empty()
        || !cloud_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(Fault::new(
            "tracker_failed",
            "The site did not report a valid Atlassian cloud ID",
        ));
    }
    Ok(format!("https://api.atlassian.com/ex/jira/{cloud_id}"))
}

/// Who the credential signs in as: at the site, and for a Cloud token the site refused (a scoped token), through the
/// gateway (`credential-verification.ts:57-93`).
pub(super) async fn verify(
    ctx: &Ctx,
    site_url: &str,
    authorization: &str,
    server: bool,
    email: bool,
) -> Result<Verified, Fault> {
    let mut site_failure = None;
    if email || server {
        match myself(ctx, site_url, authorization, server).await {
            Ok(viewer) => {
                return Ok(Verified {
                    viewer,
                    api_base_url: None,
                });
            }
            Err(refused) if !server && refused.status == 401 => site_failure = Some(refused.fault),
            Err(refused) => return Err(refused.fault),
        }
    }
    let base = gateway(ctx, site_url)
        .await
        .map_err(|fault| match &site_failure {
            Some(first) => Fault::new(
                fault.code.clone(),
                format!("{} {}", first.message, fault.message),
            ),
            None => fault,
        })?;
    let viewer = myself(ctx, &base, authorization, false)
        .await
        .map_err(|refused| match &site_failure {
            Some(first) => Fault::new(
                refused.fault.code.clone(),
                format!("{} Gateway check: {}", first.message, refused.fault.message),
            ),
            None => refused.fault,
        })?;
    Ok(Verified {
        viewer,
        api_base_url: Some(base),
    })
}

fn escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"")
}

fn is_key(text: &str) -> bool {
    let Some((project, number)) = text.split_once('-') else {
        return false;
    };
    project
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && project
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit())
}

/// A preset's JQL (Orca `shared/jira/jira-preset-jql.ts:3-29`); `resolution` for an old Server without
/// `statusCategory`. A search adds `text ~ "…"`; an issue key finds that issue whatever its state.
fn jql(preset: &str, search: Option<&str>, resolution: bool) -> String {
    if let Some(key) = search.filter(|text| is_key(text)) {
        return format!("key = \"{}\"", escape(&key.to_ascii_uppercase()));
    }
    let mut clauses: Vec<String> = Vec::new();
    match preset {
        "assigned" | "done" => clauses.push("assignee = currentUser()".into()),
        "created" => clauses.push("reporter = currentUser()".into()),
        _ => {}
    }
    let done = preset == "done";
    clauses.push(
        match (resolution, done) {
            (true, true) => "resolution IS NOT EMPTY",
            (true, false) => "resolution = Unresolved",
            (false, true) => "statusCategory = Done",
            (false, false) => "statusCategory != Done",
        }
        .into(),
    );
    if let Some(text) = search {
        clauses.push(format!("text ~ \"{}\"", escape(text)));
    }
    format!("{} ORDER BY updated DESC", clauses.join(" AND "))
}

fn text(value: &Value, path: &str) -> String {
    value
        .pointer(path)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn category(key: &str) -> Category {
    match key {
        "indeterminate" => Category::Started,
        "done" => Category::Completed,
        _ => Category::Unstarted,
    }
}

fn person(value: &Value) -> Option<Person> {
    let id = [
        text(value, "/accountId"),
        text(value, "/name"),
        text(value, "/key"),
    ]
    .into_iter()
    .find(|id| !id.is_empty())?;
    Some(Person {
        id,
        name: text(value, "/displayName"),
    })
}

fn browse(account: &Account, key: &str) -> String {
    format!("{}/browse/{key}", account.site_url.trim_end_matches('/'))
}

fn item(account: &Account, issue: &Value) -> Item {
    let key = text(issue, "/key");
    let updated_at = text(issue, "/fields/updated");
    let present = |path: &str| issue.pointer(path).filter(|value| !value.is_null());
    Item {
        provider: "jira",
        account_id: account.id.clone(),
        account_label: account.label.clone(),
        id: key.clone(),
        url: browse(account, &key),
        key,
        title: text(issue, "/fields/summary"),
        updated_ms: time_ms(&updated_at),
        updated_at,
        state: State {
            name: text(issue, "/fields/status/name"),
            category: category(&text(issue, "/fields/status/statusCategory/key")),
            color: None,
        },
        priority: present("/fields/priority").map(|priority| Priority {
            value: None,
            name: Some(text(priority, "/name")),
        }),
        assignee: present("/fields/assignee").and_then(person),
        labels: issue
            .pointer("/fields/labels")
            .and_then(Value::as_array)
            .map(|labels| {
                labels
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        container: present("/fields/project").map(|project| Container {
            id: text(project, "/id"),
            name: text(project, "/name"),
            key: Some(text(project, "/key")).filter(|key| !key.is_empty()),
        }),
        branch_name: None,
    }
}

/// One search, Server's classic `/search` or Cloud's `/search/jql` with its page tokens (`jira-issue-search.ts:73-128`).
async fn search(
    ctx: &Ctx,
    account: &Account,
    jql: &str,
    limit: usize,
    every_page: bool,
) -> Result<Vec<Item>, Refused> {
    let path = if account.server {
        "/search"
    } else {
        "/search/jql"
    };
    let mut items = Vec::new();
    let mut token: Option<String> = None;
    let mut seen = std::collections::HashSet::new();
    for _ in 0..PAGES_MAX {
        let mut body = json!({ "jql": jql, "maxResults": limit - items.len(), "fields": FIELDS });
        if let Some(token) = &token {
            body["nextPageToken"] = json!(token);
        }
        let page = rest(ctx, account, path, Some(&body), true).await?;
        items.extend(
            page.get("issues")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .map(|issue| item(account, issue)),
        );
        let next = page.get("nextPageToken").and_then(Value::as_str);
        if !every_page || items.len() >= limit || page.get("isLast") == Some(&Value::Bool(true)) {
            break;
        }
        match next {
            Some(next) if seen.insert(next.to_owned()) => token = Some(next.to_owned()),
            _ => break,
        }
    }
    items.truncate(limit);
    Ok(items)
}

/// Every project's id on a Cloud site (`jira-project-queries.ts:9-34`).
async fn projects(ctx: &Ctx, account: &Account) -> Result<Vec<String>, Refused> {
    let mut ids = Vec::new();
    for page in 0..PAGES_MAX {
        let answer = rest(
            ctx,
            account,
            &format!("/project/search?maxResults=100&startAt={}", page * 100),
            None,
            true,
        )
        .await?;
        let values = answer
            .get("values")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        ids.extend(values.iter().map(|project| {
            let id = text(project, "/id");
            if id.is_empty() {
                text(project, "/key")
            } else {
                id
            }
        }));
        if values.is_empty() || answer.get("isLast") != Some(&Value::Bool(false)) {
            break;
        }
    }
    ids.retain(|id| !id.is_empty());
    ids.dedup();
    Ok(ids)
}

async fn site_list(
    ctx: &Ctx,
    account: &Account,
    preset: &str,
    query: Option<&str>,
    limit: usize,
) -> Result<Vec<Item>, Fault> {
    if account.server {
        // An old Server has no `statusCategory` in JQL: the preset's resolution rule then (`searchJiraPreset`).
        return match search(ctx, account, &jql(preset, query, false), limit, false).await {
            Err(refused) if refused.fault.message.contains("statusCategory") => {
                search(ctx, account, &jql(preset, query, true), limit, false).await
            }
            other => other,
        }
        .map_err(|refused| refused.fault);
    }
    let jql = jql(preset, query, false);
    if preset != "all" || query.is_some() {
        return search(ctx, account, &jql, limit, false)
            .await
            .map_err(|refused| refused.fault);
    }
    // Cloud refuses an unbounded search: "all" goes a hundred projects at a time (`jira-issue-search.ts:46-71`).
    let ids = projects(ctx, account)
        .await
        .map_err(|refused| refused.fault)?;
    let mut items = Vec::new();
    for chunk in ids.chunks(PROJECTS_PER_QUERY) {
        let quoted: Vec<String> = chunk
            .iter()
            .map(|id| format!("\"{}\"", escape(id)))
            .collect();
        let bounded = format!("project in ({}) AND {jql}", quoted.join(", "));
        items.extend(
            search(ctx, account, &bounded, limit, true)
                .await
                .map_err(|refused| refused.fault)?,
        );
    }
    Ok(newest(items, limit).0)
}

pub(super) async fn list(
    ctx: &Ctx,
    accounts: &[Account],
    preset: &str,
    query: Option<&str>,
    limit: usize,
) -> Result<List, Fault> {
    let reads = join_all(accounts.iter().map(|account| async move {
        let read = tokio::time::timeout(
            SEARCH_TIMEOUT,
            site_list(ctx, account, preset, query, limit),
        )
        .await
        .unwrap_or_else(|_| {
            Err(Fault::new(
                "tracker_network",
                format!("{} did not answer the search within 30 s", account.label),
            ))
        });
        (account, read)
    }))
    .await;
    let mut items = Vec::new();
    let mut failures: Vec<(&Account, Fault)> = Vec::new();
    let mut has_more = false;
    for (account, read) in reads {
        match read {
            Ok(found) => {
                has_more |= found.len() >= limit;
                items.extend(found);
            }
            Err(fault) => failures.push((account, fault)),
        }
    }
    if !accounts.is_empty() && failures.len() == accounts.len() {
        let pick = failures
            .iter()
            .position(|(_, fault)| fault.code != "tracker_auth")
            .unwrap_or(0);
        return Err(failures.swap_remove(pick).1);
    }
    let (items, clipped) = newest(items, limit);
    Ok(List {
        items,
        has_more: has_more || clipped,
        errors: failures
            .iter()
            .map(|(account, fault)| ListError::of(account, fault))
            .collect(),
    })
}

pub(super) async fn detail(ctx: &Ctx, account: &Account, key: &str) -> Result<Detail, Fault> {
    let fields = format!("{},description,comment,subtasks", FIELDS.join(","));
    let issue = rest(
        ctx,
        account,
        &format!("/issue/{key}?fields={fields}"),
        None,
        true,
    )
    .await
    .map_err(|refused| refused.fault)?;
    let mut comments: Vec<Comment> = issue
        .pointer("/fields/comment/comments")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|comment| Comment {
            id: text(comment, "/id"),
            author: text(comment, "/author/displayName"),
            body: adf::to_markdown(comment.get("body").unwrap_or(&Value::Null)),
            created_at: text(comment, "/created"),
        })
        .collect();
    comments.sort_by(|a, b| time_ms(&a.created_at).total_cmp(&time_ms(&b.created_at)));
    Ok(Detail {
        description: adf::to_markdown(issue.pointer("/fields/description").unwrap_or(&Value::Null)),
        children: issue
            .pointer("/fields/subtasks")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|task| {
                let key = text(task, "/key");
                Child {
                    url: browse(account, &key),
                    title: text(task, "/fields/summary"),
                    key,
                }
            })
            .collect(),
        item: item(account, &issue),
        comments,
    })
}

/// The transitions the issue can take now (`jira-transition-queries.ts:16-67`): with their fields, else without when
/// the site refuses the expansion.
pub(super) async fn states(
    ctx: &Ctx,
    account: &Account,
    key: &str,
) -> Result<Vec<StateOption>, Fault> {
    let path = format!("/issue/{key}/transitions");
    let answer = match rest(
        ctx,
        account,
        &format!("{path}?expand=transitions.fields"),
        None,
        true,
    )
    .await
    {
        Err(refused) if matches!(refused.status, 400 | 403 | 404) => {
            rest(ctx, account, &path, None, true).await
        }
        other => other,
    }
    .map_err(|refused| refused.fault)?;
    Ok(answer
        .get("transitions")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|transition| StateOption {
            id: text(transition, "/id"),
            name: text(transition, "/name"),
            category: category(&text(transition, "/to/statusCategory/key")),
            color: None,
        })
        .collect())
}

/// Takes a transition. A transition whose screen requires fields fails with Jira's words.
// shortcut: no form for a transition's required fields (Orca `jira-issue-mutations.ts:126-141` sends them); add one
// when a site's workflow needs it here.
pub(super) async fn set_state(
    ctx: &Ctx,
    account: &Account,
    key: &str,
    transition: &str,
) -> Result<(), Fault> {
    rest(
        ctx,
        account,
        &format!("/issue/{key}/transitions"),
        Some(&json!({ "transition": { "id": transition } })),
        false,
    )
    .await
    .map(drop)
    .map_err(|refused| refused.fault)
}

pub(super) async fn comment(
    ctx: &Ctx,
    account: &Account,
    key: &str,
    body: &str,
) -> Result<(), Fault> {
    let body = if account.server {
        json!({ "body": body })
    } else {
        json!({ "body": adf::from_markdown(body) })
    };
    rest(
        ctx,
        account,
        &format!("/issue/{key}/comment"),
        Some(&body),
        false,
    )
    .await
    .map(drop)
    .map_err(|refused| refused.fault)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_preset_reads_as_orca_writes_it() {
        assert_eq!(
            jql("assigned", None, false),
            "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"
        );
        assert_eq!(
            jql("created", None, true),
            "reporter = currentUser() AND resolution = Unresolved ORDER BY updated DESC"
        );
        assert_eq!(
            jql("done", Some("say \"hi\""), false),
            "assignee = currentUser() AND statusCategory = Done AND text ~ \"say \\\"hi\\\"\" ORDER BY updated DESC"
        );
        assert_eq!(jql("all", Some("proj-12"), false), "key = \"PROJ-12\"");
    }

    #[test]
    fn an_issue_maps_with_its_browse_link_and_category() {
        let account = Account {
            id: "s".into(),
            label: "acme.atlassian.net".into(),
            base: "https://acme.atlassian.net".into(),
            site_url: "https://acme.atlassian.net/".into(),
            server: false,
            authorization: String::new(),
        };
        let issue = json!({"key": "PROJ-3", "fields": {
            "summary": "Crash", "updated": "2026-11-26T10:00:00.000+0900",
            "status": {"name": "In Review", "statusCategory": {"key": "indeterminate"}},
            "priority": {"name": "High"}, "assignee": {"accountId": "u1", "displayName": "Jin"},
            "labels": ["ui"], "project": {"id": "100", "key": "PROJ", "name": "Project"}
        }});
        let item = item(&account, &issue);
        assert_eq!(item.url, "https://acme.atlassian.net/browse/PROJ-3");
        assert_eq!(item.state.category, Category::Started);
        assert_eq!(item.assignee.map(|person| person.id).as_deref(), Some("u1"));
        assert_eq!(item.updated_ms, time_ms("2026-11-26T01:00:00.000Z"));
    }

    #[test]
    fn a_server_viewer_is_named_by_its_login() {
        let viewer = viewer(&json!({"name": "jin", "displayName": "Jin"})).map(|viewer| viewer.id);
        assert_eq!(viewer.as_deref(), Some("jin"));
        assert!(super::viewer(&json!({"displayName": "nobody"})).is_none());
    }
}
