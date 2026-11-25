# Scope: paired page Files-edit reports and an agent's close

## The promise

The core's web router keeps, per live connection of a paired web page, that connection's latest report of the tab whose Files editor holds unsaved edits; an ended connection's report never counts again; and an agent's close (`ompdesk_session_stop {close}`, auto-close, a failed open's cleanup, Autopilot's source tab) never decides to release a tab a settled live page holds unsaved edits in, nor lets one go while the store names it dirty.

## The harm

A released tab closes its Files editor with the person's unsaved edits in it, or (the other way) a dropped page's stale "dirty" keeps a finished child open forever. This area regressed five times (eb63a456, fb2f902, b2c22f84, 0f9382b8, 09f8b6af): per-window reports, forgetting the whole window on one drop, a stale report outliving its connection.

## Why tests miss it

The bugs live in orders: a reload overlapping its predecessor, a drop between a frame's read and its handling, a reconnect's open report racing an edit. Unit tests pick a few orders; the model checks all of them within the bounds.

## Bounds

2 pages sharing one window, 2 tabs, 2 connections per page (one reconnect each), at most 3 editor changes, at most 2 report frames in flight per connection; any interleaving. About 1.2M distinct states, depth 25, about 30 s (`MC.cfg`; the run's own count is in `evidence/`).

## In the model

`FileEditReporter` (send on change and on `open`), the router's attach, receive and finish (`file_edits.rs` `report` and `forget` under its lock), `edits`, `tab_close_step`, the core's `close_tab` decision and the release after its awaits, whose last check and removal run under the router's lock (`release_entry` inside `unless_dirty`).

## Not in the model

- Several windows (devices): the store keys reports by connection and filters by device; device isolation is pinned by `file_edits.rs` (every order of up to 5 events over 3 connections of 2 devices).
- `looked` / `userTouched` (the person at the tab), the desktop window path (`ask-window`), the close note, `#whenGone`.
- An unpair: it ends every connection of the device (`closeDevice`) before the window goes, which is the model's `Drop` per connection.
- The page side's own transport: a send while the page is not `open` is lost; the model sends only from a greeted connection and resends on `open`.
- Liveness (that a close eventually happens): safety only.
