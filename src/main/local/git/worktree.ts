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
import type { RpcWorktreeCreateResult } from "../../../shared/rpc-types";
import { GUI_WORKTREE_BRANCH_PREFIX, worktreeBranchPrefix } from "../../../shared/worktree-branch";
import { CoreError } from "../../core/process";
import { SerialChain } from "../../serial-chain";
import { stockHelperRequest } from "../../stock-helper";
import { type BridgeClient, LocalCommandError } from "../types";
import { coreGit, coreHeld, DEFAULT_TIMEOUT_MS, withRepoLock } from "./exec";
import { worktreeSlug } from "./parse";
import { prepareWorktree, WORKTREE_PREPARE_BUDGET_MS } from "./worktree-seed";

/** `git worktree add` checks out the whole tree: minutes on a large repository. */
export const WORKTREE_ADD_TIMEOUT_MS = 300_000;
const WORKTREE_REMOVE_TIMEOUT_MS = 120_000;
const PLAN_AND_ADD_MS = 6 * DEFAULT_TIMEOUT_MS + WORKTREE_ADD_TIMEOUT_MS;
/**
 * Longest each command runs before main answers, counting every git step on
 * its slowest path at that step's timeout. The renderer's RPC timeouts
 * (shared/rpc-client.ts) must not be shorter, or it reports a failure while
 * the work still lands.
 */
export const WORKTREE_COMMAND_BUDGETS_MS = {
	// Planning, stock's location, waiting for the lock and every attempt share one cancellable step.
	worktree_create: PLAN_AND_ADD_MS + WORKTREE_PREPARE_BUDGET_MS,
	// Repo root, primary root, status, prune, and `worktree remove` itself.
	worktree_remove: 4 * DEFAULT_TIMEOUT_MS + WORKTREE_REMOVE_TIMEOUT_MS,
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
	mode: "new" | "local" | "remote";
	remote?: string;
	/** `new` only: the ref the branch starts at (default the folder's HEAD). */
	from?: string;
};

export function worktreeBranchSource(value: unknown): WorktreeBranchSource | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { name, mode, remote, from } = value as Record<string, unknown>;
	if (typeof name !== "string" || !name || (mode !== "new" && mode !== "local" && mode !== "remote")) return undefined;
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
}

export async function createWorktree(
	sessionCwd: string,
	input: CreateInput,
	bridge: Pick<BridgeClient, "request">,
): Promise<RpcWorktreeCreateResult> {
	const step = new SerialChain({ name: "worktree create", maxStepMs: PLAN_AND_ADD_MS });
	const { primary, made } = await step.run(() => planAndAdd(sessionCwd, input, bridge), input.name);
	return { ...made, ...(await prepareWorktree(primary, made.path)) };
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
	// The repository, its main checkout, and the commit a new branch starts at (`HEAD`, `default`, or a ref it has).
	const { primary, startPoint, mainCheckout } = await worktreeGit<{
		primary: string;
		startPoint: string;
		mainCheckout: string;
	}>("git.worktreePlan", { cwd: baseCwd, checkoutSpelling: path.resolve(baseCwd), baseRef: input.baseRef }, 3);
	const { root, hash } = await stockWorktreeLocation(bridge, primary);

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
	return { primary, made: { ...made, baseCwd: mainCheckout } };
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
 * Dirty worktrees are refused unless `force`; the message carries the counts for the close dialog.
 * Only checkouts under the worktree root qualify: `--force` must never reach the user's own clone.
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
	return withRepoLock(primary, () =>
		worktreeGit<{ removed: true }>(
			"git.worktreeRemove",
			{ primary, path: worktreePath, timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS },
			1,
			WORKTREE_REMOVE_TIMEOUT_MS,
		),
	);
}
