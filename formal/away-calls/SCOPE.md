# Scope: a device tab's control calls while the device is away

## The promise

A control call a paired device's session makes on its host (`ompdesk_*`, a host tool call of the omp `LocalHostServices` runs for the device) has its effect at most once, on the device or on the host; the session is never left waiting on a call nobody will answer while the device is away; and a report the session was told is kept reaches the device's opener once when the device is back.

## The harm

19 Nov 2026: the MacBook slept 12:55-16:58 and the sessions its hub had opened on the Mac mini stood still, each in a control call only the sleeping MacBook would run. Letting the host run them instead risks the opposite failure: a call both computers carry out (two children opened, two messages sent).

## Why tests miss it

The bug lives in orders: a call handed to a link that is already dead but not yet seen dead, a re-attach racing the host's takeover, a reply lost with the link, the host restarting between keeping a report and handing it over. A unit test picks one order; the model checks all of them within the bounds.

## Bounds

Calls `{c1, c2, r1}` (`r1` a report), at most 2 sleeps of the device and 1 restart of the host; any interleaving. `MC.cfg`: 32 406 distinct states, depth 21 (formal.yml run 44489315919).

## In the model

The omp's call entering `hostCalls` (`delivered` while a connection is held), the link dying unseen, the host seeing it (`#startGrace`), the device's re-attach re-sending every open call and the kept reports (`#open`, `#handKept`), the device running what reaches it through its call journal (ipc.ts `hostToolExecutor`), the device's answer (`#answer`), the host's takeover (`#takeOver`, `#keepForDevice`), the host's restart.

## Not in the model

- Which tool a call is (the kept/refused/carried split in `#takeOver`): a refused call is an answered call with no effect, a carried one is `runs`.
- The window view that carries a call out (`showAway`, `HostedTabView.carryOut`): a call taken while no window listens stays in `hostCalls`, the model's not-yet-taken state.
- The device's own call journal internals (begin/finish/reconcile): modelled as "runs a call at most once"; its relaunch cases are pinned by `service.test.ts`.
- The opener's mail coalescing: the hub holding a report is one delivery by id.
