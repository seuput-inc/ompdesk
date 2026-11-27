use super::*;
use crate::agentctl::journal::bots::{BotRecord, BotWorker, WORKERS_KEPT, WorkerOrigin};
use crate::agentctl::journal::send_outbox::OutboxSend;
use crate::agentctl::service::JournalFile;

fn bot() -> BotRecord {
    BotRecord {
        id: "ada".into(),
        name: "Ada".into(),
        folder: "/bots/ada".into(),
        home: Some("/s/bot.jsonl".into()),
        ..BotRecord::default()
    }
}

#[tokio::test]
async fn only_the_fresh_spawn_binds_the_new_file_not_a_reopen_or_a_switch_in_its_tab() {
    let root = Scratch::new();
    let files = Files {
        bots: Some(root.0.join("bots.json")),
        ..Default::default()
    };
    let mut world = bot_world("/bots/ada");
    world["tabs"][3]
        .as_object_mut()
        .unwrap()
        .remove("sessionPath");
    world["tabs"]
        .as_array_mut()
        .unwrap()
        .push(tab("reopen-tab", json!({})));
    world["windowOf"]["reopen-tab"] = json!("w");
    let (control, _) = rig_files(
        world.clone(),
        Caps::default(),
        &files,
        bots_main(Mails::default(), |method, args| match method {
            "spawn" => Some(
                json!({ "tabId": if args["request"]["sessionPath"].is_string() { "reopen-tab" } else { "work1" } }),
            ),
            "stored" => Some(json!([{ "id": "old55555", "path": "/s/old.jsonl", "cwd": "/repo" }])),
            "command" if args["command"]["type"] == "get_state" => {
                Some(json!({ "success": true, "data": { "sessionFile": "/s/new.jsonl" } }))
            }
            "command" if args["command"]["type"] == "agent_control_worker" => {
                Some(json!({ "success": true }))
            }
            _ => None,
        }),
    );
    control.bots().add(bot());
    for args in [
        json!({ "folder": "/repo" }),
        json!({ "reopen": "old55555" }),
    ] {
        let result = control
            .run("bot1", "ompdesk_session_open", args, None)
            .await;
        assert!(!result.is_error, "{}", result.text);
    }
    world["tabs"][3]["sessionPath"] = json!("/s/user-switched.jsonl");
    world["tabs"][4]["sessionPath"] = json!("/s/old.jsonl");
    world["parents"] =
        json!({ "work1": { "callerTabId": "bot1" }, "reopen-tab": { "callerTabId": "bot1" } });
    crate::ports::apply_state(control.host.port(), 1, &world.to_string()).unwrap();
    control.observe_bots();
    let (restored, _) = rig_files(
        json!({}),
        Caps::default(),
        &files,
        bots_main(Mails::default(), |_, _| None),
    );
    let ada = restored.bot_named("ada").unwrap();
    for (path, owned) in [
        ("/s/new.jsonl", true),
        ("/s/old.jsonl", false),
        ("/s/user-switched.jsonl", false),
    ] {
        let worker = ada
            .workers
            .iter()
            .find(|worker| worker.session == path)
            .unwrap();
        assert_eq!(restored.worker_opened_by_bot(&ada, worker), owned, "{path}");
    }
}

#[tokio::test]
async fn an_open_cannot_claim_a_replaced_tab_before_the_worker_is_recorded() {
    for changed in [
        json!({ "sessionMoved": true }),
        json!({ "restored": true }),
        json!({ "viewing": true }),
        json!({ "device": "other" }),
    ] {
        let mut world = bot_world("/bots/ada");
        for (key, value) in changed.as_object().unwrap() {
            world["tabs"][3][key] = value.clone();
        }
        world["parents"] = json!({ "work1": { "callerTabId": "bot1" } });
        let (control, asked) = rig(
            world,
            Caps::default(),
            bots_main(Mails::default(), |method, _| {
                (method == "spawn").then(|| json!({ "tabId": "work1" }))
            }),
        );
        control.bots().add(bot());
        let result = control
            .run(
                "bot1",
                "ompdesk_session_open",
                json!({ "folder": "/repo", "message": "work" }),
                None,
            )
            .await;
        assert!(result.is_error, "{changed}");
        control.observe_bots();
        let ada = control.bot_named("ada").unwrap();
        assert!(
            ada.workers
                .iter()
                .all(|w| !control.worker_opened_by_bot(&ada, w)),
            "{changed}"
        );
        assert!(
            !asked
                .lock()
                .unwrap()
                .iter()
                .any(|(_, args)| args["command"]["type"] == "agent_control_worker")
        );
    }
}

#[tokio::test]
async fn only_a_creation_command_to_the_exact_receiver_from_the_exact_local_chat_proves_a_legacy_link()
 {
    let root = Scratch::new();
    let files = Files {
        send_outbox: Some(JournalFile {
            file: Some(root.0.join("sends.json")),
        }),
        ..Default::default()
    };
    let (control, _) = rig_files(json!({}), Caps::default(), &files, |_, _| Ok(Value::Null));
    let outbox = control.send_outbox.as_ref().unwrap();
    let mut entry = OutboxSend::new(
        "d1".into(),
        Some(1),
        "/s/worker.jsonl".into(),
        Some("remote".into()),
        "/s/bot.jsonl".into(),
        "agent_control_worker".into(),
        "agent_control_worker".into(),
        control.now(),
    );
    let mut worker = BotWorker {
        session: entry.session_path.clone(),
        opened_by_session: Some(entry.from.clone()),
        device: entry.device.clone(),
        ..Default::default()
    };
    let ada = bot();
    entry.before.push(json!({ "type": "set_model" }));
    outbox.keep(entry.clone());
    assert!(
        !control.worker_opened_by_bot(&ada, &worker),
        "a reopened session can have model setup and a first message"
    );
    entry
        .before
        .push(json!({ "type": "agent_control_worker", "from": "same display name" }));
    entry.from_device = Some("peer".into());
    outbox.keep(entry.clone());
    assert!(
        !control.worker_opened_by_bot(&ada, &worker),
        "same caller path on a peer"
    );
    entry.from_device = None;
    outbox.keep(entry);
    let (restored, _) = rig_files(json!({}), Caps::default(), &files, |_, _| Ok(Value::Null));
    assert!(restored.worker_opened_by_bot(&ada, &worker));
    worker.device = None;
    assert!(
        !restored.worker_opened_by_bot(&ada, &worker),
        "same target path locally"
    );
    worker.device = Some("remote".into());
    worker.origin = Some(WorkerOrigin::Handed);
    assert!(
        !restored.worker_opened_by_bot(&ada, &worker),
        "a hand supersedes creation evidence"
    );
    worker.origin = None;
    restored
        .send_outbox
        .as_ref()
        .unwrap()
        .settle(&worker.session, Some("remote"), "d1");
    assert!(
        !restored.worker_opened_by_bot(&ada, &worker),
        "no surviving creation evidence"
    );
}

#[tokio::test]
async fn a_bot_keeps_older_workers_and_separate_links_for_the_same_path_on_two_computers() {
    let (control, _) = rig(json!({}), Caps::default(), |_, _| Ok(Value::Null));
    let mut bots = control.bots();
    bots.add(bot());
    for i in 0..=WORKERS_KEPT {
        let worker = BotWorker {
            session: format!("/s/{i}.jsonl"),
            cwd: "/repo".into(),
            origin: Some(WorkerOrigin::Opened),
            ..Default::default()
        };
        bots.observe_worker(Some("ada"), "tab", worker);
    }
    let remote = BotWorker {
        session: "/s/0.jsonl".into(),
        cwd: "/repo".into(),
        device: Some("other".into()),
        origin: Some(WorkerOrigin::Handed),
        ..Default::default()
    };
    bots.observe_worker(Some("ada"), "remote-tab", remote);
    let workers = &bots.find("ada").unwrap().workers;
    assert_eq!(workers.len(), WORKERS_KEPT + 2);
    assert_eq!(workers[0].session, "/s/0.jsonl");
    assert_eq!(workers[0].device, None);
    assert_eq!(workers[0].origin, Some(WorkerOrigin::Opened));
    drop(bots);
    assert_eq!(
        control.bots_state()["bots"][0]["workers"]
            .as_array()
            .unwrap()
            .len(),
        WORKERS_KEPT
    );
}

#[tokio::test]
async fn an_unsaved_hand_does_not_change_the_opener_and_retry_persists_the_hand() {
    let root = Scratch::new();
    let registry = root.0.join("bots.json");
    let files = Files {
        bots: Some(registry.clone()),
        ..bot_files(&root)
    };
    let (control, asked, id) = ada_in(&root, &files, Mails::default(), |_, _| None).await;
    let hand = json!({ "action": "handTo", "id": id, "session": "work1", "text": "Review" });
    std::fs::remove_file(&registry).unwrap();
    std::fs::create_dir(&registry).unwrap();
    assert!(control.bots_command(hand.clone()).await.is_err());
    assert!(
        !asked
            .lock()
            .unwrap()
            .iter()
            .any(|(method, _)| method == "setOpener")
    );
    std::fs::remove_dir(&registry).unwrap();
    control.bots_command(hand).await.unwrap();
    let (restored, _) = rig_files(
        json!({}),
        Caps::default(),
        &files,
        bots_main(Mails::default(), |_, _| None),
    );
    let ada = restored.bot_named("Ada").unwrap();
    assert_eq!(
        ada.workers
            .iter()
            .find(|worker| worker.session == "/s/work.jsonl")
            .unwrap()
            .origin,
        Some(WorkerOrigin::Handed)
    );
}
