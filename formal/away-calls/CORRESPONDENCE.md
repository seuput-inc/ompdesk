# Correspondence: AwayCalls.tla ↔ code

| Model | Code |
|---|---|
| `Call(c)` | `LocalHostServices.#trackRun` `pending`: `hostCalls.set(id, {delivered: tab.conn !== null})`, forwarded by `#wire` to the connection |
| `Sleep` / `Wake` | environment: the device's network goes; the host's socket stays open until the link's own dead-link check |
| `Detect` | `#startGrace`: `tab.conn = null` |
| `Reattach` | `#open` resends pending calls. `#handKept` asynchronously lists the committed calls for this peer and session, checks the connection, session and ready status again, and marks each ID before emitting it. A second lookup on the same attachment cannot emit that ID again. |
| `Lose`, `LoseReply` | environment: a frame on a connection that broke never arrives (a link that recovers retransmits: TCP) |
| `ARun(m)` | the device's `hostToolExecutor` → `AgentControlRuntime.run` (call journal for mutating tools, the running set for a re-sent call still under way); a report → the opener's `agent_control.mail` (bridge drops an id it holds) |
| `BReply(m)` | `#answer` removes the omp's pending call. For a `kept:` ID it instead awaits the Rust `Settle` transaction scoped to the replying device and session. A missing row is already settled. |
| `TakeOver(c)` | `#takeOver` claims only a call with `delivered === false`. `#keepForDevice` acknowledges success only after `remote.keptCalls` has atomically renamed the new file; on failure it returns an error to the omp. |
| `BCrash` | the host app quits or dies: the omp and its waiting calls end; `kept-host-calls.json` stays |

## Abstractions and assumptions

- `delivered` is set in the same synchronous step as the emit to the connection and is never reset; the takeover deletes the call from `hostCalls` in the same synchronous step as it decides, so a re-attach (another event-loop turn) never sees a taken call. Both are single-threaded main-process code; the model's actions are those steps.
- The takeover's 60 s timer is "any moment while the link is down"; that is a superset of the code's behaviour.
- A report delivered straight to the device (not kept) and a replayed one carry the same id (the device hashes sender, receiver, kind, dispatch and text); `StableIds` is that assumption, and its bug mode shows what breaks without it.
- The file rename is the storage transition. `kept_calls.rs::ordered` reserves each transaction in stdio arrival order before any task can yield; `run` reads committed rows, then lists or replaces them. A rejected keep has no deferred save. Restart discards no acknowledged keep.
- During a lookup, a disconnect or session switch can invalidate the snapshot. `#handKept` discards it; the model represents that frame as lost on the departed link. If a keep commits during reconnect, `#keepForDevice` initiates another lookup after commit. An ACK lost after the effect can still cause a wire replay: the opener deduplicates the report, not the transport.
- The model checks one device/session and successful storage, within the existing three-day and 200-row retention limits. It does not model filesystem failures, power loss before the OS flushes an atomic rename, expired or evicted rows, or notification display. The integration test exercises expiry, scoped IDs, ordering and stale lookup results outside those abstractions.
- OS notifications are not journaled (`agentctl/service/text.rs::mutates`). If a device displays a notice and loses the reply, the same `kept:` ID can be handed over on the next connection and display again. The model's `HubOnce` is about the opener's report inbox, not exactly-once notification delivery.
