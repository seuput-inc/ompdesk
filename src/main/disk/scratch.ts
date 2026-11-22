/**
 * Disk care for the sessions' scratch folders (`session-scratch.ts`: one folder per tab, named by its process tag).
 * A folder goes
 * - when the last session it served is deleted: at once, unless a tab or tagged process still holds it;
 * - in a run (`sweep`), once no tab holds its tag (a tab of this launch, or one the last launch left that may still
 *   come back), nothing in it changed for `DISK_CARE_ARTIFACT_IDLE_DAYS` and no running process carries its tag:
 *   everything but the files its sessions' replies name, which stay until those sessions are deleted (a reply reads
 *   its picture from the path each time it is shown). A folder whose sessions are all gone waits for no idle days.
 *
 * Kept whole instead: a folder whose session file cannot be read as stock's, one this app has no record of (its
 * sessions are not known) unless it is empty, and every folder where the running processes cannot be listed.
 * Reading and removing are the core's (`crates/core/src/disk/scratch.rs`); what is in use is main's.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { DISK_CARE_ARTIFACT_IDLE_DAYS } from "../../shared/disk-care";
import { CoreError } from "../core/process";
import { coreHeld } from "../local/git/exec";
import { SCRATCH_TAG, type SessionScratch, sessionKey } from "../session-scratch";

const DAY_MS = 24 * 60 * 60_000;
const READ_MS = 10 * 60_000;
const SWEEP_MS = 30 * 60_000;

type TaggedProcesses = ReadonlyArray<{ tag?: string }> | null;

export interface ScratchCareDeps {
	store: Pick<SessionScratch, "root" | "dir" | "records" | "sessionDeleted" | "forget">;
	/** The tags a tab holds, or the last launch left for a tab that may come back. */
	heldTags(): ReadonlySet<string>;
	/** Every running process with its tag; null when they cannot be listed. */
	processes(): Promise<TaggedProcesses>;
	/** Every stored session file of this computer, or null while the session index is unavailable. */
	sessionFiles(): Promise<readonly string[] | null>;
	/** One `disk-care` line. */
	log(message: string, details: Record<string, unknown>): void;
	now?(): number;
}

/** What a run did to the scratch folders, for its summary. */
export interface ScratchSweep {
	/** The bytes of each folder something was removed from. */
	removed: number[];
	kept: number;
	failed: number;
}

interface Swept {
	bytes: number;
	removed: number;
	kept: number;
	left: number;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sessionName = (file: string): string => sessionKey(path.basename(file));

function processHold(tag: string, processes: TaggedProcesses): string | null {
	if (processes === null) return "process check unavailable";
	return processes.some(process => process.tag === tag) ? "a process of its session runs" : null;
}

export class ScratchCare {
	readonly #deps: ScratchCareDeps;

	constructor(deps: ScratchCareDeps) {
		this.#deps = deps;
	}

	get root(): string {
		return this.#deps.store.root;
	}

	/** A session file of this computer was deleted: the folders that served only it go now, whole. */
	async sessionDeleted(sessionPath: string): Promise<void> {
		const files = await this.#deps.sessionFiles().catch((error: unknown) => {
			this.#deps.log("failed", { step: "scratch", error: errorText(error) });
			return null;
		});
		if (files === null) return; // Keep the ownership record until a sweep can rule out a moved copy.
		const key = sessionKey(sessionPath);
		const name = sessionName(sessionPath);
		const moved = files.filter(file => sessionName(file) === name && sessionKey(file) !== key);
		let listed: Promise<TaggedProcesses> | undefined;
		for (const tag of this.#deps.store.sessionDeleted(sessionPath, moved)) {
			// A tab still on the tag (it moved to a session not written yet) keeps its folder; a run takes it later.
			if (this.#deps.heldTags().has(tag)) continue;
			const dir = this.#deps.store.dir(tag);
			try {
				listed ??= this.#deps.processes();
				const hold = processHold(tag, await listed);
				if (hold) {
					this.#deps.log("kept", { path: dir, reason: hold });
					continue;
				}
				if (this.#deps.heldTags().has(tag)) continue;
				await this.#remove(dir, tag, [], "its session was deleted");
			} catch (error) {
				if (error instanceof CoreError && error.code === "scratch_kept") {
					this.#deps.log("kept", { path: dir, reason: error.message });
				} else {
					this.#deps.log("failed", { step: "scratch", path: dir, error: errorText(error) });
				}
			}
		}
	}

	/** One pass over every folder under the root. */
	async sweep(): Promise<ScratchSweep> {
		const result: ScratchSweep = { removed: [], kept: 0, failed: 0 };
		const now = (this.#deps.now ?? Date.now)();
		const names = await fs.readdir(this.root).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [] as string[];
			throw error;
		});
		const records = new Map(this.#deps.store.records().map(record => [record.tag, record]));
		// A record whose folder is gone (removed by hand) names nothing any more.
		for (const tag of records.keys()) {
			if (!names.includes(tag) && !this.#deps.heldTags().has(tag)) this.#deps.store.forget(tag);
		}
		// Listed once, and only when a folder is otherwise ready to go.
		let listed: Promise<TaggedProcesses> | undefined;
		let stored: Promise<Map<string, string[]> | null> | undefined;
		const keep = (dir: string, reason: string): void => {
			result.kept++;
			this.#deps.log("kept", { path: dir, reason });
		};
		for (const tag of names) {
			// Only what this app's tabs were given: any other entry of the folder is not ours to judge.
			if (!SCRATCH_TAG.test(tag) || this.#deps.heldTags().has(tag)) continue;
			const dir = this.#deps.store.dir(tag);
			try {
				const facts = await coreHeld<{ newestMs: number; entries: number }>("disk.scratchFacts", { dir }, READ_MS);
				const record = records.get(tag);
				if (!record && facts.entries > 0) {
					keep(dir, "its sessions are not known");
					continue;
				}
				let sessions: string[] = [];
				if (record?.sessions.length) {
					stored ??= this.#deps
						.sessionFiles()
						.then(files => (files === null ? null : Map.groupBy(files, sessionName)));
					const files = await stored;
					if (files === null) {
						keep(dir, "session list unavailable");
						continue;
					}
					sessions = await existing(record.sessions, files);
				}
				if (sessions.length > 0 && (now - facts.newestMs) / DAY_MS < DISK_CARE_ARTIFACT_IDLE_DAYS) continue;
				listed ??= this.#deps.processes();
				const hold = processHold(tag, await listed);
				if (hold) {
					keep(dir, hold);
					continue;
				}
				// A tab may have taken the tag over while the folder was read.
				if (this.#deps.heldTags().has(tag)) continue;
				const bytes = await this.#remove(
					dir,
					tag,
					sessions,
					sessions.length > 0 ? "idle" : "its sessions are gone",
				);
				if (bytes !== null) result.removed.push(bytes);
			} catch (error) {
				if (error instanceof CoreError && error.code === "scratch_kept") {
					keep(dir, error.message);
					continue;
				}
				result.failed++;
				this.#deps.log("failed", { step: "scratch", path: dir, error: errorText(error) });
			}
		}
		return result;
	}

	/** The core's sweep of one folder; the bytes that went, or null when nothing did. */
	async #remove(dir: string, tag: string, sessions: readonly string[], reason: string): Promise<number | null> {
		const swept = await coreHeld<Swept>("disk.scratchSweep", { dir, sessions }, SWEEP_MS);
		if (swept.kept === 0 && swept.left === 0) this.#deps.store.forget(tag);
		if (swept.removed === 0) return null;
		this.#deps.log("scratch", {
			path: dir,
			bytes: swept.bytes,
			reason,
			...(swept.kept > 0 ? { shownInReplies: swept.kept } : {}),
			...(swept.left > 0 ? { left: swept.left } : {}),
		});
		return swept.bytes;
	}
}

/** Stock can list a moved copy while the original still exists. Replies in either file keep their attachments. */
async function existing(recorded: readonly string[], stored: ReadonlyMap<string, string[]>): Promise<string[]> {
	const found = new Set<string>();
	for (const session of recorded) {
		for (const file of stored.get(sessionName(session)) ?? []) found.add(file);
		if (found.has(session)) continue;
		try {
			await fs.lstat(session);
			found.add(session);
		} catch (error) {
			if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
		}
	}
	return [...found];
}
