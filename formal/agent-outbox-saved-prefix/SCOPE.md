# Original outbox saved-prefix eligibility

Status: **SOURCE ONLY / NOT CHECKED**. `syncCommit: null`. New model, not covered by any prior Inbox/wake/hop result. No shared manifest changes, SANY/TLC/model enumeration, mutation run, workflow dispatch or stamp were performed.

## Promise and harm

A retained original that failed its first save must not reach a receiver before the same original is physically saved. Older already-saved originals must remain eligible. Source retention, dedup and attachment GC must continue owning every pending original, including an unsaved suffix.

Main observed actual native RED `20261115-064337-2c62`: three consumers failed after canonical EISDIR saves; an unsaved send/report reached the receiver and a newer unsaved send followed an older durable one. Production saved-prefix fix: `f34e194e934abe3d13d947bf5df444039d60b820`. Caller ordering/receipt fix: `2bc13d2ebdc0efd5bde75d050e02b9bbcf6b24c4`; its separate actual service RED was `20261115-070304-c6e5`.

## State and actors

One disk-backed outbox and one receiver. Two logical original IDs and two opaque payload values in `tla/MC.cfg`. Payload abstracts the full immutable body/provenance/ordered attachment-reference identity; derived landing path/time is not logical identity. Multiple keys, devices and byte contents are not separately enumerated.

- `entries`: same original pending sequence, oldest first; no selectable mode or hidden follow-up lane.
- `savedPrefix`: contiguous eligible prefix inside that sequence, not another queue/counter of dispatch identities.
- `disk`: last successful physical journal snapshot.
- `deferred`: the existing disk-full retry's bytes, or no write. It is not an added delivery queue.
- `batch/cursor/phase`: a captured delivery iteration across receiver awaits. Canonical save and snapshot selection remain one sender mutex region.
- `seen/effects`: environment receiver's atomic durable dedup/effect state.
- `firstPayload`, `durableOrder`, `effectOrder`, `owned`: proof-only history/obligation observations, not proposed production caches or authority.

The initial sender journal, receiver dedup state and ghost history are empty. Nonempty loaded snapshots arise through the existing keep/save, receive, ACK and crash/reload actions, not arbitrary combinations of disk rows and receiver subsets. Keep success/failure and exact retry/conflict, ACK success/failure, retry snapshot success/failure, receiver delivery, disk-full retry success/final failure, and sender crash/reload are explicit transitions. An ACK may remove an original while an existing snapshot still holds it. ACK loss is represented by delivery without removal. A sender crash reloads only the last physical disk snapshot and drops its pending save thread and volatile batch; it preserves first-payload, first-durable and receiver-effect history.

## Important assumptions and exclusions

1. The source's original logical ID is stable. A different payload is offered as an existing-row conflict, not a newly authorized replacement. The outbox has no terminal identity journal; after a row is forgotten or a never-durable row is lost in a crash, authority for reusing the same ID with a different payload is outside this model. `firstPayload` is a ghost observation, not such a new journal.
2. Successful atomic save really preserves the complete snapshot; failed saves preserve prior physical bytes. Existing `disk::saves` serialization prevents a stale deferred snapshot from overwriting a newer canonical write. The deferred action deliberately does not upgrade in-memory eligibility and does not treat `store.saved` as success evidence.
3. Receiver dedup is an **environment assumption**, not a proof of the missing stock custom-original admission API, provider model context, semantic understanding, or arbitrary external-tool effects. Only a sender core crash is modeled; receiver journal loss, stock-provider implementation and whole-system exactly-once claims are excluded.
4. One serialized receiver-delivery iteration is modeled. Production direct-new-send bypass is excluded by the separately tested `hand_send` prerequisite2bc; that caller branch is not falsely claimed as a transition proof here. Cross-receiver scheduling and the full Root permission graph are excluded.
5. Unsaved memory originals can be lost if the sender core crashes before physical persistence. They are never described as durable acceptance. Successful intentionally fileless test outboxes are excluded from this disk-backed model.
6. Attachment bytes/store import/rehome/GC execution is not modeled. `PendingInventory` covers retention of original logical references while the process lives. No automatic old queue migration, manual editor archive, approval ownership, model-only yield, UI, or active delivery mode is modeled.

## Reachable restart history

Main d130 corrects only the initial-state representation from original source `816a682a65eb27401cf31edad9a6a9b47e666240`. The original model and its manually substituted `disk=<<a,b>>, seen={b}` counterexample remain preserved. The eight frozen predicates and finite bounds are unchanged. No `seen`-prefix constraint or future-effects-only property replaces them.

The existing actions still permit this history with one opaque payload `p`:

1. From empty `Init`, `Keep(a,p,TRUE,FALSE)`, `Snapshot(TRUE,FALSE)`, `Receive`, `FinishSnapshot`, and `Ack(1,TRUE,FALSE)` leave the source empty after the receiver observes `a`.
2. `Keep(b,p,TRUE,FALSE)` followed by `Keep(a,p,TRUE,FALSE)` yields source/disk order `<<b,a>>`. Reusing the same retired key with its original payload remains allowed.
3. `CrashLoad` preserves `durableOrder=<<a,b>>`, `seen={a}` and `effectOrder=<<a>>`, while loading `entries=<<b,a>>`. It does not reconstruct history from disk order.
4. A new snapshot receives `b` and then the duplicate `a`. Under the explicit receiver dedup assumption, the first-effect order is `<<a,b>>` and each effect count is one.

This is a manual action substitution, not an executed trace or proof that every transition preserves the predicates. Sender `keep` only checks current pending rows; `settle` removes them, so neither source outbox forbids the re-keep in step2. Receiver dedup must retain the original identity through this history. Actual report reception consults the current receiver journal branch and queued-mail set; the model does not prove retention after receiver history loss, branch replacement, or provider consumption. Arbitrary preexisting files without a represented reachable history are outside this initialization, not silently granted a compatible receiver history.

## Bounds and remaining gate

`Ids={i1,i2}`, `Payloads={p1,p2}`; unique-key sequences have length0..2. No state constraint, VIEW, symmetry or fairness. Safety only; no eventual storage recovery or eventual model consumption claim. Deadlock checking is enabled in the source cfg. A passing run, if Main later obtains one, would apply only to these bounds and assumptions.

Before any verified/stamped claim: Main owns registration, parser/model execution, independent correspondence review, larger/negative configurations and mutations. This source includes no fabricated green baseline or prior-proof reuse.
