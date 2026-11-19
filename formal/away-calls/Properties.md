# Properties (frozen)

Definitions live between the banners in `tla/AwayCalls.tla`.

| Property | Statement | Source |
|---|---|---|
| `AtMostOnce` | A control call's effect happens at most once, on the device or on the host. | the hub's brief (19 Nov 2026: "a call must never run twice, once on each side"); `.omp/rules/remote-devices.md` › "A re-sent control call runs at most once" |
| `HubOnce` | The opener holds each report at most once. | `.omp/rules/control-tools.md` › Mailbox ("the receiver's bridge drops an id its branch already holds") |
| `KeptUntilDelivered` | A report the session was told is kept stays in the host's outbox until the opener holds it. | the hub's brief ("reports must be kept and delivered when the opener comes back"); `.omp/rules/control-tools.md` › "A report is kept before it is sent" |
| `CallsSettle` | Once the device is back for good, every call the session waits on is answered. | `.omp/rules/remote-devices.md` › "Host tool calls and URI reads the hosted omp waits on come back too" |
| `KeptDelivered` | Once the device is back for good, every report kept for it reaches the opener. | the hub's brief |
| `AwayCallsSettle` | A call no connection was handed is answered while the device stays away. | the owner's report (19 Nov 2026: the MacBook slept 12:55-16:58 and the sessions it handed work to stalled) |

Sanity (must be violated): `NoTakeover`, `NoReplayDelivered`.
