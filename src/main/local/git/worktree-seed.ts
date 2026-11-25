/**
 * Prepares a worktree OMPdesk just created (`createWorktree`: the worktree dialog, Autopilot, the agent's
 * `ompdesk_session_open` worktrees), so a parallel session does not start without the project's local files.
 *
 * 1. `.worktreeinclude` at the main checkout's root (the cross-tool convention Orca and others read): one path or
 *    glob per line, copied from the main checkout only when git ignores it there. The whole seed is one request to
 *    the core process (`git.worktreeSeed`, `native/ompdesk/crates/core/src/git/seed.rs`, which holds its rules):
 *    held to the repository-lock step it is made in, so a stopped step cancels it.
 * 2. `.ompdesk/worktree-setup` (`.ompdesk/worktree-setup.cmd` on Windows), only when that file exists in the new
 *    worktree or the main checkout (the core looks: `git.worktreeHook`): run in the worktree under the setup
 *    supervisor (its whole process tree dies with a timeout, a quit or a crash), `SETUP_TIMEOUT_MS`, output logged to
 *    the worktree's own git dir. A failure is reported, never fatal: the worktree stays. The script is the
 *    repository's own, run with the user's rights, as the agent's first `bun install` there would be.
 *
 * `runWorktreeHook` also runs `.ompdesk/worktree-pre-merge` (in the worktree, before `ompdesk_merge` starts git) and
 * `.ompdesk/worktree-post-merge` (in the parent checkout, after the merge landed), found and logged the same way.
 *
 * The script runs under the core binary's supervise mode (`ompdesk-core --supervise`, `superviseWorktreeHook`), not as a
 * request of the running core. A hook is a shell whose children (`bun install`) must end with it at its timeout, and
 * it must never outlive the app. The running core's processes end with a dead core because they stay in its process
 * group, so on POSIX it cannot give a hook a group of its own to kill, and a hook in it would end with every restart
 * of the core; the supervisor is a process beside each command that does both.
 *
 * Stock omp (18.12.1) has neither: no `worktreeinclude` and no worktree hook in its sources, and worktree creation
 * here is OMPdesk's own (`worktree.ts`), so nothing of stock is duplicated.
 */

import type { WorktreeBaseFetch, WorktreeSeedReport, WorktreeSetupReport } from "../../../shared/rpc-types";
import { currentStepSignal, fencedEffect } from "../../serial-chain";
import { superviseWorktreeHook } from "../../setup/supervisor";
import { coreGit, DEFAULT_TIMEOUT_MS } from "./exec";

const WORKTREE_INCLUDE_FILE = ".worktreeinclude";
export const SETUP_TIMEOUT_MS = 120_000;
const runFoundHook = fencedEffect("worktree hook", superviseWorktreeHook);
/** The repository's own scripts around a worktree's life: when it is made, and either side of `ompdesk_merge`. */
export type WorktreeHook = "setup" | "pre-merge" | "post-merge";
const HOOK_EXTENSION = process.platform === "win32" ? ".cmd" : "";
export const WORKTREE_HOOK_SCRIPTS: Record<WorktreeHook, string> = {
	setup: `.ompdesk/worktree-setup${HOOK_EXTENSION}`,
	"pre-merge": `.ompdesk/worktree-pre-merge${HOOK_EXTENSION}`,
	"post-merge": `.ompdesk/worktree-post-merge${HOOK_EXTENSION}`,
};
/** What `ompdesk_merge` may spend in hooks: one before the merge, one after. */
export const MERGE_HOOKS_BUDGET_MS = 2 * SETUP_TIMEOUT_MS;
/**
 * How long a seed may start new entries; what it has not reached by then is skipped as `budget`. The request waits
 * one git timeout more, for a `check-ignore` that started just before.
 */
const SEED_BUDGET_MS = DEFAULT_TIMEOUT_MS;
/** Longest `prepareWorktree` holds `worktree_create`'s answer (the seed and its last git, the hook's git dir, the hook). */
export const WORKTREE_PREPARE_BUDGET_MS = 3 * DEFAULT_TIMEOUT_MS + SETUP_TIMEOUT_MS;

/**
 * Copies the main checkout's `.worktreeinclude` matches into `target`; null when the repo has no such file.
 * `pretendClones` is a test's stand-in for the volume: that many files count as cloned, every later one is refused as
 * a volume without reflinks refuses it.
 */
export function seedWorktree(
	primary: string,
	target: string,
	deps: { pretendClones?: number } = {},
): Promise<WorktreeSeedReport | null> {
	return coreGit(
		"git.worktreeSeed",
		{ primary, target, budgetMs: SEED_BUDGET_MS, pretendClones: deps.pretendClones },
		2,
	);
}

/**
 * Runs the repository's script for `hook` in `where.cwd`; null when there is none (the worktree's own file wins over
 * the main checkout's). The log lands in the worktree's git dir.
 */
export async function runWorktreeHook(
	hook: WorktreeHook,
	where: { primary: string; worktree: string; cwd: string; timeoutMs?: number },
): Promise<WorktreeSetupReport | null> {
	const { primary, worktree, cwd, timeoutMs = SETUP_TIMEOUT_MS } = where;
	const found = await coreGit<{ script: string; logPath: string } | null>(
		"git.worktreeHook",
		{ primary, worktree, script: WORKTREE_HOOK_SCRIPTS[hook], log: `ompdesk-worktree-${hook}.log` },
		1,
	);
	return found ? runFoundHook(hook, { primary, worktree, cwd, timeoutMs }, found, currentStepSignal()) : null;
}

/** Both steps after a successful `worktree add`; neither ever fails the creation. */
export async function prepareWorktree(
	primary: string,
	target: string,
): Promise<{ seed?: WorktreeSeedReport; setup?: WorktreeSetupReport }> {
	const seed = await seedWorktree(primary, target).catch(
		(error): WorktreeSeedReport => ({
			copied: 0,
			bytes: 0,
			cloned: false,
			skipped: [{ path: WORKTREE_INCLUDE_FILE, reason: error instanceof Error ? error.message : String(error) }],
		}),
	);
	const setup = await runWorktreeHook("setup", { primary, worktree: target, cwd: target });
	return { ...(seed ? { seed } : {}), ...(setup ? { setup } : {}) };
}

/** One line for the agent's `ompdesk_session_open` notes and Autopilot's log, or null when no step ran. */
export function describePreparation(result: {
	base?: WorktreeBaseFetch;
	seed?: WorktreeSeedReport;
	setup?: WorktreeSetupReport;
}): string | null {
	const parts: string[] = [];
	if (result.base) {
		const { ref, fetched, behind, subjects, error } = result.base;
		parts.push(
			error
				? `${ref} not fetched (${error}); cut from the local copy`
				: fetched
					? `${ref} fetched: ${behind} new commit(s)${subjects.length ? ` (${subjects.join("; ")})` : ""}`
					: `${ref} fetched under 30 s ago`,
		);
	}
	if (result.seed) {
		const skipped = result.seed.skipped.length;
		parts.push(
			`.worktreeinclude copied ${result.seed.copied} file(s)${result.seed.cloned ? " (reflink)" : ""}${
				skipped
					? `, skipped ${skipped} (${result.seed.skipped
							.slice(0, 3)
							.map(item => `${item.path}: ${item.reason}`)
							.join("; ")})`
					: ""
			}`,
		);
	}
	if (result.setup) {
		const setup = result.setup;
		parts.push(
			setup.ok
				? `${setup.script} ran (${Math.round(setup.durationMs / 1000)}s)`
				: `${setup.script} ${setup.timedOut ? "timed out" : `failed (exit ${setup.exitCode})`}, log ${setup.logPath}`,
		);
	}
	return parts.length ? parts.join("; ") : null;
}
