/**
 * Background tab IPC/event throttling (Orca parity, Phase 3).
 *
 * Prevents high-frequency streaming deltas and progress updates targeting hidden/background tabs
 * from triggering React store allocations and re-renders on every token, while preserving every
 * lifecycle/status/notification/error event so unread badges, status dots, and toasts stay exact.
 * Skipped deltas mark the tab dirty so focus re-hydrates cleanly from the authoritative transcript.
 */
import type { AgentSessionEvent, SubagentFrame } from "../../shared/rpc-types";
import { isTabDehydrated, markTabDirty, type PartitionedBatch } from "./tab-dehydration-state";

export type { PartitionedBatch };

/** High-frequency streaming/progress frames safe to skip on any hidden tab. */
const HIDDEN_DROPPABLE_EVENTS: Partial<Record<AgentSessionEvent["type"], true>> = {
	message_update: true,
	tool_execution_update: true,
	token_rate: true,
	read_group_metadata: true,
};

/** Transcript/tool store events skipped while a hidden tab is already dehydrated. */
const DEHYDRATED_STORE_SKIP_EVENTS: Partial<Record<AgentSessionEvent["type"], true>> = {
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	agent_end: true,
	read_group_metadata: true,
};

const EMPTY_EVENTS: AgentSessionEvent[] = [];

/**
 * Partition an incoming RPC event batch for `tabId`.
 * Visible tabs take the zero-allocation fast path returning the input array unchanged.
 */
export function partitionHiddenBatch(tabId: string, events: AgentSessionEvent[], isHidden: boolean): PartitionedBatch {
	if (!isHidden || events.length === 0) {
		return { storeEvents: events, controlEvents: events, dropped: 0 };
	}
	const dehydrated = isTabDehydrated(tabId);
	let storeEvents: AgentSessionEvent[] | null = null;
	let controlEvents: AgentSessionEvent[] | null = null;
	let dropped = 0;

	for (let index = 0; index < events.length; index++) {
		const event = events[index];
		if (!event) continue;
		const isNoise = HIDDEN_DROPPABLE_EVENTS[event.type] === true;
		const skipStore = isNoise || (dehydrated && DEHYDRATED_STORE_SKIP_EVENTS[event.type] === true);
		if (skipStore) {
			dropped++;
			if (!storeEvents) storeEvents = events.slice(0, index);
		} else if (storeEvents) {
			storeEvents.push(event);
		}
		if (isNoise) {
			if (!controlEvents) controlEvents = events.slice(0, index);
		} else if (controlEvents) {
			controlEvents.push(event);
		}
	}

	if (dropped > 0) markTabDirty(tabId);
	return {
		storeEvents: storeEvents ? (storeEvents.length === 0 ? EMPTY_EVENTS : storeEvents) : events,
		controlEvents: controlEvents ? (controlEvents.length === 0 ? EMPTY_EVENTS : controlEvents) : events,
		dropped,
	};
}

/** Default throttle interval for `subagent_progress` frames targeting hidden tabs. */
export const HIDDEN_SUBAGENT_PROGRESS_MS = 1_000;

interface PendingProgress {
	tabId: string;
	frame: Extract<SubagentFrame, { type: "subagent_progress" }>;
	apply: (frame: SubagentFrame) => void;
}

/**
 * Coalesces `subagent_progress` frames and drops `subagent_event` surface writes for hidden tabs
 * while letting `subagent_lifecycle` and status transitions through immediately.
 */
export class HiddenSubagentThrottler {
	readonly #intervalMs: number;
	readonly #now: () => number;
	readonly #lastAppliedAt = new Map<string, number>();
	readonly #lastStatus = new Map<string, string>();
	readonly #pending = new Map<string, PendingProgress>();
	#timer: ReturnType<typeof setTimeout> | null = null;
	droppedEvents = 0;
	coalescedProgress = 0;

	constructor(intervalMs = HIDDEN_SUBAGENT_PROGRESS_MS, now: () => number = Date.now) {
		this.#intervalMs = intervalMs;
		this.#now = now;
	}

	dispatch(
		tabId: string,
		frame: SubagentFrame,
		isHidden: boolean,
		hasEventConsumers: boolean,
		apply: (frame: SubagentFrame) => void,
	): void {
		if (!isHidden) {
			if (frame.type === "subagent_progress" && frame.payload.progress?.id) {
				const key = `${tabId}\u0000${frame.payload.progress.id}`;
				this.#pending.delete(key);
				this.#lastStatus.set(key, frame.payload.progress.status);
				this.#lastAppliedAt.set(key, this.#now());
			} else if (frame.type === "subagent_lifecycle") {
				const key = `${tabId}\u0000${frame.payload.id}`;
				this.#pending.delete(key);
				this.#lastStatus.set(key, frame.payload.status);
			}
			apply(frame);
			return;
		}

		switch (frame.type) {
			case "subagent_event": {
				// Avoid allocating per-subagent ToolsStore surfaces for hidden tabs nobody has expanded.
				if (hasEventConsumers) {
					apply(frame);
				} else {
					this.droppedEvents++;
					markTabDirty(tabId);
				}
				return;
			}
			case "subagent_lifecycle": {
				const key = `${tabId}\u0000${frame.payload.id}`;
				this.#pending.delete(key);
				this.#lastStatus.set(key, frame.payload.status);
				apply(frame);
				return;
			}
			case "subagent_progress": {
				const progress = frame.payload.progress;
				if (!progress?.id) return;
				const key = `${tabId}\u0000${progress.id}`;
				const now = this.#now();
				const prevStatus = this.#lastStatus.get(key);
				const lastAt = this.#lastAppliedAt.get(key);
				// Always apply first seen, status transitions, or frames past the throttle window.
				if (prevStatus !== progress.status || lastAt === undefined || now - lastAt >= this.#intervalMs) {
					this.#pending.delete(key);
					this.#lastStatus.set(key, progress.status);
					this.#lastAppliedAt.set(key, now);
					apply(frame);
					return;
				}
				this.coalescedProgress++;
				this.#pending.set(key, { tabId, frame, apply });
				this.#armTimer();
			}
		}
	}

	flushTab(tabId: string): void {
		const now = this.#now();
		for (const [key, item] of [...this.#pending]) {
			if (item.tabId !== tabId) continue;
			this.#pending.delete(key);
			const id = item.frame.payload.progress?.id;
			if (id) {
				this.#lastStatus.set(key, item.frame.payload.progress.status);
				this.#lastAppliedAt.set(key, now);
			}
			item.apply(item.frame);
		}
		if (this.#pending.size === 0 && this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
	}

	flushDue(): void {
		this.#timer = null;
		const now = this.#now();
		for (const [key, item] of [...this.#pending]) {
			const lastAt = this.#lastAppliedAt.get(key) ?? 0;
			if (now - lastAt < this.#intervalMs) continue;
			this.#pending.delete(key);
			if (item.frame.payload.progress?.id) {
				this.#lastStatus.set(key, item.frame.payload.progress.status);
				this.#lastAppliedAt.set(key, now);
			}
			item.apply(item.frame);
		}
		if (this.#pending.size > 0) this.#armTimer();
	}

	dispose(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
		this.#pending.clear();
		this.#lastAppliedAt.clear();
		this.#lastStatus.clear();
	}

	#armTimer(): void {
		if (this.#timer) return;
		this.#timer = setTimeout(() => this.flushDue(), this.#intervalMs);
	}
}
