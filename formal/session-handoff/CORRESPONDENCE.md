# Correspondence: SessionHandoff.tla ↔ code

Sync commit: 9e6706aaa948e11f0848764449ebc46f12711921 plus the uncommitted F1/F2 fixes (the code read; the model was not yet checked by TLC there).

| Model | Code | Atomic because |
|---|---|---|
| `ABegin` | `session-mutations.ts:301-320` `handOffSession`: `beginHandoff` (`deleted.rs:201-221`, `save_checked` before anything crosses), then the first `sessions.handoff.put` | `beginHandoff` is synchronous; a crash after it and before the put equals a lost put |
| `AGotPut(r)` | `session-mutations.ts:308-329`: the part answered, the commit next; a refused part goes to `settleHandOff` | one awaited answer, then the next request |
| `AGotCommit(r)` | `session-mutations.ts:322-342`: landed → `finishHandOff` settles the tombstone (`deleted.rs:223-245`); an error → `settleHandOff` | `settleHandoff` runs synchronously in the turn the answer arrives |
| `AGotAbort(r)` | `session-mutations.ts:256-264`: `moved` → `finishHandOff`; `aborted` → the entry goes | same |
| `AFinish` | `session-mutations.ts:222-232`: stock deletes A's copy | the `await removeStored` |
| `AReconcile` | `session-mutations.ts:364-374` `reconcileHandOffs`, from `index.ts:2052-2061` on each link-up; skips ids being settled (`settling`) | one ask per pending transfer |
| `ATimeout` | `HANDOFF_TIMEOUT_MS` (`session-mutations.ts:197-204`) firing while the link stays up; only with `TimeoutKeepsLink`. A failed abort schedules the retry (`session-mutations.ts:239-255`, `RetryAbort`): `aAsk` is set, and `AReconcile` is the timer's `reconcileHandOffs` | environment |
| `BPut` | `host-services.ts:1521-1524` → `handoff.rs:226-283` `put` | the core's global lock |
| `BCommit` | `host-services.ts:1525-1539` → `handoff.rs:452-518` `commit` up to the `committing` save, with `resolve` (`:394-424`, `ResolveClears`: a target in place clears B's tombstone, `ClearOnResolve`) for a `committing` record | the lock, held through the steps below |
| `BMove`, `BRename`, `BClear`, `BDone` | `handoff.rs:519-525`, `:526`, `:533-534`, `:535-544` | split at each crash point; `bPc # "idle"` keeps every other B step out (the lock) |
| `BLandFail` | `handoff.rs:528-532`: a landing step failed, `resolve(keep=true)` unwinds to `staged` | the lock |
| `BAbort` | `host-services.ts:1540-1541` → `handoff.rs:547-583` `abort` (its `resolve` clears too) | the lock |
| `LinkDrop`, `LinkUp` | the link (`RemoteDevices`): A's waiting request fails, `settleHandOff` leaves the transfer pending (`session-mutations.ts:328-339`); link-up fires `onHostOnline` | environment |
| `ACrash`, `BCrash` | restart: `deleted.rs:112-157` `Store::load`, `handoff.rs:73-88` `Record::load` | environment |
| `aState`, `aSaved` | `deleted.rs` tombstone with `handoff {id, device, to}`: pending = `to` none, moved = `to` set, reclaimed = entry removed | |
| `bRec`, `bJournal`, `bArt`, `bTarget`, `bTomb` | `session-handoffs-in.json`, `handoff-in/<id>/session.jsonl`, the artifacts folder beside the target, the target journal, B's `deleted-sessions.json` entry for the target | |

## Assumptions

- The retry timer is volatile: an A restart drops it (`ACrash` clears `aAsk`), and the link coming up after the restart asks instead. A link drop fails the abort `remote_offline`, which schedules no retry; the next link-up asks.
- A request on a dropped link fails at once, and settleHandOff's abort fails with it, before the link can come back. A reconnect takes seconds; the rejection runs in the same few turns.
- A matches an answer by kind. The code matches by request id and drops a stale answer. Accepting a stale one is a superset, and every stale `moved` or `aborted` answer B can send states B's durable record.
- A's tombstone saves succeed. `settle_handoff` uses `save` (logged, kept in memory on a full disk). A lost settle save leaves the entry pending on disk, and the next reconcile settles it again, so this hides no safety bug.
- B's record writes in put, commit (`committing`) and abort are atomic renames (`write_atomic_if`) and either happen or fail the step. The `done` save may fail (`let _ =`), and so may the staging removal after an abort; both are modeled as free choices.
- Requests B already received survive a link drop or an A restart (`SUBSET toB`). A B restart loses them all.
- One transfer id and one part. More parts repeat `BPut`. A part arriving out of order is refused by offset, which is not modeled.
- Other transfers cannot change a terminal decision for this id. B retains both `done` and `aborted` on disk; neither ages out.

## Granularity

One step is one locked section on B (the core's `LOCK`). Commit is the exception: it is split into the crash points `committing` saved, artifacts moved, rename, clear and `done`. The lock is modeled by `bPc # "idle"`. On A, one step is the code between two awaited answers. Merged steps: `ABegin` merges `beginHandoff` with the first put; `AGotCommit` and `AGotAbort` merge the answer with `settleHandoff`, because there is no await between them.
