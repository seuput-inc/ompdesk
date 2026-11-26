# Scope: handing a stored session to a paired computer

## The promise and the harm

At no time can both computers run the session, and once the link stays up and both computers stay up, exactly one of them can. A session that two computers both run forks its journal: two writers append different turns and one computer's work is lost. One that neither can run is stuck: the person sees it nowhere. Tests pin single orders (a lost commit answer, a restart mid-transfer, a commit held past the abort); the bugs live in the orders between a link drop, a delayed or duplicated request and a crash in the middle of B's commit.

## Modeled (in scope)

- A records the transfer pending, then sends the parts (`src/main/session-mutations.ts:301-320`, `deleted.rs` `begin_handoff`).
- A's answers: part, commit (`finishHandOff`), abort (`settleHandOff`), and A removing its copy (`session-mutations.ts:222-264, 308-342`).
- A asks again on each link-up (`reconcileHandOffs`, `index.ts:2052-2061`), and once more after `HANDOFF_RETRY_MS` when an abort failed with the link up (`session-mutations.ts:239-255`).
- B's put, commit and abort under one lock, with the commit split at its crash points: `committing` saved, temp written and artifacts moved, rename, own tombstone cleared, `done` (`remote/handoff.rs:226-283, 394-424, 452-583`); `resolve` clears B's own tombstone of a target in place.
- Link drops (A's waiting request fails at once; requests B already received may still run), duplicated requests, a failed landing step, A and B restarting with their durable records.

## Abstracted

- One transfer id, one part: more parts repeat the same put step. A's earlier `sessions.handoff.folder` request is not modeled (nothing durable happens before `begin_handoff`).
- Messages are sets with a fault budget; A matches an answer by its kind, not its request id (a superset of what A accepts).
- A request on a dropped link fails at once, before the link can come back (`Drop`).
- Tombstone saves on A (`settle_handoff`, `write_kept`) succeed; B's `done` save and the staging removals may fail (both are `let _ =` in the code).
- B's abort is one step: a crash before its answer equals a lost answer; a crash before its save equals no abort.

## Out of scope

- A second hand-over of the same session (a new id), and B handing it back to A.
- The 2000-settled-records trim on B (`MAX_SETTLED`): an aborted id trimmed away loses its fence.
- Damaged records, `transfer.from` mismatches, part offsets, blob hashes, `session_exists` from another session, the project folder lookup.
- Stock's `deleteSession` and the device tabs closing.

## Properties

| Name | Kind | Source |
|---|---|---|
| `AtMostOneRunnable` | invariant | reviewer's request; `.omp/rules/remote-devices.md` › "Handing a session to a paired computer" ("at most one computer can run the session during an outage") |
| `NoCommitAfterAbort` | invariant | `remote/handoff.rs` module doc and `abort` comment ("no part or commit of this id may land after that") |
| `ExactlyOneRunnable` | liveness | same rules section ("exactly one after it") |

## Bounds

| Run | Bounds | States, depth, time |
|---|---|---|
| `MC.cfg` | one id, at most 2 faults, safety | not run yet |
| `MC_large.cfg` | at most 4 faults, timeouts with the link up included, safety | not run yet |
| `MC_live.cfg` | at most 2 faults, then weak fairness on every handler, link-up and reconcile | not run yet |
| `MC_back.cfg` | as `MC_live.cfg`, the session handed back (B holds a tombstone at the target) | not run yet |
| `MC_timeout.cfg` | as `MC_live.cfg`, A's requests may time out while the link stays up | not run yet |

Two faults reach every bug mode in `matrix.json` (each needs one or two).

## Findings (fixed; the model holds the fix, a bug-mode run holds the code before it)

Both came from reading the model against the code; neither trace has been produced by TLC yet.

- **F1** (`MC_back.cfg` passes, `MC_bug_back_noclear.cfg` must fail): a session handed back to B, at a path B holds a tombstone for. B crashes between the rename and the commit's `deleted::clear`; the next commit or abort `resolve`d the transfer done without clearing it, so A settled `moved` and deleted its copy while B's tombstone blocked the file. Fix: `resolve` clears the tombstone when the target is in place (`handoff.rs:401-403`); Rust test `a_crash_after_the_rename_reads_as_moved`.
- **F2** (`MC_timeout.cfg` passes, `MC_bug_timeout_noretry.cfg` must fail): A's abort times out while the link stays up (B's global lock held by a long artifact copy). B saved `aborted`, A kept the transfer pending, and nothing asked again until the link dropped or A restarted. Fix: `settleHandOff` schedules one `reconcileHandOffs` after `HANDOFF_RETRY_MS` when the abort fails with anything but `remote_offline`/`remote_unknown_device` (`session-mutations.ts:245-253`).

## Tools and files

- TLA+ with TLC: interleavings, message loss and duplication, crashes, and a liveness property.
- Files: `tla/SessionHandoff.tla`, `tla/MC*.cfg`, `tla/matrix.json`, `tla/mutations.json`, `CORRESPONDENCE.md`, `Properties.md`.
- Manifest id: `session-handoff` in `formal/manifest.json`.
