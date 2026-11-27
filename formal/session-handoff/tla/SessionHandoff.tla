--------------------------- MODULE SessionHandoff ---------------------------
(* One transfer of a stored session from computer A to its paired computer B   *)
(* (`handOffSession`). A records the transfer pending in its tombstone store   *)
(* before anything crosses (a pending tombstone blocks every revival), sends   *)
(* the parts, then the commit. B stages the parts, then commits under one lock *)
(* in steps: `committing` recorded, artifacts moved beside the target, the     *)
(* journal renamed into place, its own old tombstone cleared, `done`. Any      *)
(* failure makes A ask B to call the transfer off (`abort`): B answers `moved` *)
(* when it committed, otherwise records the id aborted before it answers and   *)
(* refuses every later part or commit of it. Only that answer gives the        *)
(* session back to A. A pending transfer is asked about again each time B's    *)
(* link comes up (`reconcileHandOffs`).                                        *)
(*                                                                             *)
(* Messages are sets: a request can be lost (link drop, crash), delayed (kept  *)
(* in toB across A giving up) and duplicated (a fault that leaves a request    *)
(* in toB after B handled it). A and B crash and restart at once: volatile    *)
(* state goes, the durable records and files stay. Every fault spends one of   *)
(* MaxFaults, so a behaviour ends with the link fair and no further faults.    *)
(*                                                                             *)
(* Constants pick the design: PendingDurable (A's pending tombstone is on disk *)
(* before the first part crosses), AbortRecords (B saves `aborted` before it   *)
(* answers it), FenceAborted (B refuses a part or commit of an aborted id),    *)
(* BLeftBefore (B holds a tombstone at the target path: the session once left  *)
(* B, now handed back), TimeoutKeepsLink (A's 2-minute request timeout fires   *)
(* while the link stays up), ClearOnResolve (resolving a committing transfer   *)
(* whose target is in place also clears B's own tombstone of it), RetryAbort   *)
(* (an abort that failed while the link stayed up asks again after            *)
(* HANDOFF_RETRY_MS).                                                          *)
EXTENDS Naturals

CONSTANTS MaxFaults, PendingDurable, AbortRecords, FenceAborted, BLeftBefore, TimeoutKeepsLink,
          ClearOnResolve, RetryAbort

VARIABLES
    aState,      \* A's tombstone store for the session: "none" | "pending" | "moved" (to B) | "reclaimed" (entry gone) | "lost" (a pending entry that never reached disk, gone with a crash)
    aFile,       \* A's session file exists
    aSaved,      \* A's pending entry is on disk
    aPc,         \* what A's handOffSession or reconcile awaits: "idle" | "put" | "commit" | "abort" | "finish" (removing its copy)
    aAsk,        \* B's link came up: reconcileHandOffs is due
    link,        \* "up" | "down"
    toB,         \* requests B received or may still receive: subset of Requests
    toA,         \* answers on their way to A: subset of Answers
    bRec,        \* B's record of the id: "absent" | "staged" | "committing" | "done" | "aborted"
    bPc,         \* B's commit under its lock: "idle" | "rec" (committing saved) | "art" (temp written, artifacts moved) | "renamed" | "cleared"
    bJournal,    \* the staged journal under handoff-in/<id>
    bArt,        \* the artifacts folder beside the target
    bTarget,     \* the journal at its target path on B
    bTomb,       \* B's own tombstone at the target path
    toldAborted, \* history: B answered `aborted` for the id
    faults

aVars == <<aState, aFile, aSaved, aPc, aAsk>>
bVars == <<bRec, bPc, bJournal, bArt, bTarget, bTomb>>
vars == <<aState, aFile, aSaved, aPc, aAsk, link, toB, toA, bRec, bPc, bJournal, bArt, bTarget, bTomb, toldAborted, faults>>

Requests == {"put", "commit", "abort"}
Answers == {<<"put", "ok">>, <<"put", "err">>, <<"commit", "landed">>, <<"commit", "err">>,
            <<"abort", "moved">>, <<"abort", "aborted">>}

\* A can run a writer on the session: its file is there and no tombstone blocks it (deleted.rs `has`).
ARunnable == aFile /\ aState \in {"none", "reclaimed", "lost"}
\* B can run it: the journal is at its target and B's own tombstone does not block it.
BRunnable == bTarget /\ ~bTomb

TypeOK ==
    /\ aState \in {"none", "pending", "moved", "reclaimed", "lost"}
    /\ aFile \in BOOLEAN /\ aSaved \in BOOLEAN /\ aAsk \in BOOLEAN
    /\ aPc \in {"idle", "put", "commit", "abort", "finish"}
    /\ link \in {"up", "down"}
    /\ toB \subseteq Requests
    /\ toA \subseteq Answers
    /\ bRec \in {"absent", "staged", "committing", "done", "aborted"}
    /\ bPc \in {"idle", "rec", "art", "renamed", "cleared"}
    /\ bJournal \in BOOLEAN /\ bArt \in BOOLEAN /\ bTarget \in BOOLEAN /\ bTomb \in BOOLEAN
    /\ toldAborted \in BOOLEAN
    /\ faults \in 0..MaxFaults

Init ==
    /\ aState = "none" /\ aFile = TRUE /\ aSaved = FALSE /\ aPc = "idle" /\ aAsk = FALSE
    /\ link = "up" /\ toB = {} /\ toA = {}
    /\ bRec = "absent" /\ bPc = "idle"
    /\ bJournal = FALSE /\ bArt = FALSE /\ bTarget = FALSE /\ bTomb = BLeftBefore
    /\ toldAborted = FALSE
    /\ faults = 0

\* ---- helpers ----------------------------------------------------------------
Waiting == aPc \in {"put", "commit", "abort"}
\* B's answer reaches the wire only while the link is up.
Answer(m) == toA' = IF link = "up" THEN toA \cup {m} ELSE toA
\* B takes a request; a duplicate (one fault) leaves it to be taken again.
Consume(m) ==
    \/ /\ toB' = toB \ {m}
       /\ faults' = faults
    \/ /\ faults < MaxFaults
       /\ toB' = toB
       /\ faults' = faults + 1
\* A's request failed: settleHandOff asks B who owns the session.
AskWhoOwns == toB' = toB \cup {"abort"} /\ aPc' = "abort" /\ UNCHANGED aState
\* A link drop rejects A's request at once and settleHandOff's abort with it: the transfer stays pending.
Drop == link' = "down" /\ toA' = {} /\ aPc' = IF Waiting THEN "idle" ELSE aPc
Unwound == IF bRec = "committing" THEN "staged" ELSE bRec
PutRefused == Answer(<<"put", "err">>) /\ UNCHANGED <<bRec, bJournal>>
CommitRefused == Answer(<<"commit", "err">>) /\ UNCHANGED <<bRec, bPc, bJournal, bArt>>
CommitLanded == Answer(<<"commit", "landed">>) /\ UNCHANGED <<bRec, bPc, bJournal, bArt>>
AbortMoved(rec) == bRec' = rec /\ Answer(<<"abort", "moved">>) /\ UNCHANGED <<bJournal, bArt, toldAborted>>
\* resolve finds the target in place: B forgets its own old tombstone of the path before recording done.
ResolveClears == bTomb' = IF ClearOnResolve THEN FALSE ELSE bTomb

\* ---- A ----------------------------------------------------------------------
\* @code src/main/session-mutations.ts:301-320 the transfer recorded pending, then its parts cross
\* @code native/ompdesk/crates/core/src/sessions/deleted.rs:201-221 begin_handoff saved before anything crosses
ABegin ==
    /\ aState = "none" /\ aPc = "idle" /\ link = "up"
    /\ aState' = "pending"
    /\ aSaved' = PendingDurable
    /\ toB' = toB \cup {"put"}
    /\ aPc' = "put"
    /\ UNCHANGED <<aFile, aAsk, link, toA, bVars, toldAborted, faults>>

\* @code src/main/session-mutations.ts:308-329 a part answered: the commit next; a refused part asks B who owns it
AGotPut(r) ==
    /\ aPc = "put" /\ <<"put", r>> \in toA
    /\ toA' = toA \ {<<"put", r>>}
    /\ IF r = "ok"
       THEN toB' = toB \cup {"commit"} /\ aPc' = "commit" /\ UNCHANGED aState
       ELSE AskWhoOwns
    /\ UNCHANGED <<aFile, aSaved, aAsk, link, bVars, toldAborted, faults>>

\* @code src/main/session-mutations.ts:322-342 the commit answered: landed settles the tombstone; an error asks B who owns it
\* @code native/ompdesk/crates/core/src/sessions/deleted.rs:223-245 settle_handoff names B's path
AGotCommit(r) ==
    /\ aPc = "commit" /\ <<"commit", r>> \in toA
    /\ toA' = toA \ {<<"commit", r>>}
    /\ IF r = "err" THEN AskWhoOwns
       ELSE aState' = "moved" /\ aPc' = "finish" /\ UNCHANGED toB
    /\ UNCHANGED <<aFile, aSaved, aAsk, link, bVars, toldAborted, faults>>

\* @code src/main/session-mutations.ts:256-264 B's answer to the abort: moved settles to B; only aborted gives the session back
\* @code native/ompdesk/crates/core/src/sessions/deleted.rs:223-245 settle_handoff: `to` kept, or the entry removed
AGotAbort(r) ==
    /\ aPc = "abort" /\ <<"abort", r>> \in toA
    /\ toA' = toA \ {<<"abort", r>>}
    /\ IF r = "moved"
       THEN aState' = "moved" /\ aPc' = "finish"
       ELSE aState' = "reclaimed" /\ aPc' = "idle"
    /\ UNCHANGED <<aFile, aSaved, aAsk, link, toB, bVars, toldAborted, faults>>

\* @code src/main/session-mutations.ts:222-232 finishHandOff: stock deletes A's copy after the tombstone names B's path
AFinish ==
    /\ aPc = "finish"
    /\ aFile' = FALSE /\ aPc' = "idle"
    /\ UNCHANGED <<aState, aSaved, aAsk, link, toB, toA, bVars, toldAborted, faults>>

\* @code src/main/session-mutations.ts:364-374 reconcileHandOffs: every pending transfer not being settled now asks B again
\* @code src/main/index.ts:2052-2061 run each time B's link comes up
\* @code native/ompdesk/crates/core/src/sessions/deleted.rs:247-257 pending_handoffs
AReconcile ==
    /\ aAsk /\ link = "up"
    /\ aAsk' = FALSE
    /\ IF aState = "pending" /\ aPc = "idle"
       THEN toB' = toB \cup {"abort"} /\ aPc' = "abort"
       ELSE UNCHANGED <<toB, aPc>>
    /\ UNCHANGED <<aState, aFile, aSaved, link, toA, bVars, toldAborted, faults>>

\* @code src/main/session-mutations.ts:197-204 HANDOFF_TIMEOUT_MS: a request B is slow to answer fails while the link stays up
\* @code src/main/session-mutations.ts:239-255 a failed abort leaves the transfer pending; one that failed with the link up asks again after HANDOFF_RETRY_MS
ATimeout ==
    /\ TimeoutKeepsLink /\ faults < MaxFaults /\ Waiting
    /\ faults' = faults + 1
    /\ aAsk' = IF aPc = "abort" THEN aAsk \/ RetryAbort ELSE aAsk
    /\ IF aPc = "abort"
       THEN aPc' = "idle" /\ UNCHANGED <<aState, toB>>
       ELSE AskWhoOwns
    /\ UNCHANGED <<aFile, aSaved, link, toA, bVars, toldAborted>>

\* ---- B ----------------------------------------------------------------------
\* @code src/main/remote/host-services.ts:1521-1524 sessions.handoff.put reaches the core
\* @code native/ompdesk/crates/core/src/remote/handoff.rs:226-283 put: aborted refused, the first part records `staged`, a part after the commit answers as received
BPut ==
    /\ bPc = "idle" /\ "put" \in toB
    /\ Consume("put")
    /\ CASE bRec = "aborted" /\ FenceAborted -> PutRefused
         [] bRec \in {"committing", "done"} -> (Answer(<<"put", "ok">>) /\ UNCHANGED <<bRec, bJournal>>)
         [] OTHER -> (/\ bRec' = IF bRec = "absent" THEN "staged" ELSE bRec
                      /\ bJournal' = TRUE
                      /\ Answer(<<"put", "ok">>))
    /\ UNCHANGED <<aVars, link, bPc, bArt, bTarget, bTomb, toldAborted>>

\* @code src/main/remote/host-services.ts:1525-1539 sessions.handoff.commit reaches the core
\* @code native/ompdesk/crates/core/src/remote/handoff.rs:452-518 commit under the lock: aborted refused, done answers landed, committing resolved first, then `committing` saved
\* @code native/ompdesk/crates/core/src/remote/handoff.rs:394-424 resolve: a target in place clears B's tombstone of it and is done, else unwound to staged
BCommit ==
    /\ bPc = "idle" /\ "commit" \in toB
    /\ Consume("commit")
    /\ CASE bRec = "absent" -> CommitRefused
         [] bRec = "aborted" /\ FenceAborted -> CommitRefused
         [] bRec = "done" -> CommitLanded
         [] bRec = "committing" /\ bTarget ->
                (bRec' = "done" /\ Answer(<<"commit", "landed">>) /\ UNCHANGED <<bPc, bJournal, bArt>>)
         [] OTHER ->
                (IF bJournal /\ ~bTarget
                 THEN /\ bRec' = "committing" /\ bPc' = "rec" /\ bArt' = FALSE
                      /\ UNCHANGED <<toA, bJournal>>
                 ELSE /\ bRec' = Unwound /\ bArt' = FALSE
                      /\ Answer(<<"commit", "err">>)
                      /\ UNCHANGED <<bPc, bJournal>>)
    /\ IF bRec = "committing" /\ bTarget THEN ResolveClears ELSE UNCHANGED bTomb
    /\ UNCHANGED <<aVars, link, bTarget, toldAborted>>

\* @code native/ompdesk/crates/core/src/remote/handoff.rs:519-525 temp journal written, artifacts moved beside the target
BMove ==
    /\ bPc = "rec"
    /\ bPc' = "art" /\ bArt' = TRUE
    /\ UNCHANGED <<aVars, link, toB, toA, bRec, bJournal, bTarget, bTomb, toldAborted, faults>>

\* @code native/ompdesk/crates/core/src/remote/handoff.rs:526 the journal renamed into place last
BRename ==
    /\ bPc = "art"
    /\ bPc' = "renamed" /\ bTarget' = TRUE
    /\ UNCHANGED <<aVars, link, toB, toA, bRec, bJournal, bArt, bTomb, toldAborted, faults>>

\* @code native/ompdesk/crates/core/src/remote/handoff.rs:528-532 a landing step failed: resolved (unwound to staged), the commit answers an error
BLandFail ==
    /\ bPc \in {"rec", "art"} /\ faults < MaxFaults
    /\ faults' = faults + 1
    /\ bPc' = "idle" /\ bArt' = FALSE /\ bRec' = "staged"
    /\ Answer(<<"commit", "err">>)
    /\ UNCHANGED <<aVars, link, toB, bJournal, bTarget, bTomb, toldAborted>>

\* @code native/ompdesk/crates/core/src/remote/handoff.rs:533-534 B forgets its own tombstone at the target
\* @code native/ompdesk/crates/core/src/sessions/deleted.rs:343-348 clear
BClear ==
    /\ bPc = "renamed"
    /\ bPc' = "cleared" /\ bTomb' = FALSE
    /\ UNCHANGED <<aVars, link, toB, toA, bRec, bJournal, bArt, bTarget, toldAborted, faults>>

\* @code native/ompdesk/crates/core/src/remote/handoff.rs:535-544 `done` saved (a failed save leaves `committing`), staging removed, landed answered
BDone ==
    /\ bPc = "cleared"
    /\ bPc' = "idle"
    /\ \E saved \in BOOLEAN : bRec' = IF saved THEN "done" ELSE bRec
    /\ bJournal' = FALSE
    /\ Answer(<<"commit", "landed">>)
    /\ UNCHANGED <<aVars, link, toB, bArt, bTarget, bTomb, toldAborted, faults>>

\* @code src/main/remote/host-services.ts:1540-1541 sessions.handoff.abort reaches the core
\* @code native/ompdesk/crates/core/src/remote/handoff.rs:547-583 abort: done or a committing whose target is a file (resolve) answers moved; anything else is saved aborted before the answer
BAbort ==
    /\ bPc = "idle" /\ "abort" \in toB
    /\ Consume("abort")
    /\ CASE bRec = "done" -> AbortMoved(bRec)
         [] bRec = "committing" /\ bTarget -> AbortMoved("done")
         [] bRec = "aborted" ->
                (Answer(<<"abort", "aborted">>) /\ toldAborted' = TRUE /\ UNCHANGED <<bRec, bJournal, bArt>>)
         [] OTHER ->
                \* the staging removal is best effort (`let _ = fs::remove_dir_all`)
                (/\ bRec' = IF AbortRecords THEN "aborted" ELSE Unwound
                 /\ bArt' = FALSE
                 /\ \E removed \in BOOLEAN : bJournal' = IF removed THEN FALSE ELSE bJournal
                 /\ Answer(<<"abort", "aborted">>)
                 /\ toldAborted' = TRUE)
    /\ IF bRec = "committing" /\ bTarget THEN ResolveClears ELSE UNCHANGED bTomb
    /\ UNCHANGED <<aVars, link, bPc, bTarget>>

\* ---- environment --------------------------------------------------------------
\* @code src/main/session-mutations.ts:328-339 a request on a dropped link fails, settleHandOff's abort too (remote_offline: no retry): pending
LinkDrop ==
    /\ link = "up" /\ faults < MaxFaults
    /\ faults' = faults + 1
    /\ Drop
    /\ \E kept \in SUBSET toB : toB' = kept
    /\ UNCHANGED <<aState, aFile, aSaved, aAsk, bVars, toldAborted>>

\* @code src/main/index.ts:2052-2061 B's link comes up: reconcileHandOffs is due
LinkUp ==
    /\ link = "down"
    /\ link' = "up" /\ aAsk' = TRUE
    /\ UNCHANGED <<aState, aFile, aSaved, aPc, toB, toA, bVars, toldAborted, faults>>

\* @code native/ompdesk/crates/core/src/sessions/deleted.rs:112-157 A restarts: the store is read back from disk; the running hand-over is gone
ACrash ==
    /\ faults < MaxFaults
    /\ faults' = faults + 1
    /\ link' = "down" /\ toA' = {} /\ aPc' = "idle" /\ aAsk' = FALSE
    /\ \E kept \in SUBSET toB : toB' = kept
    /\ aState' = IF aState = "pending" /\ ~aSaved THEN "lost" ELSE aState
    /\ UNCHANGED <<aFile, aSaved, bVars, toldAborted>>

\* @code native/ompdesk/crates/core/src/remote/handoff.rs:73-88 B restarts: the record is read back; a commit stops between its steps
BCrash ==
    /\ faults < MaxFaults
    /\ faults' = faults + 1
    /\ Drop
    /\ toB' = {}
    /\ bPc' = "idle"
    /\ UNCHANGED <<aState, aFile, aSaved, aAsk, bRec, bJournal, bArt, bTarget, bTomb, toldAborted>>

Step ==
    \/ ABegin \/ AFinish \/ AReconcile \/ ATimeout
    \/ \E r \in {"ok", "err"} : AGotPut(r)
    \/ \E r \in {"landed", "err"} : AGotCommit(r)
    \/ \E r \in {"moved", "aborted"} : AGotAbort(r)
    \/ BPut \/ BCommit \/ BMove \/ BRename \/ BLandFail \/ BClear \/ BDone \/ BAbort
    \/ LinkDrop \/ LinkUp \/ ACrash \/ BCrash

Next == Step \/ UNCHANGED vars

\* The link is fair and both computers keep running: every handler and the reconcile on link up eventually runs.
Fairness ==
    /\ WF_vars(LinkUp) /\ WF_vars(AReconcile) /\ WF_vars(AFinish)
    /\ \A r \in {"ok", "err"} : WF_vars(AGotPut(r))
    /\ \A r \in {"landed", "err"} : WF_vars(AGotCommit(r))
    /\ \A r \in {"moved", "aborted"} : WF_vars(AGotAbort(r))
    /\ WF_vars(BPut) /\ WF_vars(BCommit) /\ WF_vars(BAbort)
    /\ WF_vars(BMove) /\ WF_vars(BRename) /\ WF_vars(BClear) /\ WF_vars(BDone)

SafetySpec == Init /\ [][Next]_vars
Spec == SafetySpec /\ Fairness

----------------------------------------------------------------------------
\* ==== FROZEN PROPERTIES (Properties.md) ====
\* P1 At no time can both computers run the session.
AtMostOneRunnable == ~(ARunnable /\ BRunnable)
\* P2 No commit of the id lands after B answered it aborted.
NoCommitAfterAbort == toldAborted => ~bTarget
\* P3 Once the link stays up and both computers stay up, exactly one of them can run the session, for good.
ExactlyOneRunnable == <>[](ARunnable # BRunnable)
\* ==== END FROZEN PROPERTIES ====

\* Sanity (must FAIL): both ends of a transfer are reachable.
NeverMoved == aState # "moved"
NeverReclaimed == aState # "reclaimed"
=============================================================================
