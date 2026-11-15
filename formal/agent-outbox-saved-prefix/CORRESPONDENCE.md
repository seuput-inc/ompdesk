# Saved-prefix source correspondence

Sync commit: **null**. Production inputf34e194e934abe3d13d947bf5df444039d60b820; caller prerequisite2bc13d2ebdc0efd5bde75d050e02b9bbcf6b24c4. Source only; no parser/model/runtime verification result is implied.

| Model element | Actual source | Granularity / abstraction |
|---|---|---|
| `entries`, `savedPrefix` | send_outbox.rs200-205; mail_outbox.rs135-140 | One existing outbox collection plus its native mutex-protected saved-prefix index. |
| `Confirm(s)` | send_outbox.rs225-238; mail_outbox.rs150-158 | Successful full canonical write and prefix update are one critical section. Payload references are opaque. |
| `FailSave(s,prefix,retain)` | disk/saves.rs94-118; same persist functions | Error retains prior eligibility and physical snapshot. ENOSPC may retain these same bytes in the existing save service; other errors cancel its older pending write. |
| `Init`, `CrashLoad` | send_outbox.rs249-270; mail_outbox.rs166-185 | Init is the empty canonical sender/receiver/history state. Nonempty parsed startup rows are represented by CrashLoad after actual modeled writes. CrashLoad confirms the loaded rows but preserves ghost and receiver history. Arbitrary initial disk/receiver-subset combinations, corrupt-file fallback and receiver crash are not modeled. |
| `Keep` | send_outbox.rs285-302; mail_outbox.rs200-225 | Append and successful/failed canonical save are one locked action, not an interleavable fake append/save pair. |
| `KeepRetry`, `RejectConflict` | send_outbox.rs288-301; mail_outbox.rs202-224 | Existing key and full logical payload guard before persistence. The first envelope/order is never replaced. Reuse after the row no longer exists is an explicit input assumption, not new native authority. |
| `Ack` | send_outbox.rs330-340; mail_outbox.rs249-258 | Removal adjusts eligibility only for an index before the prefix; the following save may succeed or fail. Snapshot references can survive removal. |
| `Snapshot` | send_outbox.rs356-375; mail_outbox.rs266-272 | Retry-save decision and selection of eligible original objects occur under one lock. Receiver filtering is abstracted to a single receiver. |
| `Receive` | Environment assumption; report dedup evidence is agent-control.ts229-245 | Abstract atomic durable original-ID dedup before receiver effect. NOT asserted as implemented by the absent private instruction bridge method or provider boundary. |
| `FinishSnapshot` | send_outbox.rs475-510; mail_outbox.rs295-307 | Receiver awaits occur between snapshot and completion; ACK may be lost and the same identity replayed. Sender handover metadata is abstracted away because it cannot grant unsaved eligibility. |
| `DeferredSuccess` | disk/saves.rs121-147 | Existing save thread writes last retained bytes without informing the outbox of successful eligibility; reload or later canonical save may establish it. |
| `DeferredFailure` | disk/saves.rs138-147 | Non-ENOSPC failure drops retry bytes and may emit store.saved, but cannot confirm bytes/eligibility. |
| `owned` | send pending342-352/attachment_shas; mail pending261-263/attachment_shas | Ghost pending obligation set; source/GC inventory is not replaced with the eligible snapshot. |
| `durableOrder`, `firstPayload`, `effects`, `effectOrder` | Ghost observations | First physically durable key order, immutable logical identity, receiver effect observations. No production storage or API is introduced. |

## Atomic regions and limits

Native outbox mutex protects insertion, conflict check, canonical write and prefix update; these are modeled together. Snapshot save/select is also one mutex region. Actual network/bridge calls are separate from selection, so producer save/ACK/deferred write/crash may interleave while a batch exists. The one receiver lane and durable receiver dedup are explicit assumptions. Save service write/retry holds its own existing lock, so newer canonical writes replace the old pending bytes.

There is no follow-up mode, user/agent attribution rewrite, replacement queue, authority registry, forced tool cancellation, claim of model understanding or liveness fairness. The separate current-instruction API and upstream publication gates remain open.

A text-only audit checked successor assignment/UNCHANGED coverage for all13variables in all10top-level actions, cfg references for8predicates and19resolving @code ranges. This is **not SANY, TLC, TLAPS, Lean, runtime verification, or a proof of semantic correspondence**. No checker was executed in this source unit.

## Initial-history correction

Main d130 authorizes only replacing the inconsistent arbitrary `Init` from source `816a682a65eb27401cf31edad9a6a9b47e666240` with empty canonical state. All existing actions, `Spec`, the eight frozen predicate definitions and `tla/MC.cfg` remain unchanged. The prior assignment audit and manual counterexample are retained as source evidence, not checker results.

`durableOrder`, `firstPayload`, `seen`, `effects` and `effectOrder` survive `CrashLoad` unchanged. They record first observations over the modeled history, not values reconstructed from the current disk sequence. The concrete re-keep history in `SCOPE.md` is therefore still represented even when disk order becomes `<<b,a>>` after the first effect of `a`.

The source lifecycle permits that re-keep: send_outbox.rs285-301 and mail_outbox.rs200-224 only reject conflicting payloads when the current row exists; send_outbox.rs330-338 and mail_outbox.rs249-256 remove settled rows without retaining a source-terminal identity record. The model's stable first-payload input assumption is unchanged and does not claim those sources authenticate a retired key forever.

Receiver dedup is independent of source removal. `resources/gui-bridge/agent-control.ts:229-245` checks the current journal branch or the still-queued report ID before admission. Keeping the same receiver identity through the modeled sender crash permits the duplicate `a` to have no second effect. This is conditional on the declared durable receiver-dedup environment assumption, not an implementation proof for the absent instruction admission method, indefinite branch retention, provider context, or semantic reading. No production code is changed by this correction.
