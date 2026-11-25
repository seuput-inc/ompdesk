/**
 * Review notes: what a person marks while reviewing (a diff line or range, a whole changed file, a passage of a
 * Markdown or code file, an element or region of the Preview's page) with a comment for the agent. Notes collect per
 * session and leave together as one message (`lib/review-notes.ts` `reviewNotesMessage`) into the composer of the
 * session the person picks (`lib/composer-handoff.ts`); a note that left is gone, as Orca's delivered notes are
 * (`create-diff-comments-slice.ts` `clearDeliveredDiffComments`).
 *
 * One store for every source. A note belongs to its session (`notesOwner`, the outbox's key: a computer that restarted
 * gives its tabs new ids), so a relaunch, a page change in the Preview or a closed side panel never drops it. Kept in
 * `localStorage` like the outbox; every window of this origin shares the one list (`storage` events). The newest
 * `NOTES_LIMIT` notes are kept.
 */
import { create } from "zustand";
import type { PreviewElement } from "../../shared/preview";
import { outboxSession } from "./outbox";
import { useTabsStore } from "./tabs";

/** A 1-based line range of a file, `start <= end`. */
export interface NoteLines {
	start: number;
	end: number;
}

/** Where a note sits. */
export type ReviewNoteAnchor =
	/** A changed file in the Changes diff: lines on its new side, or the whole file when `lines` is null. */
	| { kind: "diff"; path: string; lines: NoteLines | null }
	/** A passage of a file in the Files viewer; `lines` when the source view showed them. */
	| { kind: "text"; path: string; markdown: boolean; lines: NoteLines | null; excerpt: string }
	/** An element or region of the Preview's page, numbered per page as its pin is. */
	| {
			kind: "preview";
			/** The Preview tab and address (`previewPageKey`). */
			page: string;
			title: string;
			url: string;
			n: number;
			pick: "element" | "region";
			elements: PreviewElement[];
			/** A region's screenshot, PNG base64. */
			image?: string;
	  };

export interface ReviewNote {
	id: string;
	/** `notesOwner` of the session the note belongs to. */
	owner: string;
	anchor: ReviewNoteAnchor;
	body: string;
	createdAt: number;
}

export const NOTES_LIMIT = 500;
const STORAGE_KEY = "omp.review-notes.v1";

/** The session a note belongs to (the outbox's key: the computer and the session id, the tab's while it has none). */
export const notesOwner = outboxSession;

/** A Preview page's key: the Preview tab and its address. */
export function previewPageKey(state: { activeTab: string | null; url: string }): string {
	return `${state.activeTab ?? ""}\n${state.url}`;
}

function storage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

function isNote(value: unknown): value is ReviewNote {
	if (typeof value !== "object" || value === null) return false;
	if (!("id" in value && "owner" in value && "body" in value && "createdAt" in value && "anchor" in value))
		return false;
	const { id, owner, body, createdAt, anchor } = value;
	return (
		typeof id === "string" &&
		typeof owner === "string" &&
		typeof body === "string" &&
		typeof createdAt === "number" &&
		typeof anchor === "object" &&
		anchor !== null &&
		"kind" in anchor &&
		(anchor.kind === "diff" || anchor.kind === "text" || anchor.kind === "preview")
	);
}

function readStored(): ReviewNote[] | null {
	const store = storage();
	if (!store) return null;
	try {
		const parsed: unknown = JSON.parse(store.getItem(STORAGE_KEY) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter(isNote) : [];
	} catch {
		return [];
	}
}

type PreviewAnchor = Extract<ReviewNoteAnchor, { kind: "preview" }>;

/** What `add` takes: the store gives the id, the time and (for a Preview note) its number on the page. */
export type NewReviewNote = Omit<ReviewNote, "id" | "createdAt" | "anchor"> & {
	anchor: Exclude<ReviewNoteAnchor, PreviewAnchor> | Omit<PreviewAnchor, "n">;
};

interface ReviewNotesStore {
	notes: ReviewNote[];
	/** False once a write did not fit in the browser's storage: the notes would not outlive a reload. */
	saved: boolean;
	add: (note: NewReviewNote) => ReviewNote;
	/** Change a note's text or place (a Preview pin moved to its element's parent). */
	update: (id: string, change: Partial<Pick<ReviewNote, "body" | "anchor">>) => void;
	remove: (ids: readonly string[]) => void;
	/** Move one key's notes to another (a tab that got its session). */
	rekey: (from: string, to: string) => void;
	/** Read the list again (another window changed it). */
	reload: () => void;
	reset: () => void;
}

export const useReviewNotesStore = create<ReviewNotesStore>()((set, get) => {
	/** Apply `change` to the stored list (another window may have changed it since this one read it) and keep it. */
	const write = (change: (notes: ReviewNote[]) => ReviewNote[]) => {
		const next = change(readStored() ?? get().notes).slice(-NOTES_LIMIT);
		let saved = true;
		try {
			const store = storage();
			if (store) {
				if (next.length === 0) store.removeItem(STORAGE_KEY);
				else store.setItem(STORAGE_KEY, JSON.stringify(next));
			}
		} catch {
			saved = false;
		}
		set({ notes: next, saved });
	};
	return {
		notes: readStored() ?? [],
		saved: true,
		add: input => {
			const result: { note?: ReviewNote } = {};
			const page = input.anchor.kind === "preview" ? input.anchor.page : null;
			write(notes => {
				const n =
					1 +
					notes.reduce(
						(max, note) =>
							note.owner === input.owner && note.anchor.kind === "preview" && note.anchor.page === page
								? Math.max(max, note.anchor.n)
								: max,
						0,
					);
				const anchor: ReviewNoteAnchor = input.anchor.kind === "preview" ? { ...input.anchor, n } : input.anchor;
				const note: ReviewNote = { ...input, anchor, id: crypto.randomUUID(), createdAt: Date.now() };
				result.note = note;
				return [...notes, note];
			});
			if (!result.note) throw new Error("review note not added");
			return result.note;
		},
		update: (id, change) => write(notes => notes.map(note => (note.id === id ? { ...note, ...change } : note))),
		remove: ids => {
			const gone = new Set(ids);
			write(notes => notes.filter(note => !gone.has(note.id)));
		},
		rekey: (from, to) => write(notes => notes.map(note => (note.owner === from ? { ...note, owner: to } : note))),
		reload: () => {
			const stored = readStored();
			if (stored) set({ notes: stored });
		},
		reset: () => set({ notes: [], saved: true }),
	};
});

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
	window.addEventListener("storage", event => {
		if (event.key === STORAGE_KEY || event.key === null) useReviewNotesStore.getState().reload();
	});
}

// A tab's first message gives it its session: notes written before then follow it to the session's key.
useTabsStore.subscribe((state, previous) => {
	for (const tab of state.tabs) {
		if (!tab.sessionId) continue;
		const before = previous.tabs.find(entry => entry.id === tab.id);
		if (!before || before.sessionId) continue;
		const from = notesOwner(before);
		const to = notesOwner(tab);
		if (useReviewNotesStore.getState().notes.some(note => note.owner === from))
			useReviewNotesStore.getState().rekey(from, to);
	}
});

/** One session's notes, oldest first. */
export function notesOf(notes: readonly ReviewNote[], owner: string): ReviewNote[] {
	return notes.filter(note => note.owner === owner);
}
