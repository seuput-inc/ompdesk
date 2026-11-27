//! A tab's turn state, read from its sidecar's events (was `src/main/sidecar-run-state.ts`). The pool runs it in the
//! core; `remote/host-services.ts` still reads the same rules from the TypeScript file until the remote host moves
//! (R6), so both are pinned to one table of event sequences and the states they give (`run-captured.json`, replayed by
//! the test below and by `src/main/sidecar-run-state.test.ts`).
//!
//! Times are milliseconds on the clock of the one who asks (`now`): main sends its `Date.now()` with each call, so the
//! tests' fake clock is the clock of the rules here too.

use serde_json::{Map, Value, json};

use super::HostCloseTurn;

/// The open retry saga's latest attempt (`IpcRetrySaga`): the four fields the event carried, and when it began.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Saga {
    /// `attempt`, `maxAttempts`, `delayMs`, `errorMessage` as the event gave them (absent stays absent).
    pub fields: Map<String, Value>,
    pub started_at: i64,
}

const SAGA_FIELDS: [&str; 4] = ["attempt", "maxAttempts", "delayMs", "errorMessage"];

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct RunState {
    /// agent_start seen, its run not yet over.
    pub running: bool,
    /// The prompt yielded while background work can still wake the session.
    pub awaiting_settled: bool,
    /// A turn runs in front: agent_start seen, its last attempt not yet ended.
    pub turn: bool,
    pub saga: Option<Saga>,
    /// The saga's coalesced agent_end arrived while the retry was still outstanding.
    pub ended_while_retrying: bool,
    /// Compaction state (automatic, or a manual pass anyone asked for) once observed since the spawn.
    pub compacting: Option<bool>,
    /// When the current turn started, kept while background work follows it; absent while no run is on.
    pub since: Option<i64>,
}

impl RunState {
    pub(crate) fn busy(&self) -> bool {
        self.running || self.compacting == Some(true)
    }

    /// The run is on only because stock reports background work: its turn ended.
    pub(crate) fn settling(&self) -> bool {
        self.running && !self.turn
    }

    /// `runReading`: how a run stands for a party that saw none of its events.
    pub(crate) fn reading(&self, now: i64) -> Value {
        let mut reading = Map::new();
        reading.insert("running".into(), Value::from(self.running));
        reading.insert("turn".into(), Value::from(self.turn));
        if let Some(compacting) = self.compacting {
            reading.insert("compacting".into(), Value::from(compacting));
        }
        if let Some(since) = self.since {
            reading.insert("elapsedMs".into(), Value::from((now - since).max(0)));
        }
        if let Some(saga) = &self.saga {
            let mut fields = Map::new();
            for key in SAGA_FIELDS {
                if let Some(value) = saga.fields.get(key) {
                    fields.insert(key.into(), value.clone());
                }
            }
            fields.insert(
                "elapsedMs".into(),
                Value::from((now - saga.started_at).max(0)),
            );
            fields.insert("ended".into(), Value::from(self.ended_while_retrying));
            reading.insert("saga".into(), Value::Object(fields));
        }
        Value::Object(reading)
    }

    /// `runFromReading`: the run a reading describes; `kept` is this side's own run, whose pending settlement survives.
    pub(crate) fn from_reading(reading: &Value, kept: Option<&RunState>, now: i64) -> RunState {
        let running = reading["running"].as_bool().unwrap_or(false);
        let turn = reading["turn"].as_bool().unwrap_or(false);
        let saga_reading = if running {
            reading.get("saga").and_then(Value::as_object)
        } else {
            None
        };
        let kept_pending = kept.is_some_and(|kept| kept.busy() && kept.awaiting_settled);
        let saga = saga_reading.map(|saga| {
            let mut fields = Map::new();
            for key in SAGA_FIELDS {
                if let Some(value) = saga.get(key) {
                    fields.insert(key.into(), value.clone());
                }
            }
            Saga {
                fields,
                started_at: now - millis(saga.get("elapsedMs")).unwrap_or(0),
            }
        });
        RunState {
            running,
            turn,
            awaiting_settled: running && (!turn || kept_pending),
            ended_while_retrying: saga_reading
                .is_some_and(|saga| saga.get("ended").and_then(Value::as_bool) == Some(true)),
            saga,
            compacting: reading.get("compacting").and_then(Value::as_bool),
            since: running.then(|| match millis(reading.get("elapsedMs")) {
                Some(elapsed) => now - elapsed,
                None => kept.and_then(|kept| kept.since).unwrap_or(now),
            }),
        }
    }

    /// `settleRun`: `prompt_result.sessionSettled` / `session_settled`: background work keeps the run alive until settled.
    pub(crate) fn settle(&mut self, settled: bool, now: i64) {
        self.awaiting_settled = !settled;
        self.running = !settled;
        if settled {
            self.turn = false;
            self.since = None;
        } else if self.since.is_none() {
            self.since = Some(now);
        }
    }

    /// `applyRunEvent`: true when the event ended the run's last attempt (an agent_end outside a retry saga, or a
    /// failed auto_retry_end after the saga's agent_end); the session may still be awaiting settlement.
    pub(crate) fn apply(&mut self, event: &Value, now: i64) -> bool {
        match event["type"].as_str() {
            Some("agent_start") => {
                self.running = true;
                self.turn = true;
                self.since = Some(now);
                false
            }
            Some("agent_end") => {
                // The saga's coalesced agent_end can arrive before its auto_retry_end; only that end event says
                // whether the run is over.
                if self.saga.is_some() {
                    self.ended_while_retrying = true;
                    return false;
                }
                self.turn = false;
                if !self.awaiting_settled {
                    self.running = false;
                    self.since = None;
                }
                true
            }
            Some("auto_retry_start") => {
                let mut fields = Map::new();
                for key in SAGA_FIELDS {
                    if let Some(value) = event.get(key) {
                        fields.insert(key.into(), value.clone());
                    }
                }
                self.saga = Some(Saga {
                    fields,
                    started_at: now,
                });
                false
            }
            Some("auto_retry_end") => {
                let failed_after_end =
                    event["success"].as_bool() != Some(true) && self.ended_while_retrying;
                self.saga = None;
                self.ended_while_retrying = false;
                if failed_after_end {
                    self.turn = false;
                }
                if failed_after_end && !self.awaiting_settled {
                    self.running = false;
                    self.since = None;
                }
                failed_after_end
            }
            // A manual pass (RPC `compact`, `/compact`, a handoff) is announced as its own pair, whoever asked for it.
            Some("auto_compaction_start" | "manual_compaction_start") => {
                self.compacting = Some(true);
                false
            }
            Some("auto_compaction_end" | "manual_compaction_end") => {
                self.compacting = Some(false);
                false
            }
            _ => false,
        }
    }

    /// The `run` of a state as the captured table and tests print it.
    pub(crate) fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("running".into(), Value::from(self.running));
        map.insert("awaitingSettled".into(), Value::from(self.awaiting_settled));
        map.insert("turn".into(), Value::from(self.turn));
        if let Some(saga) = &self.saga {
            let mut fields = saga.fields.clone();
            fields.insert("startedAt".into(), Value::from(saga.started_at));
            map.insert("saga".into(), Value::Object(fields));
        }
        map.insert(
            "endedWhileRetrying".into(),
            Value::from(self.ended_while_retrying),
        );
        if let Some(compacting) = self.compacting {
            map.insert("compacting".into(), Value::from(compacting));
        }
        if let Some(since) = self.since {
            map.insert("since".into(), Value::from(since));
        }
        Value::Object(map)
    }
}

/// A whole number of milliseconds from a JSON number (a reading's `elapsedMs`).
fn millis(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_f64).map(|ms| ms as i64)
}

#[derive(Clone, Debug, Default, PartialEq)]
enum ObservedTurn {
    #[default]
    Initial,
    /// The previous omp is gone. Do not reuse its zero fence before the new host reports one.
    HostRestarted,
    FreshHost(HostCloseTurn),
    Unfinished,
    Finished {
        id: u64,
        outcome: Value,
        host: Option<HostCloseTurn>,
    },
}

/// A tab's run state plus what the resume rules read from it (`RunTracking`).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Tracking {
    pub run: RunState,
    observed: ObservedTurn,
    /// The user pressed Stop since the run began. Cleared by the next agent_start.
    pub stopped: bool,
    /// Stock's auto-retry waiting for its next attempt: `errorMessage`, and the serial of its `auto_retry_start`.
    pub retry: Option<Retry>,
    retry_blocked: bool,
    /// The session's goal is active (stock's last `goal_updated`): between its turns a relaunch must resume it, since
    /// stock pauses an active goal when the session loads.
    pub goal_active: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Retry {
    pub error_message: Value,
    /// One per `auto_retry_start` (the TypeScript's one object each): main hands the same object out while it stands.
    pub serial: u64,
}

impl Tracking {
    pub(super) fn close_observation(&self) -> Option<(u64, Option<&HostCloseTurn>)> {
        match &self.observed {
            ObservedTurn::Initial => Some((0, None)),
            ObservedTurn::FreshHost(host) => Some((0, Some(host))),
            ObservedTurn::Finished { id, host, .. } => Some((*id, host.as_ref())),
            ObservedTurn::Unfinished | ObservedTurn::HostRestarted => None,
        }
    }

    pub(super) fn host_status(&mut self, payload: &Value, new_omp: bool) {
        if new_omp && (payload["status"] == "restarting" || self.observed != ObservedTurn::Initial)
        {
            self.observed = ObservedTurn::HostRestarted;
            self.stopped = false;
            self.retry = None;
        }
        if matches!(
            self.observed,
            ObservedTurn::Initial | ObservedTurn::HostRestarted | ObservedTurn::FreshHost(_)
        ) && let Some(host) = HostCloseTurn::from_payload(payload).filter(|host| host.turn == 0)
        {
            self.observed = ObservedTurn::FreshHost(host);
        }
    }

    fn finish(&mut self, outcome: Value, host: Option<HostCloseTurn>, serial: &mut u64) {
        *serial += 1;
        self.observed = ObservedTurn::Finished {
            id: *serial,
            outcome,
            host,
        };
    }

    /// Repeated readings keep the local outcome's identity. A missed turn gets its own even for the same words.
    pub(super) fn read_host_outcome(&mut self, reading: &Value, serial: &mut u64) -> bool {
        let host = HostCloseTurn::from_payload(reading);
        let last = reading.get("lastRun");
        let observed = self.close_observation().and_then(|(_, host)| host);
        match (host, last) {
            (Some(host), None) if host.turn == 0 && !self.run.running => {
                if observed == Some(&host) {
                    return false;
                }
                self.observed = ObservedTurn::FreshHost(host);
            }
            (Some(host), Some(outcome))
                if host.turn != 0 && !self.run.turn && outcome["stopReason"].is_string() =>
            {
                if observed == Some(&host) && self.last_outcome() == last {
                    return false;
                }
                self.finish(outcome.clone(), Some(host), serial);
            }
            _ if self.run.turn || observed.is_some() || reading.get("hostTurn").is_some() => {
                if self.observed == ObservedTurn::Unfinished {
                    return false;
                }
                self.observed = ObservedTurn::Unfinished;
            }
            _ => return false,
        }
        self.stopped = false;
        if self.run.saga.is_none() {
            self.retry = None;
        }
        true
    }

    pub(super) fn last_outcome(&self) -> Option<&Value> {
        match &self.observed {
            ObservedTurn::Finished { outcome, .. } => Some(outcome),
            _ => None,
        }
    }

    pub(super) fn numbered_outcome(&self) -> Option<Value> {
        let ObservedTurn::Finished { id, outcome, .. } = &self.observed else {
            return None;
        };
        let mut outcome = outcome.clone();
        outcome["id"] = Value::from(*id);
        Some(outcome)
    }

    /// `trackRunEvent`: `RunState::apply` plus the run's outcome, Stop and pending auto-retry; true when it ended the
    /// run's last attempt. `serial` numbers local retries and outcomes, never a host's turns.
    pub(crate) fn track(
        &mut self,
        event: &Value,
        now: i64,
        serial: &mut u64,
        remote: bool,
    ) -> bool {
        let host = || {
            remote
                .then(|| HostCloseTurn::from_payload(event))
                .flatten()
                .filter(|host| host.turn != 0)
        };
        let ended = self.run.apply(event, now);
        match event["type"].as_str() {
            Some("agent_start") => {
                self.observed = ObservedTurn::Unfinished;
                self.stopped = false;
                self.retry = None;
                self.retry_blocked = false;
            }
            Some("auto_retry_start") => {
                *serial += 1;
                self.retry = Some(Retry {
                    error_message: event.get("errorMessage").cloned().unwrap_or(Value::Null),
                    serial: *serial,
                });
            }
            Some("agent_end")
                if ended && event.get("isTerminal").and_then(Value::as_bool) != Some(false) =>
            {
                self.finish(run_outcome(event.get("messages")), host(), serial);
            }
            Some("agent_end") if self.run.saga.is_some() => {
                self.retry_blocked |= last_assistant(event.get("messages"))
                    .is_some_and(|last| last["retryBlocked"] == true);
            }
            Some("agent_end") if remote && ended => self.observed = ObservedTurn::Unfinished,
            Some("goal_updated") => {
                self.goal_active = event["goal"]["status"].as_str() == Some("active");
            }
            Some("auto_retry_end") => {
                self.retry = None;
                if ended {
                    let mut outcome = Map::new();
                    outcome.insert("stopReason".into(), Value::from("error"));
                    if self.retry_blocked {
                        outcome.insert("retryBlocked".into(), Value::Bool(true));
                    }
                    if let Some(error) = event.get("finalError") {
                        outcome.insert("errorMessage".into(), error.clone());
                    }
                    self.finish(Value::Object(outcome), host(), serial);
                }
                self.retry_blocked = false;
            }
            _ => {}
        }
        ended
    }
}

/// Characters of a finished reply's text kept for the completion banner (UTF-16 units, as `slice` counts them).
const RUN_REPLY_PREVIEW_CHARS: usize = 4000;

/// What `Array.prototype.join` makes of one element: a string as it is, nothing (`undefined`, `null`) as empty, a number
/// or boolean as JavaScript prints it.
fn js_join_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Array(_)) => String::new(),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

fn last_assistant(messages: Option<&Value>) -> Option<&Value> {
    messages.and_then(Value::as_array).and_then(|messages| {
        messages
            .iter()
            .rfind(|m| m["role"].as_str() == Some("assistant"))
    })
}

/// A finished run's outcome, read from agent_end's own messages (the last assistant reply).
fn run_outcome(messages: Option<&Value>) -> Value {
    let last = last_assistant(messages);
    let stop_reason = last
        .and_then(|last| last["stopReason"].as_str())
        .unwrap_or("stop");
    if last.is_some_and(|last| last["retryBlocked"] == true) {
        let mut outcome = json!({"stopReason": stop_reason, "retryBlocked": true});
        if let Some(error) = last.and_then(|last| last.get("errorMessage")) {
            outcome["errorMessage"] = error.clone();
        }
        return outcome;
    }
    if let Some(error) = last
        .and_then(|last| last["errorMessage"].as_str())
        .filter(|error| !error.is_empty())
    {
        return json!({"stopReason": stop_reason, "errorMessage": error});
    }
    let content = last.and_then(|last| last.get("content"));
    let text = match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| part["type"].as_str() == Some("text"))
            .map(|part| js_join_text(part.get("text")))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    let text = crate::fs::order::js_trim(&text);
    if text.is_empty() {
        json!({"stopReason": stop_reason})
    } else {
        json!({"stopReason": stop_reason, "reply": crate::json::utf16_prefix(text, RUN_REPLY_PREVIEW_CHARS)})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAPTURED: &str = include_str!("run-captured.json");

    /// The table of `run-captured.json`: each case starts from an idle run and applies its steps in order; every step
    /// gives what `trackRunEvent` / `settleRun` / `runReading` / `runFromReading` answered and the state after it.
    #[test]
    fn captured() {
        let table: Value = serde_json::from_str(CAPTURED).expect("captured rows");
        let mut serial = 0;
        let mut steps = 0;
        for case in table["cases"].as_array().expect("cases") {
            let mut tracking = Tracking::default();
            for step in case["steps"].as_array().expect("steps") {
                let now = step["now"].as_i64().expect("now");
                let mut got = Map::new();
                match step["op"].as_str().expect("op") {
                    "event" => {
                        let ended = tracking.track(&step["event"], now, &mut serial, false);
                        got.insert("ended".into(), Value::from(ended));
                    }
                    "settle" => tracking
                        .run
                        .settle(step["settled"].as_bool().expect("settled"), now),
                    "reading" => {
                        got.insert("reading".into(), tracking.run.reading(now));
                    }
                    "fromReading" => {
                        let kept = step["keep"]
                            .as_bool()
                            .expect("keep")
                            .then(|| tracking.run.clone());
                        tracking.run = RunState::from_reading(&step["reading"], kept.as_ref(), now);
                    }
                    "stop" => tracking.stopped = true,
                    other => panic!("unknown op {other}"),
                }
                got.insert("run".into(), tracking.run.to_value());
                got.insert(
                    "lastRun".into(),
                    tracking.last_outcome().cloned().unwrap_or(Value::Null),
                );
                got.insert("stopped".into(), Value::from(tracking.stopped));
                got.insert(
                    "retry".into(),
                    tracking.retry.as_ref().map_or(
                        Value::Null,
                        |retry| json!({"errorMessage": retry.error_message}),
                    ),
                );
                assert_eq!(
                    Value::Object(got),
                    step["expect"],
                    "{} step {}",
                    case["name"],
                    step
                );
                steps += 1;
            }
        }
        assert!(steps > 1000, "only {steps} captured steps");
    }

    /// The one place the Rust copy differs on purpose: a reply cut inside a surrogate pair keeps JavaScript's half,
    /// which a Rust string cannot hold (the page shows a lone surrogate as U+FFFD, so this sends that).
    #[test]
    fn a_reply_cut_inside_a_pair_ends_in_the_replacement_character() {
        let reply = format!("{}😀tail", "a".repeat(3999));
        let outcome = run_outcome(Some(&json!([{"role": "assistant", "content": reply}])));
        assert_eq!(
            outcome["reply"],
            Value::from(format!("{}\u{fffd}", "a".repeat(3999)))
        );
        let whole = format!("{}😀tail", "a".repeat(3998));
        let outcome = run_outcome(Some(&json!([{"role": "assistant", "content": whole}])));
        assert_eq!(
            outcome["reply"],
            Value::from(format!("{}😀", "a".repeat(3998)))
        );
    }

    #[test]
    fn a_retry_gets_a_new_serial_each_start() {
        let mut serial = 0;
        let mut tracking = Tracking::default();
        let start = json!({"type": "auto_retry_start", "errorMessage": "x"});
        tracking.track(&start, 1, &mut serial, false);
        let first = tracking.retry.as_ref().map(|retry| retry.serial);
        tracking.track(&start, 2, &mut serial, false);
        assert_ne!(first, tracking.retry.as_ref().map(|retry| retry.serial));
    }

    #[test]
    fn an_outcome_keeps_its_serial_until_the_next_run_ends() {
        let mut serial = 0;
        let mut tracking = Tracking::default();
        let failed = json!({
            "type": "agent_end",
            "messages": [{"role": "assistant", "content": [], "stopReason": "error", "errorMessage": "x"}]
        });
        tracking.track(&json!({"type": "agent_start"}), 1, &mut serial, false);
        assert!(tracking.track(&failed, 2, &mut serial, false));
        let first = tracking.close_observation().unwrap().0;
        assert_ne!(first, 0);
        // Events that are not the run's end leave the outcome and its serial as they are.
        tracking.track(
            &json!({"type": "auto_compaction_end"}),
            3,
            &mut serial,
            false,
        );
        assert_eq!(tracking.close_observation(), Some((first, None)));
        // The same words after a new run are another outcome.
        tracking.track(&json!({"type": "agent_start"}), 4, &mut serial, false);
        assert!(tracking.last_outcome().is_none());
        assert!(tracking.track(&failed, 5, &mut serial, false));
        assert_ne!(tracking.close_observation().unwrap().0, first);
    }

    #[test]
    fn a_manual_compaction_is_compacting_until_its_end() {
        let mut run = RunState::default();
        let start = json!({"type": "manual_compaction_start", "mode": "handoff"});
        let skipped = json!({"type": "manual_compaction_end", "aborted": false, "skipped": true});
        assert!(!run.apply(&start, 1));
        assert_eq!(run.compacting, Some(true));
        assert!(run.busy());
        assert!(!run.apply(&skipped, 2));
        assert_eq!(run.compacting, Some(false));
        assert!(!run.busy());
    }
}
