//! Agents › GitHub › Projects: GitHub Projects (v2) over `gh api graphql` (Orca `main/github/project-view/*` at
//! stablyai/orca 02cecc98). Every query goes through the request's gh, so through the host's gate and quota guard
//! (`gate.rs`; Orca `project-graphql.ts:20-36`).
//!
//! - The projects one can open: the viewer's first 40, then up to 20 organizations with 20 each; a project past those
//!   opens by its address (`project-view-discovery.ts:16-20`). An organization page that fails keeps what was found and
//!   says so.
//! - A view: by id, else the first table, else a roadmap, else a board (`project-view-table.ts:48-145`,
//!   `project-view-config.ts:259-280`); another layout is refused with the item count.
//! - Its items: 100 a page in the project's order, at most 500 (`project-view-items.ts:21-22`), with each field value
//!   by its field.
//! - A field set or cleared on an item (`project-field-mutations.ts:51-110`).
//!
//! Not read: an issue's parent, sub-issue progress and linked pull requests (Orca's optional selections and their
//! capability cache, `project-view-cache.ts:36-97`); nothing here shows them.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::center::Center;
use super::json;
use crate::server::{Fault, Reply};

const OWNER_PROJECTS: usize = 40;
const ORGS_MAX: usize = 20;
const ORG_PROJECTS: usize = 20;
const VIEWS_PAGE: usize = 20;
const FIELDS_PAGE: usize = 50;
const ITEMS_PAGE: usize = 100;
const ITEMS_MAX: u64 = 500;

const FIELD_CONFIG: &str = "fragment FieldConfig on ProjectV2FieldConfiguration { __typename \
    ... on ProjectV2Field { id name dataType } \
    ... on ProjectV2SingleSelectField { id name dataType options { id name color } } \
    ... on ProjectV2IterationField { id name dataType configuration { \
        iterations { id title startDate duration } completedIterations { id title startDate duration } } } }";

/// A GraphQL variable as gh takes it: `-f` a string, `-F` a number.
enum Var<'a> {
    Text(&'a str),
    Number(String),
}

/// One query or mutation; gh's words when it fails, `gh_project_scope` when the token lacks the project scope.
async fn graphql(
    center: &Center<'_>,
    query: &str,
    vars: &[(&str, Var<'_>)],
) -> Result<Value, Fault> {
    let mut args: Vec<String> = vec!["graphql".into(), "-f".into(), format!("query={query}")];
    for (name, value) in vars {
        match value {
            Var::Text(text) => args.extend(["-f".into(), format!("{name}={text}")]),
            Var::Number(number) => args.extend(["-F".into(), format!("{name}={number}")]),
        }
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let text = center.api(&args).await.map_err(|fault| {
        let lower = fault.message.to_ascii_lowercase();
        if ["insufficient_scopes", "required scopes", "read:project"]
            .iter()
            .any(|phrase| lower.contains(phrase))
        {
            Fault::new("gh_project_scope", fault.message)
        } else {
            fault
        }
    })?;
    let answer = json::parse(&text)?;
    Ok(answer.get("data").cloned().unwrap_or(Value::Null))
}

fn text(value: &Value, path: &str) -> String {
    value
        .pointer(path)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    id: String,
    owner: String,
    /// `organization` or `user`.
    owner_type: &'static str,
    number: u64,
    title: String,
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Listed {
    projects: Vec<Summary>,
    /// An organization list that failed: what was found before it is kept.
    partial_failure: Option<String>,
}

fn summaries(
    nodes: &[Value],
    owner: Option<(&str, &'static str)>,
    cap: usize,
    into: &mut Vec<Summary>,
) {
    for node in nodes.iter().take(cap) {
        let (Some(id), Some(number)) = (
            node.get("id").and_then(Value::as_str),
            node.get("number").and_then(Value::as_u64),
        ) else {
            continue;
        };
        let (login, kind) = owner.map_or_else(
            || {
                let kind = if text(node, "/owner/__typename") == "Organization" {
                    "organization"
                } else {
                    "user"
                };
                (text(node, "/owner/login"), kind)
            },
            |(login, kind)| (login.to_owned(), kind),
        );
        into.push(Summary {
            id: id.to_owned(),
            owner: login,
            owner_type: kind,
            number,
            title: text(node, "/title"),
            url: text(node, "/url"),
        });
    }
}

pub(super) async fn list(center: &Center<'_>) -> Result<Reply, Fault> {
    let mut projects = Vec::new();
    let viewer = graphql(
        center,
        &format!(
            "query {{ viewer {{ login projectsV2(first: {OWNER_PROJECTS}) {{ nodes {{ id number title url \
             owner {{ __typename ... on Organization {{ login }} ... on User {{ login }} }} }} }} }} }}"
        ),
        &[],
    )
    .await?;
    summaries(
        json::rows(
            viewer.pointer("/viewer/projectsV2").unwrap_or(&Value::Null),
            "nodes",
        ),
        None,
        OWNER_PROJECTS,
        &mut projects,
    );
    let orgs = graphql(
        center,
        &format!(
            "query {{ viewer {{ organizations(first: {ORGS_MAX}) {{ nodes {{ login \
             projectsV2(first: {ORG_PROJECTS}) {{ nodes {{ id number title url }} }} }} }} }} }}"
        ),
        &[],
    )
    .await;
    let partial_failure = match orgs {
        Ok(data) => {
            for org in json::rows(
                data.pointer("/viewer/organizations")
                    .unwrap_or(&Value::Null),
                "nodes",
            ) {
                let login = text(org, "/login");
                if login.is_empty() {
                    continue;
                }
                summaries(
                    json::rows(org.get("projectsV2").unwrap_or(&Value::Null), "nodes"),
                    Some((login.as_str(), "organization")),
                    ORG_PROJECTS,
                    &mut projects,
                );
            }
            None
        }
        Err(fault) if fault == Fault::cancelled() => return Err(fault),
        Err(fault) => Some(fault.message),
    };
    // A viewer's organization project also comes in its organization's list: once.
    let mut seen = std::collections::HashSet::new();
    projects.retain(|project| seen.insert(project.id.clone()));
    Reply::json(&Listed {
        projects,
        partial_failure,
    })
}

/// A field as the page reads it: its kind, and a single select's options or an iteration field's iterations.
fn field(raw: &Value) -> Option<Value> {
    let id = raw.get("id").and_then(Value::as_str)?;
    let name = text(raw, "/name");
    let data_type = text(raw, "/dataType");
    Some(match raw.get("__typename").and_then(Value::as_str) {
        Some("ProjectV2SingleSelectField") => json!({
            "kind": "single-select", "id": id, "name": name, "dataType": data_type,
            "options": json::rows(raw, "options").iter().map(|option| json!({
                "id": text(option, "/id"), "name": text(option, "/name"), "color": text(option, "/color"),
            })).collect::<Vec<_>>(),
        }),
        Some("ProjectV2IterationField") => {
            let configuration = raw.get("configuration").unwrap_or(&Value::Null);
            let iterations: Vec<Value> = json::rows(configuration, "iterations")
                .iter()
                .chain(json::rows(configuration, "completedIterations"))
                .map(|iteration| {
                    json!({
                        "id": text(iteration, "/id"), "title": text(iteration, "/title"),
                        "startDate": text(iteration, "/startDate"),
                        "duration": iteration.get("duration").and_then(Value::as_u64).unwrap_or(0),
                    })
                })
                .collect();
            json!({ "kind": "iteration", "id": id, "name": name, "dataType": data_type, "iterations": iterations })
        }
        _ => json!({ "kind": "field", "id": id, "name": name, "dataType": data_type }),
    })
}

fn fields(nodes: &[Value]) -> Vec<Value> {
    nodes.iter().filter_map(field).collect()
}

/// An item's field value by its field (`project-view-item-normalization.ts`).
fn value(node: &Value) -> Option<(String, Value)> {
    let field_id = text(node, "/field/id");
    if field_id.is_empty() {
        return None;
    }
    let names = |path: &str, key: &str| -> Vec<Value> {
        node.pointer(path)
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|entry| json!(text(entry, &format!("/{key}"))))
            .collect()
    };
    let value = match node.get("__typename").and_then(Value::as_str)? {
        "ProjectV2ItemFieldSingleSelectValue" => json!({
            "kind": "single-select", "optionId": text(node, "/optionId"), "name": text(node, "/name"),
            "color": text(node, "/color"),
        }),
        "ProjectV2ItemFieldIterationValue" => json!({
            "kind": "iteration", "iterationId": text(node, "/iterationId"), "title": text(node, "/title"),
            "startDate": text(node, "/startDate"),
            "duration": node.get("duration").and_then(Value::as_u64).unwrap_or(0),
        }),
        "ProjectV2ItemFieldTextValue" => json!({ "kind": "text", "text": text(node, "/text") }),
        "ProjectV2ItemFieldNumberValue" => {
            json!({ "kind": "number", "number": node.get("number").cloned().unwrap_or(Value::Null) })
        }
        "ProjectV2ItemFieldDateValue" => json!({ "kind": "date", "date": text(node, "/date") }),
        "ProjectV2ItemFieldLabelValue" => {
            json!({ "kind": "labels", "labels": names("/labels/nodes", "name") })
        }
        "ProjectV2ItemFieldUserValue" => {
            json!({ "kind": "users", "users": names("/users/nodes", "login") })
        }
        _ => return None,
    };
    Some((field_id, value))
}

fn row(node: &Value) -> Option<Value> {
    let id = node.get("id").and_then(Value::as_str)?;
    let content = node.get("content").unwrap_or(&Value::Null);
    let logins = |path: &str, key: &str| -> Vec<Value> {
        content
            .pointer(path)
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|entry| json!(text(entry, &format!("/{key}"))))
            .collect()
    };
    let values: Map<String, Value> =
        json::rows(node.get("fieldValues").unwrap_or(&Value::Null), "nodes")
            .iter()
            .filter_map(value)
            .collect();
    let present = |key: &str| content.get(key).filter(|value| !value.is_null()).cloned();
    Some(json!({
        "id": id,
        "itemType": text(node, "/type"),
        "number": present("number"),
        "title": text(content, "/title"),
        "body": present("body"),
        "url": present("url"),
        "state": present("state"),
        "isDraft": present("isDraft"),
        "repository": content.pointer("/repository/nameWithOwner").cloned(),
        "assignees": logins("/assignees/nodes", "login"),
        "labels": logins("/labels/nodes", "name"),
        "values": values,
        "updatedAt": text(node, "/updatedAt"),
    }))
}

const LAYOUTS: [&str; 3] = ["TABLE_LAYOUT", "BOARD_LAYOUT", "ROADMAP_LAYOUT"];

/// The view to show: the one asked for, else the first table, else a roadmap, else a board.
fn choose<'a>(views: &'a [Value], wanted: Option<&str>) -> Option<&'a Value> {
    let layout = |layout: &str| views.iter().find(|view| text(view, "/layout") == layout);
    match wanted {
        Some(id) => views.iter().find(|view| text(view, "/id") == id),
        None => layout("TABLE_LAYOUT")
            .or_else(|| layout("ROADMAP_LAYOUT"))
            .or_else(|| layout("BOARD_LAYOUT")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ViewRequest {
    owner: String,
    /// `organization` or `user`.
    owner_type: String,
    number: u64,
    view_id: Option<String>,
    /// Replaces the view's own filter for this read (an empty one shows every item).
    query: Option<String>,
}

pub(super) async fn view(center: &Center<'_>, request: ViewRequest) -> Result<Reply, Fault> {
    let root = if request.owner_type == "organization" {
        "organization"
    } else {
        "user"
    };
    let number = request.number.to_string();
    let config = graphql(
        center,
        &format!(
            "query($owner: String!, $num: Int!) {{ {root}(login: $owner) {{ projectV2(number: $num) {{ id title url \
             views(first: {VIEWS_PAGE}) {{ nodes {{ id number name layout filter \
             fields(first: {FIELDS_PAGE}) {{ nodes {{ ...FieldConfig }} }} \
             groupByFields(first: 10) {{ nodes {{ ...FieldConfig }} }} \
             sortByFields(first: 10) {{ nodes {{ direction field {{ ...FieldConfig }} }} }} }} }} }} }} }} {FIELD_CONFIG}"
        ),
        &[("owner", Var::Text(&request.owner)), ("num", Var::Number(number.clone()))],
    )
    .await?;
    let project = config
        .pointer(&format!("/{root}/projectV2"))
        .filter(|project| !project.is_null())
        .ok_or_else(|| Fault::new("github_failed", "Project not found"))?;
    let views = json::rows(project.get("views").unwrap_or(&Value::Null), "nodes");
    let chosen = choose(views, request.view_id.as_deref())
        .ok_or_else(|| Fault::new("github_failed", "Could not find the selected view"))?;
    let filter = request
        .query
        .clone()
        .unwrap_or_else(|| text(chosen, "/filter"));
    let items_query = format!(
        "query($owner: String!, $num: Int!, $q: String!, $after: String) {{ {root}(login: $owner) {{ projectV2(number: $num) {{ \
         items(first: {ITEMS_PAGE}, after: $after, query: $q, orderBy: {{ field: POSITION, direction: ASC }}) {{ \
         totalCount pageInfo {{ hasNextPage endCursor }} nodes {{ id type updatedAt \
         content {{ __typename \
           ... on Issue {{ number title url state repository {{ nameWithOwner }} \
                assignees(first: 5) {{ nodes {{ login }} }} labels(first: 10) {{ nodes {{ name }} }} }} \
           ... on PullRequest {{ number title url state isDraft repository {{ nameWithOwner }} \
                assignees(first: 5) {{ nodes {{ login }} }} labels(first: 10) {{ nodes {{ name }} }} }} \
           ... on DraftIssue {{ title body }} }} \
         fieldValues(first: 100) {{ nodes {{ __typename \
           ... on ProjectV2ItemFieldSingleSelectValue {{ field {{ ... on ProjectV2FieldCommon {{ id }} }} name color optionId }} \
           ... on ProjectV2ItemFieldIterationValue {{ field {{ ... on ProjectV2FieldCommon {{ id }} }} title startDate duration iterationId }} \
           ... on ProjectV2ItemFieldTextValue {{ field {{ ... on ProjectV2FieldCommon {{ id }} }} text }} \
           ... on ProjectV2ItemFieldNumberValue {{ field {{ ... on ProjectV2FieldCommon {{ id }} }} number }} \
           ... on ProjectV2ItemFieldDateValue {{ field {{ ... on ProjectV2FieldCommon {{ id }} }} date }} \
           ... on ProjectV2ItemFieldLabelValue {{ field {{ ... on ProjectV2FieldCommon {{ id }} }} labels(first: 10) {{ nodes {{ name }} }} }} \
           ... on ProjectV2ItemFieldUserValue {{ field {{ ... on ProjectV2FieldCommon {{ id }} }} users(first: 5) {{ nodes {{ login }} }} }} \
         }} }} }} }} }} }} }}"
    );
    let layout = text(chosen, "/layout");
    let mut rows = Vec::new();
    let mut cursor: Option<String> = None;
    let mut total: u64;
    loop {
        let page = {
            let mut vars = vec![
                ("owner", Var::Text(&request.owner)),
                ("num", Var::Number(number.clone())),
                ("q", Var::Text(&filter)),
            ];
            if let Some(after) = &cursor {
                vars.push(("after", Var::Text(after)));
            }
            graphql(center, &items_query, &vars).await?
        };
        let items = page
            .pointer(&format!("/{root}/projectV2/items"))
            .cloned()
            .unwrap_or(Value::Null);
        total = items.get("totalCount").and_then(Value::as_u64).unwrap_or(0);
        // A layout this page does not draw, or more items than it reads: said with the count, nothing read on.
        if !LAYOUTS.contains(&layout.as_str()) {
            let name = layout.trim_end_matches("_LAYOUT").to_ascii_lowercase();
            return Err(Fault::new(
                "project_unsupported",
                format!(
                    "This is a {name} view with {total} items; table, board and roadmap views show here"
                ),
            ));
        }
        if total > ITEMS_MAX {
            return Err(Fault::new(
                "project_too_large",
                format!(
                    "This view has {total} items; narrow it with a filter to {ITEMS_MAX} or fewer"
                ),
            ));
        }
        rows.extend(json::rows(&items, "nodes").iter().filter_map(row));
        let next = items.pointer("/pageInfo/hasNextPage") == Some(&Value::Bool(true));
        match items.pointer("/pageInfo/endCursor").and_then(Value::as_str) {
            Some(end) if next && cursor.as_deref() != Some(end) => cursor = Some(end.to_owned()),
            _ => break,
        }
    }
    let summary = |view: &Value| {
        json!({ "id": text(view, "/id"), "number": view.get("number").cloned().unwrap_or(Value::Null),
                "name": text(view, "/name"), "layout": text(view, "/layout") })
    };
    Reply::json(&json!({
        "project": { "id": text(project, "/id"), "title": text(project, "/title"), "url": text(project, "/url"),
                     "owner": request.owner, "ownerType": root, "number": request.number },
        "views": views.iter().map(summary).collect::<Vec<_>>(),
        "view": {
            "id": text(chosen, "/id"), "name": text(chosen, "/name"), "layout": layout, "filter": text(chosen, "/filter"),
            "fields": fields(json::rows(chosen.get("fields").unwrap_or(&Value::Null), "nodes")),
            "groupBy": fields(json::rows(chosen.get("groupByFields").unwrap_or(&Value::Null), "nodes")),
            "sortBy": json::rows(chosen.get("sortByFields").unwrap_or(&Value::Null), "nodes").iter()
                .filter_map(|sort| Some(json!({ "direction": text(sort, "/direction"), "field": field(sort.get("field")?)? })))
                .collect::<Vec<_>>(),
        },
        "rows": rows,
        "totalCount": total,
    }))
}

/// A field's new value on an item (Orca `GitHubProjectFieldMutationValue`).
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(super) enum FieldValue {
    SingleSelect { option_id: String },
    Iteration { iteration_id: String },
    Text { text: String },
    Number { number: f64 },
    Date { date: String },
}

pub(super) async fn set_field(
    center: &Center<'_>,
    project_id: &str,
    item_id: &str,
    field_id: &str,
    value: Option<FieldValue>,
) -> Result<Reply, Fault> {
    let ids = [
        ("projectId", Var::Text(project_id)),
        ("itemId", Var::Text(item_id)),
        ("fieldId", Var::Text(field_id)),
    ];
    let Some(value) = value else {
        graphql(
            center,
            "mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) { clearProjectV2ItemFieldValue(input: { \
             projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) { projectV2Item { id } } }",
            &ids,
        )
        .await?;
        return Reply::json(&json!({ "ok": true }));
    };
    let (input, kind, var) = match &value {
        FieldValue::SingleSelect { option_id } => {
            ("singleSelectOptionId", "String!", Var::Text(option_id))
        }
        FieldValue::Iteration { iteration_id } => {
            ("iterationId", "String!", Var::Text(iteration_id))
        }
        FieldValue::Text { text } => ("text", "String!", Var::Text(text)),
        FieldValue::Number { number } => ("number", "Float!", Var::Number(number.to_string())),
        FieldValue::Date { date } => ("date", "Date!", Var::Text(date)),
    };
    let mut vars: Vec<(&str, Var<'_>)> = ids.into_iter().collect();
    vars.push(("value", var));
    graphql(
        center,
        &format!(
            "mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: {kind}) {{ updateProjectV2ItemFieldValue(input: {{ \
             projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: {{ {input}: $value }} }}) {{ projectV2Item {{ id }} }} }}"
        ),
        &vars,
    )
    .await?;
    Reply::json(&json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_view_is_the_asked_one_else_a_table_then_a_roadmap_then_a_board() {
        let views = [
            json!({"id": "b", "layout": "BOARD_LAYOUT"}),
            json!({"id": "r", "layout": "ROADMAP_LAYOUT"}),
            json!({"id": "t", "layout": "TABLE_LAYOUT"}),
        ];
        assert_eq!(text(choose(&views, None).unwrap(), "/id"), "t");
        assert_eq!(text(choose(&views[..2], None).unwrap(), "/id"), "r");
        assert_eq!(text(choose(&views[..1], None).unwrap(), "/id"), "b");
        assert_eq!(text(choose(&views, Some("b")).unwrap(), "/id"), "b");
        assert!(choose(&views, Some("gone")).is_none());
    }

    #[test]
    fn an_item_keeps_each_value_by_its_field() {
        let node = json!({"id": "PVTI_1", "type": "ISSUE", "updatedAt": "2026-11-26T00:00:00Z",
        "content": {"number": 5, "title": "Fix", "url": "https://github.com/o/r/issues/5", "state": "OPEN",
            "repository": {"nameWithOwner": "o/r"}, "assignees": {"nodes": [{"login": "jin"}]},
            "labels": {"nodes": [{"name": "bug"}]}},
        "fieldValues": {"nodes": [
            {"__typename": "ProjectV2ItemFieldSingleSelectValue", "field": {"id": "F1"}, "name": "Todo", "color": "GRAY", "optionId": "o1"},
            {"__typename": "ProjectV2ItemFieldNumberValue", "field": {"id": "F2"}, "number": 3},
            {"__typename": "ProjectV2ItemFieldRepositoryValue", "field": {"id": "F3"}},
            {"__typename": "ProjectV2ItemFieldTextValue", "field": {}, "text": "lost"}
        ]}});
        let row = row(&node).unwrap();
        assert_eq!(row["repository"], "o/r");
        assert_eq!(row["assignees"], json!(["jin"]));
        assert_eq!(row["values"]["F1"]["optionId"], "o1");
        assert_eq!(row["values"]["F2"]["number"], 3);
        assert_eq!(row["values"].as_object().map(Map::len), Some(2));
    }

    #[test]
    fn a_field_carries_its_options_and_every_iteration() {
        let select = field(&json!({"__typename": "ProjectV2SingleSelectField", "id": "S", "name": "Status",
            "dataType": "SINGLE_SELECT", "options": [{"id": "o", "name": "Done", "color": "GREEN"}]}))
        .unwrap();
        assert_eq!(select["kind"], "single-select");
        assert_eq!(select["options"][0]["name"], "Done");
        let iteration = field(&json!({"__typename": "ProjectV2IterationField", "id": "I", "name": "Sprint",
            "dataType": "ITERATION", "configuration": {"iterations": [{"id": "a"}], "completedIterations": [{"id": "b"}]}}))
        .unwrap();
        assert_eq!(iteration["iterations"].as_array().map(Vec::len), Some(2));
        assert!(field(&json!({"name": "no id"})).is_none());
    }
}
