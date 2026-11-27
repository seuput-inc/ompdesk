# Item ownership before implementation

One item belongs to host 0. Two peers compete within each of two assignment generations. The owner may restart with only the durable reservation; a failed disk write may leave a proposal, not permission to open. Delivery may be delayed across reassignment. Host or peer connectivity and disk availability change independently.

## Safety properties

- `DurableBeforeOpen`: an opened worker belongs to the holder durably recorded for that generation. Removing the write barrier must violate this even without a second contender.
- `OneWorkerPerGeneration`: at most one peer has opened for a given generation. The receiver's durable `(generation, peer)` key abstracts deduplication across retries; the model does not check that storage implementation or first-prompt delivery at the RPC boundary.
- `AddressFence`: a queued message is either undelivered, explicitly rejected as stale, or delivered to its original address. Never forward it silently to a new holder.
- `Prerequisites`: opening dependent work requires both acceptance of A and the owner's allowed answer. Owner refusal, replacement, withdrawal and a bot's own decision are not permission.

`SafeRelease` abstracts affirmative acknowledgement that an old holder can no longer run; disconnection alone is not such an acknowledgement. `Open`/`Prompt` assume the receiver enforces that fence. This is a safety model, not a proof of eventual recovery, exactly-once user-visible prompts, or notification of two separate dependents. The Rust boundary, storage and real-app cases require independent tests. No product files or sync stamp are claimed at this stage.
