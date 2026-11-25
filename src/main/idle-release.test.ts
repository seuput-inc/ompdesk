import { describe, expect, it } from "vitest";
import { IdleRelease, memoryShort } from "./idle-release";
import type { MemoryReading, WatchProcesses } from "./memory-sampler";

const GiB = 1024 ** 3;
const reading = (availableGb: number, pressure: MemoryReading["pressure"] = "normal"): MemoryReading => ({
	totalBytes: 16 * GiB,
	availableBytes: availableGb * GiB,
	pressure,
});
const QUIET = 60_000;
/** Three omps (pids 10, 20, 30) of 0.3, 0.8 and 0.5 GB under the app (pid 1). */
const sample: WatchProcesses = {
	rows: [
		{ pid: 10, ppid: 1, bytes: 0.3 * GiB },
		{ pid: 20, ppid: 1, bytes: 0.8 * GiB },
		{ pid: 30, ppid: 1, bytes: 0.5 * GiB },
	],
	busyParents: [1],
	quietTrees: [],
};
const tabs = [
	{ tabId: "a", pid: 10, quiet: true },
	{ tabId: "b", pid: 20, quiet: true },
	{ tabId: "c", pid: 30, quiet: true },
];

describe("memoryShort", () => {
	it("reads the OS now: pressure, or less than 15 % of RAM available; unknown is not short", () => {
		expect(memoryShort(reading(8))).toBe(false);
		expect(memoryShort(reading(2.5))).toBe(false);
		expect(memoryShort(reading(2.3))).toBe(true);
		expect(memoryShort(reading(8, "warn"))).toBe(true);
		expect(memoryShort(reading(8, "critical"))).toBe(true);
		expect(memoryShort(null)).toBe(false);
	});
});

describe("IdleRelease", () => {
	it("releases nothing while memory is fine, however long a tab has been quiet", () => {
		const idle = new IdleRelease(QUIET);
		expect(idle.pick(0, reading(8), tabs, sample)).toBeNull();
		expect(idle.pick(10 * QUIET, reading(8), tabs, sample)).toBeNull();
		expect(idle.pick(10 * QUIET, null, tabs, sample)).toBeNull();
	});

	it("while memory is short, releases the largest tab quiet for the whole quiet time, one per sample", () => {
		const idle = new IdleRelease(QUIET);
		idle.pick(0, reading(8), tabs, sample);
		expect(idle.pick(QUIET - 1, reading(1), tabs, sample)).toBeNull();
		expect(idle.pick(QUIET, reading(1), tabs, sample)).toEqual({ tab: tabs[1], bytes: 0.8 * GiB });
		expect(idle.pick(QUIET + 5_000, reading(1), tabs, sample)?.tab.tabId).toBe("c");
		expect(idle.pick(QUIET + 10_000, reading(1), tabs, sample)?.tab.tabId).toBe("a");
		// A tab picked starts its quiet time again: one the pool kept is not asked about every sample.
		expect(idle.pick(QUIET + 15_000, reading(1), tabs, sample)).toBeNull();
	});

	it("never releases a tab whose omp started a process: eval state, a job, a daemon or an MCP server lives there", () => {
		const idle = new IdleRelease(QUIET);
		const withEval = { ...sample, busyParents: [1, 20] };
		idle.pick(0, reading(1), tabs, withEval);
		expect(idle.pick(QUIET, reading(1), tabs, withEval)?.tab.tabId).toBe("c");
		// The worker ended: the quiet time starts then, not before.
		expect(idle.pick(QUIET + 1, reading(1), tabs, sample)?.tab.tabId).toBe("a");
		expect(idle.pick(QUIET + 2, reading(1), tabs, sample)).toBeNull();
		expect(idle.pick(2 * QUIET + 1, reading(1), tabs, sample)?.tab.tabId).toBe("b");
	});

	it("a tab that stops being quiet (shown, a turn, a draft) starts its quiet time again", () => {
		const idle = new IdleRelease(QUIET);
		const only = [{ tabId: "a", pid: 10, quiet: true }];
		idle.pick(0, reading(1), only, sample);
		idle.pick(QUIET / 2, reading(1), [{ tabId: "a", pid: 10, quiet: false }], sample);
		// Quiet again from this sample on.
		expect(idle.pick(QUIET, reading(1), only, sample)).toBeNull();
		expect(idle.pick(2 * QUIET - 1, reading(1), only, sample)).toBeNull();
		expect(idle.pick(2 * QUIET, reading(1), only, sample)?.tab.tabId).toBe("a");
	});

	it("forgets a tab that is gone and never picks one without an omp", () => {
		const idle = new IdleRelease(QUIET);
		idle.pick(0, reading(1), [{ tabId: "a", pid: 10, quiet: true }], sample);
		idle.pick(1, reading(1), [], sample);
		expect(idle.pick(QUIET, reading(1), [{ tabId: "a", pid: 10, quiet: true }], sample)).toBeNull();
		expect(idle.pick(10 * QUIET, reading(1), [{ tabId: "x", quiet: true }], sample)).toBeNull();
	});

	it("on Windows only considers quiet launchers and ranks them by the whole tree, not the launcher's own size", () => {
		const windows: WatchProcesses = {
			...sample,
			busyParents: null,
			quietTrees: [
				[10, GiB],
				[20, GiB],
			],
		};
		const idle = new IdleRelease(0);
		expect(idle.pick(0, reading(1), tabs, windows)).toEqual({ tab: tabs[0], bytes: GiB });
		expect(idle.pick(0, reading(1), tabs.slice(2), windows)).toBeNull();
	});

	it("distinguishes an unlisted PID from an unlisted parent with a live child", () => {
		const gone = [{ tabId: "gone", pid: 42, quiet: true }];
		const idle = new IdleRelease(0);
		expect(idle.pick(0, reading(1), gone, sample)).toEqual({ tab: gone[0], bytes: 0 });
		expect(idle.pick(0, reading(1), gone, { ...sample, busyParents: [42] })).toBeNull();
		expect(idle.pick(0, reading(1), gone, { ...sample, busyParents: null })).toBeNull();
	});
});
