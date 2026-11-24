//! The per-device model limit on the host (was `src/main/remote/peer-quota.ts`, D65; native-rust ledger R-Q): how
//! many model requests (prompts, steers, follow-ups, compactions…) and how many tokens a paired device may spend on
//! this computer's models per day. Both limits are optional; none is the default. Usage counts per local calendar
//! day and rides the device's record, so a restart does not reset it: a paired computer's in `remote-peers.json`
//! (the devices instance's store, `store.rs`), a Mobile web device's in `web-devices.json` (`web/store.rs`).
//!
//! Main reserves a request before it forwards a model command (which commands: `quota-commands.ts`) or starts a
//! benchmark, a model setup run or a saved schedule, and refunds it when that work did not run. A reservation is a
//! synchronous hub call answered from memory under one lock, so N reservations at limit - 1 let exactly one through.
//! A weighted reservation (a benchmark's models × runs) is refused whole when it would take the day past the limit.
//! Tokens come from each assistant `message_end`'s usage (`record`, a call main does not wait for). A turn already
//! running when the limit is crossed finishes; the next request is refused.
//!
//! Counts are written after the answer: a paired computer's by the store's writer thread (`store::save_later`), a web
//! device's by the web store's (`FileDevices::update_quota`), each one write at a time with the changes made
//! meanwhile in the next. A core that crashes loses at most the changes since the last write that finished; one that
//! exits writes them first (`store::flush`).
//!
//! Hub kind `quota`, opened with `{store: "peers"|"web", userData}`. Methods, each with `deviceId`:
//! `reserve {requests}` → `{ok: true, day}` or `{ok: false, refusal: "requests"|"tokens"}`; `refund {day, requests}`
//! (a refund after the day turned over leaves the new day alone); `record {requests?, tokens?}`;
//! `setLimits {limits: {requestsPerDay?, tokensPerDay?}}` → whether the device exists (`{}` removes the limits);
//! `view` → `{limits, usage: {requests, tokens}}` with today's usage, or null for an unknown device.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};

use super::store::{self, Store};
use crate::hub::{Kind, Outcome, params};
use crate::server::Fault;
use crate::web::devices::Patch;
use crate::web::store::FileDevices;

pub const KIND: Kind = Kind {
    name: "quota",
    open,
    call,
    close: |id| {
        locked(&INSTANCES).remove(&id);
    },
};

/// Where a device's `limits` and `usage` are kept.
#[derive(Clone)]
enum Records {
    Peers(Arc<Mutex<Store>>),
    Web(Arc<FileDevices>),
}

static INSTANCES: LazyLock<Mutex<HashMap<u64, Records>>> = LazyLock::new(Mutex::default);
/// Check and count under one lock: every instance's, as the TypeScript's ran in one JavaScript turn.
static COUNTING: Mutex<()> = Mutex::new(());

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Which {
    Peers,
    Web,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Opts {
    store: Which,
    user_data: PathBuf,
}

fn open(id: u64, opts: &RawValue, _: crate::hub::Out) -> Result<(), Fault> {
    let opts: Opts = params(opts)?;
    let records = match opts.store {
        Which::Peers => Records::Peers(store::open(&opts.user_data, store::Kind::Peers)),
        Which::Web => Records::Web(FileDevices::open(&opts.user_data)),
    };
    locked(&INSTANCES).insert(id, records);
    Ok(())
}

/// `{day, requests, tokens}` as stored.
#[derive(Clone, Default)]
struct Usage {
    day: String,
    requests: u64,
    tokens: u64,
}

impl Usage {
    fn from_json(value: Option<&Value>) -> Option<Usage> {
        let value = value?;
        Some(Usage {
            day: value.get("day")?.as_str()?.to_owned(),
            requests: count(value.get("requests")),
            tokens: count(value.get("tokens")),
        })
    }

    fn json(&self) -> Value {
        json!({ "day": self.day, "requests": self.requests, "tokens": self.tokens })
    }
}

fn count(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_f64)
        .map_or(0, |n| n.max(0.0) as u64)
}

/// `{requestsPerDay?, tokensPerDay?}`: whole numbers, as main's payload check (`PeerLimitsPayload`) lets through.
#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    requests_per_day: Option<u64>,
    tokens_per_day: Option<u64>,
}

impl Limits {
    fn json(self) -> Value {
        let mut limits = Map::new();
        if let Some(requests) = self.requests_per_day {
            limits.insert("requestsPerDay".into(), json!(requests));
        }
        if let Some(tokens) = self.tokens_per_day {
            limits.insert("tokensPerDay".into(), json!(tokens));
        }
        Value::Object(limits)
    }
}

/// A device's record as the rules read it.
struct Record {
    limits: Option<Limits>,
    usage: Option<Usage>,
}

impl Records {
    fn get(&self, device_id: &str) -> Option<Record> {
        let (limits, usage) = match self {
            Records::Peers(peers) => {
                let entry = locked(peers).get(device_id)?;
                (entry.get("limits").cloned(), entry.get("usage").cloned())
            }
            Records::Web(devices) => {
                let device = devices.get(device_id)?;
                (device.limits, device.usage)
            }
        };
        Some(Record {
            limits: limits.and_then(|value| serde_json::from_value(value).ok()),
            usage: Usage::from_json(usage.as_ref()),
        })
    }

    /// Replaces `limits` or `usage` (`None` removes it); false when there is no such device.
    fn write(&self, device_id: &str, key: &str, value: Option<Value>) -> bool {
        match self {
            Records::Peers(peers) => {
                let written = locked(peers)
                    .update_kept(device_id, vec![(key.to_owned(), value)])
                    .is_ok_and(|next| next.is_some());
                if written {
                    store::save_later(peers);
                }
                written
            }
            Records::Web(devices) => {
                let patch = match key {
                    "limits" => Patch {
                        limits: Some(value),
                        usage: None,
                    },
                    _ => Patch {
                        limits: None,
                        usage: Some(value),
                    },
                };
                devices.update_quota(device_id, patch)
            }
        }
    }
}

/// `YYYY-MM-DD` of now in this computer's time zone (UTC when the system cannot say; the schedules' day).
fn today() -> String {
    use crate::schedules::rules::Zone;
    let day = crate::schedules::rules::Local.day(crate::clock::now_ms() as i64);
    format!("{}-{:02}-{:02}", day.year, day.month, day.day)
}

/// Today's usage of a record (zero once the stored day is over).
fn used(record: &Record, today: &str) -> (u64, u64) {
    match &record.usage {
        Some(usage) if usage.day == today => (usage.requests, usage.tokens),
        _ => (0, 0),
    }
}

/// Which limit stops `requests` more of this device's model requests today, or none.
fn refusal(records: &Records, device_id: &str, requests: u64) -> Option<&'static str> {
    let record = records.get(device_id)?;
    let limits = record.limits?;
    let (requests_used, tokens_used) = used(&record, &today());
    if limits
        .requests_per_day
        .is_some_and(|limit| requests_used.saturating_add(requests) > limit)
    {
        return Some("requests");
    }
    if limits
        .tokens_per_day
        .is_some_and(|limit| tokens_used >= limit)
    {
        return Some("tokens");
    }
    None
}

fn record(records: &Records, device_id: &str, requests: u64, tokens: u64) {
    let Some(current) = records.get(device_id) else {
        return;
    };
    let day = today();
    let (requests_used, tokens_used) = used(&current, &day);
    let usage = Usage {
        day,
        requests: requests_used + requests,
        tokens: tokens_used + tokens,
    };
    records.write(device_id, "usage", Some(usage.json()));
}

fn reserve(records: &Records, device_id: &str, requests: u64) -> Value {
    if let Some(refusal) = refusal(records, device_id, requests) {
        return json!({ "ok": false, "refusal": refusal });
    }
    let day = today();
    record(records, device_id, requests, 0);
    json!({ "ok": true, "day": day })
}

/// Gives back `requests` of `day`'s count; a refund after the day turned over leaves the new day alone.
fn refund(records: &Records, device_id: &str, day: &str, requests: u64) {
    let Some(Record {
        usage: Some(usage), ..
    }) = records.get(device_id)
    else {
        return;
    };
    if usage.day != day {
        return;
    }
    let usage = Usage {
        requests: usage.requests.saturating_sub(requests),
        ..usage
    };
    records.write(device_id, "usage", Some(usage.json()));
}

fn set_limits(records: &Records, device_id: &str, limits: Limits) -> bool {
    let none = limits.requests_per_day.is_none() && limits.tokens_per_day.is_none();
    records.write(device_id, "limits", (!none).then(|| limits.json()))
}

fn view(records: &Records, device_id: &str) -> Value {
    let Some(record) = records.get(device_id) else {
        return Value::Null;
    };
    let (requests, tokens) = used(&record, &today());
    json!({
        "limits": record.limits.unwrap_or_default().json(),
        "usage": { "requests": requests, "tokens": tokens },
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Args {
    device_id: String,
    #[serde(default)]
    requests: Option<u64>,
    #[serde(default)]
    tokens: Option<u64>,
    #[serde(default)]
    day: Option<String>,
    #[serde(default)]
    limits: Option<Limits>,
}

fn call(id: u64, method: &str, raw: &RawValue) -> Outcome {
    let run = || -> Result<Value, Fault> {
        let records = locked(&INSTANCES)
            .get(&id)
            .cloned()
            .ok_or_else(|| Fault::new("no_instance", "No such quota instance"))?;
        let args: Args = params(raw)?;
        let device = args.device_id.as_str();
        let _counting = locked(&COUNTING);
        Ok(match method {
            "reserve" => reserve(&records, device, args.requests.unwrap_or(1)),
            "refund" => {
                let day = args
                    .day
                    .ok_or_else(|| Fault::new("invalid_params", "a refund names its day"))?;
                refund(&records, device, &day, args.requests.unwrap_or(1));
                Value::Null
            }
            "record" => {
                record(
                    &records,
                    device,
                    args.requests.unwrap_or(0),
                    args.tokens.unwrap_or(0),
                );
                Value::Null
            }
            "setLimits" => json!(set_limits(
                &records,
                device,
                args.limits.unwrap_or_default()
            )),
            "view" => view(&records, device),
            _ => return Err(Fault::new("no_method", format!("quota has no {method}"))),
        })
    };
    Outcome::Now(run())
}

#[cfg(test)]
mod tests;
