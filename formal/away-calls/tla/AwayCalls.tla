------------------------------ MODULE AwayCalls ------------------------------
(* Who carries out a control-tool call of a device's tab while that device    *)
(* is away. A (the device) opened session S on B (the host): S's omp runs on  *)
(* B inside LocalHostServices and every host tool call it makes goes to A     *)
(* (`HostTab.hostCalls`). A sleeps; B notices the dead link only later. The   *)
(* fix lets B carry out, once A has been away a while, the calls no           *)
(* connection was ever handed (`delivered` false), and keep S's reports in a  *)
(* durable outbox B replays to A when A is back. A runs what reaches it at    *)
(* most once (its call journal); the hub's bridge drops a report whose id it  *)
(* already holds.                                                              *)
(*                                                                             *)
(* Constants pick the design: UseTakeover (B carries out calls), TakeDelivered *)
(* (B also takes calls a connection was handed: the double-run bug),          *)
(* ResendDelivered (a re-attach on the same tab re-sends handed calls too),   *)
(* DurableOutbox (the kept reports survive B's restart), StableIds (a replay  *)
(* keeps the report's id), AReturns (A ever comes back).                       *)
EXTENDS Naturals, FiniteSets

CONSTANTS Calls, Reports, MaxSleeps, MaxCrashes,
          UseTakeover, TakeDelivered, ResendDelivered, DurableOutbox, StableIds, AReturns

ASSUME Reports \subseteq Calls

VARIABLES
    link,       \* "up": B's connection to A works; "dead": B still holds it, A is gone; "down": B dropped it
    pending,    \* per call: "new" | "waiting" (in hostCalls) | "answered" | "withdrawn" (omp ended)
    delivered,  \* per call: a connection was handed it
    inflight,   \* messages B sent A that A may still read: <<"call", c>> or <<"replay", r>>
    replies,    \* A's answers on their way to B: the same shapes
    aJournal,   \* control calls A's call journal holds (it never runs one twice)
    runs,       \* per non-report call: how many times its effect happened (A's and B's together)
    kept,       \* reports in B's outbox for A
    toldKept,   \* reports S was told are kept for A (history)
    hub,        \* per report: copies in the hub's transcript
    sleeps, crashes

vars == <<link, pending, delivered, inflight, replies, aJournal, runs, kept, toldKept, hub, sleeps, crashes>>

Msgs == ({"call"} \X Calls) \cup ({"replay"} \X Reports)

TypeOK ==
    /\ link \in {"up", "dead", "down"}
    /\ pending \in [Calls -> {"new", "waiting", "answered", "withdrawn"}]
    /\ delivered \in [Calls -> BOOLEAN]
    /\ inflight \subseteq Msgs
    /\ replies \subseteq Msgs
    /\ aJournal \subseteq Calls \ Reports
    /\ runs \in [Calls \ Reports -> 0..2]
    /\ kept \subseteq Reports
    /\ toldKept \subseteq Reports
    /\ hub \in [Reports -> 0..(2 + MaxSleeps + MaxCrashes)]
    /\ sleeps \in 0..MaxSleeps
    /\ crashes \in 0..MaxCrashes

Init ==
    /\ link = "up"
    /\ pending = [c \in Calls |-> "new"]
    /\ delivered = [c \in Calls |-> FALSE]
    /\ inflight = {} /\ replies = {}
    /\ aJournal = {}
    /\ runs = [c \in Calls \ Reports |-> 0]
    /\ kept = {} /\ toldKept = {}
    /\ hub = [r \in Reports |-> 0]
    /\ sleeps = 0 /\ crashes = 0

\* The hub's bridge holds a report once per id (`hasMailEntry`); a replay with a new id is a new message.
Deliver(r) == hub' = [hub EXCEPT ![r] = IF StableIds /\ @ >= 1 THEN @ ELSE @ + 1]

\* @code src/main/remote/host-services.ts:2536-2541 omp's host_tool_call enters hostCalls, marked delivered if a connection is held
Call(c) ==
    /\ pending[c] = "new"
    /\ pending' = [pending EXCEPT ![c] = "waiting"]
    /\ delivered' = [delivered EXCEPT ![c] = link # "down"]
    /\ inflight' = IF link # "down" THEN inflight \cup {<<"call", c>>} ELSE inflight
    /\ UNCHANGED <<link, replies, aJournal, runs, kept, toldKept, hub, sleeps, crashes>>

\* Environment: A sleeps or loses the network; B still holds the connection.
Sleep ==
    /\ link = "up" /\ sleeps < MaxSleeps
    /\ link' = "dead" /\ sleeps' = sleeps + 1
    /\ UNCHANGED <<pending, delivered, inflight, replies, aJournal, runs, kept, toldKept, hub, crashes>>

\* Environment: A is back before B noticed; the same connection carries on.
Wake ==
    /\ link = "dead" /\ AReturns
    /\ link' = "up"
    /\ UNCHANGED <<pending, delivered, inflight, replies, aJournal, runs, kept, toldKept, hub, sleeps, crashes>>

\* @code src/main/remote/host-services.ts:1880-1883 B notices: the tab's connection is gone
Detect ==
    /\ link = "dead"
    /\ link' = "down"
    /\ UNCHANGED <<pending, delivered, inflight, replies, aJournal, runs, kept, toldKept, hub, sleeps, crashes>>

\* @code src/main/remote/host-services.ts:2099-2108 A's tab.open re-attaches: waiting calls go again (resent when handed before), then the kept reports
Reattach ==
    /\ link = "down" /\ AReturns
    /\ LET again == {c \in Calls : pending[c] = "waiting" /\ (~delivered[c] \/ ResendDelivered)}
       IN /\ inflight' = inflight \cup ({"call"} \X again) \cup ({"replay"} \X kept)
          /\ delivered' = [c \in Calls |-> delivered[c] \/ c \in again]
    /\ link' = "up"
    /\ UNCHANGED <<pending, replies, aJournal, runs, kept, toldKept, hub, sleeps, crashes>>

\* Environment: a message on a connection that broke never arrives (a dead link that comes back retransmits).
Lose(m) ==
    /\ link = "down" /\ m \in inflight
    /\ inflight' = inflight \ {m}
    /\ UNCHANGED <<link, pending, delivered, replies, aJournal, runs, kept, toldKept, hub, sleeps, crashes>>

LoseReply(m) ==
    /\ link = "down" /\ m \in replies
    /\ replies' = replies \ {m}
    /\ UNCHANGED <<link, pending, delivered, inflight, aJournal, runs, kept, toldKept, hub, sleeps, crashes>>

\* @code src/main/ipc.ts:652-671 A runs the call: a control call through its journal (a re-sent one it ran answers the record), a report reaches the hub
ARun(m) ==
    /\ m \in inflight
    /\ inflight' = inflight \ {m}
    /\ replies' = replies \cup {m}
    /\ IF m[2] \in Reports
       THEN /\ Deliver(m[2]) /\ UNCHANGED <<aJournal, runs>>
       ELSE /\ aJournal' = aJournal \cup {m[2]}
            /\ runs' = IF m[2] \in aJournal THEN runs ELSE [runs EXCEPT ![m[2]] = @ + 1]
            /\ UNCHANGED hub
    /\ UNCHANGED <<link, pending, delivered, kept, toldKept, sleeps, crashes>>

\* @code src/main/remote/host-services.ts:1209-1230 A's host_tool_result: the omp gets its answer; a replay's answer commits a scoped settlement
BReply(m) ==
    /\ link = "up" /\ m \in replies
    /\ replies' = replies \ {m}
    /\ IF m[1] = "call"
       THEN /\ pending' = [pending EXCEPT ![m[2]] = IF @ = "waiting" THEN "answered" ELSE @]
            /\ UNCHANGED kept
       ELSE /\ kept' = kept \ {m[2]}
            /\ UNCHANGED pending
    /\ UNCHANGED <<link, delivered, inflight, aJournal, runs, toldKept, hub, sleeps, crashes>>

\* @code src/main/remote/host-services.ts:1941-1950 A away past the notice: B takes only a call no connection was handed
\* @code native/ompdesk/crates/core/src/remote/kept_calls.rs:91-119 a successful keep commits the outbox before B tells the session
TakeOver(c) ==
    /\ UseTakeover /\ link = "down" /\ pending[c] = "waiting"
    /\ TakeDelivered \/ ~delivered[c]
    /\ pending' = [pending EXCEPT ![c] = "answered"]
    /\ IF c \in Reports
       THEN /\ kept' = kept \cup {c} /\ toldKept' = toldKept \cup {c}
            /\ UNCHANGED runs
       ELSE /\ runs' = [runs EXCEPT ![c] = @ + 1]
            /\ UNCHANGED <<kept, toldKept>>
    /\ UNCHANGED <<link, delivered, inflight, replies, aJournal, hub, sleeps, crashes>>

\* Environment: B quits or crashes. The omp and its waiting calls end with it; the outbox file stays (when durable).
BCrash ==
    /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ link' = "down"
    /\ pending' = [c \in Calls |-> IF pending[c] = "waiting" THEN "withdrawn" ELSE pending[c]]
    /\ kept' = IF DurableOutbox THEN kept ELSE {}
    /\ replies' = {}
    /\ UNCHANGED <<delivered, inflight, aJournal, runs, toldKept, hub, sleeps>>

Step ==
    \/ Sleep \/ Wake \/ Detect \/ Reattach \/ BCrash
    \/ \E c \in Calls : Call(c) \/ TakeOver(c)
    \/ \E m \in Msgs : Lose(m) \/ LoseReply(m) \/ ARun(m) \/ BReply(m)

Next == Step \/ (UNCHANGED vars)

Fairness ==
    /\ WF_vars(Detect) /\ WF_vars(Reattach)
    /\ \A c \in Calls : WF_vars(TakeOver(c))
    /\ \A m \in Msgs : WF_vars(ARun(m)) /\ WF_vars(BReply(m))

Spec == Init /\ [][Next]_vars /\ Fairness

----------------------------------------------------------------------------
\* ==== FROZEN PROPERTIES (Properties.md) ====
\* P1 A control call's effect happens at most once, on A or on B.
AtMostOnce == \A c \in Calls \ Reports : runs[c] <= 1
\* P2 The hub holds each report of S at most once.
HubOnce == \A r \in Reports : hub[r] <= 1
\* P3 A report S was told is kept stays in B's outbox until the hub holds it.
KeptUntilDelivered == \A r \in toldKept : r \in kept \/ hub[r] >= 1
\* P4 Once A is back for good, every call S waits on is answered.
CallsSettle == \A c \in Calls : (pending[c] = "waiting") ~> (pending[c] # "waiting")
\* P5 Once A is back for good, every report kept for it reaches the hub.
KeptDelivered == \A r \in Reports : (r \in toldKept) ~> (hub[r] >= 1)
\* P6 A call no connection was handed is answered while A stays away.
AwayCallsSettle == \A c \in Calls : (pending[c] = "waiting" /\ ~delivered[c]) ~> (pending[c] # "waiting")
\* ==== END FROZEN PROPERTIES ====

\* Sanity (must FAIL): B carried out a call, and a kept report reached the hub after A came back.
NoTakeover == \A c \in Calls \ Reports : runs[c] = 0 \/ c \in aJournal
NoReplayDelivered == \A r \in toldKept : hub[r] = 0
=============================================================================
