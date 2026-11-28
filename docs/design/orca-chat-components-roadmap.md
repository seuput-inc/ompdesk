# OMPdesk Chat UI — Orca Native-Chat Component Parity Roadmap

**Branch:** `orca/chat-ui-orca-parity` (branched from `orca/design-overhaul-w1` at `4d046c604`)  
**Reference (MIT, read-only):** Orca `src/renderer/src/components/native-chat/` and `src/shared/native-chat/`  
**Scope guardrail:** Zero overlap with `#76` (DesktopChrome/titlebar), `#72` (BotItems/items-v2), `#11` (updater/hub), `#12` (Rust core memory/sidecar), and `#14` (`crates/core/src/agent/`). Wave A stays strictly inside `src/renderer/components/chat/`, `src/renderer/components/tools/`, `src/renderer/styles/`, `src/renderer/dev-harness/`, and `docs/design/`.

---

## 1. Executive Summary

Workstream `#10` (`4d046c604`, see `docs/design/orca-parity-overhaul.md`) established the visual foundation — neutral grayscale surfaces, `--sc-*` design tokens, 14px chat typography, hairline framing, and spacing rhythm. The remaining gap between OMPdesk and Orca is **component-level craft inside the chat stream**:

1. **Inline Sandboxed HTML Visuals**: Orca renders rich interactive charts, architecture diagrams, and comparison mockups directly inside assistant turns via `::orca-visual{file="..." title="..."}` in a `sandbox="allow-scripts"` iframe with theme-token forwarding, auto-height governance, and CSP isolation. OMPdesk previously rendered `::orca-visual{...}` as raw text and only supported static SVG/Mermaid figures.
2. **Structured Tool / Execution / Diff Rows & Reasoning Disclosure**: Orca's `NativeChatToolLine`, `NativeChatDiffCard`, `NativeChatToolOutput`, and `NativeChatReasoningRow` use full-width aligned single-line disclosures, pill-framed file targets, right-aligned compact metrics/status/duration clusters, framed inline diff/terminal wells, and a muted `Brain`-icon reasoning disclosure. OMPdesk's `ToolCard` rows previously hugged content width (`w-fit`), mixed legacy `--omp-*` surface fills (`bg-(--omp-code-bg)` in `BashRenderer`), and rendered `ThinkingBlock` without a reasoning icon or visual framing hierarchy.
3. **Markdown Code Blocks, Clickable File-Line Chips, & Selection-to-Quote**: Orca pairs a subtly tinted code header (language badge, line count, inert HTML preview toggle, wrap/copy) with pill-shaped clickable file-line chips and an immediate one-click "Quote" selection popover that feeds the active composer without forcing an intermediate menu. OMPdesk's `CodeBlock` lacked a tinted header band, line-count metadata, and HTML document preview; markdown path links (`a[data-path-link]`) styled as ordinary text links around inline code; and `TranscriptQuote` required a two-step target menu even for quoting into the active session.
4. **Bundle Budget Discipline**: `scripts/check-main-bundle.ts` enforces `WEB_FIRST_SCREEN_JS_BYTES = 2_260_334` (~1.6–1.9 KB headroom). Every heavy component added in Waves A–C (sandboxed visual shell & card, inert HTML code preview, selection-quote popover, future rich diff/usage visualizations) MUST be loaded behind `lazyChunk` / `React.lazy(() => import(...))` with a calm `Skeleton` fallback (never a spinner — `.omp/rules/no-loading-screens.md`) so the first-screen JS budget stays flat or decreases.

---

## 2. Component-by-Component Gap Matrix

| Domain | Orca Reference (`native-chat/` + `shared/native-chat/`) | OMPdesk Current (`src/renderer/`) | Parity Gap | Target Wave |
| :--- | :--- | :--- | :--- | :--- |
| **Inline Sandboxed Visuals** | `shared/native-chat/visuals/{native-chat-visual-directive,shell,height-governor}.ts`, `media/visuals/{NativeChatInlineVisual,NativeChatVisualFrame,use-native-chat-visual-theme}.tsx` | Static `chat/SvgBlock.tsx`, `chat/MermaidBlock.tsx`, `tools/media/FileCard.tsx`; no directive parser or sandboxed HTML visual iframe | **High** — `::orca-visual{...}` & `::momo-visual{...}` render as raw text; no theme-forwarded sandboxed HTML cards or inline fenced visuals | **Wave A (A1)** |
| **Markdown Code Blocks & HTML Preview** | `markdown/code/{NativeChatCodeBlock,NativeChatHtmlPreview}.tsx`, `markdown/native-chat-markdown.css` | `chat/CodeBlock.tsx`, `chat/FigureHeader.tsx`, `chat/Figure.tsx`, `lib/markdown.tsx` | **Medium-High** — plain header lacks subtle tinted header strip and line-count meta; no inert `sandbox=""` HTML document preview toggle for `html` fences | **Wave A (A3)** |
| **Clickable File-Line Chips** | `markdown/NativeChatMarkdown.tsx` + `links/` + `tools/lines/NativeChatToolFileTarget.tsx` | `lib/markdown-path-link.tsx` emits `<a data-path-link>`, `tools/media/{PathLink,FileChip}.tsx` | **Medium** — markdown file-line links render as raw underlined text / double-boxed `<code>`; no reusable `FileLineChip` component with icon + `:line` pill styling | **Wave A (A3)** |
| **Tool / Execution / Diff Rows** | `tools/lines/{NativeChatToolLine,NativeChatToolFileTarget,NativeChatToolOutput}.tsx`, `tools/diffs/{NativeChatDiffCard,NativeChatDiffView}.tsx`, `tools/runs/NativeChatToolRun.tsx` | `tools/ToolCard.tsx`, `tools/renderers/{EditRenderer,BashRenderer,ReadGroupCard}.tsx`, `chat/ExecutionGroup.tsx`, `lib/diff.tsx` | **High** — tool headers `w-fit` leave ragged right alignment for duration/diffstat/chevron; `ToolPathTarget` lacks subtle target chip treatment; `BashRenderer` & `EditRenderer` still reference legacy `--omp-*` fills/borders instead of framed `--sc-code-*` wells | **Wave A (A2)** |
| **Reasoning / Thinking Disclosure** | `messages/reasoning/{NativeChatReasoningRow,NativeChatReasoningDisclosure}.tsx` | `chat/ThinkingBlock.tsx` | **Medium** — lacks muted `Brain` icon in header, subtle hover/open disclosure cadence, and refined indented body hairline | **Wave A (A2)** |
| **Selection-to-Quote Action** | `selection-quotes/{NativeChatSelectionQuote,SelectionAddToChatPopover}.tsx` | `panels/notes/{TranscriptQuote,AddToChat}.tsx` + `common/SelectionActions.tsx` | **Medium** — clicking "Add to chat" always opens a secondary context menu even when quoting into the current tab; does not filter UI chrome (`button`, `.omp-message-actions`, `[data-figure-header]`) out of captured selections | **Wave A (A3)** |
| **Interactive Approval / Question / Offer Cards** | `prompts/{NativeChatApprovalCard,NativeChatQuestionCard}.tsx`, `worker-approvals/NativeChatWorkerApprovals.tsx`, `NativeChatCardFrame.tsx`, `NativeChatOfferActions.tsx` | `tools/renderers/AskRenderer.tsx`, `tools/renderers/A2uiRenderer.tsx`, `chat/bots/BotCards.tsx`, `layout/ExtensionUiOverlay.tsx` | **Medium** — ask/permission flows split between overlay modal and inline tool card; unified inline `CardFrame` action bars with keyboard shortcuts (`1`–`9`, `Cmd+Enter`) and worker-approval queue parity needed | **Wave B (B1)** |
| **Subagent Run Cards & Delegation Lanes** | `subagents/NativeChatSubagentRun.tsx`, `messages/agent-senders/`, `worker-lifetime/` | `chat/work/{ChildrenAtWork,ChildrenAtWorkList,WorkMap,CoordinationSub}.tsx`, `tools/renderers/TaskRenderer.tsx` | **Medium** — functional status map exists, but per-subagent inline expandable run transcripts, model/effort badges, and live tool-step ticker inside subagent rows lag Orca's `NativeChatSubagentRun` | **Wave B (B2)** |
| **Context Usage Meter & Turn Telemetry** | `usage/NativeChatContextUsageRing.tsx` | `chat/UsageRow.tsx`, `chat/TurnOutputMeter.tsx`, composer context pill | **Low-Medium** — OMPdesk shows numeric tokens/rate/cost well; Orca adds a compact circular SVG context-usage ring with hover breakdown popover (cached/input/output/compaction threshold) | **Wave B (B3)** |
| **Composer (`@`, `/`, Attachments, Effort, Queue)** | `composer/{controls,editor,focus,pickers,submit}/`, `attachments/{chips,intake,uploads}/`, `queue/`, `paste/` | `layout/Composer.tsx`, `layout/composer/{MentionMenu,CommandMenu,SkillPickerOverlay,ThinkingControl,queue-lane,use-composer-*}.tsx` | **Medium** — rich backend wiring already exists; parity polish needed on unified picker group headings (`NativeChatPickerGroupHeading`), removable attachment thumbnail chips with upload progress, editable queued items (`queue/editing/`), and inline quote preview chip above textarea | **Wave B (B4)** |
| **Viewport Scroll-Lock, Virtualization & Rail** | `viewport/{scroll,virtualization,new-rows,rail}/`, `NativeChatTranscriptViewport.tsx`, `NativeChatMessageList.tsx` | `chat/ChatStream.tsx`, `chat/chat-stream-utils.ts`, `chat/ConversationNavigator.tsx`, `chat/TranscriptFindBar.tsx` | **Low-Medium** — OMPdesk's TanStack virtualizer + gesture-vetoed tail anchoring (`chat-stream-utils.ts`) is already strong; remaining polish is Orca's subtle hover-revealed jump rail and unread-new-rows pill (`viewport/new-rows/`) | **Wave C (C1)** |
| **Rich Link Previews, Actions & Message Polish** | `links/{actions,previews}/`, `messages/{actions,rows,diagnostics,notices}/`, `NativeChatDividerRow.tsx` | `chat/{LinkPeek,LinkPeekCard,MessageBubble,ReplyFiles,TurnErrorNotice}.tsx` | **Low** — polish turn-divider pills, floating copy/branch/quote action bar density, and richer inline link preview cards | **Wave C (C2)** |

---

## 3. Phased Execution Plan

### Wave A — Highest-Impact Visible Chat Components *(Implemented in this branch)*

#### A1. Inline Sandboxed HTML Visuals
- **Parser & fast-path (`src/renderer/components/chat/inline-visual-directive.ts`)**:
  - Strict standalone-line grammar for both `::orca-visual{file="..." title="..."}` and `::momo-visual{file="..." title="..."}` (basename-only `.html`, traversal/separator/Windows-device-name rejection, bounded line/file/title length, cap of 8 directives per message), plus fenced ```` ```orca-visual ```` / ```` ```momo-visual ```` inline HTML blocks.
  - Streaming tail guard (`withoutPendingVisualDirectiveTail`) holds back incomplete `::orca-visual{...` lines mid-stream so raw directive syntax never flickers while typing.
  - Plain-text stripper (`stripVisualDirectiveLines`) keeps "Copy message text" clean.
- **Lazy sandboxed iframe engine (`src/renderer/components/chat/inline-visual-shell.ts` + `InlineVisualCard.tsx`)**:
  - Loaded on demand via `lazyChunk(() => import("./InlineVisualCard"))` behind `<Suspense fallback={<Skeleton ... />}>` (0 bytes added to initial first-screen bundle when no visual directive is present, and strictly no spinner).
  - Hardened `sandbox="allow-scripts"`, `referrerPolicy="no-referrer"`, `<base href="about:srcdoc">`, strict CSP (`default-src 'none'`, pinned chart/viz CDN allowlist, `connect-src 'none'`, `frame-src 'none'`, `form-action 'none'`, `base-uri 'none'`).
  - Random 128-bit hex postMessage `channel`, ES5 bootstrap script with `ResizeObserver` + `MutationObserver` auto-height, Orca height governor (`80px–2000px` clamp, rate limit, runaway-growth freeze), live theme observer forwarding both `--sc-*` and Orca CSS variables (`--background`, `--foreground`, `--card`, `--border`, `--muted`, `--muted-foreground`, `--accent`, `--primary`, `--chart-1..5`, `--font-sans`, `--font-mono`, `color-scheme`), and gated external link click forwarding.
  - Unified `FigureHeader` chrome with Preview/Code toggle (`FigureModeToggle`), Copy source, Open file in viewer, and Fullscreen `Modal` (`size="xl"`).
- **Wiring (`src/renderer/components/chat/ChatMarkdown.tsx`, `MessageBubble.tsx`, `StreamingText.tsx`)**:
  - Fast-paths straight to `MarkdownRenderer` when `!hasVisualDirective(content)` so regular turns incur zero extra render work.

#### A2. Orca-Grade Structured Tool / Execution / Diff Rows & Thinking Disclosure
- **Single-line aligned tool rows (`src/renderer/components/tools/ToolCard.tsx`, `renderers/ReadGroupCard.tsx`)**:
  - Full-width aligned rows (`w-full`) with clear left cluster (status/kind icon, intent/label, crisp mono target path chip `.omp-tool-path-chip`) and right-aligned metadata cluster (`ms-auto`: diff stat chip, diagnostics, status pill, folded thoughts, tabular duration, quiet hover-strengthened chevron).
  - Preserves every existing accessibility, sliver-guard, and `ToolCard.test.tsx` invariant.
- **Framed inline diff & terminal wells (`EditRenderer.tsx`, `BashRenderer.tsx`, `ExecutionGroup.tsx`)**:
  - Replaces legacy `--omp-code-bg` / `--omp-dim` tokens in `BashRenderer` and `EditRenderer` with framed `--sc-code-bg` / `--sc-code-border` wells (`omp-tool-diff-well`, `omp-bash-terminal`), subtle hairline dividers, and cleaner expanded step rhythm inside `.omp-execution-group-body`.
- **Reasoning disclosure (`src/renderer/components/chat/ThinkingBlock.tsx`)**:
  - Adds muted `Brain` icon in `.omp-thinking-header`, calmer hover/expanded disclosure hierarchy, and quiet indented `.omp-thinking-body` hairline.

#### A3. Enhanced Markdown Code Blocks, Clickable File-Line Chips, & Selection-to-Quote
- **Sleek code blocks & lazy inert HTML preview (`CodeBlock.tsx`, `FigureHeader.tsx`, `components.css`)**:
  - Subtle tinted `.omp-figure-header` band (`var(--sc-surface-1)` over `var(--sc-code-bg)`), crisp language badge + subtle line-count hint (`N lines`), refined icon action strip.
  - Complete HTML documents (`<!doctype html>` / `<html>` inside ```` ```html ```` fences) automatically offer a Preview / Code toggle rendering inside a lazy-loaded inert `sandbox=""` (no scripts) iframe.
- **Clickable file-line chips (`src/renderer/components/chat/FileLineChip.tsx`, `PathLink.tsx`, `FileChip.tsx`, `components.css`)**:
  - Styles markdown path links (`.markdown-body a[data-path-link]`) as compact clickable mono chips with subtle tint, border, and hover accent (flattening nested `<code>` boxes so no double border appears).
  - Adds reusable `FileLineChip` component with file icon, basename + `:line` badge, full-path tooltip, and one-click preview/open.
- **One-click Selection-to-Quote popover (`src/renderer/components/chat/SelectionQuotePopover.tsx`, wired lazily in `ChatStream.tsx`)**:
  - Filters out non-prose UI chrome (buttons, `.omp-message-actions`, `[data-figure-header]`, `.omp-tool-header`, `.omp-thinking-header`) when accepting transcript selections (`readQuotableTranscriptSelection`).
  - Offers immediate one-click **Quote** directly appending a `> ` blockquote to the active tab's composer via `handToComposer` (no redundant menu step), plus **Copy**, and an optional secondary target chooser when other tabs are open.
  - Lazy-loaded in `ChatStream.tsx` so zero bytes enter the initial first-screen bundle.

---

### Wave B — Interactive Prompt Cards, Subagent Runs, Context Ring & Composer Polish *(Next)*

- **B1. Unified Inline Approval / Question / Offer Cards**:
  - Introduce a shared `ChatCardFrame` primitive inside `components/chat/` mirroring Orca's `NativeChatCardFrame` + `NativeChatOfferActions`: consistent header icon/title/status pill, keyboard-accelerated option rows (`1`–`9`), inline rejection/feedback textarea, and resolved-state single-line collapse (`NativeChatResolvedView`).
  - Migrate inline `AskRenderer`, command/permission approvals, and worker-approval prompts to share `ChatCardFrame` while respecting `#72` (BotItems) boundaries.
- **B2. Subagent Run Cards (`NativeChatSubagentRun` parity)**:
  - Upgrade `ChildrenAtWork` / `TaskRenderer` with inline collapsible subagent run cards showing live step ticker, nested tool-call counts, model/thinking badge, duration, and one-click jump-to-tab.
- **B3. Context Usage Ring (`NativeChatContextUsageRing` parity)**:
  - Add a compact 16px SVG circular progress ring beside the composer / `UsageRow` with warning/danger thresholds (75% / 90%) and a lazy-loaded hover/click breakdown popover (system, tools, history, cache hit ratio, one-click Compact).
- **B4. Composer Picker, Attachment Chips & Queue Editing Polish**:
  - Unified group headings across `@` file/session mentions and `/` slash commands; rich thumbnail attachment chips with inline preview/remove; inline edit & reorder on queued follow-up messages (`queue-lane.tsx`); compact quoted-snippet preview pill above the textarea when quoting from transcript.

---

### Wave C — Viewport Navigation Rail, Rich Link Previews & Micro-Interactions *(Follow-up)*

- **C1. Viewport New-Rows Pill & Scrub Rail**:
  - Enhance `ChatStream` jump-to-latest button with unread-turn count badge when unpinned during streaming; refine `ConversationNavigator` into an Orca-style hover-expanding turn scrub rail with active-turn indicator.
- **C2. Rich Link Preview Cards & Turn Dividers**:
  - Upgrade `LinkPeekCard` with structured metadata layout (favicon, domain, title, snippet, open/copy actions) and add subtle centered `ChatDividerRow` pills for session handoffs, compactions, and branch forks.
- **C3. Streaming & Reduced-Motion Micro-Polish**:
  - Tune streaming block promotion cadence, diff hunk collapse/expand transitions (opacity/transform-only per `motion-system.test.ts`), and responsive phone/tablet compaction checks via `e2e/responsive-audit.ts`.

---

## 4. Bundle-Budget & Quality Guardrails

- **First-screen JS budget (`scripts/check-main-bundle.ts`)**: Keep `InlineVisualCard`, `inline-visual-shell`, `HtmlCodePreview`, and `SelectionQuotePopover` in dynamic `import()` chunks so eager delta stays `<= 0` bytes (replacing `TranscriptQuote`'s lazy import with `SelectionQuotePopover`'s lazy import keeps `ChatStream`'s eager footprint flat).
- **No loading spinners (`.omp/rules/no-loading-screens.md`)**: Lazy visual and preview chunks fall back to calm sized `Skeleton` blocks.
- **Surface & token compliance**: Pass `node scripts/lint-surfaces.mjs`, `biome check`, `bun run check:types`, all `src/renderer/styles/*.test.ts` contract suites (`tokens`, `class-usage`, `motion-system`, `has-anchors`), and dedicated Vitest suites for every new/upgraded component.
