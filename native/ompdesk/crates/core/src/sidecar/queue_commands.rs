use super::chips::{Chip, Chips, Lane};
use crate::server::Fault;
use serde_json::{Value, json};

pub(super) enum Step {
    Done(Value),
    Fail(Fault),
    Stock(Value, Continuation),
    DequeueBridge,
}

pub(super) struct Continuation(Pending);

enum Change {
    Remove,
    Edit(String),
    Move(Option<Lane>, f64),
}

enum Refresh {
    View,
    Locate(String, Change),
    Clear(Option<Lane>),
    Dequeue,
}

enum Pending {
    Refresh(Refresh),
    Removed(String),
    Promoted {
        id: String,
        index: usize,
    },
    Requeue {
        lane: Lane,
        chip: Chip,
        text: String,
        result: Value,
    },
    Sent(Value),
    Clear(Clear),
    Dequeue(String),
}

fn stock(request: Value, pending: Pending) -> Step {
    Step::Stock(request, Continuation(pending))
}

fn refresh(next: Refresh) -> Step {
    stock(json!({"type":"get_state"}), Pending::Refresh(next))
}

fn remove(lane: Lane, message: &str) -> Value {
    json!({"type":"remove_queued_message", "message":message, "queue":lane.name()})
}

fn error(message: impl Into<String>) -> Step {
    Step::Fail(Fault::new("queue_error", message))
}

fn unknown(id: &str) -> Step {
    error(format!("Unknown queued message id: {id}"))
}

fn optional_lane(command: &Value, key: &str) -> Result<Option<Lane>, String> {
    match command.get(key).map(Value::as_str) {
        None => Ok(None),
        Some(Some("steering")) => Ok(Some(Lane::Steering)),
        Some(Some("followUp")) => Ok(Some(Lane::FollowUp)),
        _ => Err(format!("{key} must be \"steering\" or \"followUp\"")),
    }
}

pub(super) fn start(
    mut command: Value,
    chips: &mut Chips,
    bridge_connected: bool,
    now: u64,
) -> Step {
    let change = match command["type"].as_str() {
        Some("get_queue") => return refresh(Refresh::View),
        Some("dequeue") if bridge_connected => return Step::DequeueBridge,
        Some("dequeue") => return refresh(Refresh::Dequeue),
        Some("queue_clear") => {
            return match optional_lane(&command, "lane") {
                Ok(lane) => refresh(Refresh::Clear(lane)),
                Err(message) => error(message),
            };
        }
        Some("queue_remove") => Change::Remove,
        Some("queue_edit") => match command["text"].take() {
            Value::String(text) => Change::Edit(text),
            _ => return error("text must be a string"),
        },
        Some("queue_move") => {
            let lane = match optional_lane(&command, "toLane") {
                Ok(lane) => lane,
                Err(message) => return error(message),
            };
            let Some(index) = command["toIndex"].as_f64().filter(|v| v.is_finite()) else {
                return error("toIndex must be a finite number");
            };
            Change::Move(lane, index)
        }
        _ => return error("Unknown queue command"),
    };
    match command["queueId"].take() {
        Value::String(id) if !id.is_empty() => match chips.find(&id) {
            Some((lane, chip, index)) => change.apply(lane, chip, index, chips, now),
            None => refresh(Refresh::Locate(id, change)),
        },
        _ => error("queueId must be a non-empty string"),
    }
}

impl Change {
    fn apply(self, lane: Lane, chip: Chip, index: usize, chips: &mut Chips, now: u64) -> Step {
        let (destination, text, result) = match self {
            Self::Remove => return stock(remove(lane, &chip.text), Pending::Removed(chip.id)),
            Self::Edit(text) => {
                let result = json!({"updated":true});
                if text == chip.text {
                    return Step::Done(result);
                }
                (lane, text, result)
            }
            Self::Move(target, at) => {
                let target = target.unwrap_or(lane);
                if target == lane {
                    if (at.floor() as usize).min(chips.lane(lane).len() - 1) == index {
                        return Step::Done(json!({"lane":lane.name(), "index":index}));
                    }
                    return Step::Fail(Fault::new(
                        "unsupported",
                        "omp cannot reorder queued messages within a lane",
                    ));
                }
                let landed_at = chips.lane(target).len();
                if target == Lane::Steering {
                    let request = json!({"type":"promote_queued_message", "message":chip.text});
                    let pending = Pending::Promoted {
                        id: chip.id.clone(),
                        index: landed_at,
                    };
                    chips.expect(target, chip.text.clone(), chip, now);
                    return stock(request, pending);
                }
                (
                    target,
                    chip.text.clone(),
                    json!({"lane":target.name(), "index":landed_at}),
                )
            }
        };
        if chip.text == "[Image]" {
            return Step::Fail(Fault::new(
                "not_editable",
                "An image-only queued message cannot be re-queued",
            ));
        }
        stock(
            remove(lane, &chip.text),
            Pending::Requeue {
                lane: destination,
                chip,
                text,
                result,
            },
        )
    }
}

struct Clear {
    lane: Lane,
    remaining: std::vec::IntoIter<String>,
    follow_up_next: bool,
    removed: usize,
}

impl Clear {
    fn begin(lane: Lane, follow_up_next: bool, removed: usize, chips: &Chips) -> Step {
        let remaining = chips
            .lane(lane)
            .iter()
            .map(|chip| chip.text.clone())
            .collect::<Vec<_>>()
            .into_iter();
        Self {
            lane,
            remaining,
            follow_up_next,
            removed,
        }
        .next(chips)
    }

    fn next(mut self, chips: &Chips) -> Step {
        if let Some(message) = self.remaining.next() {
            stock(remove(self.lane, &message), Pending::Clear(self))
        } else if self.follow_up_next {
            Self::begin(Lane::FollowUp, false, self.removed, chips)
        } else {
            Step::Done(json!({"removed":self.removed}))
        }
    }
}

impl Continuation {
    pub(super) fn resume(self, data: Value, chips: &mut Chips, now: u64) -> Step {
        match self.0 {
            Pending::Refresh(next) => {
                if let Err(message) = chips.refresh(&data, now) {
                    return error(message);
                }
                match next {
                    Refresh::View => Step::Done(chips.view()),
                    Refresh::Locate(id, change) => match chips.find(&id) {
                        Some((lane, chip, index)) => change.apply(lane, chip, index, chips, now),
                        None => unknown(&id),
                    },
                    Refresh::Clear(only) => {
                        Clear::begin(only.unwrap_or(Lane::Steering), only.is_none(), 0, chips)
                    }
                    Refresh::Dequeue => {
                        for lane in [Lane::Steering, Lane::FollowUp] {
                            if let Some(chip) = chips.lane(lane).last() {
                                return stock(
                                    remove(lane, &chip.text),
                                    Pending::Dequeue(chip.text.clone()),
                                );
                            }
                        }
                        Step::Done(json!({"messages":[]}))
                    }
                }
            }
            Pending::Removed(id) => {
                if data["removed"] == true {
                    Step::Done(json!({"removed":true}))
                } else {
                    unknown(&id)
                }
            }
            Pending::Promoted { id, index } => {
                if data["promoted"] == true {
                    Step::Done(json!({"lane":"steering", "index":index}))
                } else {
                    unknown(&id)
                }
            }
            Pending::Requeue {
                lane,
                chip,
                text,
                result,
            } => {
                if data["removed"] != true {
                    return unknown(&chip.id);
                }
                let request = json!({"type": if lane == Lane::Steering { "steer" } else { "follow_up" }, "message":text});
                chips.expect(lane, text, chip, now);
                stock(request, Pending::Sent(result))
            }
            Pending::Sent(result) => Step::Done(result),
            Pending::Clear(mut clear) => {
                clear.removed += usize::from(data["removed"] == true);
                clear.next(chips)
            }
            Pending::Dequeue(text) => Step::Done(if data["removed"] == true {
                json!({"messages":[{"text":text}]})
            } else {
                json!({"messages":[]})
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(steering: &[&str], follow_up: &[&str]) -> Value {
        json!({"queuedMessages":{"steering":steering, "followUp":follow_up}})
    }

    fn request(step: Step, expected: Value) -> Continuation {
        let Step::Stock(actual, next) = step else {
            panic!("expected stock request {expected}")
        };
        assert_eq!(actual, expected);
        next
    }

    fn done(step: Step, expected: Value) {
        let Step::Done(actual) = step else {
            panic!("expected result {expected}")
        };
        assert_eq!(actual, expected);
    }

    fn failure(step: Step, code: &str, message: &str) {
        let Step::Fail(fault) = step else {
            panic!("expected error {code}")
        };
        assert_eq!(fault.code, code);
        assert_eq!(fault.message, message);
    }

    #[test]
    fn validates_before_lookup_or_stock() {
        let mut chips = Chips::default();
        for (command, message) in [
            (json!({"type":"queue_edit"}), "text must be a string"),
            (
                json!({"type":"queue_move","toLane":null}),
                "toLane must be \"steering\" or \"followUp\"",
            ),
            (
                json!({"type":"queue_move","toIndex":"1"}),
                "toIndex must be a finite number",
            ),
            (
                json!({"type":"queue_clear","lane":null}),
                "lane must be \"steering\" or \"followUp\"",
            ),
            (
                json!({"type":"queue_remove","queueId":""}),
                "queueId must be a non-empty string",
            ),
        ] {
            failure(start(command, &mut chips, true, 0), "queue_error", message);
        }
    }

    #[test]
    fn clear_freezes_only_the_lane_currently_being_removed() {
        let mut chips = Chips::default();
        let refresh = request(
            start(json!({"type":"queue_clear"}), &mut chips, false, 1),
            json!({"type":"get_state"}),
        );
        let first = request(
            refresh.resume(state(&["a", "b"], &["old"]), &mut chips, 2),
            remove(Lane::Steering, "a"),
        );
        chips.refresh(&state(&["other"], &["new"]), 3).unwrap();
        let second = request(
            first.resume(json!({"removed":"true"}), &mut chips, 4),
            remove(Lane::Steering, "b"),
        );
        let last = request(
            second.resume(json!({"removed":true}), &mut chips, 5),
            remove(Lane::FollowUp, "new"),
        );
        done(
            last.resume(json!({"removed":true}), &mut chips, 6),
            json!({"removed":2}),
        );
    }

    #[test]
    fn promotion_preserves_images_and_reports_the_original_destination_length() {
        let mut chips = Chips::default();
        chips.refresh(&state(&["one"], &["[Image]"]), 1).unwrap();
        let id = chips.view()["followUp"][0]["id"].clone();
        let move_chip = json!({"type":"queue_move","queueId":id,"toLane":"steering","toIndex":-20});
        let promote = json!({"type":"promote_queued_message","message":"[Image]"});
        let denied = request(
            start(move_chip.clone(), &mut chips, true, 2),
            promote.clone(),
        );
        failure(
            denied.resume(json!({"promoted":1}), &mut chips, 3),
            "queue_error",
            &format!("Unknown queued message id: {}", id.as_str().unwrap()),
        );
        let pending = request(start(move_chip, &mut chips, true, 4), promote);
        chips.refresh(&state(&["one", "[Image]"], &[]), 5).unwrap();
        done(
            pending.resume(json!({"promoted":true}), &mut chips, 6),
            json!({"lane":"steering","index":1}),
        );
        assert_eq!(chips.view()["steering"][1]["id"], id);
    }

    #[test]
    fn image_no_ops_are_allowed_but_requeues_and_reordering_are_not() {
        let mut chips = Chips::default();
        chips.refresh(&state(&["a", "[Image]"], &[]), 1).unwrap();
        let id = chips.view()["steering"][1]["id"].clone();
        let mut run = |cmd| start(cmd, &mut chips, true, 2);
        done(
            run(json!({"type":"queue_edit","queueId":id,"text":"[Image]"})),
            json!({"updated":true}),
        );
        done(
            run(json!({"type":"queue_move","queueId":id,"toIndex":99.5})),
            json!({"lane":"steering","index":1}),
        );
        failure(
            run(json!({"type":"queue_move","queueId":id,"toIndex":0.9})),
            "unsupported",
            "omp cannot reorder queued messages within a lane",
        );
        for cmd in [
            json!({"type":"queue_edit","queueId":id,"text":"x"}),
            json!({"type":"queue_move","queueId":id,"toLane":"followUp","toIndex":0}),
        ] {
            failure(
                run(cmd),
                "not_editable",
                "An image-only queued message cannot be re-queued",
            );
        }
    }

    #[test]
    fn dequeue_uses_the_bridge_or_removes_the_last_preferred_chip() {
        let mut chips = Chips::default();
        assert!(matches!(
            start(json!({"type":"dequeue"}), &mut chips, true, 1),
            Step::DequeueBridge
        ));
        for (steering, lane, text, removed, result) in [
            (
                vec!["first", "last"],
                Lane::Steering,
                "last",
                json!(true),
                json!({"messages":[{"text":"last"}]}),
            ),
            (
                vec![],
                Lane::FollowUp,
                "follow",
                json!(1),
                json!({"messages":[]}),
            ),
        ] {
            let refresh = request(
                start(json!({"type":"dequeue"}), &mut chips, false, 1),
                json!({"type":"get_state"}),
            );
            let pending = request(
                refresh.resume(state(&steering, &["follow"]), &mut chips, 2),
                remove(lane, text),
            );
            done(
                pending.resume(json!({"removed":removed}), &mut chips, 3),
                result,
            );
        }
    }

    #[test]
    fn edit_only_requeues_after_stock_confirms_removal() {
        let mut chips = Chips::default();
        chips.refresh(&state(&[], &["old"]), 10).unwrap();
        let id = chips.view()["followUp"][0]["id"].clone();
        let command = json!({"type":"queue_edit","queueId":id,"text":"new"});
        let rejected = request(
            start(command.clone(), &mut chips, false, 11),
            remove(Lane::FollowUp, "old"),
        );
        let message = format!("Unknown queued message id: {}", id.as_str().unwrap());
        failure(
            rejected.resume(json!({"removed":1}), &mut chips, 12),
            "queue_error",
            &message,
        );
        let accepted = request(
            start(command, &mut chips, false, 13),
            remove(Lane::FollowUp, "old"),
        );
        let sent = request(
            accepted.resume(json!({"removed":true}), &mut chips, 14),
            json!({"type":"follow_up","message":"new"}),
        );
        chips.refresh(&state(&[], &["new"]), 15).unwrap();
        assert_eq!(chips.view()["followUp"][0]["id"], id);
        done(
            sent.resume(Value::Null, &mut chips, 16),
            json!({"updated":true}),
        );
    }

    #[test]
    fn removal_refreshes_unknown_ids_only_once() {
        let mut chips = Chips::default();
        let pending = request(
            start(
                json!({"type":"queue_remove","queueId":"missing"}),
                &mut chips,
                false,
                1,
            ),
            json!({"type":"get_state"}),
        );
        failure(
            pending.resume(state(&["other"], &[]), &mut chips, 2),
            "queue_error",
            "Unknown queued message id: missing",
        );
        let id = chips.view()["steering"][0]["id"].clone();
        let pending = request(
            start(
                json!({"type":"queue_remove","queueId":id}),
                &mut chips,
                false,
                3,
            ),
            remove(Lane::Steering, "other"),
        );
        done(
            pending.resume(json!({"removed":true}), &mut chips, 4),
            json!({"removed":true}),
        );
    }
}
