# Scope: a command across a relaunch runs once

## The promise

Whatever ends the omp a session runs in (OMPdesk's quit or update restart, a crash, a computer that goes off), a command the agent ran (`bash`, `eval`, `ssh`) makes its effect at most once. A stop never cuts a command that ends within the stop's wait (`QUIT_COMMAND_DRAIN_MS`, 20 s): its whole result reaches the journal and the relaunch goes on from it.

## The harm

Stock's restore runs a cut or failed command again with the same arguments (turn-recovery.ts `toolReplayStart`): a `git commit`, a push, a release, a message sent twice (the owner's report, 20 Nov 2026: the same empty commit made twice when a turn resumed). A command cut at a stop loses its output, and the agent repeats it.

## Why tests miss it

The harm is in the order of the stop, the command's effect, its result reaching the journal, the relaunch's restore and stock's replay, and a crash can land between any two. The stock test (`bridge-restore-request-stock.test.ts`, "a command a stop or a crash cuts") pins three orders on real omp; the model checks every order within the bounds.

## Bounds

One call, 3 lives with a command that ends within the stop's wait (`MC.cfg`), 4 lives with one that does not (`MC_long.cfg`). Any order of the call's journaling, start, effect and result, a stop or a kill at any moment, the relaunch's restore and stock's replay.

## In the model

quit-journal.ts: the stop's wait for running commands and its abort (`BeginStop`, `StopAbort`, `StopEnd`), the `tool_call` refusal of a replayed command an earlier life journaled (`Replay`). Stock: the reply with the call journaled before the call runs, the replay of a call whose result is an error or missing (`Relaunch`), a kill journaling nothing.

## Not in the model

- The agent's own decision after a refusal: it may run the command again after checking what it did. The promise is that OMPdesk and stock never run it again by themselves.
- Batches of several calls: stock dispatches every call of a batch (`prepareToolCallDispatch`, every `tool_call` emitted) before any runs, while the journal's leaf is the batch's reply, so each call is judged as the single call here.
- Background jobs (`async: true`, stock's auto-background after 60 s): a stop cancels them; the relaunch names them to the agent (`restart-core.ts` `interruptedJobs`), never runs them by itself.
- Time: the stop's 20 s and the 30 s quit watchdog appear only as `Short`.
- Liveness (that the turn goes on after the relaunch): `turn-resume`'s model and `turn-resume.test.ts`.
