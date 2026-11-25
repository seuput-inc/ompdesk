# Scope: CEF stream loss and recovery acknowledgement

The harm is a silently stale session/approval view after an evicted final event, or a replacement stream stranded by an old resource. The model follows bounded queue eviction, a partially delivered frame, reader replacement, an ordered reset, and a serial asynchronous authoritative read and ACK. Tests separately exercise real frame bytes and renderer stores.

Bounds are one window, two reader incarnations, queue capacity one or two and three or four producer events. Counters are monotone within those finite inputs. A replacement can arrive at any queue/read boundary; an authoritative read may fail. There is no fairness or liveness claim and deadlock checking is disabled for this safety-only model's quiescent states.

The model abstracts a frame copy as start/finish, preserves its identity while partial, and abstracts the successful applicable reads into one outcome. It does not prove the individual store's outcome, tab/split/ask reconciliation, permissions, offline freshness, rendering, network delivery, UTF-8 decoding, effect-free settings hydration or retry timing. Those require the real consumer regressions. It is not the paired-host SessionListing model, does not change that model's frozen properties and is not a proof of the whole app.

Native reset watermarks and bad-effect flags are observers used to state conservation and stale-reader properties, not extra production registries or identifiers. An emitted reset represents the latest coalesced eviction it covers; the page token remains a separate opaque incarnation. This separation permits a second loss during a partial reset or an older read.

No execution result is recorded here until the exact hosted matrix and mutations finish.
