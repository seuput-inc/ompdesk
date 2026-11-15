//! The page ⇄ Node relay's shell side. The page (`src/preload/shell.ts`, injected into `index.html`) talks to the
//! shell over `app://ompdesk/__ipc/…` with `fetch`; the scheme handler (`scheme.rs`) hands each request here.
//!
//! - `POST /__ipc/invoke {channel, args}` → `ipc.invoke` to Node → `{value}` or `{error}`.
//! - `POST /__ipc/send {channel, args}` → `ipc.send` event (no answer).
//! - `GET /__ipc/events` → a never-ending response of one JSON line per `wc.send`, in order, per page.
//!   `{"stream":"reset"}` follows retained events when a reader or queue gap makes the page's state uncertain.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use shell_core::wire::WireError;

/// Lines no reader took yet are kept up to this many per page (a reloading page is briefly without a reader).
const MAX_QUEUED: usize = 4096;
const RESET_LINE: &[u8] = b"{\"stream\":\"reset\"}\n";

type Waker = Box<dyn FnOnce() + Send>;
pub type Reader = Arc<()>;

#[derive(Default)]
struct Stream {
    queue: VecDeque<Vec<u8>>,
    offset: usize,
    reset_after: Option<usize>,
    reset_offset: Option<usize>,
    reader: Option<Reader>,
    waiting: Option<Waker>,
}

impl Stream {
    fn is_reader(&self, reader: &Reader) -> bool {
        self.reader.as_ref().is_some_and(|current| Arc::ptr_eq(current, reader))
    }

    fn reset_after_queued(&mut self) {
        self.reset_after = Some(self.queue.len());
    }

    fn push(&mut self, line: Vec<u8>) {
        self.queue.push_back(line);
        if self.queue.len() > MAX_QUEUED {
            let _ = self.queue.remove(usize::from(self.offset != 0));
            self.reset_after_queued();
        }
    }

    fn fill(&mut self, out: &mut [u8]) -> usize {
        let mut written = 0;
        while written < out.len() {
            if self.offset == 0 && self.reset_offset.is_none() && self.reset_after == Some(0) {
                self.reset_after = None;
                self.reset_offset = Some(0);
            }
            if let Some(offset) = self.reset_offset {
                let count = (RESET_LINE.len() - offset).min(out.len() - written);
                out[written..written + count].copy_from_slice(&RESET_LINE[offset..offset + count]);
                written += count;
                self.reset_offset = (offset + count < RESET_LINE.len()).then_some(offset + count);
                continue;
            }
            let Some(line) = self.queue.front() else {
                break;
            };
            let count = (line.len() - self.offset).min(out.len() - written);
            out[written..written + count].copy_from_slice(&line[self.offset..self.offset + count]);
            written += count;
            self.offset += count;
            if self.offset == line.len() {
                let _ = self.queue.pop_front();
                self.offset = 0;
                if let Some(remaining) = &mut self.reset_after {
                    *remaining -= 1;
                }
            }
        }
        written
    }
}

static STREAMS: Mutex<Option<HashMap<u64, Stream>>> = Mutex::new(None);

fn with_streams<R>(f: impl FnOnce(&mut HashMap<u64, Stream>) -> R) -> R {
    f(STREAMS.lock().unwrap().get_or_insert_with(HashMap::new))
}

/// A new resource takes over this page's stream; an older resource can no longer consume its bytes.
pub fn open_reader(wc_id: u64) -> Reader {
    let reader = Arc::new(());
    let waker = with_streams(|streams| {
        let stream = streams.entry(wc_id).or_default();
        if stream.reader.replace(Arc::clone(&reader)).is_some() {
            stream.reset_after_queued();
        }
        stream.waiting.take()
    });
    if let Some(waker) = waker {
        waker();
    }
    reader
}

/// Node's `wc.send`: queue the line, wake the page's parked reader (outside the lock: it calls back into CEF).
pub fn push(wc_id: u64, channel: &str, args: &Value) {
    let mut line = json!({ "channel": channel, "args": args })
        .to_string()
        .into_bytes();
    line.push(b'\n');
    let waker = with_streams(|streams| {
        let stream = streams.entry(wc_id).or_default();
        stream.push(line);
        stream.waiting.take()
    });
    if let Some(waker) = waker {
        waker();
    }
}

/// A reader asks for bytes: `Some(n)` when lines were queued (copied into `out`), else `waker` is parked and runs at
/// the next `push`, where the reader calls `pull`.
pub fn read_or_park(wc_id: u64, reader: &Reader, out: &mut [u8], waker: Waker) -> Option<usize> {
    with_streams(|streams| {
        let Some(stream) = streams.get_mut(&wc_id).filter(|stream| stream.is_reader(reader)) else {
            return Some(0);
        };
        if stream.queue.is_empty() && stream.reset_after.is_none() && stream.reset_offset.is_none() {
            stream.waiting = Some(waker);
            None
        } else {
            Some(stream.fill(out))
        }
    })
}

/// What a woken reader copies.
pub fn pull(wc_id: u64, reader: &Reader, out: &mut [u8]) -> usize {
    with_streams(|streams| {
        streams
            .get_mut(&wc_id)
            .filter(|stream| stream.is_reader(reader))
            .map(|stream| stream.fill(out))
            .unwrap_or(0)
    })
}

/// A reader went away: keep its queued bytes and announce the possible gap after them.
pub fn reader_gone(wc_id: u64, reader: &Reader) {
    with_streams(|streams| {
        if let Some(stream) = streams.get_mut(&wc_id).filter(|stream| stream.is_reader(reader)) {
            stream.reader = None;
            stream.waiting = None;
            stream.reset_after_queued();
        }
    });
}

/// A page is destroyed: its stream goes.
pub fn drop_page(wc_id: u64) {
    with_streams(|streams| {
        streams.remove(&wc_id);
    });
}

/// The invoke response body: `{"value": …}` or `{"error": {code, message}}`.
pub fn invoke_body(result: Result<Value, WireError>) -> Vec<u8> {
    match result {
        Ok(result) => json!({ "value": result.get("value").cloned().unwrap_or(Value::Null) }),
        Err(error) => json!({ "error": { "code": error.code, "message": error.message } }),
    }
    .to_string()
    .into_bytes()
}
