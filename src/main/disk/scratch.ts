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
 * Main supplies live tag, process and session facts. The core decides what can go and removes it.
 */

import * as path from "node:path";
import { DISK_CARE_ARTIFACT_IDLE_DAYS } from "../../shared/disk-care";
import { CoreError } from "../core/process";
import { coreHeld } from "../local/git/exec";
import { type SessionScratch, sessionKey } from "../session-scratch";

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
				await this.#remove(dir, tag, [], "its session was deleted", await listed);
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
		let names: Set<string>;
		try {
			names = new Set(await coreHeld<string[]>("disk.scratchTags", { root: this.root }, READ_MS));
		} catch (error) {
			if (!(error instanceof CoreError && error.code === "scratch_kept")) throw error;
			this.#deps.log("kept", { path: this.root, reason: error.message });
			result.kept++;
			return result;
		}
		const records = new Map(this.#deps.store.records().map(record => [record.tag, record]));
		// A record whose folder is gone (removed by hand) names nothing any more.
		for (const tag of records.keys()) {
			if (!names.has(tag) && !this.#deps.heldTags().has(tag)) this.#deps.store.forget(tag);
		}
		// Listed once, and only when a folder is otherwise ready to go.
		let listed: Promise<TaggedProcesses> | undefined;
		let stored: Promise<Map<string, string[]> | null> | undefined;
		const keep = (dir: string, reason: string): void => {
			result.kept++;
			this.#deps.log("kept", { path: dir, reason });
		};
		for (const tag of names) {
			if (this.#deps.heldTags().has(tag)) continue;
			const dir = this.#deps.store.dir(tag);
			try {
				const record = records.get(tag);
				const idle = await coreHeld<boolean>(
					"disk.scratchIdle",
					{
						dir,
						known: record !== undefined,
						now,
						days: DISK_CARE_ARTIFACT_IDLE_DAYS,
					},
					READ_MS,
				);
				let sessions: string[] | null = [];
				if (record?.sessions.length) {
					stored ??= this.#deps
						.sessionFiles()
						.then(files => (files === null ? null : Map.groupBy(files, sessionName)));
					const files = await stored;
					sessions = await coreHeld<string[] | null>(
						"disk.scratchSessions",
						{
							idle,
							candidates:
								files && record.sessions.map(file => ({ file, indexed: files.get(sessionName(file)) ?? [] })),
						},
						READ_MS,
					);
				}
				if (sessions === null) continue;
				listed ??= this.#deps.processes();
				const bytes = await this.#remove(
					dir,
					tag,
					sessions,
					sessions.length > 0 ? "idle" : "its sessions are gone",
					await listed,
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
	async #remove(
		dir: string,
		tag: string,
		sessions: readonly string[],
		reason: string,
		processes: TaggedProcesses,
	): Promise<number | null> {
		const running = processes?.some(process => process.tag === tag) ?? null;
		// A tab can claim the tag while the process list is pending.
		if (running === false && this.#deps.heldTags().has(tag)) return null;
		const swept = await coreHeld<Swept>("disk.scratchSweep", { dir, sessions, running }, SWEEP_MS);
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
