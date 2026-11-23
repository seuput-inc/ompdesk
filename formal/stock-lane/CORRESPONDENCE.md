# Correspondence: StockLane.tla ↔ code

All code is `native/ompdesk/crates/core/src/stock/mod.rs`. A lane is one task (`Lane::start`) that takes one message at a time from its inbox, so each lane action is atomic: nothing of the lane's state is shared with another task.

| Model | Code | Atomic because |
|---|---|---|
| `Request(r, probe)` | In `Lane::start`, `Msg::Request` schedules `terminal::frame` on the blocking pool for `terminal.create` and leaves its line absent. Other methods already have a line. `Lane::request` appends the ID, inserts `Pending`, checks for retirement, and either flushes or asks for a start if needed. | The task can send `ShellReady` immediately, but the lane cannot handle another message before `request` returns. |
| `ShellReady(r, ok)` | `Msg::ShellReady` from that create's task sets its line or fails and removes it. A missing ID receives neither a line nor a reply. The lane calls `flush`. | One message. An outstanding result stays in `probes` until handled, even after a timeout, exit, failed start, or stop. |
| `Flush(g, q, outstanding)` | `Lane::flush` writes the ready prefix to the running worker's stdin in FIFO order. It skips IDs absent from `pending` and stops at the first live entry without a line. | Synchronous inside request, start, shell-result, or withdrawal handling. `writes` records each terminal frame in send order, including order within the batch. |
| `Outlived` | `Lane::outlived_its_omp`: not the terminals worker, nothing unanswered, no other request pending, omp's `package.json` present and the install's stamp (each of main's `stampFiles`: time and size, or absent) differs from the one read just before the worker started | read inside `request`; the stamp is one `metadata` call per file, read in the lane's own step |
| `Ask` | the `stock.launch` event, numbered from `NEXT_ID` (one sequence for the whole process) | inside `request` |
| `Launched(l, ok)` | `Lane::launched` rejects an obsolete start. A matching success spawns the worker and flushes as far as preparation permits. Failure clears the queue and fails pending calls. | One message. A matching start may still spawn after every caller timed out. That is an outstanding launch, not a new start from a shell result. |
| `TimerFires(r)` | The `stock.request` handler's `wait` returns a timeout or cancellation and sends `Msg::GaveUp`. `place` has already submitted the request in frame order. | The handler decides once. Its biased `select!` takes an answer that is already available. |
| `GaveUp(r)` | `Lane::gave_up` removes the pending ID. If it was unsent, a running lane flushes past it. Otherwise the worker gets `{cancel}`, and only a stock worker gets a grace. | One message. `TimerFires` alone does not remove an entry. A concurrent shell result can still send the frame until the lane handles `GaveUp`. |
| `WorkerAnswers(g, r)` | the worker writes `{id, result}` / `{id, error}` (also `withdrawn`) | environment |
| `ReadLine(g, r)` | `read_lines` → `Msg::Line` → `Lane::line`: a line of a worker that is not the lane's is dropped (`Lane::current`) | one message |
| `Grace(g, r)` | the sleeping task of `gave_up` → `Msg::Overdue` → `Lane::overdue` | one message |
| `Idle(g)` | the sleeping task of `arm_idle_exit` → `Msg::Idle` → `Lane::idle` | one message |
| `WorkerExits(g)` / `ReadExit(g)` | the worker's waiter task → `Msg::Exited` → `Lane::exited` | one message |
| `LetGo(why)` | `Lane::let_go` (the worker's stdin sender is dropped, which closes the pipe once its writer wrote what was queued); `overdue` also asks the waiter task to kill | inside the message |
| `Fail` | `Lane::fail_pending` | inside the message |
| `Stop` | `stock.stop` / `close_all` → `end_lanes` → `Msg::Stop` → `Lane::stop`; the lane's task ends and its table entry is removed under the table's lock, so a later request makes a fresh lane | one message; the model keeps one lane and empties it, which is the fresh lane's state |
| `OmpChanges` | another process changes the omp install: omp's package, a dependency in its scope, the install's manifest or lockfile (any of main's `stampFiles`). The stamp is read before the spawn, so an install still being written when the worker starts sets `changed` once it writes another file | environment |

## Abstractions that could hide a bug

- **Terminal IDs name arrival ranks.** The first terminal request is 1 and the second is 2, regardless of their real `NEXT_ID` values. This renames IDs in lane receive order, not allocation order. Each arrival can be a create with its own probe or a ready frame such as a dispose. Two creates can finish in either order. Stock and extensions keep their original request choices. Test-only lane reassignment and idle overrides in `Tuning` are not modeled.
- **The queue contains live entries only.** `waiting` is the Rust deque with IDs absent from `pending` filtered out. Removing an ID early in this projection cannot unblock a real write sooner: a running lane flushes in the same handler, and a lane without a worker cannot write. One-shot IDs cannot become live again.
- **Probe state is independent of the worker.** For an unsent live entry, membership in `probes` means `Pending.line` is absent. A probe can still return after its entry was removed. The model omits the shell path, payload bytes, and task scheduling. A delayed, failed, or missing result is allowed.
- **The fresh lane after a stop is the same lane, emptied.** The code makes a new task with a new inbox; timers and reader tasks of the old one send into a closed inbox. The model lets those late messages reach the emptied lane, which is more than the code allows.
- **Launch numbers never repeat.** They come from one process-wide counter. A per-lane counter would restart after a stop and the model's `launching # l` check would not describe the code.
- **The idle timer's epoch is not modelled.** `idle_epoch` makes an idle timer armed before a newer request or answer do nothing, so a worker stays its whole idle time after its last answer. Without it a worker could be let go early but still only with nothing unanswered; that is a timing property, outside an untimed model. The model lets every idle timer ever armed fire.
- **Time.** Timers fire at any moment after they were armed. That a grace is 30 s or an idle exit 60 s is not checked.
- **`unanswered` belongs to the worker.** In the code it is a field of `Running`, so it empties when the worker goes; the model empties it in `LetGo` and `ReadExit`.
- **The worker's queue is not modelled.** That a withdrawn request never runs is the worker's own rule (`resources/gui-bridge/stock-helper/dispatch.ts`, pinned by `stock-helper.test.ts` "createDispatcher"); here a worker answers any request it was sent, in any order, or never.
- **A worker's last lines and its exit are two messages.** A line read after the exit was handled is dropped, in the model and in the code; the request then failed with the exit, as it did in the TypeScript (`exit` before the last `data`).
- **Writes to a worker never block the lane.** They go through an unbounded channel to the worker's writer task; a worker that stopped reading its stdin cannot stop the lane from handling timeouts.
