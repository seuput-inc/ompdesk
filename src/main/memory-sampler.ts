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

export type HibernateBlockReason =
	| "noProcess"
	| "visible"
	| "notReady"
	| "noSessionFile"
	| "busy"
	| "pendingInteraction"
	| "pendingWork"
	| "agentOwned"
	| "notQuiet"
	| "hasChildProcesses"
	| "cooldown";

export type HibernateEvictReason = "proactiveIdle" | "residentCap" | "memoryPressure" | "criticalPressure";

export interface HibernatePolicy {
	proactiveQuietMs?: number | null;
	pressureQuietMs: number;
	criticalQuietMs: number;
	reserveFraction: number;
	maxResidentTabs?: number | null;
	capQuietMs: number;
	maxEvictionsNormal: number;
	maxEvictionsCritical: number;
	cooldownMs: number;
}

export interface HibernateTabInput {
	tabId: string;
	pid?: number;
	label: string;
	sessionPath?: string;
	cwd?: string;
	quiet?: boolean;
	visible?: boolean;
	status?: string;
	busy?: boolean;
	pendingInteraction?: boolean;
	pendingWork?: boolean;
	agentOwned?: boolean;
}

export type HibernateTabEligibility =
	| { state: "blocked"; reason: HibernateBlockReason }
	| { state: "warmingQuiet"; quietMs: number; bytes: number }
	| { state: "eligible"; quietMs: number; bytes: number; reason: HibernateEvictReason };

export interface HibernateEvictCandidate {
	tabId: string;
	pid: number;
	label: string;
	sessionPath?: string;
	cwd?: string;
	bytes: number;
	quietMs: number;
	reason: HibernateEvictReason;
}

export interface HibernateTabEvaluation {
	tabId: string;
	pid?: number;
	eligibility: HibernateTabEligibility;
}

export interface HibernatePass {
	memoryShort: boolean;
	pressure?: MemoryPressure | null;
	residentCount: number;
	evict: HibernateEvictCandidate[];
	evaluations: HibernateTabEvaluation[];
}

export interface HibernatedTab {
	tabId: string;
	sessionPath?: string;
	cwd?: string;
	label: string;
	hibernatedAtMs: number;
	freedBytes: number;
	reason: HibernateEvictReason;
}

export interface HibernateStats {
	hibernationsTotal: number;
	wakesTotal: number;
	estimatedBytesFreed: number;
}

export interface HibernateStatus {
	policy: HibernatePolicy;
	quietTracked: number;
	cooldownTracked: number;
	hibernated: HibernatedTab[];
	stats: HibernateStats;
}

export type HibernateMarkParams =
	| {
			action: "hibernated";
			tabId: string;
			sessionPath?: string;
			cwd?: string;
			label: string;
			hibernatedAtMs?: number;
			freedBytes: number;
			reason: HibernateEvictReason;
	  }
	| { action: "woken"; tabId: string; nowMs?: number }
	| { action: "forget"; tabId: string }
	| { action: "reset" };

/** How long one reading or one process listing may take; past it the sample counts as failed (never as safe). */
export const SAMPLE_TIMEOUT_MS = 4_000;

/** The core's answer to `method`, or null when it fails or has not answered within `SAMPLE_TIMEOUT_MS`. */
async function sample<T>(
	method: string,
	params: Record<string, unknown> = {},
	timeoutMs = SAMPLE_TIMEOUT_MS,
): Promise<T | null> {
	try {
		const answer = await core().call<T>(method, { timeoutMs, ...params }, { timeoutMs });
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

/** Update the Rust hibernation engine's policy; returns the sanitized policy or null if the core is unavailable. */
export function hibernateConfigure(policy: Partial<HibernatePolicy>): Promise<HibernatePolicy | null> {
	return sample<HibernatePolicy>("memory.hibernateConfigure", policy);
}

/** Run one Rust hibernation evaluation pass over `tabs`, reusing a pre-sampled reading/process snapshot when given. */
export function hibernateEvaluate(params: {
	tabs: readonly HibernateTabInput[];
	nowMs?: number;
	reading?: MemoryReading | null;
	watchProcesses?: WatchProcesses | null;
	timeoutMs?: number;
}): Promise<HibernatePass | null> {
	const timeoutMs = params.timeoutMs ?? SAMPLE_TIMEOUT_MS;
	return sample<HibernatePass>(
		"memory.hibernateEvaluate",
		{
			tabs: params.tabs,
			...(params.nowMs !== undefined ? { nowMs: params.nowMs } : {}),
			...(params.reading != null ? { reading: params.reading } : {}),
			...(params.watchProcesses != null ? { watchProcesses: params.watchProcesses } : {}),
		},
		timeoutMs,
	);
}

/** Read the Rust hibernation engine's current policy, tracked counts, hibernated tabs, and cumulative stats. */
export function hibernateStatus(): Promise<HibernateStatus | null> {
	return sample<HibernateStatus>("memory.hibernateStatus");
}

/** Record a tab hibernation lifecycle transition (`hibernated`, `woken`, `forget`, or `reset`) in the Rust engine. */
export function hibernateMark(params: HibernateMarkParams): Promise<unknown> {
	return sample<unknown>("memory.hibernateMark", params);
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
