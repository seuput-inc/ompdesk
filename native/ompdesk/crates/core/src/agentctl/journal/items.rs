//! A bot's items. SQLite keeps the full history. The cache keeps each current row in insertion
//! order with its last 50 events; closing an item only affects visibility, not its retention.
//!
//! Every event has an id, counted across all items (Orca's `e<n>`, `bot-items.ts`): an item's question names the
//! event that asked it, an answer the question it answers, and a bot's Items tab is seen up to an id. The store
//! stamps a new event (id 0) as it saves the change that made it.
//!
//! What an item does not hold is read when the state is listed (`service/work/items.rs`): `stale`, `limitUntil` and
//! each linked session's `state`.

use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

mod mail;
pub(crate) use mail::{ItemMail, ItemMailState};
mod storage;

/// `ITEM_STATUSES`.
pub const STATUSES: [&str; 6] = [
    "planned",
    "working",
    "waiting",
    "needs_you",
    "done",
    "canceled",
];
/// `ITEM_OPEN_STATUSES`.
pub const OPEN_STATUSES: [&str; 4] = ["planned", "working", "waiting", "needs_you"];
/// How long a closed item appears in v1.
pub const CLOSED_KEPT_MS: f64 = 7.0 * 24.0 * 60.0 * 60_000.0;
/// Newest events shown in v1.
pub const EVENTS_KEPT: usize = 50;

pub fn is_open(status: &str) -> bool {
    OPEN_STATUSES.contains(&status)
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

/// One question of several asked at once (Orca's `BotItemDecision`): its quick replies, the one recommended, and
/// whether several may be picked.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemDecision {
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended: Option<u32>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub multi: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemQuestion {
    pub text: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended: Option<u32>,
    /// The event that asked it; an answer naming another question is refused.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub id: u64,
    /// Several questions asked at once (at most `DECISIONS_MAX`); `text` is then the words around them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub decisions: Vec<ItemDecision>,
}

/// Questions one ask may hold (Orca's `BOT_ITEM_ASK_LIMITS.questions`).
pub const DECISIONS_MAX: usize = 5;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemWait {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    /// When it was set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemLink {
    /// `session`, `pr`, `url`, `file` or `schedule`.
    pub kind: String,
    #[serde(rename = "ref")]
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Read-time: a linked session's state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemEvent {
    /// Counted across all items; 0 until the store saved it.
    #[serde(default)]
    pub id: u64,
    pub at: String,
    /// `bot` or `owner`.
    pub actor: String,
    /// `made`, `edited`, `status`, `commented`, `asked`, `answered`, `withdrawn`, `self_decided`, `linked`, `snoozed`, `unsnoozed` or `worker`.
    pub kind: String,
    /// A comment's, an ask's or an answer's words; a status's new status; a link's ref; a snooze's time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// `status`: the status it left.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// `status`: why (what a Waiting item waits on, a close note).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// `edited`: the field (`title`, `description`, `doneMeans`) and its words before and after.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    /// An owner comment's request id: the same request again changes nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<String>,
    /// The original ask for an owner answer, withdrawal, or bot decision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<u64>,
    /// `unsnoozed`: ended before its time by a question or a close, not by the owner.
    #[serde(default, skip_serializing_if = "is_false")]
    pub early: bool,
    /// `worker`: the linked session and how it ended (`done`, `blocked`); `text` is its report's first line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OpenRequest {
    pub id: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemWork {
    pub generation: u64,
    pub requested_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default)]
    pub released: bool,
    /// A late request from an older generation cannot start a new one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub retired: Vec<(String, String)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<OpenRequest>,
    pub effect_key: String,
    /// Receipt for the open effect, not the holder address. Written before main creates a worktree or tab.
    pub accepted_tab: Option<String>,
    /// None while the reserved open has not bound its new saved session.
    pub session: Option<String>,
}

impl ItemWork {
    pub fn receipt(&self, item: &str) -> String {
        if self.released {
            return format!("Item {item} generation {} has no holder.", self.generation);
        }
        let host = self.device.as_deref().unwrap_or("this computer");
        match &self.session {
            Some(path) => format!(
                "Item {item} generation {} held on {host}: {path}.",
                self.generation
            ),
            None => format!(
                "Item {item} generation {} reserved by {} on {host}.",
                self.generation, self.requested_by
            ),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemRecord {
    pub id: String,
    /// The bot's id.
    pub bot: String,
    /// Per bot, from 1.
    pub number: u32,
    /// The bot chat it belongs to: the owner's changes are mailed there.
    pub session: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work: Option<ItemWork>,
    /// Acceptance records stay on the authority, never in a shared board snapshot.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) mail: BTreeMap<String, ItemMail>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_means: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<ItemQuestion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<ItemWait>,
    #[serde(default)]
    pub links: Vec<ItemLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snoozed_until: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    /// Epoch ms of `updated_at`, what staleness is measured from.
    #[serde(default)]
    pub touched: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<String>,
    /// Epoch ms it closed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_note: Option<String>,
    #[serde(default)]
    pub events: Vec<ItemEvent>,
    #[serde(default)]
    pub version: u32,
    /// Read-time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale: Option<bool>,
    /// Read-time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_until: Option<String>,
}

impl ItemRecord {
    pub fn is_open(&self) -> bool {
        is_open(&self.status)
    }

    /// Whether it is snoozed at `now` (epoch ms).
    pub fn snoozed(&self, now: f64) -> bool {
        self.is_open()
            && self
                .snoozed_until
                .as_deref()
                .and_then(parse_iso)
                .is_some_and(|until| until > now)
    }

    pub fn visible_at(&self, now: f64) -> bool {
        self.closed
            .is_none_or(|closed| now - closed < CLOSED_KEPT_MS)
    }

    /// Clone only the v1 window, not an unbounded history that its reader would discard.
    /// Shared board snapshots also omit authority-only `work` and `mail`.
    pub fn v1(&self) -> Self {
        Self {
            id: self.id.clone(),
            bot: self.bot.clone(),
            number: self.number,
            session: self.session.clone(),
            work: None,
            mail: BTreeMap::new(),
            title: self.title.clone(),
            description: self.description.clone(),
            done_means: self.done_means.clone(),
            status: self.status.clone(),
            question: self.question.clone(),
            wait: self.wait.clone(),
            links: self.links.clone(),
            snoozed_until: self.snoozed_until.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            touched: self.touched,
            closed_at: self.closed_at.clone(),
            closed: self.closed,
            close_note: self.close_note.clone(),
            events: self.events[self.events.len().saturating_sub(EVENTS_KEPT)..].to_vec(),
            version: self.version,
            stale: self.stale,
            limit_until: self.limit_until.clone(),
        }
    }

    /// Records one event (newest last); the caller may fill its other fields.
    pub fn event(
        &mut self,
        at: &str,
        actor: &str,
        kind: &str,
        text: Option<&str>,
    ) -> &mut ItemEvent {
        self.events.push(ItemEvent {
            at: at.to_owned(),
            actor: actor.to_owned(),
            kind: kind.to_owned(),
            text: text.map(str::to_owned),
            ..ItemEvent::default()
        });
        self.events.last_mut().expect("an event was just pushed")
    }
}

// Older readers skip this non-item row. If an older writer drops it, number-only writes fail closed.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BoardNumbers {
    pub(super) last_issued: BTreeMap<String, u32>,
}

/// The items.
pub struct Items {
    db: rusqlite::Connection,
    // Held through connection close: another process must never serve a stale cache.
    _writer: Option<File>,
    file: Option<PathBuf>,
    numbers: BoardNumbers,
    items: Vec<ItemRecord>,
    by_id: HashMap<String, usize>,
    last_event: u64,
}

impl Items {
    pub(crate) fn stored_at(&self, file: &std::path::Path) -> bool {
        self.file.as_deref() == Some(file)
    }

    pub(crate) fn bound_worker(
        &self,
        tab: Option<&str>,
        session: Option<&str>,
    ) -> Option<(&str, u64)> {
        self.items.iter().find_map(|item| {
            let work = item.work.as_ref()?;
            if work.released || work.device.is_some() {
                return None;
            }
            let bound = session.is_some_and(|s| work.session.as_deref() == Some(s))
                || tab.is_some_and(|t| work.accepted_tab.as_deref() == Some(t));
            bound.then_some((item.id.as_str(), work.generation))
        })
    }

    pub fn visible(&self, now: f64) -> impl Iterator<Item = &ItemRecord> {
        self.items.iter().filter(move |item| item.visible_at(now))
    }

    pub fn v1(&self, now: f64) -> Vec<ItemRecord> {
        self.visible(now).map(ItemRecord::v1).collect()
    }

    /// The newest event id of `bot`'s items (0 when none): where its Items tab is seen up to once opened.
    pub fn newest_event(&self, bot: &str, now: f64) -> u64 {
        self.visible(now)
            .filter(|item| item.bot == bot)
            .flat_map(|item| item.events.iter().rev().take(EVENTS_KEPT).map(|e| e.id))
            .max()
            .unwrap_or(0)
    }

    pub fn write_address(&self, bot: &str, key: &str) -> Result<&ItemRecord, String> {
        if key.trim().trim_start_matches('#').parse::<u32>().is_ok()
            && !self.numbers.last_issued.contains_key(bot)
        {
            return Err("Use the immutable item id from the list: this board has no complete number history.".into());
        }
        self.find(bot, key)
            .ok_or_else(|| format!("No item \"{key}\" on this bot's board."))
    }

    pub(super) fn last_number(&self, bot: &str) -> u32 {
        if let Some(number) = self.numbers.last_issued.get(bot) {
            return *number;
        }
        self.items
            .iter()
            .filter(|item| item.bot == bot)
            .map(|item| item.number)
            .max()
            .unwrap_or(0)
    }

    pub fn next_number(&self, bot: &str) -> u32 {
        self.last_number(bot).saturating_add(1)
    }

    /// The item of `bot` that `key` names: its number (`3`, `#3`), else its id.
    pub fn find(&self, bot: &str, key: &str) -> Option<&ItemRecord> {
        let key = key.trim();
        let number = key.trim_start_matches('#').parse::<u32>().ok();
        number
            .and_then(|number| {
                self.items
                    .iter()
                    .find(|item| item.bot == bot && item.number == number)
            })
            .or_else(|| self.get(key).filter(|item| item.bot == bot))
    }

    pub fn get(&self, id: &str) -> Option<&ItemRecord> {
        self.by_id.get(id).map(|&at| &self.items[at])
    }

    /// Ids of the items that link `target` (a session's tab id or file).
    pub fn linking(&self, targets: &[&str], now: f64) -> Vec<String> {
        self.visible(now)
            .filter(|item| {
                item.links
                    .iter()
                    .any(|link| link.kind == "session" && targets.contains(&link.target.as_str()))
            })
            .map(|item| item.id.clone())
            .collect()
    }
}

/// Epoch ms of an ISO time (`YYYY-MM-DD[THH:MM[:SS[.mmm]]][Z|±HH:MM]`; no zone reads as UTC); None when it is none.
pub fn parse_iso(text: &str) -> Option<f64> {
    let text = text.trim().trim_end_matches('Z');
    let (date, time) = text.split_once('T').unwrap_or((text, "00:00:00"));
    // A zone after the time: `+09:00` is nine hours ahead of UTC.
    let (time, offset_ms) = match time.find(['+', '-']) {
        Some(at) => {
            let zone = &time[at + 1..];
            let (hours, minutes) = zone.split_once(':').unwrap_or((zone, "0"));
            let size =
                hours.parse::<f64>().ok()? * 3_600_000.0 + minutes.parse::<f64>().ok()? * 60_000.0;
            let ahead = time.as_bytes()[at] == b'+';
            (&time[..at], if ahead { size } else { -size })
        }
        None => (time, 0.0),
    };
    let mut parts = date.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut clock = time.split(':');
    let hours: f64 = clock.next()?.parse().ok()?;
    let minutes: f64 = clock.next().unwrap_or("0").parse().ok()?;
    let seconds: f64 = clock.next().unwrap_or("0").parse().ok()?;
    if clock.next().is_some() || hours >= 24.0 || minutes >= 60.0 || seconds >= 61.0 {
        return None;
    }
    // Howard Hinnant's `days_from_civil`.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(
        days as f64 * 86_400_000.0 + (hours * 3_600.0 + minutes * 60.0 + seconds) * 1_000.0
            - offset_ms,
    )
}
