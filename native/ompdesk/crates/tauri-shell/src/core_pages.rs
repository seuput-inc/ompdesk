//! The core's desktop page pushes (C4; PROTOCOL.md › 12a): each core's stdout reader hands its `page.push` frames
//! here in order. A push goes into its window's outbox exactly as main's `wc.send` does, and the push numbers admitted
//! per core generation are the fence a main answer stamped with `after` waits on (PROTOCOL.md › 11, `ipc.invoke`).

use crate::{log, page_push, runtime};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Condvar, LazyLock, Mutex, PoisonError};

/// What the shell admitted of one core generation's pushes.
#[derive(Clone, Copy, Default)]
struct Admitted {
    pushed: u64,
    ended: bool,
}

#[derive(Default)]
struct Fence {
    generations: Mutex<HashMap<u64, Admitted>>,
    changed: Condvar,
}

impl Fence {
    fn update(&self, generation: u64, change: impl FnOnce(&mut Admitted)) {
        let mut generations = self
            .generations
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        change(generations.entry(generation).or_default());
        self.changed.notify_all();
    }

    fn admitted(&self, generation: u64, pushed: u64) {
        self.update(generation, |admitted| {
            admitted.pushed = admitted.pushed.max(pushed);
        });
    }

    fn ended(&self, generation: u64) {
        self.update(generation, |admitted| admitted.ended = true);
    }

    /// Returns once push `pushed` of `generation` is admitted or that generation's stdout ended. A generation not seen
    /// yet waits too: main can read an answer stamped with push 1 before the reader took that push, and every number
    /// the core gave out reaches its stdout or ends with it.
    fn wait(&self, generation: u64, pushed: u64) {
        let generations = self
            .generations
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let _held = self
            .changed
            .wait_while(generations, |generations| {
                let admitted = generations.get(&generation).copied().unwrap_or_default();
                !admitted.ended && admitted.pushed < pushed
            })
            .unwrap_or_else(PoisonError::into_inner);
    }
}

static FENCE: LazyLock<Fence> = LazyLock::new(Fence::default);

/// One push from core `generation`'s stdout: into the live app document of `win` (dropped when it has none, as
/// `wc.send` is), then admitted. `data` is the push's one argument as JSON bytes.
pub(super) fn push(generation: u64, win: i64, channel: &str, pushed: u64, data: &[u8]) {
    match serde_json::from_slice::<Value>(data) {
        Ok(data) => {
            let id = u64::try_from(win).ok().and_then(|wc| {
                runtime()
                    .registry
                    .lock()
                    .expect("registry")
                    .app_document(wc)
            });
            if let Some(id) = id {
                page_push::detached(id, channel, &[data]);
            }
        }
        Err(error) => log::log(
            "core.page.invalid",
            json!({"generation":generation,"channel":channel,"error":error.to_string()}),
        ),
    }
    FENCE.admitted(generation, pushed);
}

/// Core `generation`'s stdout ended after its last push.
pub(super) fn ended(generation: u64) {
    FENCE.ended(generation);
}

/// Takes `after: {generation, pushed}` off main's `ipc.invoke` answer and returns once the shell admitted that push
/// (the answer reaches the page after every push the core made before main read it). Blocks: call off the UI thread.
pub(super) fn fence(answer: &mut Value) {
    let Some(after) = answer
        .as_object_mut()
        .and_then(|answer| answer.remove("after"))
    else {
        return;
    };
    if let (Some(generation), Some(pushed)) =
        (after["generation"].as_u64(), after["pushed"].as_u64())
        && pushed > 0
    {
        FENCE.wait(generation, pushed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    fn waiter(fence: &Arc<Fence>, generation: u64, pushed: u64) -> mpsc::Receiver<()> {
        let (done, released) = mpsc::channel();
        let fence = Arc::clone(fence);
        thread::spawn(move || {
            fence.wait(generation, pushed);
            let _ = done.send(());
        });
        released
    }

    fn held(released: &mpsc::Receiver<()>) -> bool {
        released.recv_timeout(Duration::from_millis(50)).is_err()
    }

    #[test]
    fn an_answer_waits_for_its_push_even_before_the_generation_was_seen() {
        let fence = Arc::new(Fence::default());
        let released = waiter(&fence, 2, 3);
        assert!(held(&released));
        fence.admitted(2, 2);
        assert!(held(&released));
        fence.admitted(1, 9);
        assert!(
            held(&released),
            "another generation's pushes do not release it"
        );
        fence.admitted(2, 3);
        assert!(released.recv_timeout(Duration::from_secs(5)).is_ok());
        assert!(
            waiter(&fence, 2, 1)
                .recv_timeout(Duration::from_secs(5))
                .is_ok()
        );
    }

    #[test]
    fn a_generation_whose_stdout_ended_releases_every_wait_on_it() {
        let fence = Arc::new(Fence::default());
        fence.admitted(4, 1);
        let released = waiter(&fence, 4, 2);
        assert!(held(&released));
        fence.ended(4);
        assert!(released.recv_timeout(Duration::from_secs(5)).is_ok());
        assert!(
            waiter(&fence, 4, 50)
                .recv_timeout(Duration::from_secs(5))
                .is_ok()
        );
    }
}
