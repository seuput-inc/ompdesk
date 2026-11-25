//! The `tools` instance's clock: the system's, or main's when the instance is opened `manual` (a vitest with fake
//! timers). A manual sleep is one of main's timers: the item `{k: "timer", timer, ms}` arms it, `{k: "clearTimer",
//! timer}` drops it when the sleep is dropped first, and the call `fire {timer, now}` ends the sleep and says main's
//! time. `now_ms` is then the time main said last (at open, then at each fire).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tokio::sync::oneshot;

/// Where a manual clock's items go (the instance's `Out` on the hub; a list in tests).
pub type Tell = Box<dyn Fn(Value)>;

pub struct Clock {
    manual: Option<Manual>,
}

struct Manual {
    tell: Tell,
    now: Cell<u64>,
    next: Cell<u64>,
    timers: RefCell<HashMap<u64, oneshot::Sender<()>>>,
}

/// A manual sleep's timer; dropping it before it fired clears main's.
struct Armed<'a> {
    manual: &'a Manual,
    timer: u64,
}

impl Drop for Armed<'_> {
    fn drop(&mut self) {
        if self
            .manual
            .timers
            .borrow_mut()
            .remove(&self.timer)
            .is_some()
        {
            (self.manual.tell)(json!({"k": "clearTimer", "timer": self.timer}));
        }
    }
}

impl Clock {
    pub fn system() -> Clock {
        Clock { manual: None }
    }

    pub fn manual(now: u64, tell: Tell) -> Clock {
        Clock {
            manual: Some(Manual {
                tell,
                now: Cell::new(now),
                next: Cell::new(0),
                timers: RefCell::default(),
            }),
        }
    }

    /// Milliseconds since the epoch, as `Date.now()` reads them.
    pub fn now_ms(&self) -> u64 {
        match &self.manual {
            Some(manual) => manual.now.get(),
            None => SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |since| since.as_millis() as u64),
        }
    }

    /// Waits `ms` on this clock. A manual timer main never fires (the instance closed) never ends.
    pub async fn sleep(&self, ms: u64) {
        let Some(manual) = &self.manual else {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            return;
        };
        let timer = manual.next.get() + 1;
        manual.next.set(timer);
        let (fire, fired) = oneshot::channel();
        manual.timers.borrow_mut().insert(timer, fire);
        let _armed = Armed { manual, timer };
        (manual.tell)(json!({"k": "timer", "timer": timer, "ms": ms}));
        if fired.await.is_err() {
            std::future::pending::<()>().await;
        }
    }

    /// Main's timer `timer` fired at `now`; false for one this clock does not hold (cleared, or a system clock).
    pub fn fire(&self, timer: u64, now: Option<u64>) -> bool {
        let Some(manual) = &self.manual else {
            return false;
        };
        if let Some(now) = now {
            manual.now.set(manual.now.get().max(now));
        }
        let fire = manual.timers.borrow_mut().remove(&timer);
        fire.is_some_and(|fire| fire.send(()).is_ok())
    }
}
