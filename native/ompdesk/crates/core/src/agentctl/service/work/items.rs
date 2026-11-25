//! A bot's items (`ompdesk_item` from a bot's chat, the owner's `BotsRequest` `item`): what the bot works on and what
//! it needs from its owner (Orca's bot items, re-implemented; control-tools.md › Bots, items and rooms).
//!
//! - The owner's change raises `version`, records an event and is mailed once to the item's chat, named
//!   `item-<id>-v<version>` (a repeat of one change is one mail). An answer to the item's question starts a turn there
//!   (the chat is reached as a routine's wake-up reaches it); any other change is a quiet note kept until the chat
//!   opens. A change that changes nothing, or one to an item that is gone, mails nothing and asks nothing.
//! - Read when listed: `stale` (open and untouched for its bot's `staleDays`), each linked session's `state`, and
//!   `limitUntil` (every live linked session waits for a usage limit: the earliest reset).
//! - A closed item adds one line to `<bot folder>/memory/journal/YYYY-MM.md`.

use std::io::Write as _;
use std::path::Path;

use serde_json::Value;

use super::super::AgentControl;
use super::super::fail::{R, fail};
use super::super::host::HostState;
use super::super::types::{ControlTab, ItemArgs, TabStatus};
use super::bots::new_id;
use crate::agentctl::journal::bots::BotRecord;
use crate::agentctl::journal::items::{
    ItemLink, ItemQuestion, ItemRecord, ItemWait, STATUSES, is_open, parse_iso,
};
use crate::agentctl::rules::mail::{Mail, MailKind};
use crate::aimemory::value::iso;

/// An item's title, at most.
pub const TITLE_MAX: usize = 200;
/// An item's description, at most.
pub const DESCRIPTION_MAX: usize = 20_000;
/// A comment, a note or a question, at most.
pub const TEXT_MAX: usize = 8_000;

const DAY_MS: f64 = 24.0 * 60.0 * 60_000.0;

fn too_long(what: &str, text: &str, max: usize) -> R<()> {
    if text.chars().count() > max {
        return fail(format!("{what} is at most {max} characters."));
    }
    Ok(())
}

/// One line of an item in a list.
fn item_line(item: &ItemRecord) -> String {
    let mut line = format!("- #{} [{}] {}", item.number, item.status, item.title);
    if let Some(question) = &item.question {
        line.push_str(&format!(" — asks: {}", question.text));
        if !question.options.is_empty() {
            line.push_str(&format!(" ({})", question.options.join(" / ")));
        }
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

impl AgentControl {
    /// An item as listed now: its read-time `stale`, `limitUntil` and linked sessions' states.
    pub(crate) fn read_item(
        &self,
        state: &HostState,
        bot: Option<&BotRecord>,
        item: &ItemRecord,
        now: f64,
    ) -> ItemRecord {
        let mut read = item.clone();
        read.stale = bot
            .and_then(|bot| bot.stale_days)
            .filter(|days| *days > 0.0 && item.is_open() && now - item.touched > days * DAY_MS)
            .map(|_| true);
        let mut limits: Vec<f64> = Vec::new();
        let mut live = 0;
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
                    session_state(tab).to_owned()
                }
                None if state.deleted_at_path(&link.target, None).is_some() => "gone".to_owned(),
                None => "done".to_owned(),
            });
        }
        read.limit_until = (live > 0 && limits.len() == live)
            .then(|| limits.iter().copied().fold(f64::INFINITY, f64::min))
            .map(|at| iso(at.max(0.0) as u64));
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
                number: self.items().next_number(&bot.id),
                session,
                title,
                description: args.description.clone().filter(|text| !text.is_empty()),
                done_means: args.done_means.clone().filter(|text| !text.is_empty()),
                status,
                created_at: at.clone(),
                updated_at: at.clone(),
                touched: now,
                version: 1,
                ..ItemRecord::default()
            };
            item.event(&at, "bot", "made", None);
            self.items().add(item.clone());
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
            return Ok(items.iter().map(item_line).collect::<Vec<_>>().join("\n"));
        }
        let Some(key) = args.item.as_deref().filter(|key| !key.trim().is_empty()) else {
            return fail(format!("{} needs item (its number or id).", args.action));
        };
        let Some(found) = self.items().find(&bot.id, key).cloned() else {
            return fail(format!(
                "No item \"{key}\" of the bot {}. ompdesk_item {{\"action\":\"list\"}} lists them.",
                bot.name
            ));
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
                    "{} {} {}{}",
                    event.at,
                    event.actor,
                    event.kind,
                    event
                        .text
                        .as_deref()
                        .map_or_else(String::new, |text| format!(": {text}"))
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
        let Some(changed) = self.items().change(&found.id, |item| {
            let before = item.status.clone();
            match action {
                "set" => {
                    if let Some(title) = args
                        .title
                        .as_deref()
                        .map(str::trim)
                        .filter(|t| !t.is_empty())
                    {
                        item.title = title.to_owned();
                    }
                    if let Some(description) = &args.description {
                        item.description = Some(description.clone()).filter(|d| !d.is_empty());
                    }
                    if let Some(done) = &args.done_means {
                        item.done_means = Some(done.clone()).filter(|d| !d.is_empty());
                    }
                    if let Some(ask) = args.ask.as_deref().filter(|ask| !ask.trim().is_empty()) {
                        item.question = Some(ItemQuestion {
                            text: ask.to_owned(),
                            options: args.options.clone().unwrap_or_default(),
                            recommended: args.recommended,
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
                        });
                        if args.status.is_none() {
                            item.status = "waiting".to_owned();
                        }
                    }
                    if let Some(status) = &args.status {
                        item.status = status.clone();
                    }
                    if let Some(snooze) = &args.snooze_until {
                        item.snoozed_until = Some(snooze.clone()).filter(|s| !s.is_empty());
                        item.event(&at, "bot", "snoozed", item.snoozed_until.clone().as_deref());
                    }
                    item.event(&at, "bot", "edited", None);
                }
                "comment" => item.event(&at, "bot", "commented", args.text.as_deref()),
                "done" | "cancel" => {
                    item.status = if action == "done" { "done" } else { "canceled" }.to_owned();
                    item.close_note = args.note.clone().filter(|note| !note.is_empty());
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
            settle_status(item, &before, &at, now, "bot");
            item.version += 1;
            item.updated_at = at.clone();
            item.touched = now;
        }) else {
            return fail("That item is gone.");
        };
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

    /// The owner's change to an item (`BotsRequest` `item`): mailed once to the item's chat, an answer as a turn.
    pub(crate) async fn owner_item(&self, request: &Value) -> R<()> {
        let id = request.get("id").and_then(Value::as_str).unwrap_or("");
        let now = self.now();
        let at = iso(now.max(0.0) as u64);
        // A change to an item that is gone mails nothing and asks nothing.
        let Some(found) = self.items().get(id).cloned() else {
            return Ok(());
        };
        let status = request
            .get("status")
            .and_then(Value::as_str)
            .filter(|status| STATUSES.contains(status) && *status != found.status)
            .map(str::to_owned);
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
                .map(|text| text.chars().take(TEXT_MAX).collect::<String>());
            match (picked, written) {
                (Some(picked), Some(written)) => Some(format!("{picked} — {written}")),
                (picked, written) => picked.or(written),
            }
        });
        let answer = answer.filter(|_| found.question.is_some());
        let comment = request
            .get("comment")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(|text| text.chars().take(TEXT_MAX).collect::<String>());
        let snooze: Option<Option<String>> = match request.get("snoozeUntil") {
            Some(Value::Null) => Some(None),
            Some(Value::String(until)) if parse_iso(until).is_some() => Some(Some(until.clone())),
            _ => None,
        }
        .filter(|snooze| *snooze != found.snoozed_until);
        // An empty change: no version, no event, no mail.
        if status.is_none() && answer.is_none() && comment.is_none() && snooze.is_none() {
            return Ok(());
        }
        let Some(changed) = self.items().change(id, |item| {
            let before = item.status.clone();
            if let Some(answer) = &answer {
                item.event(&at, "owner", "answered", Some(answer));
                item.question = None;
                if status.is_none() && item.status == "needs_you" {
                    item.status = "working".to_owned();
                }
            }
            if let Some(status) = &status {
                item.status = status.clone();
            }
            if let Some(comment) = &comment {
                item.event(&at, "owner", "commented", Some(comment));
            }
            if let Some(snooze) = &snooze {
                item.snoozed_until = snooze.clone();
                item.event(&at, "owner", "snoozed", snooze.as_deref());
            }
            settle_status(item, &before, &at, now, "owner");
            item.version += 1;
            item.updated_at = at.clone();
            item.touched = now;
            if !item.is_open() && item.close_note.is_none() {
                item.close_note = comment.clone();
            }
        }) else {
            return Ok(());
        };
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
            lines.push(format!("The owner set it to {status}."));
        }
        if let Some(comment) = &comment {
            lines.push(format!("The owner commented: {comment}"));
        }
        if let Some(snooze) = &snooze {
            lines.push(match snooze {
                Some(until) => format!("The owner snoozed it until {until}."),
                None => "The owner woke it from its snooze.".to_owned(),
            });
        }
        let text = format!(
            "Item #{} “{}” [{}]: {}",
            changed.number,
            changed.title,
            changed.status,
            lines.join(" ")
        );
        let mail_id = format!("item-{}-v{}", changed.id, changed.version);
        let kind = if answer.is_some() {
            MailKind::Question
        } else {
            MailKind::Note
        };
        let mut mail = Mail::new(&mail_id, "ompdesk", "the owner", "", kind, &text, now);
        if answer.is_some() {
            mail.instruction = Some(
                "The owner answered your item's question: go on with the item now.".to_owned(),
            );
        }
        self.mail_session(&changed.session, mail, answer.is_some())
            .await;
        self.items_changed();
        Ok(())
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
                item.event(&at, "bot", "status", Some("working"));
            }
            item.version += 1;
            item.updated_at = at.clone();
            item.touched = now;
        });
        self.items_changed();
        Ok(())
    }
}

/// After a change: a closed item records when it closed, a reopened one forgets it, and an item that no longer asks
/// drops its question.
fn settle_status(item: &mut ItemRecord, before: &str, at: &str, now: f64, actor: &str) {
    if item.status != before {
        item.event(at, actor, "status", Some(&item.status.clone()));
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
}

/// A linked session's state as its tab shows it now.
fn session_state(tab: &ControlTab) -> &'static str {
    if tab.busy || tab.resuming {
        return "working";
    }
    if !tab.asks.is_empty() || tab.plan.is_some() {
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
