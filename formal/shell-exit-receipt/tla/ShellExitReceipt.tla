------------------------- MODULE ShellExitReceipt -------------------------
EXTENDS Naturals, Sequences
CONSTANT KeepStdin
VARIABLE s
vars == <<s>>

Init ==
  /\ s = [mode |-> "boot", phase |-> "open", relaunchWanted |-> FALSE,
            relaunchSet |-> FALSE, queue |-> <<>>, code |-> 0,
            accepted |-> FALSE, answer |-> "none", stdin |-> "open",
            node |-> "alive", joined |-> FALSE, result |-> "none",
            launched |-> FALSE, prematureEOF |-> FALSE]

\* @code native/ompdesk/crates/shell/src/main.rs:330-345 Select either boot exit or the CEF-ready path.
StartCEF ==
  /\ s.mode = "boot" /\ ~s.accepted /\ s.result = "none"
  /\ s' = [s EXCEPT !.mode = "cef"]

\* @code src/main/shell-host/electron/app.ts:286-288 Relaunch is an earlier frame, if requested.
QueueRelaunch ==
  /\ s.phase = "open" /\ s.node = "alive" /\ s.result = "none"
  /\ ~s.relaunchWanted
  /\ s' = [s EXCEPT !.relaunchWanted = TRUE, !.queue = Append(@, "relaunch")]

\* @code src/main/shell-host/electron/app.ts:295-310 The quit guard is set before listeners and a reentrant exit does nothing.
\* @code src/main/shell-host/client.ts:115-143 Requests write synchronously.
\* @code src/main/shell-host/client.ts:151-155 Events write synchronously on the same stream.
RequestExit(c) ==
  /\ s.phase = "open" /\ s.node = "alive" /\ s.result = "none"
  /\ s' = [s EXCEPT !.phase = "requested", !.code = c,
                    !.queue = Append(@, "exit")]

\* @code native/ompdesk/crates/shell/src/host.rs:250-283 The reader dispatches frames in FIFO order.
\* @code native/ompdesk/crates/shell/src/dispatch.rs:55-62 The relaunch event updates the lifecycle state.
ReadRelaunch ==
  /\ s.queue # <<>> /\ Head(s.queue) = "relaunch" /\ s.result = "none"
  /\ s' = [s EXCEPT !.queue = Tail(@), !.relaunchSet = TRUE]

\* @code native/ompdesk/crates/shell/src/dispatch.rs:19-25 The exit is accepted before its answer is queued.
\* @code native/ompdesk/crates/shell/src/lifecycle.rs:69-91 Records the code and EXITING before posting shutdown.
AcceptExit ==
  /\ s.queue # <<>> /\ Head(s.queue) = "exit" /\ s.result = "none"
  /\ s' = [s EXCEPT !.queue = Tail(@), !.accepted = TRUE, !.answer = "queued"]

\* @code native/ompdesk/crates/shell/src/host.rs:231-244 The writer may deliver the answer later.
\* @code src/main/shell-host/client.ts:190-226 The answer resolves the pending call.
DeliverAnswer ==
  /\ s.answer = "queued" /\ s.node = "alive" /\ s.result = "none"
  /\ s' = [s EXCEPT !.answer = "received"]

\* @code src/main/shell-host/electron/app.ts:303-310 Process exit follows either the answer or transport rejection.
NodeExit ==
  /\ s.node = "alive" /\ s.answer = "received"
  /\ s' = [s EXCEPT !.node = "ended"]

\* @code native/ompdesk/crates/shell/src/main.rs:335-358 BootExit and the CEF return share finalization.
\* @code native/ompdesk/crates/shell/src/node.rs:106-126 Accepted exit holds stdin during the wait.
BeginStop ==
  /\ s.accepted /\ s.phase = "requested" /\ s.result = "none"
  /\ s' = [s EXCEPT !.phase = "stopping",
                    !.stdin = IF KeepStdin THEN "open" ELSE "closed"]

\* @code src/main/shell-host/electron/index.ts:26-39 EOF triggers failure shutdown, even if an answer is pending.
ObserveEOF ==
  /\ s.stdin = "closed" /\ s.node = "alive"
  /\ s' = [s EXCEPT !.node = "ended", !.prematureEOF = s.accepted /\ s.answer # "received"]

\* The process or its transport can die independently. Before EXITING this is failure.
UnexpectedDeath ==
  /\ s.node = "alive" /\ s.result = "none"
  /\ s' = [s EXCEPT !.node = "ended", !.result = IF s.accepted THEN "none" ELSE "failure"]

\* @code native/ompdesk/crates/shell/src/node.rs:117-126 A grace timeout kills and waits for Node.
TimeoutKill ==
  /\ s.phase = "stopping" /\ s.node = "alive" /\ s.result = "none"
  /\ s' = [s EXCEPT !.node = "ended"]

\* @code native/ompdesk/crates/shell/src/main.rs:350-358 Relaunch is attempted after stop has joined Node.
JoinAndFinalize ==
  /\ s.phase = "stopping" /\ s.node = "ended" /\ s.result = "none"
  /\ s' = [s EXCEPT !.joined = TRUE, !.phase = "done", !.result = "exit",
                    !.launched = s.relaunchSet]

TypeOK ==
  /\ s.mode \in {"boot", "cef"} /\ s.phase \in {"open", "requested", "stopping", "done"}
  /\ s.answer \in {"none", "queued", "received"} /\ s.node \in {"alive", "ended"}
  /\ s.stdin \in {"open", "closed"} /\ s.result \in {"none", "failure", "exit"}
  /\ s.code \in {0, 7} /\ s.queue \in Seq({"relaunch", "exit"})
  /\ Len(s.queue) <= 2

ReceiptAfterAcceptance == s.answer = "received" => s.accepted
RelaunchAfterJoin == s.launched => s.joined /\ s.node = "ended" /\ s.relaunchWanted /\ s.accepted
NoPrematureEOF == ~s.prematureEOF
FailureBeforeAcceptance == s.result = "failure" => ~s.accepted /\ ~s.launched

Next == StartCEF \/ QueueRelaunch \/ (\E c \in {0, 7}: RequestExit(c))
        \/ ReadRelaunch \/ AcceptExit \/ DeliverAnswer \/ NodeExit \/ BeginStop
        \/ ObserveEOF \/ UnexpectedDeath \/ TimeoutKill \/ JoinAndFinalize
Spec == Init /\ [][Next]_vars
=============================================================================
