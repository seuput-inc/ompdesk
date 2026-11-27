import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test, vi } from "vitest";
import { admission, git as releaseGit, requestOnce, windowsReceipt } from "./dev-release.mjs";
import { selectWindowsBatch } from "./windows-batch.mjs";

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
const windows = {
	name: "win-e2e",
	conclusion: "success",
	steps: [{ name: "Required Windows app set", conclusion: "success" }],
};
const batch = {
	main: "base",
	dev: "candidate",
	tag: "previous",
	liveVersion: "1.0.0",
	publicTag: "v1.0.0",
	changes: 3,
	jobs,
	run: {
		id: 12345,
		path: ".github/workflows/ci.yml",
		head_repository: { full_name: "seuput-inc/ompdesk" },
		event: "push",
		head_branch: "dev",
		head_sha: "candidate",
		status: "completed",
		conclusion: "success",
	},
};
const greenReceipt = sha => ({
	id: 67890,
	path: batch.run.path,
	head_repository: batch.run.head_repository,
	event: "workflow_dispatch",
	head_branch: "dev",
	head_sha: sha,
	display_title: `ci [release-windows=${sha}]`,
	status: "completed",
	conclusion: "success",
});
const green = { find: greenReceipt, jobs: () => [windows], request: () => assert.fail("duplicate dispatch") };

test("only a complete green push on the still-current dev batch can release", () => {
	assert.equal(admission(batch, green), "eligible");
	for (const patch of [
		{ conclusion: "failure" },
		{ event: "workflow_dispatch" },
		{ head_branch: "main" },
		{ head_sha: "superseded" },
		{ head_repository: { full_name: "fork/ompdesk" } },
	]) {
		assert.notEqual(admission({ ...batch, run: { ...batch.run, ...patch } }, green), "eligible");
	}
	for (const patch of [
		{ jobs: jobs.slice(1) },
		{ changes: 2 },
		{ changes: 0, exceptional: true },
		{ main: batch.dev },
		{ publicTag: "v0.9.0" },
	])
		assert.notEqual(admission({ ...batch, ...patch }, green), "eligible");
	assert.equal(admission({ ...batch, changes: 1, exceptional: true }, green), "eligible");
});

test("a finished Windows receipt needs the exact SHA, full set, successful job and successful proof step", () => {
	for (const receipt of [
		[],
		[{ ...windows, conclusion: "failure" }],
		[{ ...windows, conclusion: "cancelled" }],
		[{ ...windows, conclusion: "skipped" }],
		[{ ...windows, steps: [] }],
		[{ ...windows, steps: [{ ...windows.steps[0], conclusion: "skipped" }] }],
	]) {
		assert.match(admission(batch, { ...green, jobs: () => receipt }), /win-e2e run 67890/);
	}
	for (const patch of [
		{ conclusion: "failure" },
		{ head_sha: "ancestor" },
		{ event: "push" },
		{ display_title: "manual probe" },
		{ head_repository: { full_name: "another/ompdesk" } },
	]) {
		assert.notEqual(admission(batch, { ...green, find: sha => ({ ...greenReceipt(sha), ...patch }) }), "eligible");
	}
});

test("dev moving between dispatch and GitHub resolving its ref only releases the rejected candidate", () => {
	const base = "1".repeat(40);
	const a = "a".repeat(40);
	const b = "b".repeat(40);
	const dir = mkdtempSync(join(tmpdir(), "windows-moved-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	const moved = { ...greenReceipt(a), head_sha: b, conclusion: "failure" };
	const rejected = [{ name: "reject-windows-candidate", conclusion: "failure" }];
	const select = (tip, runs, checkJobs) =>
		selectWindowsBatch({
			dir,
			base,
			tip,
			contains: sha => sha === a || sha === tip,
			receipt: sha => windowsReceipt(sha, runs, () => checkJobs, true),
		});
	assert.equal(select(a, [], []).claim(), true);
	assert.equal(select(b, [moved], []).candidate, a);
	assert.equal(select(b, [{ ...moved, conclusion: "success" }], rejected).candidate, a);
	assert.equal(select(b, [moved, { ...moved, id: 67891 }], rejected).candidate, a);
	assert.equal(select(b, [moved], rejected).candidate, b);
	// Its display title still names A: even an apparent success on B cannot supply B's app proof.
	assert.equal(
		windowsReceipt(b, [{ ...moved, conclusion: "success" }], () => [windows]),
		undefined,
	);
});

test("only a qualifying batch requests Windows, once even before its receipt is visible", () => {
	const dir = mkdtempSync(join(tmpdir(), "windows-receipts-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	const dispatch = vi.fn();
	const find = vi.fn();
	const evidence = { ...green, find, request: sha => requestOnce(dir, sha, dispatch) };
	assert.equal(admission({ ...batch, changes: 2 }, evidence), "batch too small");
	assert.equal(find.mock.calls.length, 0);
	assert.equal(dispatch.mock.calls.length, 0);
	assert.match(admission(batch, evidence), /waiting for the Windows receipt/);
	assert.match(admission(batch, evidence), /waiting for the Windows receipt/);
	assert.deepEqual(dispatch.mock.calls, [[batch.dev]]);
	find.mockReturnValue({ ...greenReceipt(batch.dev), status: "queued", conclusion: null });
	assert.match(admission(batch, evidence), /waiting.*67890/);
	find.mockReturnValue({ ...greenReceipt(batch.dev), conclusion: "cancelled" });
	assert.match(admission(batch, evidence), /67890.*cancelled/);
	assert.deepEqual(dispatch.mock.calls, [[batch.dev]]);
});

test("a lost dispatch acknowledgment is not a reason to submit a second run", () => {
	const dir = mkdtempSync(join(tmpdir(), "windows-uncertain-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	const dispatch = vi.fn(() => {
		throw Error("lost acknowledgement");
	});
	assert.throws(() => requestOnce(dir, batch.dev, dispatch), /lost acknowledgement/);
	requestOnce(dir, batch.dev, dispatch);
	assert.equal(dispatch.mock.calls.length, 1);
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
	git("init", "-q", "--bare", "unrelated.git");
	vi.stubEnv("GIT_DIR", join(cwd, "unrelated.git"));
	onTestFinished(() => vi.unstubAllEnvs());
	releaseGit("-C", join(cwd, "tree"), "fetch", "-q", join(cwd, "remote.git"), "main");
	assert.ok(existsSync(join(cwd, "tree", ".git", "FETCH_HEAD")));
	assert.equal(existsSync(join(cwd, "unrelated.git", "FETCH_HEAD")), false);
	const firstCandidate = make("feature batch");
	local("push", "-q", "origin", "HEAD:dev");
	const winner = make("release: v1.1.0");
	local("push", "-q", "origin", `${winner}:main`);
	local("checkout", "-q", "--detach", firstCandidate);
	make("feat: sort");
	make("fix: fold");
	const later = make("perf: search");
	local("push", "-q", "origin", `${later}:dev`);
	local("checkout", "-q", "--detach", firstCandidate);
	make("different cut of same batch");
	assert.notEqual(spawnSync("git", ["-C", "tree", "push", "origin", "HEAD:main"], opts).status, 0);
	assert.equal(git("--git-dir=remote.git", "rev-parse", "main"), winner);
	assert.equal(git("--git-dir=remote.git", "rev-parse", "main^"), firstCandidate);
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
	assert.notEqual(admission({ ...next, run: { ...batch.run, head_sha: later } }, green), "eligible");
	assert.equal(admission({ ...next, run: { ...batch.run, head_sha: reconciled } }, green), "eligible");
	const second = make("release: v1.2.0");
	local("push", "-q", "origin", `${second}:main`);
	assert.equal(git("--git-dir=remote.git", "rev-parse", "main^"), reconciled);
});
