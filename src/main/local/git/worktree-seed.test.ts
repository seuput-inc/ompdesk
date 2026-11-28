import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cores from "../../core/process";
import { nativeBinPath } from "../../native-bin";
import * as runtimeLog from "../../runtime-log";
import { StepStalledError } from "../../serial-chain";
import { itWithFileSymlinks } from "../../test-symlinks";
import type { BridgeClient } from "../types";
import * as exec from "./exec";
import { gitSync, initRepo, pathExists } from "./test-repos";
import { createWorktree } from "./worktree";
import {
	describePreparation,
	prepareWorktree,
	runWorktreeHook,
	seedWorktree,
	WORKTREE_HOOK_SCRIPTS,
	type WorktreeHook,
} from "./worktree-seed";

/** The core's byte budget for a seed on a volume that cannot clone (`SEED_MAX_BYTES` in `git/seed.rs`). */
const SEED_MAX_BYTES = 50 * 1024 * 1024;

let scratch: string;
let repo: string;
let wtRoot: string;
const savedWorktreeDir = process.env.OMP_WORKTREE_DIR;
const bridge: Pick<BridgeClient, "request"> = {
	async request<T>() {
		return { root: wtRoot, hash: "abc1234" } as T;
	},
};

beforeEach(async () => {
	scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-seed-")));
	repo = path.join(scratch, "repo");
	wtRoot = path.join(scratch, "wt");
	process.env.OMP_WORKTREE_DIR = wtRoot;
	await initRepo(repo);
});

afterEach(async () => {
	if (savedWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
	else process.env.OMP_WORKTREE_DIR = savedWorktreeDir;
	await fs.rm(scratch, { recursive: true, force: true });
});

async function freshWorktree(name: string): Promise<string> {
	const target = path.join(scratch, name);
	gitSync(repo, "worktree", "add", "-q", "-b", name, target);
	return target;
}

/** A filesystem without reflinks: every clone is refused, a plain copy works. */
const noReflink = { pretendClones: 0 };

describe("seedWorktree", () => {
	it("copies ignored files and globs, never a tracked one, and reports the rest", async () => {
		await fs.writeFile(path.join(repo, ".gitignore"), ".env\n.env.*\nsecrets/\n");
		await fs.writeFile(path.join(repo, "tracked.txt"), "from git\n");
		gitSync(repo, "add", ".");
		gitSync(repo, "commit", "-q", "-m", "more");
		await fs.writeFile(path.join(repo, ".env"), "A=1\n");
		await fs.writeFile(path.join(repo, ".env.local"), "B=2\n");
		await fs.mkdir(path.join(repo, "secrets"));
		await fs.writeFile(path.join(repo, "secrets", "key"), "k\n");
		await fs.writeFile(path.join(repo, "tracked.txt"), "local edit\n");
		await fs.writeFile(
			path.join(repo, ".worktreeinclude"),
			"# local files\n.env\n.env.*\nsecrets\ntracked.txt\n../x\n",
		);
		const target = await freshWorktree("seed");

		const report = await seedWorktree(repo, target);

		expect(await fs.readFile(path.join(target, ".env"), "utf8")).toBe("A=1\n");
		expect(await fs.readFile(path.join(target, ".env.local"), "utf8")).toBe("B=2\n");
		expect(await fs.readFile(path.join(target, "secrets", "key"), "utf8")).toBe("k\n");
		// The checkout git made, whatever line ending core.autocrlf gave it (Windows runners check out CRLF).
		expect((await fs.readFile(path.join(target, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("from git\n");
		expect(report?.copied).toBe(3);
		expect(report?.skipped).toEqual(
			expect.arrayContaining([
				{ path: "tracked.txt", reason: "not_ignored" },
				{ path: "../x", reason: "outside" },
			]),
		);
	});

	it("is null without a .worktreeinclude", async () => {
		expect(await seedWorktree(repo, await freshWorktree("none"))).toBeNull();
	});

	it("stops at the size budget with a skip note when the filesystem cannot clone", async () => {
		await fs.writeFile(path.join(repo, ".gitignore"), "*.bin\n");
		gitSync(repo, "commit", "-qam", "ignore bins");
		await fs.writeFile(path.join(repo, "a.bin"), Buffer.alloc(SEED_MAX_BYTES - 10));
		await fs.writeFile(path.join(repo, "b.bin"), Buffer.alloc(100));
		await fs.writeFile(path.join(repo, ".worktreeinclude"), "*.bin\n");
		const target = await freshWorktree("budget");

		const report = await seedWorktree(repo, target, noReflink);

		expect(report).toMatchObject({ copied: 1, cloned: false });
		expect(report?.skipped).toEqual([{ path: "b.bin", reason: "budget" }]);
		expect(await pathExists(path.join(target, "b.bin"))).toBe(false);
	});

	it("skips a first file over the budget when the clone fails, and copies nothing of it", async () => {
		await fs.writeFile(path.join(repo, ".gitignore"), "*.bin\n");
		gitSync(repo, "commit", "-qam", "ignore bins");
		await fs.writeFile(path.join(repo, "a.bin"), Buffer.alloc(SEED_MAX_BYTES + 1));
		await fs.writeFile(path.join(repo, ".worktreeinclude"), "*.bin\n");
		const target = await freshWorktree("big-first");

		const report = await seedWorktree(repo, target, noReflink);

		expect(report).toMatchObject({ copied: 0, cloned: false });
		expect(report?.skipped).toEqual([{ path: "a.bin", reason: "budget" }]);
		expect(await pathExists(path.join(target, "a.bin"))).toBe(false);
	});

	it("copies past the byte budget when the filesystem clones, bounded only by the file count", async () => {
		await fs.writeFile(path.join(repo, ".gitignore"), "*.bin\n");
		gitSync(repo, "commit", "-qam", "ignore bins");
		await fs.writeFile(path.join(repo, "a.bin"), Buffer.alloc(SEED_MAX_BYTES + 1));
		await fs.writeFile(path.join(repo, "b.bin"), Buffer.alloc(SEED_MAX_BYTES + 1));
		await fs.writeFile(path.join(repo, ".worktreeinclude"), "*.bin\n");
		const target = await freshWorktree("clone");

		const report = await seedWorktree(repo, target);

		// Whether this machine's temp volume clones (APFS, btrfs, XFS reflink) is the seed's to find out; a Mac's does.
		if (process.platform === "darwin") expect(report?.cloned).toBe(true);
		if (report?.cloned) {
			expect(report).toMatchObject({ copied: 2, cloned: true });
			expect(report?.skipped).toEqual([]);
			expect((await fs.stat(path.join(target, "b.bin"))).size).toBe(SEED_MAX_BYTES + 1);
		} else expect(report).toMatchObject({ copied: 0, cloned: false });
	});

	it("goes back to the byte budget when a later clone fails, counting only what took disk", async () => {
		await fs.writeFile(path.join(repo, ".gitignore"), "*.bin\n");
		gitSync(repo, "commit", "-qam", "ignore bins");
		// Sorted: a (clones), b (the clone fails: a plain copy, within budget), c (plain, over budget), d (never reached).
		await fs.writeFile(path.join(repo, "a.bin"), Buffer.alloc(SEED_MAX_BYTES + 1));
		await fs.writeFile(path.join(repo, "b.bin"), Buffer.alloc(SEED_MAX_BYTES - 10));
		await fs.writeFile(path.join(repo, "c.bin"), Buffer.alloc(100));
		await fs.writeFile(path.join(repo, "d.bin"), Buffer.alloc(1));
		await fs.writeFile(path.join(repo, ".worktreeinclude"), "*.bin\n");
		const target = await freshWorktree("clone-then-not");

		// The first file clones, every later clone is refused: no clone across this mount.
		const report = await seedWorktree(repo, target, { pretendClones: 1 });

		expect(report).toMatchObject({ copied: 2, cloned: false });
		expect(report?.skipped).toEqual([
			{ path: "c.bin", reason: "budget" },
			{ path: "d.bin", reason: "budget" },
		]);
		expect(await pathExists(path.join(target, "b.bin"))).toBe(true);
		expect(await pathExists(path.join(target, "c.bin"))).toBe(false);
	});

	itWithFileSymlinks("refuses symlinks that lead outside the main checkout", async () => {
		const secret = path.join(scratch, "outside-secret");
		await fs.writeFile(secret, "nope\n");
		await fs.mkdir(path.join(scratch, "outside-dir"));
		await fs.writeFile(path.join(scratch, "outside-dir", ".env"), "nope\n");
		await fs.writeFile(path.join(repo, ".gitignore"), ".env\nlink\nvia/\n");
		gitSync(repo, "commit", "-qam", "ignore");
		await fs.symlink(secret, path.join(repo, "link"));
		await fs.symlink(path.join(scratch, "outside-dir"), path.join(repo, "via"));
		await fs.writeFile(path.join(repo, ".worktreeinclude"), "link\nvia/.env\n");
		const target = await freshWorktree("links");

		const report = await seedWorktree(repo, target);

		expect(report?.copied).toBe(0);
		expect(report?.skipped.map(item => item.reason)).toEqual(["symlink_outside", "symlink_outside"]);
		expect(await pathExists(path.join(target, "link"))).toBe(false);
		expect(await pathExists(path.join(target, "via", ".env"))).toBe(false);
	});
	it("recreates an ignored folder link inside the checkout as a link in the worktree", async () => {
		await fs.mkdir(path.join(repo, "store"));
		await fs.writeFile(path.join(repo, "store", "pkg.js"), "x\n");
		await fs.writeFile(path.join(repo, ".gitignore"), "store/\nmodules\n");
		gitSync(repo, "commit", "-qam", "ignore");
		// A junction on Windows (no privilege needed, as pnpm makes them); a folder symlink elsewhere.
		await fs.symlink(path.join(repo, "store"), path.join(repo, "modules"), "junction");
		await fs.writeFile(path.join(repo, ".worktreeinclude"), "modules\n");
		const target = await freshWorktree("junction");

		const report = await seedWorktree(repo, target);

		expect(report?.skipped).toEqual([]);
		expect((await fs.lstat(path.join(target, "modules"))).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(path.join(target, "modules", "pkg.js"), "utf8")).toBe("x\n");
	});
	it("points a link written with an absolute path at the worktree's own copy, never the main checkout's", async () => {
		await fs.mkdir(path.join(repo, "conf"));
		await fs.writeFile(path.join(repo, "conf", "app.json"), "{}\n");
		await fs.writeFile(path.join(repo, ".gitignore"), "linked\n");
		gitSync(repo, "add", "conf");
		gitSync(repo, "commit", "-qam", "conf");
		await fs.symlink(path.join(repo, "conf"), path.join(repo, "linked"), "junction");
		await fs.writeFile(path.join(repo, ".worktreeinclude"), "linked\n");
		const target = await freshWorktree("absolute");

		const report = await seedWorktree(repo, target);

		expect(report?.skipped).toEqual([]);
		await fs.writeFile(path.join(target, "conf", "app.json"), '{"branch":true}\n');
		expect(await fs.readFile(path.join(target, "linked", "app.json"), "utf8")).toBe('{"branch":true}\n');
		expect(await fs.readFile(path.join(repo, "conf", "app.json"), "utf8")).toBe("{}\n");
	});
	itWithFileSymlinks(
		"copies an ignored file link on Windows, where making a file symlink needs Developer Mode, and recreates it elsewhere",
		async () => {
			await fs.writeFile(path.join(repo, "real.env"), "A=1\n");
			await fs.writeFile(path.join(repo, ".gitignore"), "*.env\n");
			gitSync(repo, "commit", "-qam", "ignore");
			await fs.symlink(path.join(repo, "real.env"), path.join(repo, "link.env"));
			await fs.writeFile(path.join(repo, ".worktreeinclude"), "link.env\n");
			const target = await freshWorktree("filelink");

			const report = await seedWorktree(repo, target);

			expect(report?.skipped).toEqual([]);
			expect((await fs.lstat(path.join(target, "link.env"))).isSymbolicLink()).toBe(process.platform !== "win32");
			expect(await fs.readFile(path.join(target, "link.env"), "utf8")).toBe("A=1\n");
		},
	);
	it("leaves a force-added tracked file inside an ignored folder out, even when the target branch lacks it", async () => {
		await fs.writeFile(path.join(repo, ".gitignore"), "cache/\n");
		await fs.mkdir(path.join(repo, "cache"));
		await fs.writeFile(path.join(repo, "cache", "pinned.txt"), "tracked\n");
		gitSync(repo, "add", "-f", ".gitignore", "cache/pinned.txt");
		gitSync(repo, "commit", "-q", "-m", "force-add");
		await fs.writeFile(path.join(repo, "cache", "local.bin"), "ignored\n");
		await fs.writeFile(path.join(repo, ".worktreeinclude"), "cache\n");
		// The target branch starts before the force-add, so the tracked file is absent there.
		const target = path.join(scratch, "older");
		gitSync(repo, "worktree", "add", "-q", "-b", "older", target, "HEAD~1");

		const report = await seedWorktree(repo, target);

		expect(await fs.readFile(path.join(target, "cache", "local.bin"), "utf8")).toBe("ignored\n");
		expect(await pathExists(path.join(target, "cache", "pinned.txt"))).toBe(false);
		expect(report?.skipped).toContainEqual({ path: path.join("cache", "pinned.txt"), reason: "not_ignored" });
	});

	itWithFileSymlinks(
		"never writes through a target-branch folder symlink that leads outside the worktree",
		async () => {
			const elsewhere = path.join(scratch, "elsewhere");
			await fs.mkdir(elsewhere);
			await fs.writeFile(path.join(repo, ".gitignore"), "conf/.env\n");
			gitSync(repo, "add", ".gitignore");
			gitSync(repo, "commit", "-q", "-m", "ignore");
			const target = await freshWorktree("trap");
			await fs.symlink(elsewhere, path.join(target, "conf"));
			gitSync(target, "add", "conf");
			gitSync(target, "commit", "-q", "-m", "conf is a link");
			await fs.mkdir(path.join(repo, "conf"));
			await fs.writeFile(path.join(repo, "conf", ".env"), "SECRET=1\n");
			await fs.writeFile(path.join(repo, ".worktreeinclude"), "conf/.env\n");

			const report = await seedWorktree(repo, target);

			expect(await fs.readdir(elsewhere)).toEqual([]);
			expect(report?.copied).toBe(0);
			expect(report?.skipped).toContainEqual({ path: "conf/.env", reason: "destination_outside" });
		},
	);
});

async function nodeHook(root: string, hook: WorktreeHook, source: string): Promise<void> {
	const script = path.join(root, WORKTREE_HOOK_SCRIPTS[hook]);
	const program = `${script}.cjs`;
	await fs.mkdir(path.dirname(script), { recursive: true });
	await fs.writeFile(program, source);
	const command = `"${process.execPath}" "${program}"`;
	await fs.writeFile(script, process.platform === "win32" ? `@${command}\r\n` : `exec ${command}\n`);
}

describe("the standalone worktree hook supervisor", () => {
	it.each([
		["setup", 0, true],
		["pre-merge", 4, false],
		["post-merge", 130, true],
		["archive", 2, false],
	] as const)("keeps the captured %s result, log and last 4096 UTF-16 units", async (hook, code, fromPrimary) => {
		const primary = path.join(scratch, "fixture primary");
		await fs.rename(repo, primary);
		const worktree = path.join(scratch, "fixture worktree");
		gitSync(primary, "worktree", "add", "-q", "-b", "fixture", worktree);
		const cwd = hook === "post-merge" ? primary : worktree;
		const where = { primary, worktree, cwd };
		expect(await runWorktreeHook(hook, where)).toBeNull();
		expect(describePreparation({})).toBeNull();
		const source = `
			const fs = require('node:fs');
			fs.writeFileSync('seen.json', JSON.stringify([process.cwd(), process.env.OMPDESK_ROOT_PATH, process.env.OMPDESK_WORKTREE_PATH, process.env.OMPDESK_HOOK]));
			fs.writeSync(1, 'x'.repeat(4096));
			fs.writeSync(2, 'ERR');
			process.exit(${code});
		`;
		if (!fromPrimary) await nodeHook(primary, hook, "process.exit(99)");
		await nodeHook(fromPrimary ? primary : worktree, hook, source);
		const report = await runWorktreeHook(hook, where);
		const script = path.normalize(WORKTREE_HOOK_SCRIPTS[hook]);
		const logPath = path.join(gitSync(worktree, "rev-parse", "--absolute-git-dir"), `ompdesk-worktree-${hook}.log`);
		const exitCode = code === 130 ? null : code;
		expect(report).toMatchObject({
			script,
			logPath,
			exitCode,
			ok: code === 0,
			timedOut: false,
			outputTail: `${"x".repeat(4093)}ERR`,
		});
		expect(await fs.readFile(logPath, "utf8")).toBe(`${"x".repeat(4096)}ERR`);
		expect(JSON.parse(await fs.readFile(path.join(cwd, "seen.json"), "utf8"))).toEqual([
			cwd,
			primary,
			worktree,
			hook,
		]);
		if (!report) throw new Error("expected a hook result");
		const description = describePreparation({ setup: report });
		if (code === 0) expect(description).toBe(`${script} ran (${Math.round(report.durationMs / 1000)}s)`);
		else expect(description).toBe(`${script} failed (exit ${exitCode}), log ${logPath}`);
	});

	it("reports the captured one-millisecond deadline as a failure", async () => {
		const worktree = await freshWorktree("deadline");
		await nodeHook(repo, "setup", "setTimeout(() => process.exit(0), 3000)");
		expect(await runWorktreeHook("setup", { primary: repo, worktree, cwd: worktree, timeoutMs: 1 })).toMatchObject({
			ok: false,
			exitCode: null,
			timedOut: true,
		});
	});

	it("still runs setup after a seed refusal", async () => {
		const target = await freshWorktree("refused");
		await nodeHook(repo, "setup", "console.log('ready')");
		const failSeed = vi.spyOn(exec, "coreGit").mockRejectedValueOnce(new Error("fixture refusal"));
		try {
			expect(await prepareWorktree(repo, target)).toMatchObject({
				seed: { skipped: [{ path: ".worktreeinclude", reason: "fixture refusal" }] },
				setup: { ok: true, exitCode: 0, timedOut: false },
			});
		} finally {
			failSeed.mockRestore();
		}
	});

	it("decodes invalid UTF-8, respects write order and keeps a split surrogate even with no writable log", async () => {
		const worktree = await freshWorktree("encoding");
		const log = path.join(gitSync(worktree, "rev-parse", "--absolute-git-dir"), "ompdesk-worktree-setup.log");
		await nodeHook(
			repo,
			"setup",
			`
			const { writeSync } = require('node:fs');
			writeSync(1, Buffer.from([255, 0xf0, 0x9f]));
			writeSync(2, Buffer.from([0x98, 0x80]));
			writeSync(1, 'x'.repeat(4095));
			process.exit(3);
		`,
		);
		const where = { primary: repo, worktree, cwd: worktree };
		const expected = `�😀${"x".repeat(4095)}`;
		expect(await runWorktreeHook("setup", where)).toMatchObject({ exitCode: 3, outputTail: expected.slice(-4096) });
		expect(await fs.readFile(log, "utf8")).toBe(expected);
		await fs.unlink(log);
		await fs.mkdir(log);
		expect(await runWorktreeHook("setup", where)).toMatchObject({ exitCode: 3, outputTail: expected.slice(-4096) });
		expect((await fs.stat(log)).isDirectory()).toBe(true);
	});

	itWithFileSymlinks("publishes the new log only after exit, never through a repo-supplied symlink", async () => {
		const worktree = await freshWorktree("log-link");
		const log = path.join(gitSync(worktree, "rev-parse", "--absolute-git-dir"), "ompdesk-worktree-setup.log");
		const elsewhere = path.join(scratch, "untouched");
		await fs.writeFile(elsewhere, "previous");
		await fs.symlink(elsewhere, log);
		await nodeHook(
			repo,
			"setup",
			`
			const fs = require('node:fs');
			fs.writeSync(2, 'new ');
			fs.writeSync(1, fs.readFileSync(${JSON.stringify(log)}));
			process.exit(4);
		`,
		);
		expect(await runWorktreeHook("setup", { primary: repo, worktree, cwd: worktree })).toMatchObject({
			exitCode: 4,
			outputTail: "new previous",
		});
		expect(await fs.readFile(log, "utf8")).toBe("new previous");
		expect(await fs.readFile(elsewhere, "utf8")).toBe("previous");
	});

	it("keeps the hook alive across its discovery core's restart, then drains it before the next repo holder", async () => {
		const worktree = await freshWorktree("restarted");
		const pidFile = path.join(worktree, "pid");
		const release = path.join(worktree, "restarted");
		const observed = path.join(worktree, "observed");
		const log = path.join(gitSync(worktree, "rev-parse", "--absolute-git-dir"), "ompdesk-worktree-setup.log");
		await nodeHook(
			repo,
			"setup",
			`
			const fs = require('node:fs');
			process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150));
			fs.writeFileSync('pid', String(process.pid));
			const timer = setInterval(() => {
				if (!fs.existsSync('restarted')) return;
				fs.writeSync(1, 'after restart');
				fs.writeFileSync('observed', String(process.pid));
				clearInterval(timer);
			}, 20);
			setTimeout(() => process.exit(91), 30000);
		`,
		);
		const core = new cores.CoreProcess({ binary: () => nativeBinPath("ompdesk-core") });
		const scoped = vi.spyOn(cores, "core").mockReturnValue(core);
		const stallLog = vi.spyOn(runtimeLog, "writeRuntimeLog").mockImplementation(() => {});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let drained: Promise<unknown> | undefined;
		const held = exec
			.withRepoLock(repo, () => {
				const running = runWorktreeHook("setup", { primary: repo, worktree, cwd: worktree });
				drained = running.catch(() => null);
				return running;
			})
			.catch(error => error);
		try {
			await vi.waitFor(async () => expect(Number(await fs.readFile(pidFile, "utf8"))).toBeGreaterThan(0), {
				timeout: 15_000,
			});
			const pid = Number(await fs.readFile(pidFile, "utf8"));
			const first = core.generation;
			expect(first).toBeGreaterThan(0);
			core.abandon("restart the disposable discovery core");
			await core.stop();
			expect((await core.call("core.echo", { value: 2 })).generation).not.toBe(first);
			await fs.writeFile(release, "");
			await vi.waitFor(async () => expect(await fs.readFile(observed, "utf8")).toBe(String(pid)), {
				timeout: 15000,
			});
			await vi.advanceTimersByTimeAsync(exec.REPO_LOCK_HOLD_MS);
			expect(await held).toBeInstanceOf(StepStalledError);
			await exec.withRepoLock(repo, async () => {
				expect(() => process.kill(pid, 0)).toThrow();
				expect(await fs.readFile(log, "utf8")).toBe("after restart");
			});
		} finally {
			try {
				await vi.advanceTimersByTimeAsync(exec.REPO_LOCK_HOLD_MS);
				await held;
				await drained;
			} finally {
				vi.useRealTimers();
				scoped.mockRestore();
				stallLog.mockRestore();
				await core.stop();
			}
		}
	}, 60_000);
});

describe.skipIf(process.platform !== "win32")("worktree hook on Windows", () => {
	it("runs the .cmd script, the worktree's own before the main checkout's, and logs to the worktree's git dir", async () => {
		await fs.mkdir(path.join(repo, ".ompdesk"));
		await fs.writeFile(
			path.join(repo, WORKTREE_HOOK_SCRIPTS.setup),
			"@echo setup in %CD%\r\n@echo %OMPDESK_HOOK%>from-hook.txt\r\n",
		);
		// A space in the folder: the script's path goes through cmd.exe's quoting.
		const target = path.join(scratch, "cmd hook");
		gitSync(repo, "worktree", "add", "-q", "-b", "cmd-hook", target);

		const fromPrimary = await runWorktreeHook("setup", { primary: repo, worktree: target, cwd: target });

		expect(fromPrimary).toMatchObject({ ok: true, exitCode: 0, script: ".ompdesk\\worktree-setup.cmd" });
		expect(fromPrimary?.outputTail).toContain(`setup in ${target}`);
		expect((await fs.readFile(path.join(target, "from-hook.txt"), "utf8")).trim()).toBe("setup");
		const gitDir = gitSync(target, "rev-parse", "--absolute-git-dir");
		expect(fromPrimary?.logPath).toBe(path.join(gitDir, "ompdesk-worktree-setup.log"));
		expect(await fs.readFile(fromPrimary?.logPath ?? "", "utf8")).toContain("setup in");

		await fs.mkdir(path.join(target, ".ompdesk"), { recursive: true });
		await fs.writeFile(path.join(target, WORKTREE_HOOK_SCRIPTS.setup), "@echo own\r\n@exit /b 4\r\n");
		const fromWorktree = await runWorktreeHook("setup", { primary: repo, worktree: target, cwd: target });
		expect(fromWorktree).toMatchObject({ ok: false, exitCode: 4 });
		expect(fromWorktree?.outputTail).toContain("own");
		expect(await runWorktreeHook("pre-merge", { primary: repo, worktree: target, cwd: target })).toBeNull();
	});
});

describe.skipIf(process.platform === "win32")("worktree setup hook", () => {
	it("runs .ompdesk/worktree-setup in the new worktree through createWorktree", async () => {
		await fs.mkdir(path.join(repo, ".ompdesk"));
		await fs.writeFile(
			path.join(repo, WORKTREE_HOOK_SCRIPTS.setup),
			'echo "setup in $PWD"\nprintf "%s\\n" "$OMPDESK_ROOT_PATH" >> from-root.txt\n',
		);
		await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env\n");
		await fs.writeFile(path.join(repo, ".env"), "A=1\n");
		gitSync(repo, "add", ".ompdesk", ".worktreeinclude");
		gitSync(repo, "commit", "-q", "-m", "hook");

		const args = { name: "hooked", request: { caller: "local", id: repo } };
		const [made, repeat] = await Promise.all([
			createWorktree(repo, args, bridge),
			createWorktree(repo, args, bridge),
		]);
		expect(repeat.path).toBe(made.path);

		expect(made.seed?.copied).toBe(1);
		expect(made.setup).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
		expect(made.setup?.outputTail).toContain(`setup in ${made.path}`);
		expect(await fs.readFile(path.join(made.path, "from-root.txt"), "utf8")).toBe(`${repo}\n`);
		expect(await fs.readFile(made.setup?.logPath ?? "", "utf8")).toContain("setup in");
	});

	it("reports a failing hook without failing the worktree", async () => {
		await fs.mkdir(path.join(repo, ".ompdesk"));
		await fs.writeFile(path.join(repo, WORKTREE_HOOK_SCRIPTS.setup), "echo broken >&2\nexit 3\n");

		const made = await createWorktree(repo, { name: "broken" }, bridge);

		expect(await pathExists(made.path)).toBe(true);
		expect(made.setup).toMatchObject({ ok: false, exitCode: 3, timedOut: false });
		expect(made.setup?.outputTail).toContain("broken");
	});

	it("kills a hook past its timeout and never takes its exit code as success", async () => {
		await fs.mkdir(path.join(repo, ".ompdesk"));
		await fs.writeFile(path.join(repo, WORKTREE_HOOK_SCRIPTS.setup), "trap 'exit 0' TERM\nsleep 30\n");
		const target = await freshWorktree("slow");

		const report = await runWorktreeHook("setup", { primary: repo, worktree: target, cwd: target, timeoutMs: 500 });

		expect(report).toMatchObject({ ok: false, timedOut: true, exitCode: null });
	});

	it("runs nothing without the script", async () => {
		expect(
			await runWorktreeHook("setup", { primary: repo, worktree: await freshWorktree("plain"), cwd: repo }),
		).toBeNull();
	});

	it.each(["pre-merge", "post-merge"] as const)(
		"finds the %s script, the worktree's own before the main checkout's",
		async hook => {
			await fs.mkdir(path.join(repo, ".ompdesk"));
			await fs.writeFile(path.join(repo, WORKTREE_HOOK_SCRIPTS[hook]), 'echo "primary $OMPDESK_HOOK"\n');
			const target = await freshWorktree(`own-${hook}`);

			const fromPrimary = await runWorktreeHook(hook, { primary: repo, worktree: target, cwd: target });
			expect(fromPrimary).toMatchObject({ ok: true, script: `.ompdesk/worktree-${hook}` });
			expect(fromPrimary?.outputTail).toContain(`primary ${hook}`);
			expect(path.basename(fromPrimary?.logPath ?? "")).toBe(`ompdesk-worktree-${hook}.log`);

			await fs.mkdir(path.join(target, ".ompdesk"), { recursive: true });
			await fs.writeFile(path.join(target, WORKTREE_HOOK_SCRIPTS[hook]), "echo own\nexit 4\n");
			const fromWorktree = await runWorktreeHook(hook, { primary: repo, worktree: target, cwd: target });
			expect(fromWorktree).toMatchObject({ ok: false, exitCode: 4 });
			expect(fromWorktree?.outputTail).toContain("own");
		},
	);

	it("runs a hook in the folder it is told, with no script for another hook", async () => {
		await fs.mkdir(path.join(repo, ".ompdesk"));
		await fs.writeFile(path.join(repo, WORKTREE_HOOK_SCRIPTS["pre-merge"]), "pwd\n");
		const target = await freshWorktree("cwd");

		expect(await runWorktreeHook("post-merge", { primary: repo, worktree: target, cwd: target })).toBeNull();
		const report = await runWorktreeHook("pre-merge", { primary: repo, worktree: target, cwd: repo });
		expect(report?.outputTail.trim()).toBe(await fs.realpath(repo));
	});
});
