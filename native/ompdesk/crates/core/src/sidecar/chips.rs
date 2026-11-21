use serde_json::{Value, json};
use std::collections::VecDeque;
use std::hash::{BuildHasher, RandomState};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Lane {
    Steering,
    FollowUp,
}

const LANES: [Lane; 2] = [Lane::Steering, Lane::FollowUp];

impl Lane {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Steering => "steering",
            Self::FollowUp => "followUp",
        }
    }
}

#[derive(Clone)]
pub(super) struct Chip {
    pub id: String,
    pub text: String,
    pub timestamp: u64,
}

impl Chip {
    fn fresh(text: &str, timestamp: u64) -> Self {
        // A renderer may still hold a chip from the core process that just exited.
        static PROCESS: LazyLock<u64> = LazyLock::new(|| RandomState::new().hash_one(0_u8));
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let serial = NEXT.fetch_add(1, Ordering::Relaxed);
        let number = (u128::from(*PROCESS) << 64) | u128::from(serial);
        Self {
            id: format!("q{number}"),
            text: text.to_owned(),
            timestamp,
        }
    }

    fn wire(&self) -> Value {
        json!({"id": self.id, "text": self.text, "editable": self.text != "[Image]", "timestamp": self.timestamp})
    }
}

struct Expected {
    lane: Lane,
    chip: Chip,
    at: u64,
}

#[derive(Default)]
pub(super) struct Chips {
    lanes: [Vec<Chip>; 2],
    expected: Vec<Expected>,
}

impl Chips {
    pub(super) fn lane(&self, lane: Lane) -> &[Chip] {
        &self.lanes[lane as usize]
    }

    pub(super) fn find(&self, id: &str) -> Option<(Lane, Chip, usize)> {
        LANES.into_iter().find_map(|lane| {
            self.lane(lane)
                .iter()
                .enumerate()
                .find(|(_, chip)| chip.id == id)
                .map(|(index, chip)| (lane, chip.clone(), index))
        })
    }

    pub(super) fn expect(&mut self, lane: Lane, text: String, mut chip: Chip, now: u64) {
        chip.text = text;
        self.expected.push(Expected {
            lane,
            chip,
            at: now,
        });
    }

    pub(super) fn view(&self) -> Value {
        json!({"steering": self.wire_lane(Lane::Steering), "followUp": self.wire_lane(Lane::FollowUp)})
    }

    fn wire_lane(&self, lane: Lane) -> Value {
        Value::Array(self.lane(lane).iter().map(Chip::wire).collect())
    }

    pub(super) fn refresh(&mut self, data: &Value, now: u64) -> Result<(), String> {
        if !data.is_null() && !data.is_object() {
            return Err("Invalid get_state data".into());
        }
        match data.get("queuedMessages") {
            None | Some(Value::Null) => self.adopt([&[], &[]], now),
            Some(queue) => self.adopt(
                stock_lanes(queue).ok_or("Invalid queuedMessages lanes")?,
                now,
            ),
        }
        Ok(())
    }

    pub(super) fn project(&mut self, raw: &[u8], now: u64) -> Option<Vec<u8>> {
        let mut frame: Value = serde_json::from_slice(raw).ok()?;
        if frame.get("type")?.as_str()? != "queue_update" {
            return None;
        }
        self.adopt(stock_lanes(&frame)?, now);
        for lane in LANES {
            frame[lane.name()] = self.wire_lane(lane);
        }
        serde_json::to_vec(&frame).ok()
    }

    fn adopt(&mut self, texts: [&[Value]; 2], now: u64) {
        self.expected.retain(|e| now.saturating_sub(e.at) < 10_000);
        let mut old = std::mem::take(&mut self.lanes).map(VecDeque::from);
        let mut unmatched = [VecDeque::new(), VecDeque::new()];
        // Reserve both lanes' ordered survivors before an edit or promotion can claim one.
        let mut matched = LANES.map(|lane| {
            let i = lane as usize;
            let mut rows = Vec::with_capacity(texts[i].len());
            for text in texts[i] {
                let hit = old[i]
                    .iter()
                    .position(|chip| text.as_str() == Some(&chip.text));
                rows.push(hit.and_then(|index| {
                    unmatched[i].extend(old[i].drain(..index));
                    old[i].pop_front()
                }));
            }
            unmatched[i].append(&mut old[i]);
            rows
        });
        for lane in LANES {
            let i = lane as usize;
            let other = 1 - i;
            self.lanes[i].reserve(texts[i].len());
            for (index, text) in texts[i].iter().enumerate() {
                let text = text.as_str().expect("validated stock lane");
                let chip = if let Some(chip) = matched[i][index].take() {
                    chip
                } else if let Some(at) = self.expected.iter().position(|e| {
                    e.lane == lane
                        && e.chip.text == text
                        && !matched
                            .iter()
                            .flatten()
                            .flatten()
                            .any(|c| c.id == e.chip.id)
                        && !self.lanes.iter().flatten().any(|c| c.id == e.chip.id)
                }) {
                    let chip = self.expected.remove(at).chip;
                    for pool in &mut unmatched {
                        if let Some(index) = pool.iter().position(|c| c.id == chip.id) {
                            pool.remove(index);
                        }
                    }
                    chip
                } else if let Some(at) = unmatched[other].iter().position(|c| c.text == text) {
                    unmatched[other].remove(at).expect("located chip")
                } else {
                    Chip::fresh(text, now)
                };
                self.lanes[i].push(chip);
            }
        }
    }
}

fn stock_lanes(queue: &Value) -> Option<[&[Value]; 2]> {
    let lane = |key: &str| {
        let rows = queue.get(key)?.as_array()?;
        rows.iter().all(Value::is_string).then_some(rows.as_slice())
    };
    Some([lane("steering")?, lane("followUp")?])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(chips: &mut Chips, steering: &[&str], follow_up: &[&str], now: u64) -> Value {
        chips
            .refresh(
                &json!({"queuedMessages": {"steering": steering, "followUp": follow_up}}),
                now,
            )
            .unwrap();
        chips.view()
    }

    #[test]
    fn fresh_queues_do_not_reissue_stale_ids_at_the_same_timestamp() {
        let first = snapshot(&mut Chips::default(), &["same"], &[], 1);
        let mut next = Chips::default();
        let second = snapshot(&mut next, &["same"], &[], 1);
        let old = first["steering"][0]["id"].as_str().unwrap();
        let new = second["steering"][0]["id"].as_str().unwrap();
        assert_ne!(old, new);
        assert!(next.find(old).is_none());
        assert!(new.strip_prefix('q').unwrap().parse::<u128>().is_ok());
    }

    #[test]
    fn removal_append_and_duplicate_promotion_keep_ordered_survivors() {
        let mut chips = Chips::default();
        let a = snapshot(&mut chips, &["a", "b", "c"], &["x", "x", "y"], 1);
        let b = snapshot(&mut chips, &["a", "c", "d", "x"], &["x", "y"], 2);
        for (new, old) in [(0, 0), (1, 2)] {
            assert_eq!(b["steering"][new], a["steering"][old]);
        }
        assert_ne!(b["steering"][2]["id"], a["steering"][1]["id"]);
        assert_ne!(a["followUp"][0]["id"], a["followUp"][1]["id"]);
        assert_eq!(b["followUp"][0], a["followUp"][0]);
        assert_eq!(b["followUp"][1], a["followUp"][2]);
        assert_eq!(b["steering"][3], a["followUp"][1]);
    }

    #[test]
    fn edit_claims_the_original_chip_only_before_its_deadline() {
        for age in [9_999, 10_000, 60_000] {
            let mut chips = Chips::default();
            let a = snapshot(&mut chips, &["old", "keep"], &[], 1);
            let (lane, chip, index) = chips
                .find(a["steering"][0]["id"].as_str().unwrap())
                .unwrap();
            assert_eq!((lane, index), (Lane::Steering, 0));
            snapshot(&mut chips, &["keep"], &[], 2);
            chips.expect(lane, "new".into(), chip, 2);
            let b = snapshot(&mut chips, &["keep", "new"], &[], age + 2);
            assert_eq!(a["steering"][1], b["steering"][0]);
            let edited = &b["steering"][1];
            assert_eq!(edited["id"] == a["steering"][0]["id"], age < 10_000);
            assert_eq!(edited["timestamp"], if age < 10_000 { 1 } else { age + 2 });
            assert_eq!(edited["text"], "new");
        }
    }

    #[test]
    fn expectation_cannot_take_a_reserved_id_but_can_claim_it_later() {
        let mut chips = Chips::default();
        let a = snapshot(&mut chips, &[], &["old"], 1);
        let id = a["followUp"][0]["id"].as_str().unwrap();
        chips.expect(Lane::Steering, "new".into(), chips.find(id).unwrap().1, 2);
        let b = snapshot(&mut chips, &["new"], &["old"], 3);
        assert_ne!(b["steering"][0]["id"], id);
        assert_eq!(b["followUp"][0]["id"], id);
        let c = snapshot(&mut chips, &["new", "new"], &[], 4);
        assert_eq!(c["steering"][1]["id"], id);
    }

    #[test]
    fn project_once_preserves_extensions_and_rejects_invalid_snapshots_atomically() {
        let mut chips = Chips::default();
        let raw = br#"{"type":"queue_update","steering":["[Image]","text"],"followUp":[],"extra":{"n":3}}"#;
        let projected = chips.project(raw, 4).unwrap();
        let frame: Value = serde_json::from_slice(&projected).unwrap();
        assert_eq!(frame["extra"], json!({"n": 3}));
        assert_eq!(frame["steering"][0]["editable"], false);
        assert_eq!(frame["steering"][1]["editable"], true);
        let before = chips.view();
        assert!(chips.project(&projected, 5).is_none());
        assert!(chips.project(b"broken", 5).is_none());
        let bad = json!({"type":"queue_update", "steering":[], "followUp":[1]});
        assert!(
            chips
                .project(&serde_json::to_vec(&bad).unwrap(), 5)
                .is_none()
        );
        assert!(chips.refresh(&json!({"queuedMessages": bad}), 5).is_err());
        assert_eq!(before, chips.view());
        for missing in [json!({}), json!({"queuedMessages": null})] {
            snapshot(&mut chips, &["text"], &[], 6);
            chips.refresh(&missing, 7).unwrap();
            assert_eq!(chips.view(), json!({"steering":[], "followUp":[]}));
        }
    }
}
