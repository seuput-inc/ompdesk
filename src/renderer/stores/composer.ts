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
import { createScopedStoreHook } from "./session-runtime-context";

export interface ComposerImage {
	content: ImageContent;
	preview: string;
	/** The picture's file name, when it came from a file: a missing draft picture is attached again by it. */
	name?: string;
	/** The saved draft picture this one was read back from (draft-persistence.ts). */
	draftRef?: DraftPictureRef;
}

/** A draft picture kept by reference with the saved draft: its bytes are read back after a relaunch. */
export interface DraftPictureRef {
	id: string;
	name: string;
	mimeType: string;
}

/**
 * One place in the draft's picture strip: a ready picture, or a saved one not read back yet (`pending`) or gone
 * (`missing`, attached again by name). Only ready pictures are sendable; the rest are never `ImageContent`.
 */
export type DraftPictureSlot = ComposerImage | { ref: DraftPictureRef; status: "pending" | "missing" };

export const isReadyPicture = (slot: DraftPictureSlot): slot is ComposerImage => "content" in slot;

const readyOf = (slots: readonly DraftPictureSlot[]): ComposerImage[] => slots.filter(isReadyPicture);

/** The slots once the ready pictures are `ready`: unread ones keep their places, gone pictures leave, new ones go last. */
function withReady(slots: readonly DraftPictureSlot[], ready: readonly ComposerImage[]): DraftPictureSlot[] {
	const left = new Set(ready);
	const kept = slots.filter(slot => !isReadyPicture(slot) || left.delete(slot));
	return [...kept, ...left];
}

/**
 * Pictures attached to the draft: the same bytes twice are one, and a picture whose name an unread saved one
 * has takes that one's place (the first such, only). Returns the slots and how many were dropped as duplicates.
 */
function attachToSlots(
	slots: readonly DraftPictureSlot[],
	added: readonly ComposerImage[],
): { slots: DraftPictureSlot[]; duplicates: number } {
	const next = [...slots];
	const seen = new Set(readyOf(slots).map(image => image.content.data));
	let duplicates = 0;
	for (const image of added) {
		if (seen.has(image.content.data)) {
			duplicates++;
			continue;
		}
		seen.add(image.content.data);
		const at = image.name ? next.findIndex(slot => !isReadyPicture(slot) && slot.ref.name === image.name) : -1;
		if (at === -1) next.push(image);
		else next[at] = image;
	}
	return { slots: next, duplicates };
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

/** A quote added to the composer goes after what it holds, a blank line between, as typing it would (Orca's `appendNativeChatQuote`). */
export function appendToDraft(added: string, draft: string): string {
	const kept = draft.trimEnd();
	return kept ? `${kept}\n\n${added}` : added;
}

/**
 * One queued message a Stop withdrew (stock's `abort_and_restore_queue`), or one the core kept when the tab's omp went
 * with it still queued (`kept`, core `sidecar/held_queue.rs`), held apart from the draft until the user decides: Resume
 * sends it, Edit brings it into the field, Remove drops it. `text` is "" for a picture-only message (stock's `[Image]`
 * chip text is not content); show it with `restoredQueueLabel`.
 */
export interface RestoredQueueItem {
	id: string;
	lane: "steering" | "followUp";
	text: string;
	images: ComposerImage[];
	/** Kept from an omp that ended, not withdrawn by a Stop. */
	kept?: boolean;
}

type QueueLaneName = "steering" | "followUp";

/** The queued message the field is editing, and what Cancel puts back (RA-21). */
export interface EditingQueued {
	id: string;
	lane: QueueLaneName;
	/** The message's text when the edit began: out of stock's queue, held by the core under `token` until Save or Cancel. */
	original: string;
	/** The message's pictures: Save and Cancel queue them again with the text. */
	images: ImageContent[];
	/** The core's hold of the message while it is edited (`queue_hold`). */
	token: string;
	/** Settles once the core holds the message and stock's queue let it go (true), or the edit could not begin (false). */
	began: Promise<boolean>;
	/** The draft and pictures the field held before the edit took it over. */
	snapshot: { draft: string; pictureSlots: DraftPictureSlot[] };
}

export interface ComposerStore {
	draft: string;
	sending: boolean;
	submissionUncertain: boolean;
	/** A Stop was sent for the running turn and the turn has not ended yet: a second click or Esc sends nothing. */
	stopping: boolean;
	/** When the first Esc of "Esc again to stop" was pressed; null when none waits (an edit of the draft disarms it). */
	stopArmedAt: number | null;
	/**
	 * Queued messages the last Stop withdrew, oldest first (steers, then follow-ups). Filled only while a view that
	 * shows them is mounted (`restoredTrayMounted`); otherwise Stop merges them into the draft.
	 */
	restoredQueue: RestoredQueueItem[];
	/** A tray that renders `restoredQueue` is mounted (ComposerRestoredQueue): the only thing that makes Stop keep them apart. */
	restoredTrayMounted: number;
	/** A queued message is being edited in the field (Edit queued): its draft and pictures wait in the snapshot. */
	editingQueued: EditingQueued | null;
	/**
	 * Edits that ended (Save, Cancel) whose message is not back in stock's queue yet: it is queued again only once the
	 * core holds it and stock let it go, and a queue row shown meanwhile could name the copy about to be replaced.
	 */
	editsRequeueing: number;
	noteRequeueing: (delta: 1 | -1) => void;
	setSending: (value: boolean) => void;
	setSubmissionUncertain: (value: boolean) => void;
	setStopping: (value: boolean) => void;
	/** Arm "Esc again to stop"; disarms itself after `DOUBLE_ESC_MS`. */
	armStop: (now?: number) => void;
	disarmStop: () => void;
	/** Hold withdrawn queue entries apart from the draft. */
	holdRestored: (items: Omit<RestoredQueueItem, "id">[]) => void;
	dropRestored: (id: string) => void;
	clearRestored: () => void;
	/** Move held entries (all, or one) into the field: text ahead of the draft, blank-line separated; pictures join the strip. */
	restoreHeldToDraft: (id?: string) => void;
	/** A tray registers while mounted; the count keeps two panes of one store from unregistering each other. */
	setRestoredTrayMounted: (mounted: boolean) => void;
	/** The field takes over a queued message (snapshotting the draft and pictures it held). */
	beginEditQueued: (target: {
		id: string;
		lane: QueueLaneName;
		text: string;
		images?: ImageContent[];
		token: string;
		began: Promise<boolean>;
	}) => void;
	/** Leave the edit: the draft and pictures it replaced come back exactly. */
	endEditQueued: () => void;
	/** The draft's ready (sendable) pictures, in strip order: always `pictureSlots`' ready ones. */
	images: ComposerImage[];
	/** The draft's picture strip in order, saved pictures not read back yet included. */
	pictureSlots: DraftPictureSlot[];
	/** Replace the draft, or compute the next value from the current one
	 * (React setState parity — InputArea's updater-form call sites unchanged). */
	setDraft: (next: string | ((current: string) => string)) => void;
	/**
	 * A list replaces the whole strip (unread saved pictures too); an updater maps the ready pictures, and unread
	 * saved ones keep their places.
	 */
	setImages: (next: ComposerImage[] | ((current: ComposerImage[]) => ComposerImage[])) => void;
	setPictureSlots: (next: DraftPictureSlot[] | ((current: DraftPictureSlot[]) => DraftPictureSlot[])) => void;
	/** Attach pictures (see {@link attachToSlots}); returns how many were already attached. */
	attachImages: (added: readonly ComposerImage[]) => number;
	/** Put a saved draft's pictures in the strip as unread places, at once; a ref already there is not added twice. */
	restorePictureRefs: (refs: readonly DraftPictureRef[]) => void;
	/**
	 * A saved picture's read ended: its picture, or null when it is gone or could not be read. Lands only in the
	 * place still waiting for that very ref (the field's or a queued edit's parked draft); otherwise nothing.
	 */
	resolvePictureRef: (ref: DraftPictureRef, image: ComposerImage | null) => void;
	reset: () => void;
}

let nextRestoredId = 0;

export const createComposerStore = () =>
	createStore<ComposerStore>()((set, get) => ({
		draft: "",
		sending: false,
		submissionUncertain: false,
		stopping: false,
		stopArmedAt: null,
		restoredQueue: [],
		restoredTrayMounted: 0,
		editingQueued: null,
		// Not reset: it counts requeues in flight, and each one takes itself off when it settles.
		editsRequeueing: 0,
		noteRequeueing: delta => set(state => ({ editsRequeueing: Math.max(0, state.editsRequeueing + delta) })),
		setSending: sending => set({ sending }),
		setSubmissionUncertain: submissionUncertain => set({ submissionUncertain }),
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
			set(state => ({
				restoredQueue: [...state.restoredQueue, ...items.map(item => ({ ...item, id: `r${++nextRestoredId}` }))],
			})),
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
					pictureSlots: [...state.pictureSlots, ...taken.flatMap(item => item.images)],
					stopArmedAt: null,
				};
			}),
		setRestoredTrayMounted: mounted =>
			set(state => ({ restoredTrayMounted: Math.max(0, state.restoredTrayMounted + (mounted ? 1 : -1)) })),
		beginEditQueued: ({ id, lane, text, images = [], token, began }) =>
			set(state => ({
				// A second Edit while one runs keeps the first snapshot: Cancel still returns to what the user typed.
				editingQueued: {
					id,
					lane,
					original: text,
					images,
					token,
					began,
					snapshot: state.editingQueued?.snapshot ?? { draft: state.draft, pictureSlots: state.pictureSlots },
				},
				draft: text,
				images: [],
				pictureSlots: [],
				stopArmedAt: null,
			})),
		endEditQueued: () =>
			set(state => {
				const editing = state.editingQueued;
				if (!editing) return state;
				return {
					editingQueued: null,
					draft: editing.snapshot.draft,
					images: readyOf(editing.snapshot.pictureSlots),
					pictureSlots: editing.snapshot.pictureSlots,
					stopArmedAt: null,
				};
			}),
		images: [],
		pictureSlots: [],
		setDraft: next =>
			set(state => {
				const draft = typeof next === "function" ? next(state.draft) : next;
				return draft === state.draft ? state : { draft, stopArmedAt: null };
			}),
		setImages: next =>
			set(state => {
				if (typeof next !== "function") return { images: next, pictureSlots: next };
				const pictureSlots = withReady(state.pictureSlots, next(state.images));
				return { images: readyOf(pictureSlots), pictureSlots };
			}),
		setPictureSlots: next =>
			set(state => {
				const pictureSlots = typeof next === "function" ? next(state.pictureSlots) : next;
				return { pictureSlots, images: readyOf(pictureSlots) };
			}),
		attachImages: added => {
			const { slots, duplicates } = attachToSlots(get().pictureSlots, added);
			if (duplicates < added.length) set({ pictureSlots: slots, images: readyOf(slots) });
			return duplicates;
		},
		restorePictureRefs: refs =>
			set(state => {
				const held = new Set(
					state.pictureSlots.map(slot => (isReadyPicture(slot) ? slot.draftRef?.id : slot.ref.id)),
				);
				const fresh = refs.filter(ref => !held.has(ref.id));
				if (fresh.length === 0) return state;
				return {
					pictureSlots: [...state.pictureSlots, ...fresh.map(ref => ({ ref, status: "pending" as const }))],
				};
			}),
		resolvePictureRef: (ref, image) =>
			set(state => {
				const settle = (slots: DraftPictureSlot[]): DraftPictureSlot[] | null => {
					const at = slots.findIndex(
						slot => !isReadyPicture(slot) && slot.ref === ref && slot.status === "pending",
					);
					if (at === -1) return null;
					const next = [...slots];
					next[at] = image ? { ...image, name: ref.name, draftRef: ref } : { ref, status: "missing" };
					return next;
				};
				const pictureSlots = settle(state.pictureSlots);
				if (pictureSlots) return { pictureSlots, images: readyOf(pictureSlots) };
				const editing = state.editingQueued;
				const parked = editing && settle(editing.snapshot.pictureSlots);
				if (!editing || !parked) return state;
				return { editingQueued: { ...editing, snapshot: { ...editing.snapshot, pictureSlots: parked } } };
			}),
		reset: () =>
			set({
				draft: "",
				images: [],
				pictureSlots: [],
				sending: false,
				submissionUncertain: false,
				stopping: false,
				stopArmedAt: null,
				restoredQueue: [],
				editingQueued: null,
			}),
	}));

const defaultComposerStore = createComposerStore();
export const useComposerStore = createScopedStoreHook("composer", defaultComposerStore);
