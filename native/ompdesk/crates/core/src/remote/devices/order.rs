#[cfg(test)]
mod tests;

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::super::identity::is_device_id;
use crate::server::Fault;

const MAX_DEVICES: usize = 256;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

// Big-endian numeric order is the wire's lexicographic order on 32 lowercase hex digits.
type Key = u128;

fn hash(id: &str) -> Key {
    let digest = Sha256::new()
        .chain_update(b"ompdesk/device-section-order/v1\0")
        .chain_update(id.as_bytes())
        .finalize();
    Key::from_be_bytes(digest[..16].try_into().expect("SHA-256 is 32 bytes"))
}

fn key(value: &Value) -> Option<Key> {
    let text = value.as_str()?;
    if text.len() != 32
        || !text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    Key::from_str_radix(text, 16).ok()
}

fn integer(value: &Value, limit: u64) -> Option<u64> {
    let n = value.as_f64()?;
    (n >= 0.0 && n < limit as f64 && n.fract() == 0.0).then_some(n as u64)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Row {
    device: Key,
    slot: usize,
    clock: u64,
    writer: Key,
}

fn parse(raw: &Value) -> Option<Vec<Row>> {
    let entries = raw.as_array().filter(|a| a.len() <= MAX_DEVICES)?;
    let mut seen = HashSet::with_capacity(entries.len());
    entries
        .iter()
        .map(|entry| {
            let [device, slot, clock, writer] = entry.as_array()?.as_slice() else {
                return None;
            };
            let device = key(device)?;
            if !seen.insert(device) {
                return None;
            }
            Some(Row {
                device,
                slot: integer(slot, MAX_DEVICES as u64)? as usize,
                clock: integer(clock, MAX_SAFE_INTEGER)?,
                writer: key(writer)?,
            })
        })
        .collect()
}

fn place(mut rows: Vec<Row>) -> Vec<Row> {
    rows.sort_unstable_by_key(|r| Reverse((r.clock, r.writer, r.device)));
    rows.truncate(MAX_DEVICES);
    let len = rows.len();
    let mut slots = vec![None; len];
    for row in rows {
        let mut i = if row.slot < len { row.slot } else { 0 };
        while slots[i].is_some() {
            i = (i + 1) % len;
        }
        slots[i] = Some(row);
    }
    slots.into_iter().flatten().collect()
}

#[derive(Clone, Debug)]
pub(super) struct Order {
    device_id: String,
    writer: Key,
    slots: Vec<Row>,
}

impl Order {
    pub(super) fn new(device_id: &str, stored_rows: &Value) -> Result<Self, Fault> {
        if !is_device_id(device_id) {
            return Err(Fault::new(
                "invalid_params",
                "Invalid local device identity",
            ));
        }
        Ok(Self {
            device_id: device_id.to_owned(),
            writer: hash(device_id),
            slots: place(parse(stored_rows).unwrap_or_default()),
        })
    }

    // Sort the actual IDs first. The local alias must not change its position among unranked hosts.
    fn known<'a>(&'a self, hosts: &'a [String]) -> Vec<(&'a str, Key)> {
        let mut ids: Vec<_> = hosts
            .iter()
            .map(String::as_str)
            .filter(|id| is_device_id(id))
            .collect();
        ids.push(&self.device_id);
        ids.sort_unstable();
        ids.dedup();
        ids.into_iter()
            .map(|id| {
                if id == self.device_id {
                    ("local", self.writer)
                } else {
                    (id, hash(id))
                }
            })
            .collect()
    }

    pub(super) fn view(&self, hosts: &[String]) -> Vec<String> {
        if self.slots.is_empty() {
            return Vec::new();
        }
        let known = self.known(hosts);
        let mut visible: HashMap<_, _> = known.iter().map(|&(id, key)| (key, id)).collect();
        let mut order = Vec::with_capacity(visible.len());
        for row in &self.slots {
            if let Some(id) = visible.remove(&row.device) {
                order.push(id.to_owned());
            }
        }
        for (_, key) in known {
            if let Some(id) = visible.remove(&key) {
                order.push(id.to_owned());
            }
        }
        order
    }

    pub(super) fn wire(&self) -> Value {
        Value::Array(
            self.slots
                .iter()
                .map(|r| {
                    json!([
                        format!("{:032x}", r.device),
                        r.slot,
                        r.clock,
                        format!("{:032x}", r.writer)
                    ])
                })
                .collect(),
        )
    }

    pub(super) fn set(&mut self, order: &Value, hosts: &[String]) -> Result<bool, Fault> {
        let invalid = || Fault::new("invalid_params", "Invalid device section order");
        let order = order
            .as_array()
            .filter(|a| a.len() <= MAX_DEVICES)
            .ok_or_else(invalid)?;
        if order.is_empty() {
            return Ok(false);
        }
        let known = self.known(hosts);
        let by_id: HashMap<_, _> = known.iter().copied().collect();
        let mut selected = HashSet::with_capacity(order.len());
        let mut desired = Vec::with_capacity(order.len());
        for id in order {
            let key = *id
                .as_str()
                .and_then(|id| by_id.get(id))
                .ok_or_else(invalid)?;
            if !selected.insert(key) {
                return Err(invalid());
            }
            desired.push(key);
        }

        let mut rows = Vec::new();
        let clock = self.slots.iter().map(|r| r.clock).max().unwrap_or(0) + 1;
        if self.slots.is_empty() {
            for (slot, device) in desired.into_iter().enumerate() {
                rows.push(Row {
                    device,
                    slot,
                    clock,
                    writer: self.writer,
                });
            }
        } else {
            let ranked: HashSet<_> = self.slots.iter().map(|r| r.device).collect();
            let occupants = self.slots.iter().map(|r| r.device).chain(
                known
                    .into_iter()
                    .map(|(_, key)| key)
                    .filter(|key| !ranked.contains(key)),
            );
            let mut desired = desired.into_iter().peekable();
            let mut last_move = 0;
            for (slot, occupant) in occupants.enumerate() {
                if desired.peek().is_none() {
                    break;
                }
                let device = if selected.contains(&occupant) {
                    desired
                        .next()
                        .expect("one desired device per selected occupant")
                } else {
                    occupant
                };
                if slot < MAX_DEVICES && (device != occupant || slot >= self.slots.len()) {
                    rows.push(Row {
                        device,
                        slot,
                        clock,
                        writer: self.writer,
                    });
                }
                if device != occupant {
                    if slot >= MAX_DEVICES {
                        return Err(Fault::new("invalid_params", "Too many ranked devices"));
                    }
                    last_move = rows.len();
                }
            }
            // Keep claims for the unranked tail only as far as the last moved device.
            rows.truncate(last_move);
        }
        if rows.is_empty() {
            return Ok(false);
        }
        if clock >= MAX_SAFE_INTEGER {
            return Err(Fault::new(
                "invalid_params",
                "Device section order clock exhausted",
            ));
        }
        Ok(self.join(rows))
    }

    pub(super) fn merge(&mut self, rows: &Value) -> bool {
        parse(rows).is_some_and(|rows| self.join(rows))
    }

    pub(super) fn migrate(&mut self, legacy: &Value, hosts: &[String]) -> bool {
        let Some(ids) = legacy
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= MAX_DEVICES)
        else {
            return false;
        };
        let known: HashMap<_, _> = self.known(hosts).into_iter().collect();
        let mut seen = HashSet::with_capacity(ids.len());
        let rows = ids
            .iter()
            .filter_map(|id| known.get(id.as_str()?).copied())
            .filter(|key| seen.insert(*key))
            .enumerate()
            .map(|(slot, device)| Row {
                device,
                slot,
                clock: 0,
                writer: self.writer,
            })
            .collect();
        self.join(rows)
    }

    fn join(&mut self, rows: Vec<Row>) -> bool {
        if rows.is_empty() {
            return false;
        }
        let mut by_key: HashMap<_, _> = self.slots.iter().map(|&r| (r.device, r)).collect();
        let mut changed = false;
        for row in rows {
            // A restored writer can reuse a clock. The larger slot breaks that tie on every relay.
            if by_key.get(&row.device).is_some_and(|old| {
                (row.clock, row.writer, row.slot) <= (old.clock, old.writer, old.slot)
            }) {
                continue;
            }
            by_key.insert(row.device, row);
            changed = true;
        }
        if !changed {
            return false;
        }
        let slots = place(by_key.into_values().collect());
        if slots == self.slots {
            return false;
        }
        self.slots = slots;
        true
    }
}
