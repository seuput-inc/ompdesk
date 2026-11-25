use super::marker::STEP_HISTORY;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::Arc;

const HANG_TIMEOUT_MS: u64 = 5_000;
const SLEEP_GAP_MS: u64 = 3_000;

struct Incident {
    steps: Arc<VecDeque<String>>,
    unresponsive_ms: u64,
    self_recovered: bool,
    machine: Option<Value>,
}

pub(super) struct Engine {
    pid: u32,
    last_beat: u64,
    last_tick: u64,
    suspended: bool,
    steps: Arc<VecDeque<String>>,
    incident: Option<Incident>,
}

impl Engine {
    pub(super) fn new(now_ms: u64, pid: u32) -> Self {
        Self {
            pid,
            last_beat: now_ms,
            last_tick: now_ms,
            suspended: false,
            steps: Arc::new(VecDeque::with_capacity(STEP_HISTORY)),
            incident: None,
        }
    }

    pub(super) fn step(&mut self, phase: &str, step: &str) {
        let steps = Arc::make_mut(&mut self.steps);
        let mut label = if steps.len() == STEP_HISTORY {
            steps.pop_front().unwrap_or_default()
        } else {
            String::new()
        };
        label.clear();
        label.reserve(phase.len() + 1 + step.len());
        label.push_str(phase);
        label.push(':');
        label.push_str(step);
        steps.push_back(label);
    }

    pub(super) fn suspend(&mut self) {
        self.suspended = true;
    }

    pub(super) fn resume(&mut self, now_ms: u64) {
        self.suspended = false;
        self.last_beat = now_ms;
        self.last_tick = now_ms;
    }

    pub(super) fn heartbeat(&mut self, now_ms: u64) -> bool {
        let previous = std::mem::replace(&mut self.last_beat, now_ms);
        if let Some(incident) = &mut self.incident
            && !incident.self_recovered
        {
            incident.unresponsive_ms = now_ms.saturating_sub(previous);
            incident.self_recovered = true;
            return true;
        }
        false
    }

    pub(super) fn tick(&mut self, now_ms: u64) -> bool {
        let previous = std::mem::replace(&mut self.last_tick, now_ms);
        if self.suspended || self.incident.as_ref().is_some_and(|i| !i.self_recovered) {
            return false;
        }
        if now_ms.saturating_sub(previous) > SLEEP_GAP_MS {
            self.last_beat = now_ms;
            return false;
        }
        let unresponsive_ms = now_ms.saturating_sub(self.last_beat);
        if unresponsive_ms <= HANG_TIMEOUT_MS {
            return false;
        }
        self.incident = Some(Incident {
            steps: Arc::clone(&self.steps),
            unresponsive_ms,
            self_recovered: false,
            machine: None,
        });
        true
    }

    // The sampling deadline belongs to the runtime. Recovery does not cancel that sample.
    pub(super) fn machine(&mut self, facts: Value) {
        if let Some(incident) = &mut self.incident {
            incident.machine = Some(facts);
        }
    }

    pub(super) fn marker(&self, now_epoch_ms: u64) -> Value {
        let Some(incident) = &self.incident else {
            return Value::Null;
        };
        let phase = incident
            .steps
            .back()
            .and_then(|label| label.split_once(':'))
            .map_or("startup", |(phase, _)| phase);
        let mut marker = json!({
            "detectedAt": now_epoch_ms,
            "pid": self.pid,
            "unresponsiveMs": incident.unresponsive_ms,
            "selfRecovered": incident.self_recovered,
            "phase": phase,
            "steps": *incident.steps,
        });
        if let Some(facts) = &incident.machine {
            marker["machine"] = facts.clone();
        }
        marker
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthy_heartbeats_do_not_write_a_marker() {
        let mut engine = Engine::new(0, 7);
        for now in (1_000..=30_000).step_by(1_000) {
            assert!(!engine.heartbeat(now));
            assert!(!engine.tick(now));
        }
        assert_eq!(engine.marker(30_000), Value::Null);
    }

    #[test]
    fn a_stall_is_reported_once_and_the_next_stall_gets_a_fresh_marker() {
        let mut engine = Engine::new(0, 42);
        assert!(!engine.heartbeat(1_000));
        assert!(!engine.tick(3_000));
        assert!(!engine.tick(6_000)); // Exactly five seconds without a beat, three between ticks.
        assert!(engine.tick(6_001));
        assert_eq!(
            engine.marker(1_700_000_000_000),
            json!({
                "detectedAt": 1_700_000_000_000u64, "pid": 42, "unresponsiveMs": 5_001,
                "selfRecovered": false, "phase": "startup", "steps": []
            })
        );
        engine.machine(json!({"availMB": 512}));
        for now in (7_000..=20_000).step_by(1_000) {
            assert!(!engine.tick(now));
        }
        assert!(engine.heartbeat(20_100));
        let recovered = engine.marker(1_700_000_014_099);
        assert_eq!(recovered["detectedAt"], 1_700_000_014_099u64);
        assert_eq!(recovered["unresponsiveMs"], 19_100);
        assert_eq!(recovered["selfRecovered"], true);
        assert_eq!(recovered["machine"], json!({"availMB": 512}));
        assert!(!engine.heartbeat(20_101));
        for now in (21_000..=25_000).step_by(1_000) {
            assert!(!engine.tick(now));
        }
        assert!(engine.tick(25_102));
        let next = engine.marker(1_700_000_019_101);
        assert_eq!(next["selfRecovered"], false);
        assert_eq!(next["unresponsiveMs"], 5_001);
        assert!(next.get("machine").is_none());
    }

    #[test]
    fn a_missed_tick_or_explicit_resume_starts_a_fresh_timeout() {
        for explicit in [false, true] {
            let mut engine = Engine::new(0, 4);
            assert!(!engine.tick(3_000));
            assert!(!engine.tick(5_000));
            if explicit {
                engine.suspend();
                assert!(!engine.tick(5_001));
                engine.resume(8_001);
            } else {
                assert!(!engine.tick(8_001)); // 3,001 ms since the last tick.
            }
            assert!(!engine.tick(10_001));
            assert!(!engine.tick(13_001));
            assert!(engine.tick(13_002));
            assert_eq!(engine.marker(20_000)["unresponsiveMs"], 5_001);
        }
    }

    #[test]
    fn a_gap_during_a_reported_stall_does_not_reset_its_duration() {
        let mut engine = Engine::new(0, 8);
        assert!(!engine.tick(3_000));
        assert!(engine.tick(6_000));
        assert!(!engine.tick(40_000));
        assert!(engine.heartbeat(41_000));
        assert_eq!(engine.marker(41_000)["unresponsiveMs"], 41_000);
    }

    #[test]
    fn sample_after_recovery_keeps_the_steps_that_stalled() {
        let mut engine = Engine::new(0, 7);
        for i in 0..11 {
            engine.step("startup", &format!("step-{i}"));
        }
        engine.step("quit", "teardown:sidecars");
        assert!(!engine.tick(2_000));
        assert!(!engine.tick(4_000));
        assert!(engine.tick(6_000));
        engine.step("update", "install");
        assert!(engine.heartbeat(6_400));
        assert!(engine.marker(6_400).get("machine").is_none());
        engine.machine(json!({"cpuBusyPct": 99.5}));
        assert_eq!(
            engine.marker(7_000),
            json!({
                "detectedAt": 7_000, "pid": 7, "unresponsiveMs": 6_400, "selfRecovered": true,
                "phase": "quit", "steps": ["startup:step-4", "startup:step-5", "startup:step-6",
                    "startup:step-7", "startup:step-8", "startup:step-9", "startup:step-10",
                    "quit:teardown:sidecars"], "machine": {"cpuBusyPct": 99.5}
            })
        );
    }
}
