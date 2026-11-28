use super::*;
use crate::agentctl::journal::items::{ItemQuestion, ItemRecord};
use crate::agentctl::rules::mail::{Mail, MailKind};
use std::fs::File;
use std::io::Write as _;
use std::process::Command;
use std::sync::atomic::AtomicBool;

const CHAT: &str = "/s/bot.jsonl";
const CHILD: &str = "agentctl::service::work::tests::owner_replay::crash_at_handoff";
const PROFILE: &str = "OMPDESK_TEST_ITEM_REPLAY_PROFILE";
const CUT: &str = "OMPDESK_TEST_ITEM_REPLAY_CUT";

fn files(root: &Path) -> Files {
    Files {
        items: Some(root.join("items.json")),
        ..Files::default()
    }
}

fn seed(host: &AgentControl, id: &str, number: u32) {
    let mut item = ItemRecord {
        id: id.into(),
        bot: "bot".into(),
        number,
        session: CHAT.into(),
        title: id.into(),
        status: "planned".into(),
        version: 1,
        ..ItemRecord::default()
    };
    item.event("2026-11-27", "bot", "made", None);
    host.items().add(item).unwrap();
}

fn ask(host: &AgentControl, id: &str) -> u64 {
    let saved = host
        .items()
        .change(id, |item| {
            item.event("2026-11-28", "bot", "asked", Some("Now?"));
            item.status = "needs_you".into();
            item.question = Some(ItemQuestion {
                text: "Now?".into(),
                ..ItemQuestion::default()
            });
        })
        .unwrap()
        .unwrap();
    saved.question.unwrap().id
}

fn waiting() -> Value {
    json!({"action":"itemBatch", "device":null, "requestId":"move", "ids":["b","a","b"],
           "status":"waiting", "wait":"the vendor"})
}

// A process exit here runs no destructors. The second cut flushes the receiver's file but never answers the host.
#[tokio::test]
#[ignore = "started by owner_mail_survives_both_handoff_crash_windows"]
async fn crash_at_handoff() {
    let Some(root) = std::env::var_os(PROFILE) else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let before = std::env::var(CUT).unwrap() == "before";
    let files = files(&root);
    let (host, _) = rig_files(
        bot_world("demo"),
        Caps::default(),
        &files,
        move |method, args| {
            if method == "mail" {
                let name = if before { "attempt" } else { "accepted" };
                let mut f = File::create_new(root.join(name)).unwrap();
                f.write_all(args["details"].to_string().as_bytes()).unwrap();
                f.sync_all().unwrap();
                std::process::exit(if before { 81 } else { 82 });
            }
            Ok(Value::Null)
        },
    );
    if before {
        seed(&host, "a", 1);
        seed(&host, "b", 2);
        host.bots_command(waiting()).await.unwrap();
    } else {
        host.bots_tick().await;
    }
    panic!("the committed mail never reached the handoff");
}

#[tokio::test]
async fn owner_mail_survives_both_handoff_crash_windows() {
    let root = Scratch::new();
    for (cut, code) in [("before", 81), ("after", 82)] {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", CHILD, "--nocapture"])
            .env(PROFILE, &root.0)
            .env(CUT, cut)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(code), "{output:?}");
    }
    let read = |name: &str| -> Value {
        serde_json::from_slice(&std::fs::read(root.0.join(name)).unwrap()).unwrap()
    };
    let accepted = read("accepted");
    assert_eq!(read("attempt"), accepted);
    assert_eq!(accepted["id"], "item-b-v2+2");
    assert_eq!(accepted["itemSession"], CHAT);
    assert_eq!(
        accepted["text"],
        concat!(
            "Item #2 “b” [waiting]: The owner set it to waiting on: the vendor.\n",
            "Item #1 “a” [waiting]: The owner set it to waiting on: the vendor."
        )
    );

    let files = files(&root.0);
    let (host, asked) = rig_files(
        bot_world("demo"),
        Caps::default(),
        &files,
        move |method, args| {
            if method == "mail" {
                assert_eq!(args["details"], accepted);
                Ok(json!({"duplicate":true,"journaled":true,"itemSession":CHAT}))
            } else {
                Ok(Value::Null)
            }
        },
    );
    host.items()
        .change("a", |item| {
            item.version += 1;
            item.title = "Renamed since the move".into();
            item.event("2026-11-28", "bot", "edited", None);
        })
        .unwrap()
        .unwrap();
    // A resend and the restart pass compete for one handoff. The queued receipt is independent of the current snapshot.
    let (result, ()) = tokio::join!(host.bots_command(waiting()), host.bots_tick());
    let state = result.unwrap();
    assert_eq!(
        state["itemBatchResult"],
        json!({"ids":["b","a","b"], "changed":[{"id":"b","version":2},{"id":"a","version":2}],
               "refused":null})
    );
    for row in state["items"].as_array().unwrap() {
        let version = if row["id"] == "a" { 3 } else { 2 };
        assert_eq!(row["version"], version);
        assert_eq!(row["events"].as_array().unwrap().len(), version);
    }
    assert_eq!(state["items"].as_array().unwrap().len(), 2);
    let store = host.items();
    assert!(store.get("b").unwrap().events[1].id < store.get("a").unwrap().events[1].id);
    drop(store);
    let count = asked
        .lock()
        .unwrap()
        .iter()
        .filter(|(m, _)| m == "mail")
        .count();
    assert_eq!(count, 1);
    drop(host);
    let (host, asked) = rig_files(bot_world("demo"), Caps::default(), &files, |_, _| {
        Ok(Value::Null)
    });
    host.bots_tick().await;
    assert!(!asked.lock().unwrap().iter().any(|(m, _)| m == "mail"));
}

#[tokio::test]
async fn a_refused_owner_request_stays_refused_when_the_question_changes_after_restart() {
    let root = Scratch::new();
    let files = files(&root.0);
    let (host, _) = rig_files(quiet_world(), Caps::default(), &files, |_, _| {
        Ok(Value::Null)
    });
    seed(&host, "a", 1);
    let next = host.items().get("a").unwrap().events[0].id + 1;
    let request = json!({"action":"item", "id":"a", "requestId":"answer",
                         "answer":{"question":next,"text":"yes"}});
    let first = host.bots_command(request.clone()).await.unwrap();
    assert_eq!(first["refused"], "question_changed");
    drop(host);
    let (host, asked) = rig_files(bot_world("demo"), Caps::default(), &files, |_, _| {
        Ok(Value::Null)
    });
    assert_eq!(ask(&host, "a"), next);
    let result = host.bots_command(request).await.unwrap();
    assert_eq!(result["refused"], "question_changed");
    assert_eq!(result["items"][0]["question"]["id"], next);
    assert!(
        !asked
            .lock()
            .unwrap()
            .iter()
            .any(|(m, _)| m == "mail" || m == "reach")
    );
}

#[tokio::test]
async fn invalid_batches_cannot_wake_a_chat_or_poison_a_retry_key() {
    let root = Scratch::new();
    let files = files(&root.0);
    let (host, _) = rig_files(quiet_world(), Caps::default(), &files, |_, _| {
        Ok(Value::Null)
    });
    seed(&host, "a", 1);
    for (field, value) in [
        ("requestId", json!("")),
        ("requestId", json!("x".repeat(201))),
        ("answer", json!({"text":"wake"})),
        ("comment", json!("hello")),
        ("snoozeUntil", Value::Null),
        ("ids", json!([false])),
    ] {
        let mut request = waiting();
        request[field] = value;
        assert!(host.bots_command(request.clone()).await.is_err());
        request.as_object_mut().unwrap().remove("device");
        assert!(host.bots_from(request, "peer", "Peer", None).await.is_err());
    }
    let mut remote = waiting();
    remote.as_object_mut().unwrap().remove("device");
    assert!(host.bots_command(remote.clone()).await.is_err());
    assert_eq!(host.items().get("a").unwrap().version, 1);
    let answer = host.bots_from(remote, "peer", "Peer", None).await.unwrap();
    assert_eq!(answer["state"]["items"][0]["version"], 2);
    assert_eq!(
        answer["itemBatchResult"],
        json!({"ids":["b","a","b"], "changed":[{"id":"a","version":2}], "refused":null})
    );
}

#[tokio::test]
async fn an_answer_wakes_a_chat_for_its_older_note_without_overtaking_it() {
    let root = Scratch::new();
    let flushed = Arc::new(AtomicBool::new(false));
    let receiver = flushed.clone();
    let files = files(&root.0);
    let (host, asked) =
        rig_files(
            quiet_world(),
            Caps::default(),
            &files,
            move |method, _| match method {
                "reach" => Ok(json!("bot1")),
                "mail" => Ok(
                    json!({"duplicate":true, "journaled":receiver.load(Ordering::SeqCst),
                                "itemSession":CHAT}),
                ),
                _ => Ok(Value::Null),
            },
        );
    seed(&host, "a", 1);
    host.bots_command(waiting()).await.unwrap();
    assert!(
        !asked
            .lock()
            .unwrap()
            .iter()
            .any(|(m, _)| m == "reach" || m == "mail")
    );
    seed(&host, "b", 2);
    let question = ask(&host, "b");
    let request = json!({"action":"item","id":"b","requestId":"answer",
                         "answer":{"question":question,"text":"go"}});
    host.bots_command(request.clone()).await.unwrap();
    {
        let asks = asked.lock().unwrap();
        assert!(asks.iter().any(|(m, _)| m == "reach"));
        let mails: Vec<_> = asks.iter().filter(|(m, _)| m == "mail").collect();
        assert!(!mails.is_empty());
        assert!(
            mails
                .iter()
                .all(|(_, args)| args["details"]["id"] == "item-a-v2")
        );
    }
    crate::ports::apply_state(host.host.port(), 1, &bot_world("demo").to_string()).unwrap();
    flushed.store(true, Ordering::SeqCst);
    host.bots_command(request).await.unwrap();
    let asks = asked.lock().unwrap();
    let wakes: Vec<_> = asks
        .iter()
        .filter(|(m, args)| m == "mail" && args["delivery"]["triggerTurn"] == true)
        .collect();
    assert_eq!(wakes.len(), 1);
    assert_eq!(wakes[0].1["details"]["id"], "item-b-v2");
}

#[tokio::test]
async fn a_comment_and_its_retry_leave_an_unrelated_mail_backlog_for_recovery() {
    let ready = Arc::new(AtomicBool::new(false));
    let receiver = ready.clone();
    let (host, asked) = rig(bot_world("demo"), Caps::default(), move |method, args| {
        Ok(if method == "mail" {
            json!({"journaled":receiver.load(Ordering::SeqCst),"itemSession":args["details"]["itemSession"]})
        } else {
            Value::Null
        })
    });
    seed(&host, "a", 1);
    let offline = 20;
    let backlog: Vec<_> = (0..60)
        .map(|i| {
            let session = if i < offline {
                format!("/offline/{i}")
            } else {
                "/s/work.jsonl".into()
            };
            (
                session,
                Mail::new(
                    &format!("pending-{i}"),
                    "owner",
                    "Owner",
                    "",
                    MailKind::Note,
                    "earlier",
                    1.0,
                ),
            )
        })
        .collect();
    host.items()
        .commit_owner_scoped(vec![], None, None, &backlog, &[], &[])
        .unwrap();
    let request = json!({"action":"item","id":"a","comment":"next","requestId":"note"});
    assert_eq!(host.items_change_from(&request).await.unwrap(), json!({}));
    assert_eq!(
        host.items().pending_mail().unwrap().len(),
        backlog.len() + 1
    );
    ready.store(true, Ordering::SeqCst);
    host.items_change_from(&request).await.unwrap();
    host.items_change_from(&request).await.unwrap();
    assert_eq!(host.items().pending_mail().unwrap(), backlog);
    assert_eq!(host.items().get("a").unwrap().version, 2);
    assert_eq!(
        host.items()
            .item_receipt("bot", &json!("a"), "note", None)
            .unwrap()["outcome"],
        "commented"
    );
    {
        let log = asked.lock().unwrap();
        let attempts: Vec<_> = log.iter().filter(|(m, _)| m == "mail").collect();
        assert_eq!(attempts.len(), 2);
        assert!(
            attempts
                .iter()
                .all(|(_, a)| a["details"]["id"] == "item-a-v2"
                    && a["details"]["itemSession"] == CHAT)
        );
    }
    // A later pass can reach the live chat behind persistently offline ones without draining it all at once.
    for _ in 0..=offline {
        host.bots_tick().await;
        let left = host.items().pending_mail().unwrap().len();
        if left < backlog.len() {
            assert!(left > offline);
            return;
        }
    }
    panic!("offline chats starved the next live chat");
}

#[tokio::test]
async fn failed_owner_commit_writes_no_activity_receipt_journal_or_mail() {
    let root = Scratch::new();
    let mails = Mails::default();
    let (host, _, bot_id) = ada(&root, mails.clone(), |_, _| None).await;
    let out = host
        .run(
            "bot1",
            "ompdesk_item",
            json!({"action":"add","title":"Ship"}),
            None,
        )
        .await;
    assert!(!out.is_error, "{}", out.text);
    let before = host.items().find(&bot_id, "1").unwrap().unwrap().v1();
    let month = crate::aimemory::value::iso(host.now().max(0.0) as u64);
    let journal = root
        .0
        .join("ada/memory/journal")
        .join(format!("{}.md", &month[..7]));
    let old = std::fs::read(&journal).ok();
    host.items().fail_next_owner_mail().unwrap();
    let request = json!({"action":"itemBatch", "device":null, "requestId":"close",
                         "ids":[before.id], "status":"done"});
    assert!(host.bots_command(request).await.is_err());
    assert_eq!(host.items().find(&bot_id, "1").unwrap().unwrap(), &before);
    assert_eq!(host.items().receipt("close").unwrap(), None);
    assert_eq!(std::fs::read(&journal).ok(), old);
    assert_eq!(delivered(&mails, &format!("item-{}-v2", before.id)), 0);
}

#[tokio::test]
async fn an_undeliverable_group_fails_before_any_item_changes() {
    let (host, _) = rig(quiet_world(), Caps::default(), |_, _| Ok(Value::Null));
    let ids: Vec<String> = (1..=13).map(|n| format!("task-{n}")).collect();
    for (index, id) in ids.iter().enumerate() {
        seed(&host, id, index as u32 + 1);
    }
    // Each 8,000-character note occupies 16,000 wire units. Twelve fit and thirteen do not.
    let note = "\u{10400}".repeat(8_000);
    let request = |ids: &[String]| {
        json!({"action":"itemBatch","device":null,"requestId":"long","ids":ids,
               "status":"working","note":note})
    };
    let error = host.bots_command(request(&ids)).await.unwrap_err();
    assert!(error.message().contains("Select fewer items"));
    assert!(
        host.items()
            .visible(host.now())
            .all(|item| item.version == 1)
    );
    assert_eq!(host.items().receipt("long").unwrap(), None);
    let done = host.bots_command(request(&ids[..12])).await.unwrap();
    assert_eq!(
        done["itemBatchResult"]["changed"].as_array().unwrap().len(),
        12
    );
}

#[tokio::test]
async fn a_batch_never_switches_hosts_when_both_have_its_first_id() {
    let (peer, _) = rig(quiet_world(), Caps::default(), |_, _| Ok(Value::Null));
    seed(&peer, "b", 1);
    let before = peer.bots_share();
    let mut request = waiting();
    request.as_object_mut().unwrap().remove("device");
    let reply = peer
        .bots_from(request, "viewer", "Viewer", None)
        .await
        .unwrap();
    let result = reply["itemBatchResult"].clone();
    let (viewer, asked) = rig(quiet_world(), Caps::default(), move |method, _| {
        Ok(if method == "botsCommand" {
            reply.clone()
        } else {
            Value::Null
        })
    });
    seed(&viewer, "b", 1);
    viewer.bots_remote(&json!({"device":"peer", "online":true, "change":before}));
    let mut request = waiting();
    request["device"] = json!("peer");
    let state = viewer.bots_command(request).await.unwrap();
    assert_eq!(state["itemBatchResult"], result);
    assert_eq!(state["items"][0]["version"], 1);
    assert_eq!(state["remote"][0]["items"][0]["version"], 2);
    assert!(asked.lock().unwrap().iter().any(|(method, args)| {
        method == "botsCommand"
            && args["device"] == "peer"
            && args["request"]["action"] == "itemBatch"
            && args["request"].get("device").is_none()
    }));
    let state = viewer.bots_command(waiting()).await.unwrap();
    assert_eq!(state["items"][0]["version"], 2);
}
