# Correspondence: RelaunchOnce.tla ↔ code

| Model | Code | Atomic because |
|---|---|---|
| `Journal` | stock: the assistant reply with the call reaches the journal (`message_end`) | one append |
| `Start` | stock: the loop runs a call `tool_call` let through (`prepareToolCallDispatch` → `tool.execute`) | the run starts once dispatched |
| `Effect` | the command's own side effect | environment step |
| `Finish` | the result message is journaled; `message_end` settles it in `commands` (quit-journal.ts) | one append |
| `BeginStop` | `session_shutdown` (stock dispose, after `session_exit`): the handler holds dispose | the handler is awaited |
| `StopAbort` | `commands.settled(QUIT_COMMAND_DRAIN_MS)` ran out (or, without `Drain`, no wait), `agent.abort()`: the aborted result is journaled | the abort's result follows at once |
| `StopEnd` | dispose ends, the process exits; a dispatched call that never ran gets stock's aborted result | |
| `Kill` | SIGKILL, a crash, the computer off | nothing more reaches the journal |
| `Relaunch` | the next omp; `composer.restore_interrupted` → stock `restoreSession` (a missing result becomes "outcome unknown") → `retry` → `toolReplayStart` (every result of the batch an error) | the restore is one request |
| `Replay` | stock's replay dispatches the call again; quit-journal.ts `tool_call` → `replayOfEarlierLife` → `block` | the hook runs before the tool |

## Abstractions that could hide a bug

- **The leaf is the replay's anchor.** The guard reads the journal's leaf (`getLeafEntry`): stock's `#stripForToolReplay` moves it to the reply before it dispatches. A replay path that dispatched without moving the leaf would run the command (none in omp 19.0.0).
- **The journal's clock.** "An earlier life" is an entry journaled before `performance.timeOrigin`; the same rule `restart-core.ts` uses.
- **A first run never matches**: stock dispatches a streamed call before its reply is journaled. A provider that does not stream journals the reply first, but in this process, so the guard lets it run.
