use std::cell::Cell;
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tempfile::tempdir;

use super::*;

const DAY: &str = "2026-11-27";
const NEXT: &str = "2026-11-28";

fn peer_file(dir: &Path, rows: Value) {
    fs::write(
        dir.join("remote-peers.json"),
        json!({"v": 1, "peers": rows}).to_string(),
    )
    .unwrap();
}
fn laptop(extra: Value) -> Value {
    let mut peer = json!({
        "deviceId": "laptop",
        "name": "laptop",
        "staticPub": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "nodeId": "nLAPTOP",
        "login": null,
        "pairedAt": 0,
    });
    if let (Some(peer), Some(extra)) = (peer.as_object_mut(), extra.as_object()) {
        peer.extend(extra.clone());
    }
    peer
}

fn reserve(q: &Quota, day: &str, id: &str, attempt: &str, requests: u64) -> Result<Value, Fault> {
    q.run(
        "laptop",
        Action::Reserve {
            id,
            attempt,
            requests,
        },
        day,
    )
}

fn duplicate(charged: bool) -> Value {
    json!({"ok": false, "refusal": "duplicate", "charged": charged})
}

fn usage(q: &Quota, day: &str) -> Value {
    q.run("laptop", Action::View, day).unwrap()["usage"].clone()
}

fn settled(q: &Quota) {
    let Records::Peers(store) = &q.records else {
        unreachable!()
    };
    locked(store).flush().unwrap();
}

fn seed(dir: &Path, which: Which, extra: Value) {
    match which {
        Which::Peers => peer_file(dir, json!([laptop(extra)])),
        Which::Web => {
            let mut device = json!({
                "deviceId": "laptop", "name": "Phone", "userAgent": "", "tailscaleLogin": null,
                "secretSha256": "0".repeat(64), "publicKeyJwk": null, "grants": [], "uiPrefs": {},
                "createdAt": 0,
            });
            device
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            fs::write(
                dir.join("web-devices.json"),
                json!({"v":1, "devices":[device]}).to_string(),
            )
            .unwrap();
        }
    }
}

#[test]
fn reopens_committed_receipts_after_a_process_exits_without_flushing_its_device_list() {
    const TEST: &str = "remote::quota::tests::reopens_committed_receipts_after_a_process_exits_without_flushing_its_device_list";
    if let Some(dir) = std::env::var_os("OMPDESK_TEST_QUOTA_PROCESS_DIR") {
        let dir = Path::new(&dir);
        let which = if dir.join("remote-peers.json").exists() {
            Which::Peers
        } else {
            Which::Web
        };
        let q = Quota::new(which, dir);
        match std::env::var("OMPDESK_TEST_QUOTA_PHASE").unwrap().as_str() {
            "charge" => {
                assert_eq!(
                    reserve(&q, DAY, "first", "host-attempt", 3).unwrap(),
                    json!({"ok":true})
                );
            }
            "refund" => {
                let projected = match &q.records {
                    Records::Peers(store) => Value::Object(locked(store).get("laptop").unwrap()),
                    Records::Web(store) => store.get("laptop").unwrap().to_record(),
                };
                assert_eq!(
                    projected["usage"],
                    json!({"day":DAY, "requests":5, "tokens":8})
                );
                assert!(!projected.to_string().contains("host-attempt"));
                assert_eq!(projected["usage"].as_object().unwrap().len(), 3);
                assert_eq!(
                    reserve(&q, DAY, "first", "host-attempt", 3).unwrap(),
                    json!({"ok":true})
                );
                assert_eq!(
                    reserve(&q, DAY, "first", "new-attempt", 3).unwrap(),
                    duplicate(true)
                );
                q.run("laptop", Action::Refund { id: "first" }, DAY)
                    .unwrap();
            }
            "replay" => {
                for attempt in ["host-attempt", "new-attempt"] {
                    assert_eq!(
                        reserve(&q, DAY, "first", attempt, 3).unwrap(),
                        duplicate(false)
                    );
                    assert_eq!(
                        reserve(&q, NEXT, "first", attempt, 1).unwrap(),
                        duplicate(false)
                    );
                }
                assert_eq!(usage(&q, DAY), json!({"requests":2, "tokens":8}));
                assert_eq!(
                    reserve(&q, NEXT, "second", "another", 2).unwrap(),
                    json!({"ok":true})
                );
                q.run("laptop", Action::Refund { id: "first" }, NEXT)
                    .unwrap();
                assert_eq!(usage(&q, NEXT), json!({"requests":2, "tokens":0}));
            }
            other => panic!("unexpected phase {other}"),
        }
        std::process::exit(0);
    }
    for which in [Which::Peers, Which::Web] {
        let dir = tempdir().unwrap();
        let start = json!({"usage":{"day":DAY,"requests":2,"tokens":8}});
        for phase in ["charge", "refund", "replay"] {
            // The core may die before the JSON projection changes. Start each process with the original one.
            seed(dir.path(), which, start.clone());
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--nocapture"])
                .env("OMPDESK_TEST_QUOTA_PROCESS_DIR", dir.path())
                .env("OMPDESK_TEST_QUOTA_PHASE", phase)
                .status()
                .unwrap();
            assert!(status.success(), "{phase}: {status}");
            assert!(ledger_path(&dir.path().join(which.file()), "laptop").is_file());
        }
    }
}

const CONTENDER: &str = "OMPDESK_TEST_QUOTA_CONTENDER";
const UNLOCKED: &str = "OMPDESK_TEST_QUOTA_UNLOCKED";

fn wait_for_marker(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !path.exists() {
        assert!(Instant::now() < deadline, "timed out waiting for {path:?}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

pub(super) fn skip_lock(_: &Path) -> bool {
    if let Ok(worker) = std::env::var(CONTENDER) {
        fs::write(format!("{worker}.locking"), []).unwrap();
        return std::env::var_os(UNLOCKED).is_some();
    }
    false
}

pub(super) fn after_read(_: &Path) {
    if let Ok(worker) = std::env::var(CONTENDER) {
        fs::write(format!("{worker}.read"), []).unwrap();
        wait_for_marker(Path::new(&format!("{worker}.commit")));
    }
}

#[test]
fn two_processes_contend_for_the_last_admission() {
    const TEST: &str = "remote::quota::tests::two_processes_contend_for_the_last_admission";
    let admitted = json!({"ok":true});
    let refused = json!({"ok":false,"refusal":"requests"});
    if let Ok(worker) = std::env::var(CONTENDER) {
        let q = Quota::new(Which::Peers, &std::env::current_dir().unwrap());
        let answer = reserve(&q, DAY, &worker, "one", 1).unwrap();
        let wins = worker == "first" || std::env::var_os(UNLOCKED).is_some();
        assert_eq!(answer, if wins { admitted } else { refused });
        settled(&q);
        return;
    }

    for unlocked in [false, true] {
        let dir = tempdir().unwrap();
        let root = dir.path();
        seed(root, Which::Peers, json!({"limits":{"requestsPerDay":3}}));
        let q = Quota::new(Which::Peers, root);
        assert_eq!(reserve(&q, DAY, "seed", "one", 2).unwrap(), admitted);
        settled(&q);
        let lock_path = ledger_path(&q.path, "laptop").with_extension("lock");
        drop(q);

        let spawn = |worker: &str| {
            let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
            cmd.args(["--exact", TEST])
                .current_dir(root)
                .env(CONTENDER, worker);
            if unlocked {
                cmd.env(UNLOCKED, "1");
            } else {
                cmd.env_remove(UNLOCKED);
            }
            cmd.spawn().unwrap()
        };
        let mut first = spawn("first");
        wait_for_marker(&root.join("first.read"));
        let mut second = spawn("second");
        wait_for_marker(&root.join("second.locking"));
        let probe = fs::File::options()
            .read(true)
            .write(true)
            .open(lock_path)
            .unwrap();
        let locked = probe.try_lock();
        drop(probe);
        if unlocked && locked.is_ok() {
            // Both decisions now use the same snapshot; first publishes before second.
            wait_for_marker(&root.join("second.read"));
        }
        fs::write(root.join("first.commit"), []).unwrap();
        let first_status = first.wait().unwrap();
        fs::write(root.join("second.commit"), []).unwrap();
        let second_status = second.wait().unwrap();
        if unlocked {
            locked.expect("negative control must omit the production lock");
        } else {
            assert!(
                matches!(locked, Err(fs::TryLockError::WouldBlock)),
                "first process must still hold the device lock: {locked:?}"
            );
        }
        assert!(first_status.success(), "first contender: {first_status}");
        assert!(second_status.success(), "second contender: {second_status}");

        let q = Quota::new(Which::Peers, root);
        assert_eq!(usage(&q, DAY)["requests"], 3);
        // In the unlocked control both dispatched, but the second erased the first receipt.
        let (first, second) = if unlocked {
            (&refused, &admitted)
        } else {
            (&admitted, &refused)
        };
        for (id, expected) in [("first", first), ("second", second)] {
            assert_eq!(&reserve(&q, DAY, id, "one", 1).unwrap(), expected);
        }
    }
}

thread_local! {
    static FAIL_COMMIT: Cell<bool> = const { Cell::new(false) };
}

pub(super) fn before_commit(_: &Path) -> std::io::Result<()> {
    if FAIL_COMMIT.replace(false) {
        return Err(std::io::ErrorKind::StorageFull.into());
    }
    Ok(())
}

fn assert_commit_fails(q: &Quota, operation: impl FnOnce() -> Result<Value, Fault>) {
    let path = ledger_path(&q.path, "laptop");
    let committed = fs::read(&path).unwrap();
    FAIL_COMMIT.set(true);
    assert_eq!(operation().unwrap_err().code, "quota_storage");
    assert!(
        !FAIL_COMMIT.get(),
        "failure must reach snapshot publication"
    );
    assert!(crate::disk::saves::waiting_content(&path).is_none());
    settled(q);
    assert_eq!(fs::read(path).unwrap(), committed);
}

#[test]
fn a_full_ledger_rejects_without_leaving_a_charge_for_the_next_writer_or_restart() {
    let dir = tempdir().unwrap();
    seed(dir.path(), Which::Peers, json!({}));
    let q = Quota::new(Which::Peers, dir.path());
    assert_eq!(reserve(&q, DAY, "confirmed", "one", 2).unwrap()["ok"], true);
    assert_commit_fails(&q, || reserve(&q, DAY, "failed", "first", 1));
    assert_eq!(usage(&q, DAY)["requests"], 2);
    assert_eq!(reserve(&q, DAY, "unrelated", "b", 1).unwrap()["ok"], true);
    drop(q);
    let q = Quota::new(Which::Peers, dir.path());
    assert_eq!(usage(&q, DAY)["requests"], 3);
    assert_eq!(
        reserve(&q, DAY, "failed", "other", 1).unwrap(),
        json!({"ok":true})
    );
    assert_eq!(usage(&q, DAY)["requests"], 4);
    settled(&q);
}

#[test]
fn a_counter_write_failure_rolls_back_the_refund_and_cannot_be_saved_later() {
    let dir = tempdir().unwrap();
    seed(dir.path(), Which::Peers, json!({}));
    let q = Quota::new(Which::Peers, dir.path());
    reserve(&q, DAY, "charged", "attempt", 4).unwrap();
    let refund = Action::Refund { id: "charged" };
    assert_commit_fails(&q, || q.run("laptop", refund, DAY));
    assert_eq!(
        reserve(&q, DAY, "charged", "other", 4).unwrap(),
        duplicate(true)
    );
    assert_eq!(usage(&q, DAY)["requests"], 4);
    assert_eq!(reserve(&q, DAY, "next", "b", 1).unwrap()["ok"], true);
    settled(&q);
    drop(q);
    let q = Quota::new(Which::Peers, dir.path());
    assert_eq!(usage(&q, DAY)["requests"], 5);
    assert_eq!(
        reserve(&q, DAY, "charged", "other", 4).unwrap(),
        duplicate(true)
    );
    q.run("laptop", refund, DAY).unwrap();
    reserve(&q, DAY, "unrelated", "other", 2).unwrap();
    q.run("laptop", refund, DAY).unwrap();
    assert_eq!(usage(&q, DAY)["requests"], 3);
    settled(&q);
}

#[test]
fn an_old_day_or_an_old_pairing_cannot_refund_new_usage_and_an_unknown_device_creates_no_ledger() {
    let dir = tempdir().unwrap();
    seed(
        dir.path(),
        Which::Peers,
        json!({"limits":{"requestsPerDay":4}}),
    );
    let q = Quota::new(Which::Peers, dir.path());
    let request = Action::Reserve {
        id: "old-pair",
        attempt: "a",
        requests: 2,
    };
    assert_eq!(
        q.run("missing", request, DAY).unwrap_err().code,
        "unknown_device"
    );
    assert!(!q.path.exists());
    q.run("laptop", request, DAY).unwrap();
    reserve(&q, DAY, "old-day", "b", 2).unwrap();
    reserve(&q, NEXT, "current", "c", 1).unwrap();
    q.run("laptop", Action::Refund { id: "old-day" }, NEXT)
        .unwrap();
    assert_eq!(usage(&q, NEXT)["requests"], 1);
    let Records::Peers(store) = &q.records else {
        unreachable!()
    };
    locked(store).remove("laptop").unwrap();
    assert_eq!(
        q.run("laptop", request, NEXT).unwrap_err().code,
        "unknown_device"
    );
    locked(store)
        .put(laptop(json!({"pairedAt":1})).as_object().unwrap().clone())
        .unwrap();
    assert_eq!(usage(&q, NEXT)["requests"], 0);
    assert_eq!(q.run("laptop", request, NEXT).unwrap(), duplicate(false));
    reserve(&q, NEXT, "fresh", "new-pair", 5).unwrap();
    q.run("laptop", Action::Refund { id: "current" }, NEXT)
        .unwrap();
    assert_eq!(usage(&q, NEXT)["requests"], 5);
    settled(&q);
}

#[test]
fn tokens_limits_and_pairing_edits_survive_projection_writes() {
    let dir = tempdir().unwrap();
    seed(dir.path(), Which::Peers, json!({}));
    let q = Quota::new(Which::Peers, dir.path());
    let Records::Peers(store) = &q.records else {
        unreachable!()
    };
    for seen in 0..3 {
        q.run(
            "laptop",
            Action::Record {
                requests: 1,
                tokens: 10,
            },
            DAY,
        )
        .unwrap();
        locked(store)
            .update("laptop", vec![("lastSeenAt".into(), Some(json!(seen)))])
            .unwrap();
    }
    q.run(
        "laptop",
        Action::SetLimits(Limits {
            tokens_per_day: Some(30),
            requests_per_day: None,
        }),
        DAY,
    )
    .unwrap();
    assert_eq!(reserve(&q, DAY, "id", "a", 1).unwrap()["refusal"], "tokens");
    q.run("laptop", Action::SetLimits(Limits::default()), DAY)
        .unwrap();
    assert_eq!(reserve(&q, DAY, "id", "a", 1).unwrap()["ok"], true);
    settled(&q);
    let file: Value =
        serde_json::from_slice(&fs::read(dir.path().join("remote-peers.json")).unwrap()).unwrap();
    assert_eq!(
        file["peers"][0]["usage"],
        json!({"day":DAY, "requests":4, "tokens":30})
    );
    assert_eq!(file["peers"][0]["lastSeenAt"], 2);
    assert!(file["peers"][0].get("limits").is_none());
}

#[test]
fn zero_weight_deduplicates_ingress_even_at_the_limit_without_granting_a_charge() {
    let dir = tempdir().unwrap();
    seed(
        dir.path(),
        Which::Peers,
        json!({
            "usage": {"day":DAY,"requests":2,"tokens":30},
            "limits": {"requestsPerDay":1,"tokensPerDay":30}
        }),
    );
    let q = Quota::new(Which::Peers, dir.path());
    assert_eq!(
        reserve(&q, DAY, "actual-run", "one", 1).unwrap()["ok"],
        false
    );
    assert_eq!(
        reserve(&q, DAY, "ingress", "one", 0).unwrap(),
        json!({"ok":true})
    );
    drop(q);
    let q = Quota::new(Which::Peers, dir.path());
    assert_eq!(
        reserve(&q, DAY, "ingress", "one", 0).unwrap(),
        json!({"ok":true})
    );
    assert_eq!(
        reserve(&q, DAY, "ingress", "one", 1).unwrap(),
        duplicate(false)
    );
    assert_eq!(
        reserve(&q, NEXT, "ingress", "two", 0).unwrap(),
        duplicate(false)
    );
    q.run("laptop", Action::Refund { id: "ingress" }, DAY)
        .unwrap();
    assert_eq!(
        reserve(&q, DAY, "ingress", "one", 0).unwrap(),
        duplicate(false)
    );
    assert_eq!(usage(&q, DAY), json!({"requests":2,"tokens":30}));
}

#[test]
fn one_of_two_attempts_may_dispatch_and_another_device_has_its_own_receipt() {
    let dir = tempdir().unwrap();
    peer_file(
        dir.path(),
        json!([laptop(json!({})), laptop(json!({"deviceId":"other"}))]),
    );
    let q = Quota::new(Which::Peers, dir.path());
    let start = std::sync::Barrier::new(2);
    let answers = std::thread::scope(|threads| {
        let handles = ["one", "two"].map(|attempt| {
            let q = &q;
            let start = &start;
            threads.spawn(move || {
                start.wait();
                reserve(q, DAY, "same-id", attempt, 3).unwrap()
            })
        });
        handles.map(|thread| thread.join().unwrap())
    });
    assert!(answers.contains(&json!({"ok":true})));
    assert!(answers.contains(&duplicate(true)));
    q.run("other", Action::Refund { id: "same-id" }, DAY)
        .unwrap();
    assert_eq!(usage(&q, DAY)["requests"], 3);
    let other = Action::Reserve {
        id: "same-id",
        attempt: "one",
        requests: 2,
    };
    assert_eq!(q.run("other", other, DAY).unwrap(), json!({"ok":true}));
    q.run("laptop", Action::Refund { id: "same-id" }, DAY)
        .unwrap();
    assert_eq!(
        q.run("other", Action::View, DAY).unwrap()["usage"]["requests"],
        2
    );
    assert_eq!(usage(&q, DAY)["requests"], 0);
    settled(&q);
}

mod contention;
