/**
 * Worktrees disk care takes off the disk, losing nothing, and puts back on request.
 *
 * - `dropArtifacts`: the ignored (or untracked) output the project's own tools make again goes; everything else stays.
 * - `saveAndRemoveWorktree`: an idle worktree with work nothing else holds is saved first: tracked changes and
 *   untracked files as one commit on a new `ompdesk/saved/…` branch (never on the worktree's own branch, never on
 *   main; secrets never enter it), and every file git does not keep and no tool makes again (a seeded `.env`
 *   someone edited, a local database, a secret) in a private archive under userData (0700 folders, 0600 files; never
 *   in git, never synced, never uploaded). Only after both are verified and the worktree is unchanged does
 *   `git worktree remove --force` take the folder; the worktree's own branch stays.
 * - `archiveIgnoredData`: the archive alone, before a landed worktree is removed (`git worktree remove` deletes
 *   ignored files without asking).
 * - `restoreSavedWorktree`: `git worktree add` at the old path, the saved changes back in the working tree (not
 *   committed), the repository's own seeding and setup hook, then the archive copied back.
 *
 * The core owns the saved records, archives and gits. Main keeps the shared secret policy, the caller's live
 * `stillSame` proof and removal claim, and the repository's seeding between checkout and archive restore.
 */

import type { SavedWorktree, SavedWorktreeRestore } from "../../shared/disk-care";
import { discardNewWorktree, type WorktreeRef, type WorktreeRemoval } from "../agent-control/branches";
import { CoreError } from "../core/process";
import { coreGit, coreGitAnswer, coreHeld } from "../local/git/exec";
import { prepareWorktree } from "../local/git/worktree-seed";
import { LocalCommandError } from "../local/types";
import { ompsExitedIn } from "../omp-exits";
import type { BeforeRemove } from "../worktree-orphans";
import { withRemovalClaim } from "../worktree-removals";
import { diskBytes } from "./tree-sizes";
import {
	inProgressOperation,
	looksSecret,
	processInside,
	processWorkingFolders,
	readWorktreeFiles,
	secretIn,
	type WorktreeFiles,
} from "./worktree-facts";

/**
 * Deadlines of the core requests: the slow gits of a save and a restore (`add -A` of a big tree, `worktree add`,
 * `worktree remove`) and the copy of an archive (up to 512 MB, cloned where the volume can).
 */
const SLOW_MS = 300_000;
const ARCHIVE_COPY_MS = 10 * 60_000;
const ARCHIVE_STEP_MS = 60_000;
/** Build output to drop is measured, then removed. */
const DROP_MS = 30 * 60_000;

/** Why a worktree was left in place; the runtime log carries it. */
export class KeepWorktree extends Error {}

/** The core's refusal to save (`keep_worktree`) as the `KeepWorktree` callers catch. */
async function saveStep<T>(request: Promise<T>): Promise<T> {
	try {
		return await request;
	} catch (error) {
		if (error instanceof CoreError && error.code === "keep_worktree") throw new KeepWorktree(error.message);
		throw error;
	}
}

/** The saved records and their archives: `<dir>/saved.json`, `<dir>/saved/<id>/`. */
export class SavedWorktreeStore {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	list(primary: string): Promise<SavedWorktree[]> {
		return coreHeld("disk.savedWorktrees", { dir: this.dir, cwd: process.cwd(), primary }, ARCHIVE_STEP_MS);
	}

	find(lookup: { folder: string } | { id: string }): Promise<SavedWorktree | null> {
		return coreHeld("disk.findSavedWorktree", { dir: this.dir, cwd: process.cwd(), ...lookup }, ARCHIVE_STEP_MS);
	}

	settle(record: SavedWorktree, removed: boolean): Promise<void> {
		return coreHeld("disk.settleArchive", { dir: this.dir, record, removed }, ARCHIVE_COPY_MS);
	}
}

let store: SavedWorktreeStore | null = null;

/** Set once at startup (index.ts); the local handlers and disk care read it. */
export function setSavedWorktreeStore(next: SavedWorktreeStore): void {
	store = next;
}

export function savedWorktreeStore(): SavedWorktreeStore {
	if (!store) throw new LocalCommandError("OMPdesk is still starting; try again in a moment.", "not_ready");
	return store;
}

/** What the archive must hold: ignored entries no tool makes again, plus untracked or changed files that hold secrets. */
async function archiveEntries(
	worktree: string,
	files: WorktreeFiles,
): Promise<{ archive: string[]; secrets: string[]; overwrite: string[] }> {
	const secrets: string[] = [];
	const overwrite: string[] = [];
	for (const candidate of [...files.untrackedFiles, ...files.changed]) {
		if (!(await looksSecret(worktree, candidate))) continue;
		secrets.push(candidate);
		if (files.changed.includes(candidate)) overwrite.push(candidate);
	}
	const archive = [...files.ignored.filter(entry => !entry.regenerable).map(entry => entry.path), ...secrets];
	return { archive, secrets, overwrite };
}

export interface SaveTarget {
	path: string;
	primary: string;
	branch: string | null;
	/** Commits nothing else holds (the worktree is unlanded). */
	unlanded: boolean;
}

/** What a save's checks found: HEAD, whether anything is staged, the staged files with content in the index. */
interface SaveChecked {
	head: string;
	staged: boolean;
	stagedFiles: string[];
}

interface PreparedSave {
	record: SavedWorktree;
	savedSha: string | null;
}

/**
 * Save the worktree (branch, archive) and remove its folder. `files` is the read the caller judged; `stillSame`
 * re-reads right before the removal and answers whether nothing moved. Throws `KeepWorktree` when it keeps it.
 */
export async function saveAndRemoveWorktree(
	target: SaveTarget,
	files: WorktreeFiles,
	saved: SavedWorktreeStore,
	stillSame: () => Promise<boolean>,
): Promise<SavedWorktree> {
	const { archive, secrets, overwrite } = await archiveEntries(target.path, files);
	const regenerableUntracked = files.untracked.filter(entry => entry.regenerable).map(entry => entry.path);
	const exclude = [...secrets, ...regenerableUntracked];
	// HEAD, the size of the untracked files, whether a restore could rewrite bytes, then what is staged.
	const checked = await saveStep(
		coreGit<SaveChecked>(
			"disk.saveCheck",
			{ worktree: target.path, untrackedFiles: files.untrackedFiles, exclude },
			7,
		),
	);
	// Each staged file read whole, one at a time, until the first that names or holds a secret: a staged blob cannot
	// be left out of the index's tree, so such a file keeps the worktree.
	for (const file of checked.stagedFiles) {
		const blob = await coreGitAnswer<{ complete: boolean; bytes: number }>(
			"disk.stagedBlob",
			{ worktree: target.path, path: file },
			1,
		);
		const bytes = blob.bin ? Buffer.from(blob.bin.buffer, blob.bin.byteOffset, blob.bin.byteLength) : Buffer.alloc(0);
		if (secretIn(file, bytes, blob.result.complete && bytes.length === blob.result.bytes))
			throw new KeepWorktree(`a staged file may hold a secret (${file})`);
	}
	const dir = saved.dir;
	// HEAD → what was staged → the working tree: the index and the working tree each come back as they were. The core
	// takes the branch and the archive back when the archive fails.
	const prepared = await saveStep(
		coreGit<PreparedSave>(
			"disk.saveWork",
			{ dir, target, head: checked.head, staged: checked.staged, exclude, archive, overwrite },
			6,
			5 * SLOW_MS + ARCHIVE_COPY_MS,
		),
	);
	let unchanged: boolean;
	try {
		unchanged = await stillSame();
	} catch (error) {
		await coreGit("disk.finishSave", { dir, prepared, unchanged: null }, 1);
		throw error;
	}
	if (!unchanged) {
		await coreGit("disk.finishSave", { dir, prepared, unchanged: false }, 1);
		throw new KeepWorktree("it changed while it was being saved");
	}
	// The core publishes the record before it removes anything. An interrupted removal keeps every recovery copy.
	const regenerable = files.ignored.filter(entry => entry.regenerable).map(entry => entry.path);
	return saveStep(
		coreGit<SavedWorktree>(
			"disk.finishSave",
			{ dir, prepared, unchanged, exclude, regenerable },
			5,
			4 * SLOW_MS + ARCHIVE_COPY_MS,
		),
	);
}

/** The archive alone, recorded as saved when it holds anything (a landed worktree about to be removed). */
async function archiveIgnoredData(
	target: { path: string; primary: string; branch: string | null },
	files: WorktreeFiles,
	saved: SavedWorktreeStore,
): Promise<SavedWorktree | null> {
	const { archive } = await archiveEntries(target.path, files);
	if (archive.length === 0) return null;
	return saveStep(
		coreGit<SavedWorktree | null>("disk.archive", { dir: saved.dir, target, entries: archive }, 1, ARCHIVE_COPY_MS),
	);
}

/**
 * The `prepare` of every landed-worktree removal (`removeOrphanWorktree`): keeps one a known process works in, then
 * archives what no tool makes again and records it once the folder went. `measured` hears each worktree's size.
 */
export function archiveBeforeRemove(
	saved: SavedWorktreeStore,
	folders: readonly string[] | null,
	measured?: Map<string, number>,
): BeforeRemove {
	return async worktree => {
		if (folders !== null && processInside(worktree.path, folders)) throw new KeepWorktree("a process works in it");
		const operation = await inProgressOperation(worktree.path);
		if (operation) throw new KeepWorktree(`a git operation is half done (${operation})`);
		const files = await readWorktreeFiles(worktree.path);
		measured?.set(worktree.path, await diskBytes(worktree.path));
		const record = await archiveIgnoredData(
			{ path: worktree.path, primary: worktree.repo, branch: worktree.branch },
			files,
			saved,
		);
		return async removed => {
			if (record) await saved.settle(record, removed);
		};
	};
}

/** How long a discard waits for the closed tab's omp (and, where readable, any process) to leave the worktree. */
const DISCARD_EXIT_WAIT_MS = 5_000;
const DISCARD_EXIT_POLL_MS = 250;

export interface DiscardDeps {
	/** Every folder a session of this computer has open (windows' tabs and those run for paired devices). */
	openFolders: () => readonly string[];
	/** The working folders of running processes; null where the platform cannot tell (Windows). */
	processes?: () => Promise<string[] | null>;
	/** Whether every omp this computer stopped in the folder has exited (`ompsExitedIn`). */
	ompsExited?: (folder: string, timeoutMs: number) => Promise<boolean>;
	store?: () => SavedWorktreeStore;
	pause?: (ms: number) => Promise<void>;
}

/**
 * A failed open's unused worktree and branch (`discardNewWorktree`), removed under the removal claim every removal
 * takes (`withRemovalClaim`: no session of this computer may have it open, and none starts there meanwhile), once the
 * closed tab's omp has exited (`omp-exits.ts`, the signal that holds on every platform) and, where process folders
 * can be read, no other process works in it; either still there after a few seconds keeps it. What no tool makes
 * again is archived first.
 */
export function discardOpenedWorktree(worktree: WorktreeRef, deps: DiscardDeps): Promise<WorktreeRemoval> {
	const processes = deps.processes ?? processWorkingFolders;
	const pause =
		deps.pause ??
		((ms: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, ms);
			return promise;
		});
	return withRemovalClaim(worktree.path, deps.openFolders, async () => {
		if (!(await (deps.ompsExited ?? ompsExitedIn)(worktree.path, DISCARD_EXIT_WAIT_MS))) return null;
		let folders = await processes();
		for (
			let waited = 0;
			folders !== null && processInside(worktree.path, folders) && waited < DISCARD_EXIT_WAIT_MS;
		) {
			await pause(DISCARD_EXIT_POLL_MS);
			waited += DISCARD_EXIT_POLL_MS;
			folders = await processes();
		}
		if (folders !== null && processInside(worktree.path, folders)) return null;
		return discardNewWorktree(worktree, archiveBeforeRemove((deps.store ?? savedWorktreeStore)(), folders));
	});
}

/** What the tab spawn asks of this computer's saved worktrees (`SpawnTabDeps.savedWorktrees`). */
export const savedWorktreesForSpawn = {
	async find(folder: string): Promise<SavedWorktree | null> {
		return savedWorktreeStore().find({ folder });
	},
	restore: (id: string) => restoreSavedWorktree(id, savedWorktreeStore()),
};

/** The saved worktrees of `cwd`'s repository, newest removal first. */
export function listSavedWorktrees(primary: string, saved: SavedWorktreeStore): Promise<SavedWorktree[]> {
	return saved.list(primary);
}

/**
 * Put a saved worktree back at its old path: on its branch when the branch still points where it did and no other
 * worktree has it checked out, else detached at the saved HEAD; the saved changes as uncommitted work; then the
 * repository's seeding and setup hook; then the archive over whatever those made (the archived bytes win; a file
 * something else made there is set aside as `<name>.ompdesk-before-restore`, never deleted). The record and archive
 * go only when every archived file came back; otherwise both stay.
 */
export async function restoreSavedWorktree(id: string, saved: SavedWorktreeStore): Promise<SavedWorktreeRestore> {
	const record = await saved.find({ id });
	if (!record) throw new LocalCommandError(`No saved worktree ${id}.`, "not_saved");
	let checkout: { onBranch: boolean; root: [number, number, number, number] };
	try {
		checkout = await coreGit<typeof checkout>(
			"disk.restoreCheckout",
			{
				path: record.path,
				repo: record.repo,
				branch: record.branch,
				head: record.head,
				savedBranch: record.savedBranch,
				staged: record.staged ?? null,
			},
			6,
			SLOW_MS,
		);
	} catch (error) {
		if (error instanceof CoreError && error.code === "path_exists")
			throw new LocalCommandError(error.message, "path_exists");
		throw error;
	}
	await prepareWorktree(record.repo, record.path);
	const archive = await coreHeld<{ restored: number; skipped: number }>(
		"disk.finishRestore",
		{ dir: saved.dir, record, root: checkout.root },
		ARCHIVE_COPY_MS,
	);
	return { path: record.path, branch: checkout.onBranch ? record.branch : null, archive };
}

/** Removes the regenerable entries of `files`; each with what it took (allocated bytes, measured before). */
export function dropArtifacts(
	worktree: string,
	files: WorktreeFiles,
): Promise<{ path: string; bytes: number; reason: string }[]> {
	const entries = [...files.ignored, ...files.untracked].flatMap(entry =>
		entry.regenerable ? [{ path: entry.path, reason: entry.regenerable.reason }] : [],
	);
	return entries.length === 0 ? Promise.resolve([]) : coreHeld("disk.dropArtifacts", { worktree, entries }, DROP_MS);
}
