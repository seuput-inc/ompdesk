# Frozen properties

- **P1 QuietAgrees** (protocol level): when no push and no list answer is in flight, the window's view of the tab equals main's state. Source: the TAB_STATUS contract in `IpcTabInfo` (`src/shared/ipc-types.ts`) and the no-loading rule that a new session is usable once its omp is ready (`.omp/rules/no-loading-screens.md`, "A new session is usable before its omp is ready").

Sanity (must fail): `NoLateAnswer`, an answer lands after a push of its tab.
