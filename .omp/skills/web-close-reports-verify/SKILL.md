---
name: web-close-reports-verify
description: "Checks that a paired web page's Files-edit reports are kept per live connection and that no agent close releases a tab a settled live page holds unsaved edits in. Use when changing native/ompdesk/crates/core/src/web/file_edits.rs, receive / dispatch / file_edit_report / finish / unless_dirty in native/ompdesk/crates/core/src/web/router.rs, release_entry in native/ompdesk/crates/core/src/pool/windows.rs, native/ompdesk/crates/core/src/agentctl/rules/tab_close.rs, src/renderer/web/FileEditReporter.tsx, close_tab in native/ompdesk/crates/core/src/agentctl/service/sessions/stop.rs, closeWindowTab in src/main/tab-release.ts or src/main/web/file-edit-reports.ts; or when asked whether a phone's unsaved edit can be lost to an agent's close."
---

# Web close reports verification

## The promise and the harm

The core's web router keeps each live connection's latest Files-edit report (`web/file_edits.rs`, keyed by `connId`), an ended connection's report never counts again, and no close path (`tab_close_step` through the core's `close_tab`) decides to release a tab a settled live page holds unsaved edits in, nor lets one go while the store names it dirty. Broken, a person's unsaved edit on a phone is lost when an agent closes the tab, or a dropped page's stale word keeps a finished child open.

## Coverage

| Check id | Tool | Covers | Model |
|---|---|---|---|
| `web-close-reports` | TLC 1.8.0 | `web/file_edits.rs`, the router's `receive`/`dispatch`/`file_edit_report`/`finish`/`unless_dirty`, the pool's `release_entry`, `native/ompdesk/crates/core/src/agentctl/rules/tab_close.rs`, `FileEditReporter.tsx`, `close_tab` (`native/ompdesk/crates/core/src/agentctl/service/sessions/stop.rs`), `closeWindowTab` | `formal/web-close-reports/tla/WebCloseReports.tla`, `@code` tags on each action |

Sync commit: see `syncCommit` of `web-close-reports` in `formal/manifest.json` (the manifest wins).

## Bounds and assumptions

- 2 pages in one window, 2 tabs, 2 connections per page, 3 editor changes, 2 frames in flight per connection: 1.19M states, depth 25, about 30 s.
- Assumptions: the router records a report in the frame's own run under its lock, the same lock `finish` forgets one under (only exactly one `{dirtyTabId}` is a report, `file_edits::parse_report`; pinned by `ws-router.test.ts` "a page's Files-edit report"); frames are FIFO per connection. Full table: `formal/web-close-reports/CORRESPONDENCE.md`.
- Not covered: several devices (every order over two devices is tested in `file_edits.rs`), the person at the tab, the desktop window path, liveness. `formal/web-close-reports/SCOPE.md`.
- `NoLateDirtyRelease` holds because the pool's `release_entry` removes the tab inside `router::unless_dirty`, holding the router's lock while it checks the store and removes the entry (`releaseTab {unlessDirty}`, passed by `closeWindowTab` for an agent's release). The `split-release` mutation puts a check in main before a separate removal back and must be caught.

## Run it

`<tools-dir>` is the folder of the SKILL.md you see when you read `skill://ompdesk-formal-verify`.

```bash
bun <tools-dir>/scripts/verify-all.ts formal --only web-close-reports
```

About a minute and a half (3 runs, 9 mutations). `PASS` (exit 0): no counterexample within the bounds, not "the code is correct". `FAIL` (exit 1): a property broke, a mutation was MISSED or an `@code` tag no longer resolves. `DRIFT:`: covered code changed since the sync commit. `NOT CHECKED` (exit 3): report "not checked", never a pass.

## A failure: real bug or modeling error?

Replay the trace against the code with each row's `@code` location. A step the code cannot take is a model error: fix the model and say so. Every step possible is a bug: tell it in the code's words and pin it with a failing test first (`file-edit-reports.test.ts` exhaustive orders, `ws-router.test.ts`, `service.test.ts` "every close path follows tabCloseStep"). Never weaken a property, add a constraint or fairness to make it pass.

## Updating it for an intended change

Change the model from the code first (keep one step per synchronous run; a new `await` splits a step), change a property only when the promise changed on purpose (old wording, new wording, evidence in `Properties.md`), add a mutation for each new guard, rerun, then move the sync commit with `verify-all.ts formal --only web-close-reports --stamp` after committing.
