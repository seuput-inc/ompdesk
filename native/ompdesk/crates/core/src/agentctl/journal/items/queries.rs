//! Read-side indexes share the writer's lifetime. They can be rebuilt from current rows and their
//! bounded tails; archived events and the original JSON are never rewritten for these queries.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::io;
use std::ops::Bound::{Excluded, Included, Unbounded};

use rusqlite::OptionalExtension;
use serde_json::{Map, Value, json};

use super::storage::sql;
use super::{ItemRecord, Items, parse_iso};

const PAGE: usize = 50;
const CHANGE_WINDOW: usize = 512;

fn millis(iso: &str) -> Option<i64> {
    // Legacy timestamps are strings, not validated Dates. Bound the civil-year arithmetic too.
    if iso.trim().split_once('-')?.0.len() > 6 {
        return None;
    }
    parse_iso(iso)
        .filter(|at| at.abs() <= 8_640_000_000_000_000.0)
        .map(|at| at as i64)
}

fn others_last(item: &ItemRecord) -> u64 {
    item.events
        .iter()
        .filter(|e| e.actor != "owner")
        .map(|e| e.id)
        .max()
        .unwrap_or(0)
}

fn summary(item: &ItemRecord) -> Value {
    let asked_at = item.question.as_ref().and_then(|q| {
        let ask = item
            .events
            .iter()
            .rfind(|e| e.kind == "asked" && (q.id == 0 || e.id == q.id))?;
        millis(&ask.at)
    });
    let mut row = json!({
        "id":item.id, "bot":item.bot, "number":item.number, "session":item.session,
        "title":item.title, "status":item.status, "version":item.version, "createdAt":item.created_at,
        "updatedAt":item.updated_at, "touched":item.touched, "askedAt":asked_at,
        "lastEvent":item.events.iter().map(|e| e.id).max().unwrap_or(0), "othersLast":others_last(item)
    });
    row["sessionLinks"] = Value::Array(
        item.links
            .iter()
            .filter(|link| link.kind == "session")
            .map(|link| Value::String(link.target.clone()))
            .collect(),
    );
    if let Some(q) = &item.question {
        row["question"] = json!(q);
    }
    if let Some(wait) = &item.wait {
        row["wait"] = json!(wait);
    }
    if let Some(until) = &item.snoozed_until {
        row["snoozedUntil"] = json!(until);
    }
    if let Some(at) = &item.closed_at {
        row["closedAt"] = json!(at);
    }
    if let Some(closed) = item.closed {
        row["closed"] = json!(closed);
    }
    row
}

type Order = (i64, u32);

struct Archived {
    id: String,
    at: i64,
    wake: Option<i64>,
    others: u64,
}

#[derive(Default)]
struct BotIndex {
    open: HashSet<String>,
    latest_event: u64,
    by_session: HashMap<String, HashSet<String>>,
    archive_revision: u64,
    closed: HashMap<u32, Archived>,
    by_time: BTreeSet<Order>,
    by_wake: BTreeSet<Order>,
    by_unread: BTreeSet<(u64, u32)>,
}

impl BotIndex {
    fn update_links(&mut self, old: Option<&ItemRecord>, new: Option<&ItemRecord>) {
        if old.map(|i| &i.links) == new.map(|i| &i.links) {
            return;
        }
        if let Some(item) = old {
            for link in item.links.iter().filter(|l| l.kind == "session") {
                if let Some(rows) = self.by_session.get_mut(&link.target) {
                    rows.remove(&item.id);
                    if rows.is_empty() {
                        self.by_session.remove(&link.target);
                    }
                }
            }
        }
        if let Some(item) = new {
            for link in item.links.iter().filter(|l| l.kind == "session") {
                let rows = self.by_session.entry(link.target.clone()).or_default();
                if !rows.contains(&item.id) {
                    rows.insert(item.id.clone());
                }
            }
        }
    }

    fn insert(&mut self, item: &ItemRecord) -> Option<i64> {
        if item.is_open() {
            self.open.insert(item.id.clone());
            return None;
        }
        let n = item.number;
        let at = millis(&item.updated_at).unwrap_or(0);
        let wake = item
            .snoozed_until
            .as_deref()
            .and_then(millis)
            .filter(|w| *w > at);
        let others = others_last(item);
        self.by_time.insert((at, n));
        if let Some(w) = wake {
            self.by_wake.insert((w, n));
        }
        self.by_unread.insert((others, n));
        self.closed.insert(
            n,
            Archived {
                id: item.id.clone(),
                at,
                wake,
                others,
            },
        );
        wake
    }

    fn remove(&mut self, item: &ItemRecord) -> Option<i64> {
        if item.is_open() {
            self.open.remove(&item.id);
            None
        } else {
            let n = item.number;
            let entry = self.closed.remove(&n).expect("indexed closed item");
            self.by_time.remove(&(entry.at, n));
            if let Some(w) = entry.wake {
                self.by_wake.remove(&(w, n));
            }
            self.by_unread.remove(&(entry.others, n));
            entry.wake
        }
    }

    fn counts(&self) -> Value {
        json!({"openCount":self.open.len(), "closedTotal":self.closed.len(), "archiveRevision":self.archive_revision})
    }
}

struct Change {
    id: Option<String>,
    counts_for: Option<String>,
}

#[derive(Default)]
pub(super) struct Feed {
    bots: HashMap<String, BotIndex>,
    revision: u64,
    changes: VecDeque<Change>,
    // Current writers clear snoozes on close; an imported row can still move as time passes.
    wakes: BTreeMap<i64, HashMap<String, String>>,
    clock: Option<i64>,
}

impl Feed {
    pub(super) fn load(items: &[ItemRecord]) -> Self {
        let mut feed = Self::default();
        for item in items {
            let index = feed.bots.entry(item.bot.clone()).or_default();
            index.update_links(None, Some(item));
            if let Some(last) = item.events.iter().map(|e| e.id).max() {
                index.latest_event = index.latest_event.max(last);
            }
            if let Some(wake) = index.insert(item) {
                feed.wakes
                    .entry(wake)
                    .or_default()
                    .insert(item.id.clone(), item.bot.clone());
            }
        }
        feed
    }

    pub(super) fn change(&mut self, old: Option<&ItemRecord>, new: Option<&ItemRecord>) {
        let row = new.or(old).expect("an item change has a row");
        self.revision += 1;
        let was = old.map(ItemRecord::is_open);
        let is = new.map(ItemRecord::is_open);
        let index = if old.is_some() {
            self.bots.get_mut(&row.bot).expect("indexed item bot")
        } else {
            self.bots.entry(row.bot.clone()).or_default()
        };
        index.update_links(old, new);
        if let Some(last) = new.and_then(|i| i.events.last()) {
            index.latest_event = index.latest_event.max(last.id);
        }
        let counts_for = if was != is || is == Some(false) {
            if let Some(wake) = old.and_then(|item| index.remove(item)) {
                let entries = self.wakes.get_mut(&wake).expect("indexed archive wake");
                entries.remove(&row.id);
                if entries.is_empty() {
                    self.wakes.remove(&wake);
                }
            }
            if let Some(wake) = new.and_then(|item| index.insert(item)) {
                self.wakes
                    .entry(wake)
                    .or_default()
                    .insert(row.id.clone(), row.bot.clone());
            }
            if was == Some(false) || is == Some(false) {
                index.archive_revision = self.revision;
            }
            if index.open.is_empty() && index.closed.is_empty() {
                self.bots.remove(&row.bot);
            }
            Some(row.bot.clone())
        } else {
            None
        };
        self.push_change(Some(row.id.clone()), counts_for);
    }

    fn push_change(&mut self, id: Option<String>, counts_for: Option<String>) {
        if self.changes.len() == CHANGE_WINDOW {
            self.changes.pop_front();
        }
        self.changes.push_back(Change { id, counts_for });
    }
}

impl Items {
    /// Bot prompts list only this bot's open rows, in their original insertion order.
    pub fn bot_open(&self, bot: &str) -> impl Iterator<Item = &ItemRecord> {
        let mut positions: Vec<_> = self
            .feed
            .bots
            .get(bot)
            .into_iter()
            .flat_map(|idx| idx.open.iter().map(|id| self.by_id[id]))
            .collect();
        positions.sort_unstable();
        positions.into_iter().map(|at| &self.items[at])
    }

    pub fn latest_event(&self, bot: &str) -> u64 {
        self.feed.bots.get(bot).map_or(0, |idx| idx.latest_event)
    }

    fn linked_rows<'a>(
        &self,
        indexes: impl Iterator<Item = &'a BotIndex> + Clone,
        targets: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> BTreeSet<usize> {
        let mut rows = BTreeSet::new();
        for target in targets {
            for index in indexes.clone() {
                if let Some(ids) = index.by_session.get(target.as_ref()) {
                    rows.extend(ids.iter().map(|id| self.by_id[id]));
                }
            }
        }
        rows
    }

    /// The v1 runtime settles links and records worker reports only on retained rows.
    pub fn linking(
        &self,
        targets: impl IntoIterator<Item = impl AsRef<str>>,
        now: f64,
    ) -> Vec<String> {
        self.linked_rows(self.feed.bots.values(), targets)
            .into_iter()
            .map(|at| &self.items[at])
            .filter(|item| item.visible_at(now))
            .map(|item| item.id.clone())
            .collect()
    }

    pub fn items_linked(&self, bot: &str, sessions: &[&str]) -> Value {
        let Some(index) = self.feed.bots.get(bot) else {
            return json!({"links":[]});
        };
        let wanted: HashSet<_> = sessions.iter().copied().collect();
        let rows = self.linked_rows(std::iter::once(index), &wanted);
        let mut links = Vec::new();
        for at in rows {
            let item = &self.items[at];
            for link in &item.links {
                if link.kind == "session" && wanted.contains(link.target.as_str()) {
                    links.push(
                        json!({"session":link.target,"number":item.number,"title":item.title}),
                    );
                }
            }
        }
        let mut reply = json!({});
        reply["links"] = Value::Array(links);
        reply
    }

    pub fn feed_revision(&self) -> u64 {
        self.feed.revision
    }

    pub fn refresh_archive_clock(&mut self, now: f64) -> bool {
        let now = now.floor() as i64;
        let feed = &mut self.feed;
        let Some(previous) = feed.clock.replace(now) else {
            return false;
        };
        if now == previous || feed.wakes.is_empty() {
            return false;
        }
        let crossed = (Excluded(now.min(previous)), Included(now.max(previous)));
        let mut affected = HashSet::new();
        for (_, entries) in feed.wakes.range(crossed) {
            for bot in entries.values() {
                if !affected.contains(bot) {
                    affected.insert(bot.clone());
                }
            }
        }
        let changed = !affected.is_empty();
        for bot in affected {
            feed.revision += 1;
            feed.bots
                .get_mut(&bot)
                .expect("indexed archive bot")
                .archive_revision = feed.revision;
            feed.push_change(None, Some(bot));
        }
        changed
    }

    pub fn feed_rows(&self, since: Option<u64>) -> Value {
        let feed = &self.feed;
        let changes = since
            .and_then(|base| feed.revision.checked_sub(base))
            .filter(|n| *n <= feed.changes.len() as u64);
        let Some(n) = changes else {
            let open: Vec<_> = self
                .items
                .iter()
                .filter(|i| i.is_open())
                .map(summary)
                .collect();
            let counts: Map<_, _> = feed
                .bots
                .iter()
                .map(|(b, idx)| (b.clone(), idx.counts()))
                .collect();
            let mut seed = json!({});
            seed["open"] = Value::Array(open);
            seed["counts"] = Value::Object(counts);
            return seed;
        };
        let mut ids = HashSet::new();
        let mut counts = Map::new();
        let mut set = Vec::new();
        let mut remove = Vec::new();
        for (offset, change) in feed.changes.iter().rev().take(n as usize).enumerate() {
            if let Some(b) = &change.counts_for
                && !counts.contains_key(b)
            {
                let absolute = feed.bots.get(b).map_or_else(
                    || json!({"openCount":0,"closedTotal":0,"archiveRevision":feed.revision - offset as u64}),
                    BotIndex::counts,
                );
                counts.insert(b.clone(), absolute);
            }
            if let Some(id) = &change.id
                && ids.insert(id)
            {
                match self.by_id.get(id) {
                    Some(&at) if self.items[at].is_open() => set.push(at),
                    _ => remove.push(Value::String(id.clone())),
                }
            }
        }
        set.sort_unstable();
        let mut delta = json!({});
        delta["set"] = Value::Array(set.into_iter().map(|i| summary(&self.items[i])).collect());
        delta["remove"] = Value::Array(remove);
        delta["counts"] = Value::Object(counts);
        delta
    }

    pub fn items_page(
        &self,
        bot: &str,
        before: Option<(f64, u32)>,
        unread_since: Option<u64>,
        now: f64,
    ) -> Value {
        let mut page = json!({"closed":[],"closedTotal":0,"next":null});
        if unread_since.is_some() {
            page["unreadTotal"] = json!(0);
        }
        let Some(index) = self.feed.bots.get(bot) else {
            return page;
        };
        page["closedTotal"] = json!(index.closed.len());
        let now = now.floor() as i64;
        let upper = before.map_or(Unbounded, |(at, n)| Excluded((at as i64, n)));
        let mut rows = BTreeSet::new();
        if let Some(since) = unread_since {
            let mut unread = 0;
            for &(_, n) in index
                .by_unread
                .range((Excluded((since, u32::MAX)), Unbounded))
            {
                unread += 1;
                let entry = &index.closed[&n];
                let key = (entry.wake.filter(|w| *w <= now).unwrap_or(entry.at), n);
                if matches!(upper, Excluded(end) if key >= end) {
                    continue;
                }
                rows.insert(key);
                if rows.len() > PAGE + 1 {
                    rows.pop_first();
                }
            }
            page["unreadTotal"] = json!(unread);
        } else {
            rows.extend(
                index
                    .by_time
                    .range((Unbounded, upper))
                    .rev()
                    .filter(|(_, n)| index.closed[n].wake.is_none_or(|w| w > now))
                    .take(PAGE + 1)
                    .copied(),
            );
            let wake_end = match upper {
                Excluded(k) if k <= (now, u32::MAX) => Excluded(k),
                _ => std::ops::Bound::Included((now, u32::MAX)),
            };
            rows.extend(
                index
                    .by_wake
                    .range((Unbounded, wake_end))
                    .rev()
                    .take(PAGE + 1)
                    .copied(),
            );
        }
        let more = rows.len() > PAGE;
        let closed: Vec<_> = rows
            .into_iter()
            .rev()
            .take(PAGE)
            .enumerate()
            .map(|(i, (at, n))| {
                if i + 1 == PAGE && more {
                    page["next"] = json!({"at":at,"number":n});
                }
                summary(&self.items[self.by_id[&index.closed[&n].id]])
            })
            .collect();
        page["closed"] = Value::Array(closed);
        page
    }

    fn numbered(&self, bot: &str, number: u32) -> io::Result<Option<&ItemRecord>> {
        let mut stmt = self
            .db
            .prepare("SELECT id FROM item WHERE bot=?1 AND number=?2")
            .map_err(sql)?;
        let mut rows = stmt.query((bot, number)).map_err(sql)?;
        let Some(row) = rows.next().map_err(sql)? else {
            return Ok(None);
        };
        let id = row
            .get_ref(0)
            .map_err(sql)?
            .as_str()
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        self.get(id)
            .map(Some)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing current item"))
    }

    /// Bot tools resolve a number (`3`, `#3`) first and then a literal item id.
    pub fn find(&self, bot: &str, key: &str) -> io::Result<Option<&ItemRecord>> {
        let key = key.trim();
        if let Ok(number) = key.trim_start_matches('#').parse::<u32>()
            && let Some(item) = self.numbered(bot, number)?
        {
            return Ok(Some(item));
        }
        Ok(self.get(key).filter(|item| item.bot == bot))
    }

    fn scoped_item(&self, bot: &str, key: &Value) -> io::Result<&ItemRecord> {
        let row = if let Some(id) = key.as_str() {
            self.get(id).filter(|i| i.bot == bot)
        } else if let Some(number) = key.as_u64().and_then(|n| u32::try_from(n).ok()) {
            self.numbered(bot, number)?
        } else {
            None
        };
        row.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "item not found for this bot"))
    }

    pub fn item_detail(
        &self,
        bot: &str,
        key: &Value,
        before: Option<u64>,
        after: Option<u64>,
    ) -> io::Result<Value> {
        let item = self.scoped_item(bot, key)?;
        let bad_cursor =
            || io::Error::new(io::ErrorKind::InvalidInput, "invalid item event cursor");
        if before.is_some() && after.is_some() {
            return Err(bad_cursor());
        }
        let pos: i64 = match before.or(after) {
            None => i64::MAX,
            Some(0) if after.is_some() => -1,
            Some(id) => self
                .db
                .query_row(
                    "SELECT position FROM item_event WHERE item=?1 AND id=?2",
                    (&item.id, i64::try_from(id).map_err(|_| bad_cursor())?),
                    |r| r.get(0),
                )
                .optional()
                .map_err(sql)?
                .ok_or_else(bad_cursor)?,
        };
        let query = if after.is_some() {
            "SELECT event_json,position FROM item_event WHERE item=?1 AND position>?2 ORDER BY position LIMIT ?3"
        } else if before.is_some() {
            "SELECT event_json,position FROM item_event WHERE item=?1 AND position<?2 ORDER BY position DESC LIMIT ?3"
        } else {
            "SELECT event_json,position FROM item_event WHERE item=?1 AND position<=?2 ORDER BY position DESC LIMIT ?3"
        };
        let mut stmt = self.db.prepare(query).map_err(sql)?;
        let mut rows = stmt.query((&item.id, pos, PAGE as i64)).map_err(sql)?;
        let mut events = Vec::<Value>::new();
        let mut positions = (None, None);
        while let Some(row) = rows.next().map_err(sql)? {
            let text: String = row.get(0).map_err(sql)?;
            let position: i64 = row.get(1).map_err(sql)?;
            positions.0.get_or_insert(position);
            positions.1 = Some(position);
            events.push(serde_json::from_str(&text)?);
        }
        if after.is_none() {
            events.reverse();
            positions = (positions.1, positions.0);
        }
        let (older,newer): (bool,bool) = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM item_event WHERE item=?1 AND position<?2), EXISTS(SELECT 1 FROM item_event WHERE item=?1 AND position>?3)",
            (&item.id,positions.0,positions.1), |r| Ok((r.get(0)?,r.get(1)?)),
        ).map_err(sql)?;
        let mut known: HashSet<u64> = events.iter().filter_map(|e| e["id"].as_u64()).collect();
        let mut asks = Vec::<Value>::new();
        for id in events.iter().filter_map(|e| e["question"].as_u64()) {
            if !known.insert(id) {
                continue;
            }
            let Ok(id) = i64::try_from(id) else {
                continue;
            };
            let text: Option<String> = self.db.query_row(
                "SELECT event_json FROM item_event WHERE item=?1 AND id=?2 AND json_extract(event_json,'$.kind')='asked'",
                (&item.id, id), |r| r.get(0),
            ).optional().map_err(sql)?;
            if let Some(text) = text {
                asks.push(serde_json::from_str(&text)?);
            }
        }
        let text: String = self
            .db
            .query_row(
                "SELECT json_remove(current_json,'$.events','$.work','$.mail') FROM item WHERE id=?1",
                [&item.id],
                |r| r.get(0),
            )
            .map_err(sql)?;
        let metadata: Value = serde_json::from_str(&text)?;
        let before = events.first().filter(|_| older).map(|e| &e["id"]);
        let after = events.last().filter(|_| newer).map(|e| &e["id"]);
        let mut detail = json!({"beforeEvent":before,"afterEvent":after});
        detail["item"] = metadata;
        detail["events"] = Value::Array(events);
        detail["asks"] = Value::Array(asks);
        Ok(detail)
    }

    pub fn item_receipt(
        &self,
        bot: &str,
        key: &Value,
        request: &str,
        question: Option<u64>,
    ) -> io::Result<Value> {
        let item = self.scoped_item(bot, key)?;
        // Older binaries wrote just the request on the event. This is the (item,request) index,
        // not a scan of history. An answer for a different question is never a successful retry.
        let mut stmt = self.db.prepare(
            "SELECT json_extract(event_json,'$.kind'),json_extract(event_json,'$.question')
             FROM item_event INDEXED BY item_legacy_request
             WHERE item=?1 AND request=?2 AND json_extract(event_json,'$.actor')='owner' ORDER BY position",
        ).map_err(sql)?;
        let mut rows = stmt.query((&item.id, request)).map_err(sql)?;
        while let Some(row) = rows.next().map_err(sql)? {
            let kind: String = row.get(0).map_err(sql)?;
            let asked: Option<u64> = row
                .get::<_, Option<i64>>(1)
                .map_err(sql)?
                .and_then(|n| u64::try_from(n).ok());
            match kind.as_str() {
                "answered" if question.is_none() || asked == question => {
                    return Ok(json!({"outcome":"answered"}));
                }
                "answered" => return Ok(json!({"outcome":"unknown"})),
                "commented" if question.is_none() || asked == question => {
                    return Ok(json!({"outcome":"commented"}));
                }
                _ => {}
            }
        }
        let question_id = match question {
            Some(q) => match i64::try_from(q) {
                Ok(n) => Some(n),
                Err(_) => return Ok(json!({"outcome":"unknown"})),
            },
            None => None,
        };
        let outcome: String = self.db.query_row(
            "SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(result_json,'$.refusedItems')
                WHERE value->>0=?2 AND value->>1=?3 AND (?4 IS NULL OR value->>2 IS ?4)) THEN 'question_changed'
              WHEN ?4 IS NULL AND EXISTS (SELECT 1 FROM json_each(result_json,'$.changed')
                WHERE value->>'bot'=?2 AND value->>'id'=?3) THEN 'changed'
              ELSE 'unknown' END FROM item_request WHERE id=?1",
            (request, bot, &item.id, question_id), |r| r.get(0),
        ).optional().map_err(sql)?.unwrap_or_else(|| "unknown".into());
        Ok(json!({"outcome":outcome}))
    }
}
