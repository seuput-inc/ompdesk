//! Desktop approvals shared by phone and computer pairing. Install, answer, list and drain run on
//! the wire's read loop; only the visit waiting for its answer runs in a separate task.

use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use super::devices::sanitize_grants;
use crate::clock;
use crate::server::{Answer, Call, Fault, Registry, Reply, at_once};

#[derive(Deserialize, Serialize)]
struct Request {
    id: String,
    grants: Vec<String>,
    #[serde(flatten)]
    details: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Visit {
    host: u64,
    request: Request,
    deadline_ms: u64,
}

struct Pending {
    visit: Visit,
    timer: clock::Timer,
    answer: oneshot::Sender<Value>,
}

static PENDING: Mutex<Vec<Pending>> = Mutex::new(Vec::new());

fn pending() -> MutexGuard<'static, Vec<Pending>> {
    PENDING.lock().unwrap_or_else(|err| err.into_inner())
}

fn take(host: u64, id: &str) -> Option<Pending> {
    let mut entries = pending();
    let index = entries
        .iter()
        .position(|p| p.visit.host == host && p.visit.request.id == id)?;
    let entry = entries.remove(index);
    entry.timer.cancel();
    Some(entry)
}

fn refused(reason: &str) -> Value {
    json!({"approved": false, "reason": reason})
}

fn request(call: Call) -> Answer {
    let visit: Visit = match call.params() {
        Ok(visit) => visit,
        Err(error) => return at_once(Err(error)),
    };
    let host = visit.host;
    let id = visit.request.id.clone();
    let remaining = visit.deadline_ms.saturating_sub(clock::now_ms());
    if remaining == 0 {
        return at_once(Reply::json(&refused("timeout")));
    }
    let (answer, mut answered) = oneshot::channel();
    {
        let mut entries = pending();
        let timer_id = id.clone();
        let timer = clock::after(Duration::from_millis(remaining), move || {
            if let Some(p) = take(host, &timer_id) {
                let _ = p.answer.send(refused("timeout"));
            }
        });
        entries.push(Pending {
            visit,
            timer,
            answer,
        });
    }
    Box::pin(async move {
        let answer = tokio::select! {
            answer = &mut answered => answer,
            () = call.scope.on_cancel() => {
                drop(take(host, &id));
                answered.await
            }
        };
        Reply::json(&answer.unwrap_or_else(|_| refused("declined")))
    })
}

#[derive(Deserialize)]
struct Response {
    host: u64,
    id: String,
    approve: bool,
    grants: Option<Vec<String>>,
}

fn respond(call: Call) -> Result<Reply, Fault> {
    let response: Response = call.params()?;
    let Some(entry) = take(response.host, &response.id) else {
        return Reply::json(&false);
    };
    let expired = clock::now_ms() >= entry.visit.deadline_ms;
    let outcome = if expired {
        refused("timeout")
    } else if response.approve {
        let grants = response
            .grants
            .as_deref()
            .unwrap_or(&entry.visit.request.grants);
        json!({"approved": true, "grants": sanitize_grants(grants)})
    } else {
        refused("declined")
    };
    Reply::json(&(entry.answer.send(outcome).is_ok() && !expired))
}

#[derive(Deserialize)]
struct Host {
    host: u64,
}

fn list(call: Call) -> Result<Reply, Fault> {
    let Host { host } = call.params()?;
    let now = clock::now_ms();
    let entries = pending();
    let requests: Vec<_> = entries
        .iter()
        .filter(|p| p.visit.host == host && now < p.visit.deadline_ms)
        .map(|p| &p.visit.request)
        .collect();
    Reply::json(&requests)
}

pub(super) fn decline_all(host: u64) {
    pending().retain(|p| {
        if p.visit.host != host {
            return true;
        }
        p.timer.cancel();
        false
    });
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("web.pairing.request", request);
    registry.add("web.pairing.respond", |call| at_once(respond(call)));
    registry.add("web.pairing.pending", |call| at_once(list(call)));
}
