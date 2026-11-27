import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import { admission } from "./dev-release.mjs";

const jobs = [
	"static",
	"build",
	"win-native-bin",
	"native (windows)",
	"native (linux)",
	"check (renderer 1/2)",
	"check (renderer 2/2)",
	"check (node 1/2)",
	"check (node 2/2)",
	"win-platform (1/3)",
	"win-platform (2/3)",
	"win-platform (3/3)",
].map(name => ({ name, conclusion: "success" }));
const batch = {
	main: "base",
	dev: "candidate",
	tag: "previous",
	liveVersion: "1.0.0",
	publicTag: "v1.0.0",
	changes: 3,
	jobs,
	run: {
		path: ".github/workflows/ci.yml",
		head_repository: { full_name: "seuput-inc/ompdesk" },
		event: "push",
		head_branch: "dev",
		head_sha: "candidate",
		status: "completed",
		conclusion: "success",
	},
};

test("only a complete green push on the still-current dev batch can release", () => {
	assert.equal(admission(batch), "eligible");
	for (const patch of [
		{ conclusion: "failure" },
		{ event: "workflow_dispatch" },
		{ head_branch: "main" },
		{ head_sha: "superseded" },
		{ head_repository: { full_name: "fork/ompdesk" } },
	]) {
		assert.notEqual(admission({ ...batch, run: { ...batch.run, ...patch } }), "eligible");
	}
	for (const patch of [
		{ jobs: jobs.slice(1) },
		{ changes: 2 },
		{ changes: 0, exceptional: true },
		{ main: batch.dev },
		{ publicTag: "v0.9.0" },
	])
		assert.notEqual(admission({ ...batch, ...patch }), "eligible");
	assert.equal(admission({ ...batch, changes: 1, exceptional: true }), "eligible");
});

test("an exact candidate stays pinned and a competing release cannot replace the winner", () => {
	const cwd = mkdtempSync(join(tmpdir(), "release-origin-"));
	onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	const opts = { cwd, env, encoding: "utf8" };
	const git = (...args) =>
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@invalid", ...args], opts).trim();
	git("init", "-q", "--bare", "remote.git");
	git("init", "-q", "-b", "main", "tree");
	const local = (...args) => git("-C", "tree", ...args);
	const make = message => {
		local("commit", "-q", "--allow-empty", "-m", message);
		return local("rev-parse", "HEAD");
	};
	local("remote", "add", "origin", join(cwd, "remote.git"));
	make("base");
	local("push", "-q", "origin", "HEAD:main");
	const green = make("feature batch");
	local("push", "-q", "origin", "HEAD:dev");
	const winner = make("release: v1.1.0");
	local("push", "-q", "origin", `${winner}:main`);
	local("checkout", "-q", "--detach", green);
	make("feat: sort");
	make("fix: fold");
	const later = make("perf: search");
	local("push", "-q", "origin", `${later}:dev`);
	local("checkout", "-q", "--detach", green);
	make("different cut of same batch");
	assert.notEqual(spawnSync("git", ["-C", "tree", "push", "origin", "HEAD:main"], opts).status, 0);
	assert.equal(git("--git-dir=remote.git", "rev-parse", "main"), winner);
	assert.equal(git("--git-dir=remote.git", "rev-parse", "main^"), green);
	assert.equal(git("--git-dir=remote.git", "rev-parse", "dev"), later);
	assert.equal(spawnSync("git", ["-C", "tree", "merge-base", "--is-ancestor", winner, later], opts).status, 1);
	local("checkout", "-q", "--detach", later);
	local("merge", "-q", "--no-edit", winner);
	const reconciled = local("rev-parse", "HEAD");
	local("push", "-q", "origin", `${reconciled}:dev`);
	local("merge-base", "--is-ancestor", winner, reconciled);
	const next = {
		...batch,
		main: winner,
		tag: winner,
		dev: reconciled,
		liveVersion: "1.1.0",
		publicTag: "v1.1.0",
		changes: Number(local("rev-list", "--count", "--no-merges", `${winner}..${reconciled}`)),
	};
	assert.notEqual(admission({ ...next, run: { ...batch.run, head_sha: later } }), "eligible");
	assert.equal(admission({ ...next, run: { ...batch.run, head_sha: reconciled } }), "eligible");
	const second = make("release: v1.2.0");
	local("push", "-q", "origin", `${second}:main`);
	assert.equal(git("--git-dir=remote.git", "rev-parse", "main^"), reconciled);
});
