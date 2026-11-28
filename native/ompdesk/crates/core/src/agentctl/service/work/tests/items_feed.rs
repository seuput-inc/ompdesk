use super::*;
use crate::agentctl::journal::bots::BotRecord;
use crate::agentctl::journal::items::{ItemLink, ItemRecord};

fn own_rows(host: &AgentControl, root: &Scratch, label: &str) {
    host.bots().add(BotRecord {
        id: "b".into(),
        name: "Shared name".into(),
        folder: root.0.to_string_lossy().into(),
        chat_approval: Some("write".into()),
        skill_projects: vec!["/private-project".into()],
        ..Default::default()
    });
    let mut row = ItemRecord {
        id: "collision".into(),
        bot: "b".into(),
        number: 1,
        status: "working".into(),
        session: "/s/bot.jsonl".into(),
        title: label.into(),
        description: Some("only in detail".into()),
        links: vec![ItemLink {
            kind: "session".into(),
            target: "/s/work.jsonl".into(),
            ..Default::default()
        }],
        version: 1,
        ..Default::default()
    };
    row.event(
        "2026-11-28T12:00:00.000Z",
        "bot",
        "made",
        Some("history is private to detail"),
    );
    host.items().add(row).unwrap();
}

fn peer_feed(host: &AgentControl, since: Option<&Value>) -> Value {
    let mut query = json!({"protocol":2,"action":"itemsFeed"});
    if let Some(base) = since {
        query["since"] = base.clone();
    }
    host.items_query_from(&query).unwrap()
}

#[tokio::test]
async fn seed_delta_replay_archive_and_metadata_have_separate_payloads() {
    let root = Scratch::new();
    let (host, _) = rig(bot_world("demo"), Caps::default(), main_of(|_, _| None));
    own_rows(&host, &root, "subject");
    let local = host
        .items_query(json!({"action":"itemsFeed","protocol":2,"device":null}))
        .await
        .unwrap();
    let seed = peer_feed(&host, Some(&local["version"]));
    assert_ne!(seed["version"], local["version"]);
    assert_eq!(seed["kind"], "seed");
    assert_eq!(
        local["bots"][0]["launch"],
        json!(["--approval-mode", "write"])
    );
    for k in ["rooms", "looks"] {
        assert!(local[k].is_array());
        assert!(seed.get(k).is_none());
    }
    for k in ["launch", "picture", "workers", "skillProjects"] {
        assert!(seed["bots"][0].get(k).is_none());
    }
    assert_eq!(seed["open"][0]["sessionLinks"], json!(["/s/work.jsonl"]));
    assert_eq!(seed["counts"]["b"]["openCount"], 1);
    for k in ["events", "description", "doneMeans", "closeNote", "links"] {
        assert!(seed["open"][0].get(k).is_none());
    }
    host.owner_item(&json!({"id":"collision","comment":"late comment","requestId":"r1"}))
        .await
        .unwrap();
    let delta = peer_feed(&host, Some(&seed["version"]));
    assert_eq!(delta["kind"], "delta");
    assert_eq!(delta["base"], seed["version"]);
    assert_eq!(delta["set"][0]["id"], "collision");
    assert_eq!(delta["counts"], json!({}));
    assert!(!delta.to_string().contains("late comment"));
    assert_eq!(peer_feed(&host, Some(&seed["version"])), delta);
    let duplicate = peer_feed(&host, Some(&delta["version"]));
    assert_eq!(duplicate["version"], delta["version"]);
    assert_eq!(duplicate["set"], json!([]));
    host.owner_item(&json!({"id":"collision","status":"done"}))
        .await
        .unwrap();
    let closed = peer_feed(&host, Some(&delta["version"]));
    assert_eq!(closed["set"], json!([]));
    assert_eq!(closed["remove"], json!(["collision"]));
    assert_eq!(closed["counts"]["b"]["closedTotal"], 1);
    assert!(closed["counts"]["b"]["archiveRevision"].as_u64().unwrap() > 0);
    let detail = host
        .items_query_from(&json!({"protocol":2,"action":"itemDetail","bot":"b","id":1}))
        .unwrap();
    assert_eq!(detail["item"]["description"], "only in detail");
    assert!(detail["item"].get("events").is_none());
    assert!(
        detail["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["text"] == "late comment")
    );
    let receipt = host.items_query_from(&json!({"protocol":2,"action":"itemReceipt","bot":"b","id":"collision","requestId":"r1"})).unwrap();
    assert_eq!(receipt, json!({"protocol":2,"outcome":"commented"}));
    let page = host
        .items_query_from(&json!({"protocol":2,"action":"itemsPage","id":"b"}))
        .unwrap();
    assert_eq!(page["closed"][0]["id"], "collision");
    assert_eq!(page["closedTotal"], 1);
    assert_eq!(page["next"], Value::Null);
    assert!(
        peer_feed(&host, None)["open"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let mut world = bot_world("demo");
    world["tabs"][3]["scheduledRetry"] =
        json!({"at":1_800_000_000_000_i64,"attempt":1,"limit":true});
    crate::ports::apply_state(host.host.port(), 1, &world.to_string()).unwrap();
    let changed = peer_feed(&host, Some(&closed["version"]));
    assert_eq!(changed["kind"], "seed");
    assert_ne!(changed["version"], closed["version"]);
    let page = host
        .items_query_from(&json!({"protocol":2,"action":"itemsPage","id":"b"}))
        .unwrap();
    assert_eq!(
        page["closed"][0]["limitUntil"],
        crate::aimemory::value::iso(1_800_000_000_000)
    );
    let epoch = changed["version"]
        .as_str()
        .unwrap()
        .rsplit_once('.')
        .unwrap()
        .0;
    assert_eq!(
        peer_feed(&host, Some(&json!(format!("{epoch}.999999"))))["kind"],
        "seed"
    );
    std::fs::write(root.0.join("SOUL.md"), "New specialty").unwrap();
    let external = peer_feed(&host, Some(&changed["version"]));
    assert_eq!(external["kind"], "seed");
    assert_eq!(external["bots"][0]["specialty"], "New specialty");
    assert_eq!(peer_feed(&host, Some(&json!("unknown.3")))["kind"], "seed");
    let (restarted, _) = rig(bot_world("demo"), Caps::default(), main_of(|_, _| None));
    assert_eq!(
        peer_feed(&restarted, Some(&changed["version"]))["kind"],
        "seed"
    );
}

#[tokio::test]
async fn colliding_ids_use_only_the_selected_host_and_errors_never_fall_back() {
    let root = Scratch::new();
    let (peer, _) = rig(bot_world("demo"), Caps::default(), main_of(|_, _| None));
    own_rows(&peer, &root, "on the peer");
    let (other, _) = rig(bot_world("demo"), Caps::default(), main_of(|_, _| None));
    own_rows(&other, &root, "on the other peer");
    let mut world = bot_world("demo");
    world["devices"] = json!([
        {"id":"peer","name":"same","state":"online"},
        {"id":"other","name":"same","state":"online"},
        {"id":"lost","name":"same","state":"offline"},
        {"id":"wrong","name":"same","state":"online"}
    ]);
    let (host, asked) = rig(world, Caps::default(), move |method, args| {
        assert_eq!(method, "remoteItemsQuery");
        assert!(args["request"].get("device").is_none());
        match args["device"].as_str() {
            Some("peer") => peer
                .items_query_from(&args["request"])
                .map_err(|e| e.message()),
            Some("other") => other
                .items_query_from(&args["request"])
                .map_err(|e| e.message()),
            Some("wrong") => Ok(json!({"version":"old.1","state":{"bots":[],"items":[]}})),
            _ => Err("offline".into()),
        }
    });
    // The first remote ask below also drains earlier tells; reading a local feed must not send v1.
    assert_eq!(peer_feed(&host, None)["kind"], "seed");
    own_rows(&host, &root, "on this computer");
    let detail = |device: Value| json!({"protocol":2,"action":"itemDetail","id":"collision","bot":"b","device":device});
    assert_eq!(
        host.items_query(detail(Value::Null)).await.unwrap()["item"]["title"],
        "on this computer"
    );
    assert_eq!(
        host.items_query(detail(json!("peer"))).await.unwrap()["item"]["title"],
        "on the peer"
    );
    assert_eq!(
        host.items_query(detail(json!("other"))).await.unwrap()["item"]["title"],
        "on the other peer"
    );
    assert!(host.items_query(detail(json!("lost"))).await.is_err());
    assert!(host.items_query(detail(json!("wrong"))).await.is_err());
    assert!(host.items_query(detail(json!("unpaired"))).await.is_err());
    assert!(host.items_query_from(&detail(json!("peer"))).is_err());
    assert!(
        host.items_query_from(
            &json!({"protocol":2,"action":"itemDetail","id":"collision","bot":"Shared name"})
        )
        .is_err()
    );
    assert_eq!(asked.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn malformed_reads_do_not_enter_the_command_or_peer_route() {
    let (host, _) = rig(bot_world("demo"), Caps::default(), main_of(|_, _| None));
    for q in [
        json!({"action":"itemsFeed"}),
        json!({"protocol":1,"action":"itemsFeed"}),
        json!({"protocol":2,"action":"item","id":"x"}),
        json!({"protocol":2,"action":"get"}),
        json!({"protocol":2,"action":"itemsFeed","device":null}),
        json!({"protocol":2,"action":"itemsFeed","since":null}),
        json!({"protocol":2,"action":"itemDetail","bot":"b","id":1,"beforeEvent":1,"afterEvent":0}),
        json!({"protocol":2,"action":"itemsPage","id":"b","before":{"at":1,"number":1,"device":"elsewhere"}}),
        json!({"protocol":2,"action":"itemReceipt","bot":"b","id":"x","requestId":" r"}),
        json!({"protocol":2,"action":"itemReceipt","bot":"b","id":1,"requestId":"r"}),
        json!({"protocol":2,"action":"itemsFeed","since":"𠀀".repeat(129)}),
    ] {
        assert!(host.items_query_from(&q).is_err(), "{q}");
    }
    assert!(
        host.items_query(json!({"protocol":2,"action":"itemsFeed"}))
            .await
            .is_err()
    );
    assert!(
        host.items_query(json!({"protocol":2,"action":"itemsPage","device":false,"id":"b"}))
            .await
            .is_err()
    );
}
