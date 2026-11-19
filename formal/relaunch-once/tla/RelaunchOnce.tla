---------------------------- MODULE RelaunchOnce ----------------------------
(*
 * One command call (a `bash`, `eval` or `ssh` tool call with an effect) across the lives of the omp that runs a
 * session (resources/gui-bridge/quit-journal.ts).
 *
 * Stock journals the model's reply with the call, runs it, journals its result. A stop (OMPdesk's quit or update
 * restart: stdin closes, stock disposes the session) aborts the loop; a kill (a crash, a computer that went off) ends
 * the process with nothing more journaled. The next life's restore closes a call with no result as "outcome unknown"
 * and stock's `retry` runs a batch whose every result is an error again, with the same call id and arguments.
 *
 * `Drain` and `Guard` are the two rules of quit-journal.ts, TRUE in the code; a mutation turns each off. `Short`: the
 * command ends within the stop's wait (`QUIT_COMMAND_DRAIN_MS`).
 *)
EXTENDS Naturals

CONSTANTS MaxLives, Short, Drain, Guard

VARIABLES
    alive,     \* the session's current omp runs
    life,      \* how many omps have run the session
    stopping,  \* a stop is under way (session_shutdown ran, dispose waits on it)
    call,      \* "none" | "journaled" | "running" | "done" | "replay" | "refused"
    callLife,  \* the life that journaled the reply holding the call
    result,    \* the call's journaled result: "none" | "ok" | "error" | "aborted" | "unrun" (aborted before it ran)
    effected,  \* the execution under way has made its effect
    effects    \* how often the command's effect happened, over every life

vars == <<alive, life, stopping, call, callLife, result, effected, effects>>

TypeOK ==
    /\ alive \in BOOLEAN
    /\ life \in 1 .. MaxLives
    /\ stopping \in BOOLEAN
    /\ call \in {"none", "journaled", "running", "done", "replay", "refused"}
    /\ callLife \in 0 .. MaxLives
    /\ result \in {"none", "ok", "error", "aborted", "unrun"}
    /\ effected \in BOOLEAN
    /\ effects \in 0 .. MaxLives

Init ==
    /\ alive = TRUE
    /\ life = 1
    /\ stopping = FALSE
    /\ call = "none"
    /\ callLife = 0
    /\ result = "none"
    /\ effected = FALSE
    /\ effects = 0

\* Stock: the model's reply with the call reaches the journal.
Journal ==
    /\ alive /\ ~stopping /\ call = "none"
    /\ call' = "journaled"
    /\ callLife' = life
    /\ UNCHANGED <<alive, life, stopping, result, effected, effects>>

\* Stock: the loop runs the call it dispatched (`tool_call` let it through on its first run).
Start ==
    /\ alive /\ ~stopping /\ call = "journaled"
    /\ call' = "running"
    /\ effected' = FALSE
    /\ UNCHANGED <<alive, life, stopping, callLife, result, effects>>

\* The command does what it does (a commit, a push, a line appended).
Effect ==
    /\ alive /\ call = "running" /\ ~effected
    /\ effected' = TRUE
    /\ effects' = effects + 1
    /\ UNCHANGED <<alive, life, stopping, call, callLife, result>>

\* The command returns and its result is journaled; also while a stop lets it finish.
\* @code resources/gui-bridge/quit-journal.ts:76-80 message_end of the result settles the call the stop waits for
Finish ==
    /\ alive /\ call = "running"
    /\ call' = "done"
    /\ result' \in IF effected THEN {"ok", "error"} ELSE {"error"}
    /\ UNCHANGED <<alive, life, stopping, callLife, effected, effects>>

\* @code resources/gui-bridge/quit-journal.ts:86-90 session_shutdown: the stop begins and holds dispose
BeginStop ==
    /\ alive /\ ~stopping
    /\ stopping' = TRUE
    /\ UNCHANGED <<alive, life, call, callLife, result, effected, effects>>

\* The loop is aborted with the command still running: its aborted result is journaled. Under `Drain` the stop first
\* waits for the command, so only one that outlasts the wait is cut.
\* @code resources/gui-bridge/quit-journal.ts:90-97 the wait for running commands, then the abort
StopAbort ==
    /\ alive /\ stopping /\ call = "running"
    /\ ~(Drain /\ Short)
    /\ call' = "done"
    /\ result' = "aborted"
    /\ UNCHANGED <<alive, life, stopping, callLife, effected, effects>>

\* Dispose ends: the process exits. A call journaled but never started gets stock's aborted result: it never ran.
StopEnd ==
    /\ alive /\ stopping /\ call # "running"
    /\ alive' = FALSE
    /\ stopping' = FALSE
    /\ IF call = "journaled"
          THEN call' = "done" /\ result' = "unrun"
          ELSE UNCHANGED <<call, result>>
    /\ UNCHANGED <<life, callLife, effected, effects>>

\* A crash or a kill at any moment: nothing more is journaled.
Kill ==
    /\ alive
    /\ alive' = FALSE
    /\ stopping' = FALSE
    /\ UNCHANGED <<life, call, callLife, result, effected, effects>>

\* The next omp opens the session and the relaunch restores it: a call with no result is closed as "outcome unknown",
\* and stock's retry replays a call whose result is an error; an ok result is answered by the model.
\* @code resources/gui-bridge/composer.ts:464-517 composer.restore_interrupted -> stock restoreSession -> retry
Relaunch ==
    /\ ~alive /\ life < MaxLives
    /\ alive' = TRUE
    /\ life' = life + 1
    /\ effected' = FALSE
    /\ call' = IF call \in {"journaled", "running"} \/ (call = "done" /\ result \in {"error", "aborted", "unrun"})
                  THEN "replay"
                  ELSE call
    /\ UNCHANGED <<stopping, callLife, result, effects>>

\* Stock's replay dispatches the call again; `tool_call` refuses a command an earlier life journaled.
\* @code resources/gui-bridge/quit-journal.ts:63-70 tool_call: replayOfEarlierLife -> block
Replay ==
    /\ alive /\ ~stopping /\ call = "replay"
    /\ IF Guard /\ callLife < life
          THEN call' = "refused" /\ UNCHANGED effected
          ELSE call' = "running" /\ effected' = FALSE
    /\ UNCHANGED <<alive, life, stopping, callLife, result, effects>>

Next ==
    \/ Journal \/ Start \/ Effect \/ Finish
    \/ BeginStop \/ StopAbort \/ StopEnd \/ Kill
    \/ Relaunch \/ Replay

Spec == Init /\ [][Next]_vars

\* ================================ PROPERTIES (frozen) ================================
\* P1: whatever stops or kills the omp, a command's effect happens at most once.
AtMostOnce == effects <= 1

\* P2: a stop never cuts a command that ends within the stop's wait.
ShortCommandNotCut == Short => result # "aborted"
\* ======================================================================================

\* Sanity: an effect is reachable, so P1 is not vacuous.
NeverEffect == effects = 0
=============================================================================
