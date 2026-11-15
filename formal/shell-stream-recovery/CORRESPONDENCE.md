# ShellStreamRecovery correspondence

| Model action | Source | Atomic boundary |
|---|---|---|
| `Push` | `ipc.rs` `Stream.push` | Existing stream mutex covers append, eviction and reset position. |
| `StartPartial`, `FinishFrame`, `StartReset` | `ipc.rs` `Stream.fill` | One pull holds the mutex. The model splits buffer-limited copying between calls, exposing more interleavings without discarding a partly copied frame. |
| `FinishReset` | preload `dispatch` / `resetStream` | One complete parsed line creates a new opaque token synchronously. Native reset debt is an observer, not an actual wire field. |
| `ReplaceReader` | `ipc.rs` `open_reader` | Replace the Arc identity and take the old waiter under the same mutex; invoke it outside the lock. |
| `OldRead`, `OldCancel`, `Park` | `pull`, `reader_gone`, `read_or_park` | Each tests the captured reader Arc under the stream mutex. The scheme resource retains that exact reader. |
| `StartRead` | `installShellResync` | Capture the pending object before `await run()`. |
| `FinishRead` | `resyncPage` return or rejection | Environment outcome: required applicable reads must actually succeed. Store correctness is not assumed proven by this model. |
| `DiscardRead` | `PageResync` subsequent pass | A failed or superseded pass can be retried; retry timing/budget and availability are outside this safety model. |
| `Ack` | `installShellResync` plus preload `acknowledge` | A successful read asks to clear its captured object; equality with the current object is checked synchronously. |

A new loss can occur during frame delivery, a partial reset or a read. Queue capacity is reduced only as an explicit model bound; production remains 4096. The latest eviction must remain represented even when resets coalesce. Reader IDs stand for non-reused Arc identities, not integer webContents IDs or a new authority.

This model does not establish that every lost event is reconstructible, that an offline host is fresh, or that replaying a mutation is safe. Recovery must remain read-only, keep drafts/queues/asks, preserve views on a raced read and apply a successful approval snapshot independently of an unrelated failed status read. The renderer and native consumer regressions verify those separate implementation obligations.
