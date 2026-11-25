//! One desktop holder per slot. Steps return effects; only main performs them, after retaining the checkpoint.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::{Kind, Out, Outcome, params};
use crate::server::Fault;

pub(super) const KIND: Kind = Kind {
    name: "desktopSlot",
    open,
    call,
    close: |id| {
        SLOTS.with_borrow_mut(|slots| slots.remove(&id));
    },
};

thread_local! {
    static SLOTS: RefCell<HashMap<u64, Slot>> = RefCell::default();
}

const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Timing {
    lease_ms: u64,
    revoke_timeout_ms: u64,
    retry_ms: u64,
}

struct Slot {
    timing: Timing,
    latest_now: u64,
    state: Checkpoint,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    // Only this holder can cause another ID to be issued. Between its lease and the next lease,
    // every ID is one of its revoke attempts, even after a timeout or a reconnect.
    sequence: u64,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    holder: Option<Holder>,
    queue: VecDeque<Waiter>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Waiter {
    tab_id: String,
    requests: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Holder {
    tab_id: String,
    lease: u64,
    since: i64,
    deadline: u64,
    phase: Phase,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
enum Phase {
    Active,
    Revoking { reason: Reason, failed: bool },
    Failed { reason: Reason },
}

impl Phase {
    fn failed(self) -> bool {
        matches!(
            self,
            Self::Failed { .. } | Self::Revoking { failed: true, .. }
        )
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Reason {
    Stop,
    Closed,
    Lease,
}

impl Checkpoint {
    fn valid(&self) -> bool {
        if self.sequence > MAX_SAFE {
            return false;
        }
        let Some(holder) = &self.holder else {
            return self.queue.is_empty();
        };
        if holder.lease == 0
            || holder.lease > self.sequence
            || holder.deadline > MAX_SAFE
            || holder.since.unsigned_abs() > MAX_SAFE
        {
            return false;
        }
        let attempts = self.sequence - holder.lease;
        let valid_phase = match holder.phase {
            Phase::Active => attempts == 0,
            Phase::Revoking { failed, .. } => attempts > 0 && failed == (attempts > 1),
            Phase::Failed { .. } => attempts > 0,
        };
        let mut tabs = HashSet::with_capacity(self.queue.len());
        valid_phase
            && self.queue.iter().all(|waiter| {
                !waiter.requests.is_empty()
                    && tabs.insert(&waiter.tab_id)
                    && !(matches!(holder.phase, Phase::Active) && holder.tab_id == waiter.tab_id)
            })
    }
}

fn open(id: u64, opts: &RawValue, _: Out) -> Result<(), Fault> {
    #[derive(Deserialize)]
    struct Open {
        #[serde(flatten)]
        timing: Timing,
        #[serde(deserialize_with = "Deserialize::deserialize")]
        checkpoint: Option<Checkpoint>,
    }
    let Open { timing, checkpoint } = params(opts)?;
    let longest = timing
        .lease_ms
        .max(timing.revoke_timeout_ms)
        .max(timing.retry_ms);
    let Some(latest_now) = MAX_SAFE.checked_sub(longest) else {
        return Err(Fault::new(
            "invalid_params",
            "Invalid desktop slot durations",
        ));
    };
    let state = checkpoint.unwrap_or_default();
    if !state.valid() {
        return Err(Fault::new(
            "invalid_params",
            "Invalid desktop slot checkpoint",
        ));
    }
    SLOTS.with_borrow_mut(|slots| {
        slots.insert(
            id,
            Slot {
                timing,
                latest_now,
                state,
            },
        )
    });
    Ok(())
}

#[derive(Deserialize)]
struct Step {
    now: u64,
    wall: i64,
    #[serde(flatten)]
    op: Op,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Op {
    Acquire { tab_id: String, request_id: String },
    Touch { tab_id: String },
    Release { tab_id: String },
    Closed { tab_id: String },
    Stop { tab_id: String },
    Crashed { tab_id: String },
    Retry,
    Tick,
    Answered { lease: u64, attempt: u64, ok: bool },
    Killed { lease: u64 },
}

fn call(id: u64, method: &str, args: &RawValue) -> Outcome {
    if method != "step" {
        return Outcome::fault("no_method", method);
    }
    Outcome::Now(params(args).and_then(|step| {
        SLOTS.with_borrow_mut(|slots| {
            slots
                .get_mut(&id)
                .ok_or_else(|| Fault::new("no_instance", format!("No instance {id}")))?
                .step(step)
        })
    }))
}

fn grant(tab_id: &str, request: String, waited: bool) -> Value {
    let mut effect = json!({"kind": "grant", "tabId": tab_id, "waited": waited});
    effect["requestId"] = request.into();
    effect
}

impl Slot {
    fn step(&mut self, Step { now, wall, op }: Step) -> Result<Value, Fault> {
        if now > self.latest_now || wall.unsigned_abs() > MAX_SAFE {
            return Err(Fault::new("invalid_params", "Invalid desktop slot clock"));
        }
        if self.state.sequence == MAX_SAFE {
            return Err(Fault::new(
                "slot_id_exhausted",
                "Desktop slot IDs exhausted",
            ));
        }
        let mut effects = Vec::new();
        let changed = self.apply(op, now, wall, &mut effects);
        let state = &self.state;
        let holder = state.holder.as_ref();
        let mut reply = json!({
            "checkpoint": state,
            "deadline": holder.map(|h| h.deadline),
            "pending": holder.filter(|h| matches!(h.phase, Phase::Revoking { .. })).map(|_| state.sequence),
            "changed": changed,
        });
        reply["holder"] = holder.map_or(Value::Null, |h| {
            json!({"tabId": h.tab_id, "since": h.since, "lease": h.lease, "failed": h.phase.failed()})
        });
        reply["queue"] = Value::Array(
            state
                .queue
                .iter()
                .map(|w| Value::from(w.tab_id.as_str()))
                .collect(),
        );
        reply["effects"] = Value::Array(effects);
        Ok(reply)
    }

    fn apply(&mut self, op: Op, now: u64, wall: i64, effects: &mut Vec<Value>) -> bool {
        let holder = self.state.holder.as_mut();
        match op {
            Op::Acquire { tab_id, request_id } => {
                if let Some(holder) = holder {
                    if holder.tab_id == tab_id && matches!(holder.phase, Phase::Active) {
                        holder.deadline = now + self.timing.lease_ms;
                        effects.push(grant(&tab_id, request_id, false));
                        return false;
                    }
                    if let Some(waiter) = self.state.queue.iter_mut().find(|w| w.tab_id == tab_id) {
                        waiter.requests.push(request_id);
                    } else {
                        self.state.queue.push_back(Waiter {
                            tab_id,
                            requests: vec![request_id],
                        });
                    }
                } else {
                    effects.push(grant(&tab_id, request_id, false));
                    self.hold(tab_id, now, wall);
                }
                true
            }
            Op::Touch { tab_id } => {
                if let Some(h) =
                    holder.filter(|h| h.tab_id == tab_id && matches!(h.phase, Phase::Active))
                {
                    h.deadline = now + self.timing.lease_ms;
                }
                false
            }
            Op::Release { tab_id } => {
                if let Some(h) = holder.filter(|h| h.tab_id == tab_id) {
                    if matches!(h.phase, Phase::Revoking { .. }) {
                        return false;
                    }
                    self.advance(now, wall, effects);
                    true
                } else {
                    self.drop_waiter(&tab_id)
                }
            }
            Op::Closed { tab_id } => {
                let held = holder.is_some_and(|h| h.tab_id == tab_id);
                let removed = self.drop_waiter(&tab_id);
                if held {
                    self.start(Reason::Closed, now, effects);
                }
                removed
            }
            Op::Stop { tab_id } => {
                if holder.is_some_and(|h| h.tab_id == tab_id) {
                    self.start(Reason::Stop, now, effects);
                    false
                } else if self.drop_waiter(&tab_id) {
                    effects.push(json!({"kind":"stopWaiter", "tabId":tab_id}));
                    true
                } else {
                    false
                }
            }
            Op::Crashed { tab_id } => {
                let held = holder.is_some_and(|h| h.tab_id == tab_id);
                let removed = self.drop_waiter(&tab_id);
                if held {
                    self.advance(now, wall, effects);
                }
                held || removed
            }
            Op::Killed { lease } => {
                if let Some(h) = holder.filter(|h| h.lease == lease) {
                    self.state.queue.retain(|w| w.tab_id != h.tab_id);
                    self.advance(now, wall, effects);
                    true
                } else {
                    false
                }
            }
            Op::Retry => {
                if let Some(Phase::Failed { reason }) = holder.map(|h| h.phase) {
                    self.start(reason, now, effects);
                }
                false
            }
            Op::Tick => {
                let Some(h) = holder.filter(|h| h.deadline <= now) else {
                    return false;
                };
                let reason = match h.phase {
                    Phase::Active => Reason::Lease,
                    Phase::Revoking { reason, .. } => {
                        h.phase = Phase::Failed { reason };
                        h.deadline = now + self.timing.retry_ms;
                        return true;
                    }
                    Phase::Failed { reason } => reason,
                };
                self.start(reason, now, effects);
                false
            }
            Op::Answered { lease, attempt, ok } => {
                let Some(h) = holder.filter(|h| h.lease == lease) else {
                    return false;
                };
                if !(lease < attempt && attempt <= self.state.sequence) {
                    return false;
                }
                if ok {
                    self.advance(now, wall, effects);
                    return true;
                }
                if let Phase::Revoking { reason, .. } = h.phase
                    && attempt == self.state.sequence
                {
                    h.phase = Phase::Failed { reason };
                    h.deadline = now + self.timing.retry_ms;
                    return true;
                }
                false
            }
        }
    }

    fn start(&mut self, reason: Reason, now: u64, effects: &mut Vec<Value>) {
        let Some(h) = &mut self.state.holder else {
            return;
        };
        if matches!(h.phase, Phase::Revoking { .. }) {
            return;
        }
        self.state.sequence += 1;
        h.phase = Phase::Revoking {
            reason,
            failed: h.phase.failed(),
        };
        h.deadline = now + self.timing.revoke_timeout_ms;
        effects.push(json!({
            "kind":"revoke", "tabId":h.tab_id, "reason":reason, "lease":h.lease, "attempt":self.state.sequence
        }));
    }

    fn hold(&mut self, tab_id: String, now: u64, wall: i64) {
        self.state.sequence += 1;
        self.state.holder = Some(Holder {
            tab_id,
            lease: self.state.sequence,
            since: wall,
            deadline: now + self.timing.lease_ms,
            phase: Phase::Active,
        });
    }

    fn advance(&mut self, now: u64, wall: i64, effects: &mut Vec<Value>) {
        if let Some(Waiter { tab_id, requests }) = self.state.queue.pop_front() {
            effects.extend(requests.into_iter().map(|id| grant(&tab_id, id, true)));
            self.hold(tab_id, now, wall);
        } else {
            self.state.holder = None;
        }
    }

    fn drop_waiter(&mut self, tab_id: &str) -> bool {
        let Some(index) = self.state.queue.iter().position(|w| w.tab_id == tab_id) else {
            return false;
        };
        self.state.queue.remove(index);
        true
    }
}

#[cfg(test)]
mod tests;
