use serde_json::value::to_raw_value;

use super::*;

struct Slot(u64);

impl Slot {
    fn open(id: u64, checkpoint: Value) -> Result<Self, Fault> {
        let opts = to_raw_value(&json!({
            "leaseMs": 100, "revokeTimeoutMs": 10, "retryMs": 5, "checkpoint": checkpoint
        }))
        .unwrap();
        (KIND.open)(id, &opts, Out { id })?;
        Ok(Self(id))
    }

    fn step(&self, now: u64, mut op: Value) -> Value {
        op["now"] = now.into();
        op["wall"] = (1000 + now).into();
        match (KIND.call)(self.0, "step", &to_raw_value(&op).unwrap()) {
            Outcome::Now(result) => result.unwrap(),
            Outcome::Later(_) => panic!("desktop slot steps must answer synchronously"),
        }
    }

    fn acquire(&self, now: u64, tab: &str, request: &str) -> Value {
        self.step(
            now,
            json!({"op": "acquire", "tabId": tab, "requestId": request}),
        )
    }

    fn tab(&self, now: u64, op: &str, tab: &str) -> Value {
        self.step(now, json!({"op": op, "tabId": tab}))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        (KIND.close)(self.0);
    }
}

fn grants(tab: &str, requests: &[&str], waited: bool) -> Value {
    Value::Array(
        requests
            .iter()
            .map(|request| json!({"kind":"grant", "tabId":tab, "requestId":request, "waited":waited}))
            .collect(),
    )
}

fn answer(revoke: &Value, ok: bool) -> Value {
    json!({"op":"answered", "lease":revoke["lease"], "attempt":revoke["attempt"], "ok":ok})
}

#[test]
fn fifo_groups_waited_requests_and_rearms_only_the_active_holder() {
    let slot = Slot::open(1, Value::Null).unwrap();
    let first = slot.acquire(0, "a", "a1");
    assert_eq!(first["holder"]["since"], 1000);
    assert_eq!(first["effects"], grants("a", &["a1"], false));
    assert_eq!(first["changed"], true);
    slot.acquire(1, "b", "b1");
    slot.acquire(2, "c", "c1");
    let waiting = slot.acquire(3, "b", "b2");
    assert_eq!(waiting["queue"], json!(["b", "c"]));
    assert_eq!(waiting["effects"], json!([]));
    let own = slot.acquire(10, "a", "a2");
    assert_eq!(own["changed"], false);
    assert_eq!(own["deadline"], 110);
    assert_eq!(own["effects"], grants("a", &["a2"], false));
    assert_eq!(slot.tab(20, "touch", "a")["deadline"], 120);
    assert_eq!(slot.tab(21, "touch", "b")["deadline"], 120);
    assert_eq!(slot.step(119, json!({"op":"tick"}))["effects"], json!([]));
    let expired = slot.step(120, json!({"op":"tick"}));
    let revoke = &expired["effects"][0];
    assert_eq!(revoke["reason"], "lease");
    assert_eq!(revoke["tabId"], "a");
    assert_eq!(expired["changed"], false);
    let granted = slot.step(121, answer(revoke, true));
    assert_eq!(granted["effects"], grants("b", &["b1", "b2"], true));
    assert_eq!(granted["deadline"], 221);
    assert_eq!(granted["holder"]["since"], 1121);
    assert_eq!(granted["queue"], json!(["c"]));
    assert_eq!(
        slot.tab(122, "release", "b")["effects"],
        grants("c", &["c1"], true)
    );
    let empty = slot.tab(123, "release", "c");
    assert_eq!(empty["holder"], Value::Null);
    assert_eq!(empty["deadline"], Value::Null);
}

#[test]
fn unacknowledged_retry_replays_identically_and_late_answers_only_free_the_original_lease() {
    for failure in ["timeout", "rejection"] {
        for retry in ["tick", "retry"] {
            let live = Slot::open(1, Value::Null).unwrap();
            let acquired = live.acquire(0, "a", "a1");
            live.acquire(1, "b", "b1");
            live.acquire(2, "b", "b2");
            let stopped = live.tab(3, "stop", "a");
            let old = &stopped["effects"][0];
            assert_eq!(old["kind"], "revoke");
            assert_eq!(old["reason"], "stop");
            assert_eq!(old["lease"], acquired["holder"]["lease"]);
            assert_eq!(old["attempt"], stopped["pending"]);
            assert_eq!(stopped["deadline"], 13);
            assert_eq!(live.tab(4, "stop", "a")["effects"], json!([]));
            assert_eq!(live.tab(5, "release", "a")["pending"], old["attempt"]);
            let failed = if failure == "timeout" {
                live.step(13, json!({"op":"tick"}))
            } else {
                live.step(13, answer(old, false))
            };
            assert_eq!(failed["holder"]["failed"], true);
            assert_eq!(failed["pending"], Value::Null);
            assert_eq!(failed["effects"], json!([]));
            assert_eq!(failed["deadline"], 18);
            let queued = live.acquire(14, "a", "a2");
            assert_eq!(queued["queue"], json!(["b", "a"]));
            assert_eq!(live.tab(15, "touch", "a")["deadline"], 18);
            let now = if retry == "retry" { 15 } else { 18 };
            let again = json!({"op":retry});
            let lost = live.step(now, again.clone());
            drop(live);
            let restored = Slot::open(1, queued["checkpoint"].clone()).unwrap();
            assert_eq!(restored.step(now, again), lost);
            let current = &lost["effects"][0];
            assert!(current["attempt"].as_u64().unwrap() > old["attempt"].as_u64().unwrap());
            assert_eq!(lost["holder"]["failed"], true);
            assert_eq!(current["lease"], old["lease"]);
            drop(restored);
            let restored = Slot::open(1, lost["checkpoint"].clone()).unwrap();
            let stale = if failure == "rejection" {
                restored.step(19, answer(old, false))
            } else {
                restored.step(19, json!({"op":"tick"}))
            };
            assert_eq!(stale["pending"], current["attempt"]);
            assert_eq!(stale["checkpoint"], lost["checkpoint"]);
            let confirmed = if failure == "timeout" { old } else { current };
            let next = restored.step(20, answer(confirmed, true));
            drop(restored);
            let restored = Slot::open(1, stale["checkpoint"].clone()).unwrap();
            assert_eq!(restored.step(20, answer(confirmed, true)), next);
            assert_eq!(next["effects"], grants("b", &["b1", "b2"], true));
            assert_eq!(next["queue"], json!(["a"]));
            assert!(
                next["holder"]["lease"].as_u64().unwrap() > current["attempt"].as_u64().unwrap()
            );
            let new_a = restored.tab(21, "release", "b");
            assert_eq!(new_a["effects"], grants("a", &["a2"], true));
            for event in [
                answer(old, failure == "timeout"),
                answer(current, true),
                json!({"op":"killed","lease":old["lease"]}),
            ] {
                let ignored = restored.step(22, event);
                assert_eq!(ignored["checkpoint"], new_a["checkpoint"]);
                assert_eq!(ignored["changed"], false);
                assert_eq!(ignored["effects"], json!([]));
            }
        }
    }
}

#[test]
fn confirmed_exit_discards_the_dead_executions_queued_requests() {
    for op in ["crashed", "killed"] {
        let slot = Slot::open(1, Value::Null).unwrap();
        let held = slot.acquire(0, "a", "a1");
        let stopping = slot.tab(0, "stop", "a");
        slot.acquire(1, "a", "a2");
        slot.acquire(1, "a", "a3");
        slot.acquire(1, "b", "b1");
        let exit = if op == "crashed" {
            slot.tab(2, op, "a")
        } else {
            slot.step(2, json!({"op":op, "lease":held["holder"]["lease"]}))
        };
        assert_eq!(exit["queue"], json!([]));
        assert_eq!(exit["pending"], Value::Null);
        assert_eq!(exit["effects"], grants("b", &["b1"], true));
        assert_eq!(
            slot.step(3, answer(&stopping["effects"][0], true))["checkpoint"],
            exit["checkpoint"]
        );
    }
}

#[test]
fn removing_a_waiter_only_stops_its_process_on_explicit_stop() {
    for op in ["release", "stop", "closed", "crashed"] {
        let slot = Slot::open(1, Value::Null).unwrap();
        slot.acquire(0, "a", "a1");
        slot.acquire(0, "b", "b1");
        slot.acquire(0, "c", "c1");
        let removed = slot.tab(1, op, "b");
        assert_eq!(removed["queue"], json!(["c"]));
        let effects = if op == "stop" {
            json!([{"kind":"stopWaiter","tabId":"b"}])
        } else {
            json!([])
        };
        assert_eq!(removed["effects"], effects);
        assert_eq!(removed["changed"], true);
        assert_eq!(slot.tab(2, op, "b")["changed"], false);
        assert_eq!(
            slot.tab(3, "release", "a")["effects"],
            grants("c", &["c1"], true)
        );
    }
}

#[test]
fn closing_a_requeued_holder_removes_its_asks_but_still_waits_for_confirmation() {
    for failed in [false, true] {
        let slot = Slot::open(1, Value::Null).unwrap();
        slot.acquire(0, "a", "a1");
        let stop = slot.tab(0, "stop", "a");
        if failed {
            slot.step(1, answer(&stop["effects"][0], false));
        }
        slot.acquire(2, "a", "a2");
        slot.acquire(2, "b", "b1");
        let close = slot.tab(3, "closed", "a");
        assert_eq!(close["changed"], true);
        assert_eq!(close["queue"], json!(["b"]));
        assert_eq!(close["holder"]["tabId"], "a");
        let revoke = if failed {
            assert_eq!(close["effects"][0]["reason"], "closed");
            &close["effects"][0]
        } else {
            assert_eq!(close["effects"], json!([]));
            assert_eq!(close["pending"], stop["pending"]);
            &stop["effects"][0]
        };
        let next = slot.step(4, answer(revoke, true));
        assert_eq!(next["effects"], grants("b", &["b1"], true));
        assert_eq!(next["queue"], json!([]));
    }
}

#[test]
fn release_from_a_failed_holder_is_a_confirmation_but_an_unissued_attempt_is_not() {
    let slot = Slot::open(1, Value::Null).unwrap();
    let held = slot.acquire(0, "a", "a1");
    let lease = held["holder"]["lease"].as_u64().unwrap();
    let stopped = slot.tab(1, "stop", "a");
    let attempt = stopped["pending"].as_u64().unwrap();
    slot.acquire(2, "a", "a2");
    for wrong in [lease, attempt + 1] {
        let reply = slot.step(
            3,
            json!({"op":"answered","lease":lease,"attempt":wrong,"ok":true}),
        );
        assert_eq!(reply["effects"], json!([]));
        assert_eq!(reply["pending"], attempt);
    }
    slot.step(4, answer(&stopped["effects"][0], false));
    let resumed = slot.tab(5, "release", "a");
    assert_eq!(resumed["effects"], grants("a", &["a2"], true));
    assert!(resumed["holder"]["lease"].as_u64().unwrap() > attempt);
}

#[test]
fn invalid_checkpoints_never_open_an_empty_or_partially_restored_slot() {
    let slot = Slot::open(1, Value::Null).unwrap();
    slot.acquire(0, "a", "a1");
    let held = slot.acquire(1, "b", "b1");
    let ctl = &held["checkpoint"];
    let mut invalid = vec![json!({}), json!(false)];
    for (field, value) in [
        ("sequence", json!(0)),
        ("sequence", json!(MAX_SAFE + 1)),
        ("holder", Value::Null),
        ("queue", json!([ctl["queue"][0], ctl["queue"][0]])),
    ] {
        let mut bad = ctl.clone();
        bad[field] = value;
        invalid.push(bad);
    }
    let missing = json!({"sequence": 1, "queue": []});
    invalid.push(missing);
    let mut empty = ctl.clone();
    empty["queue"][0]["requests"] = json!([]);
    invalid.push(empty);
    let mut own = ctl.clone();
    own["queue"][0]["tabId"] = json!("a");
    invalid.push(own);
    for bad in invalid {
        assert!(Slot::open(2, bad).is_err());
        let args = to_raw_value(&json!({"op":"tick", "now":1, "wall":1001})).unwrap();
        assert!(matches!(
            (KIND.call)(2, "step", &args),
            Outcome::Now(Err(_))
        ));
    }
    let replay = Slot::open(2, ctl.clone()).unwrap();
    assert_eq!(replay.step(1, json!({"op":"tick"}))["checkpoint"], *ctl);
}

#[test]
fn a_late_confirmation_survives_reopening_before_retry_is_due() {
    let slot = Slot::open(1, Value::Null).unwrap();
    slot.acquire(0, "a", "a1");
    let stop = slot.tab(1, "stop", "a");
    slot.acquire(2, "b", "b1");
    let failed = slot.step(11, json!({"op":"tick"}));
    assert_eq!(failed["pending"], Value::Null);
    assert_eq!(failed["deadline"], 16);
    drop(slot);
    let slot = Slot::open(1, failed["checkpoint"].clone()).unwrap();
    let next = slot.step(12, answer(&stop["effects"][0], true));
    assert_eq!(next["effects"], grants("b", &["b1"], true));
    assert_eq!(next["pending"], Value::Null);
    assert_eq!(next["holder"]["failed"], false);
    assert_eq!(
        slot.step(16, json!({"op":"tick"}))["checkpoint"],
        next["checkpoint"]
    );
}
