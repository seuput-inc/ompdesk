------------------------------ MODULE UrgentAsides ------------------------------
(* Code: resources/gui-bridge/agent-control.ts watchAsides / interruptFor and   *)
(* the hooks install puts on message_end and agent_end. OMPdesk's peek in front *)
(* of stock's Agent.hasIrcInterrupts answers yes while an urgent aside of ours  *)
(* (another session's message, a report that asks for a turn) is armed and      *)
(* stock's aside queue holds anything; yes makes a running shell background.    *)
(* Design = "handover": a mark goes when stock hands that message to the model  *)
(* (its message_end) or the turn ends. Design = "observe": the build before the *)
(* fix, where a mark went only when a later peek found the queue empty.         *)
EXTENDS FiniteSets

CONSTANTS Urgent, Quiet, Design
Msgs == Urgent \cup Quiet

VARIABLES
    turn,      \* "idle" or "running": the agent loop owns a turn
    batch,     \* a tool batch runs: stock's 250 ms peek is live
    queue,     \* stock's aside queue (IrcBridge #asides)
    handing,   \* drained at a step boundary, message_end not emitted yet
    sentEver,  \* messages handed to stock's queue
    armed,     \* urgent messages whose mark went up once
    handed,    \* messages the model got
    marks,     \* OMPdesk's urgent marks (urgentAsides)
    seen,      \* Design "observe": a peek found the queue holding the marked aside
    bad        \* a peek said yes while no urgent message of ours was pending
vars == <<turn, batch, queue, handing, sentEver, armed, handed, marks, seen, bad>>

\* An urgent message that is armed and not yet handed to the model.
Pending == marks \ handed

TypeOK ==
    /\ turn \in {"idle", "running"}
    /\ batch \in BOOLEAN
    /\ queue \subseteq Msgs /\ handing \subseteq Msgs /\ sentEver \subseteq Msgs /\ armed \subseteq Urgent /\ handed \subseteq Msgs
    /\ marks \subseteq Urgent
    /\ seen \in BOOLEAN /\ bad \in BOOLEAN

Init ==
    /\ turn = "running" /\ batch = FALSE /\ queue = {} /\ handing = {}
    /\ sentEver = {} /\ armed = {} /\ handed = {} /\ marks = {} /\ seen = FALSE /\ bad = FALSE

\* What the peek answers (agent-control.ts watchAsides `peek`; stock's own IRC check is FALSE here).
Answer == marks # {} /\ queue # {}

\* @code resources/gui-bridge/agent-control.ts:173-177 interruptFor, called at :357 (a report, before sendMessage's own awaits queue it) and :387-388 (a session's message, once stock queued it)
Arm(m) ==
    /\ turn = "running" /\ m \in Urgent /\ m \notin sentEver /\ m \notin armed
    /\ marks' = marks \cup {m} /\ armed' = armed \cup {m}
    /\ seen' = FALSE
    /\ UNCHANGED <<turn, batch, queue, handing, sentEver, handed, bad>>

\* @code resources/gui-bridge/agent-control.ts:358 stock queues the aside (IrcBridge.queueAside); an urgent one after its mark (the aside's mark follows at once, nothing between)
Enqueue(m) ==
    /\ turn = "running" /\ m \notin sentEver
    /\ m \in Urgent => m \in armed
    /\ queue' = queue \cup {m} /\ sentEver' = sentEver \cup {m}
    /\ UNCHANGED <<turn, batch, handing, armed, handed, marks, seen, bad>>

\* @code resources/gui-bridge/agent-control.ts:160-161 the peek stock's tool batch runs every 250 ms
Peek ==
    /\ batch
    /\ bad' = (bad \/ (Answer /\ Pending = {}))
    /\ IF Design = "observe" /\ marks # {}
          THEN IF queue # {} THEN seen' = TRUE /\ UNCHANGED marks
               ELSE IF seen THEN marks' = {} /\ seen' = FALSE
               ELSE UNCHANGED <<marks, seen>>
          ELSE UNCHANGED <<marks, seen>>
    /\ UNCHANGED <<turn, batch, queue, handing, sentEver, armed, handed>>

\* Environment (stock agent-loop): a model reply ends in tool calls.
BatchStart ==
    /\ turn = "running" /\ ~batch /\ handing = {}
    /\ batch' = TRUE
    /\ UNCHANGED <<turn, queue, handing, sentEver, armed, handed, marks, seen, bad>>

BatchEnd ==
    /\ batch /\ batch' = FALSE
    /\ UNCHANGED <<turn, queue, handing, sentEver, armed, handed, marks, seen, bad>>

\* Environment (stock setAsideMessageProvider): the step boundary drains the whole aside queue.
Drain ==
    /\ turn = "running" /\ ~batch /\ queue # {}
    /\ handing' = handing \cup queue /\ queue' = {}
    /\ UNCHANGED <<turn, batch, sentEver, armed, handed, marks, seen, bad>>

\* @code resources/gui-bridge/agent-control.ts:212-215 message_end of a drained message: stock hands it to the model; its mark goes
HandOver(m) ==
    /\ m \in handing
    /\ handing' = handing \ {m} /\ handed' = handed \cup {m}
    /\ marks' = IF Design = "handover" THEN marks \ {m} ELSE marks
    /\ UNCHANGED <<turn, batch, queue, sentEver, armed, seen, bad>>

\* @code resources/gui-bridge/agent-control.ts:218 agent_end: every mark goes
TurnEnd ==
    /\ turn = "running" /\ ~batch /\ handing = {}
    /\ turn' = "idle"
    /\ marks' = IF Design = "handover" THEN {} ELSE marks
    /\ UNCHANGED <<batch, queue, handing, sentEver, armed, handed, seen, bad>>

\* Environment: a prompt or a stranded aside starts the next turn; its first boundary drains before any batch.
TurnStart ==
    /\ turn = "idle"
    /\ turn' = "running"
    /\ UNCHANGED <<batch, queue, handing, sentEver, armed, handed, marks, seen, bad>>

Next ==
    \/ \E m \in Msgs : Arm(m) \/ Enqueue(m) \/ HandOver(m)
    \/ Peek \/ BatchStart \/ BatchEnd \/ Drain \/ TurnEnd \/ TurnStart
    \/ (handed = Msgs /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars

\* ===== Frozen properties (Properties.md) =====
\* P1: a progress report or a note never makes the peek say yes on its own.
QuietNeverInterrupts == ~bad
\* P2: while a tool batch runs and an armed urgent message waits in the queue, the peek says yes.
UrgentInterrupts == (batch /\ queue \cap marks # {}) => Answer
\* ===== end frozen =====

\* Sanity (must FAIL): a peek can say yes at all, so P1 is not vacuous.
NeverAnswers == ~(batch /\ Answer)
=============================================================================
