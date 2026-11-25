//! The person is told when OMPdesk keeps a newer omp off this computer under the verified list (was
//! `src/main/omp-hold-notice.ts`; `ompFollowVerified`, the hub's review points 2 and 5):
//! - `failed` (runners found it breaks this release): one notification when the hold is first seen, and one more once
//!   it has lasted a day, saying for how many days.
//! - `verifying` (runners have not judged it): a hold this computer has seen for 6 hours is told, then every 24 hours.
//!
//! The `untested-major` hold of the default passes is said in Settings alone. What was told survives a relaunch (the
//! pref `ompHoldTold`); when this computer first saw a version held is the pref `ompHeldSeen`.

use serde::Serialize;
use serde_json::{Value, json};

use crate::care::{date_parse, iso_of};

pub const RETELL_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
/// `VERIFYING_OVERDUE_MS` of `src/shared/omp-update.ts`: a `verifying` hold seen this long is told.
pub const VERIFYING_TELL_AFTER_MS: f64 = 6.0 * 60.0 * 60.0 * 1000.0;
pub const TOLD_PREF: &str = "ompHoldTold";
pub const SEEN_PREF: &str = "ompHeldSeen";
const HOUR_MS: f64 = 60.0 * 60.0 * 1000.0;

/// `OmpUpdateHold`: a newer omp OMPdesk does not install on its own.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Hold {
    pub version: String,
    /// `verifying`, `failed` or `untested-major`.
    pub reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
}

/// `HoldTold`: what this computer last told about a hold. Numbers as JavaScript's.
#[derive(Clone, Debug, PartialEq)]
pub struct Told {
    pub version: String,
    pub reason: String,
    pub at: f64,
    pub count: f64,
}

/// `HoldNotice`.
#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    pub version: String,
    pub reason: &'static str,
    /// Whole hours since the hold began.
    pub hours: f64,
    /// Whole days since the hold began; 0 within the first day.
    pub days: f64,
}

/// A number as `JSON.stringify` writes it: an integral one without a fraction.
pub fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

impl Told {
    pub fn to_value(&self) -> Value {
        json!({"version": self.version, "reason": self.reason, "at": number(self.at), "count": number(self.count)})
    }
}

/// `holdNotice`: whether to notify now, and what is told after it (`told` unchanged when nothing is said).
pub fn notice(held: Option<&Hold>, told: Option<Told>, now: f64) -> (Option<Notice>, Option<Told>) {
    let Some(held) = held.filter(|held| held.reason == "failed" || held.reason == "verifying")
    else {
        return (None, told);
    };
    let since = held
        .since
        .as_deref()
        .and_then(date_parse)
        .map(|ms| ms as f64);
    let age = since.map_or(0.0, |since| (now - since).max(0.0));
    let notice = Notice {
        version: held.version.clone(),
        reason: held.reason,
        hours: (age / HOUR_MS).floor(),
        days: (age / RETELL_MS).floor(),
    };
    let same = told
        .as_ref()
        .filter(|told| told.version == held.version && told.reason == held.reason);
    let tell = |count: f64| {
        let told = Told {
            version: held.version.clone(),
            reason: held.reason.to_owned(),
            at: now,
            count,
        };
        (Some(notice.clone()), Some(told))
    };
    if held.reason == "verifying" {
        // No `since`: nothing tells how long it waited, so it is never said.
        if since.is_none() || age < VERIFYING_TELL_AFTER_MS {
            return (None, told);
        }
        return match same {
            None => tell(1.0),
            Some(same) if now - same.at >= RETELL_MS => tell(same.count + 1.0),
            Some(_) => (None, told),
        };
    }
    // First seen after a day already (the computer was off): one notification says how long, and no second follows.
    match same {
        None => tell(if age >= RETELL_MS { 2.0 } else { 1.0 }),
        Some(same) if same.count < 2.0 && age >= RETELL_MS => tell(2.0),
        Some(_) => (None, told),
    }
}

/// `parseHoldTold`: a stored record, or none for anything else.
pub fn parse_told(value: Option<&Value>) -> Option<Told> {
    let object = value?.as_object()?;
    let reason = object.get("reason")?.as_str()?;
    (reason == "verifying" || reason == "failed").then_some(())?;
    Some(Told {
        version: object.get("version")?.as_str()?.to_owned(),
        reason: reason.to_owned(),
        at: object.get("at")?.as_f64()?,
        count: object.get("count")?.as_f64()?,
    })
}

/// `heldSince`: the first-seen time of `version` from the stored `{version, at}`, or now for a version not seen
/// before; the record to keep when it changed.
pub fn held_since(stored: Option<&Value>, version: &str, now: u64) -> (String, Option<Value>) {
    if let Some(seen) = stored.and_then(Value::as_object)
        && seen.get("version").and_then(Value::as_str) == Some(version)
        && let Some(at) = seen
            .get("at")
            .and_then(Value::as_str)
            .filter(|at| date_parse(at).is_some())
    {
        return (at.to_owned(), None);
    }
    let at = iso_of(now as f64);
    (at.clone(), Some(json!({"version": version, "at": at})))
}
