//! Setup's back-off ledger `<userData>/setup-state.json` (was the ledger half of `SetupService`): per item, the
//! automatic attempts that left it missing and when the last one started, with the OMPdesk version that made them.
//! An attempt is counted when it starts, taken back on a Cancel or a quit, and forgotten once the item is found;
//! another OMPdesk version's misses are ignored. Write failures are dropped: without the ledger every launch tries.

use serde_json::{Map, Value, json};

use super::{ITEMS, tabbed};

/// Automatic attempts before an item waits [`BACKOFF_MS`] between automatic attempts.
pub const BACKOFF_AFTER: u64 = 3;
pub const BACKOFF_MS: u64 = 24 * 60 * 60 * 1000;

/// The ledger file and this OMPdesk's version (empty: none recorded, every entry counts).
pub struct Ledger<'a> {
    pub file: &'a str,
    pub app: &'a str,
}

/// One item's record: misses and the last attempt's start.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Attempts {
    pub failures: u64,
    pub last_attempt: i64,
}

fn number(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_f64().filter(|n| *n >= 0.0).map(|n| n as u64))
}

/// A time in milliseconds, as JavaScript reads any number (one before the epoch included).
fn time(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_f64().map(|n| n as i64))
}

impl Ledger<'_> {
    /// The entries this version counts, in the file's order.
    pub fn read(&self) -> Map<String, Value> {
        let Ok(text) = std::fs::read_to_string(self.file) else {
            return Map::new();
        };
        let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(&text) else {
            return Map::new();
        };
        let mut ledger = Map::new();
        for (key, value) in parsed {
            if !ITEMS.contains(&key.as_str()) || !value.is_object() {
                continue;
            }
            let app = value["app"].as_str();
            if !self.app.is_empty() && app != Some(self.app) {
                continue;
            }
            let (Some(failures), Some(last)) =
                (number(&value["failures"]), time(&value["lastAttempt"]))
            else {
                continue;
            };
            let mut entry = json!({"failures": failures, "lastAttempt": last});
            if let Some(app) = app {
                entry["app"] = json!(app);
            }
            ledger.insert(key, entry);
        }
        ledger
    }

    fn write(&self, ledger: &Map<String, Value>) {
        let _ = std::fs::write(
            self.file,
            format!("{}\n", tabbed(&Value::Object(ledger.clone()))),
        );
    }

    pub fn attempts(&self, id: &str) -> Option<Attempts> {
        let ledger = self.read();
        let entry = ledger.get(id)?;
        Some(Attempts {
            failures: number(&entry["failures"])?,
            last_attempt: time(&entry["lastAttempt"])?,
        })
    }

    /// Whether the ledger lets an automatic attempt run at `now` (`#mayAttempt` past the once-per-launch rule).
    pub fn allows(&self, id: &str, now: u64) -> bool {
        match self.attempts(id) {
            Some(record) if record.failures >= BACKOFF_AFTER => {
                (now as i64).saturating_sub(record.last_attempt) >= BACKOFF_MS as i64
            }
            _ => true,
        }
    }

    /// Counts an attempt as it starts (`#recordAttempt`).
    pub fn record(&self, id: &str, now: u64) {
        let mut ledger = self.read();
        let failures = ledger
            .get(id)
            .and_then(|entry| number(&entry["failures"]))
            .unwrap_or(0);
        let mut entry = json!({"failures": failures + 1, "lastAttempt": now});
        if !self.app.is_empty() {
            entry["app"] = json!(self.app);
        }
        ledger.insert(id.to_owned(), entry);
        self.write(&ledger);
    }

    /// Takes a stopped attempt back out (`#uncountRunning`).
    pub fn uncount(&self, id: &str) {
        let mut ledger = self.read();
        let Some(entry) = ledger.get_mut(id) else {
            return;
        };
        let failures = number(&entry["failures"]).unwrap_or(0);
        if failures <= 1 {
            ledger.shift_remove(id);
        } else {
            entry["failures"] = json!(failures - 1);
        }
        self.write(&ledger);
    }

    /// Forgets an item's misses once it is found (`#clearAttempts`).
    pub fn clear(&self, id: &str) {
        let mut ledger = self.read();
        if ledger.shift_remove(id).is_some() {
            self.write(&ledger);
        }
    }
}
