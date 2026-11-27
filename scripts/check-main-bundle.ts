/**
 * Guards for the packaged app's launch, run after `electron-vite build`:
 * - every bare specifier the main bundle still imports at runtime has to exist
 *   inside the .app. In this nested checkout bun hoists most packages to the
 *   monorepo root, so electron-builder's node_modules traversal misses them and
 *   the installed app dies with ERR_MODULE_NOT_FOUND before the window appears.
 *   The bundle is minified, so its imports are read by a parser, not a line regex.
 * - no bundled package reaches an optional peer dependency that is not installed.
 *   Vite resolves such a `require` (ws's `bufferutil`, `utf-8-validate`) to an empty
 *   object instead of a require that throws, so the package's `try { require(…) }`
 *   fallback never runs and it calls methods the object lacks: v0.34.0 crashed main
 *   on a paired phone's first WebSocket frame (`bufferUtil.unmask is not a function`).
 *   Every such stub is refused, and the bundled `ws` must carry a real round trip of
 *   masked frames: `scripts/ws-bundle-probe.ts` is bundled with the main process's
 *   own Vite config and run in Node.
 * - axe-core (the e2e accessibility audit's engine, a devDependency) never ships
 *   in the renderer, and neither does lit: `@a2ui/web_core` depends on it for its
 *   own custom elements, which OMPdesk's A2UI views do not use; its
 *   `"sideEffects": false` lets the bundler drop them (docs/design/a2ui.md §2).
 * - the renderer ships no .woff or .ttf font: Electron's Chromium always takes the
 *   .woff2, and the renderer's `woff2OnlyFonts` plugin drops the older fallbacks.
 * - the JavaScript a paired phone loads before its first screen (`web.html`'s entry,
 *   the app it imports, `../main`, and their static imports) stays within
 *   WEB_FIRST_SCREEN_JS_BYTES; the side panel's views (PanelViews.tsx) are never in
 *   it. e2e/web-perf.e2e.ts measures what that costs a phone.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { builtinModules } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_LIST_META } from "../src/renderer/web/session-list-preload";

// `URL.pathname` keeps a leading slash on Windows (`/E:/…`), which no API opens.
const BUNDLE = fileURLToPath(new URL("../out/main/index.js", import.meta.url));
const RENDERER = fileURLToPath(new URL("../out/renderer/", import.meta.url));
const RENDERER_ASSETS = fileURLToPath(new URL("../out/renderer/assets/", import.meta.url));
const WS_PROBE_CONFIG = fileURLToPath(new URL("./ws-bundle-probe.config.ts", import.meta.url));
/** Vite's stand-in for a missing optional peer dependency: `__viteOptionalPeerDep_<dep>_<importer>`. */
const OPTIONAL_PEER_STUB = /__viteOptionalPeerDep_\w+/g;
/** A property name only axe-core's source carries; it survives minification. */
const AXE_MARKER = "_thisWillBeDeletedDoNotUse";
/** The globals lit's three packages register their versions under; they survive minification. */
const LIT_MARKERS = ["litHtmlVersions", "litElementVersions", "reactiveElementVersions"];
/**
 * The phone's first-screen JavaScript, raw bytes (18 Oct 2026: 4.17 MB, 3.79 MB once the side panel's views went
 * lazy, 3.10 MB once each UI language became its own lazy chunk, 3.255 MB with the remembered sidebar state: the
 * fold stores and their saved-state parsing, 5 KB; 19 Oct 2026: 3.271 MB with the sidebar rows of the sessions
 * paired devices run on the host, 2.7 KB; 3.278 MB (3,278,281) with the family rows of the sessions this computer's
 * agents opened on a paired device, 3.4 KB; 20 Oct 2026: 3.281 MB (3,281,057) with a phone's work strip counting the
 * sessions a viewed session's agent opened, a notification click that waits for its tab and the touch session
 * sheet's order, 2.3 KB; 3.285 MB (3,284,838) with the transcript's waiting lines for the reports a bridge holds until
 * the running turn ends, 3.8 KB; 3.289 MB (3,289,072) with stock's "Ask and remember" approval: its remembering
 * answers on the approval card (`approvalChoices`) and the mode in the composer's approval row; 3.292 MB (3,292,441)
 * with the work board's strip wherever the board cannot dock (`workBoardForm`, `workBoardWidth`), its capped
 * sections (`CappedRows`) and the `checkout_peers` frame in the session store (the session rows themselves are a
 * lazy chunk), 3.4 KB; 3.294 MB (3,293,964) with the composer's one Send/Stop button (its state rule and the
 * long-press Stop menu that keeps the draft) and the model chip's short name and plain Auto, 1.5 KB; 3.295 MB
 * (3,295,059, the merged main) with the drawer's edge strip handing a tap to the control under it (`tapThrough` in
 * SidebarDrawer.tsx: the strip is on the first screen, so its tap must be), 0.8 KB; 3.297 MB (3,297,321 on the
 * merged main, 3,295,148 before) with the transcript holding a scrolled-up reader's row while a commit's changed rows
 * are measured (`contentAnchor`, ChatStream.tsx), 2.2 KB; 3.299 MB (3,298,084, 3,297,610 on main before) with a
 * paired host's sidebar rows and focused tab taking that host's own Chat/Code lane (`useHostWorkspace`, both lists
 * are on the first screen), 0.5 KB; 3.300 MB (3,299,739 on the merged main) with the composer asking the automatic
 * mode choice's question while the user types (`useAutoModePrefetch`, `prefetchAutoMode`; the web page skips it, but
 * the composer is the first screen), 0.7 KB; 3.301 MB (3,300,809, 3,299,739 before) with the disconnect notice's grace
 * (`useHostLinkLost` in stores/remote.ts and `connection-banner.ts`: the phone's bar is on the first screen and the
 * pane's banner is in the shared app chunk), 1.1 KB; 3.301 MB (3,301,397, 3,300,809 before) with a stored session's
 * gone folder: `openTab`'s folder-missing toast and its Restore re-open, and the session picker's gone mark that opens
 * such a row as a tab, 0.6 KB; 3.302 MB (3,302,253 on the merged main) with a pick of another folder's session opening
 * as its own tab instead of stock's refused in-place switch (`opensInOwnTab` in use-session-switch.ts, which the
 * sidebar and picker share), 0.9 KB; 3.311 MB (3,310,352 on the merged main of v0.49.0; 6.6 KB over the 3.303 MB
 * budget on its own base) with the sidebar's own project list: an empty or missing project's group, Remove from
 * sidebar on this device's and each host's section, the list's store and its parse (`stores/sidebar-projects.ts`,
 * `shared/sidebar-projects.ts`; the sidebar is the first screen)): a build that grows past it fails,
 * so the next eager import is a decision, not an accident. The language chunk the entries load before rendering is
 * not in it.
 */
// R3-4 intent rows add 7,595 bytes to the eager main chunk (trunk 9d1a7d055 3,303,582 → 3,311,177).
// R3-3's same-call verdict (the work card's settle and step list, the board's newest-turn check) adds 7,234 bytes over
// its base (main 7dfaf5a13 3,315,869 → 3,323,103).
// R3-1's one attention rule (lib/attention.ts, the per-tab failed-check store, the title bar's and the sidebar row's
// kinds) adds 1,656 bytes over its base (main 23cc62bd1 3,323,103 → 3,324,759).
// R3-6's strip summary (the per-open zone state and fold snapshot in WorkBoardChip, SummaryBoard and the summary line
// in board-parts.tsx, the sessions-opened chunk's preload) adds 3,155 bytes over its base (main 5c542e92b 3,324,759 →
// 3,327,914); the session rows' chunk stays off the first screen.
// The phone page's Files-edit report (web/FileEditReporter.tsx: which tab's editor holds unsaved edits, so the computer
// never closes it for an agent) adds 720 bytes over its base (main ad86fb309 3,327,914 → 3,328,634).
// The memory recall line's rows (`MemoryRecallNote` in CustomMessageCard.tsx: kind, title, date, excerpt, Open in Memory,
// Not helpful, and `parseRecallText` with its kind table in memory-recall-contracts.ts; the transcript is the first
// screen) add 6,002 bytes over its base (3,328,634 → 3,334,636).
// The recall line's per-item scope, its remembered Not helpful (`lib/recall-rated.ts`), and the page's own grants from
// the hello frame (`pageMayUse`, so a page without host-admin hides the action) add 3,601 bytes (3,334,636 → 3,338,237).
// 26 Oct 2026: every window hears what this computer works on now (`sessions.live`, `onLiveSessionsChanged`, the
// store's `live` list and the sidebar's read of it) so a row another window works on lights unopened: 620 bytes over
// the old budget (measured 3,339,620).
// omp's advisor notices read in the UI's language (`lib/notice-toast.ts`: its rule table and two shapes): 312 bytes
// more (measured 3,340,312).
// The agents' default browser (`sessions`/`prefs` API members, the relay-extension install action and the bridge
// feature label; the Settings row itself is lazy): 301 bytes more (measured 3,340,613).
// The transcript's scroll writer that tells the virtualizer the offset it wrote and remembers it (`transcriptScrollTo`,
// `readerMoved`, `compensateRowsAbove`), so a fling is never pulled back: 1,056 bytes more (measured 3,341,756).
// The work card names what the run leaned on (27 Oct 2026, the user's ask): the skills it read (`WorkOutcomes.skills`)
// and the files a live peer in the same worktree also changed (`open-peer.ts`, kept out of the board's lazy rows), with
// an `ls` of a missing path read as an answer: 2,965 bytes more (measured 3,344,721).
// A listing counts as a missing-path answer only when every `ls:` complaint it printed says so: 252 bytes more
// (measured 3,344,973).
// Round 2 of the card's facts (27 Oct 2026): skills from every source, the Protected chip and the held-back row, a
// check rerun inside a wider run resolving it (`coveredBy`), probes through read-only pipes and loopback curl; the
// failed-check attention it replaced is gone: 4,289 bytes more (measured 3,349,289).
// The card's verdicts on real journals (background jobs keyed by the call that opened them, mixed and setup-led checks,
// stops and restarts), revived subagents' resuming lane, a remote host's working rows under asleep tabs and session
// drag reordering in the sidebar (27 Oct 2026, one batch): 11,595 bytes more (measured 3,360,884).
// The dialogs only the person opens (OnDemandDialogs.tsx: the command palette, model and session pickers, rename,
// worktree, quick open, tab overview, branch picker, voice, copy, active tools, share, force tool, handoff) and the
// first-run setup's provider steps (FirstRunSlot.tsx) left the first screen (28 Oct 2026): 165,380 bytes less
// (measured 3,195,504 against 3,360,884 on the same main).
// Streaming restyle (28 Oct 2026): the shell, the session pane and the side panel's sheet carry marks the stylesheet
// reads instead of `:has()` (AppShell `data-panel`, WorkBoardChip `data-work-board-strip`, Sheet `data-sheet-kind`)
// and `checkKinds` answers a command once: 554 bytes more (measured 3,361,438 against 3,360,884 on the same main).
// The on-demand dialogs retry a failed load at the next touch or key and load at the first idle moment
// (lib/deferred-chunk.ts), and the first-run slot draws a still skeleton while its setup loads (28 Oct 2026): 1,382
// bytes more (measured 3,197,482).
// A paired host's section folds the closed sessions its agents opened that the host knows no opener of, as the host
// does (`foldsIntoProject`, its loose children), and its list keeps no row whose listing changed while its journal
// did not (`sameRow`; 28 Oct 2026): 1,446 bytes more (measured 3,198,928).
// Agent powers on by default and the new agent app actions (sidebar projects, pins, order, updates, privacy panes)
// in the shared app-action client (`lib/agent-app.ts`; 29 Oct 2026): 983 bytes more (measured 3,199,911).
// A tab's subagent transcripts held and read on by byte cursor, shared by the lanes', work cards' and Subagent view's
// reads, and no read while the window is hidden (`stores/subagent-transcripts.ts`, `whenVisible`; 29 Oct 2026: a
// paired device re-read whole journals, 11.5 MB in a minute): 1,513 bytes more (measured 3,201,424).
// The working cue says a request the model has not answered for 30 s as that wait (`lib/model-wait.ts`, the turn
// meter's `modelWaitSince` from the bridge's `model_request`; the work card's head, the board row and the strip; 29 Oct
// 2026, turns sat on "Thinking…" for minutes on a broken connection): measured 3,202,448 with the other changes of
// 29 Oct in the tree, 1,024 bytes over the measure above.
// A finished worktree's session listed only for a tab the person uses (`tabInUse`, `inUseByTab` in the host's sidebar
// and the device section; 29 Oct 2026: a device's restored asleep tabs listed two landed worktrees' sessions):
// measured 3,203,418 with the other changes of 29 Oct in the tree, 970 bytes over the measure above.
// A finished child with unmerged work is its own status, ready to merge, apart from a failed ending (`unmerged` in
// `sidebar-family.ts`, the `GitMerge` token and its words in the sidebar family row and the work board's child row; 29
// Oct 2026: it read as a failure): 1,155 bytes more (measured 3,204,573).
// The UI polish pass of 30 Oct 2026 (shorter wording in both languages, sidebar rows that keep their titles, toasts
// and What's new laid out in the flow, the palette's group icons, the phone composer's model chip): measured
// 3,206,471, 1,898 bytes over the measure above. The phone judge's follow-up (toasts under the work strip, a touch
// sheet's focus on its panel, the disabled primary button, the ask card's header once; others' edits to the same
// bundle in the tree: the composer, the palette): measured 3,207,596.
// One session menu for every device's rows (`session-menu.ts`; 30 Oct 2026): a paired host's rows now rename, pin,
// archive, move to a project and open in a split or window, with their own Archived section: measured 3,213,335,
// 5,739 bytes over the measure above.
// The working cues step at ten frames a second while the window is unfocused (`lib/cue-clock.ts`, loaded after the
// first screen by one dynamic import in main.tsx; 30 Oct 2026): measured 3,214,065 on c7f5901ab, 730 bytes more.
// The window pollers (30 Oct 2026): ToastStack measures on observers instead of a 250 ms timer, the jobs poll follows
// its tab's turn and subagents: measured 3,216,397 on d2f2af50f (this check's own count), 1,397 bytes over the budget.
// The session list read once per change and shared (30 Oct 2026): the global feed keeps main's numbered copy and
// applies what each change carries (`stores/session-list.ts`, `shared/session-list-delta.ts`, `sessions.listShared`)
// instead of reading the whole list after every change: measured 3,218,041, 1,278 bytes over its parent 51f0e312f
// (3,216,763).
// A click then a modifier pressed alone shows no focus style (`lib/focus-modality.ts`, loaded after the first screen by
// one dynamic import in main.tsx; 31 Oct 2026): 1,548 bytes (its 1,346-byte chunk and the 202-byte import), measured
// 3,220,084 with the other changes of 31 Oct in the tree.
// A retry saga rides the tab status (`retrySaga`; 31 Oct 2026): the tabs store and session hydration, both on the first
// screen, put stock's open retry on a tab shown after it started, so its failed attempt shows no failure card: measured
// 3,220,084 with it and the other changes of 31 Oct in the tree.
// The email trigger (1 Nov 2026): the `email` event in the schedule schema the desk store reads, its summary line and
// the Email accounts strings; the accounts block itself stays in the lazy Settings chunk: measured 3,252,153, 1,487
// bytes over the measure above.
// A failed pipeline named after its last stage (1 Nov 2026): `pipelineProgram`, the `pipefail` test and
// `firstStageProgram` in command-verdict-core.ts, which the work card reads: measured 3,257,009, 579 bytes over the
// tree before it (3,256,430).
// A host's browser sign-in coming back through this computer (1 Nov 2026): the `signInRelay` state in the extension-UI
// store every tab reads, its `SIGN_IN_RELAY` subscription and the API member; the panel stays in the lazy Settings
// chunk: measured 3,257,562, 553 bytes over the measure above.
// A typed session name shown with its automatic title (2 Nov 2026): the shared `SessionTitle` (name, muted automatic
// title truncated first), the parts helpers in `lib/session-title.ts` and the tabs store, and the tab-to-row lookup
// (`hooks/use-tab-list-rows.ts`) the title bar, panes and sidebar rows draw on the first screen: measured 3,261,772,
// 4,210 bytes over the measure above.
// Published palettes kept as published (2 Nov 2026): each well-known theme's own bright ANSI row, text selection and
// diff washes in theme-palettes.ts (the per-role source colors stay in the test-only theme-sources.ts): measured
// 3,262,745, 719 bytes over the same tree with the palettes before (3,262,026).
// A subagent the restart ended reads as interrupted, not failed (2 Nov 2026): `restartCuts`/`cutRunAgents` in
// `chat/work/work-run.ts`, the transcript hook (`use-restart-cuts.ts`) the async-result card and the work lanes read, and
// the new strings: measured 3,267,056, 4,311 bytes over the measure above.
// The same rule on every surface (2 Nov 2026): `lib/restart-cuts.ts` (moved out of the work card), the tab runtime's
// binding of the transcript to the subagents store, the `restart-cut` status and its strings: measured 3,269,220,
// 2,164 bytes over the measure above.
// A lost link shown in the title bar, not over it (2 Nov 2026): the bar's `offline` status (its WifiOff glyph and
// `web/link-status.ts`) on the session and page bars, and the transport's liveness question and attempt deadlines; the
// full-width `connection-banner.ts` is gone: measured 3,270,423, 1,203 bytes over the measure above.
// New agent work waits for memory (2 Nov 2026): the tab's `memoryWait` in the tabs store, tab signal, sidebar and
// device rows, the work board's child line and the chat pane's waiting row with Start now (`MemoryWaitRow`, its
// MemoryStick glyph) and `window.omp.memory`: measured 3,273,813, 3,390 bytes over the measure above.
// A family row says it waits for memory in words, with Start now (`FamilyRow` `memoryWait`, status `queued`):
// measured 3,275,138, 1,325 bytes over the measure above.
// What a person sends while the computer is out of reach waits (2 Nov 2026): the outbox store and its delivery
// (`stores/outbox.ts`, `lib/outbox-delivery.ts`), the composer's "Will send when connected" row (`ComposerOutbox`, its
// glyphs) and the strings. It stays in the first screen: a page reloaded offline must show and send what waits
// without fetching a chunk: measured 3,288,191, 13,053 bytes over the measure above.
// The restart-cut mark keyed to the run it cut (the subagents store's `run` count and `deliveredBy`) and the automatic
// install's waiting notice (the sidebar card's waiting row, `waitingWhat`, the phone sheet's line naming the work and the
// new strings) (2 Nov 2026): measured 3,278,050 on the tree before the outbox, 2,912 bytes over its own base.
// Composer dictation shows the download of its language's speech model (3 Nov 2026): the dictation bar's preparing
// line and its `ProgressBar`, the take's `onPreparing` and the strings; the prepare loop itself loads with the
// `stt-prepare` module on the take's first wait: measured 3,310,945, 1,597 bytes over the budget above. The take's
// `onPreparing(null)` once the model is here, so the bar says "Transcribing…" again (3 Nov 2026): measured 3,310,970.
// Local names shortened in the renderer (3 Nov 2026): its esbuild minify pass went from `minifyIdentifiers: false` to
// `keepNames: true` (electron.vite.config.ts), so locals and parameters read short while every function and class keeps
// its `name` for stacks and React's component stacks; main and preload keep their names. The phone parses ~29% less
// before its first frame (14 files, 3,310,970 → 2,349,974, 960,996 bytes less; brotli on the wire 674,087 → 615,573):
// measured 2,349,974.
// The session list is one chunk of its own (3 Nov 2026, components/layout/sidebar-chunk.ts, the `session-list` manual
// chunk in electron.vite.config.ts): a phone keeps it in a closed drawer. This budget counts the static closure, which is
// what a later visit (a page the service worker controls) loads before its first frame; the list loads after it, from
// the worker's cache. A first visit (no worker yet) and a page that docks the list also wait for the list's one file,
// checked below and printed with the total. Sidebar.tsx, its device sections, subagents and update card, the icons only
// it draws and dnd-kit leave the static closure, sidebar.css stays (14 files 2,349,974 → 13 files 2,155,282; brotli
// 615,171 → 567,205; the list's file 197,360, brotli 53,932): measured 2,155,282.
// Markdown keeps a single `~` as text (3 Nov 2026, remark-gfm `singleTilde: false` in lib/markdown.tsx), so two Korean
// ranges like `170~230초` on one line no longer strike everything between them: measured 2,155,315.
// The Windows caption band (4 Nov 2026, global.css `--sc-caption-band`, components.css `--sc-dialog-room`, and
// `chromePlatform` keeping a mark the page set): measured 2,155,355. The same day: the cue clock holding the loops
// under software compositing, a failed history page's pill and its retry on `ready`, its runtime-log line: 2,155,734.
// A tail read's runtime-log line with its response code (session-hydration.ts `transcript-tail`): 2,155,854.
// Local inference engine detection (4 Nov 2026): the `models-config:changed` event and its focused-tab catalog re-read
// (use-rpc-events.ts), the `localEngines` get/set of the API (a paired host has its own switch) and the Custom
// endpoints switch's two strings in the English catalog: measured 2,156,302, 448 bytes over the budget above.
// A reply's paragraph of pictures as one captioned figure row (5 Nov 2026, markdown.tsx `FigureRow`, `useImageReads`;
// replies are the first screen): measured 2,157,926, 1,624 bytes over the budget above.
// A paragraph holding a player or a document card renders as a block of its own (`rendersAsBlock`): 2,158,239.
// What a reply writes beside its tool calls stays a row of its own under its work card (6 Nov 2026,
// chat-stream-utils.ts `buildHistoryRows` narration, `liveWorkTail`; the transcript is the first screen): 2,158,572.
// agent-desktop as the default computer use (6 Nov 2026): its tool rows' header and summary (`agent-desktop-name.ts`),
// the fallback note (`ComputerUseNote.tsx`) and their strings in the English catalog; the renderer and its result
// parser are a chunk of their own (tools/index.tsx `LazyAgentDesktopRenderer`, 5,255 bytes kept out): 2,160,895.
// An agent-desktop row's own state (6 Nov 2026, ToolCard `isAgentDesktopNoMatch`, "Nothing matched": a look that matched
// nothing reads so on the row of the transcript, the first screen) and its target key naming `ref` as `ref_id`: 2,161,237.
// The macOS permissions computer use needs (6 Nov 2026): the matcher for stock's "… permission is not granted"
// (`lib/mac-permission-error.ts`, the eager `ComputerRenderer`/`EvalRenderer` ask it), their strings in the English
// catalog and the lazy fix's wrapper; the fix itself is a chunk of its own (`LazyMacPermissionFix`): 2,162,145.
// A row hears its session's subagents while no window shows it (6 Nov 2026, use-rpc-events.ts `openTabFrame`; a hidden
// running tab a tab list makes a runtime for reads its roster once, tabs.ts `reconcileTabs`): 2,162,311.
// The same read once per runtime whichever names a hidden running tab first, its status push or the tab list
// (`rosterRead`), and stock 18.17's two Devin sign-ins with the Devin mark (provider-marks.ts): 2,162,456.
// A work card is red only when the work ended in an error (6 Nov 2026): each card's failures judged in its turn
// (chat-stream-utils.ts `workTurns`, `useTurnScope`, work-findings.ts `turnScope`, work-checks.ts `TurnScope`), the
// "Errors along the way" note and its strings in the English catalog; the work card is the first screen: 2,166,852.
// A hidden tab's roster read again when its pushes may have been lost (7 Nov 2026, tabs.ts: a page's catch-up after it
// was hidden or lost its link, `reconcileTabs({resync})`; a hidden tab's omp up again, `useSessionTabs`): 2,167,109.
// A paired host's refusal of a tab another tab holds shows that tab or says where it is open, and every tab's banner
// reads its failure's reason from the tab list (7 Nov 2026, tabs.ts `applyTabList` `shown`, `applyTabFailure`, no
// switch-failure toast for a tab main let go; the visible-only route in use-rpc-events.ts went): 2,167,482.
// A tab main closed while the window still routed to it leaves quietly, with no switch-failure toast, when main's list
// no longer names it (8 Nov 2026, tabs.ts `focusTab`: a paired host's refusal answered before its tab list): 2,167,699.
// One summary per session, built in main, the only source of every row's live state (8 Nov 2026: hosted-sessions.ts
// holds each computer's summaries at a version and applies deltas, `summaryRowState`; the per-view re-reads deleted),
// and a project's one menu builder and Delete dialog (project-menu.ts, ProjectDeleteDialog.tsx), on top of v0.118.7's
// banner reason, whose failure rule is now shared with the summaries (`failureOf`), and a tab with no session file
// read from its own summary (`unsavedSessionKey`, `hostedSummaries`), on top of v0.118.8's quiet close: 2,168,705.
// Every other surface that says what a session does reads that summary by the row's rule (8 Nov 2026,
// lib/session-run.ts `sessionRun`, hooks/use-tab-run.ts: the title bar and the window title are the first screen;
// their own derivations from the runtime stores went): 2,169,204.
// A page behind the build its host serves moves to it at its next unused moment (8 Nov 2026, web-boot.ts
// `hello.build` against the page's `omp-build` meta; the `web-reload` line names both builds, noted at the reload),
// less the per-view summary reads (`ensureHostSummaries`) the one boot read replaced: 2,169,501.
// The move recorded only as the page reloads, one at a time (8 Nov 2026, sw-update.ts `HostBuildMove`): 2,169,691.
// A session whose folder is gone wears "Folder missing" on its row and opens read-only (8 Nov 2026,
// `SidebarRows.folderMissing`, `SidebarFolderMissingMark`, the `missingFolder` request and its lazy sheet's host),
// and a child opened in another folder is a row of its own project too (`openedElsewhere`): 2,170,453.
// Every model list beside a provider's mark reads its compact name, a suffix only where two would read alike (8 Nov
// 2026, provider-marks.ts `compactModelLabels`; the composer's model picker is on the first screen): 2,171,893.
// The model "Find more evidence" researches with is picked beside it and kept on the machine it runs on (8 Nov 2026,
// ModelSetupDialog.tsx; its strings in the English catalog and omp-api.ts `modelSetup.researchPick|setResearchPick`
// with their two channels reach the first screen): 2,172,134.
// The remaining long model names read the same compact label (8 Nov 2026, provider-marks.ts `compactModelText`,
// `modelRefOf`, `modelTextAmong`, `ModelLabel`; the usage row under a reply is on the first screen): 2,173,209.
// Every model list groups its models by provider (9 Nov 2026, provider-marks.ts `groupModelsByProvider`; the composer's
// model picker is on the first screen): 2,173,524.
// The sidebar prefs have one owner, main (9 Nov 2026, src/shared/sidebar-prefs.ts `sidebarPatch` and `readSidebarPrefs`
// the store applies at once, omp-api.ts `prefs.updateSidebar` and its channel, the store's re-read on PREFS_CHANGED;
// its whole-blob writer went), and a sidebar pick's runtime-log line: 2,174,377.
// A family child's review verdict by its computer and session file (9 Nov 2026, sidebar-family.ts `reviewKey`, read by
// the eager family rule): 2,174,446.
// The split the window shows, one rule for the workspace and the sidebar's selected rows (9 Nov 2026,
// hooks/use-shown-split.ts): 2,174,534.
// An omp slow to start reads as a wait on its tab's banner (9 Nov 2026, SidecarBanner's slow title, text and stderr
// tail, the session store's `sidecarSlow`, `applyTabFailure`'s slow branch; the banner is the first screen): 2,174,908.
// A start that waits its turn reads "Waiting to start" (9 Nov 2026, tab-signal.ts `queued`, the tab's projection of
// it, use-rpc-events keeping the page through a queued re-send, session-run.ts passing the summary's `queued`):
// 2,175,035.
// A session row holds its family chip's slot only while the chip draws (9 Nov 2026, sidebar-family.ts
// `familyChipCounts`/`hasFamilyChip`, read with the family hide state by both session lists): 2,175,243.
// The usage row under a reply stays one line, dropping its least useful segments as it narrows (9 Nov 2026,
// UsageRow.tsx `DROP`, every value named in its tooltip; the transcript is the first screen): 2,176,219.
// The answer to a steer reads right under it, above the card of its calls, streaming as finalized (10 Nov 2026,
// chat-stream-utils.ts `endsOnSteer`, ChatStream.tsx `ProcessGroup` `answerFirst`; the transcript is the first
// screen): 2,176,541.
// The design pass over every menu and the kit's new parts (10 Nov 2026): a dialog's first focus on its first field
// (`use-modal-layer.ts`), `StatusDot` and the segmented `ProgressBar`, the question card titled by its question, the
// plan sheet's review footer and numbering, the composer's Mode rows as tiles, the pickers' `EmptyState`s and the
// work tree rows' fixed columns, all on surfaces the first screen holds: 2,184,833, 8,292 bytes over the measure above.
// The first screen's private dots, frames, notices and labels moved onto the kit, whose `Tabs` carries a tab's marks
// and tooltip and whose `Banner`, `Sheet`, `ListRow` and menu items took the options their private copies had
// (10 Nov 2026): 2,185,228, 395 bytes more.
// The last private controls moved onto the kit and what sat only in a native `title` became reachable (11 Nov 2026):
// `Chip` (composer attachments, outbox and queue), the kit `ChoiceList` (prompt cards), `KeyHints` (the model picker),
// `Tabs` with closable tabs and a kit tooltip, menu items' tooltip and reason, `Button`/`IconButton` `disabledReason`,
// `ListRow` tooltip and small size, `Card as`, a todo's state as a shape (`TodoStatusIcon`), a repeated minute's
// clock shown on hover (`repeatedClockRows`), the run section's in-view rule (`runSectionShown`), a table cell's text
// length, a file card's `data-file-path`, the model picker's line for the highlighted model, a menu's reason reachable
// by the arrows and segments that shrink to fit their track, all on surfaces the first screen holds: 2,197,597,
// 12,369 bytes more (0.6 %).
// A reset pass dialog's choice between an account's kinds of pass (11 Nov 2026): its two strings in the English
// catalog, which the first screen loads; the dialog itself is Settings', off it: 2,197,603.
// A message between sessions carries its sender's saved id (12 Nov 2026, `shared/agent-control.ts`: the wrapper's
// pattern reads the `session` attribute and `parseAgentMessage` returns it; the transcript, which shows such a message
// as "sent by an agent", is the first screen): measured 2,197,692 on c47f87fc by ci.yml's build, 89 bytes over.
// Fallback models in Settings › Models & accounts (12 Nov 2026): their strings in the English catalog, which the first
// screen loads (the block itself is Settings', off it), less the Agent row they replace: measured 2,197,738 on the
// working tree beside other uncommitted Settings strings, 46 bytes over.
// The Fable limit in the chat's work status (12 Nov 2026, `lib/usage-windows.ts` `accountWindows` with the session's
// model, `UsageGauges` and its tooltip; the work board's meter row is the first screen): measured 2,198,011 on c5803493
// by ci.yml's build, 273 bytes over.
// omp 18.19.0's Liquid AI provider mark (12 Nov 2026, `provider-marks.ts`: the composer's model chip draws a provider's
// mark, so the table of marks is the first screen) and the two strings of a ChatGPT account's unlimited credits in the
// English catalog: measured 2,198,582 on c5d23902 by ci.yml's build, 571 bytes over.
// A fallback that stands in for the chosen model (12 Nov 2026: the composer's model chip keeps the chosen model and
// marks the stand-in, `stores/model.ts` `chosenModelOf`, two strings) and the credit use switch's strings in the
// English catalog (the row itself is Settings', off the first screen): measured 2,199,241 on the working tree,
// 659 bytes over.
// A todo reminder turn that only repeats the answer above folds under it (13 Nov 2026: `foldRepeatedAnswers` and
// `repeated-answer.ts` in the transcript, `FoldedReminders`, two strings, plus the health label of the bridge feature
// that keeps the reminder from waking a waiting session, all in the English catalog): measured 2,199,378 on
// cb261f72 by ci.yml's build before the label (about 110 bytes), 137 bytes over; the budget takes both.
// The sidebar's usage block lists every account grouped by provider and draws Settings' `ConnectedRow`/`AccountQuota`
// per account (13 Nov 2026, bc9bf3afd, 0ace6eefa, e00a31068: `SidebarUsage.tsx`, `lib/usage-reports.ts`,
// `lib/usage-rotation.ts`; the sidebar is the phone's first screen and `Sidebar.tsx` imports the block statically):
// measured 2,200,805 on main (196695ef), 1,305 bytes over.
// The markdown chunk gains `remark-dollar-math.ts` (13 Nov 2026: prices stay text, Pandoc's rule on single-dollar math;
// the phone's first screen renders replies with it): measured 2,201,852 by the runner's build of the branch, 902
// bytes over.
// The sidebar usage block's grouping (`usageAccountGroups`, about 630 bytes) moved out of `lib/usage-reports.ts`, which
// the first screen loads, into `sidebar/usage-groups.ts`, which only the session list's chunk imports: measured
// 2,201,221 by the runner's build (13 Nov 2026, branch run 43449213441), 631 bytes under the budget above. The budget is
// that measure plus 79 bytes, so the next change that grows the first screen has to say so here. Run 43487947733 on the
// branch merged with main (14 Nov 2026) passed `build` under it.
// The turn rail's window (14 Nov 2026: `ConversationNavigator` draws the newest 20 turns and an "N earlier" item, the
// transcript is the phone's first screen though its CSS hides the rail there): about 1,730 bytes more than the budget
// above measured (2,203,581 against 2,201,852 on the branch before the usage grouping moved out). Run 43497845095 on the
// branch merged with main passed `build` under the budget below.
// The input history's hydrate stops logging a paired host's `remote_offline` as a failed read (16 Nov 2026, 1326c4dc0;
// `stores/input-history.ts` is on the phone's first screen): measured 2,203,024 by the runner's build (branch run
// 43849653388), 24 bytes over. The budget is that measure plus 76 bytes.
// The side panel paints its last width on the first frame (16 Nov 2026, `PanelContainer` reads `lib/last-read`), and the
// Tauri preload stays out of subframes: measured 2,203,306 by the runner's build (branch run 43874132984), 206 bytes
// over. The budget is that measure plus 94 bytes.
// A row clicked while a session switch runs opens beside it (17 Nov 2026, `use-session-switch.ts` counts switches in
// flight; the sidebar is on the phone's first screen): measured 2,203,472 (branch run 43943178767), 72 bytes over. The
// budget is that measure plus 78 bytes.
// A phone fetches a large picture over HTTP by its `blobUrl` (17 Nov 2026, cf9fc87f0; the transcript's image content is
// on the phone's first screen) and a finished run settles calls whose end frame never came (df9455c53, `stores/tools.ts`):
// measured 2,204,283 (branch run 44004040626), 733 bytes over. The budget is that measure plus 77 bytes.
// An image card names its provider, model, size and quality under the picture (17 Nov 2026, 14f4f39e5; the image card
// is on the phone's first screen): measured 2,204,690 (main run 44050798438), 330 bytes over. The budget is that
// measure plus 80 bytes.
// A tab list answered after a tab's status push keeps what the push said (18 Nov 2026, `stores/tabs.ts` counts the
// pushes), with the boot status read that keeps the page's seeded stores (20025ddf7, `hooks/use-rpc-events.ts`): measured
// 2,204,879 (branch run 44144695375), 109 bytes over. The budget is that measure plus 80 bytes.
// omp 18.22.2's Kiro provider draws its lobe-icons mark (18 Nov 2026; `provider-marks.ts` imports every mark statically
// and is on the phone's first screen): measured 2,205,745 (branch run 44219676729), 786 bytes over. The budget is that
// measure plus 80 bytes.
// The title bar says a paired device's session waits on that device (18 Nov 2026, `TitleBar.tsx`, on the phone's first
// screen): measured 2,205,912 (branch run 44261937715), 87 bytes over. The budget is that measure plus 80 bytes.
// The setup screen says "Updating" for a too-old omp by its outdated state, since setup installs the tested omp over
// it with Bun and no longer runs stock `omp update` (19 Nov 2026, `MachineSetupView.tsx`, on the phone's first screen):
// measured 2,206,029 (branch run 44494564628), 37 bytes over.
// A window answers an agent's close with what it did (19 Nov 2026, `stores/tabs.ts` `closeRefusal` and
// `applyAgentView`; the tab store is on the phone's first screen): measured 2,206,451 (branch run 44519094423), 459
// bytes over. The budget is that measure plus 80 bytes.
// A todo list says when it last changed and why it is behind the work (20 Nov 2026, `chat/dock/TodoFreshness.tsx`; the
// work strip and the dock's todo card are on the phone's first screen): measured 2,207,770 (branch run 44579782922),
// 1,778 bytes over. The budget is that measure plus 80 bytes.
// It also lists the instructions received since that change (20 Nov 2026, `TodoReceived` with the board's rows): measured
// 2,208,877 (branch run 44589770282), 1,027 bytes over. The budget is that measure plus 80 bytes.
// They lead with their count, say what the count measures, and a tap shows a cut line whole (20 Nov 2026): measured
// 2,209,713 (branch run 44596214057), 756 bytes over. The budget is that measure plus 80 bytes.
// A paired host's refusal of a view's return after its window closed it (20 Nov 2026, C2: `view_ended` in
// `shared/ipc-error-codes.ts`, which the phone's first screen loads): measured 2,206,000 (branch run 44589727329), 8 bytes
// over. The budget is that measure plus 80 bytes.
// Those branches together with close-visible B, the page watchdog, the to-do panel's wording, the C fixes and the rest
// of next-line (20 Nov 2026): measured 2,208,648 (branch run 44601435767). The budget is that measure plus 80 bytes.
// A compaction's line and card say what happens and how long (20 Nov 2026, a50471797: `ChatStream.tsx`,
// `MessageBubble.tsx`, `lib/compaction-action.ts`), with the work board's release-gate check row (830248735): measured
// 2,207,914 (branch run 44612367045), 1,922 bytes over. The budget is that measure plus 80 bytes.
// Five theme sets, each light and dark (20 Nov 2026, 7d7e723de: `lib/theme-palettes.ts`, the set picker's model in
// `lib/themes.ts`): measured 2,208,335 (branch run 44615749422), 341 bytes over. The budget is that measure plus 80 bytes.
// A turn refused because credits are off reads as the plan's limit, not a failed response (20 Nov 2026, f8aedbc24:
// `lib/messages.ts`, `TurnErrorNotice.tsx`): measured 2,208,473 (branch run 44622480250), 58 bytes over. The budget is
// that measure plus 80 bytes.
// next-line with relaunch-keeps-work, the board fix, earlier-list's compaction line, theme sets and limit card, and G12
// (20 Nov 2026): measured 2,211,213 (branch run 44627539158). The budget is that measure plus 80 bytes.
// Session rows read their repository, branch and image (19 Nov 2026, `sessions.targets`/`sessions.artwork` in
// `shared/omp-api.ts` and the two-line row): measured 2,206,290 with both halves (parity run 44491251735, the API alone
// 2,206,183 in branch run 44489431846), 298 bytes over. The budget is that measure plus 80 bytes.
// next-line with 0.135.0 merged (its session rows and bridge-health) and the board's transcript child lines (20 Nov
// 2026): measured 2,211,541 (branch run 44628708913). The budget is that measure plus 80 bytes.
// The empty-transcript probe (20 Nov 2026) put 790 bytes on it inline (2,212,331 in branch run 44655288339; the
// branches merged with it add types only). Its report now loads by import() when a pane shows no rows; what stays is
// the per-tab seeded/written record and that import: measured 2,212,013 (branch run 44656064987), 392 bytes over. The
// budget is that measure plus 80 bytes.
// The first-run gate deciding from omp's catalog before the stock helper answers (G22, `servingVerdict` and the split
// wait in `FirstRunGate`, 20 Nov 2026), which runs on every first screen: measured 2,212,279 (branch run 44673408959),
// 266 bytes over. The budget is that measure plus 80 bytes.
// Review notes (26 Nov 2026, orca-review-notes): ⌘W's close guard reads a tab's unsent notes (`lib/tab-close.ts` →
// `stores/review-notes.ts`, the store and its localStorage list) and the composer takes handed text into a hidden tab's
// store (`lib/composer-handoff.ts`); the transcript's Add to chat is lazy (`TranscriptQuote`): measured 2,215,498 (branch
// run 45687946641), 3,139 bytes over. The budget is that measure plus 80 bytes.
// With main's queued-edit requeue (8c6217faf, b99ecc9af: the composer store's `editsRequeueing`) merged: measured
// 2,215,938 (branch run 45699393025). The budget is that measure plus 80 bytes.
// The quick terminal's shortcut, store fields and lazy mount, the palette's quick-terminal and saved-command rows (Orca
// terminal port, 26 Nov 2026; the saved-command store and parser load with the palette, the sheet and xterm on first
// open), on top of the review notes: measured 2,218,875 (local build of omp/agent/orca-terminal rebased on 73923cfad),
// 2,857 bytes over. The budget is that measure plus 80 bytes.
// The conversation's reading and writing extras (26 Nov 2026, orca-chat-reading). On the first screen, because the
// first paint of a session draws them: a restored draft's pictures as ordered slots with their kept-file references
// (`stores/composer.ts`, `draft-persistence.ts`, `use-composer-draft.ts`; a slot is a thumbnail, a still placeholder or
// the "Attach again" chip inside the one picture strip), a long prompt's fold (`MessageBubble`), the rail's "Your
// messages" button, the Find bar's listener (`TranscriptFind`), the transcript's Backspace and paste keys, the
// composer's ⌘↵, the manual compaction events (a compaction under way when the page loads) and their strings. The
// no-op notice is one branch of the compact call. Loaded idle after start (AppShell), off the first screen and drawn
// from their loaded module: the Find bar (`TranscriptFindBar`), the rail's list (`PromptListPanel`), and the `@`
// menu's sessions and paste links (`composer-extras.ts`, also on the composer's focus): measured 2,227,902 (local build
// of omp/agent/orca-chat-reading rebased on be4a4064f), 9,027 bytes over main's budget, of which about 290 are main's
// own since 26190f1da. The budget is that measure plus 80 bytes.
// The Schedules channel names left `shared/schedules.ts` for `shared/schedule-channels.ts` (26 Nov 2026, routines),
// so the first screen's `omp-api.ts` no longer pulls the schedule rules (cron, webhook senders, filters) with them.
// All sessions (26 Nov 2026, orca-board). On the first screen: the board's destination and its window's start on it
// (`stores/ui.ts` `openBoard`, AppShell's loader, `main.tsx` `#/board`), the sidebar's All sessions nav row (its
// figures load as their own chunk behind Suspense), a session row's Copy title and the hover that loads its last
// exchange (`lib/last-exchange.ts`, its own chunk), and a child's question in its opener's dock (`ChildAsks`, drawn
// beside each pane's own card at once). The page, its peek, inbox and Resources load on intent with the other pages:
// measured 2,230,764 (CI run 45754781110, omp/agent/orca-board at 3a021909f), 2,782 bytes over.
// Dictation (26 Nov 2026, orca-dictation): the composer's take state with hold-to-talk, the words while speaking and
// Retry (`hooks/use-dictation-take.ts`, `lib/dictation-press.ts`), the audio context made inside the press and the
// microphone's opening (`lib/dictation-capture.ts`, because WebKit keeps a context made later suspended), the
// `voice.dictate` key and the stream's RPC methods and strings. Loaded on use, off the first screen: the take's capture,
// stream and whole-take transcription (`lib/dictation-live.ts`, while the microphone opens), the tidy pass and its
// glossary (`lib/dictation-text.ts`, when a take first lands) and the window's dictation host (once dictation is on):
// measured 2,231,148 (e2e-nightly run 45755595124), 3,166 bytes over. Both, with the title bar's tab strip gone
// (c0ecfe18f): measured 2,231,648 (CI run 45769328347, omp/agent/orca-dictation at b85ccc38c). The budget is that
// measure plus 80 bytes.
// The new task sheet's pending rows (26 Nov 2026, orca-worktree-create): a task being made shows on the sidebar's first
// screen (`layout/sidebar/NewTaskRows.tsx` and the step runner of `stores/new-tasks.ts`, its composer helpers already
// loaded): 737 bytes measured over main (CI build of omp/agent/orca-worktree-create on 8fafd91b6), added to the budget.
// Work sources outside GitHub (26 Nov 2026, orca-trackers): `omp-api.ts`'s `trackers` member and GitLab's request
// timeout, the tracker fault codes in `shared/ipc-error-codes.ts`, GitHub sign-in's project scope argument and a new
// task's exact branch (`stores/new-tasks.ts`, `worktreeCreate`'s `branch`); the channel names sit in
// `shared/tracker-channels.ts` so the tracker rules stay with the source bar's lazy chunks: measured 2,232,761
// (e2e-nightly run 45779116807, omp/agent/orca-trackers at c149c5843). The budget is that measure plus 80 bytes.
// A paired host's task in its own section and a failed task's reason (`NewTaskRows` in `SidebarDevices.tsx`,
// `errorDetail`), and an auto-grow field that follows a value set by code: 87 bytes (2,232,472 on e2e-nightly run
// 45785242603, omp/agent/board-parity at 8ebe6c326, against the 2,232,385 its base measured), added to the budget.
// The sidebar's Bots section (26 Nov 2026, orca-bots-ui: `SidebarBots.tsx`, the bots store, a bot row's facts and its
// hover card; the sidebar is the phone's first screen, and a section that loads later would pop in). The dialogs, the
// bot page, the templates and their words load later (OnDemandDialogs, `BotsPage` lazy, `bot-launch` imports the
// templates on a template's create): 3,814 bytes measured over main (branch run 45779653731 on 9878bdec4), added to the
// budget.
// Organizing the sidebar (27 Nov 2026, orca-projects): the phone's first screen draws the session list, so what its
// rows and stores carry is on it: project groups and their section header, project and session glyphs (colour,
// emoji), the keyed sidebar entries (`setEntry`, `renameProjectGroup`), picking several rows and their menu
// (`pickedMenuItems`), the row swipe (`SwipeActions`, `sessionSwipeItems`), the open row's account read
// (`lib/tab-accounts.ts`), the sidebar requests store, the MRU close and the reopened tab's place; the dialogs (move,
// rename, appearance, emoji, parent, clone, locate folder) load on use: 2,316 bytes over main's measure (2,234,781 in
// CI run 45784490025 on 9878bdec4, whose budget was 2,232,465), added to the budget.
// First-visit tours, feature tips and What OMPdesk can do (26 Nov 2026, orca-onboarding). On the first screen: the
// guide store's tour and tip tables with their seen flags (`stores/starter-guide.ts`), the first-visit check in AppShell
// (`onboarding/surface-tours.ts`, `spotlight-target.ts`), Help's new item and the update check's macOS notice state.
// Both tours' cards, the tip row, the sheet and the desktop-only notices load as their own chunks: 2,863 bytes
// (2,235,624 on CI run 45786852939, omp/agent/orca-onboarding on fbe7b7b8d, against the 2,232,761 its base measured),
// added to the budget.
// Bot items, groups and chat cards (26 Nov 2026, orca-bots-items): the sidebar's group rows (`bots/rooms/room-faces.tsx`),
// the item page's three rebindable keys (`lib/keymap.ts`), the Bots page's room place (`bots/bot-page.ts`) and what
// decides a chat's bot card and its Hide (`chat/bots/bot-card-kind.tsx`, `hidden-cards.ts`, read by `ToolCard`,
// `MessageBubble` and `ChatStream`, all on the phone's first screen). The cards, the Items tab, the item page and the
// room load later (`chat/bots/BotCards.tsx` lazy, `BotsPage` lazy): 5,283 bytes over the budget of its base (2,242,025
// in branch run 45815652051 at 21739cea5, whose budget was 2,236,742), added to the budget with 80 bytes.
// The Preview's session ports and link toast (26 Nov 2026, orca-preview): the sidebar polls what each open tab's
// processes listen on (`stores/session-ports.ts`), names them in the row's tooltip and lists Open and Stop per port in
// its menu (`session-menu.ts`; reading, ending and opening load by import(), `lib/session-port-actions.ts`), and the
// phone's link toast offers Open in Preview beside Open on computer (a toast's `secondAction`,
// `web/host-ui/WebHostUi.tsx`): 1,346 bytes over main (2,232,994 in e2e-nightly run 45773210485, omp/agent/orca-preview
// at 6db34b5b0, over main's 2,231,648), added to the budget.
// A bot's living face (27 Nov 2026, orca-bots-face): the face drawn at rest where a bot has no picture, on the phone's
// first screen through the sidebar's Bots rows (`lib/bot-face.ts`, `common/BotFace.tsx`, `bots/BotAvatar.tsx`); the rig
// that moves it loads after the page's `load` as its own chunk (`lib/bot-face-motion.ts` and what it imports): 4,452
// bytes over the budget of its base (2,253,082 in CI run 45852447692 at a789da035, whose budget was 2,248,630), added
// to the budget with 80 bytes.
// An `a2ui` call's own chat row (26 Nov 2026, docs/design/a2ui.md §2), all of it in `main-*.js` (the engine and views
// stay in the A2UI chunk): `buildHistoryRows` cutting the call out of its card, `MessageBubble` choosing the card, the
// one lazy loader and its Suspense, the tool's row label, and the preload list's seven new chunk names (the A2UI chunk
// and what it shares with other lazy chunks: Slider, lib/chart, four lucide icons). Main at 73923cfad measured
// 2,215,938 (run 45705643845); with this, 2,217,032 (branch run 45710193733), 1,094 bytes more.
// The A2UI answer path (unit 4): ExtensionDialog telling an a2ui marker form from another (the contracts' marker
// parser) and handing it to the dock row's lazy loader (the row itself is in the A2UI chunk), and the step reveal
// finding an a2ui chat row: 2,217,814 (branch run 45712547026), 782 bytes more.
// Both merged with the quick terminal: measured 2,217,549 (branch run 45727586452; main's GitHub card went lazy
// meanwhile), inside the quick terminal's budget, which stays.
// The A2UI stack merged with main at b90e7549d: measured 2,254,932 (CI run 45868553036, omp/agent/a2ui-u4-2 at
// 33356584c), 1,850 bytes over main's 2,253,082. The budget is that measure plus 80 bytes.
// Sort and Hide sleeping (26 Nov 2026, orca-sidebar-sort): the session list's header options (`SidebarOptions`), the
// "N sleeping" line (`SidebarSleeping`), the sort and sleep rules in `sidebarRows` and the minute clock they read are
// on the phone's first screen: 2,247,759 bytes in branch run 45838019432 at ef8cfafa5 over its base's budget of
// 2,247,284, so 555 bytes with the 80 added to the budget.
// The Bots section as the Bots page's entry (its header's title button), every nav cell's tooltip and the list of
// deleted projects gone (27 Nov 2026): 2,253,761 bytes in branch run 45866719061 at d87201a7b (budget 2,253,717), the
// 44-byte excess plus 80 bytes carried into the merged budget.
// The paired page reads its own sort and Hide sleeping when the sidebar mounts. The device-pref routing brings the
// first screen to 2,255,977 bytes (run 45876781076, 8bccc83f4); allow that measurement plus 80 bytes.
// The session row menu's Move to <computer> (26 Nov 2026, cross-device-handoff): the item in `session-menu.ts` and the
// call in `Sidebar.tsx`: 181 bytes over its base (e2e-nightly run 45780059698, omp/agent/cross-device-handoff at
// 918cb6da4), added to the budget.
const WEB_FIRST_SCREEN_JS_BYTES = 2_260_334;

// Bun's `builtinModules` also lists its own modules and stand-ins (`bun:*`, `ws`, `undici`), which the Node that
// runs main (shipped beside the shell) does not have: a bundle importing `ws` at runtime must fail here, not pass
// because Bun runs this check. `electron` is not allowed: main bundles the shim (`src/main/shell-host/electron`) in its place.
const nodeBuiltins = builtinModules.filter(m => !m.startsWith("bun") && m !== "ws" && m !== "undici");
const allowed = new Set<string>([...nodeBuiltins, ...nodeBuiltins.map(m => `node:${m}`)]);

const external = new Set<string>();
const source = await fs.readFile(BUNDLE, "utf8");
for (const { path: specifier } of new Bun.Transpiler({ loader: "js" }).scanImports(source)) {
	if (allowed.has(specifier) || specifier.startsWith("./") || specifier.startsWith("../")) continue;
	external.add(specifier);
}

if (external.size > 0) {
	console.error(
		`out/main/index.js still imports ${[...external].join(", ")} at runtime. ` +
			"Add each to MAIN_BUNDLED_DEPS in electron.vite.config.ts so the packaged app needs no node_modules.",
	);
	process.exit(1);
}

// out/preload/shell.js (CEF) and tauri.js (Tauri) are classic scripts the host injects into every page before its own
// scripts: no module syntax (no import, no require, no exports) and wrapped, so none of their names joins the page's
// global scope, and no shared chunk next to them.
for (const name of ["shell", "tauri"]) {
	const preload = await fs.readFile(fileURLToPath(new URL(`../out/preload/${name}.js`, import.meta.url)), "utf8");
	const preloadImports = new Bun.Transpiler({ loader: "js" }).scanImports(preload).map(entry => entry.path);
	const preloadProblems = [
		...(preloadImports.length > 0 ? [`imports ${preloadImports.join(", ")}`] : []),
		...(/\brequire\s*\(/.test(preload) ? ["calls require()"] : []),
		...(/\b(?:module\.exports|exports\.[A-Za-z_$]|Object\.defineProperty\(exports)/.test(preload)
			? ["exports something"]
			: []),
		...(/^\(\(\)\s*=>\s*\{/.test(preload.trimStart()) && preload.trimEnd().endsWith("})();")
			? []
			: ["is not wrapped in an IIFE"]),
	];
	if (preloadProblems.length > 0) {
		console.error(
			`out/preload/${name}.js ${preloadProblems.join(", ")}: it must be one self-contained classic script.`,
		);
		process.exit(1);
	}
}

// The bundled ws, built the way out/main is (electron-vite under Node, as scripts/build-cache.ts runs it),
// carries masked frames both ways.
const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-ws-probe-"));
let probeFailure: string | null = null;
try {
	const build = spawnSync(
		process.execPath,
		["x", "electron-vite", "build", "-c", WS_PROBE_CONFIG, "--outDir", probeDir, "--logLevel", "warn"],
		{ cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
	);
	if (build.status !== 0) {
		probeFailure = `Building the ws probe failed (exit ${build.status ?? build.signal}):\n${build.stdout}${build.stderr}`;
	} else {
		// The main bundle is ESM; outside the repo nothing else says so.
		await fs.writeFile(path.join(probeDir, "main", "package.json"), '{ "type": "module" }\n');
		const run = spawnSync("node", [path.join(probeDir, "main", "ws-probe.js")], {
			encoding: "utf8",
			timeout: 30_000,
		});
		if (run.status !== 0 || !run.stdout.includes("ws round trip ok")) {
			probeFailure =
				`The bundled ws failed a WebSocket round trip in Node (exit ${run.status ?? run.signal ?? run.error?.message}):\n` +
				`${run.stdout}${run.stderr}`;
		}
	}
} finally {
	await fs.rm(probeDir, { recursive: true, force: true });
}
if (probeFailure) {
	console.error(probeFailure);
	process.exit(1);
}

const stubs = new Set(source.match(OPTIONAL_PEER_STUB));
if (stubs.size > 0) {
	console.error(
		`out/main/index.js bundles Vite's empty stand-in for a missing optional peer dependency (${[...stubs].join(", ")}): ` +
			"the package's `try { require(…) } catch` fallback never runs and it calls methods the empty object lacks. " +
			"Turn that branch off in the main build (the `define`s in electron.vite.config.ts) or install the dependency.",
	);
	process.exit(1);
}

/** A message only web_core's processor carries: the lit check below inspected the A2UI chunk, not an empty set. */
const A2UI_ENGINE_MARKER = "Surface not found for message";
let a2uiEngineSeen = false;
for (const name of await fs.readdir(RENDERER_ASSETS)) {
	if (!/\.m?js$/.test(name)) continue;
	const code = await fs.readFile(RENDERER_ASSETS + name, "utf8");
	if (code.includes(AXE_MARKER)) {
		console.error(`out/renderer/assets/${name} bundles axe-core, which is for the e2e audit only.`);
		process.exit(1);
	}
	a2uiEngineSeen ||= code.includes(A2UI_ENGINE_MARKER);
	const lit = LIT_MARKERS.find(marker => code.includes(marker));
	if (lit) {
		console.error(
			`out/renderer/assets/${name} bundles lit (${lit}): an import reached @a2ui/web_core's custom elements ` +
				"(its `universal` entry or a basic-catalog component); import only the engine (docs/design/a2ui.md §2).",
		);
		process.exit(1);
	}
}
if (!a2uiEngineSeen) {
	console.error(
		`no out/renderer asset carries @a2ui/web_core ("${A2UI_ENGINE_MARKER}"): the A2UI chunk is missing, so the lit ` +
			"check above proved nothing. Update A2UI_ENGINE_MARKER if web_core changed the message.",
	);
	process.exit(1);
}

const legacyFonts = (await fs.readdir(RENDERER, { recursive: true })).filter(name => /\.(woff|ttf)$/i.test(name));
if (legacyFonts.length > 0) {
	console.error(
		`out/renderer ships ${legacyFonts.length} .woff/.ttf fonts (${legacyFonts.slice(0, 3).join(", ")}…); ` +
			"Electron only loads .woff2. Add the package to WOFF2_ONLY_FONT_PACKAGES in electron.vite.config.ts.",
	);
	process.exit(1);
}

// The phone's first screen: web.html's entry chunk, the app chunk it imports (`main-*`), and their static imports.
const transpiler = new Bun.Transpiler({ loader: "js" });
const webHtml = await fs.readFile(path.join(RENDERER, "web.html"), "utf8");
const webEntry = /<script type="module"[^>]*src="\.\/assets\/([^"]+)"/.exec(webHtml)?.[1];
if (!webEntry) {
	console.error("out/renderer/web.html names no module entry under ./assets/.");
	process.exit(1);
}
const firstScreen = new Map<string, number>();
const addChunk = async (name: string, followDynamic: boolean): Promise<void> => {
	if (firstScreen.has(name)) return;
	const code = await fs.readFile(RENDERER_ASSETS + name, "utf8");
	firstScreen.set(name, Buffer.byteLength(code));
	for (const { path: specifier, kind } of transpiler.scanImports(code)) {
		const file = specifier.startsWith("./") ? specifier.slice(2) : null;
		if (!file?.endsWith(".js")) continue;
		if (kind === "import-statement") await addChunk(file, false);
		else if (followDynamic && kind === "dynamic-import" && file.startsWith("main-")) await addChunk(file, false);
	}
};
await addChunk(webEntry, true);
const firstScreenBytes = [...firstScreen.values()].reduce((total, size) => total + size, 0);
const panelChunk = [...firstScreen.keys()].find(name => name.startsWith("PanelViews-"));
if (panelChunk || firstScreenBytes > WEB_FIRST_SCREEN_JS_BYTES) {
	console.error(
		`The paired phone's first screen loads ${firstScreenBytes.toLocaleString("en-US")} bytes of JavaScript in ${firstScreen.size} files ` +
			`(budget ${WEB_FIRST_SCREEN_JS_BYTES.toLocaleString("en-US")})${panelChunk ? `, the side panel's views (${panelChunk}) among them` : ""}. ` +
			"Load what the first screen does not show lazily (React.lazy / import()), or raise the budget in scripts/check-main-bundle.ts with numbers from e2e/web-perf.e2e.ts.\n" +
			`Chunks, largest first: ${[...firstScreen]
				.sort((a, b) => b[1] - a[1])
				.map(([name, size]) => `${name} ${size.toLocaleString("en-US")}`)
				.join(", ")}.`,
	);
	process.exit(1);
}

// The session list's files beside the first screen (web.html's meta, scripts/pwa-plugin.ts): one chunk, so a page that
// waits for it pays one round trip, not one per file (Rollup had split it into 16 by who else imports them).
const sessionListFiles =
	new RegExp(`<meta name="${SESSION_LIST_META}" content="([^"]*)"`)
		.exec(webHtml)?.[1]
		?.split(" ")
		.filter(file => file.endsWith(".js")) ?? [];
if (sessionListFiles.length !== 1) {
	console.error(
		`out/renderer/web.html names ${sessionListFiles.length} JavaScript files for the session list (${sessionListFiles.join(", ")}), ` +
			"not one: a module only it needs was left out of the `session-list` chunk (electron.vite.config.ts).",
	);
	process.exit(1);
}
const sessionListBytes = (await fs.stat(path.join(RENDERER, sessionListFiles[0] as string))).size;

console.log(
	"main bundle is self-contained: no un-bundled runtime imports, no optional-peer stubs, the bundled ws carries " +
		`masked frames; the renderer ships no axe-core, no lit and no .woff/.ttf fonts; the phone's first screen loads ` +
		`${firstScreenBytes.toLocaleString("en-US")} bytes of JavaScript in ${firstScreen.size} files, a first visit ` +
		`${((firstScreenBytes + sessionListBytes) / 1e6).toFixed(2)} MB with the session list`,
);
