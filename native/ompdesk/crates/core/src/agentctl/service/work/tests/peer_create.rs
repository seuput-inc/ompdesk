use super::*;

#[tokio::test]
async fn invalid_peer_routines_never_make_a_folder_or_registry_row() {
    let root = Scratch::new();
    let files = kept_files(&root);
    let (host, _) = rig_files(quiet_world(), Caps::default(), &files, |_, _| {
        Ok(Value::Null)
    });
    let daily =
        json!({"label":"Morning","frequency":{"kind":"daily","time":"09:00","days":[1,2,3,4,5]}});
    let mut cases = vec![
        Value::Null,
        json!({}),
        json!([daily, daily, daily]),
        json!([{"label":"","frequency":daily["frequency"]}]),
        json!([["Morning", daily["frequency"]]]),
        json!([{"label":"Bad\nLabel","frequency":daily["frequency"]}]),
        json!([{"label":"x".repeat(81),"frequency":daily["frequency"]}]),
        json!([{"label":"Daily","frequency":daily["frequency"],"enabled":true}]),
    ];
    for freq in [
        json!({"kind":"interval","minutes":0}),
        json!({"kind":"interval","minutes":12.5}),
        json!({"kind":"interval","minutes":120,"days":[]}),
        json!({"kind":"cron","expr":"0 9 * * *"}),
        json!({"kind":"daily","time":"24:00","days":[]}),
        json!({"kind":"daily","time":"09:00"}),
        json!({"kind":"daily","time":"09:00","days":[1,1]}),
        json!({"kind":"daily","time":"09:00","days":[7]}),
    ] {
        cases.push(json!([{"label":"Test","frequency":freq}]));
    }
    for routines in cases {
        assert!(
            host.bots_from(
                json!({"action":"create","name":"Blocked","routines":routines}),
                "creator",
                "Peer",
                Some("key")
            )
            .await
            .is_err()
        );
        assert!(!root.0.join("blocked").exists());
    }
    assert!(host.bots().all().is_empty());
    assert!(!files.bots.unwrap().exists());
    host.bots_from(
        json!({"action":"create","name":"Ada","routines":[daily]}),
        "creator",
        "Peer",
        Some("key"),
    )
    .await
    .unwrap();
    assert!(!root.0.join("schedules.json").exists());
    let stored: Value =
        serde_json::from_slice(&std::fs::read(root.0.join("bots.json")).unwrap()).unwrap();
    assert_eq!(stored[0]["peerCreate"]["routines"], json!([daily]));
}

#[tokio::test]
async fn the_first_observed_creator_home_owns_one_mail_across_restarts() {
    let root = Scratch::new();
    let files = kept_files(&root);
    let mails = Mails::default();
    let start = || {
        rig_files(
            quiet_world(),
            Caps::default(),
            &files,
            bots_main(
                mails.clone(),
                chat_facts(&Arc::new(Mutex::new(said(0, false, "none")))),
            ),
        )
        .0
    };
    let host = start();
    let share = host
        .bots_from(
            json!({"action":"create","name":"Ada","kickoff":"Begin."}),
            "creator",
            "Peer",
            Some("create"),
        )
        .await
        .unwrap();
    let row = &share["state"]["bots"][0];
    assert_eq!(row["peerPending"], "home");
    assert!(row.get("peerCreate").is_none());
    let folder = row["folder"].as_str().unwrap();
    crate::ports::apply_state(host.host.port(), 1, &bot_world(folder).to_string()).unwrap();
    host.bots_tick().await;
    assert!(host.bot_named("Ada").unwrap().home.is_none());
    assert!(!host.kickoff_retry("Ada", true).await.unwrap());
    assert!(mails.lock().unwrap().is_empty());
    let observation = |device: &str, cwd: &str, id: &str| {
        serde_json::from_value(json!({
        "device":device,"cwd":cwd,"sessionId":id,"sessionPath":root.0.join(format!("session_{id}.jsonl"))
    })).unwrap()
    };
    let home = observation("creator", folder, "one");
    let other = observation("creator", folder, "two");
    assert!(host.peer_home_candidate(&home));
    assert!(host.observe_peer_home(&home).is_err());
    assert!(host.bot_named("Ada").unwrap().home.is_none());
    for id in ["one", "two"] {
        std::fs::write(
            root.0.join(format!("session_{id}.jsonl")),
            format!("{}\n", json!({"type":"session","id":id,"cwd":folder})),
        )
        .unwrap();
    }
    let same_file: super::super::bot_peer::PeerHome = serde_json::from_value(json!({
        "device":"creator","cwd":folder,"sessionId":"other","sessionPath":root.0.join("session_one.jsonl")
    })).unwrap();
    let path = root
        .0
        .join("session_one.jsonl")
        .to_string_lossy()
        .into_owned();
    assert!(host.bots().observe(folder, &path));
    assert!(host.bot_named("Ada").unwrap().home.is_none());
    assert!(
        host.observe_peer_home(&observation("other", folder, "one"))
            .unwrap()
            .is_null()
    );
    assert!(
        host.observe_peer_home(&observation("creator", "elsewhere", "one"))
            .unwrap()
            .is_null()
    );
    let answer = host.observe_peer_home(&home).unwrap();
    assert_eq!(
        host.bot_named("Ada")
            .unwrap()
            .sessions
            .iter()
            .filter(|known| **known == path)
            .count(),
        1
    );
    assert!(host.peer_home_candidate(&home));
    assert!(!host.peer_home_candidate(&other));
    assert!(!host.peer_home_candidate(&same_file));
    assert_eq!(answer["context"]["bot"]["firstRun"], true);
    assert_eq!(answer["mail"]["text"], "Begin.");
    assert!(
        answer["mail"]["content"]
            .as_str()
            .unwrap()
            .contains("Answer the owner in this chat")
    );
    let mail = answer["mail"]["id"].as_str().unwrap();
    assert!(host.observe_peer_home(&other).unwrap().is_null());
    assert!(!host.settle_peer_home(&other, mail, true, false).unwrap());
    assert!(!host.settle_peer_home(&home, "wrong", true, false).unwrap());
    assert!(!host.settle_peer_home(&home, mail, false, false).unwrap());
    assert_eq!(
        host.bots_share()["state"]["bots"][0]["peerPending"],
        "kickoff"
    );
    assert!(host.settle_peer_home(&home, mail, false, true).unwrap());
    assert_eq!(
        host.bots_share()["state"]["bots"][0]["peerPending"],
        "limit"
    );
    drop(host);
    let host = start();
    assert_eq!(
        host.observe_peer_home(&home).unwrap()["mail"],
        answer["mail"]
    );
    assert!(host.settle_peer_home(&home, mail, true, false).unwrap());
    assert!(host.settle_peer_home(&home, mail, true, false).unwrap());
    drop(host);
    let host = start();
    let already_journaled = host.observe_peer_home(&home).unwrap();
    assert_eq!(already_journaled["context"]["bot"]["firstRun"], false);
    assert_eq!(already_journaled.get("mail"), Some(&Value::Null));
    assert!(
        host.bots_share()["state"]["bots"][0]
            .get("peerPending")
            .is_none()
    );
    let blank = host
        .bots_from(
            json!({"action":"create","name":"Blank"}),
            "creator",
            "Peer",
            Some("blank"),
        )
        .await
        .unwrap();
    let folder = blank["state"]["bots"][1]["folder"].as_str().unwrap();
    std::fs::write(
        root.0.join("session_blank.jsonl"),
        format!("{}\n", json!({"type":"session","id":"blank","cwd":folder})),
    )
    .unwrap();
    let home = observation("creator", folder, "blank");
    let blank_home = host.observe_peer_home(&home).unwrap();
    assert_eq!(blank_home["context"]["bot"]["firstRun"], false);
    assert_eq!(blank_home.get("mail"), Some(&Value::Null));
    assert!(
        host.bots_share()["state"]["bots"][1]
            .get("peerPending")
            .is_none()
    );
}

#[tokio::test]
async fn two_eligible_live_homes_only_pin_one() {
    use std::sync::Barrier;
    let root = Scratch::new();
    let files = kept_files(&root);
    let (host, _) = rig_files(quiet_world(), Caps::default(), &files, |_, _| {
        Ok(Value::Null)
    });
    host.bots_from(
        json!({"action":"create","name":"Ada"}),
        "creator",
        "Peer",
        Some("key"),
    )
    .await
    .unwrap();
    let bot = host.bot_named("Ada").unwrap();
    let homes = ["one", "two"].map(|id| {
        let file = root.0.join(format!("{id}.jsonl"));
        std::fs::write(
            &file,
            format!("{}\n", json!({"type":"session","id":id,"cwd":bot.folder})),
        )
        .unwrap();
        serde_json::from_value(
            json!({"device":"creator","cwd":bot.folder,"sessionId":id,"sessionPath":file}),
        )
        .unwrap()
    });
    let gate = Barrier::new(2);
    let results = std::thread::scope(|scope| {
        let (host, gate) = (&host, &gate);
        homes
            .each_ref()
            .map(|home| {
                scope.spawn(move || {
                    let eligible = host.peer_home_candidate(home);
                    gate.wait();
                    assert!(eligible);
                    host.observe_peer_home(home).unwrap()
                })
            })
            .map(|thread| thread.join().unwrap())
    });
    assert_eq!(
        results.iter().filter(|result| result.is_object()).count(),
        1
    );
    let restored = crate::agentctl::journal::bots::Bots::new(files.bots);
    let bot = restored.find("Ada").unwrap();
    let winner = bot
        .peer_create
        .as_ref()
        .unwrap()
        .session_id
        .as_deref()
        .unwrap();
    assert_eq!(
        bot.home.as_deref().map(Path::new),
        Some(root.0.join(format!("{winner}.jsonl")).as_path())
    );
    assert_eq!(bot.sessions.len(), 1);
}
