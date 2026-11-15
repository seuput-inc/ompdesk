---------------------------- MODULE SavedPrefix ----------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Ids, Payloads, NoPayload, NoWrite
VARIABLES entries, disk, savedPrefix, deferred, batch, cursor, phase,
          firstPayload, durableOrder, seen, effects, effectOrder, owned
vars == <<entries, disk, savedPrefix, deferred, batch, cursor, phase,
          firstPayload, durableOrder, seen, effects, effectOrder, owned>>

Entry == [id : Ids, payload : Payloads]
BoundedSeq(S) == UNION {[1..n -> S] : n \in 0..Cardinality(Ids)}
Keys(s) == [i \in 1..Len(s) |-> s[i].id]
Members(s) == {s[i] : i \in 1..Len(s)}
Unique(s) == Cardinality(Members(Keys(s))) = Len(s)
Snapshots == {s \in BoundedSeq(Entry) : Unique(s)}
Position(s, x) == IF x \in Members(s)
                  THEN CHOOSE i \in 1..Len(s) : s[i] = x ELSE 0
Remove(s, i) == SubSeq(s, 1, i - 1) \o SubSeq(s, i + 1, Len(s))
Extend(order, s) ==
    LET fresh == SelectSeq(s, LAMBDA r : r.id \notin Members(order))
    IN order \o Keys(fresh)
AllRecords == Members(entries) \cup Members(disk) \cup Members(batch)
              \cup (IF deferred = NoWrite THEN {} ELSE Members(deferred))

\* A canonical successful full write and its eligibility update share the outbox mutex.
\* @code native/ompdesk/crates/core/src/agentctl/journal/send_outbox.rs:225-238
\* @code native/ompdesk/crates/core/src/agentctl/journal/mail_outbox.rs:150-158
Confirm(s) ==
    /\ disk' = s /\ savedPrefix' = Len(s)
    /\ durableOrder' = Extend(durableOrder, s) /\ deferred' = NoWrite

\* Error preserves prior physical bytes and eligibility; ENOSPC may retain the same retry bytes.
\* @code native/ompdesk/crates/core/src/disk/saves.rs:94-118
FailSave(s, prefix, retain) ==
    /\ UNCHANGED <<disk, durableOrder>>
    /\ savedPrefix' = prefix /\ deferred' = IF retain THEN s ELSE NoWrite

\* Start from empty canonical sender/receiver history; loaded snapshots arise through real actions.
\* @code native/ompdesk/crates/core/src/agentctl/journal/send_outbox.rs:249-270
\* @code native/ompdesk/crates/core/src/agentctl/journal/mail_outbox.rs:166-185
Init ==
    /\ entries = <<>> /\ disk = <<>> /\ savedPrefix = 0
    /\ deferred = NoWrite /\ batch = <<>> /\ cursor = 1 /\ phase = "idle"
    /\ firstPayload = [id \in Ids |-> NoPayload]
    /\ durableOrder = <<>> /\ seen = {}
    /\ effects = [id \in Ids |-> 0] /\ effectOrder = <<>>
    /\ owned = {}

\* One new keep holds the existing mutex through append and the save result.
\* @code native/ompdesk/crates/core/src/agentctl/journal/send_outbox.rs:285-302
\* @code native/ompdesk/crates/core/src/agentctl/journal/mail_outbox.rs:200-225
Keep(id, payload, ok, retain) ==
    /\ id \notin Members(Keys(entries))
    /\ firstPayload[id] \in {NoPayload, payload}
    /\ LET added == Append(entries, [id |-> id, payload |-> payload])
       IN /\ entries' = added
          /\ IF ok THEN Confirm(added) ELSE FailSave(added, savedPrefix, retain)
    /\ firstPayload' = [firstPayload EXCEPT ![id] = payload]
    /\ owned' = owned \cup {id}
    /\ UNCHANGED <<batch, cursor, phase, seen, effects, effectOrder>>

\* Exact payload retries cannot replace the first row; save failure cannot upgrade it.
\* @code native/ompdesk/crates/core/src/agentctl/journal/send_outbox.rs:285-302
\* @code native/ompdesk/crates/core/src/agentctl/journal/mail_outbox.rs:200-225
KeepRetry(id, payload, ok, retain) ==
    /\ id \in Members(Keys(entries))
    /\ entries[Position(Keys(entries), id)].payload = payload
    /\ IF ok THEN Confirm(entries) ELSE FailSave(entries, savedPrefix, retain)
    /\ UNCHANGED <<entries, batch, cursor, phase, firstPayload, seen,
                   effects, effectOrder, owned>>

\* @code native/ompdesk/crates/core/src/agentctl/journal/send_outbox.rs:288-296
\* @code native/ompdesk/crates/core/src/agentctl/journal/mail_outbox.rs:202-219
RejectConflict(id, payload) ==
    /\ id \in Members(Keys(entries))
    /\ entries[Position(Keys(entries), id)].payload # payload
    /\ UNCHANGED vars

\* An ACK may remove an original while a prior delivery snapshot still owns its reference.
\* @code native/ompdesk/crates/core/src/agentctl/journal/send_outbox.rs:330-340
\* @code native/ompdesk/crates/core/src/agentctl/journal/mail_outbox.rs:249-258
Ack(i, ok, retain) ==
    /\ i \in 1..Len(entries) /\ entries[i].id \in seen
    /\ LET rest == Remove(entries, i)
           prefix == IF i <= savedPrefix THEN savedPrefix - 1 ELSE savedPrefix
       IN /\ entries' = rest
          /\ IF ok THEN Confirm(rest) ELSE FailSave(rest, prefix, retain)
    /\ owned' = owned \ {entries[i].id}
    /\ UNCHANGED <<batch, cursor, phase, firstPayload, seen, effects, effectOrder>>

\* A retry save and selection of eligible originals are ONE locked region, not two awaits.
\* @code native/ompdesk/crates/core/src/agentctl/journal/send_outbox.rs:356-375
\* @code native/ompdesk/crates/core/src/agentctl/journal/mail_outbox.rs:266-272
Snapshot(ok, retain) ==
    /\ phase = "idle"
    /\ IF savedPrefix < Len(entries)
          THEN IF ok THEN Confirm(entries) ELSE FailSave(entries, savedPrefix, retain)
          ELSE UNCHANGED <<disk, savedPrefix, durableOrder, deferred>>
    /\ batch' = SubSeq(entries, 1, IF savedPrefix < Len(entries) /\ ok
                                   THEN Len(entries) ELSE savedPrefix)
    /\ cursor' = 1 /\ phase' = "delivery"
    /\ UNCHANGED <<entries, firstPayload, seen, effects, effectOrder, owned>>

\* Environment assumption: receiver atomically deduplicates durable original identities before effects.
\* This is NOT a model of missing stock custom-original/provider admission or tool transactions.
Receive ==
    /\ phase = "delivery" /\ cursor <= Len(batch)
    /\ LET id == batch[cursor].id
       IN /\ seen' = seen \cup {id}
          /\ effects' = IF id \in seen THEN effects
                        ELSE [effects EXCEPT ![id] = @ + 1]
          /\ effectOrder' = IF id \in seen THEN effectOrder ELSE Append(effectOrder, id)
    /\ cursor' = cursor + 1
    /\ UNCHANGED <<entries, disk, savedPrefix, deferred, batch, phase,
                   firstPayload, durableOrder, owned>>

\* @code native/ompdesk/crates/core/src/agentctl/journal/send_outbox.rs:475-510
\* @code native/ompdesk/crates/core/src/agentctl/journal/mail_outbox.rs:295-307
FinishSnapshot ==
    /\ phase = "delivery" /\ cursor > Len(batch)
    /\ batch' = <<>> /\ cursor' = 1 /\ phase' = "idle"
    /\ UNCHANGED <<entries, disk, savedPrefix, deferred, firstPayload,
                   durableOrder, seen, effects, effectOrder, owned>>

\* A disk-full background retry changes physical bytes, not outbox eligibility.
\* @code native/ompdesk/crates/core/src/disk/saves.rs:121-147
DeferredSuccess ==
    /\ deferred # NoWrite /\ disk' = deferred
    /\ durableOrder' = Extend(durableOrder, deferred) /\ deferred' = NoWrite
    /\ UNCHANGED <<entries, savedPrefix, batch, cursor, phase, firstPayload,
                   seen, effects, effectOrder, owned>>

\* Non-ENOSPC final failure emits store.saved too; it must NOT imply successful persistence.
\* @code native/ompdesk/crates/core/src/disk/saves.rs:138-147
DeferredFailure ==
    /\ deferred # NoWrite /\ deferred' = NoWrite
    /\ UNCHANGED <<entries, disk, savedPrefix, batch, cursor, phase, firstPayload,
                   durableOrder, seen, effects, effectOrder, owned>>

\* Environment: sender core crash/reload. Unconfirmed memory-only originals may not be recovered.
\* Receiver identity/effects survive this SENDER-only crash; arbitrary receiver transactions are excluded.
CrashLoad ==
    /\ entries' = disk /\ savedPrefix' = Len(disk) /\ deferred' = NoWrite
    /\ batch' = <<>> /\ cursor' = 1 /\ phase' = "idle"
    /\ owned' = Members(Keys(disk))
    /\ UNCHANGED <<disk, firstPayload, durableOrder, seen, effects, effectOrder>>

Next ==
    \/ \E id \in Ids, p \in Payloads, ok \in BOOLEAN, retain \in BOOLEAN :
          Keep(id, p, ok, retain) \/ KeepRetry(id, p, ok, retain)
    \/ \E id \in Ids, p \in Payloads : RejectConflict(id, p)
    \/ \E i \in 1..Len(entries), ok \in BOOLEAN, retain \in BOOLEAN : Ack(i, ok, retain)
    \/ \E ok \in BOOLEAN, retain \in BOOLEAN : Snapshot(ok, retain)
    \/ Receive \/ FinishSnapshot \/ DeferredSuccess \/ DeferredFailure \/ CrashLoad
Spec == Init /\ [][Next]_vars

\* FROZEN PROPERTIES: independent new source set, not old Inbox/wake/hop predicates.
TypeOK ==
    /\ entries \in Snapshots /\ disk \in Snapshots /\ batch \in Snapshots
    /\ deferred \in Snapshots \cup {NoWrite}
    /\ savedPrefix \in 0..Len(entries) /\ cursor \in 1..(Len(batch) + 1)
    /\ phase \in {"idle", "delivery"}
    /\ firstPayload \in [Ids -> Payloads \cup {NoPayload}]
    /\ durableOrder \in BoundedSeq(Ids) /\ effectOrder \in BoundedSeq(Ids)
    /\ seen \subseteq Ids /\ owned \subseteq Ids /\ effects \in [Ids -> Nat]
PendingInventory == owned = Members(Keys(entries))
PayloadStable == \A r \in AllRecords : r.payload = firstPayload[r.id]
ConfirmedPrefix == \A i \in 1..savedPrefix : entries[i].id \in Members(durableOrder)
SnapshotOnlyConfirmed == Members(Keys(batch)) \subseteq Members(durableOrder)
AtMostOnce == \A id \in Ids : effects[id] <= 1
ReceiverDedupConsistent == \A id \in Ids : effects[id] = IF id \in seen THEN 1 ELSE 0
EffectOrder ==
    /\ Cardinality(Members(effectOrder)) = Len(effectOrder)
    /\ Members(effectOrder) \subseteq Members(durableOrder)
    /\ \A i, j \in 1..Len(effectOrder) :
          i < j => Position(durableOrder, effectOrder[i]) < Position(durableOrder, effectOrder[j])
\* END FROZEN PROPERTIES
=============================================================================
