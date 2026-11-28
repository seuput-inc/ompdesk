use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::Path;

use serde::de::{DeserializeOwned, IgnoredAny};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::disk::tree;

use super::{Action, Fault, Patch, Record, Usage, refusal};

fn storage(error: impl std::fmt::Display) -> Fault {
    Fault::new(
        "quota_storage",
        format!("Could not access the quota ledger: {error}"),
    )
}

#[derive(Default, Deserialize, Serialize)]
struct Snapshot<R = HashMap<String, Receipt>> {
    usage: Vec<Daily>,
    reservations: R,
}

#[derive(Deserialize, Serialize)]
struct Daily {
    pairing: f64,
    day: String,
    requests: u64,
    tokens: u64,
}

#[derive(Deserialize, Serialize)]
struct Receipt {
    attempt: String,
    pairing: f64,
    day: String,
    requests: u64,
    refunded: bool,
}

fn read<R: DeserializeOwned>(path: &Path) -> Result<Option<Snapshot<R>>, Fault> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(storage),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(storage(e)),
    }
}

pub(super) fn latest(path: &Path, pairing: f64) -> Result<Option<Usage>, Fault> {
    let Some(snapshot) = read::<IgnoredAny>(path)? else {
        return Ok(None);
    };
    Ok(snapshot
        .usage
        .into_iter()
        .filter(|r| r.pairing == pairing)
        .max_by(|a, b| a.day.cmp(&b.day))
        .map(|r| Usage {
            day: r.day,
            requests: r.requests,
            tokens: r.tokens,
        }))
}

impl<R> Snapshot<R> {
    fn day(&mut self, record: &Record, day: &str) -> &mut Daily {
        if let Some(index) = self
            .usage
            .iter()
            .position(|r| r.pairing == record.pairing && r.day == day)
        {
            return &mut self.usage[index];
        }
        let seed = record.usage.as_ref().filter(|u| u.day == day);
        self.usage.push(Daily {
            pairing: record.pairing,
            day: day.to_owned(),
            requests: seed.map_or(0, |u| u.requests),
            tokens: seed.map_or(0, |u| u.tokens),
        });
        self.usage.last_mut().expect("just inserted")
    }
}

fn add(count: u64, n: u64) -> Result<u64, Fault> {
    count
        .checked_add(n)
        .filter(|n| i64::try_from(*n).is_ok())
        .ok_or_else(|| storage("usage exceeds the supported range"))
}

impl Daily {
    fn projection(&self) -> Patch {
        Patch {
            usage: Some(Some(
                json!({ "day": self.day, "requests": self.requests, "tokens": self.tokens }),
            )),
            limits: None,
        }
    }

    fn charge(&mut self, requests: u64, tokens: u64) -> Result<Patch, Fault> {
        self.requests = add(self.requests, requests)?;
        self.tokens = add(self.tokens, tokens)?;
        Ok(self.projection())
    }
}

pub(super) fn apply(
    path: &Path,
    record: Record,
    action: Action<'_>,
    day: &str,
) -> Result<(Value, Patch), Fault> {
    if let Action::View = action {
        let mut snapshot = read::<IgnoredAny>(path)?.unwrap_or_default();
        let row = snapshot.day(&record, day);
        return Ok((
            json!({"limits": record.limits.json(), "usage": {"requests": row.requests, "tokens": row.tokens}}),
            Patch::default(),
        ));
    }

    let dir = path.parent().expect("quota snapshot has a store directory");
    tree::make_dirs(dir, 0o700).map_err(|e| storage(e.message))?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    // The data file changes inode on every commit. Never replace or remove its lock.
    let lock = options.open(path.with_extension("lock")).map_err(storage)?;
    #[cfg(test)]
    let skip_lock = super::tests::skip_lock(path);
    #[cfg(not(test))]
    let skip_lock = false;
    if !skip_lock {
        lock.lock().map_err(storage)?;
    }
    let saved = read(path)?;
    #[cfg(unix)]
    if saved.is_none() {
        // Our store directory may just have been created, even by a concurrent writer.
        tree::sync_dir(dir.parent().expect("quota store has a userData directory"))
            .map_err(storage)?;
    }
    let mut snapshot: Snapshot = saved.unwrap_or_default();
    #[cfg(test)]
    super::tests::after_read(path);

    let (answer, patch) = match action {
        Action::Reserve {
            id,
            attempt,
            requests,
        } => {
            if let Some(r) = snapshot.reservations.get(id) {
                let active = !r.refunded && r.pairing == record.pairing;
                let answer = if active && r.attempt == attempt && r.requests == requests {
                    // A previous rename can be visible even if its directory sync failed.
                    #[cfg(unix)]
                    tree::sync_dir(dir).map_err(storage)?;
                    json!({"ok": true})
                } else {
                    json!({"ok": false, "refusal": "duplicate", "charged": active && r.requests != 0})
                };
                return Ok((answer, Patch::default()));
            }
            let patch = if requests == 0 {
                Patch::default()
            } else {
                let row = snapshot.day(&record, day);
                if let Some(reason) = refusal(record.limits, row.requests, row.tokens, requests) {
                    return Ok((json!({"ok": false, "refusal": reason}), Patch::default()));
                }
                row.charge(requests, 0)?
            };
            snapshot.reservations.insert(
                id.to_owned(),
                Receipt {
                    attempt: attempt.to_owned(),
                    pairing: record.pairing,
                    day: day.to_owned(),
                    requests,
                    refunded: false,
                },
            );
            (json!({"ok": true}), patch)
        }
        Action::Refund { id } => {
            let Some(r) = snapshot.reservations.get_mut(id) else {
                return Ok((Value::Null, Patch::default()));
            };
            if r.refunded {
                #[cfg(unix)]
                tree::sync_dir(dir).map_err(storage)?;
                return Ok((Value::Null, Patch::default()));
            }
            let mut patch = Patch::default();
            if r.requests != 0 {
                let row = snapshot
                    .usage
                    .iter_mut()
                    .find(|row| row.pairing == r.pairing && row.day == r.day)
                    .ok_or_else(|| storage("missing usage for reservation"))?;
                row.requests = row
                    .requests
                    .checked_sub(r.requests)
                    .ok_or_else(|| storage("reservation exceeds recorded usage"))?;
                if r.pairing == record.pairing && r.day == day {
                    patch = row.projection();
                }
            }
            r.refunded = true;
            (Value::Null, patch)
        }
        Action::Record { requests, tokens } => {
            let patch = snapshot.day(&record, day).charge(requests, tokens)?;
            (Value::Null, patch)
        }
        Action::SetLimits(_) | Action::View => unreachable!("not a ledger mutation"),
    };
    tree::write_durable(path, |writer| {
        serde_json::to_writer(writer, &snapshot)?;
        #[cfg(test)]
        super::tests::before_commit(path)?;
        Ok(())
    })
    .map_err(|e| storage(e.message))?;
    Ok((answer, patch))
}
