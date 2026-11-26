//! Linear over its GraphQL API with a personal API key (`Authorization: <key>`, no scheme), one key per workspace.
//! Orca's "Connect Linear" sign-in is Orca Cloud's (`linear-login-store.ts:10-23`) and is not ported.
//!
//! A list over several workspaces merges by `updatedAt` and pages only the workspaces whose next page could still
//! change the merged list (Orca `linear-issue-listing.ts:138-201`); paging stops after `READ_BUDGET` and then keeps
//! only the span every unfinished workspace has covered. An account whose read failed is named in `errors` while the
//! others answer; when the person picked that one account its failure is the request's.

use std::time::Instant;

use futures_util::future::join_all;
use serde::Serialize;
use serde_json::{Value, json};

use super::{
    Account, Category, Child, Comment, Container, Ctx, Detail, Exchange, Item, List, ListError,
    Person, Priority, READ_BUDGET, Service, State, StateOption, newest, pause, rate_limited, send,
    time_ms,
};
use crate::server::Fault;

const ENDPOINT: &str = "https://api.linear.app/graphql";
/// Linear's page size ceiling (`LINEAR_ISSUE_API_PAGE_SIZE_MAX`).
const PAGE_MAX: usize = 50;

const FIELDS: &str = "id identifier title url branchName priority updatedAt \
    state { name type color } team { id name key } assignee { id displayName } \
    labels(first: 20) { nodes { name } }";

const ACTIVE: &str = r#"{"state":{"type":{"nin":["completed","canceled"]}}}"#;
const COMPLETED: &str = r#"{"state":{"type":{"in":["completed","canceled"]}}}"#;

/// Where a preset's issues are listed: the viewer's assigned or created issues, or the workspace's (Orca
/// `linear-issue-query-support.ts:101-164`), and the state filter (`issue-list-filter.ts:20-35`).
fn preset_source(preset: &str) -> (&'static str, Option<&'static str>) {
    match preset {
        "assigned" => ("viewer.assignedIssues", Some(ACTIVE)),
        "created" => ("viewer.createdIssues", Some(ACTIVE)),
        "done" => ("viewer.assignedIssues", Some(COMPLETED)),
        "open" => ("issues", Some(ACTIVE)),
        _ => ("issues", None),
    }
}

fn list_query(source: &str) -> String {
    let connection = format!(
        "(first: $first, after: $after, filter: $filter, orderBy: updatedAt) \
         {{ nodes {{ {FIELDS} }} pageInfo {{ hasNextPage endCursor }} }}"
    );
    let head = "query OmpdeskLinearIssues($first: Int, $after: String, $filter: IssueFilter)";
    match source.split_once('.') {
        Some((outer, inner)) => format!("{head} {{ {outer} {{ {inner}{connection} }} }}"),
        None => format!("{head} {{ {source}{connection} }}"),
    }
}

/// An answer's `data`, and its `errors` when it has data too (a detail read keeps what it got).
async fn gql(
    ctx: &Ctx,
    account_id: &str,
    authorization: &str,
    query: &str,
    variables: Value,
) -> Result<(Value, Vec<Value>), Fault> {
    let body = serde_json::to_vec(&json!({ "query": query, "variables": variables }))
        .map_err(|error| Fault::new("internal", error.to_string()))?;
    let answer = send(
        ctx,
        Exchange {
            service: Service::Linear,
            key: account_id,
            url: ENDPOINT,
            authorization: Some(authorization),
            body: Some(&body),
            read: query.trim_start().starts_with("query"),
        },
    )
    .await?;
    let reply = answer.json();
    let errors = reply
        .get("errors")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let code = |error: &Value| {
        let extensions = error.get("extensions");
        let text = |name: &str| {
            extensions
                .and_then(|extensions| extensions.get(name))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase()
        };
        format!("{} {}", text("code"), text("type"))
    };
    if answer.status == 401
        || errors
            .iter()
            .any(|error| code(error).contains("authentication"))
    {
        return Err(Fault::new(
            "tracker_auth",
            "Linear refused the API key; connect the workspace again",
        ));
    }
    if errors
        .iter()
        .any(|error| code(error).contains("ratelimited"))
    {
        return Err(rate_limited(pause(account_id, 60_000)));
    }
    let data = reply.get("data").cloned().unwrap_or(Value::Null);
    if data.is_null() || !(200..300).contains(&answer.status) {
        let message = errors
            .iter()
            .find_map(|error| error.get("message").and_then(Value::as_str))
            .map_or_else(
                || format!("Linear answered HTTP {}", answer.status),
                str::to_owned,
            );
        return Err(Fault::new("tracker_failed", message));
    }
    Ok((data, errors))
}

fn text(value: &Value, path: &str) -> String {
    value
        .pointer(path)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn category(kind: &str) -> Category {
    match kind {
        "triage" | "backlog" => Category::Backlog,
        "started" => Category::Started,
        "completed" => Category::Completed,
        "canceled" => Category::Canceled,
        _ => Category::Unstarted,
    }
}

fn item(account: &Account, node: &Value) -> Item {
    let updated_at = text(node, "/updatedAt");
    let present = |path: &str| node.pointer(path).filter(|value| !value.is_null());
    Item {
        provider: "linear",
        account_id: account.id.clone(),
        account_label: account.label.clone(),
        id: text(node, "/id"),
        key: text(node, "/identifier"),
        title: text(node, "/title"),
        url: text(node, "/url"),
        updated_ms: time_ms(&updated_at),
        updated_at,
        state: State {
            name: text(node, "/state/name"),
            category: category(&text(node, "/state/type")),
            color: present("/state/color")
                .and_then(Value::as_str)
                .map(str::to_owned),
        },
        priority: node
            .get("priority")
            .and_then(Value::as_u64)
            .map(|value| Priority {
                value: Some(value),
                name: None,
            }),
        assignee: present("/assignee").map(|person| Person {
            id: text(person, "/id"),
            name: text(person, "/displayName"),
        }),
        labels: node
            .pointer("/labels/nodes")
            .and_then(Value::as_array)
            .map(|labels| {
                labels
                    .iter()
                    .filter_map(|label| label.get("name").and_then(Value::as_str))
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        container: present("/team").map(|team| Container {
            id: text(team, "/id"),
            name: text(team, "/name"),
            key: Some(text(team, "/key")).filter(|key| !key.is_empty()),
        }),
        branch_name: Some(text(node, "/branchName")).filter(|name| !name.trim().is_empty()),
    }
}

#[derive(Serialize)]
pub(super) struct Verified {
    viewer: Viewer,
    org: Org,
}

#[derive(Serialize)]
struct Viewer {
    id: String,
    name: String,
    email: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Org {
    id: String,
    name: String,
    url_key: String,
}

/// Who the key signs in as and its workspace (Orca `linear-account-client.ts:105-135`).
pub(super) async fn verify(ctx: &Ctx, authorization: &str) -> Result<Verified, Fault> {
    let (data, _) = gql(
        ctx,
        "verify:linear",
        authorization,
        "query OmpdeskLinearViewer { viewer { id name displayName email organization { id name urlKey } } }",
        json!({}),
    )
    .await?;
    let name = Some(text(&data, "/viewer/displayName"))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| text(&data, "/viewer/name"));
    Ok(Verified {
        viewer: Viewer {
            id: text(&data, "/viewer/id"),
            name,
            email: text(&data, "/viewer/email"),
        },
        org: Org {
            id: text(&data, "/viewer/organization/id"),
            name: text(&data, "/viewer/organization/name"),
            url_key: text(&data, "/viewer/organization/urlKey"),
        },
    })
}

/// One workspace's walk through its list.
struct Walk<'a> {
    account: &'a Account,
    items: Vec<Item>,
    has_more: bool,
    can_page: bool,
    after: Option<String>,
    error: Option<Fault>,
}

impl Walk<'_> {
    /// The oldest change it has read (its items come newest first); none read yet is infinitely new.
    fn oldest(&self) -> f64 {
        self.items
            .last()
            .map_or(f64::INFINITY, |item| item.updated_ms)
    }
}

async fn read_page(ctx: &Ctx, walk: &mut Walk<'_>, preset: &str, first: usize) {
    let (source, filter) = preset_source(preset);
    let filter: Value = filter.map_or(Value::Null, |filter| {
        serde_json::from_str(filter).unwrap_or(Value::Null)
    });
    let previous = walk.after.clone();
    let answer = gql(
        ctx,
        &walk.account.id,
        &walk.account.authorization,
        &list_query(source),
        json!({ "first": first, "after": previous, "filter": filter }),
    )
    .await;
    match answer {
        Ok((data, _)) => {
            let path = format!("/{}", source.replace('.', "/"));
            let connection = data.pointer(&path).cloned().unwrap_or(Value::Null);
            let page: Vec<Item> = connection
                .get("nodes")
                .and_then(Value::as_array)
                .map(|nodes| nodes.iter().map(|node| item(walk.account, node)).collect())
                .unwrap_or_default();
            let next = connection.pointer("/pageInfo/hasNextPage") == Some(&Value::Bool(true));
            let cursor = connection
                .pointer("/pageInfo/endCursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            walk.can_page = next && cursor.is_some() && cursor != previous && !page.is_empty();
            walk.has_more = next;
            walk.after = cursor;
            walk.items.extend(page);
        }
        Err(fault) => {
            walk.items.clear();
            walk.has_more = false;
            walk.can_page = false;
            walk.error = Some(fault);
        }
    }
}

/// The workspace whose next page could still change the merged list's first `limit`: the one whose oldest read
/// change is newest among those that can page and are not past the cutoff (Orca `findWorkspaceToPageForLimit`).
fn next_walk(walks: &[Walk<'_>], limit: usize) -> Option<usize> {
    let mut times: Vec<f64> = walks
        .iter()
        .flat_map(|walk| walk.items.iter().map(|item| item.updated_ms))
        .collect();
    times.sort_by(|a, b| b.total_cmp(a));
    let cutoff = times
        .get(limit.wrapping_sub(1))
        .copied()
        .filter(|_| times.len() >= limit);
    walks
        .iter()
        .enumerate()
        .filter(|(_, walk)| walk.can_page && cutoff.is_none_or(|cutoff| walk.oldest() > cutoff))
        .max_by(|(_, a), (_, b)| a.oldest().total_cmp(&b.oldest()))
        .map(|(index, _)| index)
}

pub(super) async fn list(
    ctx: &Ctx,
    accounts: &[Account],
    preset: &str,
    search: Option<&str>,
    limit: usize,
) -> Result<List, Fault> {
    if let Some(term) = search {
        return search_list(ctx, accounts, term, limit).await;
    }
    let started = Instant::now();
    let mut walks: Vec<Walk<'_>> = accounts
        .iter()
        .map(|account| Walk {
            account,
            items: Vec::new(),
            has_more: false,
            can_page: false,
            after: None,
            error: None,
        })
        .collect();
    let first = limit.min(PAGE_MAX);
    join_all(
        walks
            .iter_mut()
            .map(|walk| read_page(ctx, walk, preset, first)),
    )
    .await;
    while started.elapsed() < READ_BUDGET {
        let Some(index) = next_walk(&walks, limit) else {
            break;
        };
        let count: usize = walks.iter().map(|walk| walk.items.len()).sum();
        let size = if count < limit {
            (limit - count).min(PAGE_MAX)
        } else {
            let boundary = walks[index].oldest();
            let mut times: Vec<f64> = walks
                .iter()
                .flat_map(|walk| walk.items.iter().map(|item| item.updated_ms))
                .collect();
            times.sort_by(|a, b| b.total_cmp(a));
            times.truncate(limit);
            times
                .iter()
                .filter(|time| **time < boundary)
                .count()
                .clamp(1, PAGE_MAX)
        };
        read_page(ctx, &mut walks[index], preset, size).await;
    }
    finish(walks, accounts.len() == 1, limit)
}

fn finish(walks: Vec<Walk<'_>>, single: bool, limit: usize) -> Result<List, Fault> {
    if single && let Some(fault) = walks.first().and_then(|walk| walk.error.clone()) {
        return Err(fault);
    }
    // A walk the budget stopped keeps only what every unfinished workspace has covered.
    let covered_since = walks
        .iter()
        .filter(|walk| walk.has_more)
        .map(Walk::oldest)
        .fold(f64::NEG_INFINITY, f64::max);
    let has_more = walks.iter().any(|walk| walk.has_more);
    let errors = walks
        .iter()
        .filter_map(|walk| {
            walk.error
                .as_ref()
                .map(|fault| ListError::of(walk.account, fault))
        })
        .collect();
    let all: Vec<Item> = walks
        .into_iter()
        .flat_map(|walk| walk.items)
        .filter(|item| item.updated_ms >= covered_since)
        .collect();
    let (items, clipped) = newest(all, limit);
    Ok(List {
        items,
        has_more: has_more || clipped,
        errors,
    })
}

async fn search_list(
    ctx: &Ctx,
    accounts: &[Account],
    term: &str,
    limit: usize,
) -> Result<List, Fault> {
    let query = format!(
        "query OmpdeskLinearSearch($term: String!, $first: Int) {{ searchIssues(term: $term, first: $first) {{ nodes {{ {FIELDS} }} }} }}"
    );
    let reads = join_all(accounts.iter().map(|account| {
        let query = query.as_str();
        async move {
            let answer = gql(
                ctx,
                &account.id,
                &account.authorization,
                query,
                json!({ "term": term, "first": limit.min(PAGE_MAX) }),
            )
            .await;
            (account, answer)
        }
    }))
    .await;
    let mut walks = Vec::new();
    for (account, answer) in reads {
        let mut walk = Walk {
            account,
            items: Vec::new(),
            has_more: false,
            can_page: false,
            after: None,
            error: None,
        };
        match answer {
            Ok((data, _)) => {
                walk.items = data
                    .pointer("/searchIssues/nodes")
                    .and_then(Value::as_array)
                    .map(|nodes| nodes.iter().map(|node| item(account, node)).collect())
                    .unwrap_or_default();
            }
            Err(fault) => walk.error = Some(fault),
        }
        walks.push(walk);
    }
    finish(walks, accounts.len() == 1, limit)
}

/// The relations a detail read may lose to an error and still show the issue (Orca `linear-issue-detail.ts:14-21`).
const OPTIONAL: [&str; 8] = [
    "state",
    "team",
    "assignee",
    "project",
    "labels",
    "children",
    "comments",
    "description",
];

pub(super) async fn detail(ctx: &Ctx, account: &Account, id: &str) -> Result<Detail, Fault> {
    let query = format!(
        "query OmpdeskLinearIssue($id: String!) {{ issue(id: $id) {{ {FIELDS} description \
         children(first: 25) {{ nodes {{ identifier title url }} }} \
         comments(first: 50) {{ nodes {{ id body createdAt user {{ displayName }} }} }} }} }}"
    );
    let (data, errors) = gql(
        ctx,
        &account.id,
        &account.authorization,
        &query,
        json!({ "id": id }),
    )
    .await?;
    let partial = errors.iter().all(|error| {
        let path = error.get("path").and_then(Value::as_array);
        path.and_then(|path| path.first()).and_then(Value::as_str) == Some("issue")
            && path
                .and_then(|path| path.get(1))
                .and_then(Value::as_str)
                .is_some_and(|field| OPTIONAL.contains(&field))
    });
    let issue = data.get("issue").filter(|issue| !issue.is_null());
    let Some(issue) = issue.filter(|_| partial) else {
        let message = errors
            .iter()
            .find_map(|error| error.get("message").and_then(Value::as_str))
            .unwrap_or("Linear has no such issue");
        return Err(Fault::new("tracker_failed", message.to_owned()));
    };
    let mut comments: Vec<Comment> = issue
        .pointer("/comments/nodes")
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .map(|node| Comment {
                    id: text(node, "/id"),
                    author: text(node, "/user/displayName"),
                    body: text(node, "/body"),
                    created_at: text(node, "/createdAt"),
                })
                .collect()
        })
        .unwrap_or_default();
    // Linear sends the newest first; oldest first reads as linear.app and where a new one lands (Orca :288-289).
    comments.sort_by(|a, b| time_ms(&a.created_at).total_cmp(&time_ms(&b.created_at)));
    Ok(Detail {
        item: item(account, issue),
        description: text(issue, "/description"),
        comments,
        children: issue
            .pointer("/children/nodes")
            .and_then(Value::as_array)
            .map(|nodes| {
                nodes
                    .iter()
                    .map(|node| Child {
                        key: text(node, "/identifier"),
                        title: text(node, "/title"),
                        url: text(node, "/url"),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn rank(category: Category) -> u8 {
    match category {
        Category::Backlog => 0,
        Category::Unstarted => 1,
        Category::Started => 2,
        Category::Completed => 3,
        Category::Canceled => 4,
    }
}

/// The issue's team's workflow states, in Linear's order (Orca `linear-team-queries.ts`).
pub(super) async fn states(
    ctx: &Ctx,
    account: &Account,
    id: &str,
) -> Result<Vec<StateOption>, Fault> {
    let (data, _) = gql(
        ctx,
        &account.id,
        &account.authorization,
        "query OmpdeskLinearStates($id: String!) { issue(id: $id) { team { states(first: 100) { nodes { id name type color position } } } } }",
        json!({ "id": id }),
    )
    .await?;
    let mut states: Vec<(f64, StateOption)> = data
        .pointer("/issue/team/states/nodes")
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .map(|node| {
                    let position = node.get("position").and_then(Value::as_f64).unwrap_or(0.0);
                    let option = StateOption {
                        id: text(node, "/id"),
                        name: text(node, "/name"),
                        category: category(&text(node, "/type")),
                        color: Some(text(node, "/color")).filter(|color| !color.is_empty()),
                    };
                    (position, option)
                })
                .collect()
        })
        .unwrap_or_default();
    states.sort_by(|(a_position, a), (b_position, b)| {
        rank(a.category)
            .cmp(&rank(b.category))
            .then(a_position.total_cmp(b_position))
    });
    Ok(states.into_iter().map(|(_, option)| option).collect())
}

fn confirm(data: &Value, path: &str) -> Result<(), Fault> {
    if data.pointer(path) == Some(&Value::Bool(true)) {
        Ok(())
    } else {
        Err(Fault::new(
            "tracker_failed",
            "Linear did not take the change",
        ))
    }
}

pub(super) async fn set_state(
    ctx: &Ctx,
    account: &Account,
    id: &str,
    state_id: &str,
) -> Result<(), Fault> {
    let (data, _) = gql(
        ctx,
        &account.id,
        &account.authorization,
        "mutation OmpdeskLinearSetState($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }",
        json!({ "id": id, "stateId": state_id }),
    )
    .await?;
    confirm(&data, "/issueUpdate/success")
}

pub(super) async fn comment(
    ctx: &Ctx,
    account: &Account,
    id: &str,
    body: &str,
) -> Result<(), Fault> {
    let (data, _) = gql(
        ctx,
        &account.id,
        &account.authorization,
        "mutation OmpdeskLinearComment($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }",
        json!({ "id": id, "body": body }),
    )
    .await?;
    confirm(&data, "/commentCreate/success")
}

#[cfg(test)]
mod tests {
    use super::super::tests::test_item;
    use super::*;

    fn account() -> Account {
        Account {
            id: "a".into(),
            label: "Acme".into(),
            base: String::new(),
            site_url: String::new(),
            server: false,
            authorization: String::new(),
        }
    }

    #[test]
    fn a_preset_reads_the_viewer_or_the_workspace() {
        assert_eq!(preset_source("assigned").0, "viewer.assignedIssues");
        assert_eq!(
            preset_source("done"),
            ("viewer.assignedIssues", Some(COMPLETED))
        );
        assert_eq!(preset_source("all"), ("issues", None));
        assert!(
            list_query("viewer.createdIssues").contains("viewer { createdIssues(first: $first")
        );
        assert!(list_query("issues").contains("{ issues(first: $first"));
    }

    #[test]
    fn an_issue_maps_with_its_branch_and_team() {
        let node = json!({
            "id": "u1", "identifier": "LIN-12", "title": "Fix login", "url": "https://linear.app/acme/issue/LIN-12",
            "branchName": "jin/lin-12-fix-login", "priority": 2, "updatedAt": "2026-11-26T01:00:00.000Z",
            "state": {"name": "In Progress", "type": "started", "color": "#f00"},
            "team": {"id": "t", "name": "Core", "key": "LIN"}, "assignee": null,
            "labels": {"nodes": [{"name": "bug"}]}
        });
        let item = item(&account(), &node);
        assert_eq!(item.key, "LIN-12");
        assert_eq!(item.branch_name.as_deref(), Some("jin/lin-12-fix-login"));
        assert_eq!(item.state.category, Category::Started);
        assert!(item.assignee.is_none());
        assert_eq!(item.labels, ["bug"]);
        assert!(item.updated_ms > 0.0);
    }

    fn walk<'a>(account: &'a Account, times: &[f64], can_page: bool) -> Walk<'a> {
        Walk {
            account,
            items: times.iter().map(|time| test_item(*time)).collect(),
            has_more: can_page,
            can_page,
            after: Some("c".into()),
            error: None,
        }
    }

    #[test]
    fn only_a_workspace_that_could_change_the_first_page_reads_on() {
        let account = account();
        // Limit 2: the merged first two are 10 and 9.5 (cutoff 9.5). A has read only 10: what it has not read yet
        // may still fall between 10 and 9.5. B's oldest read is 8, past the cutoff: nothing it has left can enter.
        let walks = [
            walk(&account, &[10.0], true),
            walk(&account, &[9.5, 9.0, 8.0], true),
        ];
        assert_eq!(next_walk(&walks, 2), Some(0));
        let walks = [
            walk(&account, &[10.0], false),
            walk(&account, &[9.5, 9.0, 8.0], true),
        ];
        assert_eq!(next_walk(&walks, 2), None);
        // Fewer than the limit read: the newest of those that can page.
        let walks = [walk(&account, &[5.0], true), walk(&account, &[7.0], true)];
        assert_eq!(next_walk(&walks, 10), Some(1));
    }

    #[test]
    fn a_stopped_walk_keeps_only_what_every_workspace_covered() {
        let account = account();
        let walks = vec![
            walk(&account, &[10.0, 6.0], true),
            walk(&account, &[9.0, 3.0], false),
        ];
        let list = finish(walks, false, 10).unwrap_or_else(|fault| panic!("{}", fault.message));
        assert_eq!(
            list.items
                .iter()
                .map(|item| item.updated_ms)
                .collect::<Vec<_>>(),
            [10.0, 9.0, 6.0]
        );
        assert!(list.has_more);
    }

    #[test]
    fn a_failed_workspace_is_named_while_the_others_answer() {
        let account = account();
        let mut failed = walk(&account, &[], false);
        failed.error = Some(Fault::new("tracker_auth", "refused"));
        let list = finish(vec![walk(&account, &[1.0], false), failed], false, 10)
            .unwrap_or_else(|fault| panic!("{}", fault.message));
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.errors[0].kind, "auth");
        let mut alone = walk(&account, &[], false);
        alone.error = Some(Fault::new("tracker_auth", "refused"));
        assert!(finish(vec![alone], true, 10).is_err());
    }
}
