/**
 * Main's wiring of idle release (idle-release.ts): one reading every `SAMPLE_MS` (the OS's level and each session's
 * process tree, read by the core process through memory-sampler.ts), the release of a quiet tab's omp while memory is
 * short, and, as it turns short and while it stays so, the record of who uses it (memory-record.ts).
 */
import { IdleRelease, memoryShort } from "./idle-release";
import { MainRiseClock, memoryRecord, RecordClock } from "./memory-record";
import {
	hibernateConfigure,
	hibernateEvaluate,
	hibernateMark,
	type MemoryReading,
	type ProcessRow,
	readMemory,
	watchProcesses,
} from "./memory-sampler";
import type { TagOwner } from "./session-processes";

/** How often memory is read. */
export const SAMPLE_MS = 5_000;

export interface MemoryTab {
	tabId: string;
	pid?: number;
	label: string;
	/** Nothing in it is live (`idle-release.ts`): it may give its omp back while memory is short. */
	quiet?: boolean;
	sessionPath?: string;
	cwd?: string;
	visible?: boolean;
	status?: string;
	busy?: boolean;
	pendingInteraction?: boolean;
	pendingWork?: boolean;
	agentOwned?: boolean;
}

export interface MemoryWatchDeps {
	/** This computer's own tabs and the ones it runs for paired devices, with their omp's pid. */
	tabs(): MemoryTab[];
	/** Every session tag and whose it is (`SessionProcesses.owners`); absent: no record of who uses the memory. */
	owners?(): TagOwner[];
	log(message: string, details: Record<string, unknown>): void;
	/** A fixed reading for tests (`OMP_GUI_TEST_MEMORY`, a JSON file read each sample); undefined reads the OS. */
	testReading?: () => MemoryReading | null;
	sampleMs?: number;
	/** Give a quiet tab's omp back (`SidecarPool.releaseIdle`, which checks again first). */
	release?(tabId: string): void;
	/** How long a tab stays quiet before it may be released (`IDLE_RELEASE_QUIET_MS`). */
	releaseQuietMs?: number;
	/** Every sample as the core read it, null for what it did not answer, with the tabs a listing was read for and
	 * when it was asked for, the moment its processor times stand for (machine-state.ts keeps the last ones). */
	sampled?(reading: MemoryReading | null, rows: ProcessRow[] | null, tabs: readonly MemoryTab[], readAt: number): void;
}

/** Bytes as GB with one decimal, for log lines. */
function gb(bytes: number): number {
	return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/**
 * One `memory short` line (or `main memory rising`, `extra` naming the rise): what the OS reads, the largest processes
 * with their size, age and session, and what the sessions, OMPdesk itself and everything else hold. Lists are JSON
 * text, since the runtime log keeps only primitive details. Nothing is written when the processes cannot be listed.
 */
async function recordShort(
	deps: MemoryWatchDeps,
	owners: () => TagOwner[],
	reading: MemoryReading | null,
	message = "memory short",
	extra: Record<string, number> = {},
): Promise<void> {
	const record = await memoryRecord(() => ({ owners: owners(), tabs: deps.tabs() }));
	if (!record) return;
	deps.log(message, {
		level: "warn",
		...extra,
		...(reading
			? { availableGb: gb(reading.availableBytes), totalGb: gb(reading.totalBytes), pressure: reading.pressure }
			: {}),
		sessionsMb: record.sessionsMb,
		ompdeskMb: record.ompdeskMb,
		otherMb: record.otherMb,
		top: JSON.stringify(record.top),
		sessions: JSON.stringify(record.sessions),
	});
}

/** Start reading memory; while it is short a quiet tab is released and who uses it is written down. */
export function startMemoryWatch(deps: MemoryWatchDeps): void {
	let sampling = false;
	let hibernateConfigured = deps.releaseQuietMs === undefined;
	const idle = new IdleRelease(deps.releaseQuietMs);
	const clock = new RecordClock();
	const mainRise = new MainRiseClock(Date.now());
	const sample = async (): Promise<void> => {
		if (sampling) return;
		sampling = true;
		try {
			// The OS is read in a test launch too: what a stall writes down is the real computer's state.
			const readAt = Date.now();
			const [real, processes] = await Promise.all([readMemory(), watchProcesses()]);
			const reading = deps.testReading ? deps.testReading() : real;
			const owners = deps.owners;
			if (owners && reading && clock.due(Date.now(), memoryShort(reading))) await recordShort(deps, owners, reading);
			const rss = process.memoryUsage.rss();
			const rise = mainRise.due(Date.now(), rss);
			if (owners && rise !== null)
				await recordShort(deps, owners, reading, "main memory rising", {
					mainMb: Math.round(rss / 1024 ** 2),
					riseMb: Math.round(rise / 1024 ** 2),
				});
			const release = deps.release;
			const tabs = processes ? deps.tabs() : [];
			deps.sampled?.(real, processes?.rows ?? null, tabs, readAt);
			if (processes && release) {
				const nowMs = Date.now();
				let handledByCore = false;
				if (typeof hibernateEvaluate === "function") {
					if (
						!hibernateConfigured &&
						deps.releaseQuietMs !== undefined &&
						typeof hibernateConfigure === "function"
					) {
						await hibernateConfigure({ pressureQuietMs: deps.releaseQuietMs });
						hibernateConfigured = true;
					}
					const pass = await hibernateEvaluate({
						tabs,
						nowMs,
						reading,
						watchProcesses: processes,
					});
					if (pass) {
						handledByCore = true;
						for (const candidate of pass.evict) {
							deps.log("memory release", {
								tab: candidate.tabId,
								label: candidate.label,
								gb: gb(candidate.bytes),
								reason: candidate.reason,
								...(reading ? { availableGb: gb(reading.availableBytes), pressure: reading.pressure } : {}),
							});
							release(candidate.tabId);
							if (typeof hibernateMark === "function") {
								void hibernateMark({
									action: "hibernated",
									tabId: candidate.tabId,
									label: candidate.label,
									...(candidate.sessionPath ? { sessionPath: candidate.sessionPath } : {}),
									...(candidate.cwd ? { cwd: candidate.cwd } : {}),
									freedBytes: candidate.bytes,
									reason: candidate.reason,
								});
							}
						}
					}
				}
				if (!handledByCore) {
					const picked = idle.pick(nowMs, reading, tabs, processes);
					if (picked) {
						const { tab, bytes } = picked;
						deps.log("memory release", {
							tab: tab.tabId,
							label: tab.label,
							gb: gb(bytes),
							...(reading ? { availableGb: gb(reading.availableBytes), pressure: reading.pressure } : {}),
						});
						release(tab.tabId);
					}
				}
			}
		} finally {
			sampling = false;
		}
	};
	void sample();
	setInterval(() => void sample(), deps.sampleMs ?? SAMPLE_MS).unref();
}
