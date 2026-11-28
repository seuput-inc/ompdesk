//! The command entry (unit 9a, H(c)): the channels of the page's `invoke`/`send` the core serves itself. The Tauri
//! shell (`crates/tauri-shell/src/core_ipc.rs`) hands `IPC_POLICY` and `<userData>` once per core (`ipc.start`) and
//! sends every call of a channel listed in `channels.json` here over its `client: "shell"` connection (`ipc.call`):
//! desktop page calls directly from `omp_ipc`, and main's own callers (paired pages, agents) through the shell's
//! `ipc.call`, keeping one writer per lane.
//!
//! The table names channels and their handlers, nothing else: a channel's direction and web permission are
//! `IPC_POLICY`'s (`src/main/web/ipc-policy.ts`, typed over the channel union), which the shell hands over as data in
//! `ipc.start`. A channel served here that the policy does not list as `invoke` or `send` refuses the start.
//!
//! Order: a page's calls reach a handler in the order the page made them, as Electron runs them. Each caller (a
//! window's page, a paired page's connection) has a lane that takes its calls in the order their lines came (the
//! server calls `ipc.call`'s handler before it reads the next line). A `send` runs to its end before the lane takes
//! the next call; an `invoke` is started (its handler called) in turn and then answers on its own, as an async
//! Electron handler does.
//!
//! The web permission check of a paired page's call stays in main's `ws-router.ts` until the web router moves (8c).

use std::collections::HashMap;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{LazyLock, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::server::{Answer, Call, Fault, Registry, Reply};

pub fn register(registry: &mut Registry) {
    // Taken in the read loop, as `ipc.call` is: a call whose line follows the start's finds the table.
    registry.add("ipc.start", |call| {
        let started = start(&call);
        Box::pin(async move { started })
    });
    registry.add("ipc.call", enqueue);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Dir {
    Invoke,
    Send,
}

/// Who made a call, as the shell describes it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Caller {
    /// One per page that calls (`w<webContents id>`, `c<connId>`): the lane its calls are ordered in.
    pub key: String,
    /// The calling window's routing id; null when the page has none.
    #[allow(dead_code)]
    pub window: Option<i64>,
    /// A paired page's connection.
    #[allow(dead_code)]
    pub conn_id: Option<String>,
    /// A paired web device's id; None for this computer's own desktop windows.
    #[serde(default)]
    pub device_id: Option<String>,
}

/// What a core IPC channel handler receives alongside its JSON arguments.
#[derive(Clone, Debug)]
pub struct IpcContext {
    pub caller: Caller,
    /// `<userData>`, passed by the shell in `ipc.start` for user-scoped stores.
    pub user_data: Option<PathBuf>,
}

/// `Some(value)` serializes as `{"value": value}` (preserving JSON `null`), while `None` omits `"value"` so JS
/// receives `undefined` (matching a `void` or missing-key Electron handler).
pub(crate) type Handled = Pin<Box<dyn Future<Output = Result<Option<Value>, Fault>> + Send>>;
type ChannelHandler = fn(IpcContext, Vec<Value>) -> Handled;

struct Owned {
    channel: &'static str,
    handler: ChannelHandler,
}

/// The channels the core serves. Must match `channels.json` 1-to-1 (pinned by `channels_json_matches_owned`).
const OWNED: &[Owned] = &[
    Owned {
        channel: "ai-memory:cancel-handoff",
        handler: crate::aimemory::ipc::ipc_cancel_handoff,
    },
    Owned {
        channel: "ai-memory:care",
        handler: crate::aimemory::ipc::ipc_care,
    },
    Owned {
        channel: "ai-memory:care-undo",
        handler: crate::aimemory::ipc::ipc_care_undo,
    },
    Owned {
        channel: "ai-memory:delete-page",
        handler: crate::aimemory::ipc::ipc_delete_page,
    },
    Owned {
        channel: "ai-memory:feedback",
        handler: crate::aimemory::ipc::ipc_feedback,
    },
    Owned {
        channel: "ai-memory:get-state",
        handler: crate::aimemory::ipc::ipc_get_state,
    },
    Owned {
        channel: "ai-memory:handoffs",
        handler: crate::aimemory::ipc::ipc_handoffs,
    },
    Owned {
        channel: "ai-memory:lint",
        handler: crate::aimemory::ipc::ipc_lint,
    },
    Owned {
        channel: "ai-memory:observations",
        handler: crate::aimemory::ipc::ipc_observations,
    },
    Owned {
        channel: "ai-memory:overview",
        handler: crate::aimemory::ipc::ipc_overview,
    },
    Owned {
        channel: "ai-memory:pages",
        handler: crate::aimemory::ipc::ipc_pages,
    },
    Owned {
        channel: "ai-memory:profile",
        handler: crate::aimemory::ipc::ipc_profile,
    },
    Owned {
        channel: "ai-memory:projects",
        handler: crate::aimemory::ipc::ipc_projects,
    },
    Owned {
        channel: "ai-memory:purge",
        handler: crate::aimemory::ipc::ipc_purge,
    },
    Owned {
        channel: "ai-memory:read-page",
        handler: crate::aimemory::ipc::ipc_read_page,
    },
    Owned {
        channel: "ai-memory:recent",
        handler: crate::aimemory::ipc::ipc_recent,
    },
    Owned {
        channel: "ai-memory:restore-page",
        handler: crate::aimemory::ipc::ipc_restore_page,
    },
    Owned {
        channel: "ai-memory:retry",
        handler: crate::aimemory::ipc::ipc_retry,
    },
    Owned {
        channel: "ai-memory:search",
        handler: crate::aimemory::ipc::ipc_search,
    },
    Owned {
        channel: "ai-memory:sessions",
        handler: crate::aimemory::ipc::ipc_sessions,
    },
    Owned {
        channel: "ai-memory:set-terminal",
        handler: crate::aimemory::ipc::ipc_set_terminal,
    },
    Owned {
        channel: "ai-memory:sweep",
        handler: crate::aimemory::ipc::ipc_sweep,
    },
    Owned {
        channel: "ai-memory:write-page",
        handler: crate::aimemory::ipc::ipc_write_page,
    },
    Owned {
        channel: "cli-update:get-state",
        handler: crate::tools::ipc::ipc_cli_update_get_state,
    },
    Owned {
        channel: "cli-update:now",
        handler: crate::tools::ipc::ipc_cli_update_now,
    },
    Owned {
        channel: "connectivity:report",
        handler: crate::resume::ipc_connectivity_report,
    },
    Owned {
        channel: "draft-pictures:put",
        handler: crate::draft_pictures::ipc_put,
    },
    Owned {
        channel: "draft-pictures:read",
        handler: crate::draft_pictures::ipc_read,
    },
    Owned {
        channel: "draft-pictures:remove",
        handler: crate::draft_pictures::ipc_remove,
    },
    Owned {
        channel: "extension-update:get-state",
        handler: crate::tools::ipc::ipc_extension_update_get_state,
    },
    Owned {
        channel: "extension-update:now",
        handler: crate::tools::ipc::ipc_extension_update_now,
    },
    Owned {
        channel: "log:snapshot",
        handler: crate::logs::ipc_snapshot,
    },
    Owned {
        channel: "omp-update:get-state",
        handler: crate::tools::ipc::ipc_omp_update_get_state,
    },
    Owned {
        channel: "omp-update:now",
        handler: crate::tools::ipc::ipc_omp_update_now,
    },
    Owned {
        channel: "preview:device",
        handler: crate::emulator::ipc_device,
    },
    Owned {
        channel: "preview:history",
        handler: crate::browsing::ipc_history,
    },
    Owned {
        channel: "preview:visuals",
        handler: crate::visuals::ipc_visuals,
    },
    Owned {
        channel: "project-origin:get",
        handler: crate::git::project::ipc_project_origin_get,
    },
    Owned {
        channel: "resume:cancel-wait",
        handler: crate::resume::ipc_cancel_wait,
    },
    Owned {
        channel: "resume:continue",
        handler: crate::resume::ipc_continue,
    },
    Owned {
        channel: "resume:dismiss",
        handler: crate::resume::ipc_dismiss,
    },
    Owned {
        channel: "resume:stop",
        handler: crate::resume::ipc_stop,
    },
    Owned {
        channel: "setup:cancel",
        handler: crate::tools::ipc::ipc_setup_cancel,
    },
    Owned {
        channel: "setup:get-state",
        handler: crate::tools::ipc::ipc_setup_get_state,
    },
    Owned {
        channel: "setup:retry",
        handler: crate::tools::ipc::ipc_setup_retry,
    },
    Owned {
        channel: "ssh-tools:prompts",
        handler: crate::ssh::ipc_prompts,
    },
];

/// Plumbing channels for main's tests (as `core.echo` is the wire's), served only when `ipc.start` asks for them.
const TEST_OWNED: &[Owned] = &[
    Owned {
        channel: "test:ipc.record",
        handler: |ctx, args| Box::pin(record(ctx.caller, args)),
    },
    Owned {
        channel: "test:ipc.recorded",
        handler: |ctx, _| Box::pin(recorded(ctx.caller)),
    },
];

struct Entry {
    dir: Dir,
    handler: ChannelHandler,
}

struct Item {
    dir: Dir,
    handler: ChannelHandler,
    ctx: IpcContext,
    args: Vec<Value>,
    reply: oneshot::Sender<Result<Option<Value>, Fault>>,
}

#[derive(Default)]
struct State {
    /// None until `ipc.start`: a core started again has no table until the shell hands it the policy again.
    table: Option<HashMap<&'static str, Entry>>,
    user_data: Option<PathBuf>,
    lanes: HashMap<String, mpsc::UnboundedSender<Item>>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Mutex::default);

fn state() -> MutexGuard<'static, State> {
    STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Deserialize)]
struct PolicyEntry {
    dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartParams {
    /// `IPC_POLICY` as main has it.
    policy: HashMap<String, PolicyEntry>,
    /// `<userData>` path for user-scoped stores owned by the core.
    #[serde(default)]
    user_data: Option<String>,
    #[serde(default)]
    test_channels: bool,
}

#[derive(Serialize)]
struct Served {
    channel: &'static str,
    dir: Dir,
}

#[derive(Serialize)]
struct StartResult {
    channels: Vec<Served>,
}

fn table_of(
    policy: &HashMap<String, PolicyEntry>,
    owned: impl Iterator<Item = &'static Owned>,
) -> Result<HashMap<&'static str, Entry>, Fault> {
    let mut table = HashMap::new();
    for owned in owned {
        let dir = match policy.get(owned.channel).map(|entry| entry.dir.as_str()) {
            Some("invoke") => Dir::Invoke,
            Some("send") => Dir::Send,
            _ => {
                return Err(Fault::new(
                    "ipc_policy_missing",
                    format!(
                        "{} is served by ompdesk-core but IPC_POLICY lists it as no invoke or send channel",
                        owned.channel
                    ),
                ));
            }
        };
        table.insert(
            owned.channel,
            Entry {
                dir,
                handler: owned.handler,
            },
        );
    }
    Ok(table)
}

fn start(call: &Call) -> Result<Reply, Fault> {
    let params: StartParams = call.params()?;
    let tests = if params.test_channels {
        TEST_OWNED
    } else {
        &[]
    };
    let table = table_of(&params.policy, OWNED.iter().chain(tests))?;
    let mut channels: Vec<Served> = table
        .iter()
        .map(|(channel, entry)| Served {
            channel,
            dir: entry.dir,
        })
        .collect();
    channels.sort_by_key(|served| served.channel);
    let mut guard = state();
    guard.table = Some(table);
    if let Some(dir) = params
        .user_data
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
    {
        guard.user_data = Some(dir);
    }
    Reply::json(&StartResult { channels })
}

#[derive(Deserialize)]
struct CallParams {
    caller: Caller,
    channel: String,
    dir: Dir,
    #[serde(default)]
    args: Vec<Value>,
}

#[derive(Serialize)]
struct CallResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
}

/// `ipc.call`: takes the call's place in its caller's lane now, before the server reads the next line.
fn enqueue(call: Call) -> Answer {
    let placed = place(&call);
    Box::pin(async move {
        let value = placed?
            .await
            .map_err(|_| Fault::new("internal", "The call's lane ended before it answered"))??;
        Reply::json(&CallResult { value })
    })
}

fn place(call: &Call) -> Result<oneshot::Receiver<Result<Option<Value>, Fault>>, Fault> {
    let params: CallParams = call.params()?;
    let mut state = state();
    let Some(table) = &state.table else {
        return Err(Fault::new(
            "ipc_not_started",
            "ompdesk-core has not been handed IPC_POLICY",
        ));
    };
    let Some(entry) = table.get(params.channel.as_str()) else {
        return Err(Fault::new(
            "no_handler",
            format!("No handler registered for '{}'", params.channel),
        ));
    };
    if entry.dir != params.dir {
        let asked = match params.dir {
            Dir::Invoke => "invoke",
            Dir::Send => "send",
        };
        return Err(Fault::new(
            "ipc_direction",
            format!("{} is not a {asked} channel", params.channel),
        ));
    }
    let (reply, answer) = oneshot::channel();
    let key = params.caller.key.clone();
    let item = Item {
        dir: entry.dir,
        handler: entry.handler,
        ctx: IpcContext {
            caller: params.caller,
            user_data: state.user_data.clone(),
        },
        args: params.args,
        reply,
    };
    // Sent under the state's lock: a lane that finds its queue empty under the same lock ends, and the next call
    // makes a new one, so no call is ever left in a lane that already ended.
    let item = match state.lanes.get(&key) {
        Some(lane) => match lane.send(item) {
            Ok(()) => return Ok(answer),
            Err(mpsc::error::SendError(item)) => item,
        },
        None => item,
    };
    let (lane, queue) = mpsc::unbounded_channel();
    let _ = lane.send(item);
    state.lanes.insert(key.clone(), lane);
    tokio::spawn(run_lane(key, queue));
    Ok(answer)
}

async fn run_lane(key: String, mut queue: mpsc::UnboundedReceiver<Item>) {
    loop {
        let item = {
            let mut state = state();
            match queue.try_recv() {
                Ok(item) => item,
                Err(_) => {
                    state.lanes.remove(&key);
                    return;
                }
            }
        };
        let running = (item.handler)(item.ctx, item.args);
        match item.dir {
            Dir::Send => {
                let _ = item.reply.send(running.await);
            }
            Dir::Invoke => {
                let reply = item.reply;
                tokio::spawn(async move {
                    let _ = reply.send(running.await);
                });
            }
        }
    }
}

static RECORDS: LazyLock<Mutex<HashMap<String, Vec<Value>>>> = LazyLock::new(Mutex::default);

fn records() -> MutexGuard<'static, HashMap<String, Vec<Value>>> {
    RECORDS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `test:ipc.record (value, holdMs)`: records `value` for the caller after holding `holdMs`, so a later call of the
/// same caller that overtook it would be recorded first.
async fn record(caller: Caller, args: Vec<Value>) -> Result<Option<Value>, Fault> {
    let hold = args.get(1).and_then(Value::as_u64).unwrap_or(0);
    if hold > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(hold)).await;
    }
    let value = args.into_iter().next().unwrap_or(Value::Null);
    records().entry(caller.key).or_default().push(value);
    Ok(Some(Value::Null))
}

async fn recorded(caller: Caller) -> Result<Option<Value>, Fault> {
    Ok(Some(Value::Array(
        records().get(&caller.key).cloned().unwrap_or_default(),
    )))
}

#[cfg(test)]
pub(crate) static TEST_LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(Default::default);

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Manifest {
        invoke: Vec<String>,
        send: Vec<String>,
    }

    fn policy(entries: &[(&str, &str)]) -> HashMap<String, PolicyEntry> {
        entries
            .iter()
            .map(|(channel, dir)| {
                (
                    channel.to_string(),
                    PolicyEntry {
                        dir: dir.to_string(),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn channels_json_matches_owned() {
        let manifest: Manifest = serde_json::from_str(include_str!("channels.json")).unwrap();
        let mut listed: Vec<&str> = manifest
            .invoke
            .iter()
            .chain(manifest.send.iter())
            .map(String::as_str)
            .collect();
        listed.sort();
        let mut owned: Vec<&str> = OWNED.iter().map(|entry| entry.channel).collect();
        owned.sort();
        assert_eq!(listed, owned);
    }

    #[test]
    fn a_served_channel_takes_its_direction_from_the_policy() {
        let table = table_of(
            &policy(&[("test:ipc.record", "send"), ("test:ipc.recorded", "invoke")]),
            TEST_OWNED.iter(),
        )
        .unwrap();
        assert_eq!(table["test:ipc.record"].dir, Dir::Send);
        assert_eq!(table["test:ipc.recorded"].dir, Dir::Invoke);
    }

    #[test]
    fn a_served_channel_the_policy_does_not_list_refuses_the_start() {
        for dir in [None, Some("push")] {
            let entries: Vec<(&str, &str)> = match dir {
                Some(dir) => vec![("test:ipc.record", dir), ("test:ipc.recorded", "invoke")],
                None => vec![("test:ipc.recorded", "invoke")],
            };
            let fault = table_of(&policy(&entries), TEST_OWNED.iter())
                .err()
                .unwrap();
            assert_eq!(fault.code, "ipc_policy_missing");
            assert!(
                fault.message.starts_with("test:ipc.record "),
                "{}",
                fault.message
            );
        }
    }

    #[tokio::test]
    async fn a_callers_sends_run_in_the_order_its_lines_came() {
        let _guard = TEST_LOCK.lock().await;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let (client, server_io) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server_io);
        let server = tokio::spawn(crate::serve(server_read, server_write, crate::registry()));
        let (client_read, mut client_write) = tokio::io::split(client);
        let mut lines = tokio::io::BufReader::new(client_read);
        let mut policy_map = serde_json::Map::new();
        for owned in OWNED {
            policy_map.insert(
                owned.channel.to_owned(),
                serde_json::json!({"dir": "invoke"}),
            );
        }
        policy_map.insert("test:ipc.record".into(), serde_json::json!({"dir": "send"}));
        policy_map.insert(
            "test:ipc.recorded".into(),
            serde_json::json!({"dir": "invoke"}),
        );
        let policy = Value::Object(policy_map);
        let caller = r#"{"key":"order-test","window":1,"connId":null}"#;
        let input = format!(
            "{{\"id\":1,\"method\":\"ipc.start\",\"params\":{{\"policy\":{policy},\"testChannels\":true}}}}\n\
             {{\"id\":2,\"method\":\"ipc.call\",\"params\":{{\"caller\":{caller},\"channel\":\"test:ipc.record\",\"dir\":\"send\",\"args\":[1,50]}}}}\n\
             {{\"id\":3,\"method\":\"ipc.call\",\"params\":{{\"caller\":{caller},\"channel\":\"test:ipc.record\",\"dir\":\"send\",\"args\":[2,0]}}}}\n\
             {{\"id\":4,\"method\":\"ipc.call\",\"params\":{{\"caller\":{caller},\"channel\":\"test:ipc.recorded\",\"dir\":\"invoke\",\"args\":[]}}}}\n\
             {{\"id\":5,\"method\":\"ipc.call\",\"params\":{{\"caller\":{caller},\"channel\":\"test:ipc.record\",\"dir\":\"invoke\",\"args\":[]}}}}\n"
        );
        client_write.write_all(input.as_bytes()).await.unwrap();
        client_write.shutdown().await.unwrap();
        let mut answers = HashMap::new();
        let mut line = String::new();
        while lines.read_line(&mut line).await.unwrap() > 0 {
            let frame: Value = serde_json::from_str(&line).unwrap();
            if let Some(id) = frame.get("id").and_then(Value::as_u64) {
                answers.insert(id, frame);
            }
            line.clear();
        }
        server.await.unwrap().unwrap();
        assert_eq!(answers[&4]["result"]["value"], serde_json::json!([1, 2]));
        assert_eq!(answers[&5]["error"]["code"], "ipc_direction");
    }
}
