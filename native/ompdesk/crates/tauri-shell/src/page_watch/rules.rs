//! The page watch's timing rules as plain state: no clock of its own, no engine, no host.

use std::time::{Duration, Instant};

/// A page is asked again this long after its last probe was sent.
pub const PROBE_EVERY: Duration = Duration::from_secs(5);
/// A probe unanswered this long makes the page `unresponsive`.
pub const UNRESPONSIVE_AFTER: Duration = Duration::from_secs(20);
/// A load holds probes off this long at most, so a page frozen while it loads is still noticed.
pub const LOAD_GRACE: Duration = Duration::from_secs(30);
/// The most one turn counts. A turn that comes later than this was the computer asleep or the host's UI thread held,
/// and the page had no chance to answer in that time.
pub const TURN_LIMIT: Duration = Duration::from_secs(2);

/// Measures the turns of the watch.
#[derive(Default)]
pub struct Clock(Option<Instant>);

impl Clock {
    pub const fn new() -> Self {
        Self(None)
    }

    /// The time this turn counts: what passed since the last one, at most [`TURN_LIMIT`]; nothing for the first.
    pub fn step(&mut self, now: Instant) -> Duration {
        let step = self.0.map_or(Duration::ZERO, |last| {
            now.saturating_duration_since(last).min(TURN_LIMIT)
        });
        self.0 = Some(now);
        step
    }
}

/// What the page is doing at a turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activity {
    Settled,
    Loading,
    /// Its Web Inspector is open: a script paused there answers nothing, and that is not a frozen page.
    Inspected,
}

/// What a turn asks of the host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Send this probe.
    Probe(u64),
    /// Tell Node the page is `unresponsive`.
    Unresponsive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
enum Phase {
    /// No document to ask: before the first load, and after the content process ended.
    #[default]
    Empty,
    /// No probe is out; the last one was sent `since` ago.
    Resting { since: Duration },
    /// Probe `id` is out and has not answered for `waited`.
    Asked { id: u64, waited: Duration },
}

/// One app page's watch.
#[derive(Debug, Default)]
pub struct Watch {
    phase: Phase,
    last_probe: u64,
    /// Node heard `unresponsive` and not yet `responsive`.
    unresponsive: bool,
    /// The host asked for this content process to end (`forcefullyCrashRenderer`).
    killing: bool,
}

impl Watch {
    /// A document started in the page: it is asked from now on.
    pub fn document_started(&mut self) {
        self.killing = false;
        if self.phase == Phase::Empty {
            self.phase = Phase::Resting {
                since: Duration::ZERO,
            };
        }
    }

    /// `step` more time passed (see [`Clock::step`]).
    pub fn turn(&mut self, step: Duration, activity: Activity) -> Option<Step> {
        match &mut self.phase {
            Phase::Empty => None,
            Phase::Resting { since } => {
                *since = since.saturating_add(step);
                let due = match activity {
                    Activity::Settled => *since >= PROBE_EVERY,
                    Activity::Loading => *since >= LOAD_GRACE,
                    Activity::Inspected => false,
                };
                if !due {
                    return None;
                }
                self.last_probe += 1;
                self.phase = Phase::Asked {
                    id: self.last_probe,
                    waited: Duration::ZERO,
                };
                Some(Step::Probe(self.last_probe))
            }
            Phase::Asked { waited, .. } => {
                if activity == Activity::Inspected {
                    return None;
                }
                *waited = waited.saturating_add(step);
                if self.unresponsive || *waited < UNRESPONSIVE_AFTER {
                    return None;
                }
                self.unresponsive = true;
                Some(Step::Unresponsive)
            }
        }
    }

    /// The page answered probe `id`. True when Node must hear `responsive`.
    pub fn answered(&mut self, id: u64) -> bool {
        self.settle(id) && std::mem::take(&mut self.unresponsive)
    }

    /// Probe `id` ended with no answer from the page (the engine refused it, or the content process ended).
    pub fn failed(&mut self, id: u64) {
        self.settle(id);
    }

    fn settle(&mut self, id: u64) -> bool {
        match self.phase {
            Phase::Asked { id: out, waited } if out == id => {
                self.phase = Phase::Resting { since: waited };
                true
            }
            _ => false,
        }
    }

    /// The engine itself reported the page unresponsive (WebView2 only). True when Node must hear `unresponsive`.
    #[cfg_attr(not(any(windows, test)), allow(dead_code))]
    pub fn engine_unresponsive(&mut self) -> bool {
        self.phase != Phase::Empty && !std::mem::replace(&mut self.unresponsive, true)
    }

    /// The host is about to end this page's content process; `false` takes back a kill that failed.
    pub fn killing(&mut self, on: bool) {
        self.killing = on;
    }

    /// The content process ended, and its document with it. True when the host ended it itself.
    pub fn process_gone(&mut self) -> bool {
        self.phase = Phase::Empty;
        self.unresponsive = false;
        std::mem::take(&mut self.killing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECOND: Duration = Duration::from_secs(1);

    fn loaded() -> Watch {
        let mut watch = Watch::default();
        watch.document_started();
        watch
    }

    /// What each of `seconds` one-second turns asked for.
    fn turns(watch: &mut Watch, seconds: u64, activity: Activity) -> Vec<(u64, Step)> {
        (1..=seconds)
            .filter_map(|second| watch.turn(SECOND, activity).map(|step| (second, step)))
            .collect()
    }

    #[test]
    fn a_settled_page_is_asked_every_five_seconds() {
        let mut watch = loaded();
        assert_eq!(
            turns(&mut watch, 5, Activity::Settled),
            [(5, Step::Probe(1))]
        );
        assert!(!watch.answered(1));
        assert_eq!(
            turns(&mut watch, 5, Activity::Settled),
            [(5, Step::Probe(2))]
        );
    }

    #[test]
    fn no_second_probe_goes_out_while_one_is_unanswered() {
        let mut watch = loaded();
        let asked = turns(&mut watch, 60, Activity::Settled);
        assert_eq!(asked, [(5, Step::Probe(1)), (25, Step::Unresponsive)]);
    }

    #[test]
    fn a_probe_unanswered_for_twenty_seconds_is_unresponsive_once_and_its_answer_is_responsive_once()
     {
        let mut watch = loaded();
        turns(&mut watch, 5, Activity::Settled);
        assert_eq!(turns(&mut watch, 19, Activity::Settled), []);
        assert_eq!(
            watch.turn(SECOND, Activity::Settled),
            Some(Step::Unresponsive)
        );
        assert_eq!(turns(&mut watch, 600, Activity::Settled), []);
        assert!(watch.answered(1));
        assert!(!watch.answered(1));
        assert_eq!(
            turns(&mut watch, 5, Activity::Settled),
            [(1, Step::Probe(2))]
        );
        assert!(!watch.answered(2));
    }

    #[test]
    fn a_slow_answer_inside_twenty_seconds_tells_node_nothing() {
        let mut watch = loaded();
        turns(&mut watch, 5, Activity::Settled);
        assert_eq!(turns(&mut watch, 19, Activity::Settled), []);
        assert!(!watch.answered(1));
    }

    #[test]
    fn a_loading_page_is_not_asked_until_its_load_ends() {
        let mut watch = loaded();
        assert_eq!(turns(&mut watch, 29, Activity::Loading), []);
        assert_eq!(watch.turn(SECOND, Activity::Settled), Some(Step::Probe(1)));
    }

    #[test]
    fn a_load_that_never_ends_is_asked_after_its_grace() {
        let mut watch = loaded();
        assert_eq!(
            turns(&mut watch, 60, Activity::Loading),
            [(30, Step::Probe(1)), (50, Step::Unresponsive)]
        );
    }

    #[test]
    fn an_inspected_page_is_neither_asked_nor_timed() {
        let mut watch = loaded();
        assert_eq!(turns(&mut watch, 600, Activity::Inspected), []);
        assert_eq!(watch.turn(SECOND, Activity::Settled), Some(Step::Probe(1)));
        turns(&mut watch, 19, Activity::Settled);
        assert_eq!(turns(&mut watch, 600, Activity::Inspected), []);
        assert_eq!(
            watch.turn(SECOND, Activity::Settled),
            Some(Step::Unresponsive)
        );
    }

    #[test]
    fn a_page_with_no_document_is_not_asked() {
        let mut watch = Watch::default();
        assert_eq!(turns(&mut watch, 600, Activity::Settled), []);
        watch.document_started();
        assert_eq!(
            turns(&mut watch, 5, Activity::Settled),
            [(5, Step::Probe(1))]
        );
    }

    #[test]
    fn a_gone_content_process_ends_its_probe_until_the_next_document() {
        let mut watch = loaded();
        turns(&mut watch, 25, Activity::Settled);
        assert!(!watch.process_gone());
        assert_eq!(turns(&mut watch, 600, Activity::Settled), []);
        assert!(!watch.answered(1), "the dead document's probe says nothing");
        watch.document_started();
        assert_eq!(
            turns(&mut watch, 5, Activity::Settled),
            [(5, Step::Probe(2))]
        );
        assert!(
            !watch.answered(2),
            "the reloaded page was never unresponsive"
        );
    }

    #[test]
    fn a_process_the_host_ended_is_killed_and_any_other_is_not() {
        let mut watch = loaded();
        watch.killing(true);
        assert!(watch.process_gone());
        assert!(!watch.process_gone());
        watch.killing(true);
        watch.killing(false);
        assert!(!watch.process_gone(), "a kill that failed is not the cause");
        watch.killing(true);
        watch.document_started();
        assert!(
            !watch.process_gone(),
            "a kill that ended nothing does not name a later crash"
        );
    }

    #[test]
    fn a_probe_the_engine_refused_is_sent_again_and_takes_nothing_back() {
        let mut watch = loaded();
        turns(&mut watch, 25, Activity::Settled);
        watch.failed(1);
        assert_eq!(watch.turn(SECOND, Activity::Settled), Some(Step::Probe(2)));
        assert_eq!(
            turns(&mut watch, 600, Activity::Settled),
            [],
            "unresponsive is told once"
        );
        assert!(watch.answered(2));
    }

    #[test]
    fn an_answer_to_another_probe_changes_nothing() {
        let mut watch = loaded();
        turns(&mut watch, 25, Activity::Settled);
        assert!(!watch.answered(7));
        watch.failed(7);
        assert_eq!(turns(&mut watch, 600, Activity::Settled), []);
        assert!(watch.answered(1));
    }

    #[test]
    fn the_engines_own_report_is_unresponsive_once_and_the_next_answer_takes_it_back() {
        let mut watch = loaded();
        assert!(watch.engine_unresponsive());
        assert!(!watch.engine_unresponsive());
        assert_eq!(
            turns(&mut watch, 60, Activity::Settled),
            [(5, Step::Probe(1))]
        );
        assert!(watch.answered(1));
        assert!(!Watch::default().engine_unresponsive());
    }

    #[test]
    fn a_turn_after_a_sleep_counts_as_one_turn() {
        let start = Instant::now();
        let mut clock = Clock::new();
        assert_eq!(clock.step(start), Duration::ZERO);
        assert_eq!(clock.step(start + SECOND), SECOND);
        assert_eq!(clock.step(start + Duration::from_secs(3600)), TURN_LIMIT);
        assert_eq!(
            clock.step(start + Duration::from_secs(3600)),
            Duration::ZERO
        );
        assert_eq!(clock.step(start), Duration::ZERO, "a clock never runs back");
    }

    #[test]
    fn a_probe_out_across_a_sleep_is_not_unresponsive() {
        let start = Instant::now();
        let mut clock = Clock::new();
        let mut watch = loaded();
        let mut asked = Vec::new();
        for second in [0, 1, 2, 3, 4, 5, 6, 3600, 3601] {
            let step = clock.step(start + Duration::from_secs(second));
            asked.extend(watch.turn(step, Activity::Settled));
        }
        assert_eq!(asked, [Step::Probe(1)]);
    }
}
