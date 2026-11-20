import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MachineState,
	type OwnPids,
	STALL_MS,
	STATE_PAIRS_PER_HOUR,
	STATE_REPEAT_MS,
	STATE_SAMPLES,
} from "./machine-state";
import type { MemoryReading, ProcessRow } from "./memory-sampler";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const CPUS = 4;
/** `SAMPLE_TIMEOUT_MS`: how long the core's answer is waited for. */
const TIMEOUT_MS = 4_000;

/** A Windows computer near its commit limit, its processors and disk queued up. */
const READING: MemoryReading = {
	totalBytes: 32 * GB,
	availableBytes: 8 * GB,
	pressure: "normal",
	commitBytes: 30 * GB,
	commitLimitBytes: 40 * GB,
	runQueue: 12.04,
	diskQueue: 3,
	diskBusyPct: 99.96,
};

/**
 * The shell 100 > main 200 > core 300, which runs a stock worker 310 with a child and a tab's launcher 400 > omp 401
 * with a child; 900 and 901 are another program's. `lives` scales the processor time each has used.
 */
function listing(lives: number): ProcessRow[] {
	return [
		{ pid: 100, ppid: 1, bytes: 100 * MB, cpuMs: 200 * lives },
		{ pid: 200, ppid: 100, bytes: 300 * MB, cpuMs: 1_000 * lives },
		{ pid: 300, ppid: 200, bytes: 50 * MB, cpuMs: 400 * lives },
		{ pid: 310, ppid: 300, bytes: 150 * MB, cpuMs: 500 * lives },
		{ pid: 311, ppid: 310, bytes: 10 * MB, cpuMs: 100 * lives },
		{ pid: 400, ppid: 300, bytes: 5 * MB, cpuMs: 0 },
		{ pid: 401, ppid: 400, bytes: 250 * MB, cpuMs: 1_500 * lives },
		{ pid: 402, ppid: 401, bytes: 135 * MB, cpuMs: 500 * lives },
		{ pid: 900, ppid: 1, bytes: 4_000 * MB, cpuMs: 9_000 * lives },
		{ pid: 901, ppid: 900, bytes: MB },
	];
}

function rig() {
	const lines: Array<{ message: string; details: Record<string, string | number | boolean> }> = [];
	const computer = { busyMs: 0, totalMs: 0, mainCpuMs: 0 };
	const pids: OwnPids = { main: 200, host: 100, core: 300 };
	/** What the core answers a fresh read with, and after how long. */
	const fresh = {
		answer: [READING, listing(1)] as readonly [MemoryReading | null, ProcessRow[] | null],
		afterMs: 0,
	};
	const state = new MachineState({
		log: (message, details) => lines.push({ message, details }),
		read: () => new Promise(resolve => setTimeout(() => resolve(fresh.answer), fresh.afterMs)),
		timeoutMs: TIMEOUT_MS,
		pids: () => pids,
		loopMaxMs: () => 40,
		own: now => ({
			at: now,
			cpuMs: computer.mainCpuMs,
			freeBytes: 20 * GB,
			totalBytes: 32 * GB,
			cpus: CPUS,
			cpuTotalMs: computer.totalMs,
			cpuBusyMs: computer.busyMs,
		}),
	});
	/** `ms` pass with the processors `busy` (a share of all of them) and main on a fifth of one. */
	const pass = async (ms: number, busy = 0.5): Promise<void> => {
		computer.totalMs += ms * CPUS;
		computer.busyMs += ms * CPUS * busy;
		computer.mainCpuMs += ms * 0.2;
		await vi.advanceTimersByTimeAsync(ms);
	};
	return { lines, pids, fresh, state, pass };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(Date.parse("2026-11-20T00:00:00.000Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("machine state around a stall", () => {
	it("writes the sample before a lost core and a fresh one after it", async () => {
		const { lines, pids, fresh, state, pass } = rig();
		state.sample(READING, listing(1), [400]);
		await pass(5_000, 0.9);
		state.sample(READING, listing(2), [400]);
		await pass(1_200, 1);
		expect(lines).toEqual([]);

		// The next core: the omps went with the lost one.
		pids.core = 350;
		fresh.afterMs = 300;
		fresh.answer = [
			{ ...READING, availableBytes: 7 * GB },
			[
				{ pid: 100, ppid: 1, bytes: 100 * MB, cpuMs: 460 },
				{ pid: 200, ppid: 100, bytes: 300 * MB, cpuMs: 2_300 },
				{ pid: 350, ppid: 200, bytes: 50 * MB, cpuMs: 30 },
				{ pid: 900, ppid: 1, bytes: 4_000 * MB, cpuMs: 30_000 },
			],
		];
		state.stalled("core-loss");

		const machine = {
			totalMB: 32_768,
			cpus: CPUS,
			mainCpuPct: 5,
			commitPct: 75,
			pressure: "normal",
			runQueue: 12,
			diskQueue: 3,
			diskBusyPct: 100,
			elMaxMs: 40,
		};
		expect(lines).toEqual([
			{
				message: "core-loss before",
				details: {
					trigger: "core-loss",
					when: "before",
					ageMs: 1_200,
					...machine,
					availMB: 8_192,
					cpuBusyPct: 90,
					appCpuPct: 21,
					hostCpuPct: 1,
					coreCpuPct: 2,
					workersCpuPct: 3,
					ompCpuPct: 10,
					ompCount: 1,
					appMB: 1_000,
					trail: "8192/-/- 8192/90/21",
				},
			},
		]);

		await pass(300, 1);
		expect(lines.slice(1)).toEqual([
			{
				message: "core-loss after",
				details: {
					trigger: "core-loss",
					when: "after",
					afterMs: 300,
					...machine,
					availMB: 7_168,
					cpuBusyPct: 100,
					appCpuPct: 6.5,
					hostCpuPct: 1,
					coreCpuPct: 0.5,
					workersCpuPct: 0,
					ompCpuPct: 0,
					ompCount: 0,
					appMB: 450,
				},
			},
		]);
	});

	it("takes a slow step for a stall only from two seconds of main's thread or of its wait on the core", async () => {
		const { lines, state, pass } = rig();
		state.sample(READING, listing(1), [400]);
		state.slowStep({ kind: "loop", name: "unknown", ms: STALL_MS - 1 });
		state.slowStep({ kind: "hub", name: "pool.call", ms: STALL_MS - 1 });
		state.slowStep({ kind: "ipc", name: "git:status", ms: 9_000 });
		state.slowStep({ kind: "stock", name: "sessions.list", ms: 9_000 });
		await pass(1_000);
		expect(lines).toEqual([]);

		state.slowStep({ kind: "loop", name: "unknown", ms: STALL_MS });
		state.slowStep({ kind: "hub", name: "pool.call", ms: 2_600 });
		await pass(1_000);
		expect(lines.map(line => line.message)).toEqual(["loop before", "hub before", "loop after", "hub after"]);
	});

	it("still says what main reads itself when the core does not answer", async () => {
		const { lines, fresh, state, pass } = rig();
		state.sample(null, null, []);
		await pass(5_000);
		state.sample(null, null, []);
		await pass(100);
		fresh.answer = [null, null];
		fresh.afterMs = TIMEOUT_MS;
		state.stalled("hub");
		await pass(TIMEOUT_MS);

		const own = { availMB: 20_480, totalMB: 32_768, cpus: CPUS, cpuBusyPct: 50, mainCpuPct: 5, elMaxMs: 40 };
		expect(lines.map(line => line.details)).toEqual([
			{ trigger: "hub", when: "before", ageMs: 100, ...own, core: "no answer", trail: "20480/-/- 20480/50/-" },
			{ trigger: "hub", when: "after", afterMs: TIMEOUT_MS, ...own, core: "no answer", timedOut: true },
		]);
	});

	it("writes one pair per kind in a minute and no more than the hour's, counting the rest", async () => {
		const { lines, state, pass } = rig();
		state.sample(READING, listing(1), [400]);
		state.stalled("loop");
		state.stalled("loop");
		state.stalled("hub");
		await pass(STATE_REPEAT_MS - 1);
		state.stalled("loop");
		// The second loop stall is counted on the next pair written, whatever its kind.
		expect(lines.map(line => [line.message, line.details.dropped])).toEqual([
			["loop before", undefined],
			["hub before", undefined],
			["loop after", undefined],
			["hub after", 1],
		]);

		await pass(1);
		state.stalled("loop");
		await pass(1);
		expect(lines.slice(4).map(line => [line.message, line.details.dropped])).toEqual([
			["loop before", undefined],
			["loop after", 1],
		]);

		// 3 pairs are written; the hour takes 17 more of these 20.
		for (let stall = 0; stall < 20; stall++) {
			await pass(STATE_REPEAT_MS);
			state.stalled("loop");
		}
		await pass(1);
		expect(lines.filter(line => line.details.when === "after")).toHaveLength(STATE_PAIRS_PER_HOUR);

		await pass(60 * 60_000);
		state.stalled("loop");
		await pass(1);
		expect(lines[lines.length - 1]?.details).toMatchObject({ when: "after", dropped: 3 });
	});

	it("keeps a minute of samples, in a line the log keeps whole", async () => {
		const { lines, state, pass } = rig();
		for (let sample = 1; sample <= STATE_SAMPLES + 3; sample++) {
			state.sample({ ...READING, availableBytes: sample * GB }, listing(sample), [400]);
			await pass(5_000);
		}
		state.stalled("loop");
		state.stalled("loop");
		await pass(STATE_REPEAT_MS);
		state.stalled("loop");
		await pass(1);

		const trail = String(lines[0]?.details.trail).split(" ");
		expect(trail).toHaveLength(STATE_SAMPLES);
		expect(trail[0]).toBe("4096/50/21");
		// `MAX_DETAIL_KEYS` of runtime-log-core.ts: a key past it is dropped from the line.
		for (const line of lines) expect(Object.keys(line.details).length).toBeLessThanOrEqual(24);
		expect(lines[lines.length - 1]?.details.dropped).toBe(1);
	});
});
