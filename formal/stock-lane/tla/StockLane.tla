------------------------------ MODULE StockLane ------------------------------
(*
 * One lane of the stock helper's host in the core (native/ompdesk/crates/core/src/stock/mod.rs): the requests of one
 * kind of worker, the worker the lane talks to, and the reasons the lane ends it.
 *
 * The lane is one task that takes one message at a time, so each lane action below is one message handled whole.
 * What reaches it late is modelled as a set it is taken from at any later moment: main's answer to a start it was
 * asked for (`answers`), a caller's timeout (`gaveups`), a worker's answer line (`lines`) and exit (`exits`), the
 * grace timer of a timed-out request (`graces`) and the idle timer (`idles`). A worker answers what it was sent, or
 * never does (a hang), and exits at any moment. `probes` holds create IDs until their blocking tasks answer.
 *)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS Reqs, MaxWorkers, MaxLaunches, Kind
ASSUME Kind = "terminals" => Reqs = 1 .. Cardinality(Reqs)

None == 0
Workers == 1 .. MaxWorkers

VARIABLES
    caller,      \* r -> "new" | "waiting" | "answered" | "failed" | "timedout": what the request's caller was told
    pending,     \* requests the lane still owes an answer
    sent,        \* r -> the worker it was written to, or None
    waiting,     \* unsent live requests, in the order the lane received them
    probes,      \* terminal.create tasks whose ShellReady message has not been handled, including dropped requests
    writes,      \* ghost: terminal request IDs in stdin send order; terminal IDs name arrival ranks
    launching,   \* the start main was asked for and has not answered, or None
    launches,    \* starts asked for so far (their numbers never repeat)
    answers,     \* starts main has yet to answer
    running,     \* the lane's worker, or None
    made,        \* workers started so far
    life,        \* g -> "none" | "up" | "closing" (its stdin closed) | "killed" | "dead"
    unanswered,  \* requests the lane's worker was sent and has not answered
    overdue,     \* timed-out requests the lane's worker has not answered
    graces,      \* <<g, r>>: the grace timer of r, armed while g was the lane's worker
    idles,       \* g: an idle timer armed while g was the lane's worker
    lines,       \* <<g, r>>: an answer g wrote that the lane has not read
    wrote,       \* <<g, r>>: g answered r
    gaveups,     \* requests whose caller timed out, not yet told to the lane
    exits,       \* workers that exited, not yet told to the lane
    changed,     \* omp was reinstalled since the lane's worker started
    endedBy,     \* ghost: g -> "none" | "retire" | "idle" | "recycle" | "stop": why the lane ended it
    read,        \* ghost: <<g, r>>: the lane read g's answer to r while g was its worker
    cut,         \* ghost: a worker was let go, for a changed omp or for idleness, with a request in flight on it
    recycledFor, \* ghost: <<g, r>>: g was ended as hung when the grace of r passed
    staleStart,  \* ghost: a worker started from an answer to a start asked before a stop
    stopAt       \* ghost: the starts asked for before the last stop

vars == <<caller, pending, sent, waiting, probes, writes, launching, launches, answers, running, made, life, unanswered, overdue,
          graces, idles, lines, wrote, gaveups, exits, changed, endedBy, read, cut, recycledFor, staleStart, stopAt>>

TypeOK ==
    /\ caller \in [Reqs -> {"new", "waiting", "answered", "failed", "timedout"}]
    /\ pending \subseteq Reqs
    /\ sent \in [Reqs -> Workers \cup {None}]
    /\ waiting \in Seq(Reqs)
    /\ probes \subseteq Reqs
    /\ writes \in Seq(Reqs)
    /\ launching \in 0 .. MaxLaunches
    /\ launches \in 0 .. MaxLaunches
    /\ answers \subseteq 1 .. MaxLaunches
    /\ running \in Workers \cup {None}
    /\ made \in 0 .. MaxWorkers
    /\ life \in [Workers -> {"none", "up", "closing", "killed", "dead"}]
    /\ unanswered \subseteq Reqs
    /\ overdue \subseteq Reqs
    /\ graces \subseteq Workers \X Reqs
    /\ idles \subseteq Workers
    /\ lines \subseteq Workers \X Reqs
    /\ wrote \subseteq Workers \X Reqs
    /\ gaveups \subseteq Reqs
    /\ exits \subseteq Workers
    /\ changed \in BOOLEAN
    /\ endedBy \in [Workers -> {"none", "retire", "idle", "recycle", "stop"}]
    /\ read \subseteq Workers \X Reqs
    /\ cut \in BOOLEAN
    /\ recycledFor \subseteq Workers \X Reqs
    /\ staleStart \in BOOLEAN
    /\ stopAt \in 0 .. MaxLaunches

Init ==
    /\ caller = [r \in Reqs |-> "new"]
    /\ pending = {}
    /\ sent = [r \in Reqs |-> None]
    /\ waiting = <<>>
    /\ probes = {}
    /\ writes = <<>>
    /\ launching = None
    /\ launches = 0
    /\ answers = {}
    /\ running = None
    /\ made = 0
    /\ life = [g \in Workers |-> "none"]
    /\ unanswered = {}
    /\ overdue = {}
    /\ graces = {}
    /\ idles = {}
    /\ lines = {}
    /\ wrote = {}
    /\ gaveups = {}
    /\ exits = {}
    /\ changed = FALSE
    /\ endedBy = [g \in Workers |-> "none"]
    /\ read = {}
    /\ cut = FALSE
    /\ recycledFor = {}
    /\ staleStart = FALSE
    /\ stopAt = 0

\* Which kinds each rule applies to.
\* @code native/ompdesk/crates/core/src/stock/mod.rs:753-766 Lane::outlived_its_omp the terminals worker is never let go for a changed omp
Retires == Kind # "terminals"
\* @code native/ompdesk/crates/core/src/stock/mod.rs:922-952 Lane::gave_up only the stock worker is replaced when its lane stays silent
Recycles == Kind = "stock"
\* @code native/ompdesk/crates/core/src/stock/mod.rs:986-1004 Lane::arm_idle_exit only the extensions worker has an idle exit
IdleExits == Kind = "extensions"

\* omp was reinstalled while the lane's worker ran, and nothing is in flight on it: no request it was sent is
\* unanswered and none but the asking one waits.
\* @code native/ompdesk/crates/core/src/stock/mod.rs:753-766 Lane::outlived_its_omp
Outlived == running # None /\ Retires /\ changed /\ unanswered = {} /\ pending = {}

\* The lane asks main how to start a worker.
\* @code native/ompdesk/crates/core/src/stock/mod.rs:720-748 Lane::request the `stock.launch` event, named by a number never used before
Ask ==
    /\ launches < MaxLaunches
    /\ launches' = launches + 1
    /\ launching' = launches + 1
    /\ answers' = answers \cup {launches + 1}

\* The lane ends its worker: closes its stdin (`closing`), or kills it when it hung.
\* @code native/ompdesk/crates/core/src/stock/mod.rs:769-775 Lane::let_go
LetGo(why) ==
    /\ life' = [life EXCEPT ![running] = IF why = "recycle" THEN "killed" ELSE "closing"]
    /\ endedBy' = [endedBy EXCEPT ![running] = why]
    /\ cut' = (cut \/ (why \in {"retire", "idle"} /\ \E q \in Reqs : sent[q] = running /\ <<running, q>> \notin read))
    /\ running' = None
    /\ unanswered' = {}
    /\ overdue' = {}

\* Everything the lane still owes an answer fails.
\* @code native/ompdesk/crates/core/src/stock/mod.rs:794-799 Lane::fail_pending
Fail ==
    /\ caller' = [r \in Reqs |-> IF r \in pending /\ caller[r] = "waiting" THEN "failed" ELSE caller[r]]
    /\ pending' = {}
    /\ waiting' = <<>>

Ids(q) == {q[i] : i \in DOMAIN q}

RECURSIVE ReadyPrefix(_, _)
ReadyPrefix(q, outstanding) ==
    IF q = <<>> THEN <<>>
    ELSE IF Head(q) \in outstanding THEN <<>>
    ELSE <<Head(q)>> \o ReadyPrefix(Tail(q), outstanding)

\* q omits IDs no longer in pending: flush skips those entries without writing them.
\* @code native/ompdesk/crates/core/src/stock/mod.rs:778-792 Lane::flush
Flush(g, q, outstanding) ==
    LET batch == IF g = None THEN <<>> ELSE ReadyPrefix(q, outstanding)
        sending == Ids(batch)
    IN /\ sent' = [r \in Reqs |-> IF r \in sending THEN g ELSE sent[r]]
       /\ unanswered' = unanswered \cup sending
       /\ waiting' = SelectSeq(q, LAMBDA r : r \notin sending)
       /\ writes' = IF Kind = "terminals" THEN writes \o batch ELSE writes

\* A request reaches the lane.
\* @code native/ompdesk/crates/core/src/stock/mod.rs:720-748 Lane::request
Request(r, probe) ==
    /\ caller[r] = "new"
    /\ IF Kind = "terminals" THEN r = 1 + Cardinality({x \in Reqs : caller[x] # "new"}) ELSE TRUE
    /\ probes' = IF probe THEN probes \cup {r} ELSE probes
    /\ caller' = [caller EXCEPT ![r] = "waiting"]
    /\ pending' = pending \cup {r}
    /\ IF Outlived
         THEN /\ LetGo("retire")
              /\ waiting' = Append(waiting, r)
              /\ Ask
              /\ UNCHANGED <<sent, writes>>
         ELSE IF running # None
         THEN /\ Flush(running, Append(waiting, r), probes')
              /\ UNCHANGED <<launching, launches, answers, running, life, overdue, endedBy, cut>>
         ELSE /\ waiting' = Append(waiting, r)
              /\ IF launching = None THEN Ask ELSE UNCHANGED <<launching, launches, answers>>
              /\ UNCHANGED <<sent, writes, running, life, unanswered, overdue, endedBy, cut>>
    /\ UNCHANGED <<made, graces, idles, lines, wrote, gaveups, exits, changed, read, recycledFor, staleStart, stopAt>>

\* @code native/ompdesk/crates/core/src/stock/mod.rs:630-718 Lane::start handles the blocking task's ShellReady(id, result)
ShellReady(r, ok) ==
    /\ r \in probes
    /\ probes' = probes \ {r}
    /\ IF ~ok /\ r \in pending
         THEN /\ pending' = pending \ {r}
              /\ caller' = [caller EXCEPT ![r] = IF @ = "waiting" THEN "failed" ELSE @]
         ELSE UNCHANGED <<caller, pending>>
    /\ Flush(running, SelectSeq(waiting, LAMBDA id : id \in pending'), probes')
    /\ UNCHANGED <<launching, launches, answers>>
    /\ UNCHANGED <<running, made, life, overdue, graces, idles, lines, wrote, gaveups, exits, changed, endedBy,
                   read, cut, recycledFor, staleStart, stopAt>>

\* Main's answer to a start reaches the lane: how to start the worker (`ok`), or why none can start.
\* @code native/ompdesk/crates/core/src/stock/mod.rs:801-816 Lane::launched
Launched(l, ok) ==
    /\ l \in answers
    /\ answers' = answers \ {l}
    /\ IF launching # l
         THEN UNCHANGED <<caller, pending, sent, waiting, launching, running, made, life, unanswered, idles, changed,
                          staleStart, writes>>
         ELSE /\ launching' = None
              /\ IF ok
                   THEN /\ made < MaxWorkers
                        /\ made' = made + 1
                        /\ running' = made + 1
                        /\ life' = [life EXCEPT ![made + 1] = "up"]
                        /\ Flush(made + 1, waiting, probes)
                        /\ changed' = FALSE
                        /\ idles' = IF IdleExits /\ unanswered' = {} THEN idles \cup {made + 1} ELSE idles
                        /\ staleStart' = (staleStart \/ l <= stopAt)
                        /\ UNCHANGED <<caller, pending>>
                   ELSE /\ Fail
                        /\ UNCHANGED <<sent, running, made, life, unanswered, idles, changed, staleStart, writes>>
    /\ UNCHANGED <<probes, launches, overdue, graces, lines, wrote, gaveups, exits, endedBy, read, cut, recycledFor, stopAt>>

\* A request's timeout passes in its handler before the lane answered it: the caller is told at once.
\* @code native/ompdesk/crates/core/src/stock/mod.rs:411-439 wait the select over the answer, the timer and the cancel
TimerFires(r) ==
    /\ caller[r] = "waiting"
    /\ caller' = [caller EXCEPT ![r] = "timedout"]
    /\ gaveups' = gaveups \cup {r}
    /\ UNCHANGED <<pending, sent, waiting, launching, launches, answers, running, made, life, unanswered, overdue,
                   graces, idles, lines, wrote, exits, changed, endedBy, read, cut, recycledFor, staleStart, stopAt>>

\* The lane hears that a request's caller gave up: the worker is told to skip it, and a stock worker gets a grace.
\* @code native/ompdesk/crates/core/src/stock/mod.rs:922-952 Lane::gave_up
GaveUp(r) ==
    /\ r \in gaveups
    /\ gaveups' = gaveups \ {r}
    /\ IF r \notin pending
         THEN UNCHANGED <<pending, overdue, graces, waiting, sent, unanswered, writes>>
         ELSE /\ pending' = pending \ {r}
              /\ IF r \in unanswered
                   THEN UNCHANGED <<waiting, sent, unanswered, writes>>
                   ELSE Flush(running, SelectSeq(waiting, LAMBDA id : id # r), probes)
              /\ IF running # None /\ r \in unanswered /\ Recycles
                   THEN /\ overdue' = overdue \cup {r}
                        /\ graces' = graces \cup {<<running, r>>}
                   ELSE UNCHANGED <<overdue, graces>>
    /\ UNCHANGED <<caller, probes, launching, launches, answers, running, made, life, idles, lines,
                   wrote, exits, changed, endedBy, read, cut, recycledFor, staleStart, stopAt>>

\* A worker answers a request it was sent (its result, its error, or `withdrawn`).
WorkerAnswers(g, r) ==
    /\ life[g] \in {"up", "closing"}
    /\ sent[r] = g
    /\ <<g, r>> \notin wrote
    /\ wrote' = wrote \cup {<<g, r>>}
    /\ lines' = lines \cup {<<g, r>>}
    /\ UNCHANGED <<caller, pending, sent, waiting, launching, launches, answers, running, made, life, unanswered,
                   overdue, graces, idles, gaveups, exits, changed, endedBy, read, cut, recycledFor, staleStart, stopAt>>

\* The lane reads a worker's answer; one from a worker that is no longer its own is dropped.
\* @code native/ompdesk/crates/core/src/stock/mod.rs:904-917 Lane::line
ReadLine(g, r) ==
    /\ <<g, r>> \in lines
    /\ lines' = lines \ {<<g, r>>}
    /\ IF g # running
         THEN UNCHANGED <<caller, pending, unanswered, overdue, idles, read>>
         ELSE /\ read' = read \cup {<<g, r>>}
              /\ overdue' = overdue \ {r}
              /\ unanswered' = unanswered \ {r}
              /\ idles' = IF IdleExits /\ unanswered \ {r} = {} THEN idles \cup {g} ELSE idles
              /\ IF r \in pending
                   THEN /\ pending' = pending \ {r}
                        /\ caller' = [caller EXCEPT ![r] = IF @ = "waiting" THEN "answered" ELSE @]
                   ELSE UNCHANGED <<caller, pending>>
    /\ UNCHANGED <<sent, waiting, launching, launches, answers, running, made, life, graces, wrote, gaveups, exits,
                   changed, endedBy, cut, recycledFor, staleStart, stopAt>>

\* The grace of a timed-out request passes: the worker it was armed for, still silent on it, is ended as hung.
\* @code native/ompdesk/crates/core/src/stock/mod.rs:956-974 Lane::overdue
Grace(g, r) ==
    /\ <<g, r>> \in graces
    /\ graces' = graces \ {<<g, r>>}
    /\ IF g = running /\ r \in overdue
         THEN /\ recycledFor' = recycledFor \cup {<<running, r>>}
              /\ Fail
              /\ LetGo("recycle")
         ELSE UNCHANGED <<caller, pending, waiting, running, life, unanswered, overdue, endedBy, cut, recycledFor>>
    /\ UNCHANGED <<sent, launching, launches, answers, made, idles, lines, wrote, gaveups, exits, changed, read,
                   staleStart, stopAt>>

\* The idle timer is due: the worker it was armed for, with nothing unanswered, is let go.
\* @code native/ompdesk/crates/core/src/stock/mod.rs:1006-1016 Lane::idle
Idle(g) ==
    /\ g \in idles
    /\ idles' = idles \ {g}
    /\ IF g = running /\ unanswered = {}
         THEN LetGo("idle")
         ELSE UNCHANGED <<running, life, unanswered, overdue, endedBy, cut>>
    /\ UNCHANGED <<caller, pending, sent, waiting, launching, launches, answers, made, graces, lines, wrote, gaveups,
                   exits, changed, read, recycledFor, staleStart, stopAt>>

\* A worker's process ends: by itself, on its closed stdin, or killed.
WorkerExits(g) ==
    /\ life[g] \in {"up", "closing", "killed"}
    /\ life' = [life EXCEPT ![g] = "dead"]
    /\ exits' = exits \cup {g}
    /\ UNCHANGED <<caller, pending, sent, waiting, launching, launches, answers, running, made, unanswered, overdue,
                   graces, idles, lines, wrote, gaveups, changed, endedBy, read, cut, recycledFor, staleStart, stopAt>>

\* The lane hears of an exit; that of its own worker fails what waited on it.
\* @code native/ompdesk/crates/core/src/stock/mod.rs:976-983 Lane::exited
ReadExit(g) ==
    /\ g \in exits
    /\ exits' = exits \ {g}
    /\ IF g = running
         THEN /\ running' = None
              /\ unanswered' = {}
              /\ overdue' = {}
              /\ Fail
         ELSE UNCHANGED <<caller, pending, waiting, running, unanswered, overdue>>
    /\ UNCHANGED <<sent, launching, launches, answers, made, life, graces, idles, lines, wrote, gaveups, changed,
                   endedBy, read, cut, recycledFor, staleStart, stopAt>>

\* A terminal's `omp update` or `bun install -g` replaced omp's files.
OmpChanges ==
    /\ ~changed
    /\ changed' = TRUE
    /\ UNCHANGED <<caller, pending, sent, waiting, launching, launches, answers, running, made, life, unanswered,
                   overdue, graces, idles, lines, wrote, gaveups, exits, endedBy, read, cut, recycledFor, staleStart,
                   stopAt>>

\* `stock.stop`: what waits fails, the worker is let go, and a start asked for is forgotten. A later request finds a
\* lane with nothing in it.
\* @code native/ompdesk/crates/core/src/stock/mod.rs:1019-1025 Lane::stop
Stop ==
    /\ Fail
    /\ launching' = None
    /\ stopAt' = launches
    /\ IF running # None THEN LetGo("stop") ELSE UNCHANGED <<running, life, unanswered, overdue, endedBy, cut>>
    /\ UNCHANGED <<sent, launches, answers, made, graces, idles, lines, wrote, gaveups, exits, changed, read,
                   recycledFor, staleStart>>

Next ==
    \/ \E r \in Reqs, probe \in (IF Kind = "terminals" THEN BOOLEAN ELSE {FALSE}) : Request(r, probe)
    \/ \E r \in Reqs, ok \in BOOLEAN : ShellReady(r, ok)
    \/ \E r \in Reqs : GaveUp(r)
    \/ \E l \in 1 .. MaxLaunches, ok \in BOOLEAN : Launched(l, ok)
    \/ /\ UNCHANGED <<probes, writes>>
       /\ \/ \E r \in Reqs : TimerFires(r)
          \/ \E g \in Workers, r \in Reqs : WorkerAnswers(g, r) \/ ReadLine(g, r) \/ Grace(g, r)
          \/ \E g \in Workers : Idle(g) \/ WorkerExits(g) \/ ReadExit(g)
          \/ OmpChanges
          \/ Stop

Spec == Init /\ [][Next]_vars

(* ---- BEGIN FROZEN PROPERTIES (formal/stock-lane/Properties.md) ---- *)

\* A worker is let go for a changed omp or for idleness only with no request in flight on it.
NothingInFlightIsCut == ~cut

\* The terminals worker holds every live shell: the lane ends it only when it is stopped.
TerminalsWorkerIsNeverEnded == Kind = "terminals" => \A g \in Workers : endedBy[g] \in {"none", "stop"}

\* A plugin upgrade may run for minutes: only the stock worker is ever ended as hung.
OnlyTheStockWorkerIsRecycled == \A g \in Workers : endedBy[g] = "recycle" => Kind = "stock"

\* A worker is ended as hung only for a request it was sent, whose caller timed out, and that it never answered.
OnlyAStuckWorkerIsRecycled ==
    \A p \in recycledFor : sent[p[2]] = p[1] /\ caller[p[2]] = "timedout" /\ p \notin read

\* With a worker already running, the only unsent wait is for a live shell probe at the head of the terminal FIFO.
NoRequestStranded ==
    \A r \in pending :
        \/ (r \in Ids(waiting) /\ launching # None /\ running = None)
        \/ (running # None /\ sent[r] = running /\ r \in unanswered)
        \/ /\ Kind = "terminals" /\ running # None /\ launching = None
           /\ r \in Ids(waiting) /\ sent[r] = None
           /\ Head(waiting) \in pending \cap probes /\ sent[Head(waiting)] = None
           /\ Head(waiting) <= r

TerminalWritesInOrder ==
    \A i \in DOMAIN writes :
        /\ writes[i] \notin probes
        /\ \A r \in pending : r < writes[i] => sent[r] # None
        /\ \A j \in 1 .. (i - 1) : writes[j] < writes[i]

\* Until GaveUp reaches the lane, a ready frame may still win the race with its caller's timeout.
DroppedRequestsStayGone ==
    [][\A r \in Reqs :
        /\ ((caller'[r] = "failed" \/ (caller'[r] = "timedout" /\ r \notin gaveups'))
            => (r \notin pending' /\ sent'[r] = sent[r]))
        /\ ((caller[r] # "new" /\ r \notin pending) => (r \notin pending' /\ sent'[r] = sent[r]))]_vars

\* A preparation result cannot request or spawn a worker. A result for a removed ID cannot change any live request.
PreparationCannotRevive ==
    [][probes \ probes' # {} =>
        /\ UNCHANGED <<launches, made>>
        /\ ((probes \ probes') \cap pending = {} => UNCHANGED <<caller, pending, waiting, sent, writes, launching, running>>)]_vars

\* Every worker that runs with its stdin open is the lane's: none is left running that nothing will end.
NoWorkerIsForgotten == \A g \in Workers : life[g] = "up" => g = running

\* An answer to a start asked for before a stop starts no worker.
AStartAskedBeforeAStopStartsNothing == ~staleStart

(* ---- END FROZEN PROPERTIES ---- *)

\* Sanity: each must be violated, or the model cannot reach the behaviour the properties are about.
NeverRecycles == \A g \in Workers : endedBy[g] # "recycle"
NeverRetires == \A g \in Workers : endedBy[g] # "retire"
NeverIdleExits == \A g \in Workers : endedBy[g] # "idle"
NeverAnswersLate == \A r \in Reqs : ~(caller[r] = "timedout" /\ \E g \in Workers : <<g, r>> \in read)
NeverWaitsBehindCreate ==
    ~(running # None /\ Len(waiting) = 2 /\ waiting[1] \in probes \cap pending
      /\ waiting[2] \in pending \ probes /\ sent[waiting[2]] = None)
=============================================================================
