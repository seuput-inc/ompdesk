# Properties (frozen)

Definitions live between the banners in `tla/StockLane.tla`.

| Property | Statement | Source |
|---|---|---|
| `NothingInFlightIsCut` | A worker is let go for a changed omp or for idleness only while no request it was sent is unanswered. | `.omp/rules/machine-setup-updates.md` › omp updates itself: "never while a request is on its way to it"; AGENTS.md › Stock helper workers: the extensions worker "ends 60 s after its last answer"; `stock-helper.test.ts` "keeps an idle-exit worker up while a request it was sent still runs, even one whose caller timed out" |
| `TerminalsWorkerIsNeverEnded` | The lane of the terminals worker ends it only when it is stopped: never for a hung request, a changed omp or idleness. | AGENTS.md › Stock helper workers: "A hung stock call can never take a shell or a running upgrade with it"; machine-setup-updates: "never the terminals worker, whose shells would go with it" |
| `OnlyTheStockWorkerIsRecycled` | Only the stock worker is ever ended as hung. | AGENTS.md › Stock helper workers: "The terminals and extensions workers are never replaced for a slow request" |
| `OnlyAStuckWorkerIsRecycled` | A worker is ended as hung only for a request it was sent, whose caller timed out, and that it has not answered (neither a late result nor the withdrawal). | AGENTS.md › Stock helper workers: "If a timed-out request still has no answer 30 s later, the lane is stuck"; `stock-helper.test.ts` "its acknowledged withdrawal keeps the worker" |
| `NoRequestStranded` | A pending request waits for an outstanding worker start or is unanswered on the lane's own worker. On a running terminal lane only, it can instead be unsent in the FIFO while the first live entry waits for its own shell probe. | Commit 1c71982f; `Lane::request`, `Lane::launched`, `Lane::flush`, and `Msg::ShellReady` in `stock/mod.rs`. |
| `TerminalWritesInOrder` | A terminal frame reaches stdin only after its own preparation. No write passes an earlier live unsent frame. The write sequence stays in arrival order, including writes in one flush. | `Lane::request` appends to `waiting`; `Lane::flush` stops at the first missing line and sends the ready prefix to `Running::stdin`. |
| `DroppedRequestsStayGone` | A failure or a withdrawal handled by the lane leaves the request out of `pending` and sends no new frame for it. Once a request leaves `pending`, no later message can reinsert or dispatch it. | `Lane::gave_up`, `Lane::fail_pending`, `Lane::stop`, and the check of `pending` in `Msg::ShellReady`. The caller's timer and `GaveUp` are separate messages. |
| `PreparationCannotRevive` | A shell result neither asks for a start nor spawns a worker. A result whose ID is no longer pending also leaves the live requests, queue, and worker unchanged. | `Msg::ShellReady` looks up its own request and calls `Lane::flush`, not `Lane::request`. Only a matching `Msg::Launched` can spawn. |
| `NoWorkerIsForgotten` | Every worker that runs with its stdin open is the lane's worker: none is left running that nothing will end. | AGENTS.md › Dev rules: "Child processes the app spawns must not outlive it"; machine-setup-updates: workers are "stopped before the installer" |
| `AStartAskedBeforeAStopStartsNothing` | An answer to a worker start asked for before a stop starts no worker. | `stop()` of the TypeScript host ("an omp update must not replace files a live worker still reads"; a start that finished after it ended the child at once) |

## Intended change to `NoRequestStranded`

The old rule was "A request the lane still owes an answer waits for a worker start that was asked for, or is unanswered on the lane's own worker." Those two cases remain the entire rule for stock and extensions.

The new terminal-only case requires a running worker, no start in progress, and an unsent request in the live FIFO. The head must be that request or an earlier one. It must itself be pending, unsent, and have an outstanding probe with the same ID. A worker alone does not justify a wait.

`Lane::start` accepts `terminal.create` with `Pending.line = None` and starts `terminal::frame` on the blocking pool. `Lane::flush` stops at that entry even if the worker has started. For example, with a running worker, create 1 can still be preparing while dispose 2 is ready. `MC_sanity_NeverWaitsBehindCreate.cfg` requires TLC to reach that state. When the head becomes ready, fails, or is withdrawn, a running lane must drain the next ready prefix in that same message.

Sanity properties (each must be violated): `NeverRecycles`, `NeverRetires`, `NeverIdleExits`, `NeverAnswersLate`, `NeverWaitsBehindCreate`.
