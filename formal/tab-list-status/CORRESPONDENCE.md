# Correspondence

| Model action | Code |
|---|---|
| `MainChange` | `native/ompdesk/crates/core/src/pool/listen.rs` `feed_status` (and every other state change) followed by `state.rs` `forward_status`, which sends TAB_STATUS with the entry as it is at send time |
| `Push` | `src/renderer/stores/tabs.ts` `applyTabStatus`: `statusPushes += 1`, `lastStatusPush.set(tab, statusPushes)`, then the projection |
| `Send(r)` | `reconcileTabs`: `const pushesBefore = statusPushes` then `await window.omp.tabs.list()` (one async gap) |
| `Answer(r)` | `windows.rs` `tabs_for_window`: main reads its tabs; the reply travels as the IPC invoke's answer |
| `Apply(r)` | `reconcileTabs` after the await: `pushedSince` = tabs whose last push count is above `pushesBefore`; those keep the pushed tab (only viewer fields from the list), no runtime replacement, no status or failure from the list |

## Assumptions

- **A1** Every change of a tab's projected state is pushed to every window that shows it, and pushes reach a window in the order they were sent (one event route). The mutation `change-without-push` shows the property depends on it.
- **A2** `applyTabStatus` and the merge in `reconcileTabs` are synchronous: nothing interleaves inside either.
- **A3** A push and a list answer may reach the window in either order relative to when main produced them.
