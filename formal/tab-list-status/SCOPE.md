# Scope: a late tab list never undoes a tab's status push

Model: `tla/TabListStatus.tla` (TLC). Properties: `Properties.md`. Code map and assumptions: `CORRESPONDENCE.md`.

## The promise and the harm

Once no TAB_STATUS push and no tab-list answer is on its way to a window, the window shows each tab as main has it.

If it breaks, a tab that turned `ready` shows `starting` for good: its runtime was replaced with an empty one, no second `ready` comes, and the window sits on an empty "New session" screen (`e2e/no-loading.e2e.ts` cold start, about 2 runs in 10 on Windows before the fix; run 44139951807).

Why tests miss it: the list answer (an IPC invoke reply) and the pushes (IPC events) travel on separate routes, so their order at the window is not the order main sent them; a test only sees it when it holds the answer back on purpose.

## In scope

- `reconcileTabs` (`src/renderer/stores/tabs.ts`): the push count it takes before `window.omp.tabs.list()` and the merge that skips a tab pushed since.
- `applyTabStatus`: counting each push.
- Main's side as environment: every change of a tab's state is pushed with the state at send time (`forward_status`), and `tabs_for_window` reads the current state.

## Abstracted

- One tab, its whole projected state as one number that grows with every change (`starting`, `ready`, a session file, ...).
- Up to two (three in the larger run) reconciles in flight at once.
- Viewer fields (`shared`, `viewerCount`) are out: only a tab list carries them, so the merge always takes them from the list.

## Out of scope

- The resync path (`reconcileTabs({resync})`) already refuses to merge when any tab changed during the ask (`cannotReconcile`).
- Ghost adoption: a ghost has its own id and never receives a push.
