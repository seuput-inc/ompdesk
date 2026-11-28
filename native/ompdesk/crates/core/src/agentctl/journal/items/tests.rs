use std::fs;
use std::io::{self, Seek, SeekFrom, Write};

use rusqlite::{Connection, DEFAULT_NAME, FileControl, OpenFlags};
use serde_json::json;
use tempfile::tempdir;

use super::{initialize, load};
use crate::agentctl::journal::items::{ItemRecord, Items};
use crate::agentctl::rules::mail::{Mail, MailKind};

fn item(id: &str, bot: &str, number: u32) -> ItemRecord {
    ItemRecord {
        id: id.into(),
        bot: bot.into(),
        title: id.into(),
        number,
        session: format!("/{bot}"),
        status: "planned".into(),
        ..Default::default()
    }
}

fn changed(items: &Items, id: &str) -> ItemRecord {
    let mut row = items.get(id).unwrap().v1();
    row.version += 1;
    row.title = "changed".into();
    row.event("today", "owner", "commented", Some("new"));
    row
}

fn mail(id: &str) -> (String, Mail) {
    (
        "/b".into(),
        Mail::new(id, "owner", "Owner", "", MailKind::Note, "notes", 12.5),
    )
}

#[test]
fn a_second_process_cannot_serve_a_stale_cache() {
    const CHILD_PATH: &str = "OMPDESK_ITEMS_TEST_SECOND_WRITER";
    if let Some(path) = std::env::var_os(CHILD_PATH) {
        let error = Items::new(Some(path.into())).err().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        return;
    }
    let dir = tempdir().unwrap();
    let path = dir.path().join("items.json");
    let owner = Items::new(Some(path.clone())).unwrap();
    let (_, module) = module_path!().split_once("::").unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg(format!(
            "{module}::a_second_process_cannot_serve_a_stale_cache"
        ))
        .env(CHILD_PATH, &path)
        .output()
        .unwrap();
    assert!(
        child.status.success(),
        "{}",
        String::from_utf8_lossy(&child.stderr)
    );
    assert!(String::from_utf8_lossy(&child.stdout).contains("1 passed"));
    drop(owner);
    assert!(Items::new(Some(path)).is_ok());
}

#[test]
fn migration_keeps_the_original_and_ids_across_a_pruned_prefix_and_a_reload() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("items.json");
    let original = json!([
        {"id":"old", "bot":"b", "number":1, "session":"/b", "title":"old", "status":"needs_you",
         "events":[{"at":"x", "actor":"bot", "kind":"made"},
                   {"id":10, "at":"between", "actor":"bot", "kind":"edited"},
                   {"at":"y", "actor":"bot", "kind":"asked"}], "question":{"text":"which?"}},
        {"id":"pruned", "bot":"b", "number":2, "session":"/b", "title":"pruned", "status":"needs_you",
         "events":[{"id":90, "at":"a", "actor":"owner", "kind":"answered", "question":7, "request":"legacy"}],
         "question":{"id":89,"text":"still open"}}
    ]).to_string();
    fs::write(&path, &original).unwrap();
    let mode = fs::metadata(&path).unwrap().permissions();
    let mut items = Items::new(Some(path.clone())).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    assert!(fs::metadata(&path).unwrap().permissions().readonly());
    assert_eq!(items.get("old").unwrap().question.as_ref().unwrap().id, 92);
    assert_eq!(items.get("old").unwrap().events[0].id, 91);
    assert_eq!(
        items.get("pruned").unwrap().question.as_ref().unwrap().id,
        89
    );
    assert_eq!(items.get("pruned").unwrap().events[0].question, Some(7));
    items
        .change("pruned", |r| {
            for _ in 0..55 {
                r.event("z", "bot", "edited", None);
            }
        })
        .unwrap();
    drop(items);
    let items = Items::new(Some(path.clone())).unwrap();
    assert_eq!(
        items
            .visible(0.0)
            .map(|r| r.id.as_str())
            .collect::<Vec<_>>(),
        ["old", "pruned"]
    );
    assert_eq!(
        items
            .get("old")
            .unwrap()
            .events
            .iter()
            .map(|e| e.id)
            .collect::<Vec<_>>(),
        [91, 10, 92]
    );
    let pruned = items.get("pruned").unwrap();
    assert_eq!(pruned.events.len(), 50);
    assert_eq!(pruned.events[0].id, 98);
    assert!(items.has_request("pruned", "legacy").unwrap());
    assert!(!items.has_request("old", "legacy").unwrap());
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    drop(items);
    fs::set_permissions(&path, mode).unwrap();
}

#[test]
fn malformed_originals_never_publish_a_prefix_and_can_be_repaired() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("items.json");
    let good = serde_json::to_value(item("first", "b", 1)).unwrap();
    let second = serde_json::to_value(item("second", "b", 2)).unwrap();
    let mut cases = vec![
        "".into(),
        "{".into(),
        "{}".into(),
        "[]\0".into(),
        "null".into(),
        json!([good, null]).to_string(),
    ];
    for (field, value) in [
        ("id", json!("first")),
        ("number", json!(1)),
        ("number", json!(0)),
        ("title", json!(42)),
        ("bot", json!("")),
        ("status", json!("later")),
        ("futureData", json!({"otherwise":"lost"})),
        ("links", json!([{"kind":"url","ref":"a","unknown":true}])),
        ("wait", json!(["positional tuple"])),
        (
            "events",
            json!([{"id":3,"at":"a","actor":"bot","kind":"made"},{"id":3,"at":"b","actor":"bot","kind":"made"}]),
        ),
        (
            "events",
            json!([{"id":2,"at":"a","actor":"owner","kind":"answered","question":1},{"id":1,"at":"b","actor":"bot","kind":"asked"}]),
        ),
        (
            "events",
            json!([{"id":2,"at":"a","actor":"owner","kind":"answered","question":3}]),
        ),
        (
            "events",
            json!([{"id":u64::MAX,"at":"a","actor":"bot","kind":"made"}]),
        ),
    ] {
        let mut bad = second.clone();
        bad[field] = value;
        cases.push(json!([good, bad]).to_string());
    }
    for original in cases {
        fs::write(&path, &original).unwrap();
        assert!(Items::new(Some(path.clone())).is_err(), "{original}");
        assert!(!path.with_extension("sqlite3").exists());
        assert!(!path.with_extension("sqlite3.committed").exists());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert!(!fs::metadata(&path).unwrap().permissions().readonly());
    }
    let mode = fs::metadata(&path).unwrap().permissions();
    fs::write(&path, json!([good]).to_string()).unwrap();
    assert!(
        Items::new(Some(path.clone()))
            .unwrap()
            .get("first")
            .is_some()
    );
    fs::set_permissions(path, mode).unwrap();
}

#[test]
fn damaged_or_missing_sqlite_is_never_replaced_with_the_original() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("items.json");
    fs::write(&path, "[]").unwrap();
    let mode = fs::metadata(&path).unwrap().permissions();
    let database = path.with_extension("sqlite3");
    let mut items = Items::new(Some(path.clone())).unwrap();
    items.add(item("post-import", "b", 1)).unwrap();
    let size: u32 = items
        .db
        .query_row("PRAGMA page_size", [], |r| r.get(0))
        .unwrap();
    // Damage a live b-tree root at EOF, not unused slack at the end of its page.
    let last_is_root: bool = items.db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE rootpage=(SELECT page_count FROM pragma_page_count))",
        [], |r| r.get(0),
    ).unwrap();
    assert!(last_is_root);
    assert_eq!(
        Items::new(Some(path.clone())).err().unwrap().kind(),
        io::ErrorKind::WouldBlock
    );
    drop(items);
    let clean = fs::read(&database).unwrap();
    let zeros = vec![0; size as usize];
    {
        let mut f = fs::OpenOptions::new().write(true).open(&database).unwrap();
        f.seek(SeekFrom::End(-i64::from(size))).unwrap();
        f.write_all(&zeros).unwrap();
    }
    assert!(Items::new(Some(path.clone())).is_err());
    for damaged in [
        [clean.as_slice(), zeros.as_slice()].concat(),
        [clean.as_slice(), &[0]].concat(),
        vec![0; clean.len()],
        Vec::new(),
    ] {
        fs::write(&database, &damaged).unwrap();
        assert!(Items::new(Some(path.clone())).is_err());
        assert_eq!(fs::read(&database).unwrap(), damaged);
    }
    for damage in [
        "DROP TABLE item_mail",
        "PRAGMA user_version=2",
        "PRAGMA application_id=0",
    ] {
        fs::write(&database, &clean).unwrap();
        Connection::open(&database)
            .unwrap()
            .execute_batch(damage)
            .unwrap();
        assert!(Items::new(Some(path.clone())).is_err());
    }
    fs::remove_file(&database).unwrap();
    assert!(Items::new(Some(path.clone())).is_err());
    assert!(!database.exists());
    fs::write(&database, clean).unwrap();
    assert!(
        Items::new(Some(path.clone()))
            .unwrap()
            .get("post-import")
            .is_some()
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "[]");
    fs::set_permissions(path, mode).unwrap();
}

#[test]
fn batch_receipts_and_chat_intents_survive_reload_and_removal_keeps_the_high_water() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("items.json");
    let mut s = Items::new(Some(path.clone())).unwrap();
    s.add(item("i", "b", 1)).unwrap();
    s.add(item("j", "b", 2)).unwrap();
    let changes = vec![changed(&s, "j"), changed(&s, "i")];
    let mails = vec![mail("batch")];
    s.commit_owner(
        changes,
        Some("key"),
        Some("question_changed"),
        &mails,
        &["gone", "j", "i", "i"],
    )
    .unwrap();
    s.commit_owner(vec![], Some("skip"), None, &[], &["gone"])
        .unwrap();
    drop(s);
    let mut s = Items::new(Some(path.clone())).unwrap();
    assert_eq!(
        s.receipt("key").unwrap(),
        Some(Some("question_changed".into()))
    );
    assert_eq!(s.receipt("skip").unwrap(), Some(None));
    assert_eq!(s.receipt("absent").unwrap(), None);
    assert_eq!(
        s.batch_result("key").unwrap().unwrap(),
        json!({
            "ids":["gone","j","i","i"],"changed":[{"id":"j","version":1},{"id":"i","version":1}],"refused":"question_changed"
        })
    );
    assert_eq!(s.pending_mail().unwrap(), mails);
    assert_eq!(s.get("i").unwrap().events[0].id, 2);
    s.ack_mail("batch").unwrap();
    let update = changed(&s, "i");
    s.commit_owner(vec![update], None, None, &[mail("next")], &["i"])
        .unwrap();
    s.remove_bot("b").unwrap();
    assert!(s.pending_mail().unwrap().is_empty());
    drop(s);
    let mut s = Items::new(Some(path)).unwrap();
    assert_eq!(s.receipt("skip").unwrap(), Some(None));
    let mut next = item("next", "b", 1);
    next.event("now", "bot", "made", None);
    assert_eq!(s.add(next).unwrap().events[0].id, 4);
}

#[test]
fn vfs_disk_full_at_commit_does_not_publish_the_batch_or_consume_ids() {
    // The memdb VFS has a byte quota in xWrite. With spill off, the first database write is
    // COMMIT, after every row, receipt and mail INSERT succeeded. No host filesystem is filled.
    let connect = || {
        Connection::open_with_flags_and_vfs("/items-quota", OpenFlags::default(), "memdb").unwrap()
    };
    let reader = connect();
    let mut db = connect();
    db.execute_batch("PRAGMA journal_mode=MEMORY; PRAGMA foreign_keys=ON; PRAGMA cache_spill=OFF")
        .unwrap();
    initialize(&mut db, None).unwrap();
    let mut items = load(db, None).unwrap();
    let first = items.add(item("a", "b", 1)).unwrap();
    let second = items.add(item("b", "b", 2)).unwrap();
    let mut limit = 0;
    items
        .db
        .file_control(DEFAULT_NAME, FileControl::SizeLimit(&mut limit))
        .unwrap();
    assert!(limit > 0);
    let mut large = mail("large");
    large.1.text = "x".repeat(512 * 1024);
    let changes = vec![changed(&items, "a"), changed(&items, "b")];
    let error = items
        .commit_owner(changes, Some("retry"), None, &[large], &["a", "b"])
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::StorageFull);
    assert!(error.to_string().starts_with("commit item batch:"));
    assert_eq!(items.get("a"), Some(&first));
    assert_eq!(items.get("b"), Some(&second));
    assert_eq!(items.receipt("retry").unwrap(), None);
    assert!(items.pending_mail().unwrap().is_empty());
    // Start from the VFS image through a separate connection and pager cache.
    drop(items);
    reader
        .execute_batch("PRAGMA journal_mode=MEMORY; PRAGMA foreign_keys=ON")
        .unwrap();
    let mut items = load(reader, None).unwrap();
    assert_eq!(items.get("a"), Some(&first));
    assert_eq!(items.get("b"), Some(&second));
    assert_eq!(items.receipt("retry").unwrap(), None);
    assert!(items.pending_mail().unwrap().is_empty());
    limit = 2 * 1024 * 1024;
    items
        .db
        .file_control(DEFAULT_NAME, FileControl::SizeLimit(&mut limit))
        .unwrap();
    let changes = vec![changed(&items, "a"), changed(&items, "b")];
    items
        .commit_owner(changes, Some("retry"), None, &[mail("ok")], &["a", "b"])
        .unwrap();
    assert_eq!(items.get("b").unwrap().events[0].id, 2);
    assert_eq!(items.pending_mail().unwrap(), [mail("ok")]);
}
