//! Crash and demand-revive budgets for the app's MCP hub and stats server.

use std::time::{Duration, Instant};

use crate::sidecar::{MAX_RESTART_ATTEMPTS, restart_delay};

const MAX_REVIVE_ROUNDS: u8 = 3;
const REVIVE_COOLDOWN: Duration = Duration::from_secs(30);

#[derive(Default)]
pub(crate) struct RestartBudget {
    attempts: u32,
    rounds: u8,
    last_revive: Option<Instant>,
}

impl RestartBudget {
    pub(crate) fn note_ready(&mut self) {
        *self = Self::default();
    }

    pub(crate) fn next_delay(&mut self) -> Option<Duration> {
        if self.attempts >= MAX_RESTART_ATTEMPTS {
            return None;
        }
        self.attempts += 1;
        Some(restart_delay(self.attempts))
    }

    pub(crate) fn revive(&mut self, now: Instant) -> &'static str {
        if self.rounds >= MAX_REVIVE_ROUNDS {
            return "exhausted";
        }
        if self
            .last_revive
            .is_some_and(|last| now.duration_since(last) < REVIVE_COOLDOWN)
        {
            return "already-pending";
        }
        self.rounds += 1;
        self.last_revive = Some(now);
        self.attempts = 0;
        "scheduled"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_revive_has_its_own_ladder_but_needs_demand_after_cooldown() {
        let mut budget = RestartBudget::default();
        let start = Instant::now();
        for round in 0..=3 {
            for ms in [1000, 2000, 4000] {
                assert_eq!(budget.next_delay(), Some(Duration::from_millis(ms)));
            }
            assert_eq!(budget.next_delay(), None);
            assert_eq!(budget.next_delay(), None);
            let now = start + Duration::from_secs(round * 30);
            if (1..3).contains(&round) {
                assert_eq!(
                    budget.revive(now - Duration::from_millis(1)),
                    "already-pending"
                );
            }
            assert_eq!(
                budget.revive(now),
                if round < 3 { "scheduled" } else { "exhausted" }
            );
        }
        assert_eq!(budget.revive(start + Duration::from_secs(120)), "exhausted");
    }

    #[test]
    fn a_successful_bind_resets_both_budgets_and_the_cooldown() {
        let mut budget = RestartBudget::default();
        let now = Instant::now();
        for n in 0..3 {
            assert_eq!(
                budget.revive(now + Duration::from_secs(30 * n)),
                "scheduled"
            );
        }
        assert_eq!(budget.next_delay(), Some(Duration::from_secs(1)));
        assert_eq!(budget.next_delay(), Some(Duration::from_secs(2)));
        budget.note_ready();
        assert_eq!(budget.next_delay(), Some(Duration::from_secs(1)));
        assert_eq!(budget.revive(now + Duration::from_secs(60)), "scheduled");
    }
}
