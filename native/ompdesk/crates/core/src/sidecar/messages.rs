//! Stock `agent_end.messages` can miss part of the run the client watched (was `src/main/run-messages.ts`):
//! - agent-session.ts defers `agent_end` while the prompt is in flight and keeps only the newest one
//!   (`#pendingAgentEndEmit`), so a prompt that auto-continued (todo reminder, session_stop hook) ends with the
//!   continuation's messages alone;
//! - rpc-frame.ts `compactTerminalFrame` drops a prefix an oversized frame already delivered by `message_end` (wire
//!   `messageCount`).
//!
//! Every one of those messages arrived as a `message_end` first, in stream order.

use std::collections::{HashMap, VecDeque};

use serde_json::Value;

/// Hard upper bound on `message_end` entries retained per active turn in `Lane.run_messages`.
pub const RUN_MESSAGES_MAX_COUNT: usize = 256;
/// Hard upper bound on retained `message_end` raw payload bytes per active turn (8 MiB).
pub const RUN_MESSAGES_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Capacity above which a drained `RunMessageBuffer` releases its backing VecDeque allocation.
const SHRINK_CAPACITY_THRESHOLD: usize = 64;

/// Bounded FIFO buffer for `message_end` payloads within a single agent turn.
///
/// Retains the newest delivery suffix within `(max_count, max_bytes)` so `complete_run_messages`
/// can still reconstruct deferred/compacted `agent_end` frames without allowing a 100-step tool
/// turn (large diffs, file reads, screenshots) to pin tens of MiBs of cloned ASTs in `ompdesk-core`.
#[derive(Debug)]
pub struct RunMessageBuffer {
    entries: VecDeque<(Value, usize)>,
    total_bytes: usize,
    dropped_count: u64,
    max_count: usize,
    max_bytes: usize,
}

impl Default for RunMessageBuffer {
    fn default() -> Self {
        Self::with_limits(RUN_MESSAGES_MAX_COUNT, RUN_MESSAGES_MAX_BYTES)
    }
}

impl RunMessageBuffer {
    pub fn with_limits(max_count: usize, max_bytes: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            total_bytes: 0,
            dropped_count: 0,
            max_count: max_count.max(1),
            max_bytes: max_bytes.max(1),
        }
    }

    pub fn push(&mut self, message: Value, raw_bytes: usize) {
        let bytes = raw_bytes.max(1);
        if bytes > self.max_bytes {
            self.dropped_count += 1;
            return;
        }
        while self.entries.len() >= self.max_count
            || self.total_bytes.saturating_add(bytes) > self.max_bytes
        {
            let Some((_, evicted)) = self.entries.pop_front() else {
                break;
            };
            self.total_bytes = self.total_bytes.saturating_sub(evicted);
            self.dropped_count += 1;
        }
        self.total_bytes = self.total_bytes.saturating_add(bytes);
        self.entries.push_back((message, bytes));
    }

    pub fn take_all(&mut self) -> Vec<Value> {
        let out = self.entries.drain(..).map(|(msg, _)| msg).collect();
        self.total_bytes = 0;
        if self.entries.capacity() > SHRINK_CAPACITY_THRESHOLD {
            self.entries = VecDeque::new();
        }
        out
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.total_bytes = 0;
        if self.entries.capacity() > SHRINK_CAPACITY_THRESHOLD {
            self.entries = VecDeque::new();
        }
    }

    pub fn shrink_to_fit(&mut self) {
        self.entries.shrink_to_fit();
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[cfg(test)]
    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    #[cfg(test)]
    pub fn dropped_count(&self) -> u64 {
        self.dropped_count
    }
}

/// JavaScript's truthiness of a parsed JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Whether the terminal frame's copy `message` is the delivered `sent`: deeply equal, or (a copy stock touched after
/// `message_end`) the same role, time, call and custom type.
fn same(sent: &Value, message: &Value) -> bool {
    if sent == message {
        return true;
    }
    sent.get("timestamp").is_some_and(Value::is_number)
        && ["role", "timestamp", "toolCallId", "customType"]
            .iter()
            .all(|key| sent.get(key) == message.get(key))
}

/// The messages to commit for `agent_end`: everything delivered by `message_end` since the previous `agent_end`, in
/// delivery order, with the terminal frame's own copy wherever it carries one (a terminal message never delivered
/// keeps its frame position). `None` when the frame already covers the run: it is used as it is.
pub fn complete_run_messages(delivered: &[Value], terminal: &[Value]) -> Option<Vec<Value>> {
    if delivered.is_empty() {
        return None;
    }
    // Pair each terminal message with its delivery, newest first: the frame is the run's tail.
    let mut delivered_at: HashMap<usize, usize> = HashMap::new();
    let mut cursor = delivered.len() as isize - 1;
    for index in (0..terminal.len()).rev() {
        let message = &terminal[index];
        let mut candidate = cursor;
        while candidate >= 0 && truthy(message) {
            if same(&delivered[candidate as usize], message) {
                delivered_at.insert(index, candidate as usize);
                cursor = candidate - 1;
                break;
            }
            candidate -= 1;
        }
    }
    let mut messages: Vec<Value> = Vec::new();
    let mut next = 0;
    for (index, message) in terminal.iter().enumerate() {
        if let Some(&at) = delivered_at.get(&index) {
            messages.extend_from_slice(&delivered[next..at]);
            next = at + 1;
        }
        messages.push(message.clone());
    }
    messages.extend_from_slice(&delivered[next..]);
    (messages.len() != terminal.len()).then_some(messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user() -> Value {
        json!({ "role": "user", "content": "Use your todo tool", "timestamp": 100 })
    }
    fn call() -> Value {
        json!({ "role": "assistant", "content": [{ "type": "toolCall", "id": "c1", "name": "todo", "arguments": {} }], "timestamp": 101 })
    }
    fn result() -> Value {
        json!({ "role": "toolResult", "toolCallId": "c1", "toolName": "todo", "content": [], "timestamp": 102 })
    }
    fn reminder() -> Value {
        json!({ "role": "custom", "customType": "todo-reminder", "content": "finish", "timestamp": 103 })
    }
    fn reply() -> Value {
        json!({ "role": "assistant", "content": [{ "type": "text", "text": "done" }], "timestamp": 104 })
    }

    #[test]
    fn returns_a_terminal_frame_that_already_covers_the_run_unchanged() {
        let terminal = [user(), call(), result()];
        assert_eq!(
            complete_run_messages(&[user(), call(), result()], &terminal),
            None
        );
        assert_eq!(complete_run_messages(&[], &terminal), None);
    }

    #[test]
    fn restores_the_run_a_deferred_continuation_agent_end_replaced() {
        assert_eq!(
            complete_run_messages(
                &[user(), call(), result(), reminder(), reply()],
                &[reminder(), reply()]
            ),
            Some(vec![user(), call(), result(), reminder(), reply()])
        );
    }

    #[test]
    fn restores_the_prefix_an_oversized_frame_dropped_and_everything_for_an_overflowed_frame() {
        assert_eq!(
            complete_run_messages(&[user(), call(), result(), reply()], &[result(), reply()]),
            Some(vec![user(), call(), result(), reply()])
        );
        assert_eq!(
            complete_run_messages(&[user(), call(), result()], &[]),
            Some(vec![user(), call(), result()])
        );
    }

    #[test]
    fn prefers_the_terminal_copy_and_keeps_delivery_order_around_messages_stock_never_delivered() {
        let mut touched = result();
        touched["details"] = json!({ "saved": true });
        let undelivered =
            json!({ "role": "custom", "customType": "note", "content": "n", "timestamp": 105 });
        let completed = complete_run_messages(
            &[user(), call(), result(), reply()],
            &[touched.clone(), undelivered.clone(), reply()],
        )
        .unwrap();
        assert_eq!(
            completed,
            [user(), call(), touched.clone(), undelivered, reply()]
        );
        assert_eq!(completed[2], touched);
    }

    #[test]
    fn run_message_buffer_enforces_count_and_byte_bounds_and_keeps_newest_tail() {
        let mut buf = RunMessageBuffer::with_limits(3, 500);
        buf.push(user(), 100);
        buf.push(call(), 150);
        buf.push(result(), 200);
        assert_eq!(buf.len(), 3);
        assert_eq!(buf.total_bytes(), 450);
        assert_eq!(buf.dropped_count(), 0);

        // Exceeds both count (3) and byte budget (500): evicts oldest entries until it fits.
        buf.push(reply(), 250);
        assert_eq!(buf.len(), 2);
        assert_eq!(buf.total_bytes(), 450);
        assert_eq!(buf.dropped_count(), 2);

        // Single message larger than max_bytes is skipped without clearing the retained tail.
        buf.push(reminder(), 501);
        assert_eq!(buf.len(), 2);
        assert_eq!(buf.dropped_count(), 3);

        let taken = buf.take_all();
        assert_eq!(taken, [result(), reply()]);
        assert_eq!(buf.len(), 0);
        assert_eq!(buf.total_bytes(), 0);
    }

    #[test]
    fn run_message_buffer_stress_2000_large_messages_holds_8mib_and_256_count_caps() {
        let mut buf = RunMessageBuffer::default();
        let payload = "a".repeat(64 * 1024);
        for i in 0..2_000u64 {
            buf.push(
                json!({ "role": "assistant", "timestamp": i, "text": &payload }),
                payload.len(),
            );
            assert!(buf.len() <= RUN_MESSAGES_MAX_COUNT);
            assert!(buf.total_bytes() <= RUN_MESSAGES_MAX_BYTES);
        }
        // 128 MiB streamed input -> strictly <= 8 MiB retained (128 x 64 KiB = 8 MiB).
        assert_eq!(buf.total_bytes(), RUN_MESSAGES_MAX_BYTES);
        assert_eq!(buf.len(), RUN_MESSAGES_MAX_BYTES / (64 * 1024));
        assert!(buf.dropped_count() > 1_800);
        let drained = buf.take_all();
        assert_eq!(drained.len(), 128);
        assert_eq!(drained.last().unwrap()["timestamp"], 1_999);
        assert_eq!(buf.len(), 0);
        assert_eq!(buf.total_bytes(), 0);
    }
}
