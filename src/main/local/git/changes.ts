/**
 * `get_git_status`, `get_git_changes`, `get_git_fingerprint`, `get_git_diff`, the checkout root and the main checkout:
 * the read side of git runs in the core process (`native/ompdesk/crates/core/src/git`, methods `git.*`), and these are
 * its typed client. `coreGit` (`exec.ts`) holds each read to its repository-lock step.
 */
import type {
	RpcGitChanges,
	RpcGitCompare,
	RpcGitDiff,
	RpcGitFingerprint,
	RpcGitImage,
	RpcGitStatus,
} from "../../../shared/rpc-types";
import { LocalCommandError } from "../types";
import { coreGit, coreGitAnswer } from "./exec";

/**
 * A changed picture as `rev` (the base range's merge-base, else HEAD) holds it at `filePath` (a rename's origin when the
 * page passes that), for the image diff's before side (Orca's `diff/large-files/*`); the after side is the Files
 * viewer's own read of the file. Null when `rev` holds no such picture or it is over 8 MB (the core's cap).
 */
export async function getGitImage(cwd: string, filePath: string, against?: string): Promise<RpcGitImage> {
	const root = await repoRoot(cwd);
	if (!root) throw new LocalCommandError(`Not a git repository: ${cwd}`, "not_a_repo");
	const picture = await coreGitAnswer<{ mime: string | null }>(
		"git.picture",
		{ root, rev: against ?? "HEAD", path: filePath },
		2,
	);
	const { mime } = picture.result;
	return {
		before: mime && picture.bin ? `data:${mime};base64,${Buffer.from(picture.bin).toString("base64")}` : null,
	};
}

/** Worktree top-level for `cwd`, or null outside a repository. */
export function repoRoot(cwd: string): Promise<string | null> {
	return coreGit("git.repoRoot", { cwd }, 1);
}

/** Main checkout root shared by every linked worktree (`--git-common-dir`'s parent), as a native path (git prints `C:/…` on Windows). */
export function primaryRoot(cwd: string): Promise<string> {
	return coreGit("git.primaryRoot", { cwd }, 1);
}

export function getGitStatus(cwd: string): Promise<RpcGitStatus> {
	return coreGit("git.status", { cwd }, 1);
}

/**
 * A cheap stand-in for `getGitChanges` that the Changes panel polls: one status plus a stat of every listed path, and
 * the root asked of git only when the caller does not pass the one its last full read reported (or passes one that
 * does not hold `cwd`). It changes whenever the full answer may have; its value compares only with this app's own.
 */
export function getGitFingerprint(cwd: string, knownRoot?: string): Promise<RpcGitFingerprint> {
	return coreGit("git.fingerprint", { cwd, root: knownRoot }, 1);
}

export function getGitChanges(cwd: string): Promise<RpcGitChanges> {
	return coreGit("git.changes", { cwd }, 2);
}

/**
 * The Changes panel's "Against base" range: the checkout against its base (the repository's pick, the upstream when
 * it is another branch, else the remote's default branch), read again when HEAD moved meanwhile. Null without one.
 */
export function getGitCompare(cwd: string): Promise<RpcGitCompare | null> {
	// Up to three reads: each resolves the base (six gits), counts, then four at once.
	return coreGit("git.compare", { cwd }, 3 * 12);
}

/**
 * Read one authorized changed path; never follow a symlink out of the checkout. `against`: the base range's merge-base
 * (from `getGitCompare`), else the diff is against HEAD.
 */
export function getGitDiff(cwd: string, filePath: string, against?: string): Promise<RpcGitDiff> {
	return coreGit("git.diff", { cwd, path: filePath, ...(against ? { against } : {}) }, 5);
}
