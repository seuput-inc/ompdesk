//! Paired attachments stay in RAM until the last ordered part goes to the ordinary upload store.
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use crate::clock;
use crate::server::{Answer, Call, Fault, Reply, at_once};
use crate::web::uploads;

const PER_DEVICE: usize = 2;
const IDLE: Duration = Duration::from_secs(120);

type Key = (u64, String, String); // host service, authenticated device, sender's upload id

#[derive(Default)]
struct Parts {
    chunks: Vec<Vec<u8>>,
    size: usize,
    next: u64,
}

struct Waiting {
    parts: Parts,
    timer: clock::Timer,
    token: u64,
}

static WAITING: LazyLock<Mutex<HashMap<Key, Waiting>>> = LazyLock::new(Mutex::default);

fn waiting() -> MutexGuard<'static, HashMap<Key, Waiting>> {
    WAITING.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Part {
    owner: u64,
    device_id: String,
    upload: String,
    index: u64,
    last: bool,
    user_data: Option<serde::de::IgnoredAny>,
}

// Claim the part in stdio order. No disk work or whole-file copy holds the read loop.
pub(super) fn receive(mut call: Call) -> Answer {
    let part: Part = match call.params() {
        Ok(part) => part,
        Err(e) => return at_once(Err(e)),
    };
    let key = (part.owner, part.device_id, part.upload);
    let mut held = waiting();
    let previous = held.remove(&key).map(|entry| {
        entry.timer.cancel();
        entry.parts
    });
    if part.index != previous.as_ref().map_or(0, |p| p.next) {
        return at_once(Err(Fault::new(
            "invalid_path",
            "A part of this file arrived out of order; attach it again",
        )));
    }
    if previous.is_none()
        && !part.last
        && held.keys().filter(|k| k.0 == key.0 && k.1 == key.1).count() >= PER_DEVICE
    {
        return at_once(Err(Fault::new(
            "upload_refused",
            "Too many files are on their way from this device; try again later",
        )));
    }
    let mut parts = previous.unwrap_or_default();
    let chunk = call.bin.take().unwrap_or_default();
    parts.size += chunk.len();
    if parts.size > uploads::FILE_MAX_BYTES as usize {
        return at_once(Err(Fault::new("file_too_large", "file too large")));
    }
    // Bound allocation overhead even if a peer sends the file a byte at a time.
    if !chunk.is_empty() {
        if let Some(tail) = parts.chunks.last_mut()
            && tail.len() + chunk.len() <= 4096
        {
            tail.extend_from_slice(&chunk);
        } else {
            parts.chunks.push(chunk);
        }
    }
    if !part.last {
        let size = parts.size;
        parts.next += 1;
        let token = super::next_id();
        let expiring = key.clone();
        let timer = clock::after(IDLE, move || {
            let mut held = waiting();
            if held.get(&expiring).is_some_and(|e| e.token == token) {
                held.remove(&expiring);
            }
        });
        held.insert(
            key,
            Waiting {
                parts,
                timer,
                token,
            },
        );
        return at_once(Reply::json(&json!({"received": size})));
    }
    drop(held);
    if part.user_data.is_none() {
        return at_once(Err(Fault::new(
            "unsupported",
            "This computer does not take attached files",
        )));
    }
    Box::pin(async move {
        call.bin = match parts.chunks.len() {
            0 | 1 => parts.chunks.pop(),
            _ => Some(
                tokio::task::spawn_blocking(move || parts.chunks.concat())
                    .await
                    .map_err(|e| Fault::new("internal", e.to_string()))?,
            ),
        };
        uploads::store(call)
            .await
            .map_err(|error| match error.code.as_ref() {
                "upload_413" => Fault::new("file_too_large", error.message),
                code if code.starts_with("upload_") => Fault::new("upload_refused", error.message),
                _ => error,
            })
    })
}
