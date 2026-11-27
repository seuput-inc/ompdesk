import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { timeoutForCommand } from "../../../shared/rpc-client";
import type { RpcCommand, WorktreeWaitFrame } from "../../../shared/rpc-types";
import { nativeBinPath } from "../../native-bin";
import { handlers } from "../git";
import type { BridgeClient, LocalCommandContext } from "../types";
import { withRepoLock } from "./exec";
import { GITHUB_COMMAND_BUDGET_MS } from "./github";
import { PR_COMMAND_BUDGETS_MS } from "./pr";
import { SCM_COMMAND_BUDGETS_MS } from "./scm";
import { gitSync, initRepo, initRepoWithRemote, pathExists, stockShapedWorktree } from "./test-repos";
import { createWorktree, removeWorktree, WORKTREE_COMMAND_BUDGETS_MS } from "./worktree";
import { describePreparation } from "./worktree-seed";

let scratch: string;
let root: string;
let outside: string;
const savedWorktreeDir = process.env.OMP_WORKTREE_DIR;
const bridge: Pick<BridgeClient, "request"> = {
	async request<T>() {
		return { root, hash: "abc1234" } as T;
	},
};

beforeEach(async () => {
	scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-guard-")));
	root = path.join(scratch, "wt");
	outside = path.join(scratch, "projects", "app");
	await fs.mkdir(path.join(root, "gui-fix-1234567"), { recursive: true });
	await fs.mkdir(outside, { recursive: true });
	process.env.OMP_WORKTREE_DIR = root;
});

afterEach(async () => {
	if (savedWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
	else process.env.OMP_WORKTREE_DIR = savedWorktreeDir;
	await fs.rm(scratch, { recursive: true, force: true });
});

describe("worktree removal confinement", () => {
	it("refuses the root, relative and missing paths, and a symlink to an outside directory", async () => {
		const link = path.join(root, "gui-link-1234567");
		await fs.symlink(outside, link, "junction");
		for (const target of [root, "", "wt/gui-fix-1234567", path.join(root, "gone"), link]) {
			await expect(removeWorktree({ path: target, force: true }, bridge, outside)).rejects.toMatchObject({
				code: "worktree_outside_root",
			});
		}
		expect(await pathExists(outside)).toBe(true);
	});
});

describe("removeWorktree", () => {
	it("refuses a force removal outside the worktree root and leaves the directory alone", async () => {
		await fs.writeFile(path.join(outside, "keep.txt"), "user work");

		await expect(removeWorktree({ path: outside, force: true }, bridge, outside)).rejects.toMatchObject({
			code: "worktree_outside_root",
		});
		expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("user work");
	});
	it("creates with the stock-provided location, removes linked checkouts, and retains their branches", async () => {
		await initRepo(outside);
		const created = await createWorktree(outside, { name: "feature" }, bridge);
		expect(created.path).toBe(path.join(root, "gui-feature-abc1234"));
		await removeWorktree({ path: created.path }, bridge, outside);
		expect(await pathExists(created.path)).toBe(false);
		expect(gitSync(outside, "branch", "--list", created.branch)).toContain(created.branch);
		const old = await stockShapedWorktree(outside, root, "legacy-sha-name");
		await removeWorktree({ path: old.path }, bridge, outside);
		expect(await pathExists(old.path)).toBe(false);
	});
	it("refuses an unforced delete that would lose an ignored file, and deletes once the main checkout has its copy", async () => {
		await initRepo(outside);
		await fs.writeFile(path.join(outside, ".gitignore"), ".env.local\n");
		gitSync(outside, "add", ".gitignore");
		gitSync(outside, "commit", "-q", "-m", "ignore");
		const wt = await stockShapedWorktree(outside, root, "local-files");
		await fs.writeFile(path.join(wt.path, ".env.local"), "TOKEN=mine\n");
		await expect(removeWorktree({ path: wt.path }, bridge, outside)).rejects.toMatchObject({
			code: "worktree_dirty",
			message: expect.stringContaining(".env.local"),
		});
		expect(await fs.readFile(path.join(wt.path, ".env.local"), "utf8")).toBe("TOKEN=mine\n");
		// The same bytes in the main checkout, as worktree seeding copies them: nothing is lost.
		await fs.writeFile(path.join(outside, ".env.local"), "TOKEN=mine\n");
		await removeWorktree({ path: wt.path }, bridge, outside);
		expect(await pathExists(wt.path)).toBe(false);
	});
	it("refuses an unforced delete of a submodule checkout whose edits the person's ignore setting hides", async () => {
		const sub = path.join(scratch, "projects", "lib");
		await initRepo(sub);
		await initRepo(outside);
		gitSync(outside, "-c", "protocol.file.allow=always", "submodule", "--quiet", "add", sub, "lib");
		gitSync(outside, "commit", "-q", "-m", "submodule");
		const wt = await stockShapedWorktree(outside, root, "with-sub");
		gitSync(wt.path, "-c", "protocol.file.allow=always", "submodule", "--quiet", "update", "--init");
		gitSync(wt.path, "config", "submodule.lib.ignore", "all");
		await fs.writeFile(path.join(wt.path, "lib", "wip.txt"), "submodule work\n");
		await expect(removeWorktree({ path: wt.path }, bridge, outside)).rejects.toMatchObject({
			code: "worktree_dirty",
			message: expect.stringContaining("submodule"),
		});
		expect(await fs.readFile(path.join(wt.path, "lib", "wip.txt"), "utf8")).toBe("submodule work\n");
	});
	// A hosted runner's TEMP is an 8.3 short path (C:\Users\RUNNER~1\…); git answers with the long one. The caller's
	// spelling of the main checkout is the one its tabs and sessions use, so it comes back as given.
	it.skipIf(process.platform !== "win32")(
		"keeps the caller's spelling of the main checkout (a Windows short path)",
		async () => {
			await initRepo(outside);
			// Verbatim: Node's quoting would wrap the `for` loop's own quotes and cmd would name a path that does not exist.
			const short = spawnSync("cmd", ["/d", "/s", "/c", `"for %I in ("${outside}") do @echo %~sI"`], {
				encoding: "utf8",
				windowsVerbatimArguments: true,
			}).stdout.trim();
			if (!short || short.toLowerCase() === outside.toLowerCase()) return; // no 8.3 names on this volume
			const created = await createWorktree(short, { name: "short" }, bridge);
			expect(created.baseCwd).toBe(short);
		},
	);
	it("names the branch with the user's prefix, keeps the folder name, and refuses a prefix git would reject", async () => {
		await initRepo(outside);
		const plain = await createWorktree(outside, { name: "plain" }, bridge);
		expect(plain.branch).toBe("omp/gui/plain");
		const created = await createWorktree(outside, { name: "login", branchPrefix: "alice/" }, bridge);
		expect(created.branch).toBe("alice/login");
		expect(created.path).toBe(path.join(root, "gui-login-abc1234"));
		expect(gitSync(outside, "branch", "--list", "alice/login")).toContain("alice/login");
		await expect(createWorktree(outside, { name: "x", branchPrefix: "../evil/" }, bridge)).rejects.toMatchObject({
			code: "invalid_name",
		});
	});
	it("skips an occupied folder and a taken generated branch without changing either", async () => {
		await initRepo(outside);
		const first = path.join(root, "gui-topic-abc1234");
		await fs.mkdir(first);
		const taken = "alice/topic-2";
		const oldTip = gitSync(outside, "rev-parse", "HEAD");
		gitSync(outside, "branch", taken);
		gitSync(outside, "commit", "-q", "--allow-empty", "-m", "next");

		const made = await createWorktree(outside, { name: "Topic", branchPrefix: "alice/" }, bridge);
		expect(made.path).toBe(path.join(root, "gui-topic-3-abc1234"));
		expect(made.branch).toBe("alice/topic-3");
		expect(gitSync(made.path, "branch", "--show-current")).toBe(made.branch);
		expect(gitSync(made.path, "rev-parse", "HEAD")).toBe(gitSync(outside, "rev-parse", "HEAD"));
		expect(await fs.readdir(first)).toEqual([]);
		expect(gitSync(outside, "branch", "--list", "alice/topic")).toBe("");
		expect(gitSync(outside, "rev-parse", taken)).toBe(oldTip);
		expect(await pathExists(path.join(root, "gui-topic-2-abc1234"))).toBe(false);
	});
	it("uses the last free folder for an exact branch and refuses a 101st attempt", async () => {
		await initRepo(outside);
		for (let n = 1; n < 100; n++) {
			await fs.mkdir(path.join(root, n === 1 ? "gui-x-abc1234" : `gui-x-${n}-abc1234`));
		}
		const made = await createWorktree(outside, { name: "x", branch: { mode: "new", name: "work/mine" } }, bridge);
		expect(made.path).toBe(path.join(root, "gui-x-100-abc1234"));
		expect(made.branch).toBe("work/mine");
		expect(gitSync(made.path, "branch", "--show-current")).toBe("work/mine");
		await expect(createWorktree(outside, { name: "x" }, bridge)).rejects.toMatchObject({
			code: "worktree_create_failed",
			message: "No available worktree name after 100 attempts",
		});
		expect(gitSync(outside, "branch", "--list", "omp/gui/*")).toBe("");
		expect(await pathExists(path.join(root, "gui-x-101-abc1234"))).toBe(false);
	});
	it("creates a missing worktree root and refuses a blocked mkdir before creating a branch", async () => {
		await initRepo(outside);
		const parent = path.join(scratch, "nested");
		root = path.join(parent, "wt");
		await fs.writeFile(parent, "keep");
		await expect(createWorktree(outside, { name: "topic" }, bridge)).rejects.toMatchObject({
			code: "worktree_create_failed",
			message: expect.stringMatching(/^Failed to create worktree: .*mkdir /),
		});
		expect(await fs.readFile(parent, "utf8")).toBe("keep");
		expect(gitSync(outside, "branch", "--list", "omp/gui/topic")).toBe("");

		await fs.unlink(parent);
		const made = await createWorktree(outside, { name: "topic" }, bridge);
		expect(made.path).toBe(path.join(root, "gui-topic-abc1234"));
		expect(gitSync(made.path, "branch", "--show-current")).toBe("omp/gui/topic");
	});
	it("refuses a base folder that does not exist by naming it, never as a missing git", async () => {
		const gone = path.join(scratch, "projects", "gone");
		await expect(createWorktree(outside, { name: "x", baseCwd: gone }, bridge)).rejects.toMatchObject({
			code: "file_not_found",
			message: `The folder "${gone}" does not exist.`,
		});
	});
	it("starts the worktree's branch at the branch, tag or commit baseRef names, and refuses one that is no commit or reads as an option", async () => {
		await initRepo(outside);
		const mainTip = gitSync(outside, "rev-parse", "HEAD");
		gitSync(outside, "switch", "-q", "-c", "release");
		gitSync(outside, "commit", "-q", "--allow-empty", "-m", "release work");
		const releaseTip = gitSync(outside, "rev-parse", "HEAD");
		gitSync(outside, "tag", "v1");
		gitSync(outside, "switch", "-q", "main");
		const startOf = async (name: string, baseRef?: string) =>
			gitSync(
				(await createWorktree(outside, { name, ...(baseRef ? { baseRef } : {}) }, bridge)).path,
				"rev-parse",
				"HEAD",
			);
		expect(await startOf("by-default")).toBe(mainTip);
		expect(await startOf("by-head", "HEAD")).toBe(mainTip);
		expect(await startOf("by-branch", "release")).toBe(releaseTip);
		expect(await startOf("by-tag", "v1")).toBe(releaseTip);
		expect(await startOf("by-sha", releaseTip)).toBe(releaseTip);
		for (const baseRef of ["no-such-ref", "--upload-pack=x", "-b"])
			await expect(createWorktree(outside, { name: "bad", baseRef }, bridge)).rejects.toMatchObject({
				code: "invalid_base",
			});
		// A refused base created nothing: no branch, no folder.
		expect(gitSync(outside, "branch", "--list", "omp/gui/bad")).toBe("");
		expect(await pathExists(path.join(root, "gui-bad-abc1234"))).toBe(false);
	});
	it("checks out the exact branch the caller names: a new one, an existing local one, a remote one it then tracks", async () => {
		await initRepo(outside);
		const bare = path.join(scratch, "remote.git");
		gitSync(scratch, "init", "-q", "--bare", bare);
		gitSync(outside, "remote", "add", "origin", bare);
		gitSync(outside, "push", "-q", "origin", "main");
		gitSync(outside, "branch", "feature/local");
		gitSync(outside, "branch", "feature/remote");
		gitSync(outside, "push", "-q", "origin", "feature/remote");
		gitSync(outside, "branch", "-D", "feature/remote");

		const fresh = await createWorktree(outside, { name: "mine", branch: { name: "work/mine", mode: "new" } }, bridge);
		expect(fresh.branch).toBe("work/mine");
		expect(gitSync(fresh.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("work/mine");
		expect(gitSync(fresh.path, "rev-parse", "HEAD")).toBe(gitSync(outside, "rev-parse", "main"));

		const local = await createWorktree(
			outside,
			{ name: "local", branch: { name: "feature/local", mode: "local" } },
			bridge,
		);
		expect(local.branch).toBe("feature/local");
		expect(gitSync(local.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/local");

		const remote = await createWorktree(
			outside,
			{ name: "remote", branch: { name: "feature/remote", mode: "remote", remote: "origin" } },
			bridge,
		);
		expect(remote.branch).toBe("feature/remote");
		expect(gitSync(remote.path, "rev-parse", "--abbrev-ref", "feature/remote@{upstream}")).toBe(
			"origin/feature/remote",
		);
	});
	it("never renames a named branch: a taken, checked-out, missing or invalid name fails and leaves nothing behind", async () => {
		await initRepo(outside);
		const input = (branch: { name: string; mode: "new" | "local" | "remote"; remote?: string }) =>
			createWorktree(outside, { name: "x", branch }, bridge);
		await expect(input({ name: "main", mode: "new" })).rejects.toThrow(/already exists/);
		// `main` is checked out in the user's own folder.
		await expect(input({ name: "main", mode: "local" })).rejects.toThrow(
			/already checked out|already used by worktree/,
		);
		await expect(input({ name: "ghost", mode: "local" })).rejects.toThrow(/does not exist/);
		await expect(input({ name: "ghost", mode: "remote", remote: "origin" })).rejects.toThrow(/does not exist/);
		await expect(input({ name: "bad name", mode: "new" })).rejects.toMatchObject({ code: "invalid_name" });
		expect(gitSync(outside, "branch", "--list")).toBe("* main");
		expect(gitSync(outside, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
	});
	it("cuts a default-based worktree from the freshly fetched remote tip and says what the fetch brought", async () => {
		const bare = path.join(scratch, "remote.git");
		await initRepoWithRemote(outside, bare);
		gitSync(outside, "remote", "set-head", "origin", "main");
		gitSync(outside, "commit", "-q", "--allow-empty", "-m", "remote work");
		gitSync(outside, "push", "-q", "origin", "main");
		const remoteTip = gitSync(outside, "rev-parse", "HEAD");
		// This checkout has not seen the pushed commit: its main and origin/main stay one behind.
		gitSync(outside, "reset", "-q", "--hard", "HEAD~1");
		gitSync(outside, "update-ref", "refs/remotes/origin/main", "HEAD");

		const made = await createWorktree(outside, { name: "fresh", baseRef: "default" }, bridge);
		expect(gitSync(made.path, "rev-parse", "HEAD")).toBe(remoteTip);
		expect(made.base).toEqual({ ref: "origin/main", fetched: true, behind: 1, subjects: ["remote work"] });
		expect(describePreparation(made)).toBe("origin/main fetched: 1 new commit(s) (remote work)");
		expect(gitSync(outside, "rev-parse", "main")).not.toBe(remoteTip);

		const head = await createWorktree(outside, { name: "head", baseRef: "HEAD" }, bridge);
		expect(head.base).toBeUndefined();
	});
	it("leaves the repository lock free while a checkout waits for capacity, then creates it once", async () => {
		await initRepo(outside);
		const pool = process.env.OMPDESK_HEAVY_DIR;
		if (!pool) throw new Error("The test needs an isolated heavy pool");
		const env = { ...process.env };
		delete env.OMPDESK_HEAVY_HELD;
		const holder = spawn(nativeBinPath("ompdesk"), ["heavy", "hold", "--all"], { env, stdio: "pipe" });
		const exited = once(holder, "exit");
		try {
			const held = await Promise.race([once(holder.stdout, "data"), exited]);
			expect(String(held[0])).toMatch(/^held \d/);
			const frames: WorktreeWaitFrame[] = [];
			const unused = async (): Promise<never> => {
				throw new Error("unexpected stock command");
			};
			const ctx: LocalCommandContext = {
				cwd: outside,
				bridge: { ...bridge, connected: true },
				omp: { bin: "omp", version: "", run: unused },
				send: unused,
				worktreeWait: frame => frames.push(frame),
			};
			const seed = await stockShapedWorktree(outside, root, "seed");
			await fs.writeFile(path.join(outside, ".worktreeinclude"), ".env\n");
			const create = { type: "worktree_create", name: "queued", prepare: false, requestId: "creation-row" };
			const prepare = { type: "worktree_prepare", path: seed.path, requestId: "seed-row" };
			const opening = Promise.all([
				handlers.worktree_create!(create, ctx),
				handlers.worktree_create!(create, ctx),
				handlers.worktree_prepare!(prepare, ctx),
			]);
			await expect
				.poll(() => frames.map(f => [f.requestId, f.step]), { timeout: 10_000 })
				.toEqual(
					expect.arrayContaining([
						["creation-row", "create"],
						["seed-row", "prepare"],
					]),
				);
			for (const frame of frames) expect(["slots", "reservedVolume", "queue"]).toContain(frame.wait?.reason);
			await withRepoLock(outside, async () => {
				expect(await pathExists(path.join(root, "gui-queued-abc1234"))).toBe(false);
				expect(gitSync(outside, "branch", "--list", "omp/gui/queued")).toBe("");
			});
			holder.stdin.end();
			const [first, again] = await opening;
			expect(first).toEqual(again);
			expect(gitSync(outside, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(3);
			for (const id of ["creation-row", "seed-row"]) {
				expect(frames.findLast(f => f.requestId === id)?.wait).toBeNull();
			}
		} finally {
			holder.stdin.end();
			await exited;
		}
	}, 30_000);
	it("refuses an unmeasurable destination before creating its branch, checking out files or running setup", async () => {
		await initRepo(outside);
		const missing = path.join(scratch, "missing-volume");
		const link = path.join(scratch, "worktree-volume");
		await fs.symlink(missing, link, "junction");
		root = path.join(link, "target");
		await expect(createWorktree(outside, { name: "refused" }, bridge)).rejects.toMatchObject({
			code: "worktree_admission",
		});
		expect(await pathExists(missing)).toBe(false);
		expect(gitSync(outside, "branch", "--list")).toBe("* main");
		expect(gitSync(outside, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
	});
	it("answers a repeated request id with the same worktree, refuses it with other arguments, and leaves calls without one alone", async () => {
		await initRepo(outside);
		const request = { caller: "local", id: "6f9c1c1e-6d1b-4d1a-9f3e-0c3b8d1e2a11" };
		const [first, again] = await Promise.all([
			createWorktree(outside, { name: "same", request }, bridge),
			createWorktree(outside, { name: "same", request }, bridge),
		]);
		expect(again).toEqual(first);
		expect(await createWorktree(outside, { name: "same", request }, bridge)).toEqual(first);
		expect(gitSync(outside, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2);
		await expect(createWorktree(outside, { name: "other", request }, bridge)).rejects.toMatchObject({
			code: "invalid_request",
		});
		const other = { caller: "phone-1", id: request.id };
		expect((await createWorktree(outside, { name: "same", request: other }, bridge)).path).not.toBe(first.path);
		const plain = await createWorktree(outside, { name: "same" }, bridge);
		expect(plain.path).not.toBe(first.path);
	});
	it("refuses a primary checkout under the root and a linked checkout subdirectory", async () => {
		const primary = path.join(root, "user-clone");
		await initRepo(primary);
		await expect(removeWorktree({ path: primary, force: true }, bridge, primary)).rejects.toMatchObject({
			code: "not_a_worktree",
		});
		const linked = await stockShapedWorktree(primary, root, "linked");
		const nested = path.join(linked.path, "nested");
		await fs.mkdir(nested);
		await expect(removeWorktree({ path: nested, force: true }, bridge, primary)).rejects.toMatchObject({
			code: "not_a_worktree",
		});
		expect(await pathExists(linked.path)).toBe(true);
	});
});

describe("renderer RPC timeouts", () => {
	it("wait at least as long as main can take to answer each worktree, PR and source-control command", () => {
		const budgets: Record<string, number> = {
			...WORKTREE_COMMAND_BUDGETS_MS,
			...PR_COMMAND_BUDGETS_MS,
			...SCM_COMMAND_BUDGETS_MS,
			github: GITHUB_COMMAND_BUDGET_MS,
		};
		for (const [type, budget] of Object.entries(budgets)) {
			// Only the type selects the timeout; the rest of the command is irrelevant here.
			const command = { type } as RpcCommand;
			expect(timeoutForCommand(command), type).toBeGreaterThanOrEqual(budget);
		}
	});
});
