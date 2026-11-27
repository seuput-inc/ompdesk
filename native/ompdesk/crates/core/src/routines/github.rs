//! A GitHub trigger's reads and rules (was `src/main/routines/github.ts` but its poll timer): one read of one kind of
//! event asks GitHub with the person's own `gh api`, tells the rows not seen before from those seen, and answers one
//! line per new event (oldest first, at most `EVENTS_PER_POLL`) with where the trigger stands now.
//!
//! - `pull_request`: pull requests opened (`repos/<repo>/pulls`, newest 20),
//! - `issue`: issues opened, pull requests left out (`repos/<repo>/issues`, newest 20),
//! - `ci_failure`: workflow runs that concluded `failure` (`repos/<repo>/actions/runs?status=failure`, newest 20),
//! - `release`: releases published, drafts left out (`repos/<repo>/releases`, newest 10),
//! - `push`: commits new on the default branch (`repos/<repo>/commits`, newest 20).
//!
//! The first answer of a kind only records what exists. Main keeps the state between reads as this module returns it
//! (`State`, opaque to main) and saves the mark (`State::mark`, the JSON the TypeScript kept in `routine-marks.json`);
//! a launch's first read restores the mark as the TypeScript's `#restore` did. The rows are read as JavaScript read
//! GitHub's JSON: a field is whatever came, `??`, `||` and `${…}` as JavaScript spells them, `null` read through as a
//! `TypeError` in V8's words.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::connectors;
use super::text::{clip, describe_commits};
use crate::control::js::string_of_value;

const EVENTS_PER_POLL: usize = 10;
/// Ids remembered per kind: the endpoints list at most 20, a rerun or an edit may bring an old id back.
const SEEN_MAX: usize = 200;
const TITLE_CHARS: usize = 120;
/// What a field that JavaScript would have called a string method on answers when it is another type: V8's
/// `TypeError` named the bundle's minified variable, so its words were never stable.
const ANOTHER_TYPE: &str = "GitHub's answer has a field of another type";
const NOT_A_LIST: &str = "GitHub's answer was not a list";
/// `Object.prototype`'s own names: `kind in READERS` was true for each, so the TypeScript kept a mark's ids under them.
const PROTOTYPE_NAMES: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// One event kind a GitHub trigger follows. The kinds after Orca's GitHub triggers (FX1,
/// `shared/automation-event-triggers.ts:16-48`) that a `gh api` poll can see: a PR merged or closed unmerged, an
/// issue closed, a comment, a label added, a workflow run passed or finished.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    PullRequest,
    PrMerged,
    PrClosed,
    Issue,
    IssueClosed,
    Comment,
    Labeled,
    CiFailure,
    CiPassed,
    WorkflowFinished,
    Release,
    Push,
}

impl Kind {
    /// Every kind, in the order a trigger reads them.
    pub const ALL: [Kind; 12] = [
        Kind::PullRequest,
        Kind::PrMerged,
        Kind::PrClosed,
        Kind::Issue,
        Kind::IssueClosed,
        Kind::Comment,
        Kind::Labeled,
        Kind::CiFailure,
        Kind::CiPassed,
        Kind::WorkflowFinished,
        Kind::Release,
        Kind::Push,
    ];

    pub fn parse(name: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|kind| kind.name() == name)
    }

    pub(super) fn name(self) -> &'static str {
        match self {
            Kind::PullRequest => "pull_request",
            Kind::PrMerged => "pr_merged",
            Kind::PrClosed => "pr_closed",
            Kind::Issue => "issue",
            Kind::IssueClosed => "issue_closed",
            Kind::Comment => "comment",
            Kind::Labeled => "labeled",
            Kind::CiFailure => "ci_failure",
            Kind::CiPassed => "ci_passed",
            Kind::WorkflowFinished => "workflow_finished",
            Kind::Release => "release",
            Kind::Push => "push",
        }
    }

    fn endpoint(self, repo: &str) -> String {
        match self {
            Kind::PullRequest => {
                format!("repos/{repo}/pulls?state=all&sort=created&direction=desc&per_page=20")
            }
            Kind::PrMerged | Kind::PrClosed => {
                format!("repos/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=20")
            }
            Kind::Issue => {
                format!("repos/{repo}/issues?state=all&sort=created&direction=desc&per_page=20")
            }
            Kind::IssueClosed => {
                format!("repos/{repo}/issues?state=closed&sort=updated&direction=desc&per_page=20")
            }
            Kind::Comment => {
                format!("repos/{repo}/issues/comments?sort=created&direction=desc&per_page=20")
            }
            Kind::Labeled => format!("repos/{repo}/issues/events?per_page=30"),
            Kind::CiFailure => format!("repos/{repo}/actions/runs?status=failure&per_page=20"),
            Kind::CiPassed => format!("repos/{repo}/actions/runs?status=success&per_page=20"),
            Kind::WorkflowFinished => {
                format!("repos/{repo}/actions/runs?status=completed&per_page=20")
            }
            Kind::Release => format!("repos/{repo}/releases?per_page=10"),
            Kind::Push => format!("repos/{repo}"),
        }
    }
}

/// A GitHub trigger's filters (`ScheduleEvent` github `from`, `contains`, `label`): who did it, words in its title or
/// text, a label it carries or got. With `ask` (a bot's connector, `connectors.rs`) only an issue, a pull request or a
/// comment that says the bot's keyword starts a run, never the bot's own reply, and the run is told it as an ask.
#[derive(Default)]
pub struct Filters {
    from: Vec<String>,
    contains: Option<String>,
    label: Option<String>,
    ask: Option<String>,
    /// Who asked a bot's connector without being in `from`, since the last `take_refused`.
    refused: std::sync::Mutex<Vec<connectors::AccessAsk>>,
}

impl Filters {
    pub fn of(event: &Value) -> Filters {
        let text = |name: &str| {
            event
                .get(name)
                .and_then(Value::as_str)
                .map(|text| text.trim().to_lowercase())
                .filter(|text| !text.is_empty())
        };
        Filters {
            from: event
                .get("from")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_lowercase)
                .collect(),
            contains: text("contains"),
            label: text("label"),
            ask: text("ask").map(|handle| connectors::keyword(&handle)),
            refused: Default::default(),
        }
    }

    /// Who asked without being in `from` (a bot's connector only), each once, since the last call.
    pub fn take_refused(&self) -> Vec<connectors::AccessAsk> {
        std::mem::take(
            &mut *self
                .refused
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()),
        )
    }

    /// The line a bot's connector run is told of a new row it passed (`ask`): GitHub's place and link and where to
    /// reply, then who wrote it, its title and its text as someone's words.
    fn asked(&self, kind: Kind, repo: &str, row: Js<'_>) -> Option<String> {
        self.ask.as_ref()?;
        let text = |value: Js<'_>| match value {
            Js::Val(Value::String(text)) => text.clone(),
            _ => String::new(),
        };
        let (number, what, title) = match kind {
            Kind::Comment => {
                let on = text(optional(row, "issue_url"));
                let number = on.rsplit('/').next().unwrap_or_default().to_owned();
                (number, "a comment", String::new())
            }
            Kind::PullRequest => (
                nullish_template(optional(row, "number")),
                "a new pull request",
                text(optional(row, "title")),
            ),
            _ => (
                nullish_template(optional(row, "number")),
                "a new issue",
                text(optional(row, "title")),
            ),
        };
        let target = connectors::Target::Github {
            repo: repo.to_owned(),
            number: number.parse().ok()?,
        };
        let header = format!(
            "GitHub · {what} on {repo}#{number} · {} · reply with ompdesk_bot reply to {}",
            nullish_template(optional(row, "html_url")),
            target.handle()
        );
        let title = if title.is_empty() {
            String::new()
        } else {
            format!("Title: {title}\n")
        };
        let words = format!(
            "From: @{}\n{title}\n{}",
            who(optional(row, "user")),
            text(optional(row, "body"))
        );
        Some(connectors::asked(&header, &words))
    }

    /// Whether a new row (`line` what the run is told of it) passes.
    fn pass(&self, kind: Kind, row: Js<'_>, line: &str) -> bool {
        let login = |person: Js<'_>| match optional(person, "login") {
            Js::Val(Value::String(login)) => login.to_lowercase(),
            _ => String::new(),
        };
        let by = match kind {
            Kind::Labeled | Kind::CiFailure | Kind::CiPassed | Kind::WorkflowFinished => {
                login(optional(row, "actor"))
            }
            Kind::Release => login(optional(row, "author")),
            _ => login(optional(row, "user")),
        };
        let from = self.from.is_empty()
            || (kind != Kind::Push
                && (self.from.contains(&by) || self.from.iter().any(|f| f == "*")));
        let words = |key: &str| match optional(row, key) {
            Js::Val(Value::String(text)) => text.to_lowercase(),
            _ => String::new(),
        };
        let contains = self.contains.as_ref().is_none_or(|needle| {
            line.to_lowercase().contains(needle) || words("body").contains(needle)
        });
        let labels: Vec<String> = match kind {
            Kind::Labeled => vec![words_of(optional(optional(row, "label"), "name"))],
            _ => match optional(row, "labels") {
                Js::Val(Value::Array(labels)) => labels
                    .iter()
                    .map(|label| words_of(optional(Js::Val(label), "name")))
                    .collect(),
                _ => Vec::new(),
            },
        };
        let label = self
            .label
            .as_ref()
            .is_none_or(|wanted| labels.contains(wanted));
        // A bot's connector: an issue, pull request or comment that says its keyword, and never its own reply.
        let asked = self.ask.as_ref().is_none_or(|keyword| {
            matches!(kind, Kind::Issue | Kind::PullRequest | Kind::Comment)
                && (words("title").contains(keyword) || words("body").contains(keyword))
                && !words("body").contains(&connectors::REPLY_MARK.to_lowercase())
        });
        if self.ask.is_some() && asked && contains && label && !from && !by.is_empty() {
            let login = match optional(optional(row, "user"), "login") {
                Js::Val(Value::String(login)) => login.clone(),
                _ => by.clone(),
            };
            let what = match kind {
                Kind::Comment => "a comment",
                Kind::PullRequest => "a new pull request",
                _ => "a new issue",
            };
            let mut refused = self
                .refused
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            refused.push(connectors::AccessAsk {
                name: format!("@{login}"),
                person: login,
                place: format!("GitHub, {what}"),
                link: match optional(row, "html_url") {
                    Js::Val(Value::String(link)) => link.clone(),
                    _ => String::new(),
                },
            });
        }
        from && contains && label && asked
    }
}

/// A field's text, lowercase; empty for anything else.
fn words_of(value: Js<'_>) -> String {
    match value {
        Js::Val(Value::String(text)) => text.to_lowercase(),
        _ => String::new(),
    }
}

/// `gh api <endpoint>` as parsed JSON, or the words it failed with.
pub trait Api {
    fn get(&self, endpoint: &str) -> impl Future<Output = Result<Value, String>> + Send;
}

/// A row's id as the TypeScript's `Set` held it: a field that was absent is `undefined`, never equal to `null`.
#[derive(Clone, Serialize, Deserialize)]
enum Id {
    Undefined,
    Value(Value),
}

impl Id {
    fn of(value: Js<'_>) -> Id {
        match value {
            Js::Undefined => Id::Undefined,
            Js::Val(value) => Id::Value(value.clone()),
        }
    }

    /// `Set.prototype.has`: by value, an object or array never equal to another one.
    fn same(&self, other: &Id) -> bool {
        match (self, other) {
            (Id::Undefined, Id::Undefined) => true,
            (Id::Value(a), Id::Value(b)) => strict_equal(Js::Val(a), Js::Val(b)),
            _ => false,
        }
    }

    /// As `JSON.stringify` writes it in an array.
    fn json(&self) -> Value {
        match self {
            Id::Undefined => Value::Null,
            Id::Value(value) => value.clone(),
        }
    }
}

/// The default branch and its newest commit as last read: whatever GitHub gave, both truthy.
#[derive(Clone, Serialize, Deserialize)]
struct Head {
    branch: Value,
    sha: Value,
}

/// Where a GitHub trigger stands between two reads: the ids seen per row kind (in the order the kinds were first
/// read), the default branch's head.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct State {
    seen: Vec<(String, Vec<Id>)>,
    head: Option<Head>,
}

impl State {
    /// The mark the last launch saved, as far as it reads (it is JSON from disk): what `#restore` took of it.
    pub fn restore(mark: Option<&Value>) -> State {
        let mut state = State::default();
        let Some(mark) = mark.filter(|mark| is_object(mark)) else {
            return state;
        };
        if let Some(seen) = mark.get("seen").filter(|seen| is_object(seen)) {
            for (kind, ids) in entries(seen) {
                let known = Kind::parse(&kind).is_some_and(|kind| kind != Kind::Push)
                    || PROTOTYPE_NAMES.contains(&kind.as_str());
                let Some(ids) = ids.as_array().filter(|_| known) else {
                    continue;
                };
                let mut kept: Vec<Id> = Vec::new();
                for id in ids.iter().filter(|id| id.is_string() || id.is_number()) {
                    let id = Id::Value(id.clone());
                    if !kept.iter().any(|seen| seen.same(&id)) {
                        kept.push(id);
                    }
                }
                state.set_seen(&kind, kept);
            }
        }
        if let Some(Value::Object(head)) = mark.get("head")
            && let (Some(branch @ Value::String(_)), Some(sha @ Value::String(_))) =
                (head.get("branch"), head.get("sha"))
        {
            state.head = Some(Head {
                branch: branch.clone(),
                sha: sha.clone(),
            });
        }
        state
    }

    /// What it has seen, as the next launch reads it (`#mark`).
    pub fn mark(&self) -> Value {
        let seen: Map<String, Value> = self
            .seen
            .iter()
            .map(|(kind, ids)| (kind.clone(), ids.iter().map(Id::json).collect()))
            .collect();
        let mut mark = Map::new();
        mark.insert("seen".into(), Value::Object(seen));
        if let Some(head) = &self.head {
            let mut value = Map::new();
            value.insert("branch".into(), head.branch.clone());
            value.insert("sha".into(), head.sha.clone());
            mark.insert("head".into(), Value::Object(value));
        }
        Value::Object(mark)
    }

    fn set_seen(&mut self, kind: &str, ids: Vec<Id>) {
        match self.seen.iter_mut().find(|(name, _)| name == kind) {
            Some((_, seen)) => *seen = ids,
            None => self.seen.push((kind.to_owned(), ids)),
        }
    }
}

/// One read of `kind`: the lines of what is new since `state`, which it moves on. A failure leaves `state` where the
/// read had moved it before it failed, as the TypeScript's fields were.
pub async fn read(
    api: &impl Api,
    repo: &str,
    kind: Kind,
    state: &mut State,
) -> Result<Vec<String>, String> {
    read_with(api, repo, kind, state, &Filters::default()).await
}

/// `read`, keeping only the new rows that pass `filters`; a row passed over is seen all the same.
pub async fn read_with(
    api: &impl Api,
    repo: &str,
    kind: Kind,
    state: &mut State,
    filters: &Filters,
) -> Result<Vec<String>, String> {
    if kind == Kind::Push {
        let lines = read_push(api, repo, state).await?;
        return Ok(lines
            .into_iter()
            .filter(|line| filters.pass(kind, Js::Undefined, line))
            .collect());
    }
    let json = api.get(&kind.endpoint(repo)).await?;
    let mut rows = Vec::new();
    for row in rows_of(kind, &json)? {
        rows.push((Id::of(id_of(kind, row)?), describe(kind, row)?, row));
    }
    let Some((_, seen)) = state.seen.iter_mut().find(|(name, _)| name == kind.name()) else {
        let mut ids: Vec<Id> = Vec::new();
        for (id, _, _) in rows {
            if !ids.iter().any(|seen| seen.same(&id)) {
                ids.push(id);
            }
        }
        state.seen.push((kind.name().to_owned(), ids));
        return Ok(Vec::new());
    };
    // A bot's connector is told each passed row as an ask; a row that cannot be one (no number) starts nothing.
    let fresh: Vec<String> = rows
        .iter()
        .filter(|(id, line, row)| {
            !seen.iter().any(|known| known.same(id)) && filters.pass(kind, *row, line)
        })
        .filter_map(|(_, line, row)| match filters.ask {
            Some(_) => filters.asked(kind, repo, *row),
            None => Some(line.clone()),
        })
        .collect();
    for (id, _, _) in &rows {
        if !seen.iter().any(|known| known.same(id)) {
            seen.push(id.clone());
        }
    }
    if seen.len() > SEEN_MAX {
        seen.drain(..seen.len() - SEEN_MAX);
    }
    Ok(fresh.into_iter().take(EVENTS_PER_POLL).rev().collect())
}

/// One line for the new commits of the default branch, or none (first answer, a new default branch, no news).
async fn read_push(api: &impl Api, repo: &str, state: &mut State) -> Result<Vec<String>, String> {
    let info = api.get(&Kind::Push.endpoint(repo)).await?;
    let branch = optional(Js::Val(&info), "default_branch");
    if !truthy(branch) {
        return Err("GitHub named no default branch".into());
    }
    let branch_text = template(branch);
    let commits = api
        .get(&format!(
            "repos/{repo}/commits?sha={}&per_page=20",
            encode_uri_component(&branch_text)
        ))
        .await?;
    let commits = list(Js::Val(&commits))?;
    let newest = optional(commits.first().copied().unwrap_or(Js::Undefined), "sha");
    if !truthy(newest) {
        return Ok(Vec::new());
    }
    let Js::Val(branch) = branch else {
        unreachable!("a truthy value is defined")
    };
    let Js::Val(sha) = newest else {
        unreachable!("a truthy value is defined")
    };
    let before = state.head.replace(Head {
        branch: branch.clone(),
        sha: sha.clone(),
    });
    let Some(before) =
        before.filter(|before| strict_equal(Js::Val(&before.branch), Js::Val(branch)))
    else {
        return Ok(Vec::new());
    };
    let mut at = None;
    for (index, commit) in commits.iter().enumerate() {
        if strict_equal(property(*commit, "sha")?, Js::Val(&before.sha)) {
            at = Some(index);
            break;
        }
    }
    let fresh = &commits[..at.unwrap_or(commits.len())];
    if fresh.is_empty() {
        return Ok(Vec::new());
    }
    let mut lines = Vec::with_capacity(fresh.len());
    for commit in fresh {
        let sha = match property(*commit, "sha")? {
            Js::Val(Value::String(sha)) => utf16_prefix(sha, 7),
            missing @ (Js::Undefined | Js::Val(Value::Null)) => {
                return Err(type_error(missing, "slice"));
            }
            Js::Val(_) => return Err(ANOTHER_TYPE.into()),
        };
        let message = optional(property(*commit, "commit")?, "message");
        let subject = match message {
            Js::Undefined | Js::Val(Value::Null) => "",
            Js::Val(Value::String(message)) => message.split('\n').next().unwrap_or(""),
            Js::Val(_) => return Err(ANOTHER_TYPE.into()),
        };
        lines.push(format!("{sha} {subject}"));
    }
    Ok(vec![describe_commits(
        &format!("{branch_text} ({repo})"),
        fresh.len() as f64,
        &lines,
    )])
}

/// The rows of a kind's answer as its `rows` filter kept them.
fn rows_of(kind: Kind, json: &Value) -> Result<Vec<Js<'_>>, String> {
    let all = match kind {
        Kind::CiFailure | Kind::CiPassed | Kind::WorkflowFinished => {
            list(optional(Js::Val(json), "workflow_runs"))?
        }
        _ => list(Js::Val(json))?,
    };
    let mut rows = Vec::with_capacity(all.len());
    for row in all {
        let concluded = |wanted: &str| -> Result<bool, String> {
            Ok(match property(row, "conclusion")? {
                Js::Undefined => true,
                Js::Val(conclusion) => conclusion.as_str() == Some(wanted),
            })
        };
        let keep = match kind {
            Kind::Issue | Kind::IssueClosed => {
                matches!(property(row, "pull_request")?, Js::Undefined)
            }
            Kind::CiFailure => concluded("failure")?,
            Kind::CiPassed => concluded("success")?,
            Kind::Release => !matches!(property(row, "draft")?, Js::Val(Value::Bool(true))),
            Kind::PrMerged => truthy(property(row, "merged_at")?),
            Kind::PrClosed => !truthy(property(row, "merged_at")?),
            Kind::Labeled => {
                matches!(property(row, "event")?, Js::Val(Value::String(event)) if event == "labeled")
            }
            Kind::PullRequest | Kind::Comment | Kind::WorkflowFinished | Kind::Push => true,
        };
        if keep {
            rows.push(row);
        }
    }
    Ok(rows)
}

fn id_of(kind: Kind, row: Js<'_>) -> Result<Js<'_>, String> {
    match kind {
        Kind::PullRequest | Kind::Issue | Kind::PrMerged | Kind::PrClosed | Kind::IssueClosed => {
            property(row, "number")
        }
        _ => property(row, "id"),
    }
}

/// The line of a kind the TypeScript never read (FX1): fields read leniently, as none of them names a row.
fn describe_more(kind: Kind, row: Js<'_>) -> String {
    let text = |value: Js<'_>, chars: usize| match value {
        Js::Val(Value::String(text)) => clip(text, chars),
        _ => String::new(),
    };
    let field = |key: &str| optional(row, key);
    let url = nullish_template(field("html_url"));
    match kind {
        Kind::PrMerged | Kind::PrClosed | Kind::IssueClosed => {
            let what = if kind == Kind::IssueClosed {
                "Issue"
            } else {
                "PR"
            };
            let done = match kind {
                Kind::PrMerged => "merged",
                Kind::PrClosed => "closed without merging",
                _ => "closed",
            };
            let number = nullish_template(field("number"));
            let title = text(field("title"), TITLE_CHARS);
            format!(
                "{what} #{number} \"{title}\" by {} {done}: {url}",
                who(field("user"))
            )
        }
        Kind::Comment => {
            // `issue_url` ends in the issue's (or the PR's) number.
            let on = text(field("issue_url"), 400);
            let number = on.rsplit('/').next().unwrap_or_default();
            let said = text(field("body"), 200);
            format!(
                "Comment by {} on #{number}: \"{said}\": {url}",
                who(field("user"))
            )
        }
        Kind::Labeled => {
            let issue = field("issue");
            let label = text(optional(optional(row, "label"), "name"), 80);
            let number = nullish_template(optional(issue, "number"));
            let title = text(optional(issue, "title"), TITLE_CHARS);
            let url = nullish_template(optional(issue, "html_url"));
            format!(
                "Label \"{label}\" added to #{number} \"{title}\" by {}: {url}",
                who(field("actor"))
            )
        }
        _ => {
            let name = text(field("name"), 80);
            let title = text(field("display_title"), TITLE_CHARS);
            let branch = match field("head_branch") {
                branch if truthy(branch) => template(branch),
                _ => "an unknown branch".into(),
            };
            if kind == Kind::CiPassed {
                format!("CI passed: workflow \"{name}\" on {branch} (\"{title}\"): {url}")
            } else {
                let conclusion = nullish_template(field("conclusion"));
                format!(
                    "Workflow \"{name}\" finished ({conclusion}) on {branch} (\"{title}\"): {url}"
                )
            }
        }
    }
}

fn describe(kind: Kind, row: Js<'_>) -> Result<String, String> {
    let field = |key: &str| property(row, key);
    Ok(match kind {
        Kind::PullRequest | Kind::Issue => {
            let what = if kind == Kind::Issue { "Issue" } else { "PR" };
            let number = template(field("number")?);
            let title = clip(text_or_empty(field("title")?)?, TITLE_CHARS);
            let who = who(field("user")?);
            let url = nullish_template(field("html_url")?);
            format!("{what} #{number} \"{title}\" opened by {who}: {url}")
        }
        Kind::CiFailure => {
            let title = clip(text_or_empty(field("display_title")?)?, TITLE_CHARS);
            let name = clip(text_or_empty(field("name")?)?, 80);
            let branch = match field("head_branch")? {
                branch if truthy(branch) => template(branch),
                _ => "an unknown branch".into(),
            };
            let title = if title.is_empty() {
                String::new()
            } else {
                format!(" (\"{title}\")")
            };
            let url = nullish_template(field("html_url")?);
            format!("CI failure: workflow \"{name}\" on {branch}{title}: {url}")
        }
        Kind::Release => {
            let tag = field("tag_name")?;
            let tag = match tag {
                Js::Undefined | Js::Val(Value::Null) => Js::Val(&EMPTY),
                tag => tag,
            };
            let name = clip(text_or_empty(field("name")?)?, TITLE_CHARS);
            let named = if !name.is_empty()
                && !matches!(tag, Js::Val(Value::String(tag)) if *tag == name)
            {
                format!(" \"{name}\"")
            } else {
                String::new()
            };
            let who = who(field("author")?);
            let url = nullish_template(field("html_url")?);
            format!("Release {}{named} published by {who}: {url}", template(tag))
        }
        Kind::Push => unreachable!("push is read by commit order"),
        _ => describe_more(kind, row),
    })
}

static EMPTY: Value = Value::String(String::new());

/// `person?.login || "someone"`.
fn who(person: Js<'_>) -> String {
    match optional(person, "login") {
        login if truthy(login) => template(login),
        _ => "someone".into(),
    }
}

/// A value as JavaScript held it: `undefined` where a field was absent.
#[derive(Clone, Copy)]
enum Js<'a> {
    Undefined,
    Val(&'a Value),
}

/// `value.key`: `undefined` where it has none, V8's `TypeError` on `null` and `undefined`.
fn property<'a>(value: Js<'a>, key: &str) -> Result<Js<'a>, String> {
    match value {
        Js::Undefined | Js::Val(Value::Null) => Err(type_error(value, key)),
        value => Ok(optional(value, key)),
    }
}

/// `value?.key`.
fn optional<'a>(value: Js<'a>, key: &str) -> Js<'a> {
    match value {
        Js::Val(Value::Object(fields)) => fields.get(key).map_or(Js::Undefined, Js::Val),
        _ => Js::Undefined,
    }
}

fn type_error(value: Js<'_>, key: &str) -> String {
    let what = if matches!(value, Js::Undefined) {
        "undefined"
    } else {
        "null"
    };
    format!("Cannot read properties of {what} (reading '{key}')")
}

/// `array(json)`: the answer's items, or `GitHub's answer was not a list`.
fn list(value: Js<'_>) -> Result<Vec<Js<'_>>, String> {
    match value {
        Js::Val(Value::Array(items)) => Ok(items.iter().map(Js::Val).collect()),
        _ => Err(NOT_A_LIST.into()),
    }
}

/// `value ?? ""` handed to `clip`, which needs a string.
fn text_or_empty(value: Js<'_>) -> Result<&str, String> {
    match value {
        Js::Undefined | Js::Val(Value::Null) => Ok(""),
        Js::Val(Value::String(text)) => Ok(text),
        Js::Val(_) => Err(ANOTHER_TYPE.into()),
    }
}

/// `${value ?? ""}`.
fn nullish_template(value: Js<'_>) -> String {
    match value {
        Js::Undefined | Js::Val(Value::Null) => String::new(),
        value => template(value),
    }
}

/// `${value}`.
fn template(value: Js<'_>) -> String {
    match value {
        Js::Undefined => "undefined".into(),
        Js::Val(value) => string_of_value(value),
    }
}

fn truthy(value: Js<'_>) -> bool {
    match value {
        Js::Undefined | Js::Val(Value::Null) => false,
        Js::Val(Value::Bool(flag)) => *flag,
        Js::Val(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Js::Val(Value::String(text)) => !text.is_empty(),
        Js::Val(_) => true,
    }
}

/// `===` over values parsed from JSON: an object or an array is equal to no other one.
fn strict_equal(a: Js<'_>, b: Js<'_>) -> bool {
    match (a, b) {
        (Js::Undefined, Js::Undefined) => true,
        (Js::Val(a), Js::Val(b)) => match (a, b) {
            (Value::Null, Value::Null) => true,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
            (Value::String(a), Value::String(b)) => a == b,
            _ => false,
        },
        _ => false,
    }
}

/// `typeof value === "object" && value !== null`.
fn is_object(value: &Value) -> bool {
    matches!(value, Value::Object(_) | Value::Array(_))
}

/// `Object.entries(value)` of an object or an array.
fn entries(value: &Value) -> Vec<(String, &Value)> {
    match value {
        Value::Object(fields) => fields.iter().map(|(k, v)| (k.clone(), v)).collect(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, item)| (index.to_string(), item))
            .collect(),
        _ => Vec::new(),
    }
}

/// `text.slice(0, units)`: UTF-16 units, half a surrogate pair read as U+FFFD.
fn utf16_prefix(text: &str, units: usize) -> String {
    let head: Vec<u16> = text.encode_utf16().take(units).collect();
    String::from_utf16_lossy(&head)
}

/// `encodeURIComponent`.
pub(crate) fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;
    use crate::routines::captured;

    /// The answers of one step, and every endpoint asked.
    struct Fake {
        answers: Map<String, Value>,
        calls: Mutex<Vec<String>>,
    }

    impl Api for Fake {
        fn get(&self, endpoint: &str) -> impl Future<Output = Result<Value, String>> + Send {
            self.calls.lock().unwrap().push(endpoint.to_owned());
            let mut keys: Vec<&String> = self.answers.keys().collect();
            keys.sort_by_key(|key| std::cmp::Reverse(key.len()));
            let answer = match keys
                .into_iter()
                .find(|key| endpoint.starts_with(key.as_str()))
            {
                None => Err(format!("gh: HTTP 404: Not Found ({endpoint})")),
                Some(key) => match &self.answers[key] {
                    Value::Object(error) if error.contains_key("__error") => {
                        Err(error["__error"].as_str().unwrap().to_owned())
                    }
                    answer => Ok(answer.clone()),
                },
            };
            std::future::ready(answer)
        }
    }

    /// Replays each captured scenario as the TypeScript source ran it (each kind in `GITHUB_EVENT_KINDS`'s order; a
    /// read's mark saved and its lines fired; a failure told once per distinct message per kind) and compares what it
    /// did, step by step.
    #[tokio::test]
    async fn reads_every_captured_scenario_as_the_typescript_did() {
        const ORDER: [&str; 5] = ["pull_request", "issue", "ci_failure", "release", "push"];
        let scenarios = captured("github");
        assert_eq!(scenarios.len(), 19);
        for scenario in scenarios {
            let name = scenario["name"].as_str().unwrap();
            let repo = scenario["repo"].as_str().unwrap();
            let events: Vec<&str> = scenario["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|event| event.as_str().unwrap())
                .collect();
            let kinds: Vec<Kind> = ORDER
                .iter()
                .filter(|kind| events.contains(kind))
                .map(|kind| Kind::parse(kind).unwrap())
                .collect();
            let mut state = State::restore(scenario.get("mark"));
            let mut told: HashMap<&str, String> = HashMap::new();
            for (index, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
                let fake = Fake {
                    answers: step["answers"].as_object().unwrap().clone(),
                    calls: Mutex::new(Vec::new()),
                };
                let mut log = Vec::new();
                for kind in &kinds {
                    let before = fake.calls.lock().unwrap().len();
                    let outcome = read(&fake, repo, *kind, &mut state).await;
                    for call in &fake.calls.lock().unwrap()[before..] {
                        log.push(json!({ "call": call }));
                    }
                    match outcome {
                        Ok(lines) => {
                            told.remove(kind.name());
                            log.push(json!({ "save": state.mark() }));
                            for line in lines {
                                log.push(json!({ "fire": line }));
                            }
                        }
                        Err(message) => {
                            if told.get(kind.name()) != Some(&message) {
                                log.push(json!({
                                    "warn": format!("github {repo}: {}: {message}", kind.name())
                                }));
                                told.insert(kind.name(), message);
                            }
                        }
                    }
                }
                assert_eq!(Value::Array(log), step["log"], "{name}, step {index}");
            }
        }
    }

    #[test]
    fn keeps_an_absent_id_apart_from_null_between_reads() {
        let state = State {
            seen: vec![("issue".into(), vec![Id::Undefined])],
            head: None,
        };
        let text = serde_json::to_string(&state).unwrap();
        let back: State = serde_json::from_str(&text).unwrap();
        assert!(back.seen[0].1[0].same(&Id::Undefined));
        assert!(!back.seen[0].1[0].same(&Id::Value(Value::Null)));
        assert_eq!(back.mark(), json!({ "seen": { "issue": [null] } }));
    }

    #[test]
    fn encodes_a_branch_as_encode_uri_component_did() {
        assert_eq!(
            encode_uri_component("feat/x y&z?ü"),
            "feat%2Fx%20y%26z%3F%C3%BC"
        );
        assert_eq!(encode_uri_component("!'()*~-_.%"), "!'()*~-_.%25");
        assert_eq!(utf16_prefix("😀😀😀😀", 7), "😀😀😀\u{fffd}");
    }

    #[test]
    fn reads_the_kinds_orca_follows_and_filters_them() {
        let pulls = json!([
            {"number": 7, "title": "Fix build", "user": {"login": "ann"}, "merged_at": "2026-11-01T00:00:00Z",
             "html_url": "u7", "labels": [{"name": "Bug"}], "body": "It broke"},
            {"number": 8, "title": "Drop it", "user": {"login": "bob"}, "merged_at": null, "html_url": "u8", "labels": []}
        ]);
        let merged = rows_of(Kind::PrMerged, &pulls).unwrap();
        assert_eq!(merged.len(), 1);
        let line = describe(Kind::PrMerged, merged[0]).unwrap();
        assert_eq!(line, "PR #7 \"Fix build\" by ann merged: u7");
        let closed = rows_of(Kind::PrClosed, &pulls).unwrap();
        assert_eq!(
            describe(Kind::PrClosed, closed[0]).unwrap(),
            "PR #8 \"Drop it\" by bob closed without merging: u8"
        );
        let all = Filters::of(&json!({"from": ["Ann"], "label": "bug", "contains": "BROKE"}));
        assert!(all.pass(Kind::PrMerged, merged[0], &line));
        assert!(!Filters::of(&json!({"from": ["bob"]})).pass(Kind::PrMerged, merged[0], &line));
        assert!(!Filters::of(&json!({"label": "ui"})).pass(Kind::PrMerged, merged[0], &line));
        assert!(!Filters::of(&json!({"contains": "flaky"})).pass(Kind::PrMerged, merged[0], &line));
        let events = json!([
            {"id": 1, "event": "labeled", "label": {"name": "urgent"}, "actor": {"login": "cy"},
             "issue": {"number": 3, "title": "Crash", "html_url": "u3"}},
            {"id": 2, "event": "closed"}
        ]);
        let labeled = rows_of(Kind::Labeled, &events).unwrap();
        assert_eq!(labeled.len(), 1);
        assert_eq!(
            describe(Kind::Labeled, labeled[0]).unwrap(),
            "Label \"urgent\" added to #3 \"Crash\" by cy: u3"
        );
        assert!(
            Filters::of(&json!({"label": "Urgent", "from": ["cy"]})).pass(
                Kind::Labeled,
                labeled[0],
                ""
            )
        );
        let comments = json!([{"id": 9, "issue_url": "https://api.github.com/repos/o/r/issues/12", "body": "LGTM",
            "user": {"login": "dee"}, "html_url": "c9"}]);
        let comment = rows_of(Kind::Comment, &comments).unwrap();
        assert_eq!(
            describe(Kind::Comment, comment[0]).unwrap(),
            "Comment by dee on #12: \"LGTM\": c9"
        );
        let runs = json!({"workflow_runs": [
            {"id": 5, "name": "CI", "display_title": "Fix", "head_branch": "main", "conclusion": "success", "html_url": "r5"},
            {"id": 6, "name": "CI", "display_title": "Oops", "head_branch": "main", "conclusion": "failure", "html_url": "r6"}
        ]});
        let passed = rows_of(Kind::CiPassed, &runs).unwrap();
        assert_eq!(passed.len(), 1);
        assert_eq!(
            describe(Kind::CiPassed, passed[0]).unwrap(),
            "CI passed: workflow \"CI\" on main (\"Fix\"): r5"
        );
        assert_eq!(rows_of(Kind::WorkflowFinished, &runs).unwrap().len(), 2);
        for kind in Kind::ALL {
            assert_eq!(Kind::parse(kind.name()), Some(kind));
        }
    }

    #[test]
    fn a_bots_connector_takes_only_asks_by_keyword_and_quotes_them() {
        let filters = Filters::of(&json!({"ask": "Helper", "from": ["ann"]}));
        let comments = json!([
            {"id": 1, "issue_url": "https://api.github.com/repos/o/r/issues/12", "body": "BOT:helper look at this",
             "user": {"login": "Ann"}, "html_url": "c1"},
            {"id": 2, "issue_url": "https://api.github.com/repos/o/r/issues/12", "body": "no keyword",
             "user": {"login": "ann"}, "html_url": "c2"},
            {"id": 3, "issue_url": "https://api.github.com/repos/o/r/issues/12", "body": "Done bot:helper\n\n— Helper, via OMPdesk",
             "user": {"login": "ann"}, "html_url": "c3"},
            {"id": 4, "issue_url": "https://api.github.com/repos/o/r/issues/12", "body": "bot:helper hi",
             "user": {"login": "eve"}, "html_url": "c4"}
        ]);
        let rows = rows_of(Kind::Comment, &comments).unwrap();
        let passed: Vec<bool> = rows
            .iter()
            .map(|row| filters.pass(Kind::Comment, *row, ""))
            .collect();
        assert_eq!(passed, [true, false, false, false]);
        // Eve, not listed, asked: the owner is asked to let her in; Ann's own words and replies ask nothing.
        assert_eq!(
            filters.take_refused(),
            [connectors::AccessAsk {
                person: "eve".into(),
                name: "@eve".into(),
                place: "GitHub, a comment".into(),
                link: "c4".into(),
            }]
        );
        assert!(filters.take_refused().is_empty());
        let line = filters.asked(Kind::Comment, "o/r", rows[0]).expect("asked");
        let (header, words) = connectors::split(&line).expect("split");
        assert_eq!(
            header,
            "GitHub · a comment on o/r#12 · c1 · reply with ompdesk_bot reply to github:o/r#12"
        );
        assert_eq!(words, "From: @Ann\n\nBOT:helper look at this");
        // A labeled event is no ask, and anyone is `*`.
        let anyone = Filters::of(&json!({"ask": "helper", "from": ["*"]}));
        assert!(anyone.pass(Kind::Comment, rows[3], ""));
        assert!(!anyone.pass(Kind::Labeled, rows[3], ""));
        assert_eq!(
            Filters::default().asked(Kind::Comment, "o/r", rows[0]),
            None
        );
    }
}
