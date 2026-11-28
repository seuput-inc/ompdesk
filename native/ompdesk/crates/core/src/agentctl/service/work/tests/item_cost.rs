use super::*;
use rusqlite::Connection;

// Separate from the timed probe: a full projection that's built and then thrown away costs no wire bytes.
#[tokio::test]
#[ignore = "CI item-cost probe; run only this test with --ignored --exact"]
async fn warm_comment() {
    assert!(std::env::var("CI").is_ok_and(|ci| ci == "true"), "CI only");
    let root = Scratch::new();
    let mut files = bot_files(&root);
    files.bots = Some(root.0.join("bots.json"));
    let id = "item-000001";
    let items = files.items.as_ref().unwrap();
    let now = system_clock()();
    let stamp = crate::aimemory::value::iso(now as u64);
    let body = "x".repeat(420);
    let mut seq = 100_000;
    let rows: Vec<_> = (0..70)
        .map(|i| {
            let events: Vec<_> = (0..17 + usize::from(i < 60))
                .map(|_| {
                    seq += 1;
                    json!({"id":seq,"at":stamp,"actor":"bot","kind":"commented","text":body})
                })
                .collect();
            let mut row = json!({"id":format!("item-{:06}", i + 1),"bot":"bot","number":1000+i,
                "session":"/s/bot.jsonl","title":"Subject","version":10,"events":events,
                "createdAt":stamp,"updatedAt":stamp,"touched":now,"links":[],
                "status":if i < 50 { "working" } else { "done" }});
            if i >= 50 {
                row["closedAt"] = json!(stamp);
                row["closed"] = json!(now);
            }
            row
        })
        .collect();
    assert_eq!(seq, 101_250);
    std::fs::write(items, serde_json::to_vec(&rows).unwrap()).unwrap();
    let (host, asked) = rig_files(
        bot_world("demo"),
        Caps::default(),
        &files,
        bots_main(Default::default(), |_, _| None),
    );
    host.bots().add(crate::agentctl::journal::bots::BotRecord {
        id: "bot".into(),
        name: "Bot".into(),
        folder: root.0.to_string_lossy().into(),
        ..Default::default()
    });
    host.items_legacy_audience(false, false);
    let feed = |since: Option<&Value>| {
        let mut q = json!({"protocol":2,"device":null,"action":"itemsFeed"});
        if let Some(base) = since {
            q["since"] = base.clone();
        }
        host.items_query(q)
    };
    let seed = feed(None).await.unwrap();
    assert_eq!(seed["open"].as_array().unwrap().len(), 50);
    assert_eq!(seed["counts"]["bot"]["closedTotal"], 20);
    let cursor = host.items().get(id).unwrap().events.last().unwrap().id;
    let before = host.items().full_reads();
    let request =
        json!({"action":"item","id":id,"requestId":"fixed-0001","comment":"One comment."});
    assert_eq!(
        host.items_change(Value::Null, request).await.unwrap(),
        json!({})
    );
    let delta = feed(Some(&seed["version"])).await.unwrap();
    assert_eq!(delta["kind"], "delta");
    assert_eq!(delta["set"].as_array().unwrap().len(), 1);
    assert_eq!(delta["set"][0]["id"], id);
    assert_eq!(delta["set"][0]["version"], 11);
    assert!(delta["set"][0].get("events").is_none());
    let query = json!({"protocol":2,"action":"itemDetail","id":id,"bot":"bot","afterEvent":cursor});
    let detail = host.items_query_from(&query).unwrap();
    assert_eq!(detail["events"].as_array().unwrap().len(), 1);
    assert_eq!(detail["events"][0]["request"], "fixed-0001");
    host.host.port().fresh().await.unwrap();
    assert_eq!(host.items().full_reads(), before);
    {
        let observed = asked.lock().unwrap();
        assert_eq!(observed.iter().filter(|(m, _)| m == "mail").count(), 1);
        assert!(
            !observed
                .iter()
                .any(|(m, _)| m == "botsChanged" || m == "botsShared")
        );
    }
    // Positive control for the counter, outside the modern measurement.
    let snapshot = host.bots_state();
    let rows = snapshot["items"].as_array().unwrap();
    assert_eq!(rows.len(), 70);
    let changed = rows.iter().find(|r| r["id"] == id).unwrap();
    assert_eq!(changed["version"], 11);
    assert_eq!(
        changed["events"].as_array().unwrap().last(),
        Some(&detail["events"][0])
    );
    assert!(host.items().full_reads() > before);
    drop(host);
    let db = Connection::open_with_flags(
        items.with_extension("sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let count = |sql| db.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(count("SELECT count(*) FROM item_event"), 1251);
    assert_eq!(
        count("SELECT count(*) FROM item WHERE json_extract(current_json,'$.version') != 10"),
        1
    );
    assert_eq!(
        count("SELECT count(*) FROM item_event WHERE item='item-000001' AND request='fixed-0001'"),
        1
    );
}
