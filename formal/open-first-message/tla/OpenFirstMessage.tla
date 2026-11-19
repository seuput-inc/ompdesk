--------------------------- MODULE OpenFirstMessage ---------------------------
(* An open's first message across a quit. `ompdesk_session_open` makes the   *)
(* child's tab, then sends its setup and first message to the child's omp,   *)
(* which holds a queued prompt in memory until its loop journals it. The app *)
(* may quit anywhere in between (an update's restart); the relaunch restores *)
(* the child's tab with a new omp. The fix keeps the message in the send     *)
(* outbox (send-outbox.json) before anything goes out and records which omp  *)
(* was handed it; the sweep hands it once to an omp that never had it, and   *)
(* lets it go once the child's journal holds its dispatch marker.            *)
(*                                                                           *)
(* Constants: Keep (the message is kept before it goes out: the fix),        *)
(* TrackInstance (the sweep skips the omp it was handed to), MaxQuits.       *)
EXTENDS Naturals

CONSTANTS Keep, TrackInstance, MaxQuits

None == 0

VARIABLES
    up,         \* the app runs
    open,       \* the open call: "idle" | "sending" | "done" | "cut" (a quit ended it)
    omp,        \* which omp the child's tab runs now (a relaunch starts another)
    kept,       \* the outbox entry: [at |-> omp it was handed to, None before] or the empty record when none
    held,       \* copies of the message the current omp holds unjournaled (lost with it)
    journaled,  \* copies of the message in the child's journal
    quits

vars == <<up, open, omp, kept, held, journaled, quits>>

NoEntry == [at |-> None, there |-> FALSE]

TypeOK ==
    /\ up \in BOOLEAN
    /\ open \in {"idle", "sending", "done", "cut"}
    /\ omp \in 1..(MaxQuits + 1)
    /\ kept \in [at : 0..(MaxQuits + 1), there : BOOLEAN]
    /\ held \in 0..3
    /\ journaled \in 0..3
    /\ quits \in 0..MaxQuits

Init ==
    /\ up = TRUE /\ open = "idle" /\ omp = 1 /\ kept = NoEntry
    /\ held = 0 /\ journaled = 0 /\ quits = 0

\* @code native/ompdesk/crates/core/src/agentctl/service/sessions/open.rs:634-637 the child is ready: its setup and first message are kept before any goes out
Begin ==
    /\ up /\ open = "idle"
    /\ open' = "sending"
    /\ kept' = IF Keep THEN [at |-> None, there |-> TRUE] ELSE kept
    /\ UNCHANGED <<up, omp, held, journaled, quits>>

\* @code native/ompdesk/crates/core/src/agentctl/service/sessions/open.rs:665-692 the first message goes to the child's omp; the entry records that omp
Send ==
    /\ up /\ open = "sending"
    /\ open' = "done"
    /\ held' = held + 1
    /\ kept' = IF kept.there THEN [kept EXCEPT !.at = omp] ELSE kept
    /\ UNCHANGED <<up, omp, journaled, quits>>

\* The child's omp journals a prompt it holds (its loop takes it).
Journal ==
    /\ up /\ held > 0
    /\ held' = held - 1 /\ journaled' = journaled + 1
    /\ UNCHANGED <<up, open, omp, kept, quits>>

\* Environment: the app quits (an update's restart): the open call ends, the omp and what it held go.
Quit ==
    /\ up /\ quits < MaxQuits
    /\ up' = FALSE /\ quits' = quits + 1 /\ held' = 0
    /\ open' = IF open = "sending" THEN "cut" ELSE open
    /\ UNCHANGED <<omp, kept, journaled>>

\* The relaunch restores the child's tab with a new omp.
Relaunch ==
    /\ ~up
    /\ up' = TRUE /\ omp' = omp + 1
    /\ UNCHANGED <<open, kept, held, journaled, quits>>

\* @code native/ompdesk/crates/core/src/agentctl/journal/send_outbox.rs:473-521 the sweep: settled once journaled; skipped by the omp that holds it; else handed (setup first)
Sweep ==
    /\ up /\ kept.there /\ open # "sending"
    /\ IF journaled > 0
       THEN /\ kept' = NoEntry /\ UNCHANGED held
       ELSE IF TrackInstance /\ kept.at = omp
            THEN UNCHANGED <<kept, held>>
            ELSE /\ held' = held + 1 /\ kept' = [kept EXCEPT !.at = omp]
    /\ UNCHANGED <<up, open, omp, journaled, quits>>

Next == Begin \/ Send \/ Journal \/ Quit \/ Relaunch \/ Sweep \/ UNCHANGED vars

Spec == Init /\ [][Next]_vars
    /\ WF_vars(Begin) /\ WF_vars(Send) /\ WF_vars(Journal) /\ WF_vars(Relaunch) /\ WF_vars(Sweep)

----------------------------------------------------------------------------
\* ==== FROZEN PROPERTIES (Properties.md) ====
\* P1 The child's journal holds its first message at most once.
OnceAtMost == journaled <= 1
\* P2 Once the open began, the message is never lost: kept, held by the omp, or journaled.
NeverLost == open # "idle" => (kept.there \/ held > 0 \/ journaled > 0)
\* P3 Once the open began, the child gets its first message.
Arrives == (open # "idle") ~> (journaled > 0)
\* ==== END FROZEN PROPERTIES ====

\* Sanity (must FAIL): a quit that cuts the open is reachable, and the message still arrives after it.
NoCutArrival == ~(open = "cut" /\ journaled > 0)
=============================================================================
