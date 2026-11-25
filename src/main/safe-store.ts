/**
 * `electron-store` for the files main writes from events (the prefs, the window geometry): a `set` on a full disk
 * never throws into the caller. conf keeps nothing in memory (every read parses the file), so the value that could not
 * be written is kept here, per file and shared by every store on it (the prefs file has three), and answers reads until
 * it is saved. The save is tried again on the backoff of `atomic-file.ts` and the file joins the one disk-full notice
 * (`disk-full.ts`); a newer `set` replaces what waits. Any other write failure still throws, as it did.
 *
 * A file that no longer parses (a disk error, a hand edit) would throw out of every read, the first one in the store's
 * constructor, and the app would not start. It is moved aside to `<file>.corrupt-<time>` and the store goes on from
 * `<file>.bak`, the last copy that parsed (written at a process's first good read and then at most hourly), else from
 * nothing; `takeRecoveredStores` tells main what was put back so it can say so once.
 *
 * Only the public `store` accessor is wrapped, which every `get`, `set`, `delete` and `has` of conf goes through.
 */
import { readFileSync, renameSync } from "node:fs";
import { basename } from "node:path";
import ElectronStore from "electron-store";
import { DISK_FULL_RETRY_MS, writeFileAtomicSync } from "./atomic-file";
import { diskFull, isDiskFull } from "./disk-full";

const BACKUP_EVERY_MS = 60 * 60_000;
/** File path to when its `.bak` was last written in this process. */
const backedUpAt = new Map<string, number>();

export interface RecoveredStore {
	/** The store's file name (`prefs.json`). */
	file: string;
	/** Where the damaged file went (its name beside the store), or null when it could not be moved. */
	quarantined: string | null;
	/** True when the backup was put back; false when the store starts empty. */
	restored: boolean;
	/** When the backup that was put back was written (ms), when known. */
	backupAt: number | null;
}

const recovered: RecoveredStore[] = [];

/** The stores repaired since the last call, each once. */
export function takeRecoveredStores(): RecoveredStore[] {
	return recovered.splice(0);
}

function backup(path: string, value: unknown): void {
	const last = backedUpAt.get(path);
	if (last !== undefined && Date.now() - last < BACKUP_EVERY_MS) return;
	backedUpAt.set(path, Date.now());
	try {
		writeFileAtomicSync(`${path}.bak`, JSON.stringify({ savedAt: Date.now(), store: value }));
	} catch (error) {
		console.warn(`[prefs] backup of ${path} not written: ${error instanceof Error ? error.message : error}`);
	}
}

function readBackup(path: string): { savedAt: number | null; store: Record<string, unknown> } | null {
	try {
		const parsed = JSON.parse(readFileSync(`${path}.bak`, "utf8")) as { savedAt?: unknown; store?: unknown };
		if (!parsed.store || typeof parsed.store !== "object" || Array.isArray(parsed.store)) return null;
		return {
			savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : null,
			store: parsed.store as Record<string, unknown>,
		};
	} catch {
		return null;
	}
}

/** Moves the unreadable file aside and puts the backup in its place (or nothing, so the store reads empty). */
function repair(path: string): void {
	const aside = `${path}.corrupt-${Date.now()}`;
	let quarantined: string | null = null;
	try {
		renameSync(path, aside);
		quarantined = basename(aside);
	} catch (error) {
		console.warn(`[prefs] ${path} could not be moved aside: ${error instanceof Error ? error.message : error}`);
	}
	const saved = readBackup(path);
	// Written even with no backup: a file that could not be moved aside must still stop failing every read.
	writeFileAtomicSync(path, JSON.stringify(saved?.store ?? {}, undefined, "\t"));
	recovered.push({ file: basename(path), quarantined, restored: saved !== null, backupAt: saved?.savedAt ?? null });
}

interface Waiting {
	/** What the file should hold: the newest whole store that could not be written. */
	value: unknown;
	timer: NodeJS.Timeout | undefined;
	tries: number;
}

/** File path to what waits for room in it. */
const waiting = new Map<string, Waiting>();

function settle(path: string): void {
	const entry = waiting.get(path);
	if (!entry) return;
	clearTimeout(entry.timer);
	waiting.delete(path);
	diskFull.clear(path);
}

function schedule(store: { path: string; store: unknown }, entry: Waiting): void {
	const delay = DISK_FULL_RETRY_MS[Math.min(entry.tries++, DISK_FULL_RETRY_MS.length - 1)] ?? 60_000;
	entry.timer = setTimeout(() => {
		entry.timer = undefined;
		try {
			// The store's own setter: a save that lands settles the file, a full disk keeps waiting.
			store.store = entry.value;
		} catch (error) {
			console.warn(`[prefs] ${store.path} could not be saved: ${error instanceof Error ? error.message : error}`);
			settle(store.path);
			return;
		}
		if (waiting.get(store.path) === entry) schedule(store, entry);
	}, delay);
	entry.timer.unref();
}

function keep(store: { path: string; store: unknown }, value: unknown): void {
	const entry = waiting.get(store.path);
	if (entry) {
		entry.value = value;
		return;
	}
	const created: Waiting = { value, timer: undefined, tries: 0 };
	waiting.set(store.path, created);
	diskFull.report(store.path);
	schedule(store, created);
}

// biome-ignore lint/suspicious/noExplicitAny: electron-store's own constraint on the shape it stores.
export class SafeStore<T extends Record<string, any> = Record<string, unknown>> extends ElectronStore<T> {
	override get store(): T {
		const entry = waiting.get(this.path);
		if (entry) return structuredClone(entry.value as T);
		let value: T;
		try {
			value = super.store;
		} catch (error) {
			if (!(error instanceof Error && error.name === "SyntaxError")) throw error;
			repair(this.path);
			value = super.store;
		}
		backup(this.path, value);
		return value;
	}

	override set store(value: T) {
		try {
			super.store = value;
		} catch (error) {
			if (!isDiskFull(error)) throw error;
			keep(this, structuredClone(value));
			this.events.dispatchEvent(new Event("change"));
			return;
		}
		settle(this.path);
	}
}
