import { afterEach, expect, it, vi } from "vitest";
import { type MemoryReading, readMemory, watchProcesses } from "./memory-sampler";
import { SAMPLE_MS, startMemoryWatch } from "./memory-watch";
import { listTaggedProcesses } from "./session-processes";

vi.mock("./memory-sampler", () => ({ readMemory: vi.fn(), watchProcesses: vi.fn() }));
vi.mock("./session-processes", () => ({ listTaggedProcesses: vi.fn() }));

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

it("uses the tabs after recordShort and keeps quiet time across a failed listing", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	const GiB = 1024 ** 3;
	const real: MemoryReading = { totalBytes: 16 * GiB, availableBytes: 8 * GiB, pressure: "normal" };
	const rows = [{ pid: 17, ppid: 1, bytes: 2 * GiB }];
	const snapshot = { rows, busyParents: [1], quietTrees: [] };
	vi.mocked(readMemory).mockResolvedValue(real);
	vi.mocked(watchProcesses).mockResolvedValueOnce(snapshot).mockResolvedValueOnce(null).mockResolvedValue(snapshot);
	vi.mocked(listTaggedProcesses).mockResolvedValue([]);
	const oldTab = { tabId: "old", label: "closed", pid: 16, quiet: true };
	const newTab = { tabId: "new", label: "new tab", pid: 17, quiet: true };
	let current = oldTab;
	const tabs = vi.fn(() => [current]);
	const log = vi.fn((message: string, _details: Record<string, unknown>) => {
		if (message === "memory short") current = newTab;
	});
	const sampled = vi.fn();
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
	await vi.advanceTimersByTimeAsync(0);
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
