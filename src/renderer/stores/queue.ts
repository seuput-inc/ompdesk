/** The latest authoritative snapshot of this tab's pending instructions. */
import { createStore } from "zustand/vanilla";
import type { RpcGetQueueResult, RpcQueuedMessage } from "../../shared/rpc-types";
import { activeTabCommand, createScopedStoreHook, type TabCommand } from "./session-runtime-context";

export interface QueueStore {
	instance: string | null;
	entries: RpcQueuedMessage[];
	refresh: () => Promise<void>;
	setFromFrame: (snapshot: unknown) => boolean;
	reset: () => void;
}

function isSnapshot(value: unknown): value is RpcGetQueueResult {
	if (typeof value !== "object" || value === null || !("instance" in value) || !("entries" in value)) return false;
	return (
		typeof value.instance === "string" &&
		Array.isArray(value.entries) &&
		value.entries.every((entry: unknown) => {
			if (typeof entry !== "object" || entry === null) return false;
			if (!("id" in entry) || !("text" in entry) || !("state" in entry)) return false;
			return (
				typeof entry.id === "string" &&
				typeof entry.text === "string" &&
				(entry.state === "ready" || entry.state === "in_flight" || entry.state === "approval_safety") &&
				(!("images" in entry) || entry.images === undefined || Array.isArray(entry.images))
			);
		})
	);
}

export const createQueueStore = (command: TabCommand = activeTabCommand) => {
	let refreshVersion = 0;
	return createStore<QueueStore>()(set => ({
		instance: null,
		entries: [],
		refresh: async () => {
			const version = ++refreshVersion;
			try {
				const response = await command({ type: "get_queue" });
				if (version !== refreshVersion || !response.success || !isSnapshot(response.data)) return;
				set({ instance: response.data.instance, entries: response.data.entries });
			} catch {
				// Keep the last snapshot until a later read succeeds.
			}
		},
		setFromFrame: snapshot => {
			if (!isSnapshot(snapshot)) return false;
			refreshVersion += 1;
			set({ instance: snapshot.instance, entries: snapshot.entries });
			return true;
		},
		reset: () => {
			refreshVersion += 1;
			set({ instance: null, entries: [] });
		},
	}));
};

const defaultQueueStore = createQueueStore();
export const useQueueStore = createScopedStoreHook("queue", defaultQueueStore);

/** This tab's pending instructions, in the bridge's order. */
export function useQueuedMessages(): RpcQueuedMessage[] {
	return useQueueStore(state => state.entries);
}
