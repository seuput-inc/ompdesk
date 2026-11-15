# Frozen properties: original outbox saved-prefix eligibility

Frozen source input: `f34e194e934abe3d13d947bf5df444039d60b820`; caller-gate prerequisite `2bc13d2ebdc0efd5bde75d050e02b9bbcf6b24c4`. New isolated source model requested by Main d123. This is not an extension or reuse of the old Inbox/wake/hop verdicts.

All results: **not run**. No manifest entry or sync stamp exists; `syncCommit` remains null. Changes to the definitions between the frozen banners, bounds, assumptions or `Spec` require explicit model-change review. No fairness, symmetry, state constraint, VIEW or follow-up lane is present.

| Predicate | Meaning | Source / level |
|---|---|---|
| `TypeOK` | Pending/disk/deferred/snapshot sequences have unique original keys, and the prefix/cursor remain in bounds. | Same ordered entries collection and native mutex; code-level shape. |
| `PendingInventory` | Every currently owned pending original remains in the full entries inventory, including unconfirmed suffix rows. | `pending`, `owed_to`, `attachment_shas`; protocol, no trim/drop on save failure. |
| `PayloadStable` | Existing logical identity never changes its first payload, including through retry, disk snapshot, deferred write or delivery snapshot. | Both `keep` conflict guards; protocol. Payload includes body/provenance/ordered attachment references, not derived landing paths/time. |
| `ConfirmedPrefix` | Each prefix row has actually appeared in a successful physical journal write or initial journal load. | `State::persist`, constructors and `saved_prefix`; protocol. |
| `SnapshotOnlyConfirmed` | Every captured delivery original has successful journal evidence even if an ACK later removes its pending row. | `delivery_to`, `delivery_pending`; protocol. |
| `AtMostOnce` | Receiver effects for one original identity do not exceed one. | Receiver atomic durable dedup assumption, not proof of stock/provider behavior. |
| `ReceiverDedupConsistent` | The receiver's durable identity set and effect count agree. | Same receiver assumption; distinguishes source save from receiver effect. |
| `EffectOrder` | First receiver effects are a unique subsequence of the first-durable original order. | Ordered original inventory and serialized sender lane; protocol under the bounded single-receiver abstraction. |

Save failure keeps the previous prefix; ACK removal decreases it only for an earlier confirmed position. These are transition contracts, not weakened postconditions. Crash reload uses the last physical disk snapshot. Unsaved memory-only rows can be lost in a core crash and are never represented as durable acceptance. Successful fileless test outboxes are outside this disk-backed model.

`AtMostOnce` and receiver-order results, if later checked, remain conditional on the receiver assumption. No property claims provider context consumption, semantic understanding, arbitrary external-tool transaction idempotence, or full immediate-instruction completion.
