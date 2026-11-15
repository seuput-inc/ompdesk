# Saved-prefix source correspondence

Sync commit: **null**. Production inputf34e194e934abe3d13d947bf5df444039d60b820; caller prerequisite2bc13d2ebdc0efd5bde75d050e02b9bbcf6b24c4. Source only; no parser/model/runtime verification result is implied.

| Model element | Actual source | Granularity / abstraction |
|---|---|---|
| `entries`, `savedPrefix` | send_outbox.rs200-205; mail_outbox.rs135-140 | One existing outbox collection plus its native mutex-protected saved-prefix index. |
| `Confirm(s)` | send_outbox.rs225-238; mail_outbox.rs150-158 | Successful full canonical write and prefix update are one critical section. Payload references are opaque. |
| `FailSave(s,prefix,retain)` | disk/saves.rs94-118; same persist functions | Error retains prior eligibility and physical snapshot. ENOSPC may retain these same bytes in the existing save service; other errors cancel its older pending write. |
| `Init`, `CrashLoad` | send_outbox.rs249-270; mail_outbox.rs166-185 | Parsed valid startup rows are all confirmed; core crash reload is an environment action. No corrupt-file fallback or receiver crash is modeled. |
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
