import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { copyTemplate, gitSync, initRepo, template } from "../local/git/test-repos";
import type { WorktreeRef } from "./branches";

export let root: string;
export let repo: string;

/** What `worktree_create` leaves: a branch off the parent's HEAD, checked out beside it. */
export async function agentWorktree(name: string): Promise<WorktreeRef> {
	const branch = `omp/agent/${name}`;
	const target = path.join(root, `wt-${name}`);
	gitSync(repo, "worktree", "add", "-q", "-b", branch, target, "HEAD");
	return { path: target, branch, baseCwd: repo };
}

export async function commitIn(dir: string, file: string, content: string): Promise<void> {
	await fs.writeFile(path.join(dir, file), content);
	gitSync(dir, "add", file);
	gitSync(dir, "commit", "-q", "-m", `edit ${file}`);
}

/**
 * The parent's main tracks origin/main but lacks its last three commits. Push the commits and wind the template's
 * checkout back instead of cloning a second repository to push them. No origin/HEAD: the reader must use main's upstream.
 */
export async function staleParentMain(): Promise<void> {
	const from = await template("stale-parent", async dir => {
		const parent = path.join(dir, "repo");
		const remote = path.join(dir, "remote.git");
		await initRepo(parent);
		gitSync(dir, "init", "-q", "--bare", "-b", "main", remote);
		gitSync(parent, "remote", "add", "origin", remote);
		for (const name of ["x.ts", "y.ts", "z.ts"]) await commitIn(parent, name, `${name}\n`);
		gitSync(parent, "push", "-q", "-u", "origin", "main");
		gitSync(parent, "reset", "--hard", "HEAD~3");
	});
	const remote = path.join(root, "remote.git");
	await fs.rm(repo, { recursive: true, force: true });
	await copyTemplate(path.join(from, "repo"), repo);
	await copyTemplate(path.join(from, "remote.git"), remote);
	gitSync(repo, "remote", "set-url", "origin", remote);
}

/** A child cut from the parent's stale HEAD that rebased onto the remote's main (`git fetch && git rebase origin/main`). */
export async function childOnRemoteMain(name: string): Promise<WorktreeRef> {
	const wt = await agentWorktree(name);
	gitSync(wt.path, "rebase", "-q", "origin/main");
	await commitIn(wt.path, "own.ts", "own\n");
	return wt;
}

/** What a squash-merge PR does: one new commit on the parent's main holding the branch's net change; the branch's own commits are in no ancestry. */
export function squashMerge(wt: WorktreeRef): void {
	gitSync(repo, "merge", "--squash", wt.branch);
	gitSync(repo, "commit", "-q", "-m", `squash ${wt.branch}`);
}

/** Registers the shared hooks: a fresh repository for each test. */
export function installBranchesRig(): void {
	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-branches-")));
		repo = path.join(root, "repo");
		await initRepo(repo);
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
}
