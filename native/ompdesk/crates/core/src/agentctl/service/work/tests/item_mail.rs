use super::*;
use crate::agentctl::journal::attachments::sha256_hex;
use crate::agentctl::rules::mail::{Mail, MailKind};
use crate::agentctl::service::{CallId, JournalFile};

const TOOL: &str = "ompdesk_session_send";
const PATH: &str = "/s/work.jsonl";

fn files(root: &Scratch) -> Files {
    Files {
        send_outbox: Some(JournalFile::default()),
        ..kept_files(root)
    }
}

async fn item(ctl: &AgentControl, bot: &str) -> String {
    let result = ctl
        .run(
            "bot1",
            "ompdesk_item",
            json!({"action":"add", "title":"Translate"}),
            None,
        )
        .await;
    assert!(!result.is_error, "{}", result.text);
    ctl.items().find(bot, "#1").unwrap().unwrap().id.clone()
}

fn assign(ctl: &AgentControl, item: &str, generation: u64, path: &str, device: Option<&str>) {
    let work = serde_json::from_value(json!({"generation":generation,"requestedBy":"/s/bot.jsonl",
        "effectKey":"open-1","acceptedTab":"work1","session":path,"device":device}))
    .unwrap();
    ctl.items().commit_work(item, work).unwrap();
}

fn command(args: &Value) -> Option<&Value> {
    let cmd = &args["command"];
    (cmd["type"] == "agent_control_item_mail").then_some(cmd)
}

fn message(address: &str, request: &str) -> Value {
    json!({"item":address, "message":"log excerpt", "request_id":request})
}

#[tokio::test]
async fn item_mail_commits_before_delivery_and_replays_the_same_receipt_without_dispatch_or_answer()
{
    let root = Scratch::new();
    let files = files(&root);
    let receiver = Arc::new(Mutex::new(None::<AgentControl>));
    let receiving = receiver.clone();
    let (ctl, asked, board) = ada_in(&root, &files, Mails::default(), move |_, args| {
        let cmd = command(args)?;
        let service = receiving.lock().unwrap().clone().unwrap();
        let row = service
            .items()
            .committed_get(cmd["item"].as_str().unwrap())
            .unwrap();
        let mail = &row.mail[cmd["key"].as_str().unwrap()];
        assert_eq!(mail.session, PATH);
        assert_eq!(mail.generation, 1);
        assert_eq!(mail.state.status(), "accepted_pending_delivery");
        Some(json!({"success":true,"data":{"journaled":true,"key":cmd["key"]}}))
    })
    .await;
    *receiver.lock().unwrap() = Some(ctl.clone());
    let id = item(&ctl, &board).await;
    assert!(
        ctl.run("bot1", TOOL, message("#1", "unset"), None)
            .await
            .text
            .contains("no_holder")
    );
    assign(&ctl, &id, 1, PATH, None);
    let mut world = bot_world(&ctl.bot_named("Ada").unwrap().folder);
    world["parents"] = json!({"work1":{"callerTabId":"bot1"}});
    crate::ports::apply_state(ctl.host.port(), 1, &world.to_string()).unwrap();
    assert_eq!(ctl.mailbox.dispatch("work1"), "d1");
    ctl.mailbox
        .post(Mail::new(
            "ask",
            "work1",
            "Worker",
            "bot1",
            MailKind::Question,
            "Which target?",
            ctl.now(),
        ))
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        ctl.run("bot1", TOOL, message("#1", "log"), None),
        ctl.run("bot1", TOOL, message(&id, "log"), None)
    );
    assert_eq!(a.text, b.text);
    assert!(
        !a.is_error && a.text.ends_with(": delivered."),
        "{}",
        a.text
    );
    assert_eq!(ctl.mailbox.current("work1").as_deref(), Some("d1"));
    assert!(ctl.mailbox.state("work1", "bot1").unwrap().waiting);
    assert_eq!(
        asked
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, args)| command(args).is_some())
            .count(),
        1
    );
    let mut changed = message(&id, "log");
    changed["message"] = json!("different input");
    assert!(
        ctl.run("bot1", TOOL, changed, None)
            .await
            .text
            .contains("request_conflict")
    );
    drop(ctl);
    let (after, asked) = rig_files(
        world,
        Caps::default(),
        &files,
        bots_main(Mails::default(), |_, _| None),
    );
    let retry = after
        .run(
            "bot1",
            TOOL,
            message(&id, "log"),
            Some(CallId {
                id: "rpc".into(),
                resent: true,
                local_session: None,
            }),
        )
        .await;
    assert_eq!(retry.text, a.text);
    assert!(
        after
            .run(
                "bot1",
                TOOL,
                message(&id, "lost"),
                Some(CallId {
                    id: "lost-call".into(),
                    resent: true,
                    local_session: None,
                })
            )
            .await
            .is_error
    );
    assert!(
        !asked
            .lock()
            .unwrap()
            .iter()
            .any(|(_, args)| command(args).is_some())
    );
}

#[tokio::test]
async fn item_mail_refuses_foreign_senders_and_rechecks_content_and_permissions_on_delivery() {
    let root = Scratch::new();
    let (ctl, asked, board) = ada_in(&root, &files(&root), Mails::default(), |_, args| {
        command(args).map(|cmd| json!({"success":true,"data":{"key":cmd["key"],"journaled":false}}))
    })
    .await;
    let id = item(&ctl, &board).await;
    assign(&ctl, &id, 1, PATH, None);
    let denied = ctl.run("send1", TOOL, message(&id, "log"), None).await;
    assert!(denied.is_error && !denied.text.contains(PATH));
    let result = ctl.run("bot1", TOOL, message("#1", "log"), None).await;
    assert!(
        !result.is_error && result.text.contains("accepted_pending_delivery"),
        "{}",
        result.text
    );
    let payload = asked
        .lock()
        .unwrap()
        .iter()
        .find_map(|(_, args)| command(args).cloned())
        .unwrap();
    let key = payload["key"].as_str().unwrap();
    let fingerprint = sha256_hex(payload["message"].as_str().unwrap().as_bytes());
    assert!(ctl.permits_item_mail(&id, 1, PATH, None, key, &fingerprint));
    assert!(!ctl.permits_item_mail(&id, 1, PATH, None, key, "changed"));
    assert!(!ctl.permits_item_mail(&id, 2, PATH, None, key, &fingerprint));
    assert!(!ctl.permits_item_mail(&id, 1, PATH, Some("another-device"), key, &fingerprint));
    assert!(!ctl.bots_state().to_string().contains(key));
    let mut world = bot_world(&ctl.bot_named("Ada").unwrap().folder);
    world["tabs"][3]["hidden"] = json!(true);
    crate::ports::apply_state(ctl.host.port(), 1, &world.to_string()).unwrap();
    assert!(!ctl.permits_item_mail(&id, 1, PATH, None, key, &fingerprint));
    ctl.redeliver_sends().await.unwrap();
    assert!(
        ctl.run("bot1", TOOL, message(&id, "log"), None)
            .await
            .text
            .contains("access_revoked")
    );
    assert_eq!(
        asked
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, args)| command(args).is_some())
            .count(),
        1
    );
    // Same bot name, folder and saved path on another computer is not this board's sender.
    world["tabs"][1]["device"] = json!("other-device");
    crate::ports::apply_state(ctl.host.port(), 2, &world.to_string()).unwrap();
    let foreign = ctl.run("bot1", TOOL, message("#1", "other"), None).await;
    assert!(foreign.is_error && !foreign.text.contains(PATH));
}

#[tokio::test]
async fn disconnected_execution_host_mail_never_targets_the_replacement_even_at_the_same_path() {
    let root = Scratch::new();
    let files = files(&root);
    let (ctl, asked, board) = ada_in(&root, &files, Mails::default(), |_, _| None).await;
    let id = item(&ctl, &board).await;
    let mut world = bot_world(&ctl.bot_named("Ada").unwrap().folder);
    world["devices"] = json!([{"id":"other","name":"other","state":"offline"}]);
    crate::ports::apply_state(ctl.host.port(), 1, &world.to_string()).unwrap();
    assign(&ctl, &id, 1, PATH, Some("other"));
    let queued = ctl.run("bot1", TOOL, message("#1", "old"), None).await;
    assert!(
        queued.text.contains("accepted_pending_delivery"),
        "{}",
        queued.text
    );
    assert!(
        !asked
            .lock()
            .unwrap()
            .iter()
            .any(|(_, args)| command(args).is_some())
    );
    drop(ctl);
    let (after, asked) = rig_files(
        world,
        Caps::default(),
        &files,
        bots_main(Mails::default(), |_, args| {
            command(args)
                .map(|cmd| json!({"success":true,"data":{"key":cmd["key"],"journaled":true}}))
        }),
    );
    assign(&after, &id, 2, PATH, None);
    after.redeliver_sends().await.unwrap();
    let late = after.run("bot1", TOOL, message(&id, "old"), None).await;
    assert!(
        late.text.contains("generation 1") && late.text.contains("holder_changed"),
        "{}",
        late.text
    );
    assert!(
        !asked
            .lock()
            .unwrap()
            .iter()
            .any(|(_, args)| command(args).is_some())
    );
    let new = after.run("bot1", TOOL, message(&id, "new"), None).await;
    assert!(new.text.contains("generation 2") && new.text.ends_with(": delivered."));
    assert_eq!(
        asked
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, args)| command(args).is_some())
            .count(),
        1
    );
}

#[tokio::test]
async fn item_mail_does_not_send_or_defer_an_uncommitted_acceptance() {
    let root = Scratch::new();
    let (ctl, asked, board) = ada_in(&root, &files(&root), Mails::default(), |_, _| None).await;
    let id = item(&ctl, &board).await;
    assign(&ctl, &id, 1, PATH, None);
    ctl.items().set_fail_writes(true).unwrap();
    let result = ctl.run("bot1", TOOL, message(&id, "full"), None).await;
    assert!(result.is_error && result.text.contains("ENOSPC"));
    ctl.redeliver_sends().await.unwrap();
    assert!(ctl.items().get(&id).unwrap().mail.is_empty());
    assert!(
        !asked
            .lock()
            .unwrap()
            .iter()
            .any(|(_, args)| command(args).is_some())
    );
}

#[tokio::test]
async fn an_old_receiver_never_gets_an_unfenced_prompt_and_other_boards_cannot_alias_its_number() {
    use crate::agentctl::journal::items::ItemRecord;
    let left = Scratch::new();
    let right = Scratch::new();
    let (a, _, bot_a) = ada_in(&left, &files(&left), Mails::default(), |_, _| None).await;
    let (b, asked, bot_b) = ada_in(&right, &files(&right), Mails::default(), |_, args| {
        command(args)
            .map(|_| json!({"success":false,"error":"Unknown command: agent_control_item_mail"}))
    })
    .await;
    for (ctl, board, prefix) in [(&a, &bot_a, "left"), (&b, &bot_b, "right")] {
        for n in 1..=9 {
            let row = ctl
                .items()
                .add(ItemRecord {
                    bot: board.to_owned(),
                    id: format!("{prefix}-{n}"),
                    title: "Same title".into(),
                    status: "working".into(),
                    session: "/s/bot.jsonl".into(),
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(row.number, n);
        }
    }
    assign(&b, "right-9", 1, PATH, None);
    assert!(
        b.run("bot1", TOOL, message("left-9", "log"), None)
            .await
            .is_error
    );
    let not_here = a.run("bot1", TOOL, message("#9", "log"), None).await;
    assert!(not_here.is_error && not_here.text.contains("no_holder"));
    let old = b.run("bot1", TOOL, message("#9", "log"), None).await;
    assert!(old.text.contains("right-9") && old.text.contains("unsupported_receiver"));
    b.redeliver_sends().await.unwrap();
    let asked = asked.lock().unwrap();
    assert_eq!(
        asked
            .iter()
            .filter(|(_, args)| command(args).is_some())
            .count(),
        1
    );
    assert!(!asked.iter().any(|(_, args)| matches!(
        args["command"]["type"].as_str(),
        Some("prompt" | "agent_control_aside" | "agent_control_mail")
    )));
}

#[tokio::test]
async fn paired_delivery_reconciles_a_lost_reply_without_a_second_metered_command() {
    let root = Scratch::new();
    let stage = Arc::new(AtomicU64::new(0));
    let peer = stage.clone();
    let (ctl, asked, board) = ada_in(&root, &files(&root), Mails::default(), move |_, args| {
        let cmd = &args["command"];
        match cmd["type"].as_str()? {
            "agent_control_sent" => {
                let mark = &cmd["marks"][0];
                let at = peer.load(Ordering::SeqCst);
                Some(
                    json!({"success":true,"data":{"itemMail":mark,"matches":true,"queued":at == 1,
                    "journaled":if at == 2 { json!([mark]) } else { json!([]) }}}),
                )
            }
            "agent_control_item_mail" => {
                peer.store(1, Ordering::SeqCst);
                Some(json!({"success":false,"error":"lost response"}))
            }
            _ => None,
        }
    })
    .await;
    let id = item(&ctl, &board).await;
    let mut world = bot_world(&ctl.bot_named("Ada").unwrap().folder);
    world["devices"] = json!([{"id":"peer","name":"peer","state":"online"}]);
    world["tabs"][3]["device"] = json!("peer");
    crate::ports::apply_state(ctl.host.port(), 1, &world.to_string()).unwrap();
    assign(&ctl, &id, 1, PATH, Some("peer"));
    assert!(
        ctl.run("bot1", TOOL, message("#1", "sent"), None)
            .await
            .text
            .contains("accepted_pending_delivery")
    );
    ctl.redeliver_sends().await.unwrap();
    stage.store(2, Ordering::SeqCst);
    assert!(
        ctl.run("bot1", TOOL, message("#1", "sent"), None)
            .await
            .text
            .ends_with(": delivered.")
    );
    assert_eq!(
        asked
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, args)| command(args).is_some())
            .count(),
        1
    );
}
