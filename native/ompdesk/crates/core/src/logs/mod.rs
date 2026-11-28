//! One nonrecursive directory watch per Logs feed. Its worker owns the file cursors, ring and batch sequence.

mod checkpoint;
mod tail;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError, mpsc};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::ipc::{Handled, IpcContext};
use crate::server::{Answer, Call, Events, Fault, Registry, Reply};
use checkpoint::{Changes, Checkpoint};
use tail::{Batch, Tail};

const POLL: Duration = Duration::from_secs(15);
const FLUSH: Duration = Duration::from_millis(150);

type Respond = oneshot::Sender<Result<Reply, Fault>>;
type RespondValue = oneshot::Sender<Result<Value, Fault>>;

enum Input {
    Changed(notify::Result<Event>),
    Ready(Respond),
    Snapshot(Respond),
    SnapshotValue(RespondValue),
    Close(Option<Respond>),
}

struct Feed {
    owner: Events,
    input: mpsc::Sender<Input>,
}

fn feeds() -> MutexGuard<'static, HashMap<u64, Feed>> {
    static FEEDS: LazyLock<Mutex<HashMap<u64, Feed>>> = LazyLock::new(Default::default);
    FEEDS.lock().unwrap_or_else(PoisonError::into_inner)
}

fn active_watcher() -> MutexGuard<'static, Option<u64>> {
    static ACTIVE: LazyLock<Mutex<Option<u64>>> = LazyLock::new(Default::default);
    ACTIVE.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Open {
    watcher: u64,
    root: PathBuf,
    next_sequence: u64,
    checkpoint: Option<Checkpoint>,
}

#[derive(Deserialize)]
struct Id {
    watcher: u64,
}

#[derive(Serialize)]
struct Lines<'a> {
    watcher: u64,
    batch: Batch<'a>,
    changes: &'a Changes,
    retained: usize,
}

// Enqueue before the next request is read. The worker answers after the initial listing, snapshot or final flush.
fn ask(send: impl FnOnce(Respond) -> Result<(), Fault>) -> Answer {
    let (tx, rx) = oneshot::channel();
    let sent = send(tx);
    Box::pin(async move {
        sent?;
        rx.await.map_err(|_| closed())?
    })
}

fn closed() -> Fault {
    Fault::new("logs_closed", "The log watcher is closed")
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("logs.start", |call| ask(|reply| start(call, reply)));
    registry.add("logs.snapshot", |call| {
        ask(|reply| {
            let id: Id = call.params()?;
            feeds()
                .get(&id.watcher)
                .filter(|feed| !feed.owner.reaches_another(&call.events))
                .ok_or_else(closed)?
                .input
                .send(Input::Snapshot(reply))
                .map_err(|_| closed())
        })
    });
    registry.add("logs.close", |call| {
        ask(|reply| {
            let id: Id = call.params()?;
            let mut feeds = feeds();
            if feeds
                .get(&id.watcher)
                .is_some_and(|feed| !feed.owner.reaches_another(&call.events))
                && let Some(feed) = feeds.remove(&id.watcher)
            {
                let mut active = active_watcher();
                if *active == Some(id.watcher) {
                    *active = feeds.keys().max().copied();
                }
                feed.input
                    .send(Input::Close(Some(reply)))
                    .map_err(|_| closed())?;
            } else {
                let _ = reply.send(Reply::json(&()));
            }
            Ok(())
        })
    });
}

pub(super) fn close_all(events: &Events) {
    let mut feeds = feeds();
    feeds.retain(|_, feed| {
        if feed.owner.reaches_another(events) {
            return true;
        }
        let _ = feed.input.send(Input::Close(None));
        false
    });
    let mut active = active_watcher();
    if active.is_some_and(|id| !feeds.contains_key(&id)) {
        *active = feeds.keys().max().copied();
    }
}

/// Direct core IPC `log:snapshot`: reads the active `LogWatcher` feed's snapshot, or an empty batch before start.
pub(crate) fn ipc_snapshot(_ctx: IpcContext, _args: Vec<Value>) -> Handled {
    Box::pin(async move {
        let input = {
            let feeds = feeds();
            let active = *active_watcher();
            active
                .and_then(|id| feeds.get(&id))
                .or_else(|| feeds.iter().max_by_key(|(id, _)| *id).map(|(_, feed)| feed))
                .map(|feed| feed.input.clone())
        };
        let Some(input) = input else {
            return Ok(Some(json!({ "lines": [], "nextSequence": 0 })));
        };
        let (tx, rx) = oneshot::channel();
        if input.send(Input::SnapshotValue(tx)).is_err() {
            return Ok(Some(json!({ "lines": [], "nextSequence": 0 })));
        }
        match rx.await {
            Ok(Ok(batch)) => Ok(Some(batch)),
            Ok(Err(fault)) => Err(fault),
            Err(_) => Ok(Some(json!({ "lines": [], "nextSequence": 0 }))),
        }
    })
}

fn start(call: Call, reply: Respond) -> Result<(), Fault> {
    let mut open: Open = call.params()?;
    if !open.root.is_absolute() {
        return Err(Fault::new(
            "invalid_params",
            "The log directory must be absolute",
        ));
    }
    let mut feeds = feeds();
    let id = open.watcher;
    if let Some(feed) = feeds.get(&id) {
        if feed.owner.reaches_another(&call.events) {
            return Err(Fault::new(
                "invalid_params",
                "Log watcher id already in use",
            ));
        }
        return feed.input.send(Input::Ready(reply)).map_err(|_| closed());
    }
    let initial = open.checkpoint.is_none();
    let mut tail = Tail::new(open.next_sequence);
    if let Some(saved) = open.checkpoint.take() {
        tail.restore(&open.root, saved)?;
    }
    let (input, rx) = mpsc::channel();
    let feed = Feed {
        owner: call.events.clone(),
        input: input.clone(),
    };
    std::thread::Builder::new()
        .name("log tail".into())
        .spawn(move || run(open, tail, initial, call.events, input, rx, reply))
        .map_err(|error| Fault::new("logs_start", error.to_string()))?;
    feeds.insert(id, feed);
    *active_watcher() = Some(id);
    Ok(())
}

fn watch(root: &Path, input: &mpsc::Sender<Input>) -> Option<(tail::Identity, RecommendedWatcher)> {
    let (_, id) = tail::stat(root, true).ok()?;
    let input = input.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        // Linux also names reads. Reading a log must not wake its own tail.
        if !matches!(&event, Ok(event) if matches!(event.kind, EventKind::Access(_)) && !event.need_rescan()) {
            let _ = input.send(Input::Changed(event));
        }
    }).ok()?;
    watcher.watch(root, RecursiveMode::NonRecursive).ok()?;
    Some((id, watcher))
}

fn run(
    open: Open,
    mut tail: Tail,
    initial: bool,
    events: Events,
    tx: mpsc::Sender<Input>,
    rx: mpsc::Receiver<Input>,
    ready: Respond,
) {
    let root = &open.root;
    let emit = |batch: Batch<'_>, changes: &Changes, retained| {
        events.send(
            "logs.lines",
            &Lines {
                watcher: open.watcher,
                batch,
                changes,
                retained,
            },
        );
    };
    enum SnapshotReply {
        Reply(Respond),
        Value(RespondValue),
    }
    let publish = |tail: &mut Tail, snapshots: &mut Vec<SnapshotReply>| {
        tail.flush(emit);
        let snapshot = tail.snapshot();
        for reply in snapshots.drain(..) {
            match reply {
                SnapshotReply::Reply(tx) => {
                    let _ = tx.send(Reply::json(&snapshot));
                }
                SnapshotReply::Value(tx) => {
                    let _ = tx.send(
                        serde_json::to_value(&snapshot)
                            .map_err(|error| Fault::new("internal", error.to_string())),
                    );
                }
            }
        }
    };
    let mut snapshots = Vec::new();
    let mut source = watch(root, &tx);
    let _ = tail.list(root, initial);
    publish(&mut tail, &mut snapshots);
    let _ = ready.send(Reply::json(&()));
    let mut poll = Instant::now() + POLL;
    let mut flush = None;
    loop {
        let now = Instant::now();
        if now >= poll {
            // Some backends silently detach when a watched directory is replaced.
            let current = tail::stat(root, true).ok().map(|(_, id)| id);
            if source.as_ref().is_none_or(|(id, _)| Some(*id) != current) {
                source = watch(root, &tx);
            }
            if tail.list(root, false).is_err() {
                source = None;
            }
            poll = Instant::now() + POLL;
        }
        if tail.has_pending() && now >= *flush.get_or_insert(now + FLUSH) {
            publish(&mut tail, &mut snapshots);
            flush = None;
        }
        let until = flush.map_or(poll, |flush: Instant| flush.min(poll));
        match rx.recv_timeout(until.saturating_duration_since(Instant::now())) {
            Ok(Input::Changed(Ok(event))) if !event.need_rescan() && !event.paths.is_empty() => {
                for path in &event.paths {
                    if tail::log_name(path)
                        && let Some(name) = path.file_name()
                    {
                        // Use the watched directory, not an absolute path supplied by a backend.
                        tail.read(root.join(name));
                    }
                }
            }
            Ok(Input::Changed(event)) => {
                if event.is_err() {
                    source = None;
                }
                poll = Instant::now();
            }
            Ok(Input::Ready(reply)) => {
                let _ = reply.send(Reply::json(&()));
            }
            // A snapshot cannot expose lines whose recovery marks main has not received yet.
            Ok(Input::Snapshot(reply)) if tail.has_pending() => {
                snapshots.push(SnapshotReply::Reply(reply))
            }
            Ok(Input::Snapshot(reply)) => {
                let _ = reply.send(Reply::json(&tail.snapshot()));
            }
            Ok(Input::SnapshotValue(reply)) if tail.has_pending() => {
                snapshots.push(SnapshotReply::Value(reply))
            }
            Ok(Input::SnapshotValue(reply)) => {
                let _ = reply.send(
                    serde_json::to_value(tail.snapshot())
                        .map_err(|error| Fault::new("internal", error.to_string())),
                );
            }
            Ok(Input::Close(reply)) => {
                drop(source);
                publish(&mut tail, &mut snapshots);
                if let Some(reply) = reply {
                    let _ = reply.send(Reply::json(&()));
                }
                return;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::Caller;
    use crate::server::Scope;

    #[tokio::test]
    async fn ipc_snapshot_returns_empty_before_start_and_live_batch_when_running() {
        let ctx = || IpcContext {
            caller: Caller {
                key: "w1".into(),
                window: Some(1),
                conn_id: None,
                device_id: None,
            },
            user_data: None,
        };

        let empty = ipc_snapshot(ctx(), vec![]).await.unwrap().unwrap();
        assert_eq!(empty, json!({ "lines": [], "nextSequence": 0 }));

        let dir = tempfile::tempdir().unwrap();
        let (events, _sender, _frames) = Events::capture();
        let (tx, rx) = oneshot::channel();
        let params = json!({
            "watcher": 99_001,
            "root": dir.path(),
            "nextSequence": 1,
            "checkpoint": { "files": {}, "lines": ["hello log"] }
        });
        start(
            Call {
                params: serde_json::value::to_raw_value(&params).unwrap(),
                scope: Scope::detached(),
                bin: None,
                events: events.clone(),
            },
            tx,
        )
        .unwrap();
        rx.await.unwrap().unwrap();

        let snap = ipc_snapshot(ctx(), vec![]).await.unwrap().unwrap();
        assert_eq!(snap["lines"], json!(["hello log"]));
        assert_eq!(snap["nextSequence"], 1);

        close_all(&events);
        // After closing the active watcher, snapshot falls back to empty again.
        let after = ipc_snapshot(ctx(), vec![]).await.unwrap().unwrap();
        assert_eq!(after, json!({ "lines": [], "nextSequence": 0 }));
    }
}
