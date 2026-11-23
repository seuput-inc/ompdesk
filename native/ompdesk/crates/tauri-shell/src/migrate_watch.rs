//! How far each app page got through the profile-migration page (`/__profile/migrate`), and what to do when it stops.
//! An allowed WebView2 navigation can spend most of the 30 s round waiting for cookies before the host sees its
//! request. Reloading then cancels that request. Once the host receives it, a stall gets the usual 10 s watchdog.

use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const STEP_TIMEOUT: Duration = Duration::from_secs(10);
pub const ROUND_TIMEOUT: Duration = Duration::from_secs(30);
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

#[derive(Clone, Copy)]
enum Phase {
    /// `Some(id)` is the allowed WebView2 navigation still waiting to reach the request handler.
    BeforeRequest(Option<u64>),
    Watching(Step),
}

impl Phase {
    fn from_step(step: Step) -> Self {
        match step {
            Step::Navigate => Self::BeforeRequest(None),
            _ => Self::Watching(step),
        }
    }

    fn step(self) -> Step {
        match self {
            Self::BeforeRequest(_) => Step::Navigate,
            Self::Watching(step) => step,
        }
    }
}

struct Watch {
    round: u64,
    deadline: Instant,
    attempt: u32,
    phase: Phase,
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
        attempt: u32,
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
                deadline: now + ROUND_TIMEOUT,
                attempt: 1,
                phase: Phase::from_step(step),
                at: now,
            },
        );
        (Some(round), 1)
    }

    /// Records `step` of a running round; its attempt, or `None` when `wc` is not watched.
    pub fn step(&mut self, wc: u64, step: Step, now: Instant) -> Option<u32> {
        let watch = self.pages.get_mut(&wc)?;
        watch.phase = Phase::from_step(step);
        watch.at = now;
        Some(watch.attempt)
    }

    #[cfg(any(windows, test))]
    pub fn navigation_started(&mut self, wc: u64, id: u64) {
        if let Some(Watch {
            phase: Phase::BeforeRequest(current),
            ..
        }) = self.pages.get_mut(&wc)
        {
            *current = Some(id);
        }
    }

    #[cfg(any(windows, test))]
    pub fn navigation_failed(&mut self, wc: u64, id: u64) {
        let Some(watch) = self.pages.get_mut(&wc) else {
            return;
        };
        if matches!(watch.phase, Phase::BeforeRequest(Some(current)) if current == id) {
            watch.phase = Phase::BeforeRequest(None);
        }
    }

    pub fn request_received(&mut self, wc: u64, now: Instant) {
        let Some(watch) = self.pages.get_mut(&wc) else {
            return;
        };
        if matches!(watch.phase, Phase::BeforeRequest(_)) {
            watch.phase = Phase::Watching(Step::Navigate);
            watch.at = now;
        }
    }

    pub fn end(&mut self, wc: u64) -> Option<(u32, Step)> {
        self.pages
            .remove(&wc)
            .map(|watch| (watch.attempt, watch.phase.step()))
    }

    /// What `round`'s timer does now. A retry counts as the next attempt's first step; a give-up ends the round.
    pub fn due(&mut self, wc: u64, round: u64, now: Instant) -> Due {
        let Some(watch) = self.pages.get_mut(&wc).filter(|watch| watch.round == round) else {
            return Due::Ended;
        };
        let after = watch.phase.step();
        let remaining = watch.deadline.saturating_duration_since(now);
        if !remaining.is_zero() {
            let wait = match watch.phase {
                // The handler can receive the request just after this check.
                Phase::BeforeRequest(Some(_)) => STEP_TIMEOUT,
                _ => STEP_TIMEOUT.saturating_sub(now.saturating_duration_since(watch.at)),
            };
            if !wait.is_zero() {
                return Due::Wait(wait.min(remaining));
            }
            if watch.attempt < ATTEMPTS {
                watch.attempt += 1;
                watch.phase = Phase::BeforeRequest(None);
                watch.at = now;
                return Due::Retry {
                    attempt: watch.attempt,
                    after,
                };
            }
        }
        let attempt = watch.attempt;
        self.pages.remove(&wc);
        Due::GiveUp { after, attempt }
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
        let deadline = t0 + Duration::from_secs(30);
        assert_eq!(watches.due(7, round, t2), Due::Wait(Duration::from_secs(1)));
        assert_eq!(
            watches.due(7, round, deadline),
            Due::GiveUp {
                attempt: 3,
                after: Step::Navigate
            }
        );
        assert_eq!(watches.due(7, round, deadline), Due::Ended);
        // The person's Retry starts a new round.
        let (next, attempt) = watches.start(7, Step::Loading, deadline);
        let next = next.unwrap();
        assert_ne!(next, round);
        assert_eq!(attempt, 1);
        assert_eq!(watches.due(7, round, deadline), Due::Ended);
        assert_eq!(watches.due(7, next, deadline), Due::Wait(STEP_TIMEOUT));
    }

    #[test]
    fn a_navigation_waiting_21_seconds_for_cookies_finishes_on_its_first_attempt() {
        let mut watches = Watches::default();
        let start = Instant::now();
        let at = |s| start + Duration::from_secs(s);
        let round = watches.start(7, Step::Navigate, start).0.unwrap();
        watches.navigation_started(7, 41);
        for s in [10, 20] {
            assert_eq!(
                watches.due(7, round, at(s)),
                Due::Wait(Duration::from_secs(10))
            );
        }
        watches.request_received(7, at(21));
        assert_eq!(watches.step(7, Step::Served, at(21)), Some(1));
        assert_eq!(watches.step(7, Step::Handover, at(22)), Some(1));
        assert_eq!(watches.end(7), Some((1, Step::Handover)));
    }

    #[test]
    fn only_the_current_navigation_failure_restores_the_original_retry_time() {
        let mut watches = Watches::default();
        let start = Instant::now();
        let at = |s| start + Duration::from_secs(s);
        let round = watches.start(7, Step::Navigate, start).0.unwrap();
        watches.navigation_started(7, 41);
        watches.navigation_failed(7, 41);
        assert_eq!(
            watches.due(7, round, at(4)),
            Due::Wait(Duration::from_secs(6))
        );
        assert_eq!(
            watches.due(7, round, at(10)),
            Due::Retry {
                attempt: 2,
                after: Step::Navigate
            }
        );
        watches.navigation_started(7, 42);
        watches.navigation_started(7, 43);
        watches.navigation_failed(7, 41);
        watches.navigation_failed(7, 42);
        assert_eq!(
            watches.due(7, round, at(20)),
            Due::Wait(Duration::from_secs(10))
        );
        watches.navigation_failed(7, 43);
        assert_eq!(
            watches.due(7, round, at(21)),
            Due::Retry {
                attempt: 3,
                after: Step::Navigate
            }
        );
    }

    #[test]
    fn only_the_first_receipt_per_attempt_arms_the_navigate_watchdog() {
        let mut watches = Watches::default();
        let start = Instant::now();
        let at = |s| start + Duration::from_secs(s);
        let round = watches.start(7, Step::Navigate, start).0.unwrap();
        watches.navigation_started(7, 41);
        // A receipt can arrive just after the timer went to sleep.
        assert_eq!(
            watches.due(7, round, at(1)),
            Due::Wait(Duration::from_secs(10))
        );
        watches.request_received(7, at(3));
        watches.navigation_failed(7, 41);
        watches.request_received(7, at(8));
        assert_eq!(
            watches.due(7, round, at(11)),
            Due::Wait(Duration::from_secs(2))
        );
        assert_eq!(
            watches.due(7, round, at(13)),
            Due::Retry {
                attempt: 2,
                after: Step::Navigate
            }
        );
        // Receipt also arms the watchdog without a WebView2 start callback.
        watches.request_received(7, at(17));
        assert_eq!(
            watches.due(7, round, at(23)),
            Due::Wait(Duration::from_secs(4))
        );
        assert_eq!(
            watches.due(7, round, at(27)),
            Due::Retry {
                attempt: 3,
                after: Step::Navigate
            }
        );
    }

    #[test]
    fn neither_a_pending_navigation_nor_last_second_progress_extends_the_round() {
        for last_step in [None, Some(Step::Navigate), Some(Step::Loading)] {
            let mut watches = Watches::default();
            let start = Instant::now();
            let at = |s| start + Duration::from_secs(s);
            let round = watches.start(7, Step::Navigate, start).0.unwrap();
            watches.navigation_started(7, 41);
            if let Some(step) = last_step {
                if step == Step::Navigate {
                    watches.request_received(7, at(29));
                } else {
                    assert_eq!(watches.start(7, step, at(29)), (None, 1));
                    watches.request_received(7, at(29));
                }
            }
            assert_eq!(
                watches.due(7, round, at(29)),
                Due::Wait(Duration::from_secs(1))
            );
            assert_eq!(
                watches.due(7, round, at(30)),
                Due::GiveUp {
                    attempt: 1,
                    after: last_step.unwrap_or(Step::Navigate)
                }
            );
            assert_eq!(watches.due(7, round, at(30)), Due::Ended);
        }
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
