# Correspondence: AwayCalls.tla ↔ code

| Model | Code |
|---|---|
| `Call(c)` | `LocalHostServices.#trackRun` `pending`: `hostCalls.set(id, {delivered: tab.conn !== null})`, forwarded by `#wire` to the connection |
| `Sleep` / `Wake` | environment: the device's network goes; the host's socket stays open until the link's own dead-link check |
| `Detect` | `#startGrace`: `tab.conn = null` |
| `Reattach` | `#open` re-attach: every `hostCalls` entry emitted again (`resent` when `delivered`), then `#handKept` |
| `Lose`, `LoseReply` | environment: a frame on a connection that broke never arrives (a link that recovers retransmits: TCP) |
| `ARun(m)` | the device's `hostToolExecutor` → `AgentControlRuntime.run` (call journal for mutating tools, the running set for a re-sent call still under way); a report → the opener's `agent_control.mail` (bridge drops an id it holds) |
| `BReply(m)` | `#answer` with `side === "device"`: `hostCalls.delete` and the omp's answer, or `KeptCalls.settle` for a `kept:` id |
| `TakeOver(c)` | `#syncHostWait` timer → `away` → `#takeOver`: only `delivered === false` calls; reports `#keepForDevice` (`KeptCalls.keep` awaited before the answer) |
| `BCrash` | the host app quits or dies: the omp and its waiting calls end; `kept-host-calls.json` stays |

## Abstractions and assumptions

- `delivered` is set in the same synchronous step as the emit to the connection and is never reset; the takeover deletes the call from `hostCalls` in the same synchronous step as it decides, so a re-attach (another event-loop turn) never sees a taken call. Both are single-threaded main-process code; the model's actions are those steps.
- The takeover's 60 s timer is "any moment while the link is down"; that is a superset of the code's behaviour.
- A report delivered straight to the device (not kept) and a replayed one carry the same id (the device hashes sender, receiver, kind, dispatch and text); `StableIds` is that assumption, and its bug mode shows what breaks without it.
