//! Calls a hosted session made for an absent device. The committed JSON file is the queue;
//! a rejected keep must not be retried in the background after the session was told to retry it.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use crate::disk::tree::write_atomic;
use crate::server::{Answer, Call, Fault, Registry, Reply, Scope};

const MAX: usize = 200;
const TTL_MS: u64 = 3 * 24 * 60 * 60 * 1_000;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Operation {
    Keep {
        id: String,
        tool_name: String,
        arguments: Map<String, Value>,
    },
    List,
    Settle {
        id: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    file: PathBuf,
    device: String,
    session_path: String,
    #[serde(flatten)]
    op: Operation,
}

pub fn register(registry: &mut Registry) {
    registry.add("remote.keptCalls", ordered);
}

// Reserve in the stdio read loop, not when Tokio first polls the handler. Neither disk I/O
// nor a Windows rename retry holds that loop. A later list sees the preceding settlement.
fn ordered(call: Call) -> Answer {
    static TAIL: Mutex<Option<oneshot::Receiver<()>>> = Mutex::new(None);
    let (done, next) = oneshot::channel();
    let previous = TAIL.lock().unwrap_or_else(|e| e.into_inner()).replace(next);
    Box::pin(async move {
        if let Some(previous) = previous {
            let _ = previous.await;
        }
        tokio::task::spawn_blocking(move || {
            let _done = done;
            run(call.params()?, crate::clock::now_ms(), &call.scope)
        })
        .await
        .map_err(|e| Fault::new("internal", e.to_string()))?
    })
}

fn run(request: Request, now: u64, scope: &Scope) -> Result<Reply, Fault> {
    let Request {
        file,
        device,
        session_path,
        op,
    } = request;
    let mut rows: Vec<Value> = match std::fs::read(&file) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(Fault::new("io", e.to_string())),
    };
    let oldest = now.saturating_sub(TTL_MS) as f64;
    rows.retain(|row| {
        row["at"].as_f64().is_some_and(|at| at >= oldest)
            && row["id"].is_string()
            && row["device"].is_string()
            && row["sessionPath"].is_string()
            && row["toolName"].is_string()
            && (row["arguments"].is_object() || row["arguments"].is_array())
    });
    let belongs = |row: &Value| row["device"] == device && row["sessionPath"] == session_path;
    match op {
        Operation::List => {
            rows.retain(belongs);
            return Reply::json(&rows);
        }
        Operation::Keep {
            id,
            tool_name,
            arguments,
        } => {
            rows.retain(|row| !(belongs(row) && row["id"] == id));
            rows.push(json!({
                "device": device,
                "sessionPath": session_path,
                "id": id,
                "toolName": tool_name,
                "arguments": arguments,
                "at": now,
            }));
            rows.drain(..rows.len().saturating_sub(MAX));
        }
        Operation::Settle { id } => {
            let before = rows.len();
            rows.retain(|row| !(belongs(row) && row["id"] == id));
            if rows.len() == before {
                return Reply::json(&());
            }
        }
    }
    let bytes = serde_json::to_vec(&rows).map_err(|e| Fault::new("internal", e.to_string()))?;
    if !write_atomic(&file, &bytes, 0o600, 0o700, scope)? {
        return Err(Fault::cancelled());
    }
    Reply::json(&())
}
