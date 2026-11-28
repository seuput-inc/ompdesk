/**
 * Lightweight shared flags and lazy hook slots between the eagerly-loaded event loop
 * (`hooks/use-rpc-events.ts`) and the lazily-loaded dehydration + throttling chunk
 * (`lib/tab-dehydration.ts` / `lib/background-event-throttle.ts`). Kept tiny so the
 * paired phone's first-screen JS bundle stays under budget.
 */
import type { AgentSessionEvent, SubagentFrame } from "../../shared/rpc-types";

export interface PartitionedBatch {
	storeEvents: AgentSessionEvent[];
	controlEvents: AgentSessionEvent[];
	dropped: number;
}

export interface BackgroundThrottleBridge {
	partitionBatch: (tabId: string, events: AgentSessionEvent[], isHidden: boolean) => PartitionedBatch;
	dispatchSubagent: (
		tabId: string,
		frame: SubagentFrame,
		isHidden: boolean,
		hasEventConsumers: boolean,
		apply: (frame: SubagentFrame) => void,
	) => void;
	flushTab: (tabId: string) => void;
}

const dehydratedTabs = new Set<string>();
const dirtyHiddenTabs = new Set<string>();
let bridge: BackgroundThrottleBridge | null = null;

export function registerBackgroundThrottle(next: BackgroundThrottleBridge | null): void {
	bridge = next;
}

export function backgroundThrottle(): BackgroundThrottleBridge | null {
	return bridge;
}

export function isTabDehydrated(tabId: string): boolean {
	return dehydratedTabs.has(tabId);
}

export function setTabDehydrated(tabId: string, dehydrated: boolean): void {
	if (dehydrated) dehydratedTabs.add(tabId);
	else dehydratedTabs.delete(tabId);
}

export function isTabDirty(tabId: string): boolean {
	return dirtyHiddenTabs.has(tabId);
}

export function markTabDirty(tabId: string): void {
	if (tabId) dirtyHiddenTabs.add(tabId);
}

export function clearTabDirty(tabId: string): void {
	dirtyHiddenTabs.delete(tabId);
}

export function forgetTabDehydrationState(tabId: string): void {
	dehydratedTabs.delete(tabId);
	dirtyHiddenTabs.delete(tabId);
}

export function dehydratedTabCount(): number {
	return dehydratedTabs.size;
}

export function resetTabDehydrationStateForTest(): void {
	dehydratedTabs.clear();
	dirtyHiddenTabs.clear();
}
