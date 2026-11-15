/**
 * What a person sent to a session while the link to the computer running it was down (a paired phone's page, a
 * desktop tab on a paired host): kept here, shown in the composer as "will send when connected", and delivered by
 * lib/outbox-delivery.ts once the link is back. Kept in `localStorage`, so it outlives a reload and a browser that
 * killed the page in the background; every window and page of this origin shares the one list (`storage` events).
 *
 * An item is keyed by the session it was sent to (`outboxSession`), not the tab: a computer that restarted gives its
 * tabs new ids. Its `id` is the host's delivery key (`deliveryId`), so a try whose answer was lost and the next one
 * reach omp once.
 */
import { create } from "zustand";
import type { AgentMessage, ExtensionUIRequest, ExtensionUIResponse, ImageContent } from "../../shared/rpc-types";

export type OutboxSend =
	| {
			kind: "message";
			/** As the model gets it (paste markers and emoticons expanded). */
			text: string;
			images: ImageContent[];
			/** Local recovery lineage; only text and images are sent to the host. */
			recovered?: { source: ManualOutboxSend["source"]; previous: ManualOutboxSend["previous"] };
	  }
	| {
			kind: "answer";
			/** The tab whose omp asked: a question belongs to that process. */
			tabId: string;
			response: ExtensionUIResponse;
			/** The card, put back if the person takes the answer back. */
			request?: ExtensionUIRequest;
			/** What the person answered, in words. */
			summary: string;
	  }
	| ManualOutboxSend;

/** Withdrawn for explicit editing. It is never delivered by the outbox worker. */
export interface ManualOutboxSend {
	kind: "manual";
	source: { recoveryId: string; instance: string; id: string; intent: "draft" | "discard"; envelope: AgentMessage };
	text: string;
	images: ImageContent[];
	previous: { draft: string; images: ImageContent[] };
	editing: boolean;
	acknowledged: boolean;
	recovery:
		| { kind: "draft" }
		| { kind: "attempt"; deliveryId: string }
		| { kind: "previous" }
		| { kind: "withdrawal_uncertain"; intent: "draft" | "discard" }
		| { kind: "discard_pending" };
}

export type OutboxState =
	/** Waiting for the link. */
	| "held"
	/** On its way. */
	| "sending"
	/** The computer refused it (`error`): it waits for the person (try again, edit, or cancel), and so does what follows. */
	| "failed";

export interface OutboxItem {
	id: string;
	session: string;
	at: number;
	state: OutboxState;
	send: OutboxSend;
	/** A try went out on the link and may have arrived: its answer was lost. */
	tried?: true;
	/** An answer's reads of the computer's open questions that did not list its question (lib/outbox-delivery.ts). */
	misses?: number;
	error?: string;
}

interface OutboxStore {
	items: OutboxItem[];
	/** False once a write did not fit in the browser's storage: what waits would not outlive a reload. */
	saved: boolean;
	hold: (item: OutboxItem) => boolean;
	updateManual: (
		id: string,
		change: Partial<Pick<ManualOutboxSend, "text" | "images" | "previous" | "editing" | "recovery" | "acknowledged">>,
	) => boolean;
	queueManual: (id: string, deliveryId: string, text: string, images: ImageContent[]) => boolean;
	patch: (id: string, change: Partial<Pick<OutboxItem, "state" | "tried" | "error" | "misses">>) => void;
	drop: (id: string) => void;
	/** Read the list again (another window or page changed it). */
	reload: () => void;
	reset: () => void;
}

const STORAGE_KEY = "omp.outbox.v1";

/** The session an item goes to: the computer that runs it and the session's id (the tab's while it has none). */
export function outboxSession(tab: { id: string; device?: string; sessionId?: string }): string {
	return `${tab.device ?? ""}|${tab.sessionId ? `s:${tab.sessionId}` : `t:${tab.id}`}`;
}

function storage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

function isItem(value: unknown): value is OutboxItem {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Partial<OutboxItem>;
	return (
		typeof item.id === "string" &&
		typeof item.session === "string" &&
		typeof item.at === "number" &&
		typeof item.send === "object" &&
		item.send !== null &&
		(item.send.kind === "message" || item.send.kind === "answer" || item.send.kind === "manual")
	);
}

function readStored(): OutboxItem[] | null {
	const store = storage();
	if (!store) return null;
	try {
		const parsed: unknown = JSON.parse(store.getItem(STORAGE_KEY) ?? "[]");
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isItem).map(item => {
			if (item.send.kind !== "message" || !("behavior" in item.send)) return item;
			const send: typeof item.send & { behavior?: unknown } = { ...item.send };
			delete send.behavior;
			return { ...item, send };
		});
	} catch {
		return [];
	}
}

/** A try cut off by a reload or a closed page was on its way: it is held again, and may have arrived. */
function settled(items: OutboxItem[]): OutboxItem[] {
	return items.map(item => (item.state === "sending" ? { ...item, state: "held", tried: true } : item));
}

export const useOutboxStore = create<OutboxStore>()((set, get) => {
	/** Apply `change` to the stored list (another window may have changed it since this one read it) and keep it. */
	const write = (change: (items: OutboxItem[]) => OutboxItem[]) => {
		const next = change(readStored() ?? get().items);
		let saved = false;
		try {
			const store = storage();
			if (store) {
				if (next.length === 0) store.removeItem(STORAGE_KEY);
				else store.setItem(STORAGE_KEY, JSON.stringify(next));
				saved = true;
			}
		} catch {
			saved = false;
		}
		set({ items: next, saved });
		return saved;
	};
	return {
		items: settled(readStored() ?? []),
		saved: true,
		hold: item =>
			write(items =>
				items.some(entry => entry.id === item.id)
					? items.map(entry => (entry.id === item.id ? item : entry))
					: [...items, item],
			),
		updateManual: (id, change) => {
			const store = storage();
			const items = readStored();
			if (!store || !items) {
				set({ saved: false });
				return false;
			}
			const item = items.find(entry => entry.id === id);
			if (!item || item.send.kind !== "manual") return false;
			const next = items.map(entry =>
				entry.id === id && entry.send.kind === "manual" ? { ...entry, send: { ...entry.send, ...change } } : entry,
			);
			try {
				store.setItem(STORAGE_KEY, JSON.stringify(next));
			} catch {
				set({ saved: false });
				return false;
			}
			set({ items: next, saved: true });
			return true;
		},
		queueManual: (id, deliveryId, text, images) => {
			const store = storage();
			const items = readStored();
			if (!store || !items || items.some(item => item.id === deliveryId)) {
				set({ saved: false });
				return false;
			}
			const manual = items.find(item => item.id === id);
			if (
				!manual ||
				manual.send.kind !== "manual" ||
				!manual.send.acknowledged ||
				manual.send.recovery.kind !== "attempt" ||
				manual.send.recovery.deliveryId !== deliveryId
			)
				return false;
			const { source, previous } = manual.send;
			const next = items.map(item =>
				item.id !== id
					? item
					: {
							id: deliveryId,
							session: item.session,
							at: Date.now(),
							state: "held" as const,
							send: {
								kind: "message" as const,
								text,
								images,
								recovered: { source, previous },
							},
						},
			);
			try {
				store.setItem(STORAGE_KEY, JSON.stringify(next));
			} catch {
				set({ saved: false });
				return false;
			}
			set({ items: next, saved: true });
			return true;
		},
		patch: (id, change) =>
			write(items =>
				items.map(item => {
					if (item.id !== id) return item;
					const next = { ...item, ...change };
					if (change.error === undefined && "error" in change) delete next.error;
					return next;
				}),
			),
		drop: id => write(items => items.filter(item => item.id !== id)),
		reload: () => {
			const stored = readStored();
			if (stored) set({ items: stored });
		},
		reset: () => set({ items: [], saved: true }),
	};
});

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
	window.addEventListener("storage", event => {
		if (event.key === STORAGE_KEY || event.key === null) useOutboxStore.getState().reload();
	});
}

/** The items waiting for one session, oldest first. */
export function outboxFor(items: readonly OutboxItem[], session: string): OutboxItem[] {
	return items.filter(item => item.session === session).sort((a, b) => a.at - b.at);
}

/** This page holds an answer to `requestId` of `tabId`'s omp: its card stays closed when the request is read again. */
export function answerHeld(tabId: string, requestId: string): boolean {
	return useOutboxStore
		.getState()
		.items.some(
			item => item.send.kind === "answer" && item.send.tabId === tabId && item.send.response.id === requestId,
		);
}
