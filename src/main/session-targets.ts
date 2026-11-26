/**
 * What this computer's sessions work in (`shared/session-target.ts`), for every view of them: this computer's
 * windows and phone pages through IPC, a paired computer through `sessions.targets`/`sessions.artwork` on the link.
 * The git, the journal reads and the image lookups are the core's (`crates/core/src/repo_images`): it answers a
 * list from git and its image cache only, and looks images up, bounded and cached, only when asked by root.
 */
import * as path from "node:path";
import { z } from "zod";
import type { GithubBranchPr } from "../shared/github";
import {
	SESSION_TARGET_BATCH,
	type SessionArtwork,
	type SessionArtworks,
	type SessionTarget,
	type SessionTargetHead,
	type SessionTargets,
} from "../shared/session-target";
import { coreGit } from "./local/git/exec";
import { githubCommand } from "./local/git/github";

const MAX_PATH = 4096;
/** The core's own bound on one image lookup, past the git's. */
const ARTWORK_LOOKUP_MS = 15_000;

/** The rows to resolve: the boundary every caller (IPC, the link) parses with. */
export const SessionTargetsParams = z.object({
	sessions: z
		.array(z.object({ sessionPath: z.string().min(1).max(MAX_PATH), cwd: z.string().max(MAX_PATH) }))
		.max(SESSION_TARGET_BATCH),
});

/** The repository roots whose images to look up. */
export const SessionArtworkParams = z.object({
	roots: z.array(z.string().min(1).max(MAX_PATH)).max(SESSION_TARGET_BATCH),
});

/** A row's checkout whose pull request to read: its repository root and branch (`SessionTarget`). */
export const SessionPullRequestParams = z.object({
	root: z.string().min(1).max(MAX_PATH).refine(path.isAbsolute, "root must be absolute"),
	branch: z.string().min(1).max(255),
});

/** The core's answer for one folder (`repo_images::Metadata`). */
interface CoreMetadata {
	path: string;
	project: string;
	repository: { root: string; head: SessionTargetHead; owner?: string } | null;
	image?: SessionArtwork | null;
}

/** Folders the core resolves the git and image facts of; a session's journal only for a folder in no repository. */
export async function sessionTargets(params: z.infer<typeof SessionTargetsParams>): Promise<SessionTargets> {
	const targets: SessionTargets = {};
	const asks = [];
	for (const { sessionPath, cwd } of params.sessions) {
		targets[sessionPath] = null;
		if (!path.isAbsolute(cwd)) continue;
		const journal = path.isAbsolute(sessionPath) && sessionPath.endsWith(".jsonl");
		asks.push({ key: sessionPath, path: cwd, ...(journal ? { session: sessionPath } : {}) });
	}
	if (asks.length === 0) return targets;
	const answer = await coreGit<Record<string, CoreMetadata | null>>("projectMetadata.get", { targets: asks }, 1);
	for (const [sessionPath, found] of Object.entries(answer)) {
		if (found) targets[sessionPath] = targetOf(found);
	}
	return targets;
}

function targetOf(found: CoreMetadata): SessionTarget {
	const { repository } = found;
	return {
		path: found.path,
		repository: repository
			? { root: repository.root, name: found.project, ...(repository.owner ? { owner: repository.owner } : {}) }
			: null,
		head: repository?.head ?? null,
		...("image" in found ? { artwork: found.image ?? null } : {}),
	};
}

/** Each root's image: the core looks it up where its cache has none (about 10 s at most, then cached). */
export async function sessionArtwork(params: z.infer<typeof SessionArtworkParams>): Promise<SessionArtworks> {
	if (params.roots.length === 0) return {};
	const roots = params.roots.filter(root => path.isAbsolute(root));
	const answer = roots.length
		? await coreGit<SessionArtworks>("projectArtwork.get", { roots }, 1, ARTWORK_LOOKUP_MS)
		: {};
	return Object.fromEntries(params.roots.map(root => [root, answer[root] ?? null]));
}

/**
 * The pull request of a row's branch (`gh pr list --head`, its open one else its newest; null: none), read in the
 * repository's own root on this computer. Always a background read: rows ask on their own, paced by the renderer
 * (`stores/branch-prs.ts`), and the core's gate holds them while GitHub's quota is low.
 */
export function sessionPullRequest(params: z.infer<typeof SessionPullRequestParams>): Promise<GithubBranchPr | null> {
	return githubCommand(
		params.root,
		{ op: "pr_for_branch", branch: params.branch },
		true,
	) as Promise<GithubBranchPr | null>;
}
