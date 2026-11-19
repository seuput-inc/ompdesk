//! How far each app page got through the profile-migration page (`/__profile/migrate`), and what to do when it stops.
//! A step with no next step within `STEP_TIMEOUT` is retried by loading the page again, `ATTEMPTS` times in all, then
//! given up with its reason shown in the window. Windows e2e saw the page's own request sent and never answered, the
//! window stuck on it for good (nightly 44612826698, rc 44581968887).

use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const STEP_TIMEOUT: Duration = Duration::from_secs(10);
pub const ATTEMPTS: u32 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// The host sent the window to the page.
    Navigate,
    /// The page's request was answered (`assets.rs`).
    Served,
    /// The page's document started (WebView2's `ContentLoading`).
    Loading,
    Loaded,
    /// The page asked for the old profile's Local Storage and got it.
    Read,
    /// The host sent the window on to the app page.
    Handover,
}

impl Step {
    pub fn name(self) -> &'static str {
        match self {
            Step::Navigate => "navigate",
            Step::Served => "served",
            Step::Loading => "loading",
            Step::Loaded => "loaded",
            Step::Read => "read",
            Step::Handover => "handover",
        }
    }
}

struct Watch {
    round: u64,
    attempt: u32,
    step: Step,
    at: Instant,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Due {
    /// The round ended: the app page started, the page showed its own error, or the window closed.
    Ended,
    Wait(Duration),
    Retry {
        attempt: u32,
        after: Step,
    },
    GiveUp {
        after: Step,
    },
}

#[derive(Default)]
pub struct Watches {
    pages: HashMap<u64, Watch>,
    rounds: u64,
}

impl Watches {
    /// Records `step` for `wc`, starting a round when none runs; the new round's number, for its timer.
    pub fn start(&mut self, wc: u64, step: Step, now: Instant) -> (Option<u64>, u32) {
        if let Some(attempt) = self.step(wc, step, now) {
            return (None, attempt);
        }
        self.rounds += 1;
        let round = self.rounds;
        self.pages.insert(
            wc,
            Watch {
                round,
                attempt: 1,
                step,
                at: now,
            },
        );
        (Some(round), 1)
    }

    /// Records `step` of a running round; its attempt, or `None` when `wc` is not watched.
    pub fn step(&mut self, wc: u64, step: Step, now: Instant) -> Option<u32> {
        let watch = self.pages.get_mut(&wc)?;
        watch.step = step;
        watch.at = now;
        Some(watch.attempt)
    }

    pub fn end(&mut self, wc: u64) -> Option<(u32, Step)> {
        self.pages
            .remove(&wc)
            .map(|watch| (watch.attempt, watch.step))
    }

    /// What `round`'s timer does now. A retry counts as the next attempt's first step; a give-up ends the round.
    pub fn due(&mut self, wc: u64, round: u64, now: Instant) -> Due {
        let Some(watch) = self.pages.get_mut(&wc).filter(|watch| watch.round == round) else {
            return Due::Ended;
        };
        let waited = now.saturating_duration_since(watch.at);
        if waited < STEP_TIMEOUT {
            return Due::Wait(STEP_TIMEOUT - waited);
        }
        let after = watch.step;
        if watch.attempt < ATTEMPTS {
            watch.attempt += 1;
            watch.step = Step::Navigate;
            watch.at = now;
            return Due::Retry {
                attempt: watch.attempt,
                after,
            };
        }
        self.pages.remove(&wc);
        Due::GiveUp { after }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_step_without_a_next_is_retried_then_given_up() {
        let mut watches = Watches::default();
        let t0 = Instant::now();
        let (round, attempt) = watches.start(7, Step::Navigate, t0);
        let round = round.expect("a new round");
        assert_eq!(attempt, 1);
        assert_eq!(
            watches.due(7, round, t0 + Duration::from_secs(4)),
            Due::Wait(Duration::from_secs(6))
        );
        // Progress restarts the step's time.
        assert_eq!(
            watches.step(7, Step::Served, t0 + Duration::from_secs(9)),
            Some(1)
        );
        assert_eq!(
            watches.due(7, round, t0 + Duration::from_secs(12)),
            Due::Wait(Duration::from_secs(7))
        );
        let t1 = t0 + Duration::from_secs(19);
        assert_eq!(
            watches.due(7, round, t1),
            Due::Retry {
                attempt: 2,
                after: Step::Served
            }
        );
        // The page loading again joins the running round.
        assert_eq!(watches.start(7, Step::Loading, t1), (None, 2));
        let t2 = t1 + STEP_TIMEOUT;
        assert_eq!(
            watches.due(7, round, t2),
            Due::Retry {
                attempt: 3,
                after: Step::Loading
            }
        );
        assert_eq!(
            watches.due(7, round, t2 + STEP_TIMEOUT),
            Due::GiveUp {
                after: Step::Navigate
            }
        );
        assert_eq!(watches.due(7, round, t2 + STEP_TIMEOUT), Due::Ended);
        // The person's Retry starts a new round.
        assert!(matches!(
            watches.start(7, Step::Loading, t2 + STEP_TIMEOUT),
            (Some(next), 1) if next != round
        ));
    }

    #[test]
    fn an_ended_round_stops_its_timer_and_others_are_untouched() {
        let mut watches = Watches::default();
        let now = Instant::now();
        let (first, _) = watches.start(1, Step::Navigate, now);
        let (second, _) = watches.start(2, Step::Navigate, now);
        assert_eq!(watches.end(1), Some((1, Step::Navigate)));
        let late = now + STEP_TIMEOUT;
        assert_eq!(watches.due(1, first.unwrap(), late), Due::Ended);
        assert_eq!(
            watches.due(2, second.unwrap(), late),
            Due::Retry {
                attempt: 2,
                after: Step::Navigate
            }
        );
        assert_eq!(watches.step(1, Step::Served, late), None);
    }
}
