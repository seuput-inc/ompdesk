use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, params};

use super::{invalid, save_row, sql, stamp};
use crate::agentctl::journal::items::{BoardNumbers, EVENTS_KEPT, ItemRecord, Items, STATUSES};

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum LegacyRow {
    Numbers(BoardNumbers),
    Item(ItemRecord),
}

const SCHEMA: &str = include_str!("../items_v1.sql");

fn regular(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(true),
        Ok(_) => Err(invalid("expected a regular items file")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

fn disk(path: &Path) -> io::Result<Connection> {
    // Never let SQLite create an empty replacement for a database we intended to reopen.
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(sql)?;
    db.busy_timeout(Duration::ZERO).map_err(sql)?;
    db.execute_batch(
        "PRAGMA foreign_keys=ON; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=EXTRA;
         PRAGMA fullfsync=ON; BEGIN EXCLUSIVE; COMMIT;",
    )
    .map_err(sql)?;
    // DELETE + EXTRA syncs both the rollback journal and its directory before acknowledging.
    let journal: String = db
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .map_err(sql)?;
    if journal != "delete" {
        return Err(invalid("unexpected items journal mode"));
    }
    Ok(db)
}

fn initialize(db: &mut Connection, original: Option<&str>) -> io::Result<()> {
    let tx = db.transaction().map_err(sql)?;
    tx.execute_batch(SCHEMA).map_err(sql)?;
    if let Some(text) = original {
        // Vec rejects a non-array root; the struct deserializers reject unknown/duplicate fields.
        let rows: Vec<LegacyRow> = serde_json::from_str(text)?;
        // Serde also accepts positional tuples for structs. The journal format never did.
        let tuple: bool = tx
            .query_row(
                "WITH t AS (SELECT id, parent, key, type FROM json_tree(?1))
                 SELECT EXISTS(SELECT 1 FROM t WHERE type='array' AND parent IS NOT NULL
                 AND key NOT IN ('options','decisions','links','events','retired')
                 AND NOT EXISTS (SELECT 1 FROM t p WHERE p.id = t.parent AND p.key = 'retired'))",
                [text],
                |r| r.get(0),
            )
            .map_err(sql)?;
        if tuple {
            return Err(invalid("an items.json record is not an object"));
        }
        let mut numbers = BoardNumbers::default();
        let mut items = Vec::new();
        for row in rows {
            match row {
                LegacyRow::Numbers(board) => numbers.last_issued.extend(board.last_issued),
                LegacyRow::Item(item) => items.push(item),
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
        let mut last = items
            .iter()
            .flat_map(|i| &i.events)
            .map(|e| e.id)
            .max()
            .unwrap_or(0);
        let mut ids = HashSet::new();
        for item in &mut items {
            stamp(item, 0, &mut last)?;
            for event in &item.events {
                if !ids.insert(event.id) {
                    return Err(invalid("duplicate items.json event id"));
                }
            }
        }
        for mut item in items {
            if item.id.trim().is_empty()
                || item.bot.trim().is_empty()
                || item.session.trim().is_empty()
                || item.title.trim().is_empty()
                || !STATUSES.contains(&item.status.as_str())
            {
                return Err(invalid("invalid items.json item identity, title or status"));
            }
            // Old versions discarded a prefix. A retained answer or active question can still
            // name an ask in that prefix; it must not be fabricated or silently renumbered.
            let lowest = item.events.iter().map(|e| e.id).min();
            let pruned = |id: u64| id > 0 && lowest.is_some_and(|n| id < n) && !ids.contains(&id);
            let mut earlier = HashSet::new();
            for event in &item.events {
                if event.at.is_empty()
                    || event.kind.is_empty()
                    || !matches!(event.actor.as_str(), "bot" | "owner")
                {
                    return Err(invalid("invalid items.json event"));
                }
                if let Some(id) = event.question
                    && !earlier.contains(&id)
                    && !pruned(id)
                {
                    return Err(invalid("an items.json event names a missing question"));
                }
                earlier.insert(event.id);
            }
            if let Some(q) = &item.question
                && !(earlier.contains(&q.id) || pruned(q.id) || q.id == 0 && item.events.is_empty())
            {
                return Err(invalid("an items.json item names a missing question"));
            }
            save_row(&tx, &mut item, 0, true)?;
        }
        for (bot, last) in &numbers.last_issued {
            tx.execute(
                "INSERT INTO item_board(bot,last_issued) VALUES (?1,?2)",
                params![bot, last],
            )
            .map_err(sql)?;
        }
    }
    tx.commit().map_err(sql)
}

fn verify(db: &Connection, path: &Path) -> io::Result<()> {
    let integer = |p| db.query_row(p, [], |r| r.get::<_, i64>(0)).map_err(sql);
    if integer("PRAGMA application_id")? != 0x4f49544d || integer("PRAGMA user_version")? != 1 {
        return Err(invalid("unrecognized or incomplete items database"));
    }
    if integer("PRAGMA page_count")?
        .checked_mul(integer("PRAGMA page_size")?)
        .and_then(|bytes| u64::try_from(bytes).ok())
        != Some(fs::metadata(path)?.len())
    {
        return Err(invalid(
            "items database length disagrees with its page count",
        ));
    }
    // A version number alone can't distinguish a damaged or dropped table/index from an empty one.
    let expected: Vec<_> = SCHEMA
        .split(';')
        .filter_map(|s| s.find("CREATE ").map(|i| &s[i..]))
        .collect();
    let mut stmt = db
        .prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*'")
        .map_err(sql)?;
    let mut rows = stmt.query([]).map_err(sql)?;
    let mut count = 0;
    while let Some(row) = rows.next().map_err(sql)? {
        let ddl: String = row.get(0).map_err(sql)?;
        if !expected
            .iter()
            .any(|s| s.split_whitespace().eq(ddl.split_whitespace()))
        {
            return Err(invalid("unexpected items database schema"));
        }
        count += 1;
    }
    if count != expected.len() {
        return Err(invalid("incomplete items database schema"));
    }
    let integrity: String = db
        .query_row("PRAGMA integrity_check(1)", [], |r| r.get(0))
        .map_err(sql)?;
    if integrity != "ok" {
        return Err(io::Error::new(io::ErrorKind::InvalidData, integrity));
    }
    if integer("SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)")? != 0 {
        return Err(invalid("orphaned item event"));
    }
    Ok(())
}

fn load(db: Connection, writer: Option<File>) -> io::Result<Items> {
    let mut items = Vec::new();
    let mut by_id = HashMap::new();
    {
        let mut current = db
            .prepare("SELECT current_json FROM item ORDER BY ordinal")
            .map_err(sql)?;
        let mut history = db
            .prepare(
                "SELECT event_json FROM item_event WHERE item=?1 ORDER BY position DESC LIMIT ?2",
            )
            .map_err(sql)?;
        let mut rows = current.query([]).map_err(sql)?;
        while let Some(row) = rows.next().map_err(sql)? {
            let text: String = row.get(0).map_err(sql)?;
            let mut item: ItemRecord = serde_json::from_str(&text)?;
            let mut tail = history.query((&item.id, EVENTS_KEPT as i64)).map_err(sql)?;
            while let Some(row) = tail.next().map_err(sql)? {
                let text: String = row.get(0).map_err(sql)?;
                item.events.push(serde_json::from_str(&text)?);
            }
            item.events.reverse();
            by_id.insert(item.id.clone(), items.len());
            items.push(item);
        }
    }
    let (last_event, largest): (i64, i64) = db
        .query_row(
            "SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='item_event'),0),
                coalesce(max(id),0) FROM item_event",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(sql)?;
    let last_event = u64::try_from(last_event).map_err(|_| invalid("negative event sequence"))?;
    if last_event < largest as u64 {
        return Err(invalid("invalid item event high-water mark"));
    }
    let mut numbers = BoardNumbers::default();
    {
        let mut boards = db
            .prepare("SELECT bot, last_issued FROM item_board")
            .map_err(sql)?;
        let mut rows = boards.query([]).map_err(sql)?;
        while let Some(row) = rows.next().map_err(sql)? {
            let bot: String = row.get(0).map_err(sql)?;
            let last: i64 = row.get(1).map_err(sql)?;
            let last = u32::try_from(last).map_err(|_| invalid("board item number out of range"))?;
            numbers.last_issued.insert(bot, last);
        }
    }
    Ok(Items {
        db,
        _writer: writer,
        file: None,
        numbers,
        feed: super::super::queries::Feed::load(&items),
        items,
        by_id,
        last_event,
    })
}

pub(super) fn open(legacy: Option<&Path>) -> io::Result<Items> {
    let Some(legacy) = legacy else {
        let mut db = Connection::open_in_memory().map_err(sql)?;
        db.execute_batch("PRAGMA foreign_keys=ON").map_err(sql)?;
        initialize(&mut db, None)?;
        return load(db, None);
    };
    let path = legacy.with_extension("sqlite3");
    let marker = legacy.with_extension("sqlite3.committed");
    if legacy == path || legacy == marker {
        return Err(invalid("items.json path collides with the database"));
    }
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let marked = regular(&marker)?;
    if !regular(&path)? {
        if marked {
            return Err(invalid("committed items database is missing"));
        }
        let original = if regular(legacy)? {
            Some(fs::read_to_string(legacy)?)
        } else {
            None
        };
        // Keep malformed/partially imported data out of the canonical filename, even on process death.
        let tmp = tempfile::NamedTempFile::new_in(dir)?.into_temp_path();
        let mut db = disk(&tmp)?;
        initialize(&mut db, original.as_deref())?;
        db.close().map_err(|(_, e)| sql(e))?;
        tmp.persist_noclobber(&path).map_err(|e| e.error)?;
    }
    if fs::metadata(&path)?.len() < 512 {
        return Err(invalid("empty or truncated items database"));
    }
    let db = disk(&path)?;
    verify(&db, &path)?;
    if !marked && regular(legacy)? {
        let mut mode = fs::metadata(legacy)?.permissions();
        mode.set_readonly(true);
        fs::set_permissions(legacy, mode)?;
    }
    let mut marker_options = File::options();
    marker_options
        .read(true)
        .write(true)
        .create(true)
        .truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        marker_options.mode(0o600);
    }
    let writer = marker_options.open(marker)?;
    writer.try_lock().map_err(io::Error::from)?;
    writer.sync_all()?;
    #[cfg(unix)]
    File::open(dir)?.sync_all()?;
    let mut loaded = load(db, Some(writer))?;
    loaded.file = Some(legacy.to_path_buf());
    Ok(loaded)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
