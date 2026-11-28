//! A bot's items (`src/shared/bots.ts` `Item`): what it works on for its owner and what it needs from them. Kept in
//! `<userData>/items.json` (mode 0o600, one JSON array, written whole on every change); a closed item leaves it
//! `CLOSED_KEPT_MS` after it closed.
//!
//! Every event has an id, counted across all items (Orca's `e<n>`, `bot-items.ts`): an item's question names the
//! event that asked it, an answer the question it answers, and a bot's Items tab is seen up to an id. The store
//! stamps a new event (id 0) as it saves the change that made it.
//!
//! What an item does not hold is read when the state is listed (`service/work/items.rs`): `stale`, `limitUntil` and
//! each linked session's `state`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::ser::{SerializeSeq, Serializer};
use serde::{Deserialize, Serialize};

use super::read_array;
use crate::disk::saves::{SAVES, Saves};

mod mail;
pub(crate) use mail::{ItemMail, ItemMailState};

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
/// Days a closed item stays (`ITEM_CLOSED_KEPT_DAYS`), in ms.
pub const CLOSED_KEPT_MS: f64 = 7.0 * 24.0 * 60.0 * 60_000.0;
/// Newest events an item keeps.
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
#[serde(rename_all = "camelCase")]
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
pub struct ItemWait {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    /// When it was set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
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
#[serde(rename_all = "camelCase")]
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

    /// Records one event (newest last, `EVENTS_KEPT` kept); the caller may fill its other fields.
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
        let extra = self.events.len().saturating_sub(EVENTS_KEPT);
        self.events.drain(..extra);
        self.events.last_mut().expect("an event was just pushed")
    }

    /// Whether an owner change with this request id was already taken.
    pub fn has_request(&self, request: &str) -> bool {
        self.events
            .iter()
            .any(|event| event.request.as_deref() == Some(request))
    }
}

/// Gives every unsaved event of `item` the next id, and a question asked by this change the id of its ask.
fn stamp(item: &mut ItemRecord, next: &mut u64) {
    for event in item.events.iter_mut().filter(|event| event.id == 0) {
        *next += 1;
        event.id = *next;
    }
    if let Some(question) = item.question.as_mut().filter(|question| question.id == 0) {
        question.id = item
            .events
            .iter()
            .rev()
            .find(|event| event.kind == "asked")
            .or(item.events.last())
            .map_or(0, |event| event.id);
    }
}

// Older readers skip this non-item row. If an older writer drops it, number-only writes fail closed.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoardNumbers {
    last_issued: BTreeMap<String, u32>,
}

/// The items.
pub struct Items {
    file: Option<PathBuf>,
    pub(crate) saves: Arc<Saves>,
    items: Vec<ItemRecord>,
    numbers: BoardNumbers,
    /// The newest event id given.
    last_event: u64,
}

impl Items {
    pub fn new(file: Option<PathBuf>) -> Items {
        let mut numbers = BoardNumbers::default();
        let mut items = Vec::new();
        for row in file.as_deref().map(read_array).unwrap_or_default() {
            if row.get("lastIssued").is_some() {
                numbers = serde_json::from_value(row).unwrap_or_default();
            } else if let Ok(item) = serde_json::from_value::<ItemRecord>(row)
                && !item.id.is_empty()
                && !item.bot.is_empty()
            {
                items.push(item);
            }
        }
        for item in &items {
            if numbers
                .last_issued
                .get(&item.bot)
                .is_some_and(|n| *n < item.number)
            {
                numbers.last_issued.remove(&item.bot);
            }
        }
        let mut last_event = items
            .iter()
            .flat_map(|item| item.events.iter().map(|event| event.id))
            .max()
            .unwrap_or(0);
        // A file written before events had ids: each gets one, in the order they are kept.
        for item in &mut items {
            stamp(item, &mut last_event);
        }
        Items {
            file,
            items,
            numbers,
            last_event,
            saves: Arc::clone(&SAVES),
        }
    }

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

    /// Every item, closed ones past `CLOSED_KEPT_MS` dropped first.
    pub fn all(&mut self, now: f64) -> &[ItemRecord] {
        let before = self.items.len();
        self.items.retain(|item| {
            item.closed
                .is_none_or(|closed| now - closed < CLOSED_KEPT_MS)
        });
        if self.items.len() != before {
            self.save();
        }
        &self.items
    }

    /// The newest event id of `bot`'s items (0 when none): where its Items tab is seen up to once opened.
    pub fn newest_event(&self, bot: &str) -> u64 {
        self.items
            .iter()
            .filter(|item| item.bot == bot)
            .flat_map(|item| item.events.iter().map(|event| event.id))
            .max()
            .unwrap_or(0)
    }

    pub fn new_board(&mut self, bot: &str) {
        // Another call can publish the first item between bot registration and this notification.
        if self.numbers.last_issued.contains_key(bot)
            || self.items.iter().any(|item| item.bot == bot)
        {
            return;
        }
        self.numbers.last_issued.insert(bot.to_owned(), 0);
        self.save();
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

    fn last_number(&self, bot: &str) -> u32 {
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

    /// The item of `bot` that `key` names: its number (`3`, `#3`), else its id.
    pub fn find(&self, bot: &str, key: &str) -> Option<&ItemRecord> {
        let key = key.trim();
        let number = key.trim_start_matches('#').parse::<u32>().ok();
        self.items
            .iter()
            .find(|item| item.bot == bot && Some(item.number) == number)
            .or_else(|| {
                self.items
                    .iter()
                    .find(|item| item.bot == bot && item.id == key)
            })
    }

    pub fn get(&self, id: &str) -> Option<&ItemRecord> {
        self.items.iter().find(|item| item.id == id)
    }

    /// Ids of the items that link `target` (a session's tab id or file).
    pub fn linking(&self, targets: &[&str]) -> Vec<String> {
        self.items
            .iter()
            .filter(|item| {
                item.links
                    .iter()
                    .any(|link| link.kind == "session" && targets.contains(&link.target.as_str()))
            })
            .map(|item| item.id.clone())
            .collect()
    }

    pub fn add(&mut self, mut item: ItemRecord) -> Result<ItemRecord, String> {
        let previous = self.last_number(&item.bot);
        item.number = previous
            .checked_add(1)
            .ok_or("This board has used every item number.")?;
        let previous_event = self.last_event;
        stamp(&mut item, &mut self.last_event);
        if let Some(last) = self.numbers.last_issued.get_mut(&item.bot) {
            *last = item.number;
        }
        self.items.push(item);
        if self.file.is_some()
            && let Err(error) = self.commit()
        {
            let item = self.items.pop().expect("item just added");
            if let Some(last) = self.numbers.last_issued.get_mut(&item.bot) {
                *last = previous;
            }
            self.last_event = previous_event;
            return Err(error);
        }
        Ok(self.items.last().expect("item just added").clone())
    }

    /// Changes item `id` and saves; its record as it is now.
    pub fn change(&mut self, id: &str, change: impl FnOnce(&mut ItemRecord)) -> Option<ItemRecord> {
        let item = self.items.iter_mut().find(|item| item.id == id)?;
        change(item);
        stamp(item, &mut self.last_event);
        let changed = item.clone();
        self.save();
        Some(changed)
    }

    /// Drops every item of `bot`.
    pub fn remove_bot(&mut self, bot: &str) {
        let before = self.items.len();
        self.items.retain(|item| item.bot != bot);
        if self.numbers.last_issued.remove(bot).is_some() || self.items.len() != before {
            self.save();
        }
    }

    pub fn commit_work(&mut self, id: &str, work: ItemWork) -> Result<(), String> {
        let index = self
            .items
            .iter()
            .position(|item| item.id == id)
            .ok_or("That item is gone.")?;
        let old = self.items[index].work.replace(work);
        let saved = self.commit();
        if saved.is_err() {
            self.items[index].work = old;
        }
        saved
    }

    fn bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        let mut bytes = Vec::new();
        let mut writer = serde_json::Serializer::new(&mut bytes);
        let mut rows = writer.serialize_seq(None)?;
        for item in &self.items {
            rows.serialize_element(item)?;
        }
        if !self.numbers.last_issued.is_empty() {
            rows.serialize_element(&self.numbers)?;
        }
        rows.end()?;
        Ok(bytes)
    }

    fn commit(&self) -> Result<(), String> {
        let file = self.file.as_ref().ok_or("No durable item journal.")?;
        let bytes = self.bytes().map_err(|error| error.to_string())?;
        self.saves
            .commit(file, &bytes, 0o600)
            .map_err(|error| error.message)
    }

    fn save(&self) {
        let Some(file) = &self.file else { return };
        let saved = self
            .bytes()
            .map_err(|error| error.to_string())
            .and_then(|bytes| {
                self.saves
                    .write(file, &bytes, Some(0o600), 0o777)
                    .map_err(|error| error.message)
            });
        if let Err(error) = saved {
            eprintln!("[items] not saved: {error}");
        }
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
