--------------------------- MODULE WebCloseReports ---------------------------
(*
 * A paired web page's Files-edit reports and an agent's close of one of its tabs.
 *
 * Pages share ONE window (a device's up to four connections). Each page has a Files editor that holds unsaved edits
 * in at most one tab (`edit`), and a current connection; a reconnect is a fresh connection id. The page sends its
 * dirty tab on every change and right after its connection opens (`FileEditReporter`). The core's web router keeps
 * the latest report per connection (`file_edits.rs`, under the lock that ends connections), forgets a connection when
 * it ends, and an agent's close reads that store (`tab_close_step`): it keeps a tab some report names, releases any
 * other; the pool's removal checks the store again under the router's lock (`release_entry`'s `unless_dirty`).
 *
 * Frames from page to the router are FIFO per connection; frames of a connection that ended are refused.
 *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Pages, Tabs, MaxConn, MaxEdits, MaxQ

None == "none"
Absent == "absent"
ConnIds == Pages \X (1 .. MaxConn)
Dirty == Tabs \cup {None}

\* Mutation switch: the report's handler runs in a later step than the frame's receive (an `await` in between).
SplitDispatch == FALSE
\* Mutation switch: the release's last check and the pool's removal are separate steps (main reads the store, then
\* asks the pool to release), so a report can land between them.
SplitRelease == FALSE

\* @code native/ompdesk/crates/core/src/web/file_edits.rs:52-56 report: one connection's entry
Write(s, c, v) == [s EXCEPT ![c] = v]
\* @code native/ompdesk/crates/core/src/web/file_edits.rs:59-61 forget: one connection's entry
Forget(s, c) == [s EXCEPT ![c] = Absent]

VARIABLES
    edit,      \* page -> the tab its Files editor holds unsaved edits in, or None
    conn,      \* page -> index of its current connection (0: never connected)
    live,      \* connections the router serves (attached, not ended)
    greeted,   \* connections whose page saw "open" (and sent its open report)
    q,         \* connection -> report frames in flight, page to the router
    handoff,   \* connection -> frames received but not yet handled (only under SplitDispatch)
    store,     \* connection -> its latest report in the router, or Absent
    deciding,  \* tabs a close decided to release, release not done yet
    passed,    \* tabs whose last check passed, removal not done yet (only under SplitRelease)
    released,  \* tabs released
    edits,     \* edit counter (bound)
    bad,       \* ghost: a close decided to release a tab a settled live page holds dirty
    late,      \* ghost: a release went ahead while the store already named the tab dirty
    refused    \* ghost: a close kept a tab for its unsaved edits

vars == <<edit, conn, live, greeted, q, handoff, store, deciding, passed, released, edits, bad, late, refused>>

Current(p) == <<p, conn[p]>>

TypeOK ==
    /\ edit \in [Pages -> Dirty]
    /\ conn \in [Pages -> 0 .. MaxConn]
    /\ live \subseteq ConnIds
    /\ greeted \subseteq ConnIds
    /\ q \in [ConnIds -> Seq(Dirty)]
    /\ handoff \in [ConnIds -> Seq(Dirty)]
    /\ store \in [ConnIds -> Dirty \cup {Absent}]
    /\ deciding \subseteq Tabs
    /\ passed \subseteq Tabs
    /\ released \subseteq Tabs

Init ==
    /\ edit = [p \in Pages |-> None]
    /\ conn = [p \in Pages |-> 0]
    /\ live = {}
    /\ greeted = {}
    /\ q = [c \in ConnIds |-> <<>>]
    /\ handoff = [c \in ConnIds |-> <<>>]
    /\ store = [c \in ConnIds |-> Absent]
    /\ deciding = {}
    /\ passed = {}
    /\ released = {}
    /\ edits = 0
    /\ bad = FALSE
    /\ late = FALSE
    /\ refused = FALSE

\* What the router's store says about a tab of the window.
\* @code native/ompdesk/crates/core/src/web/file_edits.rs:63-76 edits
Edits(t) ==
    LET reported == {c \in ConnIds : store[c] # Absent}
    IN IF \E c \in reported : store[c] = t THEN "dirty"
       ELSE IF reported # {} THEN "clean"
       ELSE "unreported"

\* @code native/ompdesk/crates/core/src/agentctl/rules/tab_close.rs:57-67 tab_close_step (looked/userTouched, and the in-use check, are outside this model)
CloseStep(t) == IF Edits(t) = "dirty" THEN "keep" ELSE "release"

\* A page whose current connection is live, greeted and has nothing in flight: main has its word.
Settled(p) ==
    /\ conn[p] # 0
    /\ Current(p) \in live
    /\ Current(p) \in greeted
    /\ q[Current(p)] = <<>>
    /\ handoff[Current(p)] = <<>>

KnownDirty(t) == \E p \in Pages : Settled(p) /\ edit[p] = t

\* @code src/renderer/web/FileEditReporter.tsx:20-25 the editor's dirty tab changes; the effect sends it while open
Edit(p, v) ==
    /\ edits < MaxEdits
    /\ v # edit[p]
    /\ v \notin released
    /\ IF conn[p] # 0 /\ Current(p) \in greeted THEN Len(q[Current(p)]) < MaxQ ELSE TRUE
    /\ edit' = [edit EXCEPT ![p] = v]
    /\ edits' = edits + 1
    /\ q' = IF conn[p] # 0 /\ Current(p) \in greeted
               THEN [q EXCEPT ![Current(p)] = Append(@, v)]
               ELSE q
    /\ UNCHANGED <<conn, live, greeted, handoff, store, deciding, passed, released, bad, late, refused>>

\* A fresh socket: the router serves a new connection (a new random id) for the page.
\* @code native/ompdesk/crates/core/src/web/router.rs:787-828 attach_conn
Connect(p) ==
    /\ conn[p] < MaxConn
    /\ conn[p] = 0 \/ Current(p) \notin live
    /\ conn' = [conn EXCEPT ![p] = @ + 1]
    /\ live' = live \cup {<<p, conn[p] + 1>>}
    /\ UNCHANGED <<edit, greeted, q, handoff, store, deciding, passed, released, edits, bad, late, refused>>

\* The page hears its hello ("open") and sends its editor's dirty tab.
\* @code src/renderer/web/FileEditReporter.tsx:26-28 onConnectionState("open") -> send
Greet(p) ==
    /\ conn[p] # 0
    /\ Current(p) \in live
    /\ Current(p) \notin greeted
    /\ greeted' = greeted \cup {Current(p)}
    /\ q' = [q EXCEPT ![Current(p)] = Append(@, edit[p])]
    /\ UNCHANGED <<edit, conn, live, handoff, store, deciding, passed, released, edits, bad, late, refused>>

\* The socket ends (closed, timed out, retired, revoked): the router's finish ends it and forgets its report, under one lock.
\* @code native/ompdesk/crates/core/src/web/router.rs:892-931 finish: the connection leaves, its report is forgotten
Drop(c) ==
    /\ c \in live
    /\ live' = live \ {c}
    /\ store' = Forget(store, c)
    /\ UNCHANGED <<edit, conn, greeted, q, handoff, deciding, passed, released, edits, bad, late, refused>>

\* A report frame reaches the router: an ended connection refuses it; a live one records it in the same run.
\* @code native/ompdesk/crates/core/src/web/router.rs:1118-1127 receive refuses an ended connection
\* @code native/ompdesk/crates/core/src/web/router.rs:1249-1333 dispatch authorizes, then answers FILE_EDIT_REPORT itself
\* @code native/ompdesk/crates/core/src/web/router.rs:1339-1358 file_edit_report: parse, record, answer
Deliver(c) ==
    /\ q[c] # <<>>
    /\ q' = [q EXCEPT ![c] = Tail(@)]
    /\ IF ~SplitDispatch
          THEN /\ store' = IF c \in live THEN Write(store, c, Head(q[c])) ELSE store
               /\ UNCHANGED handoff
          ELSE /\ handoff' = IF c \in live THEN [handoff EXCEPT ![c] = Append(@, Head(q[c]))] ELSE handoff
               /\ UNCHANGED store
    /\ UNCHANGED <<edit, conn, live, greeted, deciding, passed, released, edits, bad, late, refused>>

\* Only under SplitDispatch: the handler runs later, after whatever else happened meanwhile.
Handle(c) ==
    /\ SplitDispatch
    /\ handoff[c] # <<>>
    /\ store' = Write(store, c, Head(handoff[c]))
    /\ handoff' = [handoff EXCEPT ![c] = Tail(@)]
    /\ UNCHANGED <<edit, conn, live, greeted, q, deciding, passed, released, edits, bad, late, refused>>

\* An agent's close reads the tab (its `webEdits` from the store) and decides.
\* @code native/ompdesk/crates/core/src/agentctl/service/sessions/stop.rs:211-245 close_tab: snapshot, tab_close_step, keep or start the release
CloseDecide(t) ==
    /\ t \notin released \cup deciding
    /\ IF CloseStep(t) = "release"
          THEN /\ deciding' = deciding \cup {t}
               /\ bad' = (bad \/ KnownDirty(t))
               /\ UNCHANGED refused
          ELSE /\ refused' = TRUE
               /\ UNCHANGED <<deciding, bad>>
    /\ UNCHANGED <<edit, conn, live, greeted, q, handoff, store, passed, released, edits, late>>

\* The release lands after awaits (exit policy and, on a paired owner, the host's close reply); reports may arrive
\* meanwhile. The pool's removal asks the store again under the router's lock, in the step that removes the tab.
\* @code src/main/tab-release.ts:30-64 refreshExitPolicy, the page's word before closeHostTurn, releaseTab with the guard
\* @code src/main/agent-control/host.ts:1240-1247 release: the guard names the page's router and device
\* @code native/ompdesk/crates/core/src/pool/windows.rs:421-453 release_entry: removal inside unless_dirty
\* @code native/ompdesk/crates/core/src/web/router.rs:652-671 unless_dirty: check and removal under the router's lock
CloseRelease(t) ==
    /\ t \in deciding
    /\ deciding' = deciding \ {t}
    /\ IF CloseStep(t) = "release"
          THEN IF SplitRelease
                  THEN /\ passed' = passed \cup {t}
                       /\ UNCHANGED <<released, late, refused>>
                  ELSE /\ released' = released \cup {t}
                       /\ late' = (late \/ Edits(t) = "dirty")
                       /\ UNCHANGED <<refused, passed>>
          ELSE /\ refused' = TRUE
               /\ UNCHANGED <<released, late, passed>>
    /\ UNCHANGED <<edit, conn, live, greeted, q, handoff, store, edits, bad>>

\* Only under SplitRelease: the removal runs later, on whatever the store says by then, without asking it.
CloseRemove(t) ==
    /\ SplitRelease
    /\ t \in passed
    /\ passed' = passed \ {t}
    /\ released' = released \cup {t}
    /\ late' = (late \/ Edits(t) = "dirty")
    /\ UNCHANGED <<edit, conn, live, greeted, q, handoff, store, deciding, edits, bad, refused>>

Next ==
    \/ \E p \in Pages, v \in Dirty : Edit(p, v)
    \/ \E p \in Pages : Connect(p) \/ Greet(p)
    \/ \E c \in ConnIds : Drop(c) \/ Deliver(c) \/ Handle(c)
    \/ \E t \in Tabs : CloseDecide(t) \/ CloseRelease(t) \/ CloseRemove(t)

Spec == Init /\ [][Next]_vars

\* ======================== Properties (frozen; see ../Properties.md) ========================

\* P1: only a live connection holds a report: an ended one never counts again.
StoreOnlyLive == \A c \in ConnIds : store[c] # Absent => c \in live

\* P2: a settled live page's report is its editor's state (no other connection's report or drop changed it).
QuiescentAgreement == \A p \in Pages : Settled(p) => store[Current(p)] = edit[p]

\* P3: a close never decides to release a tab a settled live page holds unsaved edits in.
NoReleaseOfKnownDirty == ~bad

\* P4: a release never lets a tab go while the store names it dirty (a report that landed during its awaits).
NoLateDirtyRelease == ~late

\* ========================= Sanity (each must be violated) =========================

NeverReleases == released = {}
NeverRefuses == ~refused
=============================================================================
