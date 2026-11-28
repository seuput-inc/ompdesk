import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentSessionEvent, SubagentFrame } from "../../shared/rpc-types";
import type { ComposerStore } from "../stores/composer";
import type { MessagesStore } from "../stores/messages";
import type { SessionStore } from "../stores/session";
import { deleteSessionRuntime, sessionRuntimeStore, setFocusedSessionRuntime } from "../stores/session-runtime-context";
import { createSubagentTranscripts, MAX_HELD_SUBAGENT_TRANSCRIPTS } from "../stores/subagent-transcripts";
import type { SubagentsStore } from "../stores/subagents";
import { ensureTabRuntime } from "../stores/tab-runtime";
import { type SessionTab, useTabsStore } from "../stores/tabs";
import type { ToolsStore } from "../stores/tools";
import { HiddenSubagentThrottler, partitionHiddenBatch } from "./background-event-throttle";
import { resetSnapshotsForTest } from "./snapshot-cache";
import {
	canDehydrateTab,
	dehydrateTab,
	estimateTabRetainedFootprint,
	rehydrateTabOnFocus,
	TabDehydrationController,
} from "./tab-dehydration";
import { isTabDehydrated, isTabDirty, markTabDirty, resetTabDehydrationStateForTest } from "./tab-dehydration-state";

function makeHeavyMessages(tabIndex: number, count: number): AgentMessage[] {
	const payload = "x".repeat(4_096);
	const list: AgentMessage[] = [];
	for (let i = 0; i < count; i++) {
		const callId = `call-${tabIndex}-${i}`;
		list.push({
			role: "user",
			entryId: `u-${tabIndex}-${i}`,
			content: [{ type: "text", text: `Prompt ${i} in session ${tabIndex}` }],
			timestamp: 1_000 + i * 3,
		});
		list.push({
			role: "assistant",
			entryId: `a-${tabIndex}-${i}`,
			content: [
				{ type: "text", text: `Working on step ${i}` },
				{ type: "toolCall", id: callId, name: "read", arguments: { path: `src/file-${i}.ts` } },
			],
			timestamp: 1_001 + i * 3,
		});
		list.push({
			role: "toolResult",
			entryId: `r-${tabIndex}-${i}`,
			toolCallId: callId,
			toolName: "read",
			content: [{ type: "text", text: payload }],
			timestamp: 1_002 + i * 3,
		});
	}
	return list;
}

function populateTab(tabId: string, tabIndex: number, turnCount = 12): void {
	ensureTabRuntime(tabId);
	const messages = makeHeavyMessages(tabIndex, turnCount);
	const msgStore = sessionRuntimeStore<MessagesStore>(tabId, "messages")!;
	const toolsStore = sessionRuntimeStore<ToolsStore>(tabId, "tools")!;
	const subagentsStore = sessionRuntimeStore<SubagentsStore>(tabId, "subagents")!;
	const sessionStore = sessionRuntimeStore<SessionStore>(tabId, "session")!;

	sessionStore.setState({
		status: "ready",
		sessionId: `sid-${tabIndex}`,
		sessionFile: `/sessions/tab-${tabIndex}.jsonl`,
		sessionName: `Session ${tabIndex}`,
		cwd: `/work/repo-${tabIndex}`,
		isStreaming: false,
	});
	msgStore.setState({
		messages,
		lastAppended: messages.slice(-2),
		tailVersion: `v-${tabIndex}`,
		restoredAt: null,
	});
	toolsStore.getState().hydrateMessages(messages, { turnIsLive: false });

	// Seed 2 subagents with heavy tool surfaces.
	subagentsStore.getState().setSnapshots([
		{
			id: `sub-${tabIndex}-1`,
			index: 0,
			agent: "explore",
			status: "completed",
			description: "Inspect codebase",
			lastUpdate: 1_000,
		},
		{
			id: `sub-${tabIndex}-2`,
			index: 1,
			agent: "worker",
			status: "completed",
			description: "Run checks",
			lastUpdate: 2_000,
		},
	]);
	for (const subId of [`sub-${tabIndex}-1`, `sub-${tabIndex}-2`]) {
		const surface = subagentsStore.getState().surface(subId);
		surface.getState().hydrateMessages(messages.slice(0, 9), { turnIsLive: false });
	}
}

const createdTabs: string[] = [];

beforeEach(() => {
	resetSnapshotsForTest();
	resetTabDehydrationStateForTest();
	useTabsStore.setState({ tabs: [], activeTabId: null, split: null, rememberedSplits: [] });
	setFocusedSessionRuntime(null);
	// Minimal mock for lazy attach/hydrate RPCs triggered on focus re-hydration.
	const commandForTab = vi.fn(async (_tabId: string, cmd: { type: string }) => {
		if (cmd.type === "get_state") {
			return {
				type: "response",
				command: "get_state",
				success: true,
				data: { sessionId: "sid-restored", isStreaming: false, todoPhases: [] },
			};
		}
		if (cmd.type === "get_transcript_page") {
			return {
				type: "response",
				command: "get_transcript_page",
				success: true,
				data: { messages: makeHeavyMessages(1, 3), version: "v-live" },
			};
		}
		return { type: "response", command: cmd.type, success: true, data: {} };
	});
	const storage = new Map<string, string>();
	const localStorageMock = {
		get length() {
			return storage.size;
		},
		key: (i: number) => [...storage.keys()][i] ?? null,
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => {
			storage.set(k, v);
		},
		removeItem: (k: string) => {
			storage.delete(k);
		},
		clear: () => storage.clear(),
	};
	Object.defineProperty(globalThis, "localStorage", { value: localStorageMock, configurable: true, writable: true });
	Object.defineProperty(globalThis, "window", {
		value: {
			localStorage: localStorageMock,
			omp: {
				rpc: {
					command: vi.fn(async () => ({ type: "response", command: "noop", success: true, data: {} })),
					commandForTab,
				},
			},
		},
		configurable: true,
		writable: true,
	});
});

afterEach(() => {
	for (const id of createdTabs.splice(0)) deleteSessionRuntime(id);
	resetTabDehydrationStateForTest();
	resetSnapshotsForTest();
	useTabsStore.setState({ tabs: [], activeTabId: null, split: null, rememberedSplits: [] });
});

describe("Phase 3: 20-tab store dehydration, lazy focus re-hydration & background throttling", () => {
	it("dehydrates 19 background tabs in a 20-tab workspace with >90% retained byte reduction while preserving active tab and drafts", () => {
		let now = 100_000;
		const tabs: SessionTab[] = [];
		for (let i = 0; i < 20; i++) {
			const id = `tab-${i}`;
			createdTabs.push(id);
			tabs.push({
				id,
				cwd: `/work/repo-${i}`,
				status: "ready",
				kind: "agent",
				title: `Session ${i}`,
				sessionId: `sid-${i}`,
				sessionPath: `/sessions/tab-${i}.jsonl`,
				unreadDone: false,
			});
			populateTab(id, i, 12);
		}
		// Add an unsent user composer draft to a hidden tab — must survive dehydration untouched.
		sessionRuntimeStore<ComposerStore>("tab-5", "composer")?.getState().setDraft("finish PR review");

		useTabsStore.setState({ tabs, activeTabId: "tab-0", split: null });
		setFocusedSessionRuntime("tab-0");

		const baselineTotal = tabs.reduce((sum, t) => sum + estimateTabRetainedFootprint(t.id).estimatedBytes, 0);
		const baselineBg = tabs.slice(1).reduce((sum, t) => sum + estimateTabRetainedFootprint(t.id).estimatedBytes, 0);
		expect(baselineTotal).toBeGreaterThan(2_000_000);
		expect(baselineBg).toBeGreaterThan(1_900_000);

		const controller = new TabDehydrationController(
			{ idleWindowMs: 120_000, maxHydratedHiddenTabs: 4, capGraceMs: 15_000, sweepMs: 60_000 },
			() => now,
		);
		controller.start();

		// Stage 1: After 20s (> capGraceMs, < idleWindowMs), soft LRU cap trims 19 hidden tabs down to 4 warm.
		now += 20_000;
		const capPass = controller.sweep();
		expect(capPass.dehydrated.length).toBe(15);
		expect(capPass.hydratedHidden).toBe(4);
		expect(capPass.totalDehydrated).toBe(15);
		expect(isTabDehydrated("tab-0")).toBe(false);

		const afterCapTotal = tabs.reduce((sum, t) => sum + estimateTabRetainedFootprint(t.id).estimatedBytes, 0);
		expect(afterCapTotal).toBeLessThan(baselineTotal * 0.35);

		// Stage 2: After 125s (> idleWindowMs), proactive idle dehydrates all 19 background tabs.
		now += 105_000;
		const idlePass = controller.sweep();
		expect(idlePass.dehydrated.length).toBe(4);
		expect(idlePass.hydratedHidden).toBe(0);
		expect(idlePass.totalDehydrated).toBe(19);

		const afterIdleTotal = tabs.reduce((sum, t) => sum + estimateTabRetainedFootprint(t.id).estimatedBytes, 0);
		const afterIdleBg = tabs.slice(1).reduce((sum, t) => sum + estimateTabRetainedFootprint(t.id).estimatedBytes, 0);
		const reductionPct = ((baselineTotal - afterIdleTotal) / baselineTotal) * 100;

		expect(afterIdleBg).toBe(0);
		expect(reductionPct).toBeGreaterThan(90);

		// Active tab retains full transcript, tools, and subagent surfaces.
		const activeFp = estimateTabRetainedFootprint("tab-0");
		expect(activeFp.messages).toBe(36);
		expect(activeFp.toolEntries).toBe(12);
		expect(activeFp.subagentSurfaces).toBe(2);

		// Hidden dehydrated tab preserves composer draft, session metadata, and subagent roster rows.
		expect(sessionRuntimeStore<ComposerStore>("tab-5", "composer")?.getState().draft).toBe("finish PR review");
		expect(sessionRuntimeStore<SessionStore>("tab-5", "session")?.getState().sessionName).toBe("Session 5");
		expect(sessionRuntimeStore<SubagentsStore>("tab-5", "subagents")?.getState().subagents.size).toBe(2);
		expect(sessionRuntimeStore<SubagentsStore>("tab-5", "subagents")?.getState().surfaces.size).toBe(0);

		controller.stop();
	});

	it("respects safety invariants and never dehydrates visible, running, unsaved, or optimistic-prompt tabs", () => {
		const tabs: SessionTab[] = [
			{ id: "vis", cwd: "/a", status: "ready", kind: "agent", sessionPath: "/s/vis.jsonl", unreadDone: false },
			{ id: "split", cwd: "/b", status: "ready", kind: "agent", sessionPath: "/s/split.jsonl", unreadDone: false },
			{ id: "run", cwd: "/c", status: "running", kind: "agent", sessionPath: "/s/run.jsonl", unreadDone: false },
			{ id: "unsaved", cwd: "/d", status: "ready", kind: "agent", unreadDone: false },
			{ id: "opt", cwd: "/e", status: "ready", kind: "agent", sessionPath: "/s/opt.jsonl", unreadDone: false },
			{ id: "exp", cwd: "/f", status: "ready", kind: "agent", sessionPath: "/s/exp.jsonl", unreadDone: false },
		];
		for (const [idx, tab] of tabs.entries()) {
			createdTabs.push(tab.id);
			populateTab(tab.id, idx, 2);
		}
		// Clear sessionId/sessionFile on unsaved blank tab.
		sessionRuntimeStore<SessionStore>("unsaved", "session")?.setState({ sessionId: "", sessionFile: null });
		// Add unsent optimistic prompt to `opt`.
		sessionRuntimeStore<MessagesStore>("opt", "messages")
			?.getState()
			.appendLiveMessage({
				role: "user",
				content: [{ type: "text", text: "queued send" }],
				optimistic: true,
				timestamp: 9999,
			});
		// Mark subagent surface mounted on `exp`.
		sessionRuntimeStore<SubagentsStore>("exp", "subagents")?.setState({ eventConsumers: 1 });

		useTabsStore.setState({
			tabs,
			activeTabId: "vis",
			split: { axis: "columns", ratio: 0.5, first: { tabId: "vis" }, second: { tabId: "split" } },
		});
		const visible = new Set(["vis", "split"]);

		for (const tab of tabs) {
			expect(canDehydrateTab(tab, visible)).toBe(false);
			expect(dehydrateTab(tab.id)).toBe(false);
		}
	});

	it("immediately dehydrates asleep tabs and lazily re-hydrates snapshot + live session on focus without losing draft", () => {
		createdTabs.push("active", "sleeping");
		const tabs: SessionTab[] = [
			{ id: "active", cwd: "/a", status: "ready", kind: "agent", sessionPath: "/s/a.jsonl", unreadDone: false },
			{ id: "sleeping", cwd: "/b", status: "ready", kind: "agent", sessionPath: "/s/b.jsonl", unreadDone: false },
		];
		populateTab("active", 0, 5);
		populateTab("sleeping", 1, 8);
		sessionRuntimeStore<ComposerStore>("sleeping", "composer")?.getState().setDraft("draft preserved");
		useTabsStore.setState({ tabs, activeTabId: "active", split: null });

		const controller = new TabDehydrationController({ idleWindowMs: 600_000 }, () => 1_000);
		controller.start();

		// Rust core hibernates the background tab -> status transitions to `asleep`.
		useTabsStore.setState({
			tabs: tabs.map(t => (t.id === "sleeping" ? { ...t, status: "asleep" } : t)),
		});
		expect(isTabDehydrated("sleeping")).toBe(true);
		expect(estimateTabRetainedFootprint("sleeping").estimatedBytes).toBe(0);

		// User switches focus back to the hibernated tab -> synchronously seeds cached snapshot preview.
		useTabsStore.setState({
			tabs: tabs.map(t => (t.id === "sleeping" ? { ...t, status: "ready" } : t)),
			activeTabId: "sleeping",
		});
		expect(isTabDehydrated("sleeping")).toBe(false);
		const msgState = sessionRuntimeStore<MessagesStore>("sleeping", "messages")!.getState();
		expect(msgState.messages.length).toBeGreaterThan(0);
		expect(msgState.restoredAt).not.toBeNull();
		expect(sessionRuntimeStore<ToolsStore>("sleeping", "tools")!.getState().finishedTools.size).toBeGreaterThan(0);
		expect(sessionRuntimeStore<ComposerStore>("sleeping", "composer")!.getState().draft).toBe("draft preserved");

		controller.stop();
	});

	it("throttles 1,000+ background streaming/progress events with zero hidden-tab store churn while keeping badges accurate", () => {
		createdTabs.push("fg", "bg");
		populateTab("fg", 0, 2);
		populateTab("bg", 1, 2);
		useTabsStore.setState({
			tabs: [
				{ id: "fg", cwd: "/a", status: "ready", kind: "agent", sessionPath: "/s/a.jsonl", unreadDone: false },
				{ id: "bg", cwd: "/b", status: "running", kind: "agent", sessionPath: "/s/b.jsonl", unreadDone: false },
			],
			activeTabId: "fg",
		});

		const shell: AgentMessage = { role: "assistant", content: [], timestamp: 5_000 };
		const batch: AgentSessionEvent[] = [];
		for (let i = 0; i < 1_000; i++) {
			batch.push({
				type: "message_update",
				message: shell,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tok", partial: shell },
			});
		}
		for (let i = 0; i < 500; i++) {
			batch.push({
				type: "tool_execution_update",
				toolCallId: "tc-1",
				toolName: "bash",
				args: { command: "ls" },
				partialResult: { content: [{ type: "text", text: `line ${i}` }] },
			});
		}
		batch.push({ type: "agent_end", messages: [] });

		// Hidden tab drops all 1,500 streaming deltas from store/control events while keeping agent_end!
		const partitioned = partitionHiddenBatch("bg", batch, true);
		expect(partitioned.dropped).toBe(1_500);
		expect(partitioned.storeEvents).toHaveLength(1);
		expect(partitioned.storeEvents[0]?.type).toBe("agent_end");
		expect(partitioned.controlEvents).toHaveLength(1);
		expect(partitioned.controlEvents[0]?.type).toBe("agent_end");
		expect(isTabDirty("bg")).toBe(true);

		// Visible tab takes zero-allocation fast path.
		const visibleBatch = partitionHiddenBatch("fg", batch, false);
		expect(visibleBatch.dropped).toBe(0);
		expect(visibleBatch.storeEvents).toBe(batch);

		// Subagent throttler drops 200 subagent_event frames on hidden tab and coalesces 100 progress ticks.
		let clock = 10_000;
		const throttler = new HiddenSubagentThrottler(1_000, () => clock);
		const applied: SubagentFrame[] = [];
		const apply = (frame: SubagentFrame) => applied.push(frame);

		for (let i = 0; i < 200; i++) {
			throttler.dispatch(
				"bg",
				{
					type: "subagent_event",
					payload: { id: "sub-1", event: { type: "turn_start" } },
				},
				true,
				false,
				apply,
			);
		}
		expect(throttler.droppedEvents).toBe(200);
		expect(applied).toHaveLength(0);

		for (let i = 0; i < 100; i++) {
			clock += 5;
			throttler.dispatch(
				"bg",
				{
					type: "subagent_progress",
					payload: {
						index: 0,
						agent: "worker",
						agentSource: "bundled",
						task: "work",
						progress: {
							id: "sub-1",
							index: 0,
							agent: "worker",
							agentSource: "bundled",
							status: "running",
							task: "work",
							recentTools: [],
							recentOutput: [],
							toolCount: i,
							tokens: i * 10,
							requests: i + 1,
							cost: 0,
							durationMs: i * 5,
						},
					},
				},
				true,
				false,
				apply,
			);
		}
		// Only the first running progress frame passed; the other 99 were coalesced.
		expect(applied).toHaveLength(1);
		expect(throttler.coalescedProgress).toBe(99);

		// Status transition (`completed`) passes immediately so badge updates with zero lag.
		throttler.dispatch(
			"bg",
			{
				type: "subagent_progress",
				payload: {
					index: 0,
					agent: "worker",
					agentSource: "bundled",
					task: "work",
					progress: {
						id: "sub-1",
						index: 0,
						agent: "worker",
						agentSource: "bundled",
						status: "completed",
						task: "work",
						recentTools: [],
						recentOutput: [],
						toolCount: 100,
						tokens: 1_000,
						requests: 10,
						cost: 0,
						durationMs: 500,
					},
				},
			},
			true,
			false,
			apply,
		);
		expect(applied).toHaveLength(2);
		expect(applied[1]?.type === "subagent_progress" && applied[1].payload.progress.status).toBe("completed");
		throttler.dispose();

		// Focusing dirty tab clears dirty flag and forces fresh tailVersion: null.
		markTabDirty("bg");
		expect(rehydrateTabOnFocus("bg")).toBe(true);
		expect(isTabDirty("bg")).toBe(false);
		expect(sessionRuntimeStore<MessagesStore>("bg", "messages")?.getState().tailVersion).toBeNull();
	});

	it("bounds SubagentTranscripts in-memory cache with LRU eviction while staying cursor-resumable", async () => {
		let calls = 0;
		const transcripts = createSubagentTranscripts(async cmd => {
			calls++;
			const id = "subagentId" in cmd ? String(cmd.subagentId) : "unknown";
			return {
				type: "response",
				command: cmd.type,
				success: true,
				data: {
					messages: [{ role: "assistant", content: [{ type: "text", text: `reply ${id}` }], timestamp: calls }],
					nextByte: 128,
				},
			};
		});

		const total = MAX_HELD_SUBAGENT_TRANSCRIPTS + 6;
		for (let i = 0; i < total; i++) {
			await transcripts.read(`sub-${i}`, { settled: `completed:${i}` });
		}
		expect(transcripts.size()).toBe(MAX_HELD_SUBAGENT_TRANSCRIPTS);
		// Oldest 6 evicted, newest 12 retained.
		expect(transcripts.held("sub-0")).toBeUndefined();
		expect(transcripts.held(`sub-${total - 1}`)).toBeDefined();

		// Re-reading an evicted subagent transparently fetches again from byte 0.
		const reread = await transcripts.read("sub-0", { settled: "completed:0" });
		expect(reread.messages).toHaveLength(1);
		expect(transcripts.held("sub-0")).toBeDefined();
		expect(transcripts.size()).toBe(MAX_HELD_SUBAGENT_TRANSCRIPTS);
	});
});
