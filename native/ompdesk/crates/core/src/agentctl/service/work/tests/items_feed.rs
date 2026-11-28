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
    host.items_change_from(
        &json!({"action":"item","id":"collision","comment":"late comment","requestId":"r1"}),
    )
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
    host.items_change_from(&json!({"action":"item","id":"collision","status":"done"}))
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
        json!({"protocol":2,"action":"itemsLinked","bot":"b","sessions":[]}),
        json!({"protocol":2,"action":"itemsLinked","bot":"b","sessions":vec!["s";129]}),
        json!({"protocol":2,"action":"itemsLinked","bot":"b","sessions":["\n"]}),
        json!({"protocol":2,"action":"itemsLinked","bot":"b","sessions":["s".repeat(32_769)]}),
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

#[tokio::test]
async fn compact_comments_deliver_once_and_publish_only_to_subscribed_v1_audiences() {
    let root = Scratch::new();
    let mails = Mails::default();
    let (host, asked) = rig(
        bot_world("demo"),
        Caps::default(),
        bots_main(mails.clone(), |_, _| None),
    );
    own_rows(&host, &root, "one");
    let mut base = host.bots_share()["version"].clone();
    for (version, (local, peer)) in
        (2..).zip([(false, false), (true, false), (false, true), (true, true)])
    {
        host.items_legacy_audience(local, peer);
        let request = json!({"action":"item","id":"collision","comment":"words","requestId":format!("r{version}")});
        let offset = asked.lock().unwrap().len();
        assert_eq!(
            host.items_change(Value::Null, request.clone())
                .await
                .unwrap(),
            json!({})
        );
        assert_eq!(host.items_change_from(&request).await.unwrap(), json!({}));
        let frames = asked.lock().unwrap();
        let frames = &frames[offset..];
        let count = |kind| frames.iter().filter(|(m, _)| m == kind).count();
        assert_eq!(count("itemsV2Changed"), 1);
        assert!(
            frames
                .iter()
                .all(|(m, args)| m != "itemsV2Changed" || args == &json!({}))
        );
        assert_eq!(count("botsChanged"), usize::from(local));
        assert_eq!(count("botsShared"), usize::from(peer));
        assert_eq!(count("botQuietFolders"), 0);
        assert_eq!(count("mail"), 1);
        assert_eq!(delivered(&mails, &format!("item-collision-v{version}")), 1);
        if let Some((_, state)) = frames.iter().find(|(m, _)| m == "botsChanged") {
            assert_eq!(
                state["state"]["items"][0]["events"][version - 1]["text"],
                "words"
            );
        }
        if let Some((_, state)) = frames.iter().find(|(m, _)| m == "botsShared") {
            assert_eq!(state["change"]["base"], base);
            assert_eq!(state["change"]["set"]["items"][0]["version"], version);
            base = state["change"]["version"].clone();
        }
    }
}

#[tokio::test]
async fn compact_mutations_never_reroute_missing_offline_or_colliding_targets() {
    let root = Scratch::new();
    let mut world = bot_world("demo");
    world["devices"] = json!([
        {"id":"peer","name":"Peer","state":"online"},
        {"id":"bad","name":"Bad","state":"online"},
        {"id":"lost","name":"Lost","state":"offline"}
    ]);
    let (host, asked) = rig(world, Caps::default(), |method, args| {
        assert_eq!(method, "remoteItemsChange");
        assert_eq!(
            args["request"],
            json!({"action":"item","id":"collision","comment":"remote"})
        );
        Ok(if args["device"] == "peer" {
            json!({})
        } else {
            json!({"state":{"items":[]}})
        })
    });
    own_rows(&host, &root, "local");
    let r = json!({"action":"item","id":"collision","comment":"remote"});
    assert_eq!(
        host.items_change(json!("peer"), r.clone()).await.unwrap(),
        json!({})
    );
    for device in [
        json!("bad"),
        json!("lost"),
        json!("unknown"),
        json!(" peer"),
        json!(0),
    ] {
        assert!(host.items_change(device, r.clone()).await.is_err());
    }
    for request in [
        json!({"action":"item","id":"collision","device":"elsewhere","comment":"no"}),
        json!({"action":"itemBatch","ids":["collision","missing"],"requestId":"all","status":"done"}),
        json!({"action":"item","id":"missing","comment":"no"}),
        json!({"action":"item","ids":["collision"],"id":"different","comment":"no"}),
        json!({"action":"itemsOpened","id":"Shared name"}),
        json!({"action":"itemBatch","ids":["collision"],"requestId":"a","status":"done","answer":{"text":"wake"}}),
        json!({"action":"delete","id":"b"}),
    ] {
        assert!(host.items_change_from(&request).await.is_err(), "{request}");
    }
    assert_eq!(host.items().get("collision").unwrap().version, 1);
    assert_eq!(asked.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn compact_batch_reopens_an_archive_and_replays_the_committed_versions() {
    let root = Scratch::new();
    let (host, _) = rig(
        bot_world("demo"),
        Caps::default(),
        bots_main(Mails::default(), |_, _| None),
    );
    own_rows(&host, &root, "archived");
    host.items()
        .change("collision", |row| {
            row.status = "done".into();
            row.closed = Some(1.);
            row.event("2000-01-01", "owner", "status", Some("done"));
        })
        .unwrap();
    assert_eq!(host.bots_state()["items"], json!([]));
    let seen = json!({"action":"itemsOpened","id":"b"});
    assert_eq!(host.items_change_from(&seen).await.unwrap(), json!({}));
    assert_eq!(host.bots().find("b").unwrap().items_seen, 2);
    let seed = peer_feed(&host, None);
    host.items_change_from(&seen).await.unwrap();
    assert_eq!(
        peer_feed(&host, Some(&seed["version"]))["version"],
        seed["version"]
    );
    let change =
        json!({"action":"itemBatch","ids":["collision"],"status":"planned","requestId":"reopen"});
    let receipt = json!({"itemBatchResult":{"ids":["collision"],"changed":[{"id":"collision","version":2}],"refused":null}});
    assert_eq!(host.items_change_from(&change).await.unwrap(), receipt);
    host.items_change_from(&json!({"action":"item","id":"collision","comment":"later"}))
        .await
        .unwrap();
    assert_eq!(host.items_change_from(&change).await.unwrap(), receipt);
    assert_eq!(host.bots_state()["items"][0]["status"], "planned");
}

#[tokio::test]
async fn local_roster_changes_do_not_invalidate_a_peers_feed() {
    let (host, _) = rig(quiet_world(), Caps::default(), main_of(|_, _| None));
    let local = |since: Option<&Value>| {
        let mut q = json!({"protocol":2,"action":"itemsFeed","device":null});
        if let Some(version) = since {
            q["since"] = version.clone();
        }
        host.items_query(q)
    };
    let initial = local(None).await.unwrap();
    let peer = peer_feed(&host, None);
    assert_eq!(initial["remote"], json!([]));
    assert!(peer.get("remote").is_none());
    let roster = json!({"device":"remote","name":"Paired","online":true});
    let mut update = roster.clone();
    update["change"] = json!({"version":"test.1","state":{"bots":[],"items":[]}});
    assert_eq!(host.bots_remote(&update)["applied"], true);
    let joined = local(Some(&initial["version"])).await.unwrap();
    assert_eq!(joined["kind"], "seed");
    assert_eq!(joined["remote"], json!([roster]));
    update["change"] = json!({"version":"test.2","state":{"bots":[],"items":[]}});
    host.bots_remote(&update);
    assert_eq!(
        local(Some(&joined["version"])).await.unwrap()["kind"],
        "delta"
    );
    host.bots_remote(&json!({"device":"remote","name":"Paired","online":false}));
    let offline = local(Some(&joined["version"])).await.unwrap();
    assert_eq!(offline["remote"][0]["online"], false);
    host.bots_remote(&json!({"device":"remote","forget":true}));
    assert_eq!(
        local(Some(&offline["version"])).await.unwrap()["remote"],
        json!([])
    );
    assert_eq!(
        peer_feed(&host, Some(&peer["version"]))["version"],
        peer["version"]
    );
}

#[tokio::test]
async fn linked_sessions_are_scoped_and_live_only_on_a_summary() {
    let root = Scratch::new();
    let mut world = bot_world("demo");
    world["tabs"][3]["busy"] = json!(true);
    let (host, _) = rig(world, Caps::default(), main_of(|_, _| None));
    own_rows(&host, &root, "assigned");
    assert_eq!(peer_feed(&host, None)["open"][0]["live"], true);
    let q = json!({"protocol":2,"action":"itemsLinked","bot":"b","sessions":["/s/work.jsonl","/unrelated"]});
    let reply = host.items_query_from(&q).unwrap();
    assert_eq!(
        reply,
        json!({"protocol":2,"links":[{"session":"/s/work.jsonl","number":1,"title":"assigned"}]})
    );
    let mut other = q;
    other["bot"] = json!("Shared name");
    assert!(host.items_query_from(&other).is_err());
    let detail = host
        .items_query_from(&json!({"protocol":2,"action":"itemDetail","bot":"b","id":"collision"}))
        .unwrap();
    assert_eq!(detail["item"]["links"][0]["state"], "working");
    assert!(detail["item"].get("live").is_none());
}

#[tokio::test]
async fn compact_answer_replay_respects_the_question_that_was_actually_answered() {
    let root = Scratch::new();
    let mails = Mails::default();
    let (host, _) = rig(
        bot_world("demo"),
        Caps::default(),
        bots_main(mails.clone(), |_, _| None),
    );
    own_rows(&host, &root, "answer");
    let ask = || {
        host.items()
            .change("collision", |row| {
                row.event("2026-11-28T12:00:00Z", "bot", "asked", Some("Do this?"));
                row.status = "needs_you".into();
                row.question = Some(crate::agentctl::journal::items::ItemQuestion {
                    text: "Do this?".into(),
                    ..Default::default()
                });
            })
            .unwrap()
            .unwrap()
            .question
            .unwrap()
            .id
    };
    let first = ask();
    let answer = |key, question| json!({"action":"item","id":"collision","requestId":key,"answer":{"question":question,"text":"yes"}});
    let receipt = |key, question| {
        host.items_query_from(&json!({"protocol":2,"action":"itemReceipt","bot":"b","id":"collision","requestId":key,"question":question})).unwrap()
    };
    assert_eq!(
        host.items_change_from(&answer("first", first))
            .await
            .unwrap(),
        json!({})
    );
    let second = ask();
    assert_ne!(first, second);
    assert_eq!(
        host.items_change_from(&answer("first", first))
            .await
            .unwrap(),
        json!({})
    );
    assert!(
        host.items_change_from(&answer("first", second))
            .await
            .is_err()
    );
    assert_eq!(
        host.items_change_from(&answer("late", first))
            .await
            .unwrap(),
        json!({"refused":"question_changed"})
    );
    assert_eq!(
        host.items_change_from(&answer("late", first))
            .await
            .unwrap(),
        json!({"refused":"question_changed"})
    );
    assert_eq!(receipt("first", first)["outcome"], "answered");
    assert_eq!(receipt("first", second)["outcome"], "unknown");
    assert_eq!(receipt("late", first)["outcome"], "question_changed");
    assert_eq!(
        mails
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, delivered)| *delivered)
            .count(),
        1
    );
}

#[tokio::test]
async fn notification_routing_follows_the_registry_without_a_legacy_subscriber() {
    let root = Scratch::new();
    let (host, asked) = rig_files(
        quiet_world(),
        Caps::default(),
        &bot_files(&root),
        bots_main(Mails::default(), |_, _| None),
    );
    host.tell_quiet_folders();
    let bot = host.create_bot("New", None).unwrap();
    host.bots_command(json!({"action":"update","id":bot.id,"quiet":["failed"]}))
        .await
        .unwrap();
    let preview = host
        .bots_command(json!({"action":"deletePreview","id":bot.id}))
        .await
        .unwrap();
    host.bots_command(json!({"action":"delete","id":bot.id,"expected":preview}))
        .await
        .unwrap();
    host.host.port().fresh().await.unwrap();
    let calls = asked.lock().unwrap();
    let routing: Vec<_> = calls
        .iter()
        .filter(|(m, _)| m == "botQuietFolders")
        .map(|(_, v)| v.clone())
        .collect();
    assert_eq!(
        routing,
        [
            json!({"folders":[]}),
            json!({"folders":[{"folder":bot.folder,"quiet":[]}]}),
            json!({"folders":[{"folder":bot.folder,"quiet":["failed"]}]}),
            json!({"folders":[]}),
        ]
    );
    assert!(
        calls
            .iter()
            .all(|(m, _)| m != "botsChanged" && m != "botsShared")
    );
}

#[tokio::test]
async fn a_numeric_bot_comment_leaves_the_chat_digest_alone_but_a_new_question_reaches_it() {
    let root = Scratch::new();
    let (sent, mut digests) = tokio::sync::mpsc::unbounded_channel();
    let main = bots_main(Mails::default(), move |method, args| {
        if method == "command" && args["command"]["type"] == "agent_control_bot" {
            sent.send(args["command"]["context"].clone()).unwrap();
        }
        None
    });
    let (host, calls) = rig(bot_world(&root.0.to_string_lossy()), Caps::default(), main);
    own_rows(&host, &root, "work");
    host.bots_tick().await;
    let initial = digests.try_recv().unwrap();
    assert_eq!(
        initial["items"],
        json!([{"number":1,"title":"work","status":"working"}])
    );
    assert_eq!(initial["needsYou"], json!([]));
    let before = host.items().full_reads();
    let at = calls.lock().unwrap().len();
    let tool = |args| host.run("bot1", "ompdesk_item", args, None);
    let result = tool(json!({"action":"comment","item":"#1","text":"kept in detail"})).await;
    assert!(!result.is_error, "{}", result.text);
    host.host.port().fresh().await.unwrap();
    assert_eq!(host.items().full_reads(), before);
    assert!(digests.try_recv().is_err());
    {
        let calls = calls.lock().unwrap();
        assert!(
            calls[at..]
                .iter()
                .all(|(m, _)| !matches!(m.as_str(), "botsChanged" | "botsShared"))
        );
        assert!(
            calls[at..]
                .iter()
                .any(|(m, v)| m == "itemsV2Changed" && v == &json!({}))
        );
    }
    let detail = host
        .items_query_from(&json!({"protocol":2,"action":"itemDetail","bot":"b","id":1}))
        .unwrap();
    assert_eq!(detail["events"][1]["text"], "kept in detail");
    let result = tool(
        json!({"action":"set","item":"#1","ask":"Which?","options":["A","B"],"recommended":1}),
    )
    .await;
    assert!(!result.is_error, "{}", result.text);
    let next = tokio::time::timeout(std::time::Duration::from_secs(2), digests.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(next["needsYou"], next["items"]);
    let row = &next["items"][0];
    assert_eq!(row["status"], "needs_you");
    assert_eq!(row["question"]["text"], "Which?");
    assert_eq!(row["question"]["options"], json!(["A", "B"]));
    assert_eq!(row["question"]["recommended"], 1);
}
