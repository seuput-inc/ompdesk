---------------------------- MODULE TabListStatus ----------------------------
(* A window's view of one tab's status. Main (the core's pool) changes the   *)
(* tab's state and pushes every change as TAB_STATUS, in order. The window    *)
(* also asks main for its whole tab list (GET_TABS: the boot reconcile, a     *)
(* TAB_LIST_CHANGED naming an unseen tab, a failed route). The list answer    *)
(* and the pushes travel on different routes, so an answer read before a push *)
(* can land after it. UseGuard = TRUE is the code as written: a listing does  *)
(* not overwrite a tab that received a push while the list was asked.         *)
(* FALSE is the code before the fix (cold start left on "starting").          *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS MaxV, Reqs, UseGuard

\* mainV: main's state of the tab, one number per change (0 = starting, 1 = ready, ...).
\* pushes: TAB_STATUS frames on their way to the window, oldest first.
\* view: the state the window shows. pushCount: pushes the window applied (`statusPushes`).
\* req[r]: one reconcile's list request: its phase, the push count when it was sent, main's answer.
\* late: answers that landed after a push of the same tab (sanity: the guarded case is reached).
VARIABLES mainV, pushes, view, pushCount, req, late
vars == <<mainV, pushes, view, pushCount, req, late>>

Phases == {"idle", "sent", "answered", "done"}

TypeOK ==
    /\ mainV \in 0..MaxV
    /\ pushes \in Seq(0..MaxV)
    /\ view \in 0..MaxV
    /\ pushCount \in 0..MaxV
    /\ req \in [Reqs -> [phase : Phases, sent : 0..MaxV, snap : 0..MaxV]]
    /\ late \in 0..Cardinality(Reqs)

Init ==
    /\ mainV = 0 /\ pushes = <<>> /\ view = 0 /\ pushCount = 0
    /\ req = [r \in Reqs |-> [phase |-> "idle", sent |-> 0, snap |-> 0]]
    /\ late = 0

\* @code native/ompdesk/crates/core/src/pool/listen.rs:58-65 feed_status: the tab's state changes
\* @code native/ompdesk/crates/core/src/pool/state.rs:563-573 forward_status: TAB_STATUS with the state at send time
MainChange ==
    /\ mainV < MaxV
    /\ mainV' = mainV + 1
    /\ pushes' = Append(pushes, mainV + 1)
    /\ UNCHANGED <<view, pushCount, req, late>>

\* @code src/renderer/stores/tabs.ts:1353-1356 applyTabStatus: counts the push, then projects it over the tab
Push ==
    /\ pushes # <<>>
    /\ view' = Head(pushes)
    /\ pushes' = Tail(pushes)
    /\ pushCount' = pushCount + 1
    /\ UNCHANGED <<mainV, req, late>>

\* @code src/renderer/stores/tabs.ts:722-725 reconcileTabs: takes the push count, then asks `window.omp.tabs.list()`
Send(r) ==
    /\ req[r].phase = "idle"
    /\ req' = [req EXCEPT ![r].phase = "sent", ![r].sent = pushCount]
    /\ UNCHANGED <<mainV, pushes, view, pushCount, late>>

\* @code native/ompdesk/crates/core/src/pool/windows.rs:716 tabs_for_window: main reads its tabs (the answer)
Answer(r) ==
    /\ req[r].phase = "sent"
    /\ req' = [req EXCEPT ![r].phase = "answered", ![r].snap = mainV]
    /\ UNCHANGED <<mainV, pushes, view, pushCount, late>>

\* @code src/renderer/stores/tabs.ts:769-810 reconcileTabs: a tab pushed since the ask keeps what the push said
Apply(r) ==
    /\ req[r].phase = "answered"
    /\ req' = [req EXCEPT ![r].phase = "done"]
    /\ late' = IF pushCount > req[r].sent THEN late + 1 ELSE late
    /\ view' = IF UseGuard /\ pushCount > req[r].sent THEN view ELSE req[r].snap
    /\ UNCHANGED <<mainV, pushes, pushCount>>

Quiet == pushes = <<>> /\ \A r \in Reqs : req[r].phase \in {"idle", "done"}
Next ==
    \/ MainChange \/ Push
    \/ \E r \in Reqs : Send(r) \/ Answer(r) \/ Apply(r)
    \/ (Quiet /\ mainV = MaxV /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars

\* ============================ FROZEN PROPERTIES ============================
\* P1 (Properties.md): once nothing is on its way (no push, no list answer), the window shows main's state.
QuietAgrees == Quiet => view = mainV
\* ========================== END FROZEN PROPERTIES ==========================

\* Sanity (must FAIL): a list answer lands after a push of its tab, so QuietAgrees is not vacuous.
NoLateAnswer == late = 0
=============================================================================
