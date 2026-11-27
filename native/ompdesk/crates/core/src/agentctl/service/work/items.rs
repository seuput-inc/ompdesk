//! A bot's items (`ompdesk_item` from a bot's chat, the owner's `BotsRequest` `item`): what the bot works on and what
//! it needs from its owner (Orca's bot items, re-implemented; control-tools.md › Bots, items and rooms).
//!
//! - The owner's change raises `version`, records an event and is mailed once to the item's chat, named
//!   `item-<id>-v<version>` (a repeat of one change is one mail). An answer to the item's question starts a turn there
//!   (the chat is reached as a routine's wake-up reaches it); any other change is a quiet note kept until the chat
//!   opens. A change that changes nothing, a snooze alone (the item keeps its status), or one to an item that is gone
//!   mails nothing and asks nothing. Several items changed at once (`ids`) are one mail per chat.
//! - A comment or an answer the owner sends carries a request id: the same request again changes nothing (Orca's
//!   `use-bot-item-pending-comments.ts`). An answer names the question it answers; when the bot has asked another one
//!   since, the change is refused as `question_changed` and nothing is written.
//! - Every event says what it was: a status its old status and note, an edit its field before and after, a linked
//!   session's report (`worker`) its first line (Orca's `BotItemActivityList.tsx`).
//! - Read when listed: `stale` (Orca's `isBotItemStale`: Needs you untouched for its bot's `staleDays`, In progress or
//!   Waiting with no live linked session for as long, Planned for three times that; never while snoozed), each linked
//!   session's `state`, and `limitUntil` (every live linked session waits for a usage limit: the earliest reset).
//! - A closed item adds one line to `<bot folder>/memory/journal/YYYY-MM.md`.

use std::io::Write as _;
use std::path::Path;

use serde_json::Value;

use super::super::AgentControl;
use super::super::fail::{Fail, R, fail};
use super::super::host::HostState;
use super::super::types::{ControlTab, ItemArgs, TabStatus};
use super::bots::new_id;
use crate::agentctl::journal::bots::BotRecord;
use crate::agentctl::journal::items::{
    DECISIONS_MAX, ItemDecision, ItemLink, ItemQuestion, ItemRecord, ItemWait, STATUSES, is_open,
    parse_iso,
};
use crate::agentctl::rules::mail::{Mail, MailKind};
use crate::aimemory::value::iso;

/// An item's title, at most.
pub const TITLE_MAX: usize = 200;
/// An item's description, at most.
pub const DESCRIPTION_MAX: usize = 20_000;
/// A comment, a note or a question, at most.
pub const TEXT_MAX: usize = 8_000;
/// What a Waiting item waits on, at most: one line (Orca's `BOT_ITEM_LIMITS.wait`).
pub const WAIT_MAX: usize = 200;
/// One question of several, at most (Orca's `BOT_ITEM_ASK_LIMITS.prompt`).
const DECISION_MAX: usize = 500;
/// Quick replies one question takes, at most.
const OPTIONS_MAX: usize = 8;
/// The owner's answer named a question the bot has since replaced (`BotsState.refused`).
pub const QUESTION_CHANGED: &str = "question_changed";

const DAY_MS: f64 = 24.0 * 60.0 * 60_000.0;
/// Planned items wait this many times longer before they read as stale (Orca's `BOT_ITEM_PLANNED_STALE_FACTOR`).
const PLANNED_STALE_FACTOR: f64 = 3.0;

fn too_long(what: &str, text: &str, max: usize) -> R<()> {
    if text.chars().count() > max {
        return fail(format!("{what} is at most {max} characters."));
    }
    Ok(())
}

fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// An ask as plain words (Orca's `botItemAskText`): the words around it, then each question and its quick replies.
fn ask_words(context: &str, decisions: &[ItemDecision]) -> String {
    let several = decisions.len() > 1;
    let parts = decisions.iter().enumerate().map(|(at, decision)| {
        let head = if several {
            format!("{}. {}", at + 1, decision.question)
        } else {
            decision.question.clone()
        };
        let options = decision.options.iter().enumerate().map(|(index, option)| {
            let recommended = if decision.recommended == Some(index as u32) {
                " (recommended)"
            } else {
                ""
            };
            format!("   - {option}{recommended}")
        });
        std::iter::once(head)
            .chain(options)
            .collect::<Vec<_>>()
            .join("\n")
    });
    std::iter::once(context.trim().to_owned())
        .filter(|context| !context.is_empty())
        .chain(parts)
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// One line of an item in a list.
fn item_line(item: &ItemRecord) -> String {
    let mut line = format!("- #{} [{}] {}", item.number, item.status, item.title);
    if let Some(question) = &item.question {
        if question.decisions.is_empty() {
            line.push_str(&format!(" — asks: {}", question.text));
            if !question.options.is_empty() {
                line.push_str(&format!(" ({})", question.options.join(" / ")));
            }
        } else {
            let asked: Vec<String> = question
                .decisions
                .iter()
                .map(|decision| match decision.options.is_empty() {
                    true => decision.question.clone(),
                    false => format!("{} ({})", decision.question, decision.options.join(" / ")),
                })
                .collect();
            line.push_str(&format!(" — asks: {}", asked.join("; ")));
        }
        line.push_str(&format!(" [question {}]", question.id));
    }
    if let Some(wait) = &item.wait {
        line.push_str(&format!(" — waits on {}", wait.text));
        if let Some(until) = &wait.until {
            line.push_str(&format!(" until {until}"));
        }
    }
    if let Some(until) = &item.snoozed_until {
        line.push_str(&format!(" (snoozed until {until})"));
    }
    if item.stale == Some(true) {
        line.push_str(" (stale)");
    }
    if let Some(until) = &item.limit_until {
        line.push_str(&format!(
            " (its sessions wait for a usage limit until {until})"
        ));
    }
    line
}

/// `- YYYY-MM-DD | item #<n> | <status> | <title>` into `<folder>/memory/journal/YYYY-MM.md`.
pub(crate) fn journal_line(folder: &Path, item: &ItemRecord, at: &str) {
    let (day, month) = (&at[..at.len().min(10)], &at[..at.len().min(7)]);
    let dir = folder.join("memory").join("journal");
    let line = format!(
        "- {day} | item #{} | {} | {}\n",
        item.number,
        item.status,
        item.title.replace('\n', " ")
    );
    let written = std::fs::create_dir_all(&dir).and_then(|()| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(format!("{month}.md")))
            .and_then(|mut file| file.write_all(line.as_bytes()))
    });
    if let Err(error) = written {
        eprintln!(
            "[items] journal line not written in {}: {error}",
            dir.display()
        );
    }
}

/// Whether `item` reads as stale after `days` (Orca's `isBotItemStale`); `live`: a linked session still works.
fn is_stale(item: &ItemRecord, days: f64, live: bool, now: f64) -> bool {
    if !item.is_open() || item.snoozed(now) {
        return false;
    }
    // Back from a snooze, its clock starts again then.
    let woke = item
        .snoozed_until
        .as_deref()
        .and_then(parse_iso)
        .filter(|until| *until <= now)
        .unwrap_or(0.0);
    let idle = now - item.touched.max(woke);
    match item.status.as_str() {
        "planned" => idle >= days * PLANNED_STALE_FACTOR * DAY_MS,
        "working" | "waiting" => idle >= days * DAY_MS && !live,
        _ => idle >= days * DAY_MS,
    }
}

/// Records an edit of `field`, its words before and after.
fn edited(
    item: &mut ItemRecord,
    at: &str,
    field: &str,
    before: Option<String>,
    after: Option<String>,
) {
    let event = item.event(at, "bot", "edited", None);
    event.field = Some(field.to_owned());
    event.before = before;
    event.after = after;
}

impl AgentControl {
    pub(in crate::agentctl::service) fn item_assigner(
        &self,
        caller: &ControlTab,
        bot: &str,
    ) -> bool {
        let state = self.host.state();
        let Some(path) = caller
            .session_path
            .as_deref()
            .filter(|path| !path.is_empty())
        else {
            return false;
        };
        state.enabled
            && state.parent_of(&caller.tab_id).is_none()
            && state.tabs.iter().any(|tab| {
                tab.tab_id == caller.tab_id
                    && tab.cwd == caller.cwd
                    && tab.session_path.as_deref() == Some(path)
                    && tab.device.is_none()
                    && !tab.viewing
                    && tab.opened_by_session.is_none()
            })
            && self.bots().of_folder(&caller.cwd).is_some_and(|board| {
                board.id == bot
                    && !board.paused
                    && board.has_session(path)
                    && !board
                        .workers
                        .iter()
                        .any(|w| w.device.is_none() && w.session == path)
            })
    }

    /// The board bound this exact saved session during its spawn. Links, opener scans and reach grant nothing.
    fn confirm_item_assignment(&self, caller: &ControlTab, args: &ItemArgs) -> R<String> {
        let denied = || {
            Fail::Tool("No current assignment to this session for that item and generation.".into())
        };
        let state = self.host.state();
        let tab = state
            .tabs
            .iter()
            .find(|tab| {
                state.enabled
                    && tab.tab_id == caller.tab_id
                    && tab.session_path == caller.session_path
            })
            .ok_or_else(denied)?;
        let key = args.item.as_deref().ok_or_else(denied)?;
        let generation = args.generation.ok_or_else(denied)?;
        if args.session.is_some() || !self.holds_item(tab, key, generation) {
            return Err(denied());
        }
        Ok(format!(
            "Item {key} generation {generation} held by this session."
        ))
    }

    pub(in crate::agentctl::service) fn holds_item(
        &self,
        tab: &ControlTab,
        key: &str,
        generation: u64,
    ) -> bool {
        let Some(path) = tab.session_path.as_deref().filter(|s| !s.is_empty()) else {
            return false;
        };
        if tab.hidden || tab.viewing || tab.device.is_some() {
            return false;
        }
        let board = {
            let store = self.items();
            let Some(item) = store.get(key).filter(|item| item.is_open()) else {
                return false;
            };
            if !item.work.as_ref().is_some_and(|work| {
                work.generation == generation && work.session.as_deref() == Some(path)
            }) {
                return false;
            }
            item.bot.clone()
        };
        self.bots()
            .find(&board)
            .is_some_and(|bot| bot.id == board && !bot.paused)
    }

    /// An item as listed now: its read-time `stale`, `limitUntil` and linked sessions' states.
    pub(crate) fn read_item(
        &self,
        state: &HostState,
        bot: Option<&BotRecord>,
        item: &ItemRecord,
        now: f64,
    ) -> ItemRecord {
        let mut read = item.clone();
        // Shared board snapshots are not authority to address a worker.
        read.work = None;
        let mut limits: Vec<f64> = Vec::new();
        let mut live = 0;
        let mut working = false;
        for link in read.links.iter_mut().filter(|link| link.kind == "session") {
            let tab = state.tabs.iter().find(|tab| {
                tab.tab_id == link.target
                    || (tab.device.is_none()
                        && tab.session_path.as_deref() == Some(link.target.as_str()))
            });
            link.state = Some(match tab {
                Some(tab) => {
                    live += 1;
                    if let Some(retry) = tab.scheduled_retry.as_ref().filter(|retry| retry.limit) {
                        limits.push(retry.at);
                    }
                    let state = session_state(tab);
                    working |= state == "working" || state == "waiting";
                    state.to_owned()
                }
                None if state.deleted_at_path(&link.target, None).is_some() => "gone".to_owned(),
                None => "done".to_owned(),
            });
        }
        read.limit_until = (live > 0 && limits.len() == live)
            .then(|| limits.iter().copied().fold(f64::INFINITY, f64::min))
            .map(|at| iso(at.max(0.0) as u64));
        read.stale = bot
            .and_then(|bot| bot.stale_days)
            .filter(|days| *days > 0.0 && is_stale(item, *days, working, now))
            .map(|_| true);
        read
    }

    /// Session links that name a tab name its session file once the tab has one (a child an item's session open made
    /// before its first message was written). Whether anything changed.
    pub(crate) fn settle_item_links(&self, state: &HostState) -> bool {
        let pending: Vec<(String, usize, String)> = {
            let mut items = self.items();
            let now = self.now();
            items
                .all(now)
                .iter()
                .flat_map(|item| {
                    item.links.iter().enumerate().filter_map(|(at, link)| {
                        let tab = state.tabs.iter().find(|tab| tab.tab_id == link.target)?;
                        let path = tab.session_path.clone().filter(|path| !path.is_empty())?;
                        (link.kind == "session").then(|| (item.id.clone(), at, path))
                    })
                })
                .collect()
        };
        for (id, at, path) in &pending {
            self.items().change(id, |item| {
                if let Some(link) = item.links.get_mut(*at) {
                    link.target = path.clone();
                }
            });
        }
        !pending.is_empty()
    }

    /// `ompdesk_item`: only a bot's chat (a session in its folder) has items.
    pub(crate) async fn item_tool(&self, caller: &ControlTab, args: ItemArgs) -> R<String> {
        if args.action == "claim" {
            return self.confirm_item_assignment(caller, &args);
        }
        let Some(bot) = self.bot_of_folder(&caller.cwd) else {
            return fail("ompdesk_item works in a bot's chat");
        };
        let Some(session) = caller
            .session_path
            .clone()
            .filter(|path| !path.is_empty())
            .or_else(|| bot.home.clone())
        else {
            return fail("This chat has no saved file yet: add items after its first message.");
        };
        let now = self.now();
        let at = iso(now.max(0.0) as u64);
        if args.action == "add" {
            let title = args.title.as_deref().unwrap_or("").trim().to_owned();
            if title.is_empty() {
                return fail("add needs title.");
            }
            too_long("title", &title, TITLE_MAX)?;
            too_long(
                "description",
                args.description.as_deref().unwrap_or(""),
                DESCRIPTION_MAX,
            )?;
            too_long(
                "done_means",
                args.done_means.as_deref().unwrap_or(""),
                DESCRIPTION_MAX,
            )?;
            let status = args.status.clone().unwrap_or_else(|| "planned".to_owned());
            if !STATUSES.contains(&status.as_str()) {
                return fail(format!("status is one of {}.", STATUSES.join(", ")));
            }
            let mut item = ItemRecord {
                id: new_id("item"),
                bot: bot.id.clone(),
                session,
                title,
                description: args.description.clone().filter(|text| !text.is_empty()),
                done_means: args.done_means.clone().filter(|text| !text.is_empty()),
                status: status.clone(),
                created_at: at.clone(),
                updated_at: at.clone(),
                touched: now,
                version: 1,
                ..ItemRecord::default()
            };
            item.event(&at, "bot", "made", Some(&status));
            let item = self.items().add(item).map_err(Fail::Tool)?;
            self.items_changed();
            return Ok(format!(
                "Added item #{} “{}” ({}).",
                item.number, item.title, item.status
            ));
        }
        if args.action == "list" {
            let items: Vec<ItemRecord> = {
                let state = self.host.state();
                let mut store = self.items();
                store
                    .all(now)
                    .iter()
                    .filter(|item| item.bot == bot.id)
                    .filter(|item| match args.status.as_deref() {
                        Some(status) => item.status == status,
                        None => item.is_open(),
                    })
                    .map(|item| self.read_item(&state, Some(&bot), item, now))
                    .collect()
            };
            if items.is_empty() {
                return Ok("No items.".to_owned());
            }
            return Ok(items
                .iter()
                .map(|item| format!("{} (id {})", item_line(item), item.id))
                .collect::<Vec<_>>()
                .join("\n"));
        }
        let Some(key) = args.item.as_deref().filter(|key| !key.trim().is_empty()) else {
            return fail(format!("{} needs item (its number or id).", args.action));
        };
        let found = {
            let store = self.items();
            if args.action == "show" {
                store.find(&bot.id, key).ok_or_else(|| {
                    Fail::Tool(format!("No item \"{key}\" of the bot {}.", bot.name))
                })?
            } else {
                store.write_address(&bot.id, key).map_err(Fail::Tool)?
            }
            .clone()
        };
        if args.action == "show" {
            let read = self.read_item(&self.host.state(), Some(&bot), &found, now);
            let mut lines = vec![item_line(&read)];
            if let Some(description) = &read.description {
                lines.push(format!("description: {description}"));
            }
            if let Some(done) = &read.done_means {
                lines.push(format!("done means: {done}"));
            }
            for link in &read.links {
                lines.push(format!(
                    "link: {} {}{}",
                    link.kind,
                    link.target,
                    link.state
                        .as_deref()
                        .map_or_else(String::new, |state| format!(" ({state})"))
                ));
            }
            for event in read.events.iter().rev().take(10) {
                lines.push(format!(
                    "{} {} {}{}{}",
                    event.at,
                    event.actor,
                    event.kind,
                    event
                        .text
                        .as_deref()
                        .map_or_else(String::new, |text| format!(": {text}")),
                    event
                        .note
                        .as_deref()
                        .map_or_else(String::new, |note| format!(" ({note})"))
                ));
            }
            return Ok(lines.join("\n"));
        }
        // What every action but add, list and show asks of its arguments, before anything changes.
        let action = args.action.as_str();
        match action {
            "set" => {
                if let Some(title) = &args.title {
                    too_long("title", title, TITLE_MAX)?;
                }
                if let Some(description) = &args.description {
                    too_long("description", description, DESCRIPTION_MAX)?;
                }
                if let Some(ask) = &args.ask {
                    too_long("ask", ask, TEXT_MAX)?;
                }
                if let Some(wait) = &args.wait {
                    too_long("wait", wait, TEXT_MAX)?;
                }
                let asks = args.asks.as_deref().unwrap_or(&[]);
                if asks.len() > DECISIONS_MAX {
                    return fail(format!("asks takes up to {DECISIONS_MAX} questions."));
                }
                for ask in asks {
                    if ask.question.trim().is_empty() {
                        return fail("Each of asks needs its question.");
                    }
                    too_long("A question of asks", &ask.question, DECISION_MAX)?;
                    if ask.options.len() > OPTIONS_MAX {
                        return fail(format!("A question takes up to {OPTIONS_MAX} options."));
                    }
                    if ask
                        .recommended
                        .is_some_and(|index| index as usize >= ask.options.len())
                    {
                        return fail("recommended is not one of that question's options.");
                    }
                }
                if let Some(status) = &args.status
                    && !STATUSES.contains(&status.as_str())
                {
                    return fail(format!("status is one of {}.", STATUSES.join(", ")));
                }
                for (what, time) in [("until", &args.until), ("snooze_until", &args.snooze_until)] {
                    if let Some(time) = time.as_deref().filter(|time| !time.is_empty())
                        && parse_iso(time).is_none()
                    {
                        return fail(format!("{what} is an ISO time (2026-11-25T09:00:00Z)."));
                    }
                }
            }
            "withdraw" | "self_decide" => {
                if args.question.is_none() {
                    return fail("Name the question id shown on the item.");
                }
                let note = args.note.as_deref().unwrap_or("").trim();
                if note.is_empty() {
                    return fail(
                        "Give a note explaining why the question no longer needs an answer.",
                    );
                }
                too_long("note", note, TEXT_MAX)?;
            }
            "comment" => {
                let text = args.text.as_deref().unwrap_or("");
                if text.trim().is_empty() {
                    return fail("comment needs text.");
                }
                too_long("text", text, TEXT_MAX)?;
            }
            "done" | "cancel" => {
                too_long("note", args.note.as_deref().unwrap_or(""), TEXT_MAX)?;
            }
            "link" => {
                let given: Vec<(&str, &String)> = [
                    ("url", &args.url),
                    ("file", &args.file),
                    ("session", &args.session),
                    ("pr", &args.pr),
                ]
                .into_iter()
                .filter_map(|(kind, value)| {
                    value.as_ref().filter(|v| !v.is_empty()).map(|v| (kind, v))
                })
                .collect();
                if given.len() != 1 {
                    return fail("link takes exactly one of url, file, session or pr.");
                }
            }
            other => return fail(format!("ompdesk_item has no action {other}.")),
        }
        let session_link = match (action, args.session.as_deref()) {
            ("link", Some(session)) => {
                let state = self.host.state();
                Some(
                    state
                        .tabs
                        .iter()
                        .find(|tab| tab.tab_id == session || tab.task.as_deref() == Some(session))
                        .and_then(|tab| {
                            tab.session_path
                                .clone()
                                .or_else(|| Some(tab.tab_id.clone()))
                        })
                        .unwrap_or_else(|| session.to_owned()),
                )
            }
            _ => None,
        };
        let mut store = self.items();
        if matches!(action, "withdraw" | "self_decide")
            && store
                .get(&found.id)
                .and_then(|i| i.question.as_ref())
                .map(|q| q.id)
                != args.question
        {
            return fail(QUESTION_CHANGED);
        }
        let Some(changed) = store.change(&found.id, |item| {
            let before = item.status.clone();
            let mut note: Option<String> = None;
            match action {
                "set" => {
                    if let Some(title) = args
                        .title
                        .as_deref()
                        .map(str::trim)
                        .filter(|t| !t.is_empty() && *t != item.title)
                    {
                        let was = std::mem::replace(&mut item.title, title.to_owned());
                        edited(item, &at, "title", Some(was), Some(title.to_owned()));
                    }
                    if let Some(description) = &args.description {
                        let next = Some(description.clone()).filter(|d| !d.is_empty());
                        if next != item.description {
                            let was = std::mem::replace(&mut item.description, next.clone());
                            edited(item, &at, "description", was, next);
                        }
                    }
                    if let Some(done) = &args.done_means {
                        let next = Some(done.clone()).filter(|d| !d.is_empty());
                        if next != item.done_means {
                            let was = std::mem::replace(&mut item.done_means, next.clone());
                            edited(item, &at, "doneMeans", was, next);
                        }
                    }
                    let decisions: Vec<ItemDecision> = args
                        .asks
                        .iter()
                        .flatten()
                        .map(|ask| ItemDecision {
                            question: ask.question.trim().to_owned(),
                            options: ask.options.clone(),
                            recommended: ask.recommended,
                            multi: ask.multi,
                        })
                        .collect();
                    let context = args
                        .ask
                        .as_deref()
                        .map(str::trim)
                        .filter(|ask| !ask.is_empty());
                    if context.is_some() || !decisions.is_empty() {
                        let text = context.unwrap_or("").to_owned();
                        let words = if decisions.is_empty() {
                            text.clone()
                        } else {
                            ask_words(&text, &decisions)
                        };
                        item.event(&at, "bot", "asked", Some(&words));
                        let single = decisions.is_empty();
                        // A new ask gets the id of its event as the store saves it.
                        item.question = Some(ItemQuestion {
                            text,
                            options: if single {
                                args.options.clone().unwrap_or_default()
                            } else {
                                Vec::new()
                            },
                            recommended: if single { args.recommended } else { None },
                            id: 0,
                            decisions,
                        });
                        item.status = "needs_you".to_owned();
                    } else if let Some(question) = item.question.as_mut() {
                        if let Some(options) = &args.options {
                            question.options = options.clone();
                        }
                        if args.recommended.is_some() {
                            question.recommended = args.recommended;
                        }
                    }
                    if let Some(wait) = args.wait.as_deref().filter(|wait| !wait.trim().is_empty())
                    {
                        item.wait = Some(ItemWait {
                            text: wait.to_owned(),
                            until: args.until.clone().filter(|until| !until.is_empty()),
                            at: Some(at.clone()),
                        });
                        note = Some(wait.to_owned());
                        if args.status.is_none() {
                            item.status = "waiting".to_owned();
                        }
                    }
                    if let Some(status) = &args.status {
                        item.status = status.clone();
                    }
                    if let Some(snooze) = &args.snooze_until {
                        let until = Some(snooze.clone()).filter(|s| !s.is_empty());
                        if until != item.snoozed_until {
                            item.snoozed_until = until.clone();
                            match until {
                                Some(until) => {
                                    item.event(&at, "bot", "snoozed", Some(&until));
                                }
                                None => {
                                    item.event(&at, "bot", "unsnoozed", None);
                                }
                            }
                        }
                    }
                }
                "withdraw" | "self_decide" => {
                    let kind = if action == "withdraw" {
                        "withdrawn"
                    } else {
                        "self_decided"
                    };
                    item.event(&at, "bot", kind, args.note.as_deref().map(str::trim))
                        .question = args.question;
                    item.status = "working".to_owned();
                }
                "comment" => {
                    item.event(&at, "bot", "commented", args.text.as_deref());
                }
                "done" | "cancel" => {
                    item.status = if action == "done" { "done" } else { "canceled" }.to_owned();
                    item.close_note = args.note.clone().filter(|note| !note.is_empty());
                    note = item.close_note.clone();
                }
                "link" => {
                    let (kind, target) = if let Some(session) = &session_link {
                        ("session", session.clone())
                    } else if let Some(url) = args.url.clone().filter(|v| !v.is_empty()) {
                        ("url", url)
                    } else if let Some(file) = args.file.clone().filter(|v| !v.is_empty()) {
                        ("file", file)
                    } else {
                        ("pr", args.pr.clone().unwrap_or_default())
                    };
                    if !item
                        .links
                        .iter()
                        .any(|link| link.kind == kind && link.target == target)
                    {
                        item.links.push(ItemLink {
                            kind: kind.to_owned(),
                            target: target.clone(),
                            ..ItemLink::default()
                        });
                    }
                    item.event(&at, "bot", "linked", Some(&target));
                }
                _ => {}
            }
            settle_status(item, &before, &at, now, "bot", note.as_deref());
            item.version += 1;
            item.updated_at = at.clone();
            item.touched = now;
        }) else {
            return fail("That item is gone.");
        };
        drop(store);
        if !changed.is_open() && is_open(&found.status) {
            journal_line(Path::new(&bot.folder), &changed, &at);
        }
        self.items_changed();
        Ok(format!(
            "Item {}",
            item_line(&changed).trim_start_matches("- ")
        ))
    }

    /// An item changed: main hears the new state and bot chats their new context.
    pub(crate) fn items_changed(&self) {
        self.bots_changed();
        let control = self.clone();
        tokio::spawn(async move { control.bots_tick().await });
    }

    /// The owner opened a bot's Items tab (`BotsRequest` `itemsOpened`): what its items hold now is seen.
    pub(crate) fn items_opened(&self, bot: &str) -> R<()> {
        let bot = self.bot_named(bot)?;
        let newest = self.items().newest_event(&bot.id);
        if newest > bot.items_seen {
            self.bots()
                .change(&bot.id, |record| record.items_seen = newest);
            self.bots_changed();
        }
        Ok(())
    }

    /// A session an item links reported to its opener that it is done or blocked: the item's Activity says so.
    pub(crate) fn item_worker_report(&self, caller: &ControlTab, kind: &str, text: &str) {
        let path = caller.session_path.clone().filter(|path| !path.is_empty());
        let mut targets = vec![caller.tab_id.as_str()];
        if let Some(path) = path.as_deref() {
            targets.push(path);
        }
        let ids = self.items().linking(&targets);
        if ids.is_empty() {
            return;
        }
        let now = self.now();
        let at = iso(now.max(0.0) as u64);
        let subject = cut(
            text.lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or(""),
            240,
        );
        let link = path.unwrap_or_else(|| caller.tab_id.clone());
        for id in ids {
            self.items().change(&id, |item| {
                let event = item.event(
                    &at,
                    "bot",
                    "worker",
                    Some(subject.as_str()).filter(|subject| !subject.is_empty()),
                );
                event.link = Some(link.clone());
                event.state = Some(kind.to_owned());
                item.version += 1;
                item.updated_at = at.clone();
                item.touched = now;
            });
        }
        self.items_changed();
    }

    /// The owner's change to one item (`id`) or several (`ids`), `BotsRequest` `item`: mailed once to each item's
    /// chat, an answer as a turn. Answers `question_changed` when an answer names a question the bot replaced.
    pub(crate) async fn owner_item(&self, request: &Value) -> R<Option<&'static str>> {
        let ids: Vec<String> = match request.get("ids").and_then(Value::as_array) {
            Some(ids) => ids
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            None => request
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .into_iter()
                .collect(),
        };
        let now = self.now();
        let at = iso(now.max(0.0) as u64);
        let text_of = |key: &str, max: usize| {
            request
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(|text| cut(text, max))
        };
        let comment = text_of("comment", TEXT_MAX);
        let note = text_of("note", TEXT_MAX);
        let wait = text_of("wait", WAIT_MAX);
        let request_id = text_of("requestId", 200);
        let asked_status = request
            .get("status")
            .and_then(Value::as_str)
            .filter(|status| STATUSES.contains(status))
            .map(str::to_owned)
            .or_else(|| wait.as_ref().map(|_| "waiting".to_owned()));
        let snooze: Option<Option<String>> = match request.get("snoozeUntil") {
            Some(Value::Null) => Some(None),
            Some(Value::String(until)) if parse_iso(until).is_some() => Some(Some(until.clone())),
            _ => None,
        };
        let named = request
            .get("answer")
            .and_then(|answer| answer.get("question"))
            .and_then(Value::as_u64);
        // Per chat: its lines, the first change's mail id, whether one is an answer.
        let mut mails: Vec<(String, Vec<String>, String, bool)> = Vec::new();
        let mut refused: Option<&'static str> = None;
        let mut changed_any = false;
        for id in &ids {
            // A change to an item that is gone mails nothing and asks nothing.
            let mut store = self.items();
            let Some(found) = store.get(id).cloned() else {
                continue;
            };
            if request_id
                .as_deref()
                .is_some_and(|request| found.has_request(request))
            {
                continue;
            }
            if named.is_some() && found.question.as_ref().map(|question| question.id) != named {
                refused = Some(QUESTION_CHANGED);
                continue;
            }
            if request.get("answer").is_some()
                && found.question.is_none()
                && found
                    .events
                    .iter()
                    .rev()
                    .find(|event| {
                        matches!(
                            event.kind.as_str(),
                            "asked" | "answered" | "withdrawn" | "self_decided"
                        )
                    })
                    .is_some_and(|event| {
                        matches!(event.kind.as_str(), "withdrawn" | "self_decided")
                    })
            {
                refused = Some(QUESTION_CHANGED);
                continue;
            }
            let answer: Option<String> = request.get("answer").and_then(|answer| {
                let picked = answer
                    .get("choice")
                    .and_then(Value::as_u64)
                    .and_then(|choice| {
                        found
                            .question
                            .as_ref()?
                            .options
                            .get(choice as usize)
                            .cloned()
                    });
                let written = answer
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(|text| cut(text, TEXT_MAX));
                match (picked, written) {
                    (Some(picked), Some(written)) => Some(format!("{picked} — {written}")),
                    (picked, written) => picked.or(written),
                }
            });
            let (answer, comment) = match (answer, &found.question) {
                (Some(answer), Some(_)) => (Some(answer), comment.clone()),
                // Nothing waits on an answer any more: the words stay as a comment.
                (Some(answer), None) => (
                    None,
                    Some(match &comment {
                        Some(comment) => format!("{answer}\n\n{comment}"),
                        None => answer,
                    }),
                ),
                (None, _) => (None, comment.clone()),
            };
            // Waiting again on a Waiting item edits what it waits on.
            let status = asked_status.clone().filter(|status| {
                *status != found.status || (status == "waiting" && wait.is_some())
            });
            let snooze = snooze
                .clone()
                .filter(|snooze| *snooze != found.snoozed_until);
            // An empty change: no version, no event, no mail.
            if status.is_none() && answer.is_none() && comment.is_none() && snooze.is_none() {
                continue;
            }
            let Some(changed) = store.change(id, |item| {
                let before = item.status.clone();
                if let Some(answer) = &answer {
                    let question = item.question.as_ref().map(|question| question.id);
                    let event = item.event(&at, "owner", "answered", Some(answer));
                    event.question = question;
                    event.request = request_id.clone();
                    item.question = None;
                    if status.is_none() && item.status == "needs_you" {
                        item.status = "working".to_owned();
                    }
                }
                if let Some(status) = &status {
                    if status == "waiting"
                        && let Some(wait) = &wait
                    {
                        item.wait = Some(ItemWait {
                            text: wait.clone(),
                            until: None,
                            at: Some(at.clone()),
                        });
                        if before == "waiting" {
                            let event = item.event(&at, "owner", "status", Some("waiting"));
                            event.from = Some(before.clone());
                            event.note = Some(wait.clone());
                        }
                    }
                    item.status = status.clone();
                }
                if let Some(comment) = &comment {
                    item.event(&at, "owner", "commented", Some(comment)).request =
                        request_id.clone();
                }
                if let Some(snooze) = &snooze {
                    let early = item.snoozed(now);
                    item.snoozed_until = snooze.clone();
                    match snooze {
                        Some(until) => {
                            item.event(&at, "owner", "snoozed", Some(until));
                        }
                        None if early => {
                            item.event(&at, "owner", "unsnoozed", None);
                        }
                        None => {}
                    }
                }
                let why = if item.status == "waiting" {
                    wait.as_deref()
                } else {
                    note.as_deref()
                };
                settle_status(item, &before, &at, now, "owner", why);
                item.version += 1;
                item.updated_at = at.clone();
                item.touched = now;
                if !item.is_open() && item.close_note.is_none() {
                    item.close_note = note.clone().or_else(|| comment.clone());
                }
            }) else {
                continue;
            };
            drop(store);
            changed_any = true;
            if !changed.is_open()
                && is_open(&found.status)
                && let Some(bot) = self.bots().find(&changed.bot).cloned()
            {
                journal_line(Path::new(&bot.folder), &changed, &at);
            }
            let mut lines: Vec<String> = Vec::new();
            if let Some(answer) = &answer {
                lines.push(format!("The owner answered: {answer}"));
            }
            if let Some(status) = &status {
                lines.push(match (status.as_str(), wait.as_deref(), note.as_deref()) {
                    ("waiting", Some(wait), _) => {
                        format!("The owner set it to waiting on: {wait}.")
                    }
                    (_, _, Some(note)) => format!("The owner set it to {status}: {note}"),
                    _ => format!("The owner set it to {status}."),
                });
            }
            if let Some(comment) = &comment {
                lines.push(format!("The owner commented: {comment}"));
            }
            // A snooze alone mails nobody: the item keeps its status (Orca's `BotItemSnooze.tsx`).
            if lines.is_empty() {
                continue;
            }
            let line = format!(
                "Item #{} “{}” [{}]: {}",
                changed.number,
                changed.title,
                changed.status,
                lines.join(" ")
            );
            match mails
                .iter_mut()
                .find(|(session, ..)| *session == changed.session)
            {
                Some((_, lines, _, answered)) => {
                    lines.push(line);
                    *answered |= answer.is_some();
                }
                None => mails.push((
                    changed.session.clone(),
                    vec![line],
                    format!("item-{}-v{}", changed.id, changed.version),
                    answer.is_some(),
                )),
            }
        }
        for (session, lines, id, answered) in mails {
            // Several items in one move are one mail, named by its first change and how many it holds.
            let id = if lines.len() > 1 {
                format!("{id}+{}", lines.len())
            } else {
                id
            };
            let kind = if answered {
                MailKind::Question
            } else {
                MailKind::Note
            };
            let mut mail = Mail::new(
                &id,
                "ompdesk",
                "the owner",
                "",
                kind,
                &lines.join("\n"),
                now,
            );
            if answered {
                mail.instruction = Some(
                    "The owner answered your item's question: go on with the item now.".to_owned(),
                );
            }
            self.mail_session(&session, mail, answered).await;
        }
        if changed_any {
            self.items_changed();
        }
        Ok(refused)
    }

    /// `ompdesk_session_open {item}` from a bot's chat: each child it opened is linked to the item, and a planned
    /// item is now being worked on.
    pub(crate) fn link_opened(&self, caller: &ControlTab, key: &str, child_tab: &str) -> R<()> {
        let Some(bot) = self.bot_of_folder(&caller.cwd) else {
            return fail("item works only from a bot's chat.");
        };
        let Some(found) = self.items().find(&bot.id, key).cloned() else {
            return fail(format!("No item \"{key}\" of the bot {}.", bot.name));
        };
        let now = self.now();
        let at = iso(now.max(0.0) as u64);
        self.items().change(&found.id, |item| {
            let before = item.status.clone();
            if !item
                .links
                .iter()
                .any(|link| link.kind == "session" && link.target == child_tab)
            {
                item.links.push(ItemLink {
                    kind: "session".to_owned(),
                    target: child_tab.to_owned(),
                    ..ItemLink::default()
                });
            }
            item.event(&at, "bot", "linked", Some(child_tab));
            if item.status == "planned" {
                item.status = "working".to_owned();
            }
            settle_status(item, &before, &at, now, "bot", None);
            item.version += 1;
            item.updated_at = at.clone();
            item.touched = now;
        });
        self.items_changed();
        Ok(())
    }
}

/// After a change: a status change is recorded with what it left and why, a closed item records when it closed, a
/// reopened one forgets it, an item that no longer asks drops its question (and one no longer waiting its wait), and
/// a close or a new question ends a snooze early.
fn settle_status(
    item: &mut ItemRecord,
    before: &str,
    at: &str,
    now: f64,
    actor: &str,
    note: Option<&str>,
) {
    if item.status != before {
        let to = item.status.clone();
        let event = item.event(at, actor, "status", Some(&to));
        event.from = Some(before.to_owned());
        event.note = note.map(str::to_owned);
    }
    if item.is_open() {
        item.closed = None;
        item.closed_at = None;
    } else if item.closed.is_none() {
        item.closed = Some(now);
        item.closed_at = Some(at.to_owned());
    }
    if item.status != "needs_you" {
        item.question = None;
    }
    if item.status != "waiting" {
        item.wait = None;
    }
    let ends_snooze = !item.is_open() || (item.status == "needs_you" && before != "needs_you");
    if ends_snooze
        && let Some(until) = item.snoozed_until.take()
        && parse_iso(&until).is_some_and(|until| until > now)
    {
        item.event(at, actor, "unsnoozed", None).early = true;
    }
}

/// A linked session's state as its tab shows it now.
fn session_state(tab: &ControlTab) -> &'static str {
    if tab.busy || tab.resuming {
        return "working";
    }
    if !tab.asks.is_empty() {
        return "waiting";
    }
    match tab.status {
        TabStatus::Exited | TabStatus::Error => "failed",
        _ => match tab.last_run.as_ref().map(|run| run.stop_reason.as_str()) {
            Some("error") => "failed",
            Some("aborted") => "stopped",
            _ => "done",
        },
    }
}
