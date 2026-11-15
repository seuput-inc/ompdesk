/**
 * Composer content. Lives in a store (not InputArea-local state) so session
 * tabs can snapshot/restore text and image attachments together.
 *
 * Writes still flow through the same call sites as the old useState: every
 * producer (typing, paste markers, mentions, history recall, dequeue
 * restore, the `omp:fill-composer` window event) calls setDraft with a value
 * or an updater.
 *
 * Beside the content it holds what the composer's run controls need to agree on across the field, the Stop
 * button and the window-level Esc: a Stop already in flight, the first Esc of a stop-with-a-draft, the
 * automatic mode choice a prompt waits on, and the queued messages a Stop withdrew (`restoredQueue`).
 */
import { createStore } from "zustand/vanilla";
import type { ImageContent } from "../../shared/rpc-types";
import { expandPasteMarkers } from "../lib/paste-blobs";
import { useOutboxStore } from "./outbox";
import { createScopedStoreHook } from "./session-runtime-context";

export interface ComposerImage {
	content: ImageContent;
	preview: string;
}

/** How long the first Esc of a stop (or of a draft's clear) waits for its second. */
export const DOUBLE_ESC_MS = 1500;

/**
 * Text handed back to the composer (a failed send, a dequeued or withdrawn message) goes ahead of the
 * draft typed meanwhile, a blank line between: every restore joins the same way.
 */
export function prependToDraft(restored: string, draft: string): string {
	return draft.trim() ? `${restored}\n\n${draft}` : restored;
}

/**
 * One message withdrawn by Stop, held apart from the draft until the person resumes,
 * edits or removes it. Picture-only messages have empty text.
 */
export interface RestoredQueueItem {
	id: string;
	text: string;
	images: ComposerImage[];
}

export interface RecoveredEditing {
	id: string;
	previous: { draft: string; images: ComposerImage[] };
	frozen: boolean;
}
export interface ComposerStore {
	draft: string;
	sending: boolean;
	submissionUncertain: boolean;
	/**
	 * Withdraws the submission still being prepared (the automatic mode choice runs before a prompt
	 * leaves): true when it had not left yet, so nothing reaches omp. Null when none is pending.
	 */
	cancelSubmit: (() => boolean) | null;
	/** The automatic mode choice is being asked right now ("Deciding how to run this…"); Stop/Esc return at once. */
	decidingMode: boolean;
	/** A Stop was sent for the running turn and the turn has not ended yet: a second click or Esc sends nothing. */
	stopping: boolean;
	/** When the first Esc of "Esc again to stop" was pressed; null when none waits (an edit of the draft disarms it). */
	stopArmedAt: number | null;
	/**
	 * Messages withdrawn by the last Stop, oldest first and held apart from the draft.
	 */
	restoredQueue: RestoredQueueItem[];
	/** A tray that renders `restoredQueue` is mounted (ComposerRestoredQueue): the only thing that makes Stop keep them apart. */
	restoredTrayMounted: number;
	editingRecovered: RecoveredEditing | null;
	beginRecoveredEdit: (id: string) => boolean;
	cancelRecoveredEdit: () => boolean;
	freezeRecoveredEdit: (deliveryId: string) => RecoveredEditing | null;
	thawRecoveredEdit: (id: string, uncertain?: boolean) => void;
	finishRecoveredEdit: (id: string) => RecoveredEditing["previous"] | null;
	setSending: (value: boolean) => void;
	setCancelSubmit: (cancel: (() => boolean) | null) => void;
	setSubmissionUncertain: (value: boolean) => void;
	setDecidingMode: (value: boolean) => void;
	setStopping: (value: boolean) => void;
	/** Arm "Esc again to stop"; disarms itself after `DOUBLE_ESC_MS`. */
	armStop: (now?: number) => void;
	disarmStop: () => void;
	/** Hold withdrawn queue entries apart from the draft. */
	holdRestored: (items: (Omit<RestoredQueueItem, "id"> & { id?: string })[]) => void;
	dropRestored: (id: string) => void;
	clearRestored: () => void;
	/** Move held entries (all, or one) into the field: text ahead of the draft, blank-line separated; pictures join the strip. */
	restoreHeldToDraft: (id?: string) => void;
	/** A tray registers while mounted; the count keeps two panes of one store from unregistering each other. */
	setRestoredTrayMounted: (mounted: boolean) => void;
	images: ComposerImage[];
	/** Replace the draft, or compute the next value from the current one
	 * (React setState parity — InputArea's updater-form call sites unchanged). */
	setDraft: (next: string | ((current: string) => string)) => void;
	setImages: (next: ComposerImage[] | ((current: ComposerImage[]) => ComposerImage[])) => void;
	reset: () => void;
}

let nextRestoredId = 0;

export const createComposerStore = () => {
	const store = createStore<ComposerStore>()((set, get) => ({
		draft: "",
		sending: false,
		submissionUncertain: false,
		cancelSubmit: null,
		decidingMode: false,
		stopping: false,
		stopArmedAt: null,
		restoredQueue: [],
		restoredTrayMounted: 0,
		editingRecovered: null,
		beginRecoveredEdit: id => {
			if (get().editingRecovered) return false;
			const item = useOutboxStore.getState().items.find(entry => entry.id === id);
			if (!item || item.send.kind !== "manual") return false;
			const send = item.send;
			if (
				!send.acknowledged ||
				send.recovery.kind === "attempt" ||
				send.recovery.kind === "withdrawal_uncertain" ||
				send.recovery.kind === "discard_pending"
			)
				return false;
			const fromContents = (images: ImageContent[]): ComposerImage[] =>
				images.map(content => ({ content, preview: `data:${content.mimeType};base64,${content.data}` }));
			const previous = send.editing
				? { draft: send.previous.draft, images: fromContents(send.previous.images) }
				: { draft: get().draft, images: get().images };
			if (
				!useOutboxStore.getState().updateManual(id, {
					editing: true,
					previous: {
						draft: expandPasteMarkers(previous.draft),
						images: previous.images.map(image => image.content),
					},
				})
			)
				return false;
			set({
				editingRecovered: { id, previous, frozen: false },
				draft: send.text,
				images: fromContents(send.images),
			});
			return true;
		},
		cancelRecoveredEdit: () => {
			const editing = get().editingRecovered;
			if (!editing || editing.frozen) return false;
			if (!useOutboxStore.getState().updateManual(editing.id, { editing: false })) return false;
			set({ editingRecovered: null, draft: editing.previous.draft, images: editing.previous.images });
			return true;
		},
		freezeRecoveredEdit: deliveryId => {
			const { editingRecovered, draft, images } = get();
			if (!editingRecovered || editingRecovered.frozen) return null;
			const manual = useOutboxStore.getState().items.find(item => item.id === editingRecovered.id);
			if (
				!manual ||
				manual.send.kind !== "manual" ||
				!manual.send.acknowledged ||
				manual.send.recovery.kind === "attempt" ||
				manual.send.recovery.kind === "withdrawal_uncertain" ||
				manual.send.recovery.kind === "discard_pending"
			)
				return null;
			if (
				!useOutboxStore.getState().updateManual(editingRecovered.id, {
					text: expandPasteMarkers(draft),
					images: images.map(image => image.content),
					recovery: { kind: "attempt", deliveryId },
				})
			)
				return null;
			set({ editingRecovered: { ...editingRecovered, frozen: true } });
			return editingRecovered;
		},
		thawRecoveredEdit: (id, uncertain = false) => {
			const editing = get().editingRecovered;
			if (editing?.id !== id) return;
			if (!uncertain && !useOutboxStore.getState().updateManual(id, { recovery: { kind: "draft" } }))
				set({ submissionUncertain: true });
			set({ editingRecovered: { ...editing, frozen: false } });
		},
		finishRecoveredEdit: id => {
			const editing = get().editingRecovered;
			if (!editing || editing.id !== id) return null;
			set({ editingRecovered: null });
			return editing.previous;
		},
		setSending: sending => set({ sending }),
		setCancelSubmit: cancelSubmit => set({ cancelSubmit }),
		setSubmissionUncertain: submissionUncertain => set({ submissionUncertain }),
		setDecidingMode: decidingMode => set({ decidingMode }),
		setStopping: stopping => set({ stopping }),
		armStop: (now = Date.now()) => {
			set({ stopArmedAt: now });
			setTimeout(() => {
				if (get().stopArmedAt === now) set({ stopArmedAt: null });
			}, DOUBLE_ESC_MS);
		},
		disarmStop: () => {
			if (get().stopArmedAt !== null) set({ stopArmedAt: null });
		},
		holdRestored: items =>
			set(state => {
				const usedIds = new Set([
					...state.restoredQueue.map(item => item.id),
					...items.flatMap(item => item.id ?? []),
				]);
				const held = items.map(item => {
					let id = item.id;
					if (id === undefined) {
						do id = `r${++nextRestoredId}`;
						while (usedIds.has(id));
						usedIds.add(id);
					}
					return { ...item, id };
				});
				return { restoredQueue: [...state.restoredQueue, ...held] };
			}),
		dropRestored: id => set(state => ({ restoredQueue: state.restoredQueue.filter(item => item.id !== id) })),
		clearRestored: () => set({ restoredQueue: [] }),
		restoreHeldToDraft: id =>
			set(state => {
				const taken = state.restoredQueue.filter(item => id === undefined || item.id === id);
				if (taken.length === 0) return state;
				const text = taken
					.map(item => item.text)
					.filter(part => part.trim())
					.join("\n\n");
				return {
					restoredQueue: state.restoredQueue.filter(item => !taken.includes(item)),
					draft: text ? prependToDraft(text, state.draft) : state.draft,
					images: [...state.images, ...taken.flatMap(item => item.images)],
					stopArmedAt: null,
				};
			}),
		setRestoredTrayMounted: mounted =>
			set(state => ({ restoredTrayMounted: Math.max(0, state.restoredTrayMounted + (mounted ? 1 : -1)) })),
		images: [],
		setDraft: next =>
			set(state => {
				const draft = typeof next === "function" ? next(state.draft) : next;
				return draft === state.draft ? state : { draft, stopArmedAt: null };
			}),
		setImages: next => set(state => ({ images: typeof next === "function" ? next(state.images) : next })),
		reset: () =>
			set({
				draft: "",
				images: [],
				sending: false,
				submissionUncertain: false,
				cancelSubmit: null,
				decidingMode: false,
				stopping: false,
				stopArmedAt: null,
				restoredQueue: [],
				editingRecovered: null,
			}),
	}));
	store.subscribe((state, previous) => {
		const editing = state.editingRecovered;
		if (!editing || editing.frozen) return;
		if (state.draft === previous.draft && state.images === previous.images && !previous.editingRecovered?.frozen)
			return;
		useOutboxStore.getState().updateManual(editing.id, {
			text: expandPasteMarkers(state.draft),
			images: state.images.map(image => image.content),
		});
	});
	return store;
};

const defaultComposerStore = createComposerStore();
export const useComposerStore = createScopedStoreHook("composer", defaultComposerStore);
