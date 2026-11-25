import { spawn } from "node:child_process";
import { once } from "node:events";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { idleFootprints } from "./idle-release";
import { listProcesses, type ProcessRow, readMemory, watchProcesses } from "./memory-sampler";
import { DIES_WITH_TEST } from "./test-fake-omp";

// parseMacSysctl, windowsReading and parsePs moved to the core process with their cases
// (native/ompdesk/crates/core/src/memory/mod.rs); the cases below read this computer through it.

describe("the core's reading of this computer", () => {
	it("reports the RAM the OS reports, and no more available than there is", async () => {
		const reading = await readMemory();
		// Windows and Linux count whole KB; macOS' hw.memsize is a multiple of one.
		expect(reading?.totalBytes).toBe(Math.floor(os.totalmem() / 1024) * 1024);
		expect(reading?.availableBytes).toBeGreaterThanOrEqual(0);
		expect(["normal", "warn", "critical"]).toContain(reading?.pressure);
		// Windows: the available physical memory node reads too, a moment apart.
		if (process.platform === "win32")
			expect(Math.abs((reading?.availableBytes ?? 0) - os.freemem())).toBeLessThan(os.totalmem() / 4);
		// What a stall's record reads beside it (machine-state.ts): Windows' commit charge and run queue, macOS' swap.
		if (process.platform === "win32") {
			expect(reading?.commitLimitBytes).toBeGreaterThan(0);
			expect(reading?.commitBytes).toBeLessThanOrEqual(reading?.commitLimitBytes ?? 0);
			expect(reading?.runQueue).toBeGreaterThanOrEqual(0);
		}
		if (process.platform === "darwin") expect(reading?.swapBytes).toBeLessThanOrEqual(reading?.swapTotalBytes ?? -1);
	});

	it("lists this process under its parent, and a child it starts under it", async () => {
		// The child says when node is up in it: a process a moment old holds almost no memory yet.
		const child = spawn(
			process.execPath,
			["-e", `${DIES_WITH_TEST} process.stdout.write("up"); setInterval(() => {}, 1e9)`],
			{ stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
		);
		try {
			await once(child.stdout, "data");
			const rows = (await listProcesses()) ?? [];
			const own = rows.find(row => row.pid === process.pid);
			const started = rows.find(row => row.pid === child.pid);
			expect(own?.ppid).toBe(process.ppid);
			expect(started?.ppid).toBe(process.pid);
			// Resident bytes of a process that holds vitest: tens of MB, within a factor of what node reports for itself.
			const rss = process.memoryUsage().rss;
			expect(own?.bytes).toBeGreaterThan(rss / 4);
			expect(own?.bytes).toBeLessThan(rss * 4);
			expect(started?.bytes).toBeGreaterThan(1024 ** 2);
			// Processor time so far: more for the process that runs vitest than for a child a moment old.
			expect(own?.cpuMs).toBeGreaterThanOrEqual(started?.cpuMs ?? Number.NaN);
			// Windows names each image (idle release tells conhost.exe from work by it); ps names none.
			expect(own?.name?.toLowerCase()).toBe(
				process.platform === "win32" ? path.basename(process.execPath).toLowerCase() : undefined,
			);
		} finally {
			child.kill();
		}
	});
});

/** The former idle-release rules, run against the exact same live OS snapshot as the core. */
function referenceBytes(rows: readonly ProcessRow[], pid: number): number | undefined {
	const work = (parent: number) =>
		rows.filter(row => row.ppid === parent && row.name?.toLowerCase() !== "conhost.exe");
	const children = work(pid);
	if (process.platform === "win32") {
		const [omp] = children;
		if (!omp || children.length !== 1 || work(omp.pid).length) return undefined;
	} else if (children.length) return undefined;
	const seen = new Set<number>();
	const root = rows.find(row => row.pid === pid);
	const stack = root ? [root] : [];
	let bytes = 0;
	for (let row = stack.pop(); row; row = stack.pop()) {
		if (seen.has(row.pid)) continue;
		seen.add(row.pid);
		bytes += row.bytes;
		stack.push(...rows.filter(child => child.ppid === row.pid));
	}
	return bytes;
}

it("matches the old release rules for this computer's live trees and absent parents", async () => {
	const sample = await watchProcesses();
	if (!sample) throw new Error("the OS process listing failed");
	expect(sample.rows.some(row => row.pid === process.pid)).toBe(true);
	const pids = new Set([process.pid, process.ppid, 0xffff_ffff]);
	for (const row of sample.rows.slice(0, 64)) {
		pids.add(row.pid);
		pids.add(row.ppid);
	}
	const tabs = Array.from(pids, pid => ({ tabId: String(pid), pid, quiet: true }));
	const bytes = idleFootprints(sample, tabs);
	for (const pid of pids) expect(bytes.get(pid), `pid ${pid}`).toBe(referenceBytes(sample.rows, pid));
});
