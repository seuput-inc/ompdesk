use std::collections::HashSet;
use std::io;
use std::path::PathBuf;

use rusqlite::{ErrorCode, OptionalExtension, Transaction, params};
use serde::Serialize;

use super::{EVENTS_KEPT, ItemRecord, ItemWork, Items};
use crate::agentctl::rules::mail::Mail;

#[path = "open.rs"]
mod open;

fn sql(error: rusqlite::Error) -> io::Error {
    let kind = match error.sqlite_error_code() {
        Some(ErrorCode::DiskFull) => io::ErrorKind::StorageFull,
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => io::ErrorKind::WouldBlock,
        Some(
            ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase | ErrorCode::ConstraintViolation,
        ) => io::ErrorKind::InvalidData,
        _ => io::ErrorKind::Other,
    };
    io::Error::new(kind, error)
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn stamp(item: &mut ItemRecord, start: usize, next: &mut u64) -> io::Result<()> {
    for event in &mut item.events[start..] {
        if event.id == 0 {
            if *next >= i64::MAX as u64 {
                return Err(invalid("item event id exhausted"));
            }
            *next += 1;
            event.id = *next;
        }
    }
    if let Some(question) = item.question.as_mut().filter(|q| q.id == 0) {
        question.id = item
            .events
            .iter()
            .rev()
            .find(|e| e.kind == "asked")
            .or(item.events.last())
            .map_or(0, |e| e.id);
    }
    Ok(())
}

/// The current row carries no history. Append only the supplied suffix; restore the v1 tail by move.
fn save_row(
    tx: &Transaction<'_>,
    item: &mut ItemRecord,
    start: usize,
    insert: bool,
) -> io::Result<()> {
    let mut events = std::mem::take(&mut item.events);
    let row = serde_json::to_string(item)?;
    if insert {
        tx.execute(
            "INSERT INTO item(id,bot,number,current_json) VALUES (?1,?2,?3,?4)",
            params![item.id, item.bot, item.number, row],
        )
        .map_err(sql)?;
    } else if tx
        .execute(
            "UPDATE item SET current_json=?2 WHERE id=?1",
            (&item.id, row),
        )
        .map_err(sql)?
        != 1
    {
        return Err(invalid("missing item during update"));
    }
    if start < events.len() {
        let mut append = tx
            .prepare("INSERT INTO item_event(id,item,position,event_json) VALUES (?1,?2,?3,?4)")
            .map_err(sql)?;
        for (offset, event) in events[start..].iter().enumerate() {
            let id = i64::try_from(event.id).map_err(|_| invalid("item event id out of range"))?;
            // Initial rows keep their array offsets. A later global id exceeds every initial offset.
            let position = if insert { offset as i64 } else { id };
            append
                .execute((id, &item.id, position, serde_json::to_string(event)?))
                .map_err(sql)?;
        }
    }
    if events.len() > EVENTS_KEPT {
        events = events.split_off(events.len() - EVENTS_KEPT);
    }
    item.events = events;
    Ok(())
}

fn update(
    tx: &Transaction<'_>,
    old: &ItemRecord,
    item: &mut ItemRecord,
    next: &mut u64,
) -> io::Result<()> {
    if item.id != old.id
        || item.bot != old.bot
        || item.number != old.number
        || !item.events.starts_with(&old.events)
    {
        return Err(invalid("cannot replace item identity or event history"));
    }
    let start = old.events.len();
    if item.events[start..].iter().any(|e| e.id != 0) {
        return Err(invalid("a new item event already has an id"));
    }
    stamp(item, start, next)?;
    save_row(tx, item, start, false)
}

#[cfg(test)]
impl Items {
    /// Refuse every mail insert on this connection until it closes.
    pub(crate) fn fail_next_owner_mail(&self) -> io::Result<()> {
        self.db
            .execute_batch(
                "CREATE TEMP TRIGGER refuse_mail BEFORE INSERT ON item_mail
                 BEGIN SELECT raise(ABORT,'injected owner mail write failure'); END;",
            )
            .map_err(sql)
    }

    /// Toggle synthetic disk-full failures on item table writes.
    pub(crate) fn set_fail_writes(&self, fail: bool) -> io::Result<()> {
        if fail {
            self.db
                .execute_batch(
                    "CREATE TEMP TRIGGER IF NOT EXISTS refuse_item_insert BEFORE INSERT ON item
                     BEGIN SELECT raise(ABORT,'ENOSPC: test disk is full'); END;
                     CREATE TEMP TRIGGER IF NOT EXISTS refuse_item_update BEFORE UPDATE ON item
                     BEGIN SELECT raise(ABORT,'ENOSPC: test disk is full'); END;",
                )
                .map_err(sql)
        } else {
            self.db
                .execute_batch(
                    "DROP TRIGGER IF EXISTS refuse_item_insert;
                     DROP TRIGGER IF EXISTS refuse_item_update;",
                )
                .map_err(sql)
        }
    }

    /// Read committed rows directly from SQLite (asserting no open transaction).
    pub(crate) fn committed_rows(&self) -> Vec<ItemRecord> {
        assert!(self.db.is_autocommit(), "expected committed item state");
        let mut stmt = self
            .db
            .prepare("SELECT current_json FROM item ORDER BY ordinal")
            .unwrap();
        let mut rows = stmt.query([]).unwrap();
        let mut out = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            let text: String = row.get(0).unwrap();
            out.push(serde_json::from_str(&text).unwrap());
        }
        out
    }

    /// Read one committed row directly from SQLite (asserting no open transaction).
    pub(crate) fn committed_get(&self, id: &str) -> Option<ItemRecord> {
        assert!(self.db.is_autocommit(), "expected committed item state");
        let text: Option<String> = self
            .db
            .query_row("SELECT current_json FROM item WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .unwrap();
        text.map(|t| serde_json::from_str(&t).unwrap())
    }
}

#[derive(Serialize)]
struct Changed<'a> {
    id: &'a str,
    version: u32,
}

#[derive(Serialize)]
struct Outcome<'a> {
    ids: &'a [&'a str],
    changed: Vec<Changed<'a>>,
    refused: Option<&'a str>,
}

impl Items {
    pub fn new(file: Option<PathBuf>) -> io::Result<Self> {
        open::open(file.as_deref())
    }

    pub fn new_board(&mut self, bot: &str) {
        // Another call can publish the first item between bot registration and this notification.
        if self.numbers.last_issued.contains_key(bot)
            || self.items.iter().any(|item| item.bot == bot)
        {
            return;
        }
        if let Err(error) = self.db.execute(
            "INSERT INTO item_board(bot,last_issued) VALUES (?1,0)",
            [bot],
        ) {
            eprintln!("[items] board numbers not saved: {error}");
            return;
        }
        self.numbers.last_issued.insert(bot.to_owned(), 0);
    }

    pub fn add(&mut self, mut item: ItemRecord) -> io::Result<ItemRecord> {
        if item.number == 0 {
            item.number = self
                .last_number(&item.bot)
                .checked_add(1)
                .ok_or_else(|| invalid("This board has used every item number."))?;
        }
        let mut next = self.last_event;
        if item.events.iter().any(|e| e.id != 0) {
            return Err(invalid("a new item event already has an id"));
        }
        let tracked = self.numbers.last_issued.get(&item.bot).copied();
        let updated_last = tracked.map(|last| last.max(item.number));
        let tx = self.db.transaction().map_err(sql)?;
        stamp(&mut item, 0, &mut next)?;
        save_row(&tx, &mut item, 0, true)?;
        if let Some(last) = updated_last {
            tx.execute(
                "UPDATE item_board SET last_issued=?2 WHERE bot=?1",
                params![&item.bot, last],
            )
            .map_err(sql)?;
        }
        tx.commit().map_err(sql)?;
        if let Some(last) = updated_last
            && let Some(entry) = self.numbers.last_issued.get_mut(&item.bot)
        {
            *entry = last;
        }
        self.last_event = next;
        self.by_id.insert(item.id.clone(), self.items.len());
        let result = item.clone();
        self.items.push(item);
        Ok(result)
    }

    pub(super) fn persist_row(
        &mut self,
        id: &str,
        mutate: impl FnOnce(&mut ItemRecord),
    ) -> Result<(), String> {
        if self.file.is_none() {
            return Err("No durable item journal.".into());
        }
        let Some(&at) = self.by_id.get(id) else {
            return Err("That item is gone.".into());
        };
        let mut updated = self.items[at].clone();
        let start = updated.events.len();
        mutate(&mut updated);
        let tx = self.db.transaction().map_err(|e| sql(e).to_string())?;
        save_row(&tx, &mut updated, start, false).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| sql(e).to_string())?;
        self.items[at] = updated;
        Ok(())
    }

    pub fn commit_work(&mut self, id: &str, work: ItemWork) -> Result<(), String> {
        self.persist_row(id, |item| {
            item.work = Some(work);
        })
    }

    pub fn change(
        &mut self,
        id: &str,
        change: impl FnOnce(&mut ItemRecord),
    ) -> io::Result<Option<ItemRecord>> {
        let Some(&at) = self.by_id.get(id) else {
            return Ok(None);
        };
        let old = &self.items[at];
        let mut item = old.clone();
        change(&mut item);
        let mut next = self.last_event;
        let tx = self.db.transaction().map_err(sql)?;
        update(&tx, old, &mut item, &mut next)?;
        tx.commit().map_err(sql)?;
        self.last_event = next;
        let result = item.clone();
        self.items[at] = item;
        Ok(Some(result))
    }

    pub fn receipt(&self, request_id: &str) -> io::Result<Option<Option<String>>> {
        self.db
            .query_row(
                "SELECT json_extract(result_json,'$.refused') FROM item_request WHERE id=?1",
                [request_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql)
    }

    pub fn batch_result(&self, key: &str) -> io::Result<Option<serde_json::Value>> {
        let text: Option<String> = self
            .db
            .query_row(
                "SELECT result_json FROM item_request WHERE id=?1",
                [key],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql)?;
        text.as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(Into::into)
    }

    pub fn has_request(&self, id: &str, request: &str) -> io::Result<bool> {
        self.db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM item_event WHERE item=?1 AND request=?2)",
                (id, request),
                |r| r.get(0),
            )
            .map_err(sql)
    }

    pub fn commit_owner(
        &mut self,
        mut changes: Vec<ItemRecord>,
        request_id: Option<&str>,
        refused: Option<&str>,
        mails: &[(String, Mail)],
        ids: &[&str],
    ) -> io::Result<()> {
        let mut next = self.last_event;
        let tx = self.db.transaction().map_err(sql)?;
        let mut seen = HashSet::with_capacity(changes.len());
        for item in &mut changes {
            let Some(&at) = self.by_id.get(&item.id) else {
                return Err(invalid("missing item in owner batch"));
            };
            if !seen.insert(at) {
                return Err(invalid("duplicate changed item in owner batch"));
            }
            update(&tx, &self.items[at], item, &mut next)?;
        }
        if let Some(key) = request_id {
            let outcome = Outcome {
                ids,
                changed: changes
                    .iter()
                    .map(|item| Changed {
                        id: &item.id,
                        version: item.version,
                    })
                    .collect(),
                refused,
            };
            tx.execute(
                "INSERT INTO item_request(id,result_json) VALUES (?1,?2)",
                (key, serde_json::to_string(&outcome)?),
            )
            .map_err(sql)?;
        }
        for (session, mail) in mails {
            tx.execute(
                "INSERT INTO item_mail(id,session,mail_json) VALUES (?1,?2,?3)",
                (&mail.id, session, serde_json::to_string(mail)?),
            )
            .map_err(sql)?;
        }
        tx.commit().map_err(|error| {
            let error = sql(error);
            io::Error::new(error.kind(), format!("commit item batch: {error}"))
        })?;
        self.last_event = next;
        for item in changes {
            let at = self.by_id[&item.id];
            self.items[at] = item;
        }
        Ok(())
    }

    pub fn pending_mail(&self) -> io::Result<Vec<(String, Mail)>> {
        let mut stmt = self
            .db
            .prepare("SELECT session,mail_json FROM item_mail ORDER BY rowid")
            .map_err(sql)?;
        let mut rows = stmt.query([]).map_err(sql)?;
        let mut pending = Vec::new();
        while let Some(row) = rows.next().map_err(sql)? {
            let text: String = row.get(1).map_err(sql)?;
            pending.push((row.get(0).map_err(sql)?, serde_json::from_str(&text)?));
        }
        Ok(pending)
    }

    pub fn ack_mail(&mut self, id: &str) -> io::Result<()> {
        self.db
            .execute("DELETE FROM item_mail WHERE id=?1", [id])
            .map_err(sql)?;
        Ok(())
    }

    pub fn remove_bot(&mut self, bot: &str) -> io::Result<()> {
        let tx = self.db.transaction().map_err(sql)?;
        let deleted = tx
            .execute("DELETE FROM item WHERE bot=?1", [bot])
            .map_err(sql)?;
        tx.execute("DELETE FROM item_board WHERE bot=?1", [bot])
            .map_err(sql)?;
        if deleted != 0 {
            tx.execute(
                "DELETE FROM item_mail WHERE NOT EXISTS (
                    SELECT 1 FROM item WHERE json_extract(current_json,'$.session')=item_mail.session)",
                [],
            )
            .map_err(sql)?;
        }
        tx.commit().map_err(sql)?;
        self.numbers.last_issued.remove(bot);
        if deleted != 0 {
            self.items.retain(|item| {
                if item.bot == bot {
                    self.by_id.remove(&item.id);
                    false
                } else {
                    true
                }
            });
            for (at, item) in self.items.iter().enumerate() {
                *self.by_id.get_mut(&item.id).expect("indexed item") = at;
            }
        }
        Ok(())
    }
}
