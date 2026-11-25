//! A pull request's or an issue's work past what `pr.rs` reads, each one `github` operation (`center.rs`): its state
//! and auto-merge, its labels, assignees and requested reviewers, the review conversation (threads with their replies,
//! resolution and the code a comment sits on, reactions, the timeline), files marked viewed, the stack of PRs it sits
//! in, a short read of any issue or PR for a link's peek, the checkout's PR template and the account's API quota.
//! Orca's counterpart is named at each function. A write that carries a person's text sends it from a body file
//! (`BodyFile`), never on the command line, which Windows caps at 32 767 characters.

use std::path::Path;

use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};

use super::BodyFile;
use super::center::Center;
use super::json::{self, get, or};
use crate::git::read;
use crate::server::{Fault, Reply};

fn done() -> Result<Reply, Fault> {
    Reply::json(&json!({ "ok": true }))
}

/// `owner` and `name` of `OWNER/NAME` or `HOST/OWNER/NAME`.
fn slug(repo: &str) -> Result<(&str, &str), Fault> {
    let mut parts = repo.rsplit('/');
    match (parts.next(), parts.next()) {
        (Some(name), Some(owner)) if !name.is_empty() && !owner.is_empty() => Ok((owner, name)),
        _ => Err(Fault::new(
            "github_failed",
            format!("Not a repository: {repo}"),
        )),
    }
}

/// A URL path segment (a label's name in `…/labels/<name>`).
fn segment(text: &str) -> String {
    text.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                char::from(byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

/// One `gh api graphql` run with string (`-f`) and integer (`-F`) variables; answers `data`.
async fn graphql(
    center: &Center<'_>,
    query: &str,
    strings: &[(&str, &str)],
    numbers: &[(&str, u64)],
) -> Result<Value, Fault> {
    let query = format!("query={query}");
    let strings: Vec<String> = strings
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect();
    let numbers: Vec<String> = numbers
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect();
    let mut args = vec!["graphql", "-f", query.as_str()];
    for variable in &strings {
        args.extend(["-f", variable.as_str()]);
    }
    for variable in &numbers {
        args.extend(["-F", variable.as_str()]);
    }
    let answer = json::parse(&center.api(&args).await?)?;
    Ok(answer.get("data").cloned().unwrap_or(Value::Null))
}

/// `gh pr close` or `gh pr reopen` (Orca `client/update/pr-state.ts:33-40`: gh's own reopen, which the REST state
/// PATCH can refuse).
pub async fn pr_state(center: &Center<'_>, number: u64, state: &str) -> Result<Reply, Fault> {
    let number = number.to_string();
    let verb = if state == "closed" { "close" } else { "reopen" };
    let repo = center.repo().await?;
    center
        .call(&["pr", verb, &number, "--repo", &repo], None)
        .await?;
    done()
}

/// Auto-merge on or off. On is GraphQL's `enablePullRequestAutoMerge` held to the head the PR has now, never `gh pr
/// merge --auto`, which merges at once when nothing blocks (Orca `client/merge/pr-auto-merge.ts:124-193`); off is `gh
/// pr merge --disable-auto` (`:214-221`).
pub async fn pr_auto_merge(
    center: &Center<'_>,
    number: u64,
    enable: bool,
    method: Option<&str>,
) -> Result<Reply, Fault> {
    let spelled = number.to_string();
    let repo = center.repo().await?;
    if !enable {
        center
            .call(
                &["pr", "merge", &spelled, "--disable-auto", "--repo", &repo],
                None,
            )
            .await?;
        return done();
    }
    let method = match method {
        Some("squash") => "SQUASH",
        Some("rebase") => "REBASE",
        _ => "MERGE",
    };
    let pr = center
        .json(&[
            "pr",
            "view",
            &spelled,
            "--repo",
            &repo,
            "--json",
            "id,headRefOid",
        ])
        .await?;
    let id = json::text(&pr, "id").unwrap_or_default();
    let head = json::text(&pr, "headRefOid").unwrap_or_default();
    let query = "mutation($id: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID) { enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $head}) { pullRequest { id } } }";
    let mut strings = vec![("id", id), ("method", method)];
    if !head.is_empty() {
        strings.push(("head", head));
    }
    graphql(center, query, &strings, &[])
        .await
        .map_err(|fault| {
            // GitHub refuses auto-merge for a PR nothing blocks (Orca `classifySetAutoMergeError`).
            if fault.message.to_ascii_lowercase().contains("clean status") {
                Fault::new(
                    "github_failed",
                    "Nothing blocks this pull request, so there is no auto-merge to wait for: merge it instead",
                )
            } else {
                fault
            }
        })?;
    done()
}

/// Labels, assignees and (on a PR) requested reviewers to add or remove.
#[derive(Deserialize, Default)]
pub struct People {
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    assignees: Vec<String>,
    #[serde(default)]
    reviewers: Vec<String>,
}

/// A write of `values` as the array field `field` (`field[]=value` each) to a REST endpoint.
async fn rest(
    center: &Center<'_>,
    method: &str,
    endpoint: &str,
    field: &str,
    values: &[String],
) -> Result<(), Fault> {
    if values.is_empty() {
        return Ok(());
    }
    let fields: Vec<String> = values
        .iter()
        .map(|value| format!("{field}[]={value}"))
        .collect();
    let mut args = vec!["-X", method, endpoint];
    for value in &fields {
        args.extend(["-f", value.as_str()]);
    }
    center.api(&args).await.map(|_| ())
}

/// Edits a PR's or an issue's labels, assignees and requested reviewers through REST, which takes a PR as the issue
/// it is (Orca `client/update/pr-reviewers.ts:9-33` sends reviewers the same way). Not `gh pr edit`, whose GraphQL
/// read of the PR's classic projects fails on some repositories.
pub async fn people(
    center: &Center<'_>,
    pull: bool,
    number: u64,
    add: &People,
    remove: &People,
) -> Result<Reply, Fault> {
    let repo = center.repo().await?;
    let (owner, name) = slug(&repo)?;
    let issue = format!("repos/{owner}/{name}/issues/{number}");
    rest(
        center,
        "POST",
        &format!("{issue}/labels"),
        "labels",
        &add.labels,
    )
    .await?;
    for label in &remove.labels {
        let endpoint = format!("{issue}/labels/{}", segment(label));
        center.api(&["-X", "DELETE", &endpoint]).await?;
    }
    let assignees = format!("{issue}/assignees");
    rest(center, "POST", &assignees, "assignees", &add.assignees).await?;
    rest(center, "DELETE", &assignees, "assignees", &remove.assignees).await?;
    if pull {
        let reviewers = format!("repos/{owner}/{name}/pulls/{number}/requested_reviewers");
        rest(center, "POST", &reviewers, "reviewers", &add.reviewers).await?;
        rest(center, "DELETE", &reviewers, "reviewers", &remove.reviewers).await?;
    }
    done()
}

/// The logins that can be assigned in the repository: the reviewer, assignee and @mention pickers' people (Orca
/// `PRAssigneesPanel.tsx`, `github-mention-option-filter`). The first 100.
pub async fn assignable(center: &Center<'_>) -> Result<Reply, Fault> {
    let repo = center.repo().await?;
    let (owner, name) = slug(&repo)?;
    let endpoint = format!("repos/{owner}/{name}/assignees?per_page=100");
    let rows = json::parse(&center.api(&[&endpoint]).await?)?;
    let logins: Vec<Value> = json::list(&rows)
        .iter()
        .filter_map(|row| get(row, "login").cloned())
        .collect();
    Reply::json(&logins)
}

/// The repository's labels for the label picker (`gh label list`).
pub async fn labels(center: &Center<'_>) -> Result<Reply, Fault> {
    let repo = center.repo().await?;
    let rows = center
        .json(&[
            "label",
            "list",
            "--repo",
            &repo,
            "--limit",
            "200",
            "--json",
            "name,color,description",
        ])
        .await?;
    let labels: Vec<Value> = json::list(&rows)
        .iter()
        .map(|row| {
            json!({
                "name": or(row, "name", ""),
                "color": or(row, "color", ""),
                "description": or(row, "description", ""),
            })
        })
        .collect();
    Reply::json(&labels)
}

const REACTIONS: &str = "reactionGroups { content viewerHasReacted reactors { totalCount } }";
/// The timeline's events the conversation shows between comments (Orca `conversation-tab-timeline.tsx`).
const TIMELINE: &str = "timelineItems(last: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, CLOSED_EVENT, REOPENED_EVENT, MERGED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, REVIEW_REQUESTED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, RENAMED_TITLE_EVENT, PULL_REQUEST_COMMIT, CROSS_REFERENCED_EVENT]) { nodes { __typename ... on LabeledEvent { createdAt actor { login } label { name } } ... on UnlabeledEvent { createdAt actor { login } label { name } } ... on ClosedEvent { createdAt actor { login } } ... on ReopenedEvent { createdAt actor { login } } ... on MergedEvent { createdAt actor { login } mergeRefName } ... on HeadRefForcePushedEvent { createdAt actor { login } } ... on ReviewRequestedEvent { createdAt actor { login } requestedReviewer { ... on User { login } ... on Team { name } } } ... on AssignedEvent { createdAt actor { login } assignee { ... on User { login } } } ... on UnassignedEvent { createdAt actor { login } assignee { ... on User { login } } } ... on ReadyForReviewEvent { createdAt actor { login } } ... on ConvertToDraftEvent { createdAt actor { login } } ... on RenamedTitleEvent { createdAt actor { login } currentTitle } ... on PullRequestCommit { url commit { abbreviatedOid messageHeadline committedDate author { name user { login } } } } ... on CrossReferencedEvent { createdAt actor { login } source { ... on Issue { number title url } ... on PullRequest { number title url } } } } }";

/// One PR's conversation in one GraphQL read (Orca `client/fetch/pr-review-threads-query.ts`): its comments, reviews,
/// review threads (each with its comments, whether it is resolved and the diff hunk it sits on) and timeline.
fn conversation_query() -> String {
    let comment =
        format!("id databaseId author {{ login }} body bodyHTML createdAt url {REACTIONS}");
    format!(
        "query($owner: String!, $name: String!, $number: Int!) {{ repository(owner: $owner, name: $name) {{ pullRequest(number: $number) {{ id body bodyHTML comments(first: 100) {{ nodes {{ {comment} }} }} reviews(first: 100) {{ nodes {{ id author {{ login }} body bodyHTML state submittedAt createdAt url {REACTIONS} }} }} reviewThreads(first: 100) {{ nodes {{ id isResolved path line originalLine comments(first: 50) {{ nodes {{ {comment} diffHunk }} }} }} }} {TIMELINE} }} }} }}"
    )
}

/// Whether `text` is a UUID as GitHub writes an attachment's (`8-4-4-4-12` hex digits).
fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(at, byte)| {
            if matches!(at, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

/// The attachment id at the end of an attachment's path, `/assets/<uuid>` or `/assets/<digits>/<uuid>`, lowercased.
fn asset_id(path: &str) -> Option<String> {
    let rest = &path[path.rfind("/assets/")? + "/assets/".len()..];
    let id = match rest.split_once('/') {
        None => rest,
        Some((digits, id))
            if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            id
        }
        Some(_) => return None,
    };
    is_uuid(id).then(|| id.to_ascii_lowercase())
}

/// The first UUID anywhere in a path (a signed image's `/<user>/<n>-<uuid>.png`), lowercased.
fn uuid_in(path: &str) -> Option<String> {
    (0..path.len().saturating_sub(35))
        .filter_map(|at| path.get(at..at + 36))
        .find(|candidate| is_uuid(candidate))
        .map(str::to_ascii_lowercase)
}

/// What a private attachment shows as: each attachment URL in the Markdown `body` with the signed, short-lived URL
/// GitHub put in its rendered `html` for the same attachment, on githubusercontent.com or the same host (Orca
/// `main/github/attachments/body-image-urls.ts:7-144`). The page shows the signed one; the Markdown keeps the original.
fn body_images(body: &str, html: &str) -> serde_json::Map<String, Value> {
    let mut images = serde_json::Map::new();
    let originals: Vec<(&str, String, url::Url)> = body
        .match_indices("https://")
        .filter_map(|(at, _)| {
            let end = body[at..]
                .find(|c: char| c.is_whitespace() || "<>\"'`()[]".contains(c))
                .map_or(body.len(), |length| at + length);
            let text = &body[at..end];
            let url = url::Url::parse(text).ok()?;
            let id = asset_id(url.path())?;
            Some((text, id, url))
        })
        .collect();
    if originals.is_empty() {
        return images;
    }
    let mut signed: Vec<(String, url::Url)> = Vec::new();
    for (at, _) in html.match_indices("<img") {
        let tag = &html[at..html[at..].find('>').map_or(html.len(), |end| at + end)];
        // `src="…"`, never the `data-canonical-src` GitHub puts beside it.
        let Some(src) = tag.match_indices("src=\"").find_map(|(start, _)| {
            let before = tag[..start].chars().last();
            before
                .is_some_and(char::is_whitespace)
                .then(|| &tag[start + 5..])
                .and_then(|value| value.split('"').next())
        }) else {
            continue;
        };
        let Ok(url) = url::Url::parse(&src.replace("&amp;", "&")) else {
            continue;
        };
        if url.scheme() == "https"
            && let Some(id) = uuid_in(url.path())
        {
            signed.push((id, url));
        }
    }
    for (original, id, url) in originals {
        let Some((_, display)) = signed.iter().find(|(signed_id, _)| *signed_id == id) else {
            continue;
        };
        let trusted = display.host_str().is_some_and(|host| {
            host.ends_with(".githubusercontent.com") || Some(host) == url.host_str()
        });
        if trusted && display.as_str() != original {
            images.insert(original.to_owned(), Value::from(display.as_str()));
        }
    }
    images
}

/// `{images}` beside a body that holds private attachments; nothing for one that holds none.
fn with_images(mut entry: Value, row: &Value) -> Value {
    let images = body_images(
        json::text(row, "body").unwrap_or_default(),
        json::text(row, "bodyHTML").unwrap_or_default(),
    );
    if !images.is_empty() {
        entry["images"] = Value::Object(images);
    }
    entry
}

/// A comment's reactions that someone gave, in GitHub's order: `{content, count, viewerHasReacted}` (Orca
/// `comments/comment-reactions.ts:61-90`).
fn reactions(row: &Value) -> Vec<Value> {
    json::rows(row, "reactionGroups")
        .iter()
        .filter_map(|group| {
            let count = get(group, "reactors")
                .and_then(|reactors| get(reactors, "totalCount"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            (count > 0).then(|| {
                json!({
                    "content": or(group, "content", ""),
                    "count": count,
                    "viewerHasReacted": json::truthy(&or(group, "viewerHasReacted", false)),
                })
            })
        })
        .collect()
}

fn comment(row: &Value) -> Value {
    with_images(
        json!({
            "id": or(row, "id", ""),
            "databaseId": or(row, "databaseId", Value::Null),
            "author": json::login(row, "author"),
            "body": or(row, "body", ""),
            "createdAt": or(row, "createdAt", ""),
            "url": or(row, "url", ""),
            "reactions": reactions(row),
        }),
        row,
    )
}

/// `connection.nodes ?? []`.
fn nodes<'a>(row: &'a Value, key: &str) -> &'a [Value] {
    get(row, key).map_or(&[], |connection| json::rows(connection, "nodes"))
}

/// One timeline event as `{kind, actor, createdAt, subject?, url?, sha?}`; none for a kind the conversation does not
/// show.
fn event(row: &Value) -> Option<Value> {
    let kind = match json::text(row, "__typename")? {
        "LabeledEvent" => "labeled",
        "UnlabeledEvent" => "unlabeled",
        "ClosedEvent" => "closed",
        "ReopenedEvent" => "reopened",
        "MergedEvent" => "merged",
        "HeadRefForcePushedEvent" => "force_pushed",
        "ReviewRequestedEvent" => "review_requested",
        "AssignedEvent" => "assigned",
        "UnassignedEvent" => "unassigned",
        "ReadyForReviewEvent" => "ready_for_review",
        "ConvertToDraftEvent" => "converted_to_draft",
        "RenamedTitleEvent" => "renamed",
        "PullRequestCommit" => "commit",
        "CrossReferencedEvent" => "referenced",
        _ => return None,
    };
    if kind == "commit" {
        let commit = get(row, "commit")?;
        let author = get(commit, "author");
        let actor = author
            .and_then(|author| get(author, "user"))
            .and_then(|user| get(user, "login"))
            .or_else(|| author.and_then(|author| get(author, "name")))
            .cloned()
            .unwrap_or_else(|| "ghost".into());
        return Some(json!({
            "kind": kind,
            "actor": actor,
            "createdAt": or(commit, "committedDate", ""),
            "subject": or(commit, "messageHeadline", ""),
            "sha": or(commit, "abbreviatedOid", ""),
            "url": or(row, "url", ""),
        }));
    }
    let mut event = json!({
        "kind": kind,
        "actor": json::login(row, "actor"),
        "createdAt": or(row, "createdAt", ""),
    });
    let named = |outer: &str, inner: &[&str]| {
        get(row, outer).and_then(|value| inner.iter().find_map(|key| get(value, key).cloned()))
    };
    let subject = match kind {
        "labeled" | "unlabeled" => named("label", &["name"]),
        "merged" => get(row, "mergeRefName").cloned(),
        "review_requested" => named("requestedReviewer", &["login", "name"]),
        "assigned" | "unassigned" => named("assignee", &["login"]),
        "renamed" => get(row, "currentTitle").cloned(),
        "referenced" => get(row, "source").map(|source| {
            Value::from(format!(
                "#{} {}",
                or(source, "number", 0),
                json::text(source, "title").unwrap_or_default()
            ))
        }),
        _ => None,
    };
    if let Some(subject) = subject {
        event["subject"] = subject;
    }
    if let Some(url) = named("source", &["url"]) {
        event["url"] = url;
    }
    Some(event)
}

/// `pr_conversation`: the PR's node id, its comments, its reviews with text or a verdict (a bare COMMENTED review only
/// wraps its inline comments), its review threads and its timeline.
pub async fn conversation(center: &Center<'_>, number: u64) -> Result<Reply, Fault> {
    let repo = center.repo().await?;
    let (owner, name) = slug(&repo)?;
    let data = graphql(
        center,
        &conversation_query(),
        &[("owner", owner), ("name", name)],
        &[("number", number)],
    )
    .await?;
    let pull = get(&data, "repository")
        .and_then(|repository| get(repository, "pullRequest"))
        .cloned()
        .unwrap_or(Value::Null);
    let reviews: Vec<Value> = nodes(&pull, "reviews")
        .iter()
        .filter(|row| {
            json::text(row, "body").is_some_and(|body| !body.trim().is_empty())
                || json::text(row, "state") != Some("COMMENTED")
        })
        .map(|row| {
            with_images(
                json!({
                    "id": or(row, "id", ""),
                    "author": json::login(row, "author"),
                    "body": or(row, "body", ""),
                    "state": or(row, "state", ""),
                    "createdAt": get(row, "submittedAt").or_else(|| get(row, "createdAt")).cloned().unwrap_or_else(|| "".into()),
                    "url": or(row, "url", ""),
                    "reactions": reactions(row),
                }),
                row,
            )
        })
        .collect();
    let threads: Vec<Value> = nodes(&pull, "reviewThreads")
        .iter()
        .map(|row| {
            let comments = nodes(row, "comments");
            json!({
                "id": or(row, "id", ""),
                "isResolved": or(row, "isResolved", false),
                "path": or(row, "path", ""),
                "line": get(row, "line").or_else(|| get(row, "originalLine")).cloned().unwrap_or(Value::Null),
                "diffHunk": comments.first().map_or(Value::from(""), |first| or(first, "diffHunk", "")),
                "comments": comments.iter().map(comment).collect::<Vec<_>>(),
            })
        })
        .collect();
    let pull_images = body_images(
        json::text(&pull, "body").unwrap_or_default(),
        json::text(&pull, "bodyHTML").unwrap_or_default(),
    );
    Reply::json(&json!({
        "id": or(&pull, "id", ""),
        "bodyImages": pull_images,
        "comments": nodes(&pull, "comments").iter().map(comment).collect::<Vec<_>>(),
        "reviews": reviews,
        "threads": threads,
        "timeline": nodes(&pull, "timelineItems").iter().filter_map(event).collect::<Vec<_>>(),
    }))
}

/// A reply inside a review thread to its first comment (Orca `pull-request-page/conversation/reply.ts:18-40`): REST's
/// replies endpoint, the text read from a body file (`-F body=@file`).
pub async fn thread_reply(
    center: &Center<'_>,
    number: u64,
    comment_id: u64,
    body: &str,
) -> Result<Reply, Fault> {
    let repo = center.repo().await?;
    let (owner, name) = slug(&repo)?;
    let file = BodyFile::new(body).await?;
    let field = format!("body=@{}", file.path());
    let endpoint = format!("repos/{owner}/{name}/pulls/{number}/comments/{comment_id}/replies");
    center.api(&["-X", "POST", &endpoint, "-F", &field]).await?;
    drop(file);
    done()
}

/// Resolves or reopens a review thread (Orca `client/update/resolve-review-thread.ts:15-39`).
pub async fn thread_resolve(
    center: &Center<'_>,
    thread_id: &str,
    resolved: bool,
) -> Result<Reply, Fault> {
    let mutation = if resolved {
        "resolveReviewThread"
    } else {
        "unresolveReviewThread"
    };
    let query = format!(
        "mutation($id: ID!) {{ {mutation}(input: {{threadId: $id}}) {{ thread {{ isResolved }} }} }}"
    );
    graphql(center, &query, &[("id", thread_id)], &[]).await?;
    done()
}

/// Adds or removes the viewer's reaction on a comment or review (Orca `client/update/pr-comment-reaction.ts:18-56`);
/// `content` is GraphQL's `ReactionContent` (main checked it).
pub async fn reaction(
    center: &Center<'_>,
    subject_id: &str,
    content: &str,
    add: bool,
) -> Result<Reply, Fault> {
    let mutation = if add { "addReaction" } else { "removeReaction" };
    let query = format!(
        "mutation($id: ID!, $content: ReactionContent!) {{ {mutation}(input: {{subjectId: $id, content: $content}}) {{ subject {{ id }} }} }}"
    );
    graphql(
        center,
        &query,
        &[("id", subject_id), ("content", content)],
        &[],
    )
    .await?;
    done()
}

/// The PR's node id and each file's viewed state for the viewer (`VIEWED`, `UNVIEWED`, `DISMISSED`: viewed before the
/// file changed again), the first 100 files (Orca `PRViewedCheckbox.tsx`, `pr-file-diff-mapping.ts`).
pub async fn files_viewed(center: &Center<'_>, number: u64) -> Result<Reply, Fault> {
    let repo = center.repo().await?;
    let (owner, name) = slug(&repo)?;
    let query = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id files(first: 100) { nodes { path viewerViewedState } } } } }";
    let data = graphql(
        center,
        query,
        &[("owner", owner), ("name", name)],
        &[("number", number)],
    )
    .await?;
    let pull = get(&data, "repository")
        .and_then(|repository| get(repository, "pullRequest"))
        .cloned()
        .unwrap_or(Value::Null);
    let files: Vec<Value> = nodes(&pull, "files")
        .iter()
        .map(|file| {
            json!({
                "path": or(file, "path", ""),
                "state": or(file, "viewerViewedState", "UNVIEWED"),
            })
        })
        .collect();
    Reply::json(&json!({ "id": or(&pull, "id", ""), "files": files }))
}

/// Marks one file of a PR viewed or not (Orca `client/update/pr-file-viewed.ts:28-58`).
pub async fn file_viewed(
    center: &Center<'_>,
    pull_request_id: &str,
    path: &str,
    viewed: bool,
) -> Result<Reply, Fault> {
    let mutation = if viewed {
        "markFileAsViewed"
    } else {
        "unmarkFileAsViewed"
    };
    let query = format!(
        "mutation($id: ID!, $path: String!) {{ {mutation}(input: {{pullRequestId: $id, path: $path}}) {{ pullRequest {{ id }} }} }}"
    );
    graphql(
        center,
        &query,
        &[("id", pull_request_id), ("path", path)],
        &[],
    )
    .await?;
    done()
}

/// The longest stack shown.
const STACK_MOST: usize = 20;

/// The stack a PR sits in, bottom first: below it the PRs whose head is the base of the one above (an open one, else
/// the newest), above it the open PRs based on its head and theirs; empty when it stands alone. Orca reads GitHub's
/// stack metadata (`GitHubPRStackMap.tsx`, `lookup/pr-stack-summary-cache.ts`); this one follows the branches, which
/// every repository has.
fn stack(rows: &[Value], number: u64) -> Vec<Value> {
    let numbered = |row: &&Value| row.get("number").and_then(Value::as_u64);
    let Some(current) = rows.iter().find(|row| numbered(row) == Some(number)) else {
        return Vec::new();
    };
    let field = |row: &Value, key: &str| json::text(row, key).unwrap_or_default().to_owned();
    let open = |row: &Value| json::text(row, "state") == Some("OPEN");
    let mut seen = vec![number];
    let mut below = Vec::new();
    let mut base = field(current, "baseRefName");
    while below.len() < STACK_MOST {
        let mut candidates: Vec<&Value> = rows
            .iter()
            .filter(|row| json::text(row, "headRefName") == Some(base.as_str()))
            .filter(|row| numbered(row).is_some_and(|number| !seen.contains(&number)))
            .collect();
        candidates.sort_by_key(|row| (open(*row), numbered(row)));
        let Some(&next) = candidates.last() else {
            break;
        };
        seen.extend(numbered(&next));
        below.push(next);
        base = field(next, "baseRefName");
    }
    let mut above = Vec::new();
    let mut heads = vec![field(current, "headRefName")];
    while let Some(head) = heads.pop() {
        for row in rows {
            let Some(child) = numbered(&row) else {
                continue;
            };
            if above.len() + below.len() >= STACK_MOST
                || seen.contains(&child)
                || !open(row)
                || json::text(row, "baseRefName") != Some(head.as_str())
            {
                continue;
            }
            seen.push(child);
            above.push(row);
            heads.push(field(row, "headRefName"));
        }
    }
    if below.is_empty() && above.is_empty() {
        return Vec::new();
    }
    let entry = |row: &Value| {
        json!({
            "number": or(row, "number", 0),
            "title": or(row, "title", ""),
            "state": or(row, "state", ""),
            "isDraft": or(row, "isDraft", false),
            "headRefName": or(row, "headRefName", ""),
            "baseRefName": or(row, "baseRefName", ""),
            "url": or(row, "url", ""),
            "current": numbered(&row) == Some(number),
        })
    };
    below
        .iter()
        .rev()
        .copied()
        .chain(std::iter::once(current))
        .chain(above.iter().copied())
        .map(entry)
        .collect()
}

/// `pr_stack`: the stack of `number` among the repository's 200 newest PRs (one `gh pr list`).
pub async fn pr_stack(center: &Center<'_>, number: u64) -> Result<Reply, Fault> {
    let repo = center.repo().await?;
    let rows = center
        .json(&[
            "pr",
            "list",
            "--repo",
            &repo,
            "--state",
            "all",
            "--limit",
            "200",
            "--json",
            "number,title,state,isDraft,headRefName,baseRefName,url",
        ])
        .await?;
    Reply::json(&stack(json::list(&rows), number))
}

/// The places a repository keeps its PR template, first found first (Orca `client/create/pull-request-template.ts:54-61`).
const TEMPLATES: [&str; 6] = [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
];
/// A longer file is no template a PR body can take.
const TEMPLATE_MOST: u64 = 65_536;

fn read_template(root: &str) -> Option<String> {
    TEMPLATES.iter().find_map(|relative| {
        let file = Path::new(root).join(relative);
        let size = std::fs::metadata(&file).ok()?.len();
        (size <= TEMPLATE_MOST)
            .then(|| std::fs::read_to_string(&file).ok())
            .flatten()
            .filter(|text| !text.trim().is_empty())
    })
}

/// `pr_template`: the checkout's PR template, `null` when it has none.
pub async fn pr_template(center: &Center<'_>) -> Result<Reply, Fault> {
    let root = read::repo_root(center.tools.git()?, center.cwd).await?;
    let body = match root {
        Some(root) => tokio::task::spawn_blocking(move || read_template(&root))
            .await
            .map_err(|_| Fault::new("internal", "The template read panicked"))?,
        None => None,
    };
    Reply::json(&json!({ "body": body }))
}

/// `rate_limit`: the account's REST, GraphQL and search quotas on the host (`gh api rate_limit`, which costs nothing):
/// `{name, limit, remaining, used, reset}`, `reset` in seconds since 1970 (Orca `github-rate-limit-display.tsx`).
pub async fn rate_limit(center: &Center<'_>) -> Result<Reply, Fault> {
    let answer = json::parse(&center.api(&["rate_limit"]).await?)?;
    let resources = get(&answer, "resources");
    let rows: Vec<Value> = ["core", "graphql", "search"]
        .iter()
        .filter_map(|name| {
            let resource = get(resources?, name)?;
            Some(json!({
                "name": name,
                "limit": or(resource, "limit", 0),
                "remaining": or(resource, "remaining", 0),
                "used": or(resource, "used", 0),
                "reset": or(resource, "reset", 0),
            }))
        })
        .collect();
    Reply::json(&rows)
}

/// A failed job's annotations (its check run is the job): `{path, line, level, title, message}`, the first 20; none
/// when the read fails, so the run's detail still shows (Orca `editor/check-details/panel`).
pub async fn annotations(center: &Center<'_>, repo: &str, job_id: u64) -> Vec<Value> {
    let Ok((owner, name)) = slug(repo) else {
        return Vec::new();
    };
    let endpoint = format!("repos/{owner}/{name}/check-runs/{job_id}/annotations?per_page=20");
    let Ok(rows) = center
        .api(&[&endpoint])
        .await
        .and_then(|text| json::parse(&text))
    else {
        return Vec::new();
    };
    json::list(&rows)
        .iter()
        .map(|row| {
            json!({
                "path": or(row, "path", ""),
                "line": or(row, "start_line", Value::Null),
                "level": or(row, "annotation_level", ""),
                "title": or(row, "title", ""),
                "message": or(row, "message", ""),
            })
        })
        .collect()
}

/// The image types GitHub's attachments take and their largest size (Orca `shared/github/attachments/image-attachment.ts`).
const IMAGE_TYPES: [&str; 5] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
];
const IMAGE_MOST: usize = 10 * 1024 * 1024;
/// A private attachment read for showing: GitHub's own previews stay well under this.
const ATTACHMENT_MOST: usize = 5 * 1024 * 1024;
const ATTACHMENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const UPLOAD_MS: u64 = 120_000;

/// Whether GitHub takes image uploads on `host`: github.com and its `*.ghe.com` data-residency hosts; a server of
/// GitHub Enterprise has no uploads endpoint gh can reach.
fn uploads_allowed(host: &str) -> bool {
    host == "github.com"
        || host.strip_suffix(".ghe.com").is_some_and(|name| {
            !name.is_empty()
                && !name.starts_with('-')
                && !name.ends_with('-')
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

/// `image_upload`: a pasted or dropped image uploaded as a GitHub attachment, answering its URL for the Markdown (Orca
/// `main/github/attachments/image-attachment-upload.ts:10-99`): the repository's id, then a POST of the bytes on gh's
/// stdin to `uploads.<host>/user-attachments/assets`.
pub async fn image_upload(
    center: &Center<'_>,
    name: &str,
    content_type: &str,
    data: &str,
) -> Result<Reply, Fault> {
    if !IMAGE_TYPES.contains(&content_type) {
        return Err(Fault::new(
            "github_failed",
            "GitHub takes PNG, JPEG, GIF, WebP and SVG images",
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| Fault::new("invalid_params", "The image is not base64"))?;
    if bytes.is_empty() || bytes.len() > IMAGE_MOST {
        return Err(Fault::new(
            "github_failed",
            "GitHub takes images up to 10 MB",
        ));
    }
    let host = center.host_name().to_ascii_lowercase();
    if !uploads_allowed(&host) {
        return Err(Fault::new(
            "github_failed",
            "This GitHub server takes no image uploads: attach the image on GitHub or use an image URL",
        ));
    }
    let repo = center.repo().await?;
    let (owner, repo_name) = slug(&repo)?;
    let info = json::parse(&center.api(&[&format!("repos/{owner}/{repo_name}")]).await?)?;
    let Some(id) = get(&info, "id")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
    else {
        return Err(Fault::new(
            "github_failed",
            "GitHub could not find this repository",
        ));
    };
    let endpoint = format!(
        "https://uploads.{host}/user-attachments/assets?name={}&content_type={}&repository_id={id}",
        segment(name),
        segment(content_type)
    );
    let length = format!("Content-Length: {}", bytes.len());
    let args = [
        "api",
        "-X",
        "POST",
        &endpoint,
        "-H",
        "Content-Type: application/octet-stream",
        "-H",
        &length,
        "--input",
        "-",
    ];
    let asset = json::parse(&center.send(&args, Some(UPLOAD_MS), Some(&bytes)).await?)?;
    let url = json::text(&asset, "url").unwrap_or_default();
    if !url.starts_with(&format!("https://{host}/user-attachments/")) {
        return Err(Fault::new(
            "github_failed",
            "GitHub did not answer an image URL: paste the image again to retry",
        ));
    }
    Reply::json(&json!({ "url": url }))
}

/// `item_peek`: an issue's or a PR's title, state and author in one REST read, for a link's hover card and a PR card
/// that follows its PR (Orca `client/fetch/work-item-preview.ts`). `state` is `MERGED` for a merged PR.
pub async fn item_peek(center: &Center<'_>, number: u64) -> Result<Reply, Fault> {
    let repo = center.repo().await?;
    let (owner, name) = slug(&repo)?;
    let endpoint = format!("repos/{owner}/{name}/issues/{number}");
    let row = json::parse(&center.api(&[&endpoint]).await?)?;
    let pull = get(&row, "pull_request");
    let state = if pull.and_then(|pull| get(pull, "merged_at")).is_some() {
        "MERGED"
    } else if json::text(&row, "state") == Some("closed") {
        "CLOSED"
    } else {
        "OPEN"
    };
    Reply::json(&json!({
        "number": or(&row, "number", number),
        "title": or(&row, "title", ""),
        "state": state,
        "isPr": pull.is_some(),
        "isDraft": or(&row, "draft", false),
        "author": json::login(&row, "user"),
        "comments": or(&row, "comments", 0),
        "url": or(&row, "html_url", ""),
        "updatedAt": or(&row, "updated_at", ""),
    }))
}

/// Where GitHub serves a private attachment's signed URL: its user-content hosts, never anything a body names.
fn attachment_allowed(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|url| {
        url.scheme() == "https"
            && url.port().is_none()
            && url.host_str().is_some_and(|host| {
                host.strip_suffix(".githubusercontent.com")
                    .is_some_and(|name| !name.is_empty() && !name.contains('/'))
            })
    })
}

/// `attachment`: one private attachment image read through its short-lived signed URL (the `images` map of a
/// conversation's bodies) and answered as a `data:` URL, because the page loads no remote image (Orca
/// `main/github/attachments/body-image-urls.ts:7-144` swaps the same URLs; it lets the browser load them). The read is
/// `web_peek::fetch_capped`'s: no credentials, public addresses only, an image type, 5 MiB at most.
pub async fn attachment(url: &str) -> Result<Reply, Fault> {
    if !attachment_allowed(url) {
        return Err(Fault::new("invalid_params", "Not a GitHub attachment URL"));
    }
    let fetched = crate::web_peek::fetch_capped(
        url,
        crate::web_peek::Accepted::Image,
        ATTACHMENT_MOST,
        ATTACHMENT_TIMEOUT,
    )
    .await?;
    let mime = fetched
        .content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let data = base64::engine::general_purpose::STANDARD.encode(&fetched.bytes);
    Reply::json(&json!({ "dataUrl": format!("data:{mime};base64,{data}") }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_owner_and_name_and_spells_a_label_for_its_path() {
        assert_eq!(slug("o/r").unwrap(), ("o", "r"));
        assert_eq!(slug("ghe.test/o/r").unwrap(), ("o", "r"));
        assert!(slug("r").is_err());
        assert_eq!(
            segment("good first/issue 한"),
            "good%20first%2Fissue%20%ED%95%9C"
        );
        assert!(uploads_allowed("github.com"));
        assert!(uploads_allowed("acme.ghe.com"));
        assert!(!uploads_allowed("ghe.example.com"));
        assert!(!uploads_allowed(".ghe.com"));
        assert!(!uploads_allowed("-x.ghe.com"));
        assert!(attachment_allowed(
            "https://private-user-images.githubusercontent.com/1/a.png?jwt=x"
        ));
        assert!(!attachment_allowed(
            "http://private-user-images.githubusercontent.com/1/a.png"
        ));
        assert!(!attachment_allowed(
            "https://githubusercontent.com.evil.test/a.png"
        ));
        assert!(!attachment_allowed(
            "https://private-user-images.githubusercontent.com:8443/a.png"
        ));
        assert!(!attachment_allowed("https://github.com/o/r/assets/1"));
    }

    #[test]
    fn follows_a_stack_of_branches_both_ways() {
        let pr = |number: u64, head: &str, base: &str, state: &str| json!({ "number": number, "headRefName": head, "baseRefName": base, "state": state });
        let rows = [
            pr(1, "a", "main", "MERGED"),
            pr(2, "b", "a", "OPEN"),
            pr(3, "c", "b", "OPEN"),
            pr(4, "d", "c", "OPEN"),
            pr(5, "e", "b", "CLOSED"),
            pr(6, "x", "main", "OPEN"),
        ];
        let numbers = |entries: Vec<Value>| -> Vec<u64> {
            entries
                .iter()
                .map(|entry| entry["number"].as_u64().unwrap())
                .collect()
        };
        assert_eq!(numbers(stack(&rows, 3)), [1, 2, 3, 4]);
        assert_eq!(stack(&rows, 3)[2]["current"], json!(true));
        assert!(stack(&rows, 6).is_empty());
        assert!(stack(&rows, 99).is_empty());
        // A cycle of branches ends.
        let cycle = [pr(7, "p", "q", "OPEN"), pr(8, "q", "p", "OPEN")];
        assert_eq!(numbers(stack(&cycle, 7)), [8, 7]);
    }

    #[test]
    fn reads_the_timeline_s_events() {
        let labeled = json!({ "__typename": "LabeledEvent", "createdAt": "t", "actor": { "login": "a" }, "label": { "name": "bug" } });
        assert_eq!(
            event(&labeled).unwrap(),
            json!({ "kind": "labeled", "actor": "a", "createdAt": "t", "subject": "bug" })
        );
        let commit = json!({ "__typename": "PullRequestCommit", "url": "u", "commit": { "abbreviatedOid": "abc", "messageHeadline": "Fix", "committedDate": "t", "author": { "name": "N", "user": null } } });
        assert_eq!(
            event(&commit).unwrap(),
            json!({ "kind": "commit", "actor": "N", "createdAt": "t", "subject": "Fix", "sha": "abc", "url": "u" })
        );
        let referenced = json!({ "__typename": "CrossReferencedEvent", "createdAt": "t", "actor": null, "source": { "number": 9, "title": "T", "url": "s" } });
        assert_eq!(
            event(&referenced).unwrap(),
            json!({ "kind": "referenced", "actor": "ghost", "createdAt": "t", "subject": "#9 T", "url": "s" })
        );
        assert!(event(&json!({ "__typename": "SubscribedEvent" })).is_none());
        let group = json!({ "reactionGroups": [
            { "content": "HEART", "viewerHasReacted": true, "reactors": { "totalCount": 2 } },
            { "content": "EYES", "viewerHasReacted": false, "reactors": { "totalCount": 0 } },
        ] });
        assert_eq!(
            reactions(&group),
            vec![json!({ "content": "HEART", "count": 2, "viewerHasReacted": true })]
        );
    }

    /// A private attachment shows through the signed URL GitHub rendered for it; another host's picture, an image
    /// that is no attachment and a body without one map to nothing.
    #[test]
    fn maps_a_private_attachment_to_its_signed_url() {
        let id = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
        let original = format!("https://github.com/user-attachments/assets/{id}");
        let body = format!("Look:\n\n![shot]({original})\n\n![other](https://example.test/a.png)");
        let signed = format!(
            "https://private-user-images.githubusercontent.com/1/2-{}.png?jwt=abc&amp;x=1",
            id.to_uppercase()
        );
        let html = format!(
            "<p><img data-canonical-src=\"{original}\" src=\"{signed}\" alt=\"shot\"></p><img src=\"https://evil.test/{id}.png\">"
        );
        let images = body_images(&body, &html);
        assert_eq!(images.len(), 1);
        assert_eq!(
            images[&original],
            json!(format!(
                "https://private-user-images.githubusercontent.com/1/2-{}.png?jwt=abc&x=1",
                id.to_uppercase()
            ))
        );
        assert!(body_images("no attachment", &html).is_empty());
        assert_eq!(
            asset_id(&format!("/user-attachments/assets/123/{id}")),
            Some(id.into())
        );
        assert_eq!(asset_id("/user-attachments/assets/x/y"), None);
    }
}
