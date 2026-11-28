//! Bounded post-ready coalescing for `page_push`.
//!
//! Keeps WebView2/WKWebView `eval()` queues bounded and prevents UI-thread saturation when
//! multiple concurrent tabs stream rapid deltas:
//! 1. Caps the post-ready outbox at `POST_READY_LIMIT`, clearing stale backlog and inserting a
//!    single `{"stream":"reset"}` marker on overflow (matching pre-ready overflow recovery).
//! 2. Coalesces up to `MAX_COALESCE_ITEMS` pushes (within `MAX_COALESCE_BYTES`) into a single
//!    ordered JS script so each UI-thread drain turn performs one `webview.eval(...)` instead of
//!    N separate turns and N separate script evaluations.

use super::{Push, Submitted};
use crate::WireError;
use crate::registry::Identity;
use std::collections::VecDeque;

/// Maximum buffered pushes in a ready document's outbox before overflow reset.
pub(super) const POST_READY_LIMIT: usize = 4096;
/// Maximum pushes merged into a single `webview.eval()` batch.
pub(super) const MAX_COALESCE_ITEMS: usize = 64;
/// Maximum combined script bytes merged into a single `webview.eval()` batch (512 KiB).
pub(super) const MAX_COALESCE_BYTES: usize = 512 * 1024;

/// One FIFO-ordered batch of pushes delivered in a single `webview.eval()` call.
pub(super) struct CoalescedBatch {
    pub(super) script: String,
    pub(super) receipts: Vec<Submitted>,
    #[cfg(test)]
    pub(super) count: usize,
}

impl CoalescedBatch {
    pub(super) fn submit(
        self,
        eval: impl FnOnce(String) -> Result<(), WireError>,
    ) -> Result<(), WireError> {
        let result = eval(self.script);
        for receipt in self.receipts {
            let _ = receipt.send(result.clone());
        }
        result
    }
}

/// Push `item` onto `pending`, enforcing `limit` with `{"stream":"reset"}` recovery on overflow.
pub(super) fn push_bounded(pending: &mut VecDeque<Push>, id: Identity, item: Push, limit: usize) {
    if pending.len() >= limit {
        pending.clear();
        pending.push_back(Push {
            script: format!(
                "window.__ompTauriPush({}, {{\"stream\":\"reset\"}});",
                id.generation
            ),
            submitted: None,
        });
    }
    pending.push_back(item);
}

/// Pop a bounded FIFO batch from `pending` within `(max_items, max_bytes)`.
/// Always takes at least one item when `pending` is non-empty, even if that item exceeds `max_bytes`.
pub(super) fn take_batch(pending: &mut VecDeque<Push>) -> Option<CoalescedBatch> {
    take_batch_with_limits(pending, MAX_COALESCE_ITEMS, MAX_COALESCE_BYTES)
}

fn take_batch_with_limits(
    pending: &mut VecDeque<Push>,
    max_items: usize,
    max_bytes: usize,
) -> Option<CoalescedBatch> {
    let first = pending.pop_front()?;
    let max_items = max_items.max(1);
    let mut script = first.script;
    let mut receipts = Vec::new();
    if let Some(receipt) = first.submitted {
        receipts.push(receipt);
    }
    let mut count = 1usize;

    while count < max_items {
        let Some(next) = pending.front() else {
            break;
        };
        if script.len().saturating_add(next.script.len()) > max_bytes {
            break;
        }
        let next = pending.pop_front().expect("checked front");
        script.push_str(&next.script);
        if let Some(receipt) = next.submitted {
            receipts.push(receipt);
        }
        count += 1;
    }

    #[cfg(not(test))]
    let _ = count;

    Some(CoalescedBatch {
        script,
        receipts,
        #[cfg(test)]
        count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::failed;
    use serde_json::json;
    use tokio::sync::oneshot;
    use tokio::sync::oneshot::error::TryRecvError;

    fn id() -> Identity {
        Identity {
            win: Some(1),
            wc: 1,
            generation: 7,
        }
    }

    #[test]
    fn coalesces_multiple_pushes_in_fifo_order_and_delivers_all_receipts() {
        let mut pending = VecDeque::new();
        let (tx1, mut rx1) = oneshot::channel();
        let (tx2, mut rx2) = oneshot::channel();
        push_bounded(
            &mut pending,
            id(),
            Push::new(id(), "a", &[json!(1)], Some(tx1)),
            POST_READY_LIMIT,
        );
        push_bounded(
            &mut pending,
            id(),
            Push::new(id(), "b", &[json!(2)], None),
            POST_READY_LIMIT,
        );
        push_bounded(
            &mut pending,
            id(),
            Push::new(id(), "c", &[json!(3)], Some(tx2)),
            POST_READY_LIMIT,
        );

        let batch = take_batch(&mut pending).unwrap();
        assert_eq!(batch.count, 3);
        assert!(pending.is_empty());

        let mut evaluated = Vec::new();
        batch
            .submit(|script| {
                evaluated.push(script);
                Ok(())
            })
            .unwrap();
        assert_eq!(evaluated.len(), 1);
        assert_eq!(
            evaluated[0],
            concat!(
                "window.__ompTauriPush(7, {\"channel\":\"a\",\"args\":[1]});",
                "window.__ompTauriPush(7, {\"channel\":\"b\",\"args\":[2]});",
                "window.__ompTauriPush(7, {\"channel\":\"c\",\"args\":[3]});"
            )
        );
        assert_eq!(rx1.try_recv(), Ok(Ok(())));
        assert_eq!(rx2.try_recv(), Ok(Ok(())));
    }

    #[test]
    fn splits_batches_by_item_and_byte_limits_without_dropping_oversized_single_item() {
        let mut pending = VecDeque::new();
        for i in 0..5 {
            push_bounded(
                &mut pending,
                id(),
                Push::new(id(), "ch", &[json!(i)], None),
                POST_READY_LIMIT,
            );
        }
        let first = take_batch_with_limits(&mut pending, 2, 10_000).unwrap();
        assert_eq!(first.count, 2);
        let second = take_batch_with_limits(&mut pending, 2, 10_000).unwrap();
        assert_eq!(second.count, 2);
        let third = take_batch_with_limits(&mut pending, 2, 10_000).unwrap();
        assert_eq!(third.count, 1);
        assert!(pending.is_empty());

        // Single push larger than byte budget still flushes intact as its own batch.
        let huge = "x".repeat(256);
        push_bounded(
            &mut pending,
            id(),
            Push::new(id(), "big", &[json!(huge)], None),
            POST_READY_LIMIT,
        );
        push_bounded(
            &mut pending,
            id(),
            Push::new(id(), "small", &[json!(1)], None),
            POST_READY_LIMIT,
        );
        let b1 = take_batch_with_limits(&mut pending, 64, 128).unwrap();
        assert_eq!(b1.count, 1);
        assert!(b1.script.contains("\"channel\":\"big\""));
        let b2 = take_batch_with_limits(&mut pending, 64, 128).unwrap();
        assert_eq!(b2.count, 1);
        assert!(b2.script.contains("\"channel\":\"small\""));
    }

    #[test]
    fn post_ready_overflow_clears_backlog_cancels_displaced_receipts_and_emits_reset() {
        let mut pending = VecDeque::new();
        let (tx, mut rx) = oneshot::channel();
        push_bounded(
            &mut pending,
            id(),
            Push::new(id(), "first", &[json!(0)], Some(tx)),
            3,
        );
        push_bounded(
            &mut pending,
            id(),
            Push::new(id(), "second", &[json!(1)], None),
            3,
        );
        push_bounded(
            &mut pending,
            id(),
            Push::new(id(), "third", &[json!(2)], None),
            3,
        );
        assert_eq!(rx.try_recv(), Err(TryRecvError::Empty));

        // 4th push hits limit 3: clears old items, cancels displaced receipt, inserts reset + new item.
        push_bounded(
            &mut pending,
            id(),
            Push::new(id(), "after", &[json!(3)], None),
            3,
        );
        assert_eq!(rx.try_recv(), Err(TryRecvError::Closed));
        assert_eq!(pending.len(), 2);
        assert_eq!(
            pending[0].script,
            "window.__ompTauriPush(7, {\"stream\":\"reset\"});"
        );
        assert!(pending[1].script.contains("\"channel\":\"after\""));
    }

    #[test]
    fn failed_batch_eval_propagates_error_to_every_receipt_in_batch() {
        let mut pending = VecDeque::new();
        let (tx1, mut rx1) = oneshot::channel();
        let (tx2, mut rx2) = oneshot::channel();
        push_bounded(
            &mut pending,
            id(),
            Push::new(id(), "a", &[], Some(tx1)),
            POST_READY_LIMIT,
        );
        push_bounded(
            &mut pending,
            id(),
            Push::new(id(), "b", &[], Some(tx2)),
            POST_READY_LIMIT,
        );
        let batch = take_batch(&mut pending).unwrap();
        let err = failed("webview closed");
        assert_eq!(batch.submit(|_| Err(err.clone())), Err(err.clone()));
        assert_eq!(rx1.try_recv(), Ok(Err(err.clone())));
        assert_eq!(rx2.try_recv(), Ok(Err(err)));
    }
}
