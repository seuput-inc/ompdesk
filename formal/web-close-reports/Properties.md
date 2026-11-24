# Properties (frozen)

Definitions live between the banners in `tla/WebCloseReports.tla`.

| Property | Statement | Source |
|---|---|---|
| `StoreOnlyLive` | Only a live connection holds a report; an ended one never counts again. | `file_edits.rs` doc (was `file-edit-reports.ts`); fb2f902 ("forget a paired page's Files-edit report when its last connection drops"); `.omp/rules/control-tools.md` "Unsaved Files edits stay protected" |
| `QuiescentAgreement` | A live, greeted connection with nothing in flight holds exactly its page's editor state: no other connection's report or drop changed it. | 09f8b6af ("keep Files-edit reports per connection"); `.omp/rules/multi-viewer-web.md` "a device's up to four connections share one window" |
| `NoLateDirtyRelease` | A release never lets a tab go while the store names it dirty (a report that landed during the release's awaits, or between its last check and the removal). | the review of this unit (29 Oct 2026); `tab-release.ts` `stillClosable`; C2 (24 Nov 2026) |
| `NoReleaseOfKnownDirty` | A close never decides to release a tab a settled live page holds unsaved edits in. | b2c22f84, 0f9382b8; `.omp/rules/control-tools.md` "Only `dirty` keeps the tab" |

Sanity (must be violated): `NeverReleases`, `NeverRefuses`.

Wording change, C2 (24 Nov 2026): `NoLateDirtyRelease` said "main's store"; it says "the store" since the store moved to the core's web router (`file_edits.rs`). The promise is the same; its statement now also names the gap between the last check and the removal, which the `split-release` mutation reopens.
