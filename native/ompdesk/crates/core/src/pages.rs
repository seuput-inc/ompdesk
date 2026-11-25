//! The one sender of the core's pushes to pages (docs/rust-node-removal.md, "C4"). A window id at or above zero is a
//! desktop window, the shell's webContents id: its push goes to the core's owner on the core's stdio as the event
//! `page.push {win, ch, pushed}` with the data's JSON as `bin`, and the owner puts it in that window's outbox
//! (`owner.rs`, the shell's `page_push.rs`). Every frame leaves through the one stdio writer, so a window hears the
//! core's pushes in the order they were made. A window id below zero is a paired device's: the core's router takes it
//! in this process (`web::router::deliver_window`), under the same rules as main's pushes to that device.
//!
//! `pushed` numbers the desktop pushes of this core process from 1, so an answer can say which pushes were made
//! before it.
//!
//! Built, not called: the pool's pushes still go through main until the event drain (C5) moves their producer here.
//! A test core started with `OMPDESK_TEST_PAGES_SHADOW` set sends the pool's pushes here as well (`shadow`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use serde_json::{Value, json};

use crate::server::Events;

static OWNER: Mutex<Option<Events>> = Mutex::new(None);
static PUSHED: AtomicU64 = AtomicU64::new(0);
static SHADOW: LazyLock<bool> =
    LazyLock::new(|| std::env::var_os("OMPDESK_TEST_PAGES_SHADOW").is_some());

/// The core's stdio, when it is its owner's and not main's (`serve_as`).
pub fn attach(events: Events) {
    *OWNER.lock().unwrap_or_else(|e| e.into_inner()) = Some(events);
}

/// Whether a test core also sends what the pool hands main (the parity suite's comparison).
pub fn shadow() -> bool {
    *SHADOW
}

/// The number of the last desktop push this process made, 0 before the first.
pub fn pushed() -> u64 {
    PUSHED.load(Ordering::SeqCst)
}

/// `data` on `channel` (an `IPC_EVENTS` value) to every window of `wins`, its JSON written once.
pub fn send(wins: &[i64], channel: &str, data: &Value) {
    let Ok(text) = serde_json::to_vec(data) else {
        return;
    };
    let owner = OWNER.lock().unwrap_or_else(|e| e.into_inner());
    for &win in wins {
        if win < 0 {
            crate::web::router::deliver_window(win, channel, text.clone());
            continue;
        }
        let Some(owner) = owner.as_ref() else {
            continue;
        };
        // Numbered and queued under one lock: a later number never reaches the writer first.
        let pushed = PUSHED.fetch_add(1, Ordering::SeqCst) + 1;
        owner.send_bin(
            "page.push",
            &json!({"win": win, "ch": channel, "pushed": pushed}),
            text.clone(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_each_desktop_push_and_writes_its_data_once_as_bin() {
        let (events, _keep, mut frames) = Events::capture();
        attach(events);
        let before = pushed();
        send(
            &[3, 7],
            "rpc:tab-status",
            &json!({"tabId": "t", "status": "ready"}),
        );
        let mut got = Vec::new();
        while let Ok(frame) = frames.try_recv() {
            let (head, bin) = frame.parts();
            let head: Value = serde_json::from_slice(head).expect("a JSON line");
            got.push((head, bin.map(<[u8]>::to_vec)));
        }
        assert_eq!(got.len(), 2);
        for (index, (head, bin)) in got.iter().enumerate() {
            assert_eq!(head["event"], "page.push");
            assert_eq!(head["data"]["ch"], "rpc:tab-status");
            assert_eq!(head["data"]["pushed"], before + 1 + index as u64);
            let data: Value = serde_json::from_slice(bin.as_deref().expect("bin")).unwrap();
            assert_eq!(data, json!({"tabId": "t", "status": "ready"}));
        }
        assert_eq!(got[0].0["data"]["win"], 3);
        assert_eq!(got[1].0["data"]["win"], 7);
        assert_eq!(pushed(), before + 2);
    }
}
