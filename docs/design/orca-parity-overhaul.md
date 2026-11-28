# OMPdesk → Orca Parity UI/UX & Structure Overhaul Roadmap

**Base commit**: `9bb8924cc4` (`orca/line-v0155`, sitting on `v0.154.0` + 27 pending dev commits)  
**Reference audited**: Orca renderer source (`/tmp/orca-src-research/src/renderer/src/**`) vs OMPdesk (`src/renderer/**`)  
**Status**: Waves 1–4 implemented on `orca/design-overhaul-w1`; post-`#76` top-bar handoff checklist ready below.

---

## 1. Baseline & Guardrails

### Already Ported on `orca/line-v0155` (Preserve — Do Not Regress)
- **Near-monochrome default themes** (`theme-light.css`, `theme-dark.css`, `lib/theme-palettes.ts`): `#ffffff` / `#0a0a0a` canvas, `#171717` / `#e5e5e5` neutral accent, hue reserved for links (`--omp-link`), waiting (`--sc-attention`), unread (`--sc-unread`), working (`--sc-working`), and status.
- **Typography & reading scale**: `@fontsource-variable/geist` with `0.01em` tracking, system monospace (`SF Mono` / `Cascadia Code` / `JetBrains Mono`), 13 px chat prose / 12 px chat code default (`:root:not([data-custom-font-size])`), 46 rem reading column (`--omp-column-reading`).
- **Shell geometry**: 36 px top bar (`--sc-topbar-h`), 24 px desktop status bar (`--sc-statusbar-h`), 280 px resizable sidebar (`220–500 px`), Orca's 3 elevation levels (`--sc-shadow-sm/md/lg`), floating glass `.omp-floating`.
- **Session list & status cues**: 16 px leading status lane (`SessionStatusLane`), yellow working arc (`WorkingArc`), 4 % hover / 9 % active + inset hairline cards, unread `"New"` divider, folded long prompts (`11rem` + fade), conversation turn rail + prompt filter, ⌘F highlight-API find bar.

### Hard Engineering Constraints
1. **First-screen JS bundle budget**: `2,260,334 B` raw JS ceiling (`scripts/check-main-bundle.ts`, ~1.6–1.9 KB margin). Every wave must target **zero or negative JS bundle delta** — prefer CSS/token unification, deleting redundant chrome/classes, and keeping new UI in existing lazy chunks.
2. **`#76` Top-Bar Ownership Boundary**: `DesktopTitleBar.tsx`, `DesktopChrome.tsx`, `src/renderer/lib/chrome-layout.ts`, and `native/ompdesk/crates/tauri-shell/**` hit-test code are owned by `#76` (`hold/titlebar76` `8406bb744b`). Waves 1–3 do **not** touch these files; remaining top-bar polish is documented in Wave 4.
3. **Contract Tests & Rules**: `tokens.test.ts` (CSS ↔ `THEMES` equality, `window-background.json`, AA 4.5:1 / 3:1 floors, `--sc-hairline`, `--sc-<status>-on-soft`), `themes.contrast.test.ts`, `motion-system.test.ts` (compositor-only keyframes, tokenized durations/curves), `class-usage.test.ts`, `has-anchors.test.ts` (no `:has()` on streaming ancestors), `touch-targets.test.ts` (44 px phone controls), and `scripts/lint-surfaces.mjs` (colorless content policy).

---

## 2. Surface-by-Surface Audit (OMPdesk vs Orca)

| # | Surface | Current OMPdesk (File & Pattern) | Orca Reference (`/tmp/orca-src-research`) | Concrete Gap | Priority / Wave |
|---|---|---|---|---|---|
| **1** | **Visual Design System** | `tokens.css`, `global.css`, `components.css`: `--sc-code-bg`, `--sc-surface`, `--sc-surface-sunken` are referenced in `Card.tsx:40`, `components.css:2556`, `MachineSetupView.tsx:212`, `QuestionInbox.tsx:45`, `GithubProjects.tsx:366` but **undefined** (paint transparent). Code/composer/dialog borders use opaque `#2e2e2e` (`--sc-border-subtle`) in dark mode; `global.css` & `components.css` still have literal `1px solid var(--sc-divider)` / `var(--omp-border-muted)` and 9 px opaque scrollbars. | `assets/main.css` (`:root`, `.dark`, lines 280–510, 880–988, 1078–1112): derived `color-mix` chat/code/inline-code/composer tokens (`2–7%` fills, `7–14%` translucent borders), crisp dialog hairline (`border-black/14 dark:border-white/14`), 8 px hover-brightened translucent scrollbars (`28%→48%`), Bots/Projects section divider (`--worktree-sidebar-section-divider`). | Broken undefined `--sc-*` tokens leave cards/code wells unpainted; opaque dark-mode borders (`#2e2e2e`) and 9 px opaque scrollbars add visual harshness compared to Orca's calm translucent hairlines. | **P0 — Wave 1** |
| **2** | **App Shell & Left Sidebar** | `Sidebar.tsx:2934–3015`, `SidebarNav.tsx:111–126`, `sidebar.css:408–415`, `StatusBar.tsx:34`: `.omp-sidebar-controls` stacks `pb-2` + CSS `padding-bottom: 12px`, `[data-sidebar-destinations]` uses `24px` vertical padding; `SidebarNav` uses `size="md"` (`32px`, `text-sc-md`) vs compact nav rows; `[data-sidebar-bots]` has no bottom section divider separating it from Projects; `StatusBar` uses heavy `border-(--sc-border-subtle)` and `px-2`. | `sidebar/chrome/SidebarNav.tsx:95–158`, `sidebar/SidebarBotsSplit.tsx`, `status-bar/StatusBarSurface.tsx:88`: compact nav (`gap-0.5 px-2 pt-2 pb-1`, `text-[13px] font-medium tracking-tight`, `py-1.5`), clear Bots/Projects hairline divider (`--worktree-sidebar-section-divider`), `24px` status bar with `px-3 gap-4 border-border`. | Excess sidebar chrome padding steals vertical list height; nav rows feel oversized next to slim 40 px session cards; Bots and Projects visually bleed together; status bar seam is heavier than Orca's. | **P0 — Wave 1** (spacing/dividers/nav/status bar) + **Wave 3** (Bots split & project headers) |
| **3** | **Chat Canvas & Message Stream** | `CodeBlock.tsx:204` (`bg-(--sc-surface-1) border-(--sc-border-subtle)`), `components.css:378–386, 3369–3373` (inline code `bg: var(--sc-surface-2); border: 0`), `components.css:155–408` vs `3150–3377` (duplicate `.markdown-body` rules + literal `1px` table/hr borders), `MessageBubble.tsx`, `ExecutionGroup.tsx`, `ChatStream.tsx` (starter cards). | `assets/main.css:880–955` (`--chat-code-surface` 2%/3.5%, `--chat-code-border` 7%, `--chat-inline-code-surface` 4%/6%, `--chat-inline-code-border` 9%/8%), `native-chat/messages/**` (quiet metadata, crisp tool-output wells, calm empty state). | Dark-mode code blocks look like heavy `#171717` slabs with `#2e2e2e` frames; borderless inline code disappears inside dark bubbles/cards; duplicate markdown CSS rules and noisy metadata/empty-state chrome remain. | **P0 — Wave 1** (code & inline-code surfaces + hairlines) + **Wave 2** (message stream, tool cards, empty state) |
| **4** | **Composer (Input Surface)** | `InputArea.tsx:449` (`border-(--sc-border-subtle) bg-(--sc-field) shadow-(--sc-shadow-sm)`), `components.css:3488–3491` (`.omp-composer-box:has(textarea:focus)` jumps to `box-shadow: var(--sc-shadow-md)` — a `32px` modal drop shadow!), `ComposerField.tsx:77` (`px-4 pt-3 pb-1`), `ComposerToolbar.tsx`. | `native-chat/composer/editor/NativeChatComposerField.tsx:227–238, 293–313`: constant subtle hairline border (`border-chat-composer-border`, `11%/9%` foreground) + translucent surface (`bg-chat-composer-surface`), `shadow-xs`, `[contain:paint]`, no focus shadow flash, compact `p-1.5` outer padding + `px-2 py-1` field inset. | Focusing the composer triggers a heavy `shadow-md` elevation jump and dark border flash every time focus shifts; dark-mode composer (`#171717` + `#2e2e2e`) looks boxier than Orca's subtle `4%` translucent surface. | **P0 — Wave 1** (composer surface/border & eliminate focus flash) + **Wave 2** (toolbar/field ergonomics & padding polish) |
| **5** | **Right Panel / Inspector** | `PanelContainer.tsx:124, 240` (`[data-panel-actions]` is `min-h-(--sc-space-10) px-3 py-2` = 40 px secondary bar under the 36 px topbar), `global.css:400` (`border-bottom: 1px solid var(--sc-divider)`), `RepositoryChanges.tsx`, `FilesPanel.tsx`, `DiffPanel.tsx`. | `right-sidebar/RightSidebar.tsx`, `right-sidebar/activity-bar/right-sidebar-top-activity-bar.tsx:89`, `right-sidebar/file-explorer/`, `source-control/`: single `36px` top activity bar (`border-b`), compact `32px` sub-headers, low-noise tree/change rows and clean empty states. | Double-header height (36 px + 40 px = 76 px) wastes vertical space in Files/Changes/Checks; literal `1px` topbar divider instead of `--sc-hairline`; sub-panel headers and empty states vary in density across views. | **P1 — Wave 1** (`[data-panel-actions]` 32 px + hairline) + **Wave 3** (Changes/Files/Diff/Empty-state unification) |
| **6** | **Bots, Items & Question Inbox** | `QuestionInbox.tsx:45` (broken `bg-(--sc-surface)`, raw `<fieldset>` with verbose timestamps and ungrouped visual weight), `BotPane.tsx:91–157` (header + underline tabs without bottom seam), `BotActivity.tsx`, `items/BotItems.tsx`. | `bots/BotNeedsYouSection.tsx`, `bots/BotNeedRow.tsx`, `bots/BotPanelHeader.tsx`, `bots/items/BotItemsList.tsx`: scannable single-column priority rows with kind badges, compact inline quick-actions, clear group counts and calm surfaces. | Broken `bg-(--sc-surface)` renders inbox cards transparent; Question Inbox cards lack clear priority/source badges and compact quick-reply layout; BotPane tabs & Items headers have looser density than Orca. | **P1 — Wave 1** (fix `QuestionInbox` broken surface token & card radius) + **Wave 3** (Inbox card hierarchy, BotPane & Items density) |
| **7** | **Settings & Dialogs** | `Modal.tsx:110` (`border-(--sc-border-subtle)` opaque dark edge), `Sheet.tsx:124`, `global.css:1085, 1253–1312` (literal `1px` borders on narrow nav & master-detail panes), `SettingsPage.tsx`, `SettingsLayout.tsx` (37 px compact rows, no target-highlight fade on deep-link jump). | `ui/dialog.tsx:124–185` (`border-black/14 dark:border-white/14`, translucent `--dialog-surface`, unified `confirm`/`form`/`list`/`review` sizes `420/480/520/680px`), `settings/navigation/SettingsSidebar.tsx`, `assets/main.css:2686–2775` (`.settings-target-highlight` fade, consistent `28px` select triggers). | Dark-mode dialogs have muddy opaque `#2e2e2e` outlines instead of crisp `14%` translucent hairlines; Settings panes mix literal `1px` dividers and lack subtle deep-link target highlight feedback. | **P1 — Wave 1** (dialog hairline border + Settings hairlines) + **Wave 4** (unified dialog sizes, Settings polish & `#76` top-bar alignment) |

---

## 3. Prioritized Implementation Waves

### Wave 1 — Foundation Tokens, Broken Token Fixes & High-Payoff Chrome Calm *(Implemented Now on `orca/design-overhaul-w1`)*
**Goal**: Highest app-wide visual upgrade across Light & Dark (and all 5 theme sets) with **zero `#76` conflicts** and **zero/negative first-screen JS delta**.
- **Design tokens** (`src/renderer/styles/tokens.css`):
  - Define missing `--sc-code-bg` + add Orca-derived surface/border tokens: `--sc-code-border`, `--sc-inline-code-bg`, `--sc-inline-code-border`, `--sc-composer-bg`, `--sc-composer-border`, `--sc-composer-border-focus`, `--sc-dialog-border`, `--sc-sidebar-section-divider`, `--sc-scrollbar-thumb`, `--sc-scrollbar-thumb-hover` (with `:root[data-theme="dark"]` tuning).
- **Global & component stylesheets** (`global.css`, `components.css`, `sidebar.css`):
  - Replace 9 px opaque scrollbars with Orca's 8 px translucent hover-brightened scrollbars (`--omp-scrollbar-size: 8px`).
  - Eliminate `.omp-composer-box:has(textarea:focus)` heavy `shadow-md` flash; hold calm hairline elevation (`--sc-composer-border-focus` + `--sc-shadow-sm`).
  - Upgrade inline `<code>` to Orca's translucent fill + hairline edge (`--sc-inline-code-bg` / `--sc-inline-code-border`).
  - Convert remaining literal `1px solid var(--sc-divider)` / `var(--omp-border-muted)` / `var(--omp-md-hr)` seams to `var(--sc-hairline) solid var(--sc-divider)`.
  - Tighten sidebar control/footer vertical padding (`--sc-space-2`), add Bots/Projects hairline divider (`[data-sidebar-bots]`), and keep phone touch targets untouched.
- **Targeted component fixes** (`CodeBlock.tsx`, `InputArea.tsx`, `Modal.tsx`, `StatusBar.tsx`, `SidebarNav.tsx`, `PanelContainer.tsx`, `QuestionInbox.tsx`, `GithubProjects.tsx`):
  - Fix undefined tokens in `QuestionInbox.tsx` (`--sc-surface` → `--sc-surface-1`) and `GithubProjects.tsx` (`--sc-surface-sunken` → `--sc-surface-2`), and restore `Card surface="code"` / `MachineSetupView` via `--sc-code-bg`.
  - Apply `--sc-code-bg`/`--sc-code-border` on `CodeBlock`, `--sc-composer-bg`/`--sc-composer-border` on `InputArea`, `--sc-dialog-border` on `Modal`, `border-(--sc-divider) px-3` on `StatusBar`, compact `size="sm"` on `SidebarNav`, and `min-h-(--sc-control-md) px-2 py-1` on `PanelContainer` `[data-panel-actions]`.
- **Regression guard** (`src/renderer/styles/tokens.test.ts`):
  - Add automated check that every `--sc-*` custom property referenced in `src/renderer/**` is defined in `src/renderer/styles/*.css`.
- **Bundle budget impact**: **~0 B / slightly negative** (CSS-only tokens + shorter/equivalent Tailwind utility strings; zero new imports or components).

---

### Wave 2 — Chat Canvas & Composer Ergonomics *(Next Ready Wave)*
**Goal**: Bring conversation readability, work-card restraint, and composer ergonomics to Orca parity.
- **Exact files**:
  - `src/renderer/styles/components.css` (dedupe legacy `.markdown-body` vs `.omp-transcript-editorial .markdown-body` rules; align `.omp-execution-group-body` well to `--sc-code-bg`; tune `.omp-thinking-body` and empty-state starter cards).
  - `src/renderer/components/chat/MessageBubble.tsx` (quieter timestamp & metadata row rhythm, tighter action reveal spacing).
  - `src/renderer/components/chat/ChatStream.tsx` & empty-state welcome block (calm Orca-level starter card density and spacing).
  - `src/renderer/components/chat/ExecutionGroup.tsx` & `LiveStepPeek.tsx` (unify step-row padding, subtle verdict chip borders, reduce nested border stacking).
  - `src/renderer/components/layout/composer/ComposerField.tsx` & `ComposerToolbar.tsx` (tighten field inset `px-3 pt-2.5 pb-1`, unify toolbar chip heights/gaps, align model/effort/run pill visual weight).
- **Bundle budget impact**: **≤ 0 B** (pure CSS cleanup + class-string refactoring; removing dead duplicate markdown CSS reduces CSS size too).

---

### Wave 3 — Sidebar, Right Panel / Inspector, Bots, Items & Question Inbox
**Goal**: High-density scanning and action clarity across navigation, workspace inspection, and async bot triage.
- **Exact files**:
  - `src/renderer/components/layout/sidebar/Sidebar.tsx`, `SidebarBots.tsx`, `SidebarOptions.tsx`, `sidebar.css` (project header icon/hover alignment, Bots section collapse preview spacing, subtle group count alignment).
  - `src/renderer/components/panels/RepositoryChanges.tsx`, `FilesPanel.tsx`, `DiffPanel.tsx`, `PanelChrome.tsx` (unify 32 px panel subheaders, compact file/change tree row rhythm, consistent `EmptyState size="sm"` usage, calmer diff hunk headers).
  - `src/renderer/components/bots/QuestionInbox.tsx`, `BotPane.tsx`, `BotActivity.tsx`, `items/BotItems.tsx` (adopt Orca's `NeedRow`-style scan layout: kind/priority pill + context subtitle + inline quick-reply ergonomics, header/tab bottom seam on `BotPane`, tighter item group headers).
- **Bundle budget impact**: **0 B on first screen** (`RepositoryChanges`, `FilesPanel`, `DiffPanel`, `QuestionInbox`, `BotPane`, `BotItems` all live in lazy route/panel chunks; sidebar edits stay class-only).

---

### Wave 4 — Settings, Dialogs & `#76` Top-Bar Handoff Alignment
**Goal**: Final structural harmony across configuration surfaces, modals, and the post-`#76` desktop title bar.
- **Exact files**:
  - `src/renderer/components/settings/SettingsPage.tsx`, `SettingsLayout.tsx`, `src/renderer/styles/global.css` (deep-link target highlight fade matching Orca's `.settings-target-highlight`, nav item hover/active refinement, consistent section heading rhythm while preserving `.omp/rules/settings-layout-look.md` minimal-settings & density pins).
  - `src/renderer/components/common/Modal.tsx`, `Sheet.tsx`, `ConfirmDialog.tsx` (align modal size presets and footer spacing with Orca's unified `confirm` / `form` / `list` / `review` rhythm; consistent dark-mode `--dialog-surface` translucency where GPU compositing is active).
  - **`#76` Top-Bar Handoff Section** *(do NOT edit until `#76` merges from `hold/titlebar76`)*:
    - Files owned by `#76`: `src/renderer/components/layout/DesktopTitleBar.tsx` (if introduced), `src/renderer/components/layout/DesktopChrome.tsx`, `src/renderer/lib/chrome-layout.ts`, `src/renderer/components/layout/TitleBar.tsx` (coordinate seam), `native/ompdesk/crates/tauri-shell/src/{chrome_hit,windows_chrome,window_activation,main}.rs`, `src/preload/tauri.ts`.
    - Post-merge alignment checklist:
      1. Ensure titlebar bottom seam uses `var(--sc-hairline) solid var(--sc-divider)` (matching `PanelContainer` and `StatusBar`).
      2. Align sidebar header surface (`--sc-surface-1`) and main titlebar surface (`--sc-bg`) seamlessly across the 36 px `--sc-topbar-h` band with inset shadow (`inset 0 -1px 0`) so traffic-light vertical centering (`y = 18px`) never shifts by 1 px.
      3. Verify Windows caption-band (`--sc-caption-buttons`, `--sc-caption-band`) clearance in `e2e/windows-caption.e2e.ts` and `e2e/window-chrome-hit.e2e.ts` after visual polish.
- **Bundle budget impact**: **≤ 0 B on first screen** (Settings is lazy-loaded; `Modal`/`Sheet` edits are class/CSS-only).
