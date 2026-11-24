# Correspondence: WebCloseReports.tla ↔ code

| Model | Code | Atomic because |
|---|---|---|
| `Edit(p, v)` | `src/renderer/web/FileEditReporter.tsx` effect on `fileEditDirty`/`fileEditTabId`/`activeTabId` → `reportFileEdits` | one React effect run; the frame joins the socket's FIFO |
| `Connect(p)` | the core's router `Host::attach_conn` (`web/router.rs`; a new connection, `connId` a random UUID) | under the router's lock |
| `Greet(p)` | `FileEditReporter`'s `onConnectionState("open")` → send | the page's own effect, after the hello |
| `Drop(c)` | the core's `Host::finish` (`web/router.rs`): the connection leaves the router and `state.file_edits.forget(conn_id)`, under the router's lock | one synchronous run under the lock `receive` also takes; the core refuses the connection's frames from the moment it ends |
| `Deliver(c)` | the core's `Host::receive` (refuses an ended connection) → `Host::dispatch` (authorizes as `IPC_POLICY` says, `workspace`) → `Host::file_edit_report` → `FileEditReports::report` | one synchronous run under the router's lock: nothing awaits, and only exactly one `{dirtyTabId}` is a report (`file_edits::parse_report`), so a frame carrying a picture is never one (pinned: `ws-router.test.ts` "a page's Files-edit report") |
| `Write` / `Forget` | `FileEditReports::report` / `forget` (`web/file_edits.rs`): one connection's entry | HashMap insert/remove |
| `Edits(t)` | `FileEditReports::edits` | pure read |
| `CloseStep(t)` | `tab_close_step` (`native/ompdesk/crates/core/src/agentctl/rules/tab_close.rs`, the core's one close rule) minus `looked`/`userTouched` | pure |
| `CloseDecide(t)` | the core's `close_tab` (`native/ompdesk/crates/core/src/agentctl/service/sessions/stop.rs`) reads the snapshot's tabs (each tab's `webEdits`, which `host.ts` `#controlTab` reads from the core's store through the pool's `fileEdits`, pushed to the core) and applies `tab_close_step` | synchronous until `await host.release` |
| `CloseRelease(t)` | `host.release` → `closeWindowTab` (guard `{host, device}`) → exit-policy read and, for a paired owner, the page's word and then host acknowledgement → `SidecarPool.releaseTab {unlessDirty}` → the pool's `release_entry` removes the entry inside `router::unless_dirty` | the check and the removal run under the router's lock in one closure on the hub thread; `receive` takes the same lock, so a report lands before the check or after the removal. Main re-checks nothing after the awaits (its re-checks went in the C3 correction); the page's word before the host request only keeps a dirty tab's host turn open. The host's own removal is a separate decision, outside this model; if a dirty report lands during the host request, the local tab and its editors remain. |

## Abstractions that could hide a bug

- One window: the store's device filter is not exercised here (`file_edits.rs` tests every order over two devices instead).
- The model tracks unsaved edits, not turns or terminals. A refusal by the turn check leaves the tab open; it is not evidence that a paired host still has the same turn.
- Frames are FIFO per connection and never duplicated (a WebSocket).
- `Greet` sends from the page's current editor state; the real page sends `fileEditTabId ?? activeTabId` when dirty, which the model folds into `edit[p]`.
- The `SplitDispatch` switch is how the model says "the report is recorded in the frame's own run"; the code keeps it because the router answers `FILE_EDIT_REPORT` inside `dispatch`, never through main's `#dispatch` (which may await a picture's upload).
- The `SplitRelease` switch is how the model says "the release's last check and the removal are one step"; the code keeps it because `release_entry` removes the entry inside `unless_dirty`, holding the router's lock (a check in main followed by a separate `releaseTab` call would be the mutation).

## Closed gaps: a report during the release's awaits, and between the check and the removal

Before `stillClosable`, a dirty report that landed after `close_tab` decided and before `releaseTab` ran (during `refreshExitPolicy`) did not stop the release (`NoLateDirtyRelease` failed, 7 steps); the `no-recheck-before-release` mutation puts that gap back. Since C2 the store is the core's router's, whose threads record reports while main runs, so a check in main followed by the pool's removal in a second call would let a report land between them. The pool removes the entry inside the router's lock instead (`unless_dirty`), and the `split-release` mutation puts the two-step version back. Both must be detected.
