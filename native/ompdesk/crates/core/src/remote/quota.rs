//! Host-side quota for a paired computer or web device. Limits stay on the pairing record. A locked device file
//! commits a reservation and its weighted daily count before main may dispatch; the JSON writer only projects
//! committed usage for the existing device lists. Old device files seed the ledger on the first change.
//!
//! `reserve {deviceId, requests, reservationId, attemptId}`: the same hub attempt can recover a lost answer;
//! a new dispatch attempt with the same logical ID is refused, even after midnight or a refund. Only the host
//! makes an attempt ID. Weight zero records schedule ingress without spending requests or checking daily limits.
//! `refund {deviceId, reservationId}` releases the stored charge once. `record`, `view` and `setLimits` are unchanged.

mod ledger;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

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

struct Quota {
    records: Records,
    path: PathBuf,
}

enum Records {
    Peers(Arc<Mutex<Store>>),
    Web(Arc<FileDevices>),
}

static INSTANCES: LazyLock<Mutex<HashMap<u64, Arc<Quota>>>> = LazyLock::new(Mutex::default);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Which {
    Peers,
    Web,
}

impl Which {
    fn file(self) -> &'static str {
        match self {
            Self::Peers => "remote-quota",
            Self::Web => "web-quota",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Opts {
    store: Which,
    user_data: PathBuf,
}

fn open(id: u64, opts: &RawValue, _: crate::hub::Out) -> Result<(), Fault> {
    let opts: Opts = params(opts)?;
    locked(&INSTANCES).insert(id, Arc::new(Quota::new(opts.store, &opts.user_data)));
    Ok(())
}

/// `{day, requests, tokens}` as stored.
#[derive(Debug)]
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
    pairing: f64,
    limits: Limits,
    usage: Option<Usage>,
}

impl Record {
    fn new(pairing: f64, limits: Option<&Value>, usage: Option<&Value>) -> Self {
        Self {
            pairing,
            limits: limits
                .and_then(|v| Limits::deserialize(v).ok())
                .unwrap_or_default(),
            usage: Usage::from_json(usage),
        }
    }
}

impl Quota {
    fn new(which: Which, dir: &Path) -> Self {
        let records = match which {
            Which::Peers => Records::Peers(store::open(dir, store::Kind::Peers)),
            Which::Web => Records::Web(FileDevices::open(dir)),
        };
        Self {
            records,
            path: dir.join(which.file()),
        }
    }

    fn run(&self, device: &str, action: Action<'_>, day: &str) -> Result<Value, Fault> {
        let apply = |pairing, limits: Option<&Value>, usage: Option<&Value>| {
            if let Action::SetLimits(new) = action {
                let none = new.requests_per_day.is_none() && new.tokens_per_day.is_none();
                return Ok((
                    json!(true),
                    Patch {
                        limits: Some((!none).then(|| new.json())),
                        usage: None,
                    },
                ));
            }
            let record = Record::new(pairing, limits, usage);
            ledger::apply(&ledger_path(&self.path, device), record, action, day)
        };
        let result = match &self.records {
            Records::Peers(peers) => {
                let result = locked(peers).edit_quota(device, apply)?;
                if result.as_ref().is_some_and(|(_, changed)| *changed) {
                    store::save_later(peers);
                }
                result.map(|(answer, _)| answer)
            }
            Records::Web(devices) => devices.edit_quota(device, apply)?,
        };
        match (result, action) {
            (Some(answer), _) => Ok(answer),
            (None, Action::Reserve { .. }) => {
                Err(Fault::new("unknown_device", "Device is not paired"))
            }
            (None, Action::SetLimits(_)) => Ok(Value::Bool(false)),
            (None, _) => Ok(Value::Null),
        }
    }
}

/// A device id is not a file name, even on a case-insensitive file system.
fn ledger_path(dir: &Path, device: &str) -> PathBuf {
    dir.join(crate::hex(&Sha256::digest(device.as_bytes())))
        .with_extension("json")
}

/// Recover the public projection when the core stopped after committing the private ledger.
pub(crate) fn restore_usage(file: &Path, which: Which, rows: &mut [Value], paired_at: &str) {
    if rows.is_empty() {
        return;
    }
    let path = file.with_file_name(which.file());
    for row in rows {
        if let (Some(id), Some(pairing)) = (row["deviceId"].as_str(), row[paired_at].as_f64())
            && let Ok(Some(usage)) = ledger::latest(&ledger_path(&path, id), pairing)
            && row["usage"]["day"]
                .as_str()
                .is_none_or(|stored| stored <= usage.day.as_str())
        {
            row["usage"] = usage.json();
        }
    }
}

/// `YYYY-MM-DD` of now in this computer's time zone (UTC when the system cannot say; the schedules' day).
fn today() -> String {
    use crate::schedules::rules::Zone;
    let day = crate::schedules::rules::Local.day(crate::clock::now_ms() as i64);
    format!("{}-{:02}-{:02}", day.year, day.month, day.day)
}

fn refusal(
    limits: Limits,
    requests_used: u64,
    tokens_used: u64,
    requests: u64,
) -> Option<&'static str> {
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

#[derive(Clone, Copy)]
enum Action<'a> {
    Reserve {
        id: &'a str,
        attempt: &'a str,
        requests: u64,
    },
    Refund {
        id: &'a str,
    },
    Record {
        requests: u64,
        tokens: u64,
    },
    SetLimits(Limits),
    View,
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
    reservation_id: Option<String>,
    #[serde(default)]
    attempt_id: Option<String>,
    #[serde(default)]
    limits: Option<Limits>,
}

fn required_id<'a>(id: Option<&'a str>, name: &str) -> Result<&'a str, Fault> {
    id.filter(|id| !id.is_empty() && id.len() <= 256)
        .ok_or_else(|| Fault::new("invalid_params", format!("{name} must have 1 to 256 bytes")))
}

fn call(id: u64, method: &str, raw: &RawValue) -> Outcome {
    let run = || -> Result<Value, Fault> {
        let quota = locked(&INSTANCES)
            .get(&id)
            .cloned()
            .ok_or_else(|| Fault::new("no_instance", "No such quota instance"))?;
        let args: Args = params(raw)?;
        let action = match method {
            "reserve" => Action::Reserve {
                id: required_id(args.reservation_id.as_deref(), "reservationId")?,
                attempt: required_id(args.attempt_id.as_deref(), "attemptId")?,
                requests: args.requests.ok_or_else(|| {
                    Fault::new("invalid_params", "a reservation needs a request count")
                })?,
            },
            "refund" => Action::Refund {
                id: required_id(args.reservation_id.as_deref(), "reservationId")?,
            },
            "record" => Action::Record {
                requests: args.requests.unwrap_or(0),
                tokens: args.tokens.unwrap_or(0),
            },
            "setLimits" => Action::SetLimits(args.limits.unwrap_or_default()),
            "view" => Action::View,
            _ => return Err(Fault::new("no_method", format!("quota has no {method}"))),
        };
        quota.run(&args.device_id, action, &today())
    };
    Outcome::Now(run())
}

#[cfg(test)]
mod tests;
