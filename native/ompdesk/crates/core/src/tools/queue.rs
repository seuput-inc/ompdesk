//! The one queue of the `tools` kind: every install, detection and updater pass runs here, one at a time, in the
//! order asked (was setup's `#queue` and the three `UpdateScheduler` chains, `serial-chain.ts`).
//!
//! A step is a future the queue owns. Past its bound ([`STEP_MAX_MS`], on the instance's clock) or when the instance
//! closes, the queue drops it: nothing it would still do happens, which is the fence `throwIfStepStalled` and
//! `fencedCall` were. What it started outside the process (a supervised installer, a download) it registered with
//! [`Ctx::on_stop`]; those stops run when the step ends, however it ends, so a stopped step never leaves an installer
//! running for the next one to meet (Finding 4: a stopped updater step aborted the setup step it nested but never
//! cancelled its installer, and the next install failed "An install is already running").
//!
//! A step that needs an install (an updater pass that updates a tool) runs it inline with its own `Ctx`, never as a
//! second queued step: there is no nested step to fence, and waiting on the queue from inside a step would wait for
//! itself.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

use serde_json::Value;
use tokio::sync::{Notify, oneshot};

use super::clock::Clock;
use crate::hub::LocalFuture;
use crate::server::Fault;

/// The longest one step runs (`SETUP_STEP_MAX_MS`, `UPDATE_STEP_MAX_MS`).
pub const STEP_MAX_MS: u64 = 30 * 60_000;

/// What a step is, for joining and for the `chain-stall` line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepKind {
    Detect,
    Install,
    OmpPass,
    CliPass,
    ExtPass,
}

impl StepKind {
    /// The chain a stall line names: the TypeScript chain this kind of step ran on.
    pub fn chain(self) -> &'static str {
        match self {
            StepKind::Detect | StepKind::Install => "machine setup",
            StepKind::OmpPass | StepKind::CliPass | StepKind::ExtPass => "update scheduler",
        }
    }
}

pub type Answer = Result<Value, Fault>;
pub type Work = Box<dyn FnOnce(Ctx) -> LocalFuture<Answer>>;

pub struct Step {
    pub label: String,
    pub kind: StepKind,
    pub work: Work,
}

/// What a running step holds of the queue: the stops of what it started, and the person's Cancel.
#[derive(Clone, Default)]
pub struct Ctx(Rc<CtxInner>);

#[derive(Default)]
struct CtxInner {
    stops: RefCell<Vec<Box<dyn FnMut() -> bool>>>,
    cancelled: Cell<bool>,
}

impl Ctx {
    /// Registers what ends something this step started; it answers whether it ended something still running, and
    /// must be a no-op once that ended by itself. It runs on a Cancel and when the step ends.
    pub fn on_stop(&self, stop: impl FnMut() -> bool + 'static) {
        self.0.stops.borrow_mut().push(Box::new(stop));
    }

    /// The person's Cancel stopped what this step ran: it starts nothing more (setup's `#stopPipeline`).
    pub fn cancelled(&self) -> bool {
        self.0.cancelled.get()
    }

    /// Runs every stop; `keep` keeps them for a later stop (a Cancel), else they go. Whether any ended something.
    fn stop(&self, keep: bool) -> bool {
        let mut stops = std::mem::take(&mut *self.0.stops.borrow_mut());
        let mut ended = false;
        for stop in &mut stops {
            ended |= stop();
        }
        if keep {
            let mut held = self.0.stops.borrow_mut();
            stops.append(&mut held);
            *held = stops;
        }
        ended
    }
}

struct Waiting {
    step: Step,
    waiters: Vec<oneshot::Sender<Answer>>,
}

struct Running {
    kind: StepKind,
    ctx: Ctx,
    waiters: Vec<oneshot::Sender<Answer>>,
    stop: Option<oneshot::Sender<Fault>>,
}

#[derive(Default)]
struct St {
    waiting: VecDeque<Waiting>,
    running: Option<Running>,
    closed: bool,
}

/// Hears each stopped step: its chain, its label and the bound it ran past.
type Stalled = Box<dyn Fn(&'static str, &str, u64)>;

pub struct Queue {
    st: RefCell<St>,
    wake: Notify,
    clock: Rc<Clock>,
    bound_ms: u64,
    stalled: Stalled,
}

fn closed() -> Fault {
    Fault::new("tools_closed", "The tools hub closed")
}

/// `formatSpan` of `serial-chain.ts`.
fn span(ms: u64) -> String {
    if ms >= 60_000 {
        format!("{} min", (ms as f64 / 60_000.0).round())
    } else {
        format!("{} s", (ms as f64 / 1000.0).round())
    }
}

impl Queue {
    /// A queue whose steps are bound by `bound_ms` on `clock`; `stalled(chain, label, ms)` hears each stopped one.
    /// Its worker is [`Queue::run`], which the owner spawns.
    pub fn new(
        clock: Rc<Clock>,
        bound_ms: u64,
        stalled: impl Fn(&'static str, &str, u64) + 'static,
    ) -> Rc<Queue> {
        Rc::new(Queue {
            st: RefCell::default(),
            wake: Notify::new(),
            clock,
            bound_ms,
            stalled: Box::new(stalled),
        })
    }

    /// Queues `step` behind every step asked before it; the future is its answer. An omp pass asked while one runs or
    /// waits joins it (its `work` is dropped) and gets the same answer. Refused once the queue closed.
    pub fn enqueue(&self, step: Step) -> Result<LocalFuture<Answer>, Fault> {
        let (answer, answered) = oneshot::channel();
        {
            let mut st = self.st.borrow_mut();
            if st.closed {
                return Err(closed());
            }
            let joins = step.kind == StepKind::OmpPass;
            let St {
                waiting, running, ..
            } = &mut *st;
            if let Some(running) = running.as_mut().filter(|r| joins && r.kind == step.kind) {
                running.waiters.push(answer);
            } else if let Some(waiting) = waiting
                .iter_mut()
                .find(|w| joins && w.step.kind == step.kind)
            {
                waiting.waiters.push(answer);
            } else {
                waiting.push_back(Waiting {
                    step,
                    waiters: vec![answer],
                });
            }
        }
        self.wake.notify_one();
        Ok(Box::pin(async move {
            answered.await.unwrap_or_else(|_| Err(closed()))
        }))
    }

    /// The person's Cancel: ends what the running step started (its installer answers `cancelled`, its download
    /// aborts) and marks the step cancelled. False when it ran nothing to end, as setup's `cancel()`.
    pub fn cancel(&self) -> bool {
        let ctx = self.st.borrow().running.as_ref().map(|r| r.ctx.clone());
        let Some(ctx) = ctx else { return false };
        let ended = ctx.stop(true);
        if ended {
            ctx.0.cancelled.set(true);
        }
        ended
    }

    /// The quit: the running step is dropped and what it started ends now; queued steps never run (their callers
    /// hear `tools_closed`); nothing is queued after.
    pub fn close(&self) {
        let (waiting, running) = {
            let mut st = self.st.borrow_mut();
            st.closed = true;
            // The running step's callers hear the close now: its worker may be dropped with the instance before it
            // answers them.
            let running = st
                .running
                .as_mut()
                .map(|r| (r.ctx.clone(), r.stop.take(), std::mem::take(&mut r.waiters)));
            (std::mem::take(&mut st.waiting), running)
        };
        for waiter in waiting.into_iter().flat_map(|w| w.waiters) {
            let _ = waiter.send(Err(closed()));
        }
        if let Some((ctx, stop, waiters)) = running {
            ctx.stop(true);
            if let Some(stop) = stop {
                let _ = stop.send(closed());
            }
            for waiter in waiters {
                let _ = waiter.send(Err(closed()));
            }
        }
        self.wake.notify_one();
    }

    /// The worker: runs each step to its end, its bound or the close, then the next. Ends once the queue closed.
    pub async fn run(self: Rc<Self>) {
        loop {
            let next = {
                let mut st = self.st.borrow_mut();
                if st.closed {
                    return;
                }
                st.waiting.pop_front().map(|Waiting { step, waiters }| {
                    let ctx = Ctx::default();
                    let (stop, stopped) = oneshot::channel();
                    st.running = Some(Running {
                        kind: step.kind,
                        ctx: ctx.clone(),
                        waiters,
                        stop: Some(stop),
                    });
                    (step, ctx, stopped)
                })
            };
            let Some((Step { label, kind, work }, ctx, stopped)) = next else {
                self.wake.notified().await;
                continue;
            };
            let bound = self.bound_ms;
            // The work first: a step that ends at its first poll never arms its bound (one of main's timers when manual).
            let answer = tokio::select! {
                biased;
                answer = work(ctx.clone()) => answer,
                () = self.clock.sleep(bound) => {
                    (self.stalled)(kind.chain(), &label, bound);
                    Err(Fault::new("step_stalled", format!(
                        "{label} did not finish in {} and was stopped so the next one can run ({}).",
                        span(bound),
                        kind.chain()
                    )))
                }
                Ok(reason) = stopped => Err(reason),
            };
            // The step's future is gone here; what it started and did not see end, ends now.
            ctx.stop(false);
            let running = self.st.borrow_mut().running.take();
            for waiter in running.into_iter().flat_map(|r| r.waiters) {
                let _ = waiter.send(answer.clone());
            }
        }
    }
}
