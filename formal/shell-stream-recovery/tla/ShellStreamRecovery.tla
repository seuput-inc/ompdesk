------------------------ MODULE ShellStreamRecovery ------------------------
EXTENDS Naturals, Integers, Sequences
CONSTANTS Capacity, MaxEvents, FenceReader, KeepPartial, AnnounceLoss, FenceAck, WaitRead
VARIABLE s
vars == <<s>>
Max(a, b) == IF a > b THEN a ELSE b

Init == s = [queue |-> <<>>, partial |-> 0, produced |-> 0, lost |-> 0,
             after |-> -1, debt |-> 0, resetPart |-> -1, reader |-> 1,
             waiting |-> FALSE, pending |-> 0, serial |-> 0, pendingLoss |-> 0,
             read |-> "none", readToken |-> 0, readLoss |-> 0, ackedLoss |-> 0,
             badReader |-> FALSE, badAck |-> FALSE]

TypeOK ==
    /\ s.queue \in Seq(1..MaxEvents) /\ Len(s.queue) <= Capacity
    /\ s.partial \in 0..MaxEvents /\ s.produced \in 0..MaxEvents
    /\ s.lost \in 0..MaxEvents /\ s.after \in -1..Capacity
    /\ s.debt \in 0..MaxEvents /\ s.resetPart \in -1..MaxEvents
    /\ s.reader \in {1, 2} /\ s.waiting \in BOOLEAN
    /\ s.pending \in 0..(MaxEvents + 2) /\ s.serial \in 0..(MaxEvents + 2)
    /\ s.pendingLoss \in 0..MaxEvents /\ s.read \in {"none", "working", "ok", "failed"}
    /\ s.readToken \in 0..(MaxEvents + 2) /\ s.readLoss \in 0..MaxEvents
    /\ s.ackedLoss \in 0..MaxEvents /\ s.badReader \in BOOLEAN /\ s.badAck \in BOOLEAN

\* @code native/ompdesk/crates/shell/src/ipc.rs:37-46 Stream.push: evict a complete queued frame, then owe a reset after retained frames
Push ==
    LET next == Append(s.queue, s.produced + 1)
        overflow == Len(next) > Capacity
        kept == IF overflow THEN
                    IF s.partial # 0 /\ KeepPartial THEN <<Head(next)>> \o Tail(Tail(next)) ELSE Tail(next)
                ELSE next
    IN /\ s.produced < MaxEvents
       /\ s' = [s EXCEPT !.queue = kept, !.produced = @ + 1,
                 !.lost = @ + IF overflow THEN 1 ELSE 0,
                 !.after = IF overflow /\ AnnounceLoss THEN Len(kept) ELSE @,
                 !.debt = IF overflow /\ AnnounceLoss THEN s.lost + 1 ELSE @,
                 !.waiting = FALSE]

\* @code native/ompdesk/crates/shell/src/ipc.rs:49-76 Stream.fill: a split output buffer leaves the frame at the front with its offset
StartPartial ==
    /\ s.queue # <<>> /\ s.partial = 0 /\ s.resetPart = -1 /\ s.after # 0
    /\ s' = [s EXCEPT !.partial = Head(s.queue)]

\* @code native/ompdesk/crates/shell/src/ipc.rs:63-75 Stream.fill: finish one complete frame before moving the reset position
FinishFrame ==
    /\ s.queue # <<>> /\ s.resetPart = -1 /\ s.after # 0
    /\ s' = [s EXCEPT !.queue = Tail(@), !.partial = 0,
              !.after = IF @ > 0 THEN @ - 1 ELSE @]

\* @code native/ompdesk/crates/shell/src/ipc.rs:52-60 Stream.fill: the ordered reset may itself be partially delivered
StartReset ==
    /\ s.after = 0 /\ s.partial = 0 /\ s.resetPart = -1
    /\ s' = [s EXCEPT !.resetPart = s.debt, !.after = -1, !.debt = 0]

\* @code src/preload/shell.ts:89-106 resetStream/dispatch: a complete reset gives the page a new opaque token
FinishReset ==
    /\ s.resetPart >= 0 /\ s.serial < MaxEvents + 2
    /\ s' = [s EXCEPT !.serial = @ + 1, !.pending = s.serial + 1,
              !.pendingLoss = s.resetPart, !.resetPart = -1]

\* @code native/ompdesk/crates/shell/src/ipc.rs:88-101 open_reader: replace the resource, announce uncertainty and release its old waiter
ReplaceReader ==
    /\ s.reader = 1
    /\ s' = [s EXCEPT !.reader = 2, !.waiting = FALSE,
              !.after = Len(s.queue), !.debt = Max(s.lost, s.debt)]

\* @code native/ompdesk/crates/shell/src/ipc.rs:137-144 pull: an older resource cannot consume the replacement stream
OldRead ==
    /\ s.reader = 2 /\ s.queue # <<>>
    /\ s' = IF FenceReader THEN s ELSE
              [s EXCEPT !.queue = Tail(@), !.partial = 0,
                        !.after = IF @ > 0 THEN @ - 1 ELSE @, !.badReader = TRUE]

\* @code native/ompdesk/crates/shell/src/ipc.rs:148-155 reader_gone: stale cancellation cannot clear the current waiter
OldCancel ==
    LET parked == IF FenceReader THEN s.waiting ELSE FALSE
    IN /\ s.reader = 2 /\ s.waiting
       /\ s' = [s EXCEPT !.waiting = parked, !.badReader = @ \/ (s.waiting # parked)]

\* @code native/ompdesk/crates/shell/src/ipc.rs:122-133 read_or_park: an empty live reader waits for the next push
Park ==
    /\ s.queue = <<>> /\ s.after = -1 /\ s.resetPart = -1 /\ ~s.waiting
    /\ s' = [s EXCEPT !.waiting = TRUE]

\* @code src/renderer/web/resync.ts:127-130 installShellResync: capture the current token before awaiting authoritative reads
StartRead ==
    /\ s.pending # 0 /\ s.read = "none"
    /\ s' = [s EXCEPT !.read = "working", !.readToken = s.pending, !.readLoss = s.pendingLoss]

\* Environment: the applicable authoritative reads may succeed or fail. Store correctness is checked separately.
FinishRead(ok) ==
    /\ s.read = "working"
    /\ s' = [s EXCEPT !.read = IF ok THEN "ok" ELSE "failed"]

\* @code src/renderer/web/resync.ts:72-102 PageResync: a failed or superseded pass may be followed by another pass; timing is abstracted
DiscardRead ==
    /\ s.read # "none" /\ (s.read = "failed" \/ s.readToken # s.pending)
    /\ s' = [s EXCEPT !.read = "none"]

\* @code src/renderer/web/resync.ts:128-132 installShellResync and src/preload/shell.ts:84-85 acknowledge: success clears only the identical token
Ack ==
    /\ s.pending # 0 /\ s.read # "none"
    /\ (WaitRead => s.read = "ok")
    /\ (FenceAck => s.readToken = s.pending)
    /\ s' = [s EXCEPT !.badAck = @ \/ s.read # "ok" \/ s.readToken # s.pending,
              !.ackedLoss = IF s.read = "ok" /\ s.readToken = s.pending THEN Max(@, s.readLoss) ELSE @,
              !.pending = 0, !.pendingLoss = 0, !.read = "none"]

Next == Push \/ StartPartial \/ FinishFrame \/ StartReset \/ FinishReset \/ ReplaceReader
        \/ OldRead \/ OldCancel \/ Park \/ StartRead \/ (\E ok \in BOOLEAN : FinishRead(ok)) \/ DiscardRead \/ Ack
Spec == Init /\ [][Next]_vars

\* ===== Frozen properties (Properties.md) =====
NoPartialFrameLoss == s.partial = 0 \/ (Len(s.queue) > 0 /\ Head(s.queue) = s.partial)
NoStaleReaderEffect == ~s.badReader
NoUnsignalledLoss == s.lost = 0 \/ (s.after >= 0 /\ s.debt = s.lost)
                     \/ s.resetPart = s.lost \/ (s.pending # 0 /\ s.pendingLoss = s.lost) \/ s.ackedLoss = s.lost
CurrentReadBeforeAck == ~s.badAck
\* ===== End frozen properties =====
=============================================================================
