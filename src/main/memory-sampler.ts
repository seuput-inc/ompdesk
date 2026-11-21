/**
 * This computer's memory: the OS's own pressure level and available memory,
 * and the footprint of each session's process tree (its omp and everything it started: tsc, vitest, Playwright's
 * browsers, a cargo build).
 *
 * The reads and their rules are the core process's (`native/ompdesk/crates/core/src/memory/`): macOS one `sysctl`
 * for the kernel's pressure level, its free percentage, `hw.memsize` and the swap, and one `ps` for the processes;
 * Windows `GlobalMemoryStatusEx` with the share of RAM still available and the commit charge, its processor and disk
 * queues (PDH), and a Toolhelp32 snapshot with each process's working set and processor time. The watch also gets
 * the quiet trees' footprints from that listing. A stall's independent process read doesn't need those facts.
 */
import { readFileSync } from "node:fs";
import { core } from "./core/process";

export type MemoryPressure = "normal" | "warn" | "critical";

export interface MemoryReading {
	totalBytes: number;
	/** What the OS can hand out without paging: macOS `kern.memorystatus_level` % of RAM, Windows' available physical memory. */
	availableBytes: number;
	pressure: MemoryPressure;
	/** Windows: the memory promised to processes, and the most that can be (RAM plus page files). */
	commitBytes?: number;
	commitLimitBytes?: number;
	/** macOS: the swap in use, and its size now. */
	swapBytes?: number;
	swapTotalBytes?: number;
	/** Windows: threads ready to run with no processor free, requests waiting on the disks, and the share of time the
	 * disks were busy since the reading before. Absent while Windows has no value for one. */
	runQueue?: number;
	diskQueue?: number;
	diskBusyPct?: number;
}

export interface ProcessRow {
	pid: number;
	ppid: number;
	/** Resident bytes; on macOS the footprint (compressed and swapped pages too) of a process this user may read. */
	bytes: number;
	/** Image name (`conhost.exe`), Windows only: `ps` names none. */
	name?: string;
	/** Processor time used so far, kernel and user, in ms; absent for a process this user may not ask. */
	cpuMs?: number;
}

export interface WatchProcesses {
	rows: ProcessRow[];
	/** POSIX leaves are quiet at their own size. On Windows a leaf is busy and this list is null. */
	busyParents: number[] | null;
	/** Quiet parents only, with the bytes of every descendant including console hosts. */
	quietTrees: [pid: number, bytes: number][];
}

/** How long one reading or one process listing may take; past it the sample counts as failed (never as safe). */
export const SAMPLE_TIMEOUT_MS = 4_000;

/** The core's answer to `method`, or null when it fails or has not answered within `SAMPLE_TIMEOUT_MS`. */
async function sample<T>(method: string): Promise<T | null> {
	try {
		const answer = await core().call<T>(method, { timeoutMs: SAMPLE_TIMEOUT_MS }, { timeoutMs: SAMPLE_TIMEOUT_MS });
		return answer.result;
	} catch {
		return null;
	}
}

/** The OS's reading now; null when it cannot be read in time. */
export function readMemory(): Promise<MemoryReading | null> {
	return sample<MemoryReading | null>("memory.reading");
}

/** Every process with its parent and resident bytes; null when the listing failed or took too long. */
export function listProcesses(): Promise<ProcessRow[] | null> {
	return sample<ProcessRow[]>("memory.processes");
}

export function watchProcesses(): Promise<WatchProcesses | null> {
	return sample<WatchProcesses>("memory.watchProcesses");
}

/** Unpackaged test launches: the reading a test writes to `file` (`{"totalGb":16,"availableGb":3,"pressure":"warn"}`). */
export function testMemoryReading(file: string): MemoryReading | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const totalGb = "totalGb" in parsed ? Number(parsed.totalGb) : Number.NaN;
		const availableGb = "availableGb" in parsed ? Number(parsed.availableGb) : Number.NaN;
		const pressure = "pressure" in parsed ? parsed.pressure : "normal";
		if (!(totalGb > 0) || !(availableGb >= 0)) return null;
		return {
			totalBytes: totalGb * 1024 ** 3,
			availableBytes: availableGb * 1024 ** 3,
			pressure: pressure === "warn" || pressure === "critical" ? pressure : "normal",
		};
	} catch {
		return null;
	}
}
