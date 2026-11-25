# Properties (frozen)

Definitions live between the banners in `tla/OpenFirstMessage.tla`.

| Property | Statement | Source |
|---|---|---|
| `OnceAtMost` | The child's journal holds its first message at most once. | the hub's brief d2 (19 Nov 2026: "delivered exactly once after the relaunch"); `.omp/rules/control-tools.md` › "A message survives its receiver's omp ending" |
| `NeverLost` | Once the open began, its first message is kept, held by the child's omp, or journaled: never nowhere. | the owner's report d3 (19 Nov 2026: a child opened during the update countdown came back "not started", untitled, with no first message) |
| `Arrives` | Once the open began, the child gets its first message. | the hub's brief d2 |

Sanity (must be violated): `NoCutArrival`.
