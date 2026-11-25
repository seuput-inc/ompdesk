/**
 * A landed session branch's copy on origin: `removeSafeWorktree` and `mergeBranch` delete it only when its tip is in
 * `origin/<base>` (by ancestry or by content), judged against origin alone, with a lease on the tip judged. Real temp
 * repos with a bare remote.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { gitSync, initRepoWithRemote } from "../local/git/test-repos";
import { mergeBranch, removeSafeWorktree, type WorktreeRef } from "./branches";
import { agentWorktree, commitIn, installBranchesRig, repo, root } from "./branches-test-rig";

installBranchesRig();

let remote: string;

beforeEach(async () => {
	remote = path.join(root, "remote.git");
	await fs.rm(repo, { recursive: true, force: true });
	await initRepoWithRemote(repo, remote);
	gitSync(repo, "remote", "set-head", "origin", "main");
});

/** The tip origin holds for `branch`, "" when it holds none. */
const onOrigin = (branch: string) => gitSync(remote, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);

async function pushedChild(name: string): Promise<WorktreeRef> {
	const wt = await agentWorktree(name);
	await commitIn(wt.path, `${name}.ts`, `${name}\n`);
	gitSync(wt.path, "push", "-q", "origin", wt.branch);
	return wt;
}

/** Another clone squash-merges the branch's copy into origin's main, as a squash-merged pull request does. */
function squashOnOrigin(wt: WorktreeRef): void {
	const other = path.join(root, "other");
	gitSync(root, "clone", "-q", remote, other);
	gitSync(other, "config", "user.email", "other@example.com");
	gitSync(other, "config", "user.name", "Other");
	gitSync(other, "merge", "--squash", `origin/${wt.branch}`);
	gitSync(other, "commit", "-q", "-m", `squash ${wt.branch}`);
	gitSync(other, "push", "-q", "origin", "main");
}

describe("a session branch's copy on origin", () => {
	it("stays when the branch was merged here but never reached origin's main", async () => {
		const wt = await pushedChild("local");
		const tip = onOrigin(wt.branch);
		expect(await mergeBranch(wt, "Worker")).toMatchObject({ merged: true, remote: { outcome: "not-landed" } });
		expect(await removeSafeWorktree(wt)).toMatchObject({ removal: "removed", remote: { outcome: "not-landed" } });
		expect(onOrigin(wt.branch)).toBe(tip);
	});

	it("is deleted once its tip is in origin's main", async () => {
		const wt = await pushedChild("pushed");
		gitSync(wt.path, "push", "-q", "origin", "HEAD:main");
		expect(await removeSafeWorktree(wt)).toEqual({
			removal: "removed",
			remote: { outcome: "deleted", message: expect.stringContaining("origin/main") },
		});
		expect(onOrigin(wt.branch)).toBe("");
		expect(onOrigin("main")).not.toBe("");
	});

	it("is deleted once origin's main holds it squashed", async () => {
		const wt = await pushedChild("squashed");
		squashOnOrigin(wt);
		gitSync(repo, "fetch", "-q", "origin");
		expect(await removeSafeWorktree(wt)).toMatchObject({ removal: "removed", remote: { outcome: "deleted" } });
		expect(onOrigin(wt.branch)).toBe("");
	});

	it("fetches what it judges: a merge after origin squashed it, before this checkout fetched, deletes it", async () => {
		const wt = await pushedChild("unfetched");
		squashOnOrigin(wt);
		expect(await mergeBranch(wt, "Worker")).toMatchObject({ merged: true, remote: { outcome: "deleted" } });
		expect(onOrigin(wt.branch)).toBe("");
	});

	it("stays when it moved on origin after it was judged landed", async () => {
		const wt = await pushedChild("moved");
		gitSync(wt.path, "push", "-q", "origin", "HEAD:main");
		const tip = onOrigin(wt.branch);
		// A bare repository has no identity of its own, and a runner has no global one.
		const as = ["-c", "user.name=Other", "-c", "user.email=other@example.com"];
		const moved = gitSync(remote, ...as, "commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "moved");
		// The deletion's own push runs this hook once origin has told it the tip: origin's copy moves right then.
		const slash = (file: string) => file.replaceAll("\\", "/");
		const hooks = path.join(root, "hooks");
		await fs.mkdir(hooks);
		await fs.writeFile(
			path.join(hooks, "pre-push"),
			`#!/bin/sh\ngit --git-dir="${slash(remote)}" update-ref refs/heads/${wt.branch} ${moved} ${tip}\n`,
			{ mode: 0o755 },
		);
		gitSync(repo, "config", "core.hooksPath", slash(hooks));
		expect(await removeSafeWorktree(wt)).toMatchObject({ removal: "removed", remote: { outcome: "moved" } });
		expect(onOrigin(wt.branch)).toBe(moved);
	});

	it("stays and says so when origin cannot be reached, and the worktree still goes", async () => {
		const wt = await pushedChild("offline");
		gitSync(wt.path, "push", "-q", "origin", "HEAD:main");
		gitSync(repo, "remote", "set-url", "origin", path.join(root, "gone.git"));
		expect(await removeSafeWorktree(wt)).toEqual({
			removal: "removed",
			remote: { outcome: "failed", message: expect.stringContaining("could not be read") },
		});
		await expect(fs.stat(wt.path)).rejects.toThrow();
		expect(onOrigin(wt.branch)).not.toBe("");
	});

	it("is nothing to report when origin holds no copy", async () => {
		const wt = await agentWorktree("unpushed");
		await commitIn(wt.path, "unpushed.ts", "x\n");
		gitSync(wt.path, "push", "-q", "origin", "HEAD:main");
		expect(await removeSafeWorktree(wt)).toEqual({ removal: "removed" });
		expect(onOrigin("main")).not.toBe("");
	});

	it("stays when origin pushes elsewhere than it is read from, even though it landed where it is read", async () => {
		const wt = await pushedChild("split");
		// The push destination holds the same copy, but its main never got the work.
		const pushes = path.join(root, "pushes.git");
		gitSync(root, "clone", "-q", "--bare", remote, pushes);
		gitSync(wt.path, "push", "-q", "origin", "HEAD:main");
		gitSync(repo, "remote", "set-url", "--push", "origin", pushes);
		const onPushes = (branch: string) =>
			gitSync(pushes, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);
		const tip = onPushes(wt.branch);
		expect(await removeSafeWorktree(wt)).toMatchObject({
			removal: "removed",
			remote: { outcome: "push-elsewhere" },
		});
		expect(onPushes(wt.branch)).toBe(tip);
		expect(onOrigin(wt.branch)).toBe(tip);
	});
});
