import { afterEach, expect, it, vi } from "vitest";
import {
	hibernateConfigure,
	hibernateEvaluate,
	hibernateMark,
	type MemoryReading,
	readMemory,
	watchProcesses,
} from "./memory-sampler";
import { SAMPLE_MS, startMemoryWatch } from "./memory-watch";

vi.mock("./memory-sampler", () => ({
	readMemory: vi.fn(),
	watchProcesses: vi.fn(),
	hibernateConfigure: vi.fn(),
	hibernateEvaluate: vi.fn(),
	hibernateMark: vi.fn(),
}));

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.resetAllMocks();
});

it("uses the tabs after recordShort and keeps quiet time across a failed listing", async () => {
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(0);
	const GiB = 1024 ** 3;
	const real: MemoryReading = { totalBytes: 16 * GiB, availableBytes: 8 * GiB, pressure: "normal" };
	const rows = [{ pid: 17, ppid: 1, bytes: 2 * GiB }];
	const snapshot = { rows, busyParents: [1], quietTrees: [] };
	vi.mocked(readMemory).mockResolvedValue(real);
	vi.mocked(watchProcesses).mockResolvedValueOnce(snapshot).mockResolvedValueOnce(null).mockResolvedValue(snapshot);
	const oldTab = { tabId: "old", label: "closed", pid: 16, quiet: true };
	const newTab = { tabId: "new", label: "new tab", pid: 17, quiet: true };
	let current = oldTab;
	const tabs = vi.fn(() => [current]);
	const log = vi.fn((message: string, _details: Record<string, unknown>) => {
		if (message === "memory short") current = newTab;
	});
	const firstSample = Promise.withResolvers<void>();
	const sampled = vi.fn(() => firstSample.resolve());
	const release = vi.fn();
	startMemoryWatch({
		tabs,
		log,
		sampled,
		release,
		owners: () => [],
		testReading: () => ({ ...real, availableBytes: GiB }),
		releaseQuietMs: 2 * SAMPLE_MS,
	});
	await firstSample.promise;
	expect(sampled).toHaveBeenLastCalledWith(real, rows, [newTab], 0);
	expect(release).not.toHaveBeenCalled();
	const reads = tabs.mock.calls.length;
	await vi.advanceTimersByTimeAsync(SAMPLE_MS);
	expect(tabs).toHaveBeenCalledTimes(reads);
	expect(sampled).toHaveBeenLastCalledWith(real, null, [], SAMPLE_MS);
	expect(release).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(SAMPLE_MS);
	expect(release.mock.calls).toEqual([["new"]]);
	expect(log).toHaveBeenCalledWith("memory release", {
		tab: "new",
		label: "new tab",
		gb: 2,
		availableGb: 1,
		pressure: "normal",
	});
});

it("delegates hibernation policy to Rust hibernateEvaluate and marks each evicted tab", async () => {
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(10_000);
	const GiB = 1024 ** 3;
	const reading: MemoryReading = { totalBytes: 16 * GiB, availableBytes: GiB, pressure: "critical" };
	const rows = [
		{ pid: 101, ppid: 1, bytes: 3 * GiB },
		{ pid: 102, ppid: 1, bytes: 2 * GiB },
	];
	const snapshot = { rows, busyParents: [1], quietTrees: [] };
	vi.mocked(readMemory).mockResolvedValue(reading);
	vi.mocked(watchProcesses).mockResolvedValue(snapshot);
	vi.mocked(hibernateConfigure).mockResolvedValue(null);
	vi.mocked(hibernateEvaluate).mockResolvedValue({
		memoryShort: true,
		pressure: "critical",
		residentCount: 2,
		evict: [
			{
				tabId: "tab-a",
				pid: 101,
				label: "heavy tab",
				sessionPath: "/sessions/a.jsonl",
				cwd: "/work/a",
				bytes: 3 * GiB,
				quietMs: 90_000,
				reason: "criticalPressure",
			},
			{
				tabId: "tab-b",
				pid: 102,
				label: "idle tab",
				bytes: 2 * GiB,
				quietMs: 120_000,
				reason: "proactiveIdle",
			},
		],
		evaluations: [],
	});
	vi.mocked(hibernateMark).mockResolvedValue({});

	const log = vi.fn();
	const release = vi.fn();
	const done = Promise.withResolvers<void>();
	const wrappedRelease = (tabId: string) => {
		release(tabId);
		if (release.mock.calls.length === 2) done.resolve();
	};
	startMemoryWatch({
		tabs: () => [
			{
				tabId: "tab-a",
				pid: 101,
				label: "heavy tab",
				quiet: true,
				sessionPath: "/sessions/a.jsonl",
				cwd: "/work/a",
			},
			{ tabId: "tab-b", pid: 102, label: "idle tab", quiet: true },
		],
		log,
		release: wrappedRelease,
		releaseQuietMs: 30_000,
	});
	await done.promise;

	expect(hibernateConfigure).toHaveBeenCalledWith({ pressureQuietMs: 30_000 });
	expect(hibernateEvaluate).toHaveBeenCalledWith({
		tabs: [
			{
				tabId: "tab-a",
				pid: 101,
				label: "heavy tab",
				quiet: true,
				sessionPath: "/sessions/a.jsonl",
				cwd: "/work/a",
			},
			{ tabId: "tab-b", pid: 102, label: "idle tab", quiet: true },
		],
		nowMs: 10_000,
		reading,
		watchProcesses: snapshot,
	});
	expect(release.mock.calls).toEqual([["tab-a"], ["tab-b"]]);
	expect(log).toHaveBeenCalledWith("memory release", {
		tab: "tab-a",
		label: "heavy tab",
		gb: 3,
		reason: "criticalPressure",
		availableGb: 1,
		pressure: "critical",
	});
	expect(hibernateMark).toHaveBeenCalledWith({
		action: "hibernated",
		tabId: "tab-a",
		label: "heavy tab",
		sessionPath: "/sessions/a.jsonl",
		cwd: "/work/a",
		freedBytes: 3 * GiB,
		reason: "criticalPressure",
	});
	expect(hibernateMark).toHaveBeenCalledWith({
		action: "hibernated",
		tabId: "tab-b",
		label: "idle tab",
		freedBytes: 2 * GiB,
		reason: "proactiveIdle",
	});
});
