//! The journals, against what the TypeScript wrote (`captured.json`: every op of a case run through the TypeScript
//! modules, with the answer and the file's text after each step) and the TypeScript tests' own cases.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::call_journal::{
    CALL_JOURNAL_MAX, CALL_JOURNAL_TTL_MS, CallBegin, CallJournal, CallResult, parse_intent,
};
use super::mail_outbox::{MailAnswer, MailOutbox, OutboxMail, RedeliverDeps, redeliver_mail};
use super::pending_cleanups::{PendingCleanup, PendingCleanups};
use super::send_outbox::{
    HandOver, OutboxSend, OwedDeps, SendOutbox, SentAnswer, deliver_owed, redeliver_sends,
};
use super::session_fates::{FatedSession, SessionFates, fate_when};
use super::{Clock, js_number};

fn captured() -> Value {
    serde_json::from_str(include_str!("captured.json")).unwrap()
}

struct Dir(PathBuf);

impl Dir {
    fn new() -> Dir {
        Dir(crate::fs::disk::make_temp_dir("ompdesk-journal-").unwrap())
    }

    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn clock_at(start: f64) -> (Clock, Arc<Mutex<f64>>) {
    let now = Arc::new(Mutex::new(start));
    let read = now.clone();
    (Arc::new(move || *read.lock().unwrap()), now)
}

fn text_of(file: &Option<PathBuf>) -> Option<String> {
    file.as_deref()
        .and_then(|file| std::fs::read_to_string(file).ok())
}

/// A case's setup: its file (when it has one) with the text it starts with, and its clock.
fn start(case: &Value, dir: &Dir, name: &str) -> (Option<PathBuf>, Clock, Arc<Mutex<f64>>) {
    let file = case["file"].as_bool().unwrap().then(|| dir.file(name));
    if let (Some(file), Some(initial)) = (&file, case["initial"].as_str()) {
        std::fs::write(file, initial).unwrap();
    }
    let (clock, now) = clock_at(case["now"].as_f64().unwrap());
    (file, clock, now)
}

/// The step's answer and file text must be the TypeScript's, byte for byte.
fn check(case: &Value, i: usize, step: &Value, out: &Value, file: &Option<PathBuf>) {
    let name = case["name"].as_str().unwrap();
    let op = &case["ops"][i];
    assert_eq!(
        out.to_string(),
        step["out"].to_string(),
        "{name}: op {i} {op}"
    );
    if let Some(expected) = step.get("file") {
        assert_eq!(
            text_of(file).as_deref(),
            expected.as_str(),
            "{name}: file after op {i} {op}"
        );
    }
}

fn str_of(value: &Value) -> String {
    value.as_str().unwrap().to_owned()
}

fn opt_str(value: &Value) -> Option<&str> {
    value.as_str()
}

#[test]
fn call_journal_replays_the_typescripts() {
    let data = captured();
    for case in data["callJournal"].as_array().unwrap() {
        let dir = Dir::new();
        let (file, clock, now) = start(case, &dir, "calls.json");
        let mut journal = CallJournal::with_clock(file.clone(), clock);
        for (i, op) in case["ops"].as_array().unwrap().iter().enumerate() {
            let out = match op["op"].as_str().unwrap() {
                "now" => {
                    *now.lock().unwrap() = op["ms"].as_f64().unwrap();
                    Value::Null
                }
                "get" => journal
                    .get(op["key"].as_str().unwrap())
                    .map_or(Value::Null, |record| record.to_json()),
                "begin" => {
                    let record = &op["record"];
                    journal
                        .begin(CallBegin {
                            key: str_of(&record["key"]),
                            tool: str_of(&record["tool"]),
                            caller_tab_id: str_of(&record["callerTabId"]),
                            intent: record.get("intent").and_then(parse_intent),
                            opened: record.get("opened").map(|opened| {
                                opened.as_array().unwrap().iter().map(str_of).collect()
                            }),
                        })
                        .unwrap();
                    Value::Null
                }
                "finish" => {
                    let result = &op["result"];
                    journal
                        .finish(
                            op["key"].as_str().unwrap(),
                            CallResult {
                                text: str_of(&result["text"]),
                                is_error: result["isError"].as_bool().unwrap(),
                            },
                        )
                        .unwrap();
                    Value::Null
                }
                "note" => {
                    journal
                        .note(op["key"].as_str().unwrap(), op["tab"].as_str().unwrap())
                        .unwrap();
                    Value::Null
                }
                "ack" => {
                    journal.acknowledge(op["callId"].as_str().unwrap()).unwrap();
                    Value::Null
                }
                "count" => Value::String(
                    (0..503)
                        .map(|i| {
                            if journal.get(&format!("k{i}")).is_some() {
                                '1'
                            } else {
                                '0'
                            }
                        })
                        .collect(),
                ),
                other => panic!("{other}"),
            };
            check(case, i, &case["steps"][i], &out, &file);
        }
    }
}

fn send_entry(value: &Value) -> OutboxSend {
    super::send_outbox::parse_entry(value).unwrap()
}

#[test]
fn historical_delivery_tags_round_trip_without_selecting_a_runtime_mode() {
    let dir = Dir::new();
    let file = dir.file("send-outbox.json");
    let original = json!([
        {"mark":"old-steer","sessionPath":"/s/kid.jsonl","from":"/s/boss.jsonl",
         "body":"one","message":"wrapped one","streamingBehavior":"steer","at":1},
        {"mark":"old-follow-up","sessionPath":"/s/kid.jsonl","from":"/s/boss.jsonl",
         "body":"two","message":"wrapped two","streamingBehavior":"followUp","at":2}
    ]);
    std::fs::write(&file, serde_json::to_string(&original).unwrap()).unwrap();
    let outbox = SendOutbox::new(Some(file.clone()));
    let rows = outbox.pending();
    assert_eq!(
        rows.iter().map(OutboxSend::to_json).collect::<Vec<_>>(),
        original.as_array().unwrap().as_slice()
    );
    outbox.keep(send(3)).unwrap();
    let reopened = SendOutbox::new(Some(file));
    let rows = reopened.pending();
    assert_eq!(rows[0].to_json(), original[0]);
    assert_eq!(rows[1].to_json(), original[1]);
    assert!(rows[2].to_json().get("streamingBehavior").is_none());
}

#[test]
fn pending_instructions_survive_old_retention_limits_and_keep_first_identity_on_retry() {
    let dir = Dir::new();
    let file = dir.file("send-outbox.json");
    let (clock, now) = clock_at(1_000.0);
    let outbox = SendOutbox::with_clock(Some(file.clone()), clock);
    for n in 1..=205 {
        outbox.keep(send(n)).unwrap();
    }
    let mut retry = send(1);
    retry.message = "a later display wrapper must not replace the first envelope".into();
    outbox.keep(retry).unwrap();
    let mut conflicting = send(1);
    conflicting.body = "different instruction".into();
    assert!(outbox.keep(conflicting).is_err());
    *now.lock().unwrap() = 4.0 * super::THREE_DAYS_MS;
    let reopened = SendOutbox::new(Some(file));
    assert_eq!(outbox.pending(), reopened.pending());
    assert_eq!(reopened.pending(), (1..=205).map(send).collect::<Vec<_>>());
}

#[test]
fn a_failed_source_save_preserves_the_original_for_the_same_retry() {
    let dir = Dir::new();
    let file = dir.file("send-outbox.json");
    let outbox = SendOutbox::new(Some(file.clone()));
    std::fs::create_dir(&file).unwrap();
    assert!(outbox.keep(send(1)).is_err());
    assert_eq!(outbox.pending(), [send(1)]);
    std::fs::remove_dir(&file).unwrap();
    outbox.keep(send(1)).unwrap();
    assert_eq!(SendOutbox::new(Some(file)).pending(), [send(1)]);
}

#[test]
fn same_identity_preserves_original_attachment_metadata_and_ignores_only_relanded_paths() {
    let dir = Dir::new();
    let file = dir.file("send-outbox.json");
    let mut encoded = send(7).to_json();
    encoded["attachments"] = json!({
        "images": [
            {"sha256": "a".repeat(64), "name": "picture.png", "mimeType": "image/png", "size": 1},
            {"sha256": "c".repeat(64), "name": "second.png", "mimeType": "image/png", "size": 2}
        ],
        "files": [
            {"sha256": "b".repeat(64), "name": "notes.txt", "mimeType": "text/plain", "size": 1,
             "path": "/landed/original.txt", "landedAt": 1000},
            {"sha256": "d".repeat(64), "name": "other.txt", "mimeType": "text/plain", "size": 2,
             "path": "/landed/other.txt", "landedAt": 1000}
        ]
    });
    let original = send_entry(&encoded);
    let outbox = SendOutbox::new(Some(file.clone()));
    outbox.keep(original.clone()).unwrap();
    let mut changed = original.clone();
    changed.attachments.as_mut().unwrap().images[0].name = "different.png".into();
    assert!(outbox.keep(changed).is_err());
    let mut reordered = original.clone();
    reordered.attachments.as_mut().unwrap().images.swap(0, 1);
    assert!(outbox.keep(reordered).is_err());
    let mut reordered = original.clone();
    reordered.attachments.as_mut().unwrap().files.swap(0, 1);
    assert!(outbox.keep(reordered).is_err());
    let mut relanded = original.clone();
    let landed = &mut relanded.attachments.as_mut().unwrap().files[0];
    landed.path = "/landed/retry.txt".into();
    landed.landed_at = 2000.0;
    outbox.keep(relanded).unwrap();
    assert_eq!(SendOutbox::new(Some(file)).pending(), [original]);
    let empty = send(8);
    outbox.keep(empty.clone()).unwrap();
    let mut changed = empty.clone();
    changed.attachments = Some(super::attachments::AttachedSet::default());
    assert!(outbox.keep(changed).is_err());
    assert_eq!(outbox.pending().last(), Some(&empty));
}

fn mail_entry(value: &Value) -> OutboxMail {
    super::mail_outbox::parse_entry(value).unwrap()
}

struct MailEnv {
    env: Value,
    log: Mutex<Value>,
}

impl RedeliverDeps for MailEnv {
    fn tab_of(&self, session_path: &str, device: Option<&str>) -> Option<String> {
        self.log.lock().unwrap()["looked"]
            .as_array_mut()
            .unwrap()
            .push(json!([session_path, device]));
        self.env["tabs"][session_path]
            .as_str()
            .or(self.env["tab"].as_str())
            .map(str::to_owned)
    }

    async fn send(&self, tab_id: &str, mail: &OutboxMail) -> Option<MailAnswer> {
        self.log.lock().unwrap()["sent"]
            .as_array_mut()
            .unwrap()
            .push(json!([tab_id, mail.id]));
        let answer = &self.env["answers"][mail.id.as_str()];
        if !answer.is_object() {
            return None;
        }
        Some(MailAnswer {
            duplicate: answer["duplicate"] == json!(true),
            journaled: answer["journaled"] == json!(true),
        })
    }
}

#[tokio::test]
async fn mail_redelivery_replays_the_typescripts() {
    let data = captured();
    for case in data["mailRedeliver"].as_array().unwrap() {
        let dir = Dir::new();
        let (file, clock, _) = start(case, &dir, "mail-outbox.json");
        let outbox = MailOutbox::with_clock(file.clone(), clock);
        for (i, op) in case["ops"].as_array().unwrap().iter().enumerate() {
            let kind = op["op"].as_str().unwrap();
            let deps = MailEnv {
                env: op["env"].clone(),
                log: Mutex::new(json!({"looked": [], "sent": []})),
            };
            let mut out = serde_json::Map::new();
            match kind {
                "keep" => outbox.keep(mail_entry(&op["entry"])).unwrap(),
                "pending" => {
                    out.insert(
                        "res".into(),
                        Value::Array(outbox.pending().iter().map(OutboxMail::to_json).collect()),
                    );
                }
                "redeliver" => redeliver_mail(&outbox, &deps).await,
                other => panic!("{other}"),
            }
            out.insert(
                "log".into(),
                if kind == "redeliver" {
                    deps.log.lock().unwrap().clone()
                } else {
                    Value::Null
                },
            );
            check(case, i, &case["steps"][i], &Value::Object(out), &file);
        }
    }
}

fn fated(value: &Value) -> FatedSession {
    let non_empty = |key: &str| value[key].as_str().map(str::to_owned);
    FatedSession {
        ids: value["ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(str_of)
            .collect(),
        path: non_empty("path"),
        device: non_empty("device"),
        title: str_of(&value["title"]),
        hidden: value["hidden"] == json!(true),
        cwd: str_of(&value["cwd"]),
        opened_by_session: non_empty("openedBySession"),
    }
}

#[test]
fn session_fates_replays_the_typescripts() {
    let data = captured();
    for case in data["sessionFates"].as_array().unwrap() {
        let dir = Dir::new();
        let (file, clock, now) = start(case, &dir, "fates.json");
        let mut fates = SessionFates::with_clock(file.clone(), clock);
        for (i, op) in case["ops"].as_array().unwrap().iter().enumerate() {
            let fate = |found: Option<super::session_fates::SessionFate>| {
                found.map_or(Value::Null, |fate| fate.to_json())
            };
            let out = match op["op"].as_str().unwrap() {
                "now" => {
                    *now.lock().unwrap() = op["ms"].as_f64().unwrap();
                    Value::Null
                }
                "closed" => {
                    fates.closed(fated(&op["session"]), op["by"].as_str().unwrap());
                    Value::Null
                }
                "deleted" => {
                    fates.deleted(
                        fated(&op["session"]),
                        op["by"].as_str().unwrap(),
                        op["at"].as_f64(),
                    );
                    Value::Null
                }
                "find" => fate(fates.find(op["id"].as_str().unwrap())),
                "of" => fate(fates.of(op["path"].as_str().unwrap(), opt_str(&op["device"]))),
                "fateWhen" => Value::String(fate_when(
                    op["at"].as_f64().unwrap(),
                    op["by"].as_str().unwrap(),
                )),
                other => panic!("{other}"),
            };
            check(case, i, &case["steps"][i], &out, &file);
        }
    }
}

fn cleanup(value: &Value) -> PendingCleanup {
    super::pending_cleanups::parse_cleanup(value).unwrap()
}

#[test]
fn pending_cleanups_replays_the_typescripts() {
    let data = captured();
    for case in data["pendingCleanups"].as_array().unwrap() {
        let dir = Dir::new();
        let (file, _, _) = start(case, &dir, "cleanups.json");
        let mut cleanups = PendingCleanups::new(file.clone());
        for (i, op) in case["ops"].as_array().unwrap().iter().enumerate() {
            let out = match op["op"].as_str().unwrap() {
                "add" => {
                    cleanups.add(cleanup(&op["c"]));
                    Value::Null
                }
                "drop" => {
                    cleanups.drop_cleanup(&cleanup(&op["c"]));
                    Value::Null
                }
                "take" => Value::Array(
                    cleanups
                        .take(op["caller"].as_str().unwrap())
                        .iter()
                        .map(PendingCleanup::to_json)
                        .collect(),
                ),
                other => panic!("{other}"),
            };
            check(case, i, &case["steps"][i], &out, &file);
        }
    }
}

// ---- the TypeScript tests' own cases (mail-outbox.test.ts, send-outbox.test.ts) ----

fn mail(id: &str) -> OutboxMail {
    OutboxMail {
        id: id.into(),
        session_path: "/s/boss.jsonl".into(),
        device: None,
        from: None,
        from_device: None,
        content: format!("<ompdesk-mail>{id}</ompdesk-mail>"),
        details: json!({"id": id, "kind": "done"}),
        delivery: super::super::rules::mail::MailDelivery { trigger_turn: true },
        historical_delivery: None,
        attachments: None,
        attachments_corrupt: false,
        at: 1_000.0,
    }
}

fn fixed(now: f64) -> Clock {
    Arc::new(move || now)
}

fn ids(outbox: &MailOutbox) -> Vec<String> {
    outbox.pending().into_iter().map(|mail| mail.id).collect()
}

#[test]
fn a_report_survives_a_relaunch_until_it_is_settled() {
    let dir = Dir::new();
    let file = dir.file("mail-outbox.json");
    let mut with_device = mail("a");
    with_device.device = Some("dev-1".into());
    MailOutbox::with_clock(Some(file.clone()), fixed(2_000.0))
        .keep(with_device.clone())
        .unwrap();
    let reopened = MailOutbox::with_clock(Some(file.clone()), fixed(2_000.0));
    assert_eq!(reopened.pending(), vec![with_device]);
    reopened.settle("a");
    assert!(
        MailOutbox::with_clock(Some(file), fixed(2_000.0))
            .pending()
            .is_empty()
    );
}

#[test]
fn a_same_report_id_preserves_the_first_envelope_and_order_and_rejects_conflicts() {
    let outbox = MailOutbox::new(None);
    let first = mail("a");
    outbox.keep(first.clone()).unwrap();
    outbox.keep(mail("b")).unwrap();
    let mut retry = first.clone();
    retry.at = 2_000.0;
    outbox.keep(retry).unwrap();
    let mut conflicting = first.clone();
    conflicting.content = "different report".into();
    assert!(outbox.keep(conflicting).is_err());
    assert_eq!(outbox.pending(), [first, mail("b")]);
}

#[test]
fn unconsumed_reports_survive_the_old_age_and_count_limits_and_restart() {
    let dir = Dir::new();
    let file = dir.file("mail-outbox.json");
    let outbox = MailOutbox::with_clock(Some(file.clone()), fixed(1_000.0));
    let mut expected = Vec::new();
    for n in 0..105 {
        let mut encoded = mail(&format!("m{n}")).to_json();
        encoded["delivery"]["deliverAs"] = if n % 2 == 0 { "followUp" } else { "aside" }.into();
        encoded["from"] = "/s/original-sender.jsonl".into();
        encoded["fromDevice"] = "source-device".into();
        let original = mail_entry(&encoded);
        outbox.keep(original.clone()).unwrap();
        expected.push(original);
    }
    let reopened = MailOutbox::with_clock(Some(file), fixed(4.0 * super::THREE_DAYS_MS));
    assert_eq!(reopened.pending(), expected);
}

#[test]
fn a_report_save_failure_keeps_the_first_original_and_same_identity_retry() {
    let dir = Dir::new();
    let file = dir.file("mail-outbox.json");
    let outbox = MailOutbox::new(Some(file.clone()));
    let original = mail("a");
    std::fs::create_dir(&file).unwrap();
    assert!(outbox.keep(original.clone()).is_err());
    assert_eq!(outbox.pending().as_slice(), std::slice::from_ref(&original));
    let mut changed = original.clone();
    changed.details["text"] = "changed payload".into();
    assert!(outbox.keep(changed).is_err());
    std::fs::remove_dir(&file).unwrap();
    outbox.keep(original.clone()).unwrap();
    assert_eq!(MailOutbox::new(Some(file)).pending(), [original]);
}

#[test]
fn a_damaged_mail_file_and_its_non_reports_are_ignored() {
    let dir = Dir::new();
    let file = dir.file("mail-outbox.json");
    let mut text = Value::Array(vec![
        mail("ok").to_json(),
        json!({"id": "no-path"}),
        Value::Null,
        json!("x"),
    ]);
    std::fs::write(&file, text.to_string()).unwrap();
    assert_eq!(
        ids(&MailOutbox::with_clock(Some(file.clone()), fixed(2_000.0))),
        ["ok"]
    );
    text = json!("{not json");
    std::fs::write(&file, text.as_str().unwrap()).unwrap();
    assert!(MailOutbox::new(Some(file)).pending().is_empty());
}

#[test]
fn old_report_tags_are_preserved_only_in_storage() {
    let dir = Dir::new();
    let file = dir.file("mail-outbox.json");
    for tag in ["followUp", "aside"] {
        let mut old = mail("old").to_json();
        old["delivery"] = json!({"triggerTurn": true, "deliverAs": tag});
        std::fs::write(&file, Value::Array(vec![old.clone()]).to_string()).unwrap();
        let outbox = MailOutbox::with_clock(Some(file.clone()), fixed(2_000.0));
        assert_eq!(outbox.pending()[0].to_json(), old);
        assert_eq!(
            outbox.pending()[0].delivery.to_json(),
            json!({"triggerTurn": true})
        );
    }
}

#[test]
fn the_mail_file_is_written_when_a_report_is_kept() {
    let dir = Dir::new();
    let file = dir.file("mail-outbox.json");
    MailOutbox::with_clock(Some(file.clone()), fixed(2_000.0))
        .keep(mail("a"))
        .unwrap();
    let held: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(held.as_array().unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn the_outbox_files_are_private_and_the_call_journal_is_not_pinned() {
    use super::pending_cleanups::CleanupAction;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    let dir = Dir::new();
    let mode = |file: &Path| std::fs::metadata(file).unwrap().permissions().mode() & 0o777;
    let sends = dir.file("s.json");
    SendOutbox::with_clock(Some(sends.clone()), fixed(2_000.0))
        .keep(send_entry(&json!({"mark": "m", "sessionPath": "/p", "from": "f", "body": "b", "message": "x", "streamingBehavior": "steer", "at": 1_000}))).unwrap();
    assert_eq!(mode(&sends), 0o600);
    let mails = dir.file("m.json");
    MailOutbox::with_clock(Some(mails.clone()), fixed(2_000.0))
        .keep(mail("a"))
        .unwrap();
    assert_eq!(mode(&mails), 0o600);
    let fates = dir.file("f.json");
    SessionFates::with_clock(Some(fates.clone()), fixed(2_000.0)).closed(
        FatedSession {
            ids: vec!["a".into()],
            ..Default::default()
        },
        "x",
    );
    assert_eq!(mode(&fates), 0o600);
    let cleanups = dir.file("c.json");
    PendingCleanups::new(Some(cleanups.clone())).add(PendingCleanup {
        caller: "c".into(),
        path: None,
        device: None,
        tab_id: "t".into(),
        title: String::new(),
        action: CleanupAction::Stop,
        at: 1.0,
    });
    assert_eq!(mode(&cleanups), 0o600);
}

struct Mails {
    answers: Mutex<Vec<Option<MailAnswer>>>,
    sent: Mutex<Vec<String>>,
}

impl RedeliverDeps for Mails {
    fn tab_of(&self, session_path: &str, _device: Option<&str>) -> Option<String> {
        (session_path == "/s/boss.jsonl").then(|| "tab9".to_owned())
    }

    async fn send(&self, tab_id: &str, mail: &OutboxMail) -> Option<MailAnswer> {
        self.sent
            .lock()
            .unwrap()
            .push(format!("{tab_id}:{}", mail.id));
        let mut answers = self.answers.lock().unwrap();
        if answers.is_empty() {
            None
        } else {
            answers.remove(0)
        }
    }
}

#[tokio::test]
async fn redelivery_settles_once_the_journal_holds_the_report() {
    let outbox = MailOutbox::with_clock(None, fixed(2_000.0));
    outbox.keep(mail("a")).unwrap();
    let deps = Mails {
        answers: Mutex::new(vec![
            Some(MailAnswer::default()),
            Some(MailAnswer {
                duplicate: true,
                journaled: false,
            }),
            Some(MailAnswer {
                duplicate: true,
                journaled: true,
            }),
        ]),
        sent: Mutex::new(Vec::new()),
    };
    redeliver_mail(&outbox, &deps).await;
    redeliver_mail(&outbox, &deps).await;
    assert_eq!(outbox.pending().len(), 1);
    redeliver_mail(&outbox, &deps).await;
    assert!(outbox.pending().is_empty());
    assert_eq!(*deps.sent.lock().unwrap(), ["tab9:a", "tab9:a", "tab9:a"]);
}

#[tokio::test]
async fn a_report_without_a_tab_or_an_answering_omp_waits_for_the_next_pass() {
    let outbox = MailOutbox::with_clock(None, fixed(2_000.0));
    let mut closed = mail("closed");
    closed.session_path = "/s/closed.jsonl".into();
    outbox.keep(closed).unwrap();
    outbox.keep(mail("starting")).unwrap();
    let deps = Mails {
        answers: Mutex::new(vec![None]),
        sent: Mutex::new(Vec::new()),
    };
    redeliver_mail(&outbox, &deps).await;
    assert_eq!(*deps.sent.lock().unwrap(), ["tab9:starting"]);
    assert_eq!(ids(&outbox), ["closed", "starting"]);
}

fn send(n: i64) -> OutboxSend {
    OutboxSend::new(
        format!("[ompdesk dispatch d{n}:"),
        Some(n),
        "/s/kid.jsonl".into(),
        None,
        "/s/boss.jsonl".into(),
        format!("do part {n}"),
        format!("do part {n}\n\n[ompdesk dispatch d{n}: report]"),
        1_000.0,
    )
}

/// A receiver omp as stock runs it: a prompt it is handed waits in its queue until the test journals it.
struct Omp {
    instance: &'static str,
    journal: Mutex<Vec<String>>,
    prompts: Mutex<Vec<String>>,
    refuse: bool,
    tab: Option<&'static str>,
    mute: bool,
    looked: Mutex<Vec<(String, Option<String>)>>,
}

impl Omp {
    fn new(instance: &'static str) -> Omp {
        Omp {
            instance,
            journal: Mutex::new(Vec::new()),
            prompts: Mutex::new(Vec::new()),
            refuse: false,
            tab: Some("kid00009"),
            mute: false,
            looked: Mutex::new(Vec::new()),
        }
    }

    fn prompts(&self) -> Vec<String> {
        self.prompts.lock().unwrap().clone()
    }
}

impl OwedDeps for Omp {
    fn tab_of(&self, session_path: &str, device: Option<&str>) -> Option<String> {
        self.looked
            .lock()
            .unwrap()
            .push((session_path.to_owned(), device.map(str::to_owned)));
        self.tab.map(str::to_owned)
    }

    async fn sent(&self, _tab_id: &str, marks: &[String]) -> Option<SentAnswer> {
        if self.mute {
            return None;
        }
        let journal = self.journal.lock().unwrap();
        Some(SentAnswer {
            instance: self.instance.into(),
            journaled: marks
                .iter()
                .filter(|mark| journal.contains(mark))
                .cloned()
                .collect(),
        })
    }

    async fn prompt(&self, _tab_id: &str, entry: &OutboxSend) -> HandOver {
        self.prompts.lock().unwrap().push(entry.mark.clone());
        if self.refuse {
            HandOver::Refused
        } else {
            HandOver::Handed
        }
    }
}

#[tokio::test]
async fn an_ended_omps_message_reaches_the_relaunched_omp_exactly_once() {
    let dir = Dir::new();
    let file = dir.file("send-outbox.json");
    let before = SendOutbox::with_clock(Some(file.clone()), fixed(2_000.0));
    before.keep(send(2)).unwrap();
    before.handed(&send(2), "omp-a");

    let outbox = SendOutbox::with_clock(Some(file.clone()), fixed(2_000.0));
    let next = Omp::new("omp-b");
    redeliver_sends(&outbox, &next).await;
    assert_eq!(next.prompts(), ["[ompdesk dispatch d2:"]);
    redeliver_sends(&outbox, &next).await;
    assert_eq!(next.prompts().len(), 1);
    next.journal
        .lock()
        .unwrap()
        .push("[ompdesk dispatch d2:".into());
    redeliver_sends(&outbox, &next).await;
    assert!(
        SendOutbox::with_clock(Some(file), fixed(2_000.0))
            .pending()
            .is_empty()
    );
    assert_eq!(next.prompts().len(), 1);
}

#[tokio::test]
async fn a_message_is_never_handed_again_to_its_omp_and_a_journaled_one_settles() {
    let outbox = SendOutbox::with_clock(None, fixed(2_000.0));
    for n in [1, 2] {
        outbox.keep(send(n)).unwrap();
        outbox.handed(&send(n), "omp-a");
    }
    let same = Omp::new("omp-a");
    same.journal
        .lock()
        .unwrap()
        .push("[ompdesk dispatch d1:".into());
    redeliver_sends(&outbox, &same).await;
    assert!(same.prompts().is_empty());
    let left: Vec<Option<i64>> = outbox
        .pending()
        .iter()
        .map(|entry| entry.dispatch)
        .collect();
    assert_eq!(left, [Some(2)]);
}

#[tokio::test]
async fn an_empty_receiver_queue_is_not_an_acknowledgement() {
    let outbox = SendOutbox::new(None);
    outbox.keep(send(2)).unwrap();
    outbox.handed(&send(2), "omp-a");
    let same = Omp::new("omp-a");
    redeliver_sends(&outbox, &same).await;
    let mut expected = send(2).to_json();
    expected["instance"] = "omp-a".into();
    assert_eq!(
        outbox
            .pending()
            .iter()
            .map(OutboxSend::to_json)
            .collect::<Vec<_>>(),
        [expected]
    );
    assert!(same.prompts().is_empty());
    let restarted = Omp::new("omp-b");
    redeliver_sends(&outbox, &restarted).await;
    assert_eq!(restarted.prompts(), ["[ompdesk dispatch d2:"]);
}

#[tokio::test]
async fn the_order_is_kept_while_an_earlier_message_cannot_be_handed_over() {
    let outbox = SendOutbox::with_clock(None, fixed(2_000.0));
    for n in [2, 3] {
        outbox.keep(send(n)).unwrap();
        outbox.handed(&send(n), "omp-a");
    }
    let mut refusing = Omp::new("omp-b");
    refusing.refuse = true;
    assert!(!deliver_owed(&outbox, &refusing, "/s/kid.jsonl", None).await);
    assert_eq!(refusing.prompts(), ["[ompdesk dispatch d2:"]);
    let taking = Omp::new("omp-b");
    assert!(deliver_owed(&outbox, &taking, "/s/kid.jsonl", None).await);
    assert_eq!(
        taking.prompts(),
        ["[ompdesk dispatch d2:", "[ompdesk dispatch d3:"]
    );
}

#[tokio::test]
async fn it_waits_without_a_tab_or_an_answering_bridge_and_looks_up_a_device_by_it() {
    let outbox = SendOutbox::with_clock(None, fixed(2_000.0));
    let mut entry = send(2);
    entry.device = Some("dev-1".into());
    entry.instance = Some("omp-a".into());
    outbox.keep(entry).unwrap();
    let mut none = Omp::new("omp-b");
    none.tab = None;
    redeliver_sends(&outbox, &none).await;
    let mut mute = Omp::new("omp-b");
    mute.mute = true;
    redeliver_sends(&outbox, &mute).await;
    assert_eq!(
        *none.looked.lock().unwrap(),
        [("/s/kid.jsonl".to_owned(), Some("dev-1".to_owned()))]
    );
    assert!(none.prompts().is_empty() && mute.prompts().is_empty());
    assert_eq!(outbox.pending().len(), 1);
}

#[test]
fn a_dispatch_is_numbered_past_the_one_still_owed_and_a_resend_is_recognized() {
    let outbox = SendOutbox::with_clock(None, fixed(2_000.0));
    outbox.keep(send(4)).unwrap();
    let mut other = send(1);
    other.mark = "[ompdesk request m-1]".into();
    other.dispatch = None;
    other.session_path = "/s/other.jsonl".into();
    outbox.keep(other).unwrap();
    assert_eq!(outbox.last_dispatch("/s/kid.jsonl", None), 4);
    assert_eq!(outbox.last_dispatch("/s/kid.jsonl", Some("dev-1")), 0);
    let joined = outbox.waiting("/s/boss.jsonl", "/s/kid.jsonl", None, "do part 4", "");
    assert_eq!(joined.map(|entry| entry.dispatch), Some(Some(4)));
    assert!(
        outbox
            .waiting("/s/else.jsonl", "/s/kid.jsonl", None, "do part 4", "")
            .is_none()
    );
}

// ---- limits the capture checks too, kept as plain tests so a failure names them ----

#[test]
fn only_acknowledged_calls_are_forgotten() {
    let (clock, now) = clock_at(0.0);
    let mut journal = CallJournal::with_clock(None, clock);
    let begin = |key: &str| CallBegin {
        key: key.into(),
        tool: "t".into(),
        caller_tab_id: "x".into(),
        intent: None,
        opened: None,
    };
    for key in ["old1\n\nc1", "old2\n\nc2"] {
        journal.begin(begin(key)).unwrap();
        journal
            .finish(
                key,
                CallResult {
                    text: "a".into(),
                    is_error: false,
                },
            )
            .unwrap();
    }
    journal.acknowledge("c1").unwrap();
    *now.lock().unwrap() = CALL_JOURNAL_TTL_MS + 10.0;
    journal.begin(begin("new")).unwrap();
    assert!(journal.get("old1\n\nc1").is_none());
    assert!(journal.get("old2\n\nc2").is_some());
    assert!(CALL_JOURNAL_MAX > 0 && js_number(1.0) == json!(1));
}
