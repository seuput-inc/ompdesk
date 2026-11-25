use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::*;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ompdesk-quota-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A `remote-peers.json` holding `peers`, and the quota's records over it.
fn peers(dir: &Path, peers: Value) -> Records {
    let file = json!({ "v": 1, "peers": peers });
    std::fs::write(dir.join("remote-peers.json"), file.to_string()).unwrap();
    Records::Peers(store::open(dir, store::Kind::Peers))
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

/// The laptop's entry as the file holds it once every change made so far is written (the file is read only then:
/// on Windows a read during the writer's rename would hold it back).
fn on_disk(dir: &Path, records: &Records) -> Value {
    let Records::Peers(store) = records else {
        unreachable!("these cases run over the peers' store")
    };
    let start = Instant::now();
    while !store::settled(store) {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "the writes settle"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let text = std::fs::read_to_string(dir.join("remote-peers.json")).unwrap();
    let file: Value = serde_json::from_str(&text).unwrap();
    file["peers"][0].clone()
}

#[test]
fn a_reservation_is_answered_from_memory_and_its_count_is_on_disk_once_the_write_settles() {
    let dir = scratch("disk");
    let records = peers(
        &dir,
        json!([laptop(json!({ "limits": { "requestsPerDay": 3 } }))]),
    );

    assert_eq!(reserve(&records, "laptop", 1)["ok"], json!(true));
    assert_eq!(view(&records, "laptop")["usage"]["requests"], json!(1));
    let entry = on_disk(&dir, &records);
    assert_eq!(
        entry["usage"],
        json!({ "day": today(), "requests": 1, "tokens": 0 })
    );
    assert_eq!(entry["limits"], json!({ "requestsPerDay": 3 }));
}

#[test]
fn reservations_at_the_limit_let_exactly_one_through() {
    let dir = scratch("parallel");
    let day = today();
    let records = peers(
        &dir,
        json!([laptop(json!({
            "limits": { "requestsPerDay": 3 },
            "usage": { "day": day, "requests": 2, "tokens": 0 },
        }))]),
    );
    let answers: Vec<Value> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..5)
            .map(|_| {
                scope.spawn(|| {
                    let _counting = locked(&COUNTING);
                    reserve(&records, "laptop", 1)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(answers.iter().filter(|a| a["ok"] == json!(true)).count(), 1);
    assert!(
        answers
            .iter()
            .filter(|a| a["ok"] == json!(false))
            .all(|a| a["refusal"] == json!("requests"))
    );
    assert_eq!(on_disk(&dir, &records)["usage"]["requests"], json!(3));
}

#[test]
fn a_write_of_the_devices_instance_between_counts_never_loses_either() {
    let dir = scratch("order");
    let records = peers(&dir, json!([laptop(json!({}))]));
    let Records::Peers(store) = &records else {
        unreachable!()
    };
    for seen in 0..20 {
        record(&records, "laptop", 1, 10);
        locked(store)
            .update("laptop", vec![("lastSeenAt".into(), Some(json!(seen)))])
            .unwrap();
    }
    record(&records, "laptop", 1, 10);
    let entry = on_disk(&dir, &records);
    assert_eq!(entry["usage"]["requests"], json!(21));
    assert_eq!(entry["usage"]["tokens"], json!(210));
    assert_eq!(entry["lastSeenAt"], json!(19));
}

#[test]
fn refunds_once_per_day_and_limits_come_off_with_an_empty_object() {
    let dir = scratch("refund");
    let records = peers(
        &dir,
        json!([laptop(json!({ "limits": { "requestsPerDay": 1 } }))]),
    );
    let first = reserve(&records, "laptop", 1);
    assert_eq!(
        reserve(&records, "laptop", 1),
        json!({ "ok": false, "refusal": "requests" })
    );
    refund(&records, "laptop", first["day"].as_str().unwrap(), 1);
    assert_eq!(view(&records, "laptop")["usage"]["requests"], json!(0));
    refund(&records, "laptop", "1999-01-01", 1);
    assert_eq!(reserve(&records, "laptop", 1)["ok"], json!(true));

    assert!(set_limits(&records, "laptop", Limits::default()));
    assert_eq!(view(&records, "laptop")["limits"], json!({}));
    assert!(on_disk(&dir, &records).get("limits").is_none());
    assert!(!set_limits(&records, "nobody", Limits::default()));
    assert_eq!(reserve(&records, "nobody", 1)["ok"], json!(true));
}
