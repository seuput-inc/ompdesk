/** Project identity and its per-folder cache live in git/project.rs. */
import * as path from "node:path";
import {
	type OriginFacts,
	type ProjectOrigin,
	worktreeFolderSlug,
	worktreeKindOf,
} from "../../../shared/project-origin";
import { core } from "../../core/process";
import { coreGit } from "./exec";

/** Each git's timeout; the lookup runs two of them one after another. */
const GIT_MS = 10_000;

interface Checkout {
	project: string;
	root: string;
	worktree: { branch: string | null; folder: string } | null;
}

/**
 * What git says about `cwd`'s checkout (common dir, git dir, branch, top level), uncached; null outside a repository,
 * and whenever git cannot answer.
 */
export function readOriginFacts(cwd: string): Promise<OriginFacts | null> {
	return coreGit<OriginFacts | null>(
		"git.originFacts",
		{ cwd: path.resolve(cwd), timeoutMs: GIT_MS },
		0,
		2 * GIT_MS,
	).catch(() => null);
}

/** Do not resolve git or transmit its environment for cached sidebar rows. */
export async function readProjectOrigin(cwd: string, now?: () => number): Promise<ProjectOrigin | null> {
	if (!cwd) return null;
	const params = { cwd: path.isAbsolute(cwd) ? cwd : path.resolve(cwd), now: now?.() };
	try {
		const cached = (await core().call<Checkout | null | "needsGit">("git.cachedProjectOrigin", params)).result;
		const origin =
			cached === "needsGit" ? await coreGit<Checkout | null>("git.projectOrigin", params, 0, 2 * GIT_MS) : cached;
		if (!origin) return null;
		const tree = origin.worktree;
		return {
			project: origin.project,
			root: origin.root,
			worktree: tree && {
				branch: tree.branch,
				kind: worktreeKindOf(tree.branch),
				slug: worktreeFolderSlug(tree.folder),
			},
		};
	} catch {
		return null;
	}
}
