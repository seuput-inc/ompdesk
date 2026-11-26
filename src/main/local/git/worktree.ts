/**
 * `worktree_create` / `worktree_remove` (port of fork rpc-worktree.ts). The gits and their rules (base and branch
 * checks, `worktree add` and its branch rollback, the checks before a removal, the removal) run in the core process
 * (`native/ompdesk/crates/core/src/git/worktree.rs`). Main gets stock's worktree root and repo hash through the
 * bridge and holds the repository lock while the core selects a free name and creates the checkout.
 * Collisions suffix `-2..-100` on the folder and on generated branch names. Removal keeps the branch and
 * requires a linked checkout registered by git under the canonical root.
 * Kept over stock createSessionWorktree: GUI names/baseRef differ and never carry
 * uncommitted changes. Removal deliberately retains branches; session exit safety
 * still runs in main after omp has gone, unlike stock removeExitWorktrees.
 */

import * as path from "node:path";
import type { RpcWorktreeCreateResult, WorktreeBaseFetch } from "../../../shared/rpc-types";
import { GUI_WORKTREE_BRANCH_PREFIX, worktreeBranchPrefix } from "../../../shared/worktree-branch";
import { CoreError } from "../../core/process";
import { SerialChain } from "../../serial-chain";
import { stockHelperRequest } from "../../stock-helper";
import { type BridgeClient, LocalCommandError } from "../types";
import { primaryRoot, repoRoot } from "./changes";
import { coreGit, coreHeld, DEFAULT_TIMEOUT_MS, withRepoLock } from "./exec";
import { worktreeSlug } from "./parse";
import { archiveHookRefusal, prepareWorktree, SETUP_TIMEOUT_MS, WORKTREE_PREPARE_BUDGET_MS } from "./worktree-seed";

/** `git worktree add` checks out the whole tree: minutes on a large repository. */
export const WORKTREE_ADD_TIMEOUT_MS = 300_000;
const WORKTREE_REMOVE_TIMEOUT_MS = 120_000;
/** The fetch of the remote default branch before a `default`-based worktree (the core's own timeout). */
const BASE_FETCH_TIMEOUT_MS = 60_000;
/** The plan's gits: repo root, primary root, default branch, its sha before and after the fetch, count, subjects. */
const PLAN_ROUNDS = 7;
const PLAN_AND_ADD_MS = (PLAN_ROUNDS + 3) * DEFAULT_TIMEOUT_MS + BASE_FETCH_TIMEOUT_MS + WORKTREE_ADD_TIMEOUT_MS;
/** A create request's answer, by `<caller>:<requestId>`, is kept this long for the caller's retry. */
const CREATE_REQUEST_KEEP_MS = 10 * 60_000;
/**
 * Longest each command runs before main answers, counting every git step on
 * its slowest path at that step's timeout. The renderer's RPC timeouts
 * (shared/rpc-client.ts) must not be shorter, or it reports a failure while
 * the work still lands.
 */
export const WORKTREE_COMMAND_BUDGETS_MS = {
	// Planning (its fetch of the remote default branch included), stock's location, waiting for the lock and every
	// attempt share one cancellable step.
	worktree_create: PLAN_AND_ADD_MS + WORKTREE_PREPARE_BUDGET_MS,
	// The seed and setup of a worktree `worktree_create {prepare: false}` made (the new task sheet's own step).
	worktree_prepare: 2 * DEFAULT_TIMEOUT_MS + WORKTREE_PREPARE_BUDGET_MS,
	worktree_prefetch: PLAN_ROUNDS * DEFAULT_TIMEOUT_MS + BASE_FETCH_TIMEOUT_MS,
	// Repo root, primary root, status, the archive hook, prune, and `worktree remove` itself.
	worktree_remove: 4 * DEFAULT_TIMEOUT_MS + SETUP_TIMEOUT_MS + WORKTREE_REMOVE_TIMEOUT_MS,
} as const;

/** The codes the core refuses a worktree step with, which the page gets as the command's `code`. */
const REFUSALS = new Set([
	"not_a_repo",
	"invalid_base",
	"invalid_name",
	"worktree_create_failed",
	"not_a_worktree",
	"worktree_outside_root",
	"worktree_dirty",
	"worktree_remove_failed",
]);

/** One worktree request to the core (`rounds`, `slowMs`: see `coreGit`); its refusals keep their code. */
export async function worktreeGit<T>(method: string, params: object, rounds: number, slowMs?: number): Promise<T> {
	try {
		return await coreGit<T>(method, params, rounds, slowMs);
	} catch (error) {
		if (error instanceof CoreError && REFUSALS.has(error.code))
			throw new LocalCommandError(error.message, error.code);
		throw error;
	}
}

/** Main cannot import pi-utils' Bun hash or its live worktree.base override. */
export async function stockWorktreeLocation(
	bridge: Pick<BridgeClient, "request">,
	primaryRoot: string,
): Promise<{ root: string; hash: string }> {
	const location = await bridge.request<{ root: string; hash: string }>("git.worktree_location", { primaryRoot });
	if (
		!location ||
		typeof location.root !== "string" ||
		!path.isAbsolute(location.root) ||
		typeof location.hash !== "string" ||
		!/^[0-9a-f]{7}$/.test(location.hash)
	) {
		throw new Error("omp returned an invalid worktree location");
	}
	return location;
}

/** The branch a worktree gets when the caller names it (`RpcCommand` `worktree_create.branch`), or undefined when malformed. */
export type WorktreeBranchSource = {
	name: string;
	mode: "new" | "local" | "remote" | "reuse";
	remote?: string;
	/** `new` and `reuse`: the ref a new branch starts at (default the create's base). */
	from?: string;
};

export function worktreeBranchSource(value: unknown): WorktreeBranchSource | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { name, mode, remote, from } = value as Record<string, unknown>;
	if (
		typeof name !== "string" ||
		!name ||
		(mode !== "new" && mode !== "local" && mode !== "remote" && mode !== "reuse")
	)
		return undefined;
	if (mode === "remote" && (typeof remote !== "string" || !remote || remote.startsWith("-"))) return undefined;
	if (from !== undefined && (typeof from !== "string" || !from || from.startsWith("-"))) return undefined;
	return {
		name,
		mode,
		...(typeof remote === "string" && remote ? { remote } : {}),
		...(typeof from === "string" ? { from } : {}),
	};
}

interface CreateInput {
	name: string;
	baseCwd?: string;
	baseRef?: string;
	branchPrefix?: string;
	branch?: WorktreeBranchSource;
	/** A preset of the repository's `.ompdesk/sparse` (core `git/sparse.rs`): only its folders are checked out. */
	sparse?: string;
	/** False: leave the seed and setup hook to `prepareCreatedWorktree`, the caller's next step. */
	prepare?: boolean;
}

const createRequests = new Map<string, { args: string; made: Promise<RpcWorktreeCreateResult>; at: number }>();

let recordedFolders: () => Promise<readonly string[]> = async () => [];

/**
 * The folders saved sessions recorded as their working folder (index.ts: the session index). A new worktree never
 * takes one (FX22): stock keys a session's history by its folder, so a removed worktree's sessions would read as the
 * new one's and open in it.
 */
export function setRecordedFoldersSource(source: () => Promise<readonly string[]>): void {
	recordedFolders = source;
}

/** The repository's sparse checkout presets (`.ompdesk/sparse` in its main checkout); none outside a repository. */
export function sparsePresets(cwd: string): Promise<{ name: string; folders: string[] }[]> {
	return worktreeGit("git.sparsePresets", { cwd }, 3);
}

let branchRenamed: (path: string, from: string, branch: string) => void = () => {};

/** Who follows a renamed branch in the tabs bound to its worktree (index.ts: the pool's records). */
export function setBranchRenamedListener(listener: (path: string, from: string, branch: string) => void): void {
	branchRenamed = listener;
}

/**
 * A new task's worktree branch named for its work (FS91): `from` becomes `to` (or `to-2`…) in the checkout at `cwd`
 * while it is still out there and never published; `branch` null when nothing was renamed (core `rename_unpushed`).
 * It holds the lock the Changes panel's push takes in that checkout (`scm.ts` `mutate`, keyed by its root), so no push
 * of ours runs between its checks and `git branch -m`; an agent's own push is caught by the core's check after it.
 * Every tab bound to that worktree on `from` then names the new branch.
 */
export async function renameUnpushedBranch(cwd: string, from: string, to: string): Promise<{ branch: string | null }> {
	const root = (await repoRoot(cwd)) ?? cwd;
	// Two `ls-remote` per remote at 30 s each (core `LS_REMOTE_MS`) beside a dozen local reads.
	const renamed = await withRepoLock(root, () =>
		worktreeGit<{ branch: string | null }>("git.renameUnpushed", { cwd, from, to }, 12, 60_000),
	);
	if (renamed.branch) branchRenamed(cwd, from, renamed.branch);
	return renamed;
}

/**
 * A create that names its request (`caller`: the paired device asking, else "local"; `id`: the caller's id for this
 * one create) answers every repeat of that request with the same worktree (a retry after a lost answer), refuses the
 * id with other arguments, and forgets a failed one so its retry runs again.
 */
export function createWorktree(
	sessionCwd: string,
	input: CreateInput & { request?: { caller: string; id: string } },
	bridge: Pick<BridgeClient, "request">,
): Promise<RpcWorktreeCreateResult> {
	const { request, ...args } = input;
	if (!request) return createWorktreeOnce(sessionCwd, args, bridge);
	const now = Date.now();
	for (const [key, entry] of createRequests) if (now - entry.at > CREATE_REQUEST_KEEP_MS) createRequests.delete(key);
	const key = `${request.caller}:${request.id}`;
	const argsKey = JSON.stringify([
		args.name,
		args.baseCwd ?? sessionCwd,
		args.baseRef,
		args.branchPrefix,
		args.branch,
		args.sparse,
		args.prepare,
	]);
	const known = createRequests.get(key);
	if (known) {
		if (known.args === argsKey) return known.made;
		return Promise.reject(
			new LocalCommandError("This request id was used for a different worktree", "invalid_request"),
		);
	}
	const made = createWorktreeOnce(sessionCwd, args, bridge);
	createRequests.set(key, { args: argsKey, made, at: now });
	made.catch(() => {
		if (createRequests.get(key)?.made === made) createRequests.delete(key);
	});
	return made;
}

/** The remote default branch fetched ahead of a create (the worktree dialog when it opens); null outside a repository or without one. */
export function prefetchWorktreeBase(cwd: string): Promise<WorktreeBaseFetch | null> {
	return worktreeGit("git.worktreePrefetch", { cwd }, PLAN_ROUNDS, BASE_FETCH_TIMEOUT_MS);
}

async function createWorktreeOnce(
	sessionCwd: string,
	input: CreateInput,
	bridge: Pick<BridgeClient, "request">,
): Promise<RpcWorktreeCreateResult> {
	const step = new SerialChain({ name: "worktree create", maxStepMs: PLAN_AND_ADD_MS });
	const { primary, made, base } = await step.run(() => planAndAdd(sessionCwd, input, bridge), input.name);
	const prepared = input.prepare === false ? {} : await prepareWorktree(primary, made.path);
	return { ...made, ...(base ? { base } : {}), ...prepared };
}

/**
 * The seed and setup hook of a worktree a `worktree_create {prepare: false}` made, as their own step (the new task
 * sheet shows each step on its row): `worktreePath` must be a linked worktree of `baseCwd`'s repository.
 */
export async function prepareCreatedWorktree(
	baseCwd: string,
	worktreePath: string,
): Promise<Pick<RpcWorktreeCreateResult, "seed" | "setup">> {
	const [primary, own] = await Promise.all([primaryRoot(baseCwd), primaryRoot(worktreePath)]);
	if (own !== primary || path.resolve(worktreePath) === path.resolve(primary))
		throw new LocalCommandError(`Not a worktree of ${primary}: ${worktreePath}`, "not_a_worktree");
	return prepareWorktree(primary, worktreePath);
}

async function planAndAdd(sessionCwd: string, input: CreateInput, bridge: Pick<BridgeClient, "request">) {
	const slug = worktreeSlug(input.name);
	if (!slug) {
		throw new LocalCommandError(
			`Invalid worktree name "${input.name}" — use 1-41 chars of [a-z0-9-], starting with a letter or digit.`,
			"invalid_name",
		);
	}
	const branchPrefix =
		input.branchPrefix === undefined ? GUI_WORKTREE_BRANCH_PREFIX : worktreeBranchPrefix(input.branchPrefix);
	if (branchPrefix === null) {
		throw new LocalCommandError(`Invalid worktree branch prefix "${input.branchPrefix}".`, "invalid_name");
	}
	const baseCwd = input.baseCwd ?? sessionCwd;
	// Check before resolving Git so a missing base still names the folder when Git is unavailable.
	const stat = await coreHeld<{ directory: boolean }>("fs.stat", { path: baseCwd }, PLAN_AND_ADD_MS).catch(
		(error: unknown) => {
			if (error instanceof CoreError && ["file_not_found", "io", "exists"].includes(error.code)) return null;
			throw error;
		},
	);
	if (!stat?.directory) {
		throw new LocalCommandError(`The folder "${baseCwd}" does not exist.`, "file_not_found");
	}
	// The repository, its main checkout, and the commit a new branch starts at (`HEAD`, `default` fetched first, or a
	// ref it has).
	const { primary, startPoint, mainCheckout, base } = await worktreeGit<{
		primary: string;
		startPoint: string;
		mainCheckout: string;
		base?: WorktreeBaseFetch;
	}>(
		"git.worktreePlan",
		{ cwd: baseCwd, checkoutSpelling: path.resolve(baseCwd), baseRef: input.baseRef },
		PLAN_ROUNDS,
		BASE_FETCH_TIMEOUT_MS,
	);
	const { root, hash } = await stockWorktreeLocation(bridge, primary);
	// Only a worktree's folder name can collide; the core compares the full path.
	const taken = (await recordedFolders().catch(() => [])).filter(folder => path.basename(folder).startsWith("gui-"));

	const made = await withRepoLock(primary, async () => {
		try {
			return await worktreeGit<{ path: string; branch: string }>(
				"git.worktreeAdd",
				{
					primary,
					baseCwd,
					root,
					hash,
					slug,
					branchPrefix,
					startPoint,
					...(input.sparse ? { sparse: input.sparse } : {}),
					taken,
					source: input.branch,
					addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS,
				},
				0,
				PLAN_AND_ADD_MS,
			);
		} catch (error) {
			if (error instanceof LocalCommandError) throw error;
			throw new LocalCommandError(
				`Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`,
				"worktree_create_failed",
			);
		}
	});
	return { primary, base, made: { ...made, baseCwd: mainCheckout } };
}

/**
 * What names a worktree made without a calling tab of this computer (an agent on another computer opening a
 * session here): the stock helper's `git.worktree_location` (stock-helper/worktrees.ts), the same stock
 * `worktree.base` and repo hash a tab's bridge answers `worktree_create` with, read from the repository's config.
 * No session of this computer needs to run.
 */
export const tablessWorktreeBridge: Pick<BridgeClient, "request"> = {
	request: <T>(method: string, params?: unknown) => stockHelperRequest<T>(method, params),
};

/**
 * Dirty worktrees are refused unless `force`; the message carries the counts for the close dialog. So is one whose
 * removal would delete what status does not show: ignored files no other copy holds, submodule checkouts (the core's
 * `removal_risk`). Only checkouts under the worktree root qualify: `--force` must never reach the user's own clone.
 */
export async function removeWorktree(
	input: { path: string; force?: boolean },
	bridge: Pick<BridgeClient, "request">,
	sessionCwd: string,
): Promise<{ removed: true }> {
	const { root } = await stockWorktreeLocation(bridge, path.resolve(sessionCwd));
	const { primary, path: worktreePath } = await worktreeGit<{ primary: string; path: string }>(
		"git.worktreeRemoval",
		{ path: input.path, root, force: input.force === true },
		4,
	);
	// The repository's archive hook runs once the removal is cleared (Orca `execute-worktree-removal.ts:162-188`); its
	// failure keeps the worktree unless the person forces the removal.
	const hookRefusal = await archiveHookRefusal(primary, worktreePath);
	if (hookRefusal && input.force !== true)
		throw new LocalCommandError(`The worktree was kept: ${hookRefusal}.`, "worktree_archive_failed");
	return withRepoLock(primary, () =>
		worktreeGit<{ removed: true }>(
			"git.worktreeRemove",
			{ primary, path: worktreePath, timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS },
			1,
			WORKTREE_REMOVE_TIMEOUT_MS,
		),
	);
}
