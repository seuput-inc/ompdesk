//! What an opener hears of a child it opened besides the child's own reports and its done report: a turn that failed
//! with nothing to retry it, an omp that stopped for good, a provider retry, a wait for a usage limit or a backoff
//! retry, background work that keeps the child past `background_note_ms`, and a question the opener ended its turn
//! without answering. Each is told once: per turn (`turn:` keys, cleared when the next turn is seen starting), per
//! dispatch (a retry that comes back every ten minutes is told once), or until the omp is up again.
//!
//! After Orca's worker observation (stablyai/orca, MIT: `src/main/runtime/orchestration/workers/turn-stops/`
//! `worker-background-waits.ts`, `chat-worker-model-wait.ts`, `chat-worker-error-escalation.ts`,
//! `mailbox/questions/question-reconcile.ts`), re-implemented over OMPdesk's tab facts. Stock omp detects the stalls
//! and runs the retries (`auto_retry_start`, `session/turn-recovery.ts`); this only says so to the opener.
//!
//! Pure: `ChildWatch::step` takes the facts one auto-close pass read and answers what to tell now.

use std::collections::HashSet;

/// What a child does as one pass sees it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Phase {
    #[default]
    Idle,
    /// A turn runs.
    Running,
    /// Its turn ended; stock's background work (subagents, async jobs) still runs.
    Settling,
}

/// A failed turn's own retry main armed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Armed {
    pub at: f64,
    pub attempt: u32,
    pub limit: bool,
}

/// What one pass read of a child and its opener.
#[derive(Clone, Debug, Default)]
pub struct WatchFacts {
    pub phase: Phase,
    /// The opener's current dispatch to it ("" before the first).
    pub dispatch: String,
    /// Its omp exited or failed to start for good (not restarting, not a held session): why.
    pub down: Option<String>,
    /// Its last turn ended `error`: the error.
    pub failed: Option<String>,
    /// Stock's provider retry its running turn is in: attempt, of, error.
    pub retrying: Option<(u32, u32, String)>,
    /// Main's own retry of its failed turn.
    pub armed: Option<Armed>,
    /// It goes on by itself without a retry: a relaunch continues it, or it waits for the connection.
    pub continues: bool,
    /// The question or blocker it waits on that its opener was told of (a card's id, a report's dispatch and kind).
    pub question: Option<String>,
    pub opener_busy: bool,
    /// The opener ended its turn: not busy, not continuing, not waiting on a card of its own.
    pub opener_idle: bool,
    pub now: f64,
    pub failure_settle_ms: f64,
    pub background_note_ms: f64,
}

/// One thing to tell.
#[derive(Clone, Debug, PartialEq)]
pub enum Tell {
    /// The turn failed and nothing retries it: the opener decides (a `blocked` mail that wakes it).
    Failed(String),
    /// Its omp is gone for good (`blocked`).
    Down(String),
    /// Stock retries a failed model request (a quiet note).
    Retrying {
        attempt: u32,
        of: u32,
        error: String,
    },
    /// It waits for a provider's usage limit until `at` (a quiet note).
    Limit { at: f64, error: String },
    /// Main retries its failed turn at `at` (a quiet note).
    Backoff {
        at: f64,
        attempt: u32,
        error: String,
    },
    /// Its background work has kept it this long (a quiet note).
    Background { minutes: u64 },
    /// Its opener ended its turn without answering it: the child is told (a quiet note) and the person notified.
    Unanswered,
}

/// The watch of one child, kept across passes.
#[derive(Clone, Debug, Default)]
pub struct ChildWatch {
    pub phase: Phase,
    pub told: HashSet<String>,
    /// When a pass first saw the failure nothing retried: main may arm its retry a moment after the turn ends, so the
    /// failure stands only once it held for `failure_settle_ms`.
    pub failed_since: Option<f64>,
    pub settling_since: Option<f64>,
    pub question: Option<String>,
    /// The opener ran a turn since the question reached it.
    pub opener_ran: bool,
}

impl ChildWatch {
    pub fn step(&mut self, facts: &WatchFacts) -> Vec<Tell> {
        let mut out = Vec::new();
        if facts.phase == Phase::Running && self.phase != Phase::Running {
            self.told.retain(|key| !key.starts_with("turn:"));
            self.failed_since = None;
        }
        if facts.phase != Phase::Settling {
            self.settling_since = None;
        } else if self.settling_since.is_none() {
            self.settling_since = Some(facts.now);
        }
        self.phase = facts.phase;

        match &facts.down {
            Some(why) => {
                if self.told.insert("down".into()) {
                    out.push(Tell::Down(why.clone()));
                }
            }
            None => {
                self.told.remove("down");
            }
        }

        if let Some((attempt, of, error)) = &facts.retrying
            && self.told.insert("turn:retry".into())
        {
            out.push(Tell::Retrying {
                attempt: *attempt,
                of: *of,
                error: error.clone(),
            });
        }

        let error = facts.failed.clone().unwrap_or_default();
        match facts.armed {
            Some(armed) if armed.limit => {
                if self.told.insert(format!("limit:{}", facts.dispatch)) {
                    out.push(Tell::Limit {
                        at: armed.at,
                        error,
                    });
                }
                self.failed_since = None;
            }
            Some(armed) => {
                if self.told.insert(format!("backoff:{}", facts.dispatch)) {
                    out.push(Tell::Backoff {
                        at: armed.at,
                        attempt: armed.attempt,
                        error,
                    });
                }
                self.failed_since = None;
            }
            None if facts.failed.is_some() && !facts.continues && facts.phase != Phase::Running => {
                let since = *self.failed_since.get_or_insert(facts.now);
                if facts.now - since >= facts.failure_settle_ms
                    && self.told.insert("turn:failed".into())
                {
                    out.push(Tell::Failed(error));
                }
            }
            None => self.failed_since = None,
        }

        if facts.failed.is_none()
            && let Some(since) = self.settling_since
        {
            let waited = facts.now - since;
            if waited >= facts.background_note_ms && self.told.insert("turn:background".into()) {
                out.push(Tell::Background {
                    minutes: (waited / 60_000.0).round() as u64,
                });
            }
        }

        if facts.question != self.question {
            self.question = facts.question.clone();
            self.opener_ran = false;
        }
        if facts.opener_busy {
            self.opener_ran = true;
        }
        if let Some(question) = &self.question
            && facts.opener_idle
            && self.opener_ran
            && self.told.insert(format!("question:{question}"))
        {
            out.push(Tell::Unanswered);
        }
        out
    }
}
