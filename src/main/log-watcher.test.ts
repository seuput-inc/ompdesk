import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { CORE_EXITED, core } from "./core/process";
import { LogWatcher } from "./log-watcher";

/** Count resources in the process that actually tails the files. Linux can attach many inotify watches to one fd. */
function watchResources(): number {
	const pid = core().pid;
	if (!pid) throw new Error("log watcher has no running core");
	if (process.platform === "win32") {
		const handles = execFileSync(
			"powershell.exe",
			["-NoProfile", "-Command", `(Get-Process -Id ${pid}).HandleCount`],
			{ encoding: "utf8" },
		);
		return Number(handles.trim());
	}
	if (process.platform === "darwin") {
		const list = execFileSync("/usr/sbin/lsof", ["-nP", "-p", String(pid), "-Ff"], { encoding: "utf8" });
		return list.split("\n").filter(line => /^f\d+$/.test(line)).length;
	}
	const info = `/proc/${pid}/fdinfo`;
	const entries = readdirSync(info);
	let count = entries.length;
	for (const fd of entries) {
		try {
			count += readFileSync(path.join(info, fd), "utf8").split("\ninotify wd:").length - 1;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return count;
}

test("opening logs later replays complete lines once, including split appends", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-log-test-"));
	const file = path.join(directory, "omp.test.log");
	await fs.writeFile(file, "previous run\n");
	const watcher = new LogWatcher(directory);
	const batches: string[] = [];
	watcher.onLines = batch => batches.push(...batch.lines);
	try {
		await watcher.start();
		await fs.appendFile(file, "[info] split");
		await delay(200);
		expect((await watcher.getSnapshot()).lines).toEqual([]);
		await fs.appendFile(file, " message\n[error] failed\n");
		await expect
			.poll(async () => (await watcher.getSnapshot()).lines)
			.toEqual(["[info] split message", "[error] failed"]);
		await expect.poll(() => batches).toEqual(["[info] split message", "[error] failed"]);
		expect(await watcher.getSnapshot()).toEqual({ lines: batches, nextSequence: 2 });
	} finally {
		await watcher.stop();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

// The installed app held 1,131 of its 1,325 descriptors on ~/.omp/logs: one per omp log since the logs dir began,
// because every omp.*.log got its own fs.watch (a kqueue descriptor on macOS, a directory handle on Windows).
test("holds no descriptor per log file and still tails the live ones", { timeout: 20_000 }, async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-log-fds-"));
	const watcher = new LogWatcher(directory);
	const live = [1, 2, 3].map(i => path.join(directory, `omp.2026-10-20.${90_000 + i}.log`));
	try {
		await watcher.start();
		const emptyWatch = watchResources();
		expect(emptyWatch).toBeGreaterThan(0);
		await watcher.stop();
		const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		await Promise.all(
			Array.from({ length: 60 }, async (_, i) => {
				const file = path.join(directory, `omp.2026-10-16.${10_000 + i}.log`);
				await fs.writeFile(file, `old run ${i}\n`);
				await fs.utimes(file, old, old);
			}),
		);
		await Promise.all(live.map(file => fs.writeFile(file, "started\n")));
		await watcher.start();
		expect(watchResources() - emptyWatch).toBeLessThanOrEqual(4);
		for (const [i, file] of live.entries()) await fs.appendFile(file, `live ${i}\n`);
		await expect
			.poll(async () => (await watcher.getSnapshot()).lines.sort(), { timeout: 10_000 })
			.toEqual(["live 0", "live 1", "live 2"]);
		expect(watchResources() - emptyWatch).toBeLessThanOrEqual(4);
	} finally {
		await watcher.stop();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("a long run does not grow per new omp and keeps every line a new omp writes", { timeout: 30_000 }, async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-log-grow-"));
	const watcher = new LogWatcher(directory);
	try {
		await watcher.start();
		const emptyWatch = watchResources();
		const expected: string[] = [];
		for (let i = 0; i < 40; i++) {
			const file = path.join(directory, `omp.2026-10-20.${20_000 + i}.log`);
			// A new omp's first line lands with the file itself, before any watcher can see it.
			await fs.writeFile(file, `omp ${i} boot\n`);
			await fs.appendFile(file, `omp ${i} done\n`);
			expected.push(`omp ${i} boot`, `omp ${i} done`);
			await expect
				.poll(async () => (await watcher.getSnapshot()).lines.length, { timeout: 10_000 })
				.toBe(expected.length);
		}
		expect((await watcher.getSnapshot()).lines.sort()).toEqual(expected.sort());
		expect(watchResources() - emptyWatch).toBeLessThanOrEqual(2);
	} finally {
		await watcher.stop();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("batches retain a whole burst while a snapshot holds its last 1000 lines", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-log-burst-"));
	const watcher = new LogWatcher(directory);
	const lines = Array.from({ length: 1004 }, (_, i) => `line ${i}`);
	const delivered: string[] = [];
	const cursors: number[] = [];
	watcher.onLines = batch => {
		delivered.push(...batch.lines);
		cursors.push(batch.nextSequence - delivered.length);
	};
	try {
		await watcher.start();
		await fs.writeFile(path.join(directory, "omp.burst.log"), `${lines.join("\n")}\n`);
		await expect.poll(() => delivered.length).toBe(lines.length);
		expect(delivered).toEqual(lines);
		expect(cursors.every(offset => offset === 0)).toBe(true);
		expect(await watcher.getSnapshot()).toEqual({ lines: lines.slice(-1000), nextSequence: lines.length });
		await watcher.stop();
		expect(await watcher.getSnapshot()).toEqual({ lines: [], nextSequence: lines.length });
	} finally {
		await watcher.stop();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("rotation drops the previous file's partial line; restart skips writes while stopped", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-log-rotate-"));
	const watcher = new LogWatcher(directory);
	const file = path.join(directory, "omp.rotate.log");
	const delivered: string[] = [];
	watcher.onLines = batch => delivered.push(...batch.lines);
	try {
		await watcher.start();
		await fs.writeFile(file, "before\nunfinished");
		await expect.poll(async () => (await watcher.getSnapshot()).nextSequence).toBe(1);
		await fs.rename(file, `${file}.old`);
		await fs.writeFile(file, "replacement longer than the previous log\n");
		await expect
			.poll(async () => (await watcher.getSnapshot()).lines)
			.toEqual(["before", "replacement longer than the previous log"]);
		await fs.writeFile(file, "short\n");
		await expect.poll(async () => (await watcher.getSnapshot()).lines.at(-1)).toBe("short");
		await watcher.stop();
		expect(delivered).toEqual(["before", "replacement longer than the previous log", "short"]);
		await fs.appendFile(file, "stopped\n");
		await watcher.start();
		await fs.appendFile(file, "again\n");
		await expect.poll(() => watcher.getSnapshot()).toEqual({ lines: ["again"], nextSequence: 4 });
	} finally {
		await watcher.stop();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("a replacement core resumes the live ring and split line without replaying prelaunch bytes", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-log-core-loss-"));
	const live = path.join(directory, "omp.live.log");
	const cold = path.join(directory, "omp.cold.log");
	const retired = path.join(directory, "omp.retired.log");
	const history = Array.from({ length: 1001 }, (_, index) => `retained ${index}`);
	await fs.writeFile(live, "previous run\n");
	await fs.writeFile(cold, "old cold log\n");
	const old = new Date(Date.now() - 86_400_000);
	await fs.utimes(cold, old, old);
	const watcher = new LogWatcher(directory);
	const delivered: string[] = [];
	const cursors: number[] = [];
	watcher.onLines = batch => {
		delivered.push(...batch.lines);
		cursors.push(batch.nextSequence - delivered.length);
	};
	let generation = 0;
	const down = Promise.withResolvers<void>();
	// Registered before the watcher. These writes happen after its core exited and before its replacement starts.
	const off = core().on(CORE_EXITED, (_data, _bin, ended) => {
		if (ended !== generation) return;
		try {
			unlinkSync(retired);
			appendFileSync(live, Buffer.from([0x82, 0xac, 0x0a]));
			appendFileSync(cold, "cold append\n");
			writeFileSync(path.join(directory, "omp.new.log"), "created while down\n");
			down.resolve();
		} catch (error) {
			down.reject(error);
		}
	});
	try {
		await watcher.start();
		generation = core().generation;
		await fs.writeFile(retired, `${history.join("\n")}\n`);
		await expect.poll(() => delivered.length).toBe(history.length);
		await fs.appendFile(live, Buffer.concat([Buffer.from("accepted\nsplit "), Buffer.from([0xe2])]));
		await expect.poll(() => delivered.length).toBe(history.length + 1);
		expect(delivered).toEqual([...history, "accepted"]);
		core().abandon("log recovery test ends its fixture core");
		await down.promise;
		await expect.poll(() => delivered.length, { timeout: 10_000 }).toBe(history.length + 4);
		expect(core().generation).not.toBe(generation);
		expect(delivered.slice(-3).sort()).toEqual(["cold append", "created while down", "split €"]);
		expect(cursors.every(offset => offset === 0)).toBe(true);
		expect(await watcher.getSnapshot()).toEqual({ lines: delivered.slice(-1000), nextSequence: history.length + 4 });
	} finally {
		off();
		await watcher.stop();
		await fs.rm(directory, { recursive: true, force: true });
	}
}, 20_000);
