/**
 * Hidden / asleep tab store dehydration & lazy focus re-hydration (Orca parity, Phase 3).
 *
 * Loaded lazily after the first screen (`main.tsx`) so it adds zero static weight to the
 * paired phone's first-screen JS bundle. Releases retained JS heap objects (transcript rows,
 * finished tool payloads, per-subagent `ToolsStore` surfaces and cached subagent transcripts)
 * from finished background or hibernated (`asleep`) tabs while preserving lightweight metadata
 * (`session`, `tabs`, `composer` unsent draft/pictures, `extensionUi`, `subagents` roster).
 *
 * Returning focus to a dehydrated or dirty tab synchronously seeds its cached snapshot preview
 * (honoring `.omp/rules/no-loading-screens.md` — no spinner, no blank frame) and triggers lazy
 * hydration (and sidecar wake via `focusTab`'s routing when `asleep`).
 */
import type { AgentMessage } from "../../shared/rpc-types";
import { attachTabSession, hydrateTabSession, snapshotIdentity } from "../hooks/session-hydration";
import type { MessagesStore } from "../stores/messages";
import type { SessionStore } from "../stores/session";
import { onFocusedSessionRuntimeChange, sessionRuntime, sessionRuntimeStore } from "../stores/session-runtime-context";
import type { SubagentsStore } from "../stores/subagents";
import { isTabClosed, type SessionTab, useTabsStore, visibleTabIds } from "../stores/tabs";
import type { ToolsStore } from "../stores/tools";
import { HiddenSubagentThrottler, partitionHiddenBatch } from "./background-event-throttle";
import {
	backgroundThrottle,
	clearTabDirty,
	forgetTabDehydrationState,
	isTabDehydrated,
	isTabDirty,
	registerBackgroundThrottle,
	setTabDehydrated,
} from "./tab-dehydration-state";
import { seedTranscript, writeTranscriptSnapshot } from "./transcript-snapshot";

/** Default hidden idle window before proactive dehydration (2 minutes). */
export const DEFAULT_DEHYDRATE_IDLE_MS = 120_000;
/** Soft LRU cap on simultaneously hydrated hidden tabs; excess tabs dehydrate past `capGraceMs`. */
export const DEFAULT_MAX_HYDRATED_HIDDEN_TABS = 4;
/** Short grace before soft-cap eviction so rapid Cmd+Tab switching never thrashes. */
export const DEFAULT_CAP_GRACE_MS = 15_000;
/** Periodic background sweep cadence. */
export const DEFAULT_SWEEP_MS = 15_000;

export interface TabDehydrationPolicy {
	/** Idle window (ms) after which any safe hidden tab dehydrates proactively. */
	idleWindowMs: number;
	/** Maximum hidden tabs kept hydrated simultaneously (LRU); excess evicts past `capGraceMs`. */
	maxHydratedHiddenTabs: number;
	/** Minimum hidden duration (ms) before soft-cap eviction. */
	capGraceMs: number;
	/** Periodic sweep interval (ms). */
	sweepMs: number;
}

export const DEFAULT_DEHYDRATION_POLICY: TabDehydrationPolicy = {
	idleWindowMs: DEFAULT_DEHYDRATE_IDLE_MS,
	maxHydratedHiddenTabs: DEFAULT_MAX_HYDRATED_HIDDEN_TABS,
	capGraceMs: DEFAULT_CAP_GRACE_MS,
	sweepMs: DEFAULT_SWEEP_MS,
};

export interface TabRetainedFootprint {
	messages: number;
	toolEntries: number;
	subagentSurfaces: number;
	subagentTranscripts: number;
	estimatedBytes: number;
}

function estimateJsonBytes(value: unknown): number {
	if (value == null) return 0;
	if (typeof value === "string") return value.length * 2;
	try {
		return JSON.stringify(value).length * 2;
	} catch {
		return 0;
	}
}

/** Deterministic retained-payload footprint estimator for telemetry and multi-tab stress tests. */
export function estimateTabRetainedFootprint(tabId: string): TabRetainedFootprint {
	const messagesStore = sessionRuntimeStore<MessagesStore>(tabId, "messages")?.getState();
	const toolsStore = sessionRuntimeStore<ToolsStore>(tabId, "tools")?.getState();
	const subagentsStore = sessionRuntimeStore<SubagentsStore>(tabId, "subagents")?.getState();

	let bytes = 0;
	let messages = 0;
	if (messagesStore) {
		messages = messagesStore.messages.length + messagesStore.liveMessages.length;
		if (messagesStore.messages.length > 0) bytes += estimateJsonBytes(messagesStore.messages);
		if (messagesStore.liveMessages.length > 0) bytes += estimateJsonBytes(messagesStore.liveMessages);
		if (messagesStore.lastAppended.length > 0) bytes += estimateJsonBytes(messagesStore.lastAppended);
		bytes += (messagesStore.streamingText.length + messagesStore.streamingThinking.length) * 2;
	}

	let toolEntries = 0;
	if (toolsStore) {
		toolEntries = toolsStore.finishedTools.size + toolsStore.liveTools.size;
		for (const entry of toolsStore.finishedTools.values()) bytes += estimateJsonBytes(entry);
		for (const entry of toolsStore.liveTools.values()) bytes += estimateJsonBytes(entry);
		for (const partial of toolsStore.partialResults.values()) bytes += estimateJsonBytes(partial);
	}

	let subagentSurfaces = 0;
	let subagentTranscripts = 0;
	if (subagentsStore) {
		subagentSurfaces = subagentsStore.surfaces.size;
		subagentTranscripts = subagentsStore.transcripts.size();
		for (const surface of subagentsStore.surfaces.values()) {
			const surfaceState = surface.getState();
			for (const entry of surfaceState.finishedTools.values()) bytes += estimateJsonBytes(entry);
			for (const entry of surfaceState.liveTools.values()) bytes += estimateJsonBytes(entry);
		}
		for (const id of subagentsStore.subagents.keys()) {
			const held = subagentsStore.transcripts.held(id);
			if (held) bytes += estimateJsonBytes(held.messages);
		}
	}

	return {
		messages,
		toolEntries,
		subagentSurfaces,
		subagentTranscripts,
		estimatedBytes: bytes,
	};
}

function isUnsentOptimisticUser(message: AgentMessage): boolean {
	return message.role === "user" && message.optimistic === true && !message.optimisticDelivered;
}

function hasRetainedHeavyPayload(tabId: string): boolean {
	const messages = sessionRuntimeStore<MessagesStore>(tabId, "messages")?.getState();
	if (
		messages &&
		(messages.messages.length > 0 ||
			messages.liveMessages.some(message => !isUnsentOptimisticUser(message)) ||
			messages.lastAppended.length > 0 ||
			messages.streamingMessage !== null ||
			messages.streamingText.length > 0 ||
			messages.streamingThinking.length > 0 ||
			messages.readTargets.size > 0)
	) {
		return true;
	}
	const tools = sessionRuntimeStore<ToolsStore>(tabId, "tools")?.getState();
	if (tools && (tools.finishedTools.size > 0 || tools.partialResults.size > 0)) return true;
	const subagents = sessionRuntimeStore<SubagentsStore>(tabId, "subagents")?.getState();
	if (subagents && (subagents.surfaces.size > 0 || subagents.transcripts.size() > 0)) return true;
	return false;
}

/** Whether `tab` is safe to dehydrate without losing unsaved work or interrupting active UI/turns. */
export function canDehydrateTab(tab: SessionTab, visible: ReadonlySet<string>): boolean {
	if (tab.ghost || isTabClosed(tab.id) || visible.has(tab.id)) return false;
	if (!sessionRuntime(tab.id)) return false;
	if (tab.status === "running" || tab.compacting) return false;

	const session = sessionRuntimeStore<SessionStore>(tab.id, "session")?.getState();
	if (session?.isStreaming || session?.isCompacting) return false;

	const tools = sessionRuntimeStore<ToolsStore>(tab.id, "tools")?.getState();
	if (tools && tools.liveTools.size > 0) return false;

	const subagents = sessionRuntimeStore<SubagentsStore>(tab.id, "subagents")?.getState();
	if (subagents && subagents.eventConsumers > 0) return false;

	// Never dehydrate a tab that holds an unsent optimistic prompt waiting for delivery.
	const messages = sessionRuntimeStore<MessagesStore>(tab.id, "messages")?.getState();
	if (messages?.liveMessages.some(isUnsentOptimisticUser)) return false;

	// Must have a resumable session identity (or be hibernated `asleep`) so focus can re-fetch cleanly.
	const resumable = Boolean(
		tab.status === "asleep" || tab.sessionPath || tab.sessionId || session?.sessionFile || session?.sessionId,
	);
	return resumable;
}

/**
 * Release heavy retained JS payloads for a safe hidden/asleep tab while keeping lightweight
 * metadata (`session`, `composer` draft/pictures, `extensionUi`, `subagents` roster) intact.
 * Returns true if any heavy payload was freed.
 */
export function dehydrateTab(tabId: string): boolean {
	const state = useTabsStore.getState();
	const tab = state.tabs.find(entry => entry.id === tabId);
	if (!tab) return false;
	const visible = new Set(visibleTabIds(state));
	if (!canDehydrateTab(tab, visible)) return false;

	const hadPayload = hasRetainedHeavyPayload(tabId);
	const messagesStore = sessionRuntimeStore<MessagesStore>(tabId, "messages");
	if (messagesStore) {
		const msgState = messagesStore.getState();
		if (msgState.messages.length > 0) {
			writeTranscriptSnapshot(snapshotIdentity(tab), msgState.messages);
		}
		const keptLive = msgState.liveMessages.filter(isUnsentOptimisticUser);
		messagesStore.setState({
			messages: [],
			liveMessages: keptLive,
			lastAppended: [],
			streamingMessage: null,
			streamingText: "",
			streamingThinking: "",
			prevCursor: undefined,
			pageError: null,
			isLoadingPage: false,
			restoredAt: null,
			tailVersion: null,
			readTargets: new Map(),
		});
	}

	const toolsStore = sessionRuntimeStore<ToolsStore>(tabId, "tools");
	if (toolsStore) {
		const t = toolsStore.getState();
		if (t.finishedTools.size > 0 || t.partialResults.size > 0) t.reset();
	}

	const subagentsStore = sessionRuntimeStore<SubagentsStore>(tabId, "subagents");
	subagentsStore?.getState().dehydrateCaches();

	setTabDehydrated(tabId, true);
	return hadPayload;
}

/**
 * Synchronously seed snapshot preview and kick off lazy live hydration when a dehydrated or
 * background-dirty tab returns to view. Joins any in-flight `focusTab` hydration without
 * duplicate RPCs and preserves user composer drafts untouched.
 */
export function rehydrateTabOnFocus(tabId: string): boolean {
	backgroundThrottle()?.flushTab(tabId);
	const wasDehydrated = isTabDehydrated(tabId);
	const wasDirty = isTabDirty(tabId);
	if (!wasDehydrated && !wasDirty) return false;

	setTabDehydrated(tabId, false);
	clearTabDirty(tabId);

	const tab = useTabsStore.getState().tabs.find(entry => entry.id === tabId);
	if (!tab || tab.ghost || isTabClosed(tabId)) return false;

	const messagesStore = sessionRuntimeStore<MessagesStore>(tabId, "messages");
	const toolsStore = sessionRuntimeStore<ToolsStore>(tabId, "tools");
	if (wasDehydrated && messagesStore) {
		const seeded = seedTranscript(messagesStore, snapshotIdentity(tab));
		if (seeded && toolsStore) {
			toolsStore.getState().hydrateMessages(seeded, { turnIsLive: tab.status === "running" });
		}
	}
	if (wasDirty && messagesStore) {
		// Force a fresh tail fetch instead of trusting an `ifVersion` taken before hidden deltas were skipped.
		messagesStore.setState({ tailVersion: null });
	}

	if (tab.status === "ready" || tab.status === "running") {
		void (wasDirty ? hydrateTabSession(tabId) : attachTabSession(tabId));
	}
	return true;
}

export interface SweepResult {
	dehydrated: string[];
	hydratedHidden: number;
	totalDehydrated: number;
}

export class TabDehydrationController {
	readonly #policy: TabDehydrationPolicy;
	readonly #now: () => number;
	/** Timestamp when each currently hidden tab left the visible set. */
	readonly #hiddenSince = new Map<string, number>();
	#timer: ReturnType<typeof setInterval> | null = null;
	#unsubTabs: (() => void) | null = null;
	#unsubFocus: (() => void) | null = null;

	constructor(policy: Partial<TabDehydrationPolicy> = {}, now: () => number = Date.now) {
		this.#policy = { ...DEFAULT_DEHYDRATION_POLICY, ...policy };
		this.#now = now;
	}

	start(): void {
		if (this.#unsubTabs) return;
		this.#syncVisibility();
		this.#unsubTabs = useTabsStore.subscribe(() => this.#syncVisibility());
		this.#unsubFocus = onFocusedSessionRuntimeChange(() => this.#syncVisibility());
		this.#timer = setInterval(() => {
			this.sweep();
		}, this.#policy.sweepMs);
	}

	stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
		this.#unsubTabs?.();
		this.#unsubTabs = null;
		this.#unsubFocus?.();
		this.#unsubFocus = null;
		this.#hiddenSince.clear();
	}

	/** Synchronize hidden timestamps, re-hydrate any newly visible tab, and dehydrate newly `asleep` tabs. */
	#syncVisibility(): void {
		const state = useTabsStore.getState();
		const now = this.#now();
		const visible = new Set(visibleTabIds(state));
		const present = new Set<string>();

		for (const tab of state.tabs) {
			present.add(tab.id);
			if (visible.has(tab.id)) {
				this.#hiddenSince.delete(tab.id);
				rehydrateTabOnFocus(tab.id);
				continue;
			}
			if (!this.#hiddenSince.has(tab.id)) {
				this.#hiddenSince.set(tab.id, now);
			}
			// A tab whose sidecar was hibernated (`asleep`) by Rust core dehydrates immediately.
			if (tab.status === "asleep" && !isTabDehydrated(tab.id) && canDehydrateTab(tab, visible)) {
				dehydrateTab(tab.id);
			}
		}

		for (const id of [...this.#hiddenSince.keys()]) {
			if (!present.has(id)) {
				this.#hiddenSince.delete(id);
				forgetTabDehydrationState(id);
			}
		}
	}

	/** Run one deterministic dehydration pass over all hidden tabs (asleep, proactive idle, and LRU soft cap). */
	sweep(): SweepResult {
		this.#syncVisibility();
		const state = useTabsStore.getState();
		const now = this.#now();
		const visible = new Set(visibleTabIds(state));
		const dehydrated: string[] = [];

		// Collect hidden tabs that still retain heavy payloads (ordered oldest-hidden first for LRU).
		const hydratedCandidates: Array<{ tab: SessionTab; hiddenMs: number }> = [];
		for (const tab of state.tabs) {
			if (visible.has(tab.id)) continue;
			if (isTabDehydrated(tab.id)) continue;
			if (!canDehydrateTab(tab, visible)) continue;
			const hiddenSince = this.#hiddenSince.get(tab.id) ?? now;
			const hiddenMs = Math.max(0, now - hiddenSince);

			// Tier 1: hibernated sidecar (`asleep`) or past proactive idle window.
			if (tab.status === "asleep" || hiddenMs >= this.#policy.idleWindowMs) {
				if (dehydrateTab(tab.id)) dehydrated.push(tab.id);
				continue;
			}
			if (hasRetainedHeavyPayload(tab.id)) {
				hydratedCandidates.push({ tab, hiddenMs });
			}
		}

		// Tier 2: soft LRU cap on simultaneously hydrated hidden tabs.
		if (hydratedCandidates.length > this.#policy.maxHydratedHiddenTabs) {
			hydratedCandidates.sort((a, b) => b.hiddenMs - a.hiddenMs);
			let excess = hydratedCandidates.length - this.#policy.maxHydratedHiddenTabs;
			for (const candidate of hydratedCandidates) {
				if (excess <= 0) break;
				if (candidate.hiddenMs < this.#policy.capGraceMs) continue;
				if (dehydrateTab(candidate.tab.id)) {
					dehydrated.push(candidate.tab.id);
					excess--;
				}
			}
		}

		let hydratedHidden = 0;
		let totalDehydrated = 0;
		for (const tab of state.tabs) {
			if (visible.has(tab.id)) continue;
			if (isTabDehydrated(tab.id)) totalDehydrated++;
			else if (hasRetainedHeavyPayload(tab.id)) hydratedHidden++;
		}
		return { dehydrated, hydratedHidden, totalDehydrated };
	}
}

let activeController: TabDehydrationController | null = null;
let activeThrottler: HiddenSubagentThrottler | null = null;

/** Install the singleton renderer tab-dehydration & background-throttle controller (called lazily after first paint in `main.tsx`). */
export function installTabDehydration(policy?: Partial<TabDehydrationPolicy>): () => void {
	activeController?.stop();
	activeThrottler?.dispose();
	const throttler = new HiddenSubagentThrottler();
	activeThrottler = throttler;
	registerBackgroundThrottle({
		partitionBatch: partitionHiddenBatch,
		dispatchSubagent: (tabId, frame, hidden, hasConsumers, apply) =>
			throttler.dispatch(tabId, frame, hidden, hasConsumers, apply),
		flushTab: tabId => throttler.flushTab(tabId),
	});
	const controller = new TabDehydrationController(policy);
	controller.start();
	activeController = controller;
	return () => {
		if (activeController === controller) activeController = null;
		if (activeThrottler === throttler) {
			activeThrottler = null;
			registerBackgroundThrottle(null);
		}
		throttler.dispose();
		controller.stop();
	};
}
