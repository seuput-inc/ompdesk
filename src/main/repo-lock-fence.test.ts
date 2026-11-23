/**
 * What a repository-lock holder that ran past its bound can still do. Two cases, both on the fake clock only (the fs,
 * git and child processes are real):
 *  - an effect it has not started yet (its code resumes after a late answer that is not an fs call): fenced, it throws
 *    before it starts and never lands on what the next holder made;
 *  - an effect the OS already has (an fs call dispatched, a child still exiting): the caller hears of the stop at once,
 *    but the lock is not handed to the next holder until that effect settled, so it cannot finish against the next
 *    holder's files; a call still running `STALLED_DRAIN_MAX_MS` after the stop makes every mutation fail busy (naming it)
 *    until it ended, and then the repository is usable again.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { timeoutForCommand } from "../shared/rpc-client";
import { SavedWorktreeStore } from "./disk/saved-worktrees";
import { fs } from "./fenced-fs";
import { primaryRoot, repoRoot } from "./local/git/changes";
import { execBin, REPO_LOCK_HOLD_MS, withRepoLock } from "./local/git/exec";
import * as scm from "./local/git/scm";
import { gitSync } from "./local/git/test-repos";
import { createWorktree } from "./local/git/worktree";
import { WORKTREE_PREPARE_BUDGET_MS } from "./local/git/worktree-seed";
import { ChainBusyError, SerialChain, STALLED_DRAIN_MAX_MS, StepStalledError, trackEffect } from "./serial-chain";
import { DIES_WITH_TEST } from "./test-fake-omp";
import { removeOrphanWorktree } from "./worktree-orphans";
import { bridge, deps, installOrphansRig, repo, root, SLOW, scene, wtRoot } from "./worktree-orphans-test-rig";

installOrphansRig();

type Held = "realpath" | "mkdir" | "rm" | "rename" | "writeFile" | "copyFile" | "symlink" | "readFile";

interface HeldCall {
	/** The call was made (and is held). */
	reached: Promise<void>;
	/** The real operation finished (after `release`). */
	answered: Promise<void>;
	release: () => void;
}

/** Holds the first `method` call whose first argument is `target` until `release()`, then runs it for real. */
function hold(method: Held, target: string, order?: string[]): HeldCall {
	const real = promises[method].bind(promises) as (...args: unknown[]) => Promise<unknown>;
	const reached = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const answered = Promise.withResolvers<void>();
	let used = false;
	vi.spyOn(promises, method).mockImplementation((async (...args: unknown[]) => {
		if (used || args[0] !== target) return real(...args);
		used = true;
		reached.resolve();
		await released.promise;
		const answer = await real(...args);
		order?.push(`${method} done`);
		answered.resolve();
		return answer;
	}) as never);
	return { reached: reached.promise, answered: answered.promise, release: () => released.resolve() };
}

/** Real fs round trips: enough for anything a resumed holder still started to land. */
async function settle(): Promise<void> {
	for (let round = 0; round < 25; round++) await promises.stat(os.tmpdir());
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const caught = (run: Promise<unknown>): Promise<unknown> =>
	run.then(
		() => null,
		error => error,
	);

type Op = [
	name: string,
	act: (dir: string) => Promise<unknown>,
	verify: (dir: string, order: string[]) => Promise<void>,
];

const read = (dir: string, name: string) => promises.readFile(path.join(dir, name), "utf8");
const missing = (dir: string, name: string) => expect(promises.lstat(path.join(dir, name))).rejects.toThrow();

describe("an effect a stopped holder has not started", () => {
	const ops: Array<[string, Op[1], Op[2]]> = [
		[
			"rm",
			dir => fs.rm(path.join(dir, "kept.txt"), { force: true, recursive: true }),
			async dir => expect(await read(dir, "kept.txt")).toBe("next holder\n"),
		],
		[
			"rename",
			dir => fs.rename(path.join(dir, "kept.txt"), path.join(dir, "moved.txt")),
			async dir => {
				expect(await read(dir, "kept.txt")).toBe("next holder\n");
				await missing(dir, "moved.txt");
			},
		],
		[
			"writeFile",
			dir => fs.writeFile(path.join(dir, "kept.txt"), "old holder\n"),
			async dir => expect(await read(dir, "kept.txt")).toBe("next holder\n"),
		],
		[
			"copyFile",
			dir => fs.copyFile(path.join(dir, "kept.txt"), path.join(dir, "copy.txt")),
			dir => missing(dir, "copy.txt"),
		],
		["symlink", dir => fs.symlink(path.join(dir, "kept.txt"), path.join(dir, "link")), dir => missing(dir, "link")],
		["mkdir", dir => fs.mkdir(path.join(dir, "made", "deep"), { recursive: true }), dir => missing(dir, "made")],
	];

	it.each(ops)("%s is refused when the holder resumes after the next one ran", async (name, act, verify) => {
		const dir = path.join(root, `late-${name}`);
		await promises.mkdir(dir);
		const key = `/repo/late-${name}`;
		const gate = Promise.withResolvers<void>();
		const old = caught(
			withRepoLock(key, async () => {
				await gate.promise;
				await act(dir);
			}),
		);
		const next = withRepoLock(key, () => promises.writeFile(path.join(dir, "kept.txt"), "next holder\n"));
		await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
		await next;
		gate.resolve();
		expect(await old).toBeInstanceOf(StepStalledError);
		await settle();
		await verify(dir, []);
	});
});

describe("an effect the OS already has when the holder is stopped", () => {
	const inFlight: Array<[string, Op[1], Op[2]]> = [
		[
			"rm",
			dir => fs.rm(path.join(dir, "kept.txt"), { force: true }),
			async dir => expect(await read(dir, "kept.txt")).toBe("next holder\n"),
		],
		[
			"rename",
			dir => fs.rename(path.join(dir, "kept.txt"), path.join(dir, "moved.txt")),
			async dir => {
				expect(await read(dir, "kept.txt")).toBe("next holder\n");
				expect(await read(dir, "moved.txt")).toBe("old\n");
			},
		],
		[
			"writeFile",
			dir => fs.writeFile(path.join(dir, "kept.txt"), "old holder\n"),
			async dir => expect(await read(dir, "kept.txt")).toBe("next holder\n"),
		],
		[
			"copyFile",
			dir => fs.copyFile(path.join(dir, "kept.txt"), path.join(dir, "copy.txt")),
			async dir => expect(await read(dir, "copy.txt")).toBe("old\n"),
		],
		[
			"symlink",
			dir => fs.symlink("kept.txt", path.join(dir, "link")),
			async dir => expect(await read(dir, "link")).toBe("next holder\n"),
		],
	];

	it.each(inFlight)(
		"%s finishes before the next holder starts, and the next holder's file survives",
		async (name, act, verify) => {
			const dir = path.join(root, `flight-${name}`);
			await promises.mkdir(dir);
			await promises.writeFile(path.join(dir, "kept.txt"), "old\n");
			const order: string[] = [];
			// `symlink`'s first argument is the link's target, the others' is the file.
			const held = hold(name as Held, name === "symlink" ? "kept.txt" : path.join(dir, "kept.txt"), order);
			const key = `/repo/flight-${name}`;
			const old = caught(withRepoLock(key, () => act(dir)));
			const next = withRepoLock(key, async () => {
				order.push("next start");
				await promises.rm(path.join(dir, "kept.txt"), { force: true });
				await promises.writeFile(path.join(dir, "kept.txt"), "next holder\n");
			});
			await held.reached;
			await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
			// The caller is told at once; the lock is not free while the call is still out.
			expect(await old).toBeInstanceOf(StepStalledError);
			await settle();
			expect(order).toEqual([]);
			held.release();
			await next;
			await settle();
			expect(order).toEqual([`${name} done`, "next start"]);
			await verify(dir, order);
		},
	);

	it("a call still running a minute after the stop makes every mutation fail busy, naming it, until it ended", async () => {
		const dir = path.join(root, "busy");
		await promises.mkdir(dir);
		await promises.writeFile(path.join(dir, "kept.txt"), "old\n");
		const order: string[] = [];
		const held = hold("rm", path.join(dir, "kept.txt"), order);
		const key = "/repo/busy";
		const old = caught(withRepoLock(key, () => fs.rm(path.join(dir, "kept.txt"), { force: true })));
		const queued = caught(
			withRepoLock(key, async () => {
				order.push("queued start");
				await promises.writeFile(path.join(dir, "kept.txt"), "queued\n");
			}),
		);
		await held.reached;
		await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
		expect(await old).toBeInstanceOf(StepStalledError);
		// Within the bound the next mutation waits for the call; past it, it is refused and creates nothing.
		await vi.advanceTimersByTimeAsync(STALLED_DRAIN_MAX_MS);
		expect(await queued).toMatchObject({
			name: "LocalCommandError",
			code: "repo_busy",
			message: expect.stringContaining("fs.rm"),
		});
		// And a mutation that comes later fails at once, without waiting.
		const later = withRepoLock(key, async () => {
			order.push("later start");
		});
		await expect(later).rejects.toMatchObject({ code: "repo_busy" });
		await settle();
		expect(order).toEqual([]);
		expect(await promises.readFile(path.join(dir, "kept.txt"), "utf8")).toBe("old\n");
		// The moment the call ended the repository is usable again: no restart.
		held.release();
		await held.answered;
		await settle();
		await withRepoLock(key, async () => {
			order.push("after start");
			await promises.writeFile(path.join(dir, "kept.txt"), "after\n");
		});
		expect(order).toEqual(["rm done", "after start"]);
		expect(await promises.readFile(path.join(dir, "kept.txt"), "utf8")).toBe("after\n");
	});

	it("a chain refuses steps naming what still runs, and logs it once, until it ended", async () => {
		const logged: Array<[string, string, string[]]> = [];
		const chain = new SerialChain({
			name: "test",
			maxStepMs: 1_000,
			logBusy: (c, step, pending) => logged.push([c, step, pending]),
			log: () => {},
		});
		const end = Promise.withResolvers<void>();
		const hung = caught(chain.run(() => trackEffect("fs.rm /x", end.promise), "holder"));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await hung).toBeInstanceOf(StepStalledError);
		await vi.advanceTimersByTimeAsync(STALLED_DRAIN_MAX_MS);
		expect(logged).toEqual([["test", "holder", ["fs.rm /x"]]]);
		const refused = await caught(chain.run(async () => "ran", "next"));
		expect(refused).toBeInstanceOf(ChainBusyError);
		expect((refused as ChainBusyError).pending).toEqual(["fs.rm /x"]);
		end.resolve();
		await settle();
		expect(await chain.run(async () => "ran", "next")).toBe("ran");
	});

	it.skipIf(process.platform === "win32")(
		"a git child that ignores SIGTERM: the next holder starts only after it exited",
		async () => {
			const pidFile = path.join(root, "pid");
			const script = `${DIES_WITH_TEST} process.on("SIGTERM", () => {}); require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1e9)`;
			const key = "/repo/sigterm";
			let started = false;
			const old = caught(
				withRepoLock(key, () =>
					execBin(process.execPath, ["-e", script, pidFile], { cwd: root, timeoutMs: 24 * 60 * 60_000 }),
				),
			);
			const next = withRepoLock(key, async () => {
				started = true;
			});
			let pid = 0;
			await vi.waitFor(
				async () => {
					pid = Number(await promises.readFile(pidFile, "utf8"));
					expect(pid).toBeGreaterThan(0);
				},
				{ timeout: 20_000, interval: 20 },
			);
			await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
			expect(await old).toBeInstanceOf(StepStalledError);
			// SIGTERM was sent and ignored: it is still alive, and the lock is still held.
			await settle();
			expect(alive(pid)).toBe(true);
			expect(started).toBe(false);
			// The kill after the grace period ends it; only then the next holder starts.
			await vi.advanceTimersByTimeAsync(2_000);
			await next;
			expect(started).toBe(true);
			expect(alive(pid)).toBe(false);
		},
	);
});

describe("every caller of withRepoLock that touches the disk", () => {
	it(
		"scm discard: a removal already dispatched ends before the next holder starts, and its file survives",
		async () => {
			const file = path.join(root, "repo", "fresh.txt");
			await promises.writeFile(file, "mine\n");
			await scm.stage(repo, ["fresh.txt"]);
			const target = path.join(await promises.realpath(repo), "fresh.txt");
			const order: string[] = [];
			const held = hold("rm", target, order);
			// The key `discard` locks: the checkout root git reports.
			const key = (await repoRoot(repo)) as string;
			const old = caught(scm.discard(repo, ["fresh.txt"]));
			// Queued once the discard holds the lock (it reads the checkout root first).
			await held.reached;
			const next = withRepoLock(key, async () => {
				order.push("next start");
				await promises.writeFile(file, "next holder\n");
			});
			await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
			expect(await old).toBeInstanceOf(Error);
			await settle();
			expect(order).toEqual([]);
			held.release();
			await next;
			await settle();
			expect(order).toEqual(["rm done", "next start"]);
			expect(await promises.readFile(file, "utf8")).toBe("next holder\n");
		},
		SLOW,
	);

	it.skipIf(process.platform === "win32")(
		"scm commit in the core: a stopped holder's git is ended, and the next holder starts once it exited",
		async () => {
			const marker = `late-${randomUUID()}`;
			const gitRunning = () =>
				execFileSync("ps", ["-A", "-o", "args="], { encoding: "utf8" })
					.split("\n")
					.some(line => line.includes(marker));
			const ready = path.join(root, "hook-pid");
			const hook = path.join(repo, ".git", "hooks", "pre-commit");
			await promises.mkdir(path.dirname(hook), { recursive: true });
			await promises.writeFile(hook, `#!/bin/sh\necho $$ > '${ready}'\nexec sleep 60 </dev/null >/dev/null 2>&1\n`, {
				mode: 0o755,
			});
			await promises.writeFile(path.join(repo, "a.txt"), "a\n");
			await scm.stage(repo, ["a.txt"]);
			const key = (await repoRoot(repo)) as string;
			// The lock step is stopped through its caller's own bounded step, so no other timer of the request runs out.
			const caller = new SerialChain({ name: "caller", maxStepMs: 1_000, log: () => {} });
			const old = caught(caller.run(() => scm.commit(repo, { message: marker })));
			let hookPid = 0;
			await vi.waitFor(
				async () => {
					hookPid = Number(await promises.readFile(ready, "utf8"));
					expect(hookPid).toBeGreaterThan(0);
				},
				{ timeout: 20_000, interval: 20 },
			);
			try {
				expect(gitRunning()).toBe(true);
				let gitAtStart: boolean | null = null;
				const next = withRepoLock(key, async () => {
					gitAtStart = gitRunning();
				});
				await vi.advanceTimersByTimeAsync(1_000);
				expect(await old).toBeInstanceOf(StepStalledError);
				await next;
				expect(gitAtStart).toBe(false);
				expect(gitSync(repo, "log", "-1", "--format=%s")).toBe("init");
			} finally {
				if (alive(hookPid)) process.kill(hookPid, "SIGKILL");
			}
		},
		SLOW,
	);

	const savedRecord = () => ({
		id: "test-save",
		path: path.join(root, "closed"),
		repo,
		branch: null,
		head: "abc",
		savedBranch: null,
		removedAt: 1,
		archivedFiles: 0,
		archivedBytes: 0,
	});

	it("a late removal proof cannot publish a saved record under the next holder", async () => {
		const store = new SavedWorktreeStore(path.join(root, "saved"));
		const key = "/repo/fence-saved";
		const proof = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const attempted = Promise.withResolvers<void>();
		const old = caught(
			withRepoLock(key, async () => {
				started.resolve();
				await proof.promise;
				try {
					await store.settle(savedRecord(), true);
				} finally {
					attempted.resolve();
				}
			}),
		);
		await started.promise;
		const next = withRepoLock(key, () => store.settle({ ...savedRecord(), id: "next" }, true));
		await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
		expect(await old).toBeInstanceOf(StepStalledError);
		await next;
		proof.resolve();
		await attempted.promise;
		expect((await store.list(repo)).map(row => row.id)).toEqual(["next"]);
	});

	it.skipIf(process.platform === "win32")(
		"a cancelled native saved-record read drains before handover and never renames",
		async () => {
			const store = new SavedWorktreeStore(path.join(root, "saved"));
			await promises.mkdir(store.dir);
			const file = path.join(store.dir, "saved.json");
			execFileSync("mkfifo", [file]);
			const key = "/repo/fence-saved-read";
			const caller = new SerialChain({ name: "caller", maxStepMs: 1_000, log: () => {} });
			const old = caught(caller.run(() => withRepoLock(key, () => store.settle(savedRecord(), true))));
			const writer = await promises.open(file, "w"); // The real Rust reader has opened its end.
			let handedOver = false;
			const next = withRepoLock(key, async () => {
				handedOver = true;
			});
			try {
				await vi.advanceTimersByTimeAsync(1_000);
				expect(await old).toBeInstanceOf(StepStalledError);
				// A later frame answered: the core has read the cancel but is still waiting on its OS read.
				await new SavedWorktreeStore(path.join(root, "empty")).find({ id: "absent" });
				expect(handedOver).toBe(false);
				await writer.writeFile("[]");
			} finally {
				await writer.close();
			}
			await next;
			expect((await promises.lstat(file)).isFIFO()).toBe(true);
		},
		SLOW,
	);

	it(
		"worktree create: a stopped native add cannot create a branch or checkout under the next holder",
		async () => {
			const key = await primaryRoot(repo);
			const branch = "omp/gui/late";
			const refDir = path.join(repo, ".git", "refs", "heads", "omp", "gui");
			const refLock = path.join(refDir, "late.lock");
			await promises.mkdir(refDir, { recursive: true });
			await promises.writeFile(refLock, "");
			gitSync(repo, "config", "core.filesRefLockTimeout", "-1");
			// The core recreates this root inside the held request. The competing ref lock stops git making the branch.
			await promises.rmdir(wtRoot);
			const requested = Promise.withResolvers<void>();
			const location = Promise.withResolvers<void>();
			const stopped = vi.fn();
			const old = caught(
				createWorktree(
					repo,
					{ name: "late" },
					{
						async request<T>(method: string) {
							requested.resolve();
							await location.promise;
							return bridge.request<T>(method);
						},
					},
				),
			).then(stopped);
			try {
				const limit = timeoutForCommand({ type: "worktree_create", name: "late" });
				if (limit === undefined) throw new Error("worktree_create has no RPC budget");
				const createMs = limit - WORKTREE_PREPARE_BUDGET_MS;
				const spentMs = 90_000;
				await requested.promise;
				await vi.advanceTimersByTimeAsync(spentMs);
				location.resolve();
				await vi.waitFor(() => promises.access(wtRoot), { timeout: 20_000, interval: 20 });
				const next = withRepoLock(key, async () => {
					await promises.unlink(refLock);
					gitSync(repo, "branch", branch);
				});
				await vi.advanceTimersByTimeAsync(createMs - spentMs);
				expect(stopped).toHaveBeenCalledWith(expect.any(StepStalledError));
				await old;
				await next;
				expect(gitSync(repo, "rev-parse", branch)).toBe(gitSync(repo, "rev-parse", "HEAD"));
				expect(await promises.readdir(wtRoot)).toEqual([]);
			} finally {
				location.resolve();
				await promises.rm(refLock, { force: true });
			}
		},
		SLOW,
	);

	it(
		"orphan removal (the save-and-remove and session worktree removals remove through the same git call): a late listing never removes the worktree",
		async () => {
			const dirs = await scene();
			const held = hold("realpath", wtRoot);
			const key = await primaryRoot(repo);
			const old = caught(removeOrphanWorktree(repo, dirs.landed as string, deps));
			const next = withRepoLock(key, async () => {});
			await held.reached;
			await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
			held.release();
			await next;
			expect(await old).toBeInstanceOf(StepStalledError);
			await settle();
			await promises.stat(dirs.landed as string);
			expect(gitSync(repo, "branch", "--list", "omp/gui/landed")).toContain("omp/gui/landed");
		},
		SLOW,
	);
});
