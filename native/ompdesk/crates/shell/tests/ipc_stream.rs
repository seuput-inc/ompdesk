#[allow(dead_code)]
#[path = "../src/ipc.rs"]
mod ipc;

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use serde_json::{Value, json};

const CAPACITY: usize = 4096;

fn drain(wc_id: u64, reader: &ipc::Reader) -> Vec<u8> {
    let mut result = Vec::new();
    let mut buffer = [0; 1024];
    loop {
        let count = ipc::pull(wc_id, reader, &mut buffer);
        if count == 0 {
            return result;
        }
        result.extend_from_slice(&buffer[..count]);
    }
}

fn frames(bytes: &[u8]) -> Vec<Value> {
    bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| {
            serde_json::from_slice(line).expect("each event and reset is a complete JSON line")
        })
        .collect()
}

#[test]
fn overflow_announces_the_evicted_final_delta_after_the_retained_events() {
    let wc = 1_100_001;
    let other = 1_100_002;
    let reader = ipc::open_reader(wc);
    let other_reader = ipc::open_reader(other);
    ipc::push(
        wc,
        "sessions:changed",
        &json!([{ "list": { "base": "e.1", "version": "e.2", "set": [], "remove": ["/deleted"] } }]),
    );
    ipc::push(other, "other-window", &json!(["untouched"]));
    for i in 0..CAPACITY {
        ipc::push(wc, "noise", &json!([i]));
    }

    let received = frames(&drain(wc, &reader));
    assert_eq!(received.len(), CAPACITY + 1);
    for (i, frame) in received[..CAPACITY].iter().enumerate() {
        assert_eq!(frame, &json!({ "channel": "noise", "args": [i] }));
    }
    assert_eq!(received[CAPACITY], json!({ "stream": "reset" }));
    assert_eq!(
        frames(&drain(other, &other_reader)),
        vec![json!({ "channel": "other-window", "args": ["untouched"] })]
    );
    ipc::drop_page(wc);
    ipc::drop_page(other);
}

#[test]
fn overflow_preserves_an_already_partially_delivered_event() {
    let wc = 1_100_003;
    let reader = ipc::open_reader(wc);
    ipc::push(wc, "first", &json!(["한글"]));
    let mut first = [0; 5];
    assert_eq!(ipc::pull(wc, &reader, &mut first), first.len());
    for i in 0..CAPACITY {
        ipc::push(wc, "noise", &json!([i]));
    }

    let mut bytes = first.to_vec();
    bytes.extend_from_slice(&drain(wc, &reader));
    let received = frames(&bytes);
    assert_eq!(received.len(), CAPACITY + 1);
    assert_eq!(received[0], json!({ "channel": "first", "args": ["한글"] }));
    for (i, frame) in received[1..CAPACITY].iter().enumerate() {
        assert_eq!(frame, &json!({ "channel": "noise", "args": [i + 1] }));
    }
    assert_eq!(received[CAPACITY], json!({ "stream": "reset" }));
    ipc::drop_page(wc);
}

#[test]
fn another_overflow_during_a_partial_reset_reports_another_reset() {
    let wc = 1_100_004;
    let reader = ipc::open_reader(wc);
    for _ in 0..=CAPACITY {
        ipc::push(wc, "noise", &json!([1]));
    }
    let line = format!("{}\n", json!({ "channel": "noise", "args": [1] }));
    let mut prefix = vec![0; line.len() * CAPACITY + 5];
    assert_eq!(ipc::pull(wc, &reader, &mut prefix), prefix.len());
    for _ in 0..=CAPACITY {
        ipc::push(wc, "noise", &json!([2]));
    }

    prefix.extend_from_slice(&drain(wc, &reader));
    let received = frames(&prefix);
    assert_eq!(received.len(), 2 * CAPACITY + 2);
    assert_eq!(received[CAPACITY], json!({ "stream": "reset" }));
    assert!(
        received[CAPACITY + 1..2 * CAPACITY + 1]
            .iter()
            .all(|frame| *frame == json!({ "channel": "noise", "args": [2] }))
    );
    assert_eq!(received[2 * CAPACITY + 1], json!({ "stream": "reset" }));
    ipc::drop_page(wc);
}

#[test]
fn reconnect_keeps_the_remainder_and_other_queued_events() {
    let wc = 1_100_005;
    let old = ipc::open_reader(wc);
    ipc::push(wc, "first", &json!(["value"]));
    ipc::push(wc, "second", &json!(["value"]));
    let mut prefix = [0; 5];
    assert_eq!(ipc::pull(wc, &old, &mut prefix), prefix.len());
    ipc::reader_gone(wc, &old);
    let reader = ipc::open_reader(wc);
    let mut bytes = prefix.to_vec();
    bytes.extend_from_slice(&drain(wc, &reader));
    assert_eq!(
        frames(&bytes),
        vec![
            json!({ "channel": "first", "args": ["value"] }),
            json!({ "channel": "second", "args": ["value"] }),
            json!({ "stream": "reset" })
        ]
    );
    ipc::drop_page(wc);
}

#[test]
fn stale_reader_cannot_drain_or_cancel_the_replacement() {
    let wc = 1_100_006;
    let old = ipc::open_reader(wc);
    ipc::push(wc, "kept", &json!([1]));
    let reader = ipc::open_reader(wc);
    let mut buffer = [0; 16];
    assert_eq!(ipc::pull(wc, &old, &mut buffer), 0);
    assert_eq!(
        ipc::read_or_park(
            wc,
            &old,
            &mut buffer,
            Box::new(|| panic!("stale reader was parked"))
        ),
        Some(0)
    );
    assert_eq!(
        frames(&drain(wc, &reader)),
        vec![
            json!({ "channel": "kept", "args": [1] }),
            json!({ "stream": "reset" })
        ]
    );
    let wakes = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&wakes);
    assert_eq!(
        ipc::read_or_park(
            wc,
            &reader,
            &mut buffer,
            Box::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
            })
        ),
        None
    );
    ipc::reader_gone(wc, &old);
    assert_eq!(wakes.load(Ordering::SeqCst), 0);
    ipc::push(wc, "next", &json!([2]));
    assert_eq!(wakes.load(Ordering::SeqCst), 1);
    assert_eq!(
        frames(&drain(wc, &reader)),
        vec![json!({ "channel": "next", "args": [2] })]
    );
    ipc::drop_page(wc);
}

#[test]
fn a_reader_from_a_destroyed_page_cannot_touch_a_reused_wc_id() {
    let wc = 1_100_007;
    let old = ipc::open_reader(wc);
    ipc::drop_page(wc);
    let reader = ipc::open_reader(wc);
    ipc::push(wc, "new-page", &json!([3]));
    let mut buffer = [0; 16];
    assert_eq!(ipc::pull(wc, &old, &mut buffer), 0);
    ipc::reader_gone(wc, &old);
    assert_eq!(
        frames(&drain(wc, &reader)),
        vec![json!({ "channel": "new-page", "args": [3] })]
    );
    ipc::drop_page(wc);
}

#[test]
fn replacing_a_parked_reader_releases_only_the_old_reader() {
    let wc = 1_100_008;
    let old = ipc::open_reader(wc);
    let wakes = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&wakes);
    let mut buffer = [0; 16];
    assert_eq!(
        ipc::read_or_park(
            wc,
            &old,
            &mut buffer,
            Box::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
            })
        ),
        None
    );
    let reader = ipc::open_reader(wc);
    assert_eq!(wakes.load(Ordering::SeqCst), 1);
    assert_eq!(
        frames(&drain(wc, &reader)),
        vec![json!({ "stream": "reset" })]
    );
    assert_eq!(ipc::pull(wc, &old, &mut buffer), 0);
    ipc::drop_page(wc);
}
