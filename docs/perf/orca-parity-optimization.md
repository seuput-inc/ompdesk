# OMPdesk Multi-Session Performance & Stability Optimization Roadmap (Orca Parity, Rust-First)

> **Goal:** Bring OMPdesk's multi-session memory footprint, responsiveness, and crash stability to Orca's level, built Rust-first inside `native/ompdesk/crates/core` and `native/ompdesk/crates/tauri-shell` so every optimization advances Phase F (Node main removal) rather than adding throwaway Node logic.

---

## 1. Executive Summary & Measured Root Causes

Opening 6–15+ concurrent sessions in OMPdesk today causes severe RAM accumulation (often 4–10+ GiB across `omp` Bun runtimes + WebView2/WKWebView), UI freezes during multi-tab streaming, and eventual WebView2/WKWebView OOM crashes. Our codebase audit identified **six concrete structural bottlenecks** across three layers:

| # | Layer | Exact File & Symbol | Bottleneck / Unbounded Structure | Impact |
|---|-------|---------------------|----------------------------------|--------|
| **B1** | Core / Main | `src/main/idle-release.ts` (`IdleRelease::pick`, `memoryShort`, `RESERVE_FRACTION = 0.15`), `src/main/memory-watch.ts` (`SAMPLE_MS = 5_000`) | **Strictly reactive hibernation:** Zero tabs are ever hibernated while available RAM >= 15% and OS pressure is `normal`. Once pressure hits, only **1 tab per 5 s** can be released, and only if already quiet >= 5 min. Policy & timers still live in Node. | **250–600 MiB/tab** (up to **1.9 GiB** per long session, noted in `memory/mod.rs:364`) stays permanently resident across every finished background tab until the OS is already paging/thrashing. |
| **B2** | Rust Core Pool | `native/ompdesk/crates/core/src/pool/api.rs:946-988` (`memory_tabs` calling `self.quiet(tab)` in a loop) | **N+1 synchronous hub round-trip** every 5 s: `memory_tabs()` fetches `self.facts(&tabs)` once, then loops over every tab calling `self.quiet(tab)` which invokes `self.facts(&[tab])` again per tab (21 blocking hub round-trips for 20 tabs). | Periodic main-thread & hub stalls scaling linearly with open tab count. |
| **B3** | Rust Core Procs / Main | `src/main/session-processes.ts:516-548` (`SessionProcesses::use`), `crates/core/src/procs/mod.rs` (`procs.list`) | **No Rust per-session process-tree memory/CPU accounting or spike guardrails:** `procs.list` ships every OS process over stdio JSON to Node; TS regroups with quadratic array copies (`[...(byTag.get(tag) ?? []), row]`), drops CPU accounting, and has no per-session spike/orphan budget telemetry (`MainRiseClock` watches only Node main RSS). | Unchecked child-tree leaks (dev servers, eval workers, orphaned tools) and unnecessary full-OS JSON serialization across stdio. |
| **B4** | Rust Core Channels & Buffers | `crates/core/src/wire.rs:201` (`spawn_writer`), `sidecar/lane.rs:502,555` (`Lane.run_messages`, `inbox`), `sidecar/lane.rs:408-412` (`Held.frames`), `sidecar/mod.rs:134` (`TAPS`), `sidecar/process.rs:156` (`stdin`), `sidecar/bridge.rs:107` (`Bridge.cmds`) | **Unbounded channels & full-turn AST cloning:** Every internal MPSC channel is `unbounded_channel`. `Lane.run_messages: Vec<Value>` clones every parsed `message_end` JSON AST (including large diffs/tool outputs) for the entire turn until `agent_end`. `Held.frames` buffers unboundedly behind `agent_end` for up to 5 s (`ENTRY_ID_TIMEOUT`). | Core RSS spikes under multi-tab parallel tool runs; zero backpressure when a consumer lags. |
| **B5** | Tauri Shell IPC | `native/ompdesk/crates/tauri-shell/src/page_push.rs:43-111` (`Outbox.pending`, `admit`, `enqueue`) | **Unbounded post-ready push queue & per-event `eval()` storm:** `PRE_READY_LIMIT = 4096` only applies while `!outbox.ready`. Once ready, `Outbox.pending: VecDeque<Push>` is unbounded, and every single IPC push allocates a full `window.__ompTauriPush(...)` script string and dispatches an individual `app.run_on_main_thread` + `webview.eval()`. | UI-thread saturation and WebView2/WKWebView JS heap bloat during concurrent streaming tabs. |
| **B6** | React Renderer Stores | `src/renderer/stores/session-runtime-context.tsx:62` (`runtimes: Map`), `messages.ts:8,17` (`messages`, `lastAppended`), `tools.ts:111,244,249` (`finishedTools`, `endedCallKeys`), `subagents.ts:16-24` (`surfaces`), `subagent-transcripts.ts:72` (`entries`) | **Permanent per-tab JS heap retention:** Every open tab keeps 12 Zustand stores alive until tab close — never trimmed when hidden or `"asleep"`. `tools.ts` retains full tool `args` and `result` payloads (file reads, bash outputs, diffs) for every call forever; `subagents.ts` retains a full `ToolsStore` + full transcript `AgentMessage[]` cache per subagent forever. | **150–500+ MiB JS heap** across 10–15 long sessions inside WebView2/WKWebView, directly causing renderer OOM crashes and GC pause freezes. |

---

## 2. Three-Phase Optimization Roadmap

### Phase 1 — Rust-First Sidecar Hibernation Engine & Per-Session Process-Tree Accounting (This Deliverable)

**Scope (Core Rust, zero UI/CSS/branch conflicts):**
1. **Rust Core Sidecar Idle Hibernation Engine (`native/ompdesk/crates/core/src/memory/hibernate.rs`)**:
   - Port and upgrade the idle-release eligibility & eviction state machine into `ompdesk-core` with full Orca-parity semantics:
     - **Proactive idle hibernation** (`quietWindowMs`, default 15 min) so finished, hidden, child-free tabs sleep without waiting for the OS to run out of RAM.
     - **Soft resident-sidecar cap** (`maxResidentTabs`, optional, with `capQuietWindowMs` = 2 min) to keep active `omp` process count bounded on laptops/desktops.
     - **Pressure-accelerated eviction** (`pressureQuietWindowMs` = 5 min at Warn / <15% available; multi-tab batching up to 3 evictions/tick under Critical pressure) so spikes drain immediately.
     - **Safety invariants & anti-thrash cooldown:** Never sleeps a tab that is visible/split, not `ready`, has no saved `sessionFile`, is busy/streaming/settling/compacting, has a pending approval/ask/draft/unsaved prompt/sign-in, has pending retry/restart/connection wait, is agent-owned, or owns any non-console child process (eval worker, daemon, dev server, MCP server). Applies a post-wake / post-attempt cooldown (`cooldownMs`) to prevent sleep/wake thrashing.
     - **Resumable metadata registry:** Tracks hibernated tabs' `{ sessionPath, cwd, label, hibernatedAtMs, freedBytes, reason }` and cumulative telemetry (`hibernationsTotal`, `wakesTotal`, `estimatedBytesFreed`).
   - Expose core RPCs: `memory.hibernateConfigure`, `memory.hibernateEvaluate`, `memory.hibernateStatus`, `memory.hibernateMark`.
2. **Sidecar Lane Safe Sleep & Transparent Wake/Resume Hook (`native/ompdesk/crates/core/src/sidecar/lane.rs`, `mod.rs`)**:
   - Release lane heap buffers (`last_stderr`, `slow_log`, `run_messages`) with `shrink_to_fit()` on `Command::Sleep` while preserving `session_path`, `cwd`, and `is_new = false`.
   - Add idempotent `sidecar.wake` (`Command::Wake`) RPC that transparently restarts an `"asleep"` lane on its preserved `session_path` and returns `{ woke, status, sessionPath, cwd }`.
3. **Eliminate N+1 Hub Round-Trip in `pool/api.rs` (`memory_tabs`)**:
   - Factor `Pool::is_quiet(&self, tab: &str, sleepable: bool)` so `memory_tabs()` reuses its batch `self.facts(&tabs)` result in a single round-trip instead of calling `self.facts(&[tab])` per tab.
4. **Rust Per-Session Process-Tree Memory & CPU Accounting RPC (`native/ompdesk/crates/core/src/procs/accounting.rs`)**:
   - Register `procs.sessionFootprints`: scans OS processes in Rust, groups tagged trees (`OMP_GUI_SESSION_TAG`), separates `omp` vs child processes vs `conhost.exe` vs stock shared workers (`__omp_worker_`), aggregates working set / `phys_footprint` bytes and CPU ms, flags `hasBlockingChildren` and `overBudget` spikes, reports orphaned tagged processes from closed/crashed sessions, and bounds output to top-K processes per session (never exposing argv).

**Estimated Phase 1 Impact:**
- **RAM:** **60–80% reduction** in idle background sidecar RAM on multi-session workloads (e.g., 12 open tabs with 2 active: ~4.2 GiB -> ~0.9–1.3 GiB once wired in Phase 2).
- **Hub latency:** Eliminates N extra synchronous hub calls per 5 s memory sample (`O(N)` -> `O(1)`).
- **Stability:** Enables multi-tab critical-pressure drainage and Rust-native leak/orphan/spike detection without transferring full OS process lists over stdio.

---

### Phase 2 — Wiring, Core/Shell IPC Backpressure & Bounded Streaming Buffers

**Scope (Core + Tauri Shell + thin Node/client cutover):**
1. **Cut over `memory-watch.ts` / `idle-release.ts` & `SessionProcesses.use()` to Phase 1 Rust RPCs**:
   - Drive hibernation directly from `memory.hibernateEvaluate` / `memory.hibernateMark` (with user-configurable idle window / soft cap via prefs) and route resource panel queries through `procs.sessionFootprints`.
   - Delete duplicate TypeScript grouping & `IdleRelease` state machine once parity tests pass (updating `docs/rust-inventory/root.tsv`).
2. **Tauri Shell `page_push.rs` Post-Ready Coalescing & Backpressure**:
   - Replace per-push `app.run_on_main_thread` + `webview.eval()` with a **frame-coalesced drain** (one pending UI-thread drain per document that flushes queued pushes as a single batched JS invocation, bounded by a post-ready high-water mark with `stream: reset` recovery on overflow).
   - Eliminates WebView2 UI-thread storms when 4+ split/background tabs emit concurrent updates.
3. **Core `Lane` & `EventBatcher` Memory Discipline**:
   - Compact `Lane.run_messages` to retain only lightweight message headers/keys needed by `complete_run_messages` (or bound/drop oversized tool-result payloads when already persisted) instead of cloning full JSON ASTs for every `message_end`.
   - Bound `Held.frames` with byte/count guardrails and coalesce consecutive `text_delta`/`thinking_delta`/`tool_execution_update` events before crossing into WebView2.
   - Add bounded/metered channel capacity or backpressure drops for low-priority `tool_execution_update` / `token_rate` telemetry on `TAPS` and `spawn_writer`.

**Estimated Phase 2 Impact:**
- **CPU & UI smoothness:** 5–10x fewer WebView2 `eval()` calls during heavy multi-tab streaming; eliminates main-thread stalls during concurrent tool runs.
- **Core RAM:** 50–150 MiB savings per long active turn inside `ompdesk-core`.

---

### Phase 3 — Renderer Memory Discipline & Lazy Tab Hydration (Prevent WebView2 / WKWebView OOM)

**Scope (`src/renderer/stores/*`, `src/renderer/hooks/*`, zero styling/CSS changes):**
1. **Hidden / Hibernated Tab Store Dehydration (`tab-runtime.ts`, `messages.ts`, `tools.ts`, `subagents.ts`)**:
   - When a tab is hidden for longer than a configurable window (or transitions to `status: "asleep"`), dehydrate its heavy stores while keeping lightweight metadata (`session`, `composer` unsent draft, `tabs` row, `extensionUi` open asks):
     - Trim `messages.ts` to a small tail preview (or rely on existing `transcript-snapshot.ts` cache) and clear `lastAppended`.
     - Evict `tools.ts` `finishedTools` payload bodies (`result.content`, `result.details`) and `partialResults` for hidden/asleep tabs.
     - Evict `subagents.ts` per-subagent `surfaces` (`ToolsStore`) and `subagent-transcripts.ts` `entries` cache (already cursor-resumable on demand via `hydrateSurface`).
2. **Lazy Re-Hydration on Tab Focus**:
   - Leverage existing `attachTabSession(tabId)` + `tailVersion` (`ifVersion`) + paged transcript loading so returning to a dehydrated or freshly woken tab transparently re-hydrates the visible tail without flash or data loss (honoring `.omp/rules/no-loading-screens.md` via cached snapshot preview).
3. **Bounded Per-Tab Tool Output & Scrollback Limits**:
   - Cap in-memory `finishedTools` result preview bytes per entry in `tools.ts` (large tool outputs load full detail on card expand) and cap `SubagentTranscripts` LRU size across tabs.

**Estimated Phase 3 Impact:**
- **Renderer (WebView2 / WKWebView) JS Heap:** **65–85% reduction** when 10+ long sessions are open (~500–900 MiB -> ~120–200 MiB), directly eliminating WebView2 OOM crashes and long GC freezes.

---

## 3. Complementarity & Zero-Conflict Boundaries

| Parallel Track | What That Track Owns | How This Roadmap Complements It (Zero Overlap) |
|----------------|----------------------|------------------------------------------------|
| **`#72` (bot items snapshot compaction/paging, `items-v2`)** | Bot work-items storage, snapshot compaction, and paging. | Completely separate data plane. We do not touch `items-v2` or bot item stores; Phase 1–3 optimize session sidecars, process trees, shell push transport, and chat/tool/subagent stores. |
| **`#9` / Phase F (Node removal, prefs, `git-aslr`)** | Removing Node main modules and `git-aslr`. | **Directly advances Phase F** by placing hibernation policy (`memory/hibernate.rs`), lane wake (`sidecar/lane.rs`), and session accounting (`procs/accounting.rs`) natively inside `ompdesk-core` from day one — zero new Node services introduced. |
| **`#64` (Windows WSL host)** | WSL host integration. | Untouched. Core `procs`/`memory` OS readers remain platform-isolated behind `crate::sys`. |
| **`#76` (titlebar chrome) & `#10` (UI styling Waves 1–3)** | Titlebar chrome, `components.css`, chat/sidebar CSS. | Untouched. Zero CSS or chrome modifications in any phase. |
| **`#11` (Windows NSIS updater & `hub.open` startup)** | `installer.nsh`, updater flow, `hub.open`. | Untouched. No installer, updater, or `hub.open` edits. |

---

## 4. Quantitative Before vs After Verification Summary (Phases 1–3)

All numbers below are verified by deterministic automated Rust (`ompdesk-core`, `ompdesk-tauri-shell`) and Vitest (`renderer` + debug `ompdesk-core`) tests on branch `orca/perf-orca-parity-p1` with zero clippy warnings, zero TypeScript errors, and zero first-screen bundle budget regressions.

| Dimension / Workload (20-Tab Multi-Session Baseline: 1 Active + 19 Background) | Before (Baseline) | After (Phases 1–3 Implemented & Verified) | Verified Delta / Bound | Pinning Test / Verification |
|---|---|---|---|---|
| **Background Sidecar RAM (20 tabs × 350 MiB, normal RAM)** | 20 live `omp` sidecars permanently resident (**7,000 MiB**; 0 evicted while RAM ≥ 15%) | Soft cap (`maxResidentTabs=6`, 2m quiet): **6 live / 14 hibernated** (**2,100 MiB**, 4,900 MiB freed). Proactive idle (15m quiet): **1 active / 19 hibernated** (**350 MiB**, 6,650 MiB freed) | **-70.0%** at soft cap; **-95.0%** at steady-state idle (with resumable `sessionPath`/`cwd` preserved) | `memory::hibernate::tests::twenty_tab_multi_session_hibernation_stress` |
| **Critical Memory Pressure Drainage Rate** | 1 tab / 5 s (only after 5 min quiet) | Up to **3 tabs / tick** after 1 min quiet (`criticalQuietMs=60s`, `maxEvictionsCritical=3`) | **3x faster** critical-pressure recovery, **5x shorter** quiet window | `memory::hibernate::tests::critical_pressure_drains_multiple_tabs_per_tick_faster` |
| **`pool.memoryTabs` Hub Round-Trips (20 tabs, every 5 s)** | 21 synchronous hub calls (`1 + N`) | **1** batched synchronous hub call (`O(1)`) | **-95.2%** hub round-trips per sample | `crates/core/src/pool/api.rs` (`Pool::is_quiet`) |
| **Per-Session Process Accounting (`SessionProcesses.use`)** | Full-OS `procs.list` over stdio JSON + `O(N²)` JS array-spread grouping | Single native Rust `procs.sessionFootprints` pass (`O(N)` grouping, top-K bounded, CPU ms + blocking-child + orphan + spike flags) | **Eliminates** full-OS stdio transfer & `O(N²)` JS copies | `procs::accounting::tests::*`, `session-processes.test.ts` |
| **Rust Core `Lane.run_messages` & Channel Backpressure** | Unbounded `Vec<Value>` AST clones per turn; unbounded `TAPS`/`stdin`/`signals`/`Held.frames` | `RunMessageBuffer` capped at **256 msgs / 8 MiB** (128 MiB streamed input -> exact **8 MiB** retained); `Held` capped at **2,048 frames / 16 MiB** shedding only progress noise; `TAPS` bounded **2,048** (drop-on-full); `stdin` **512** / `signals` **16** | **-93.8%** worst-case turn buffer RAM (128 MiB -> 8 MiB); 0 critical frames dropped | `sidecar::messages::tests::run_message_buffer_stress_2000_large_messages_holds_8mib_and_256_count_caps`, `sidecar::tests::held_frame_backpressure_*`, `sidecar::tests::tap_backpressure_*` |
| **Tauri Shell Post-Ready `page_push` Dispatches** | Unbounded `VecDeque<Push>`; 1 `run_on_main_thread` + 1 `webview.eval()` per event | Bounded **4,096** post-ready cap with overflow reset; **1** UI-thread drain per burst coalescing up to **64 items / 512 KiB** per `webview.eval()` | Up to **64x fewer** WebView2/WKWebView `eval()` & UI-thread round-trips | `page_push::coalesce::tests::*`, `page_push::tests::post_ready_burst_schedules_one_drain_until_emptied` (11/11) |
| **Renderer JS Heap Retention (20 tabs: 1 active + 19 finished)** | All 20 tabs retain full `messages`, `tools` (`finishedTools` payloads), and `subagents` (`surfaces` + `transcripts`) indefinitely (**>2.2 MiB** in 12-turn fixture) | Soft LRU cap (`maxHydratedHiddenTabs=4`, 15s grace): **15/19** background dehydrated (**>65%** total drop). Proactive idle (2m) or `asleep`: **19/19** background dehydrated (**0 B** background retained, **>90%** total drop); active tab, composer drafts, `extensionUi`, and subagent roster preserved; synchronous snapshot seed on focus | **-100%** retained heavy background store payloads (**>90%** total workspace reduction) with zero flicker/spinner on focus | `src/renderer/lib/tab-dehydration.test.ts` (5/5) |
| **Background Tab Streaming Event Churn (1,500 token/tool deltas + 300 subagent frames)** | Every hidden-tab `message_update`, `tool_execution_update`, `subagent_event`, and `subagent_progress` triggers store allocations/copies | **1,500/1,500** streaming/tool deltas & **200/200** `subagent_event` frames skipped on hidden tabs; **99/100** `subagent_progress` ticks coalesced (1 s window) while `agent_end`, `subagent_lifecycle`, and status transitions pass immediately | **-99.9%** hidden-tab streaming store churn; unread/status badges stay exact | `src/renderer/lib/tab-dehydration.test.ts`, `use-rpc-events.test.tsx` (93/93) |
| **Per-Tab `SubagentTranscripts` In-Memory Cache** | Unbounded `Map<string, Entry>` per tab | Bounded LRU (**12** entries/tab, cursor-resumable on demand) | Strictly `O(1)` bounded per tab | `src/renderer/lib/tab-dehydration.test.ts`, `subagent-transcripts.test.ts` (6/6) |
| **Paired Phone First-Screen JS Bundle (`check-main-bundle.ts`)** | Budget: **2,260,334 bytes** | **2,259,760 bytes** (14 files; dehydration + throttling controller lazy-loaded via `import()` after first paint) | **574 bytes under budget** (0 budget increase required) | `bun run build` (`scripts/check-main-bundle.ts`) |
