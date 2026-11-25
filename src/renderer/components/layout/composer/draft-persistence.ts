/**
 * Unsent composer text outlives a renderer reload and an app relaunch. The per-tab composer store
 * lives in memory only (it already rides an omp restart, see tabs.ts), so each draft is also kept in
 * localStorage under its session: the session file (the id while there is none), on its device.
 *
 * A session with no message yet is also filed under its folder: stock writes the session file with
 * the first message, so a relaunch opens a new empty session there and the draft follows it. Only a
 * folder draft written before this page loaded is taken (`since`), so a second new tab in the same
 * folder never copies the draft another open tab is typing, and the first tab to take it claims it.
 *
 * Folded pastes are expanded; pictures are filed by opaque ID, never as bytes in localStorage.
 * The newest {@link MAX_DRAFTS} entries stay; a sent, cleared or evicted draft releases its pictures.
 */
import type { OmpApi } from "../../../../shared/ipc-types";
import type { ComposerImage, DraftPictureRef, DraftPictureSlot } from "../../../stores/composer";

const STORAGE_KEY = "omp.composerDrafts";
const MAX_DRAFTS = 50;
/** A draft longer than this is not kept across a reload (one 200k-character draft was a 400 KB rewrite per pause). */
export const MAX_DRAFT_CHARS = 100_000;

export interface DraftOwner {
	/** Paired host's deviceId; absent = this machine. */
	device?: string;
	sessionFile?: string | null;
	sessionId?: string | null;
	cwd?: string | null;
	/** No message yet: the session file may not exist after a relaunch. */
	empty: boolean;
}

export interface DraftKeys {
	session: string;
	folder?: string;
}

interface SavedDraft {
	text: string;
	at: number;
	session?: string;
	images?: DraftPictureRef[];
}

type PictureFiles = OmpApi["draftPictures"];
type PictureError = (name: string, error: unknown) => void;
// A paired page files no picture on the computer: each would go up twice, once for the draft and once when sent, on a
// phone's data and its daily upload quota. Its pictures live in the page, which no automatic reload drops
// (`pageSafeMoment`); one reloaded by hand restores each as the "Attach again" chip.
const pictureFiles = () =>
	typeof window === "undefined" || window.document?.documentElement.dataset.platform === "web"
		? undefined
		: window.omp?.draftPictures;
const reportError: PictureError = (name, error) => console.warn("Draft picture:", name, error);
const pictureRefs = new WeakMap<ComposerImage, DraftPictureRef>();
const failedPuts = new WeakSet<ComposerImage>();

function pictureRef(slot: DraftPictureSlot): DraftPictureRef {
	if ("ref" in slot) return slot.ref;
	const held = slot.draftRef ?? pictureRefs.get(slot);
	if (held) return held;
	const mimeType = slot.content.mimeType;
	const ref = { id: crypto.randomUUID(), name: slot.name || `image.${mimeType.split("/")[1] || "png"}`, mimeType };
	pictureRefs.set(slot, ref);
	return ref;
}

function isPictureRef(value: unknown): value is DraftPictureRef {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"name" in value &&
		typeof value.name === "string" &&
		"mimeType" in value &&
		typeof value.mimeType === "string" &&
		value.mimeType.startsWith("image/")
	);
}

/** Where a draft is filed; undefined until the session is known. */
export function draftKeys(owner: DraftOwner): DraftKeys | undefined {
	const device = owner.device ?? "local";
	const session = owner.sessionFile || owner.sessionId;
	if (!session) return undefined;
	return {
		session: `${device}|session|${session}`,
		folder: owner.empty && owner.cwd ? `${device}|folder|${owner.cwd}` : undefined,
	};
}

function readAll(storage: Storage): Record<string, SavedDraft> {
	try {
		const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const drafts: Record<string, SavedDraft> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value !== "object" || value === null) continue;
			if (!("text" in value) || typeof value.text !== "string" || !("at" in value) || typeof value.at !== "number")
				continue;
			const session = "session" in value && typeof value.session === "string" ? value.session : undefined;
			const images = "images" in value && Array.isArray(value.images) ? value.images.filter(isPictureRef) : [];
			drafts[key] = {
				text: value.text,
				at: value.at,
				...(session === undefined ? {} : { session }),
				...(images.length ? { images } : {}),
			};
		}
		return drafts;
	} catch {
		return {};
	}
}

/** Remove a file only after the last reference (including a folder alias) was successfully unfiled. */
function writeAll(
	storage: Storage,
	before: Record<string, SavedDraft>,
	drafts: Record<string, SavedDraft>,
	files: PictureFiles | undefined,
	onError: PictureError,
): boolean {
	const newest = Object.entries(drafts)
		.sort(([, a], [, b]) => b.at - a.at)
		.slice(0, MAX_DRAFTS);
	try {
		if (newest.length === 0) storage.removeItem(STORAGE_KEY);
		else storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(newest)));
		const kept = new Set(newest.flatMap(([, draft]) => draft.images?.map(ref => ref.id) ?? []));
		for (const old of Object.values(before)) {
			for (const { id, name } of old.images ?? []) {
				if (kept.has(id)) continue;
				kept.add(id);
				void files?.remove(id).catch(error => onError(name, error));
			}
		}
		return true;
	} catch {
		// Storage full or unavailable: the draft stays in memory for this window's life.
		return false;
	}
}

/** Save metadata synchronously (also on pagehide); write the bytes only for newly filed pictures. */
export function saveDraft(
	storage: Storage,
	keys: DraftKeys,
	text: string,
	{
		now = Date.now(),
		pictures = [],
		files = pictureFiles(),
		onError = reportError,
	}: { now?: number; pictures?: readonly DraftPictureSlot[]; files?: PictureFiles; onError?: PictureError } = {},
): "saved" | "cleared" | "tooLarge" {
	const before = readAll(storage);
	const current = before[keys.session];
	const tooLarge = text.length > MAX_DRAFT_CHARS;
	const keep = !tooLarge && (text.trim() !== "" || pictures.length > 0);
	const refs = keep ? pictures.map(pictureRef) : [];
	const unchanged =
		keep &&
		current?.text === text &&
		(current.images?.length ?? 0) === refs.length &&
		refs.every((ref, i) => current.images?.[i]?.id === ref.id);
	if (!unchanged) {
		const drafts = { ...before };
		for (const [key, saved] of Object.entries(drafts)) if (saved.session === keys.session) delete drafts[key];
		delete drafts[keys.session];
		if (keep) {
			const draft = { text, at: now, ...(refs.length ? { images: refs } : {}) };
			drafts[keys.session] = draft;
			if (keys.folder !== undefined) drafts[keys.folder] = { ...draft, session: keys.session };
		}
		if (!writeAll(storage, before, drafts, files, onError)) return tooLarge ? "tooLarge" : keep ? "saved" : "cleared";
	}
	if (keep && files) {
		const held = new Set(current?.images?.map(ref => ref.id));
		for (const slot of pictures) {
			if (!("content" in slot)) continue;
			const ref = pictureRef(slot);
			if (held.has(ref.id) && !failedPuts.has(slot)) continue;
			failedPuts.delete(slot);
			void files.put(ref.id, slot.content).catch(error => {
				failedPuts.add(slot);
				onError(ref.name, error);
			});
		}
	}
	return tooLarge ? "tooLarge" : keep ? "saved" : "cleared";
}

/**
 * The session's own draft, else a folder draft written before `since` (claimed: it moves to this
 * session, so no other tab takes it too).
 */
export function loadDraft(storage: Storage, keys: DraftKeys, since: number, now = Date.now()): SavedDraft | undefined {
	const drafts = readAll(storage);
	const own = drafts[keys.session];
	if (own) return own;
	const folder = keys.folder === undefined ? undefined : drafts[keys.folder];
	if (keys.folder === undefined || !folder || folder.at >= since) return undefined;
	const moved = { ...drafts };
	delete moved[keys.folder];
	const draft = { text: folder.text, at: now, images: folder.images };
	moved[keys.session] = draft;
	writeAll(storage, drafts, moved, pictureFiles(), reportError);
	return draft;
}
