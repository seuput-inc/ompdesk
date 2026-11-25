/**
 * While this computer is short of memory, a session nobody uses gives its omp back (the owner's goal of 6 Nov 2026,
 * "dozens of sessions without weight", under the condition "no slower and nothing lost"). Electron-free: the memory
 * watch (`memory-watch.ts`) feeds it each sample, and the pool (`SidecarPool.releaseIdle`) re-checks and does it.
 *
 * Nothing changes while memory is fine: no tab is released then, so no session ever waits for its omp to start again.
 * Short means what the OS says now: pressure warn or critical, or less than `RESERVE_FRACTION` of RAM available.
 *
 * Only a quiet tab goes: the pool says nothing in it is live (hidden in every window and device, idle, no ask, plan,
 * draft, retry or continuation, not opened by an agent), and its omp has started no process. A child process is live
 * state a restart would lose: the eval worker holds the session's eval state, a background job or a daemon runs, an
 * MCP server is connected. A console host (conhost.exe, which Windows starts beside a console program) is not work.
 * On Windows the tab's pid is a launcher, bun's `omp.exe` shim or cmd.exe for an `omp.cmd` (spawn.ts), whose one
 * other child is the omp itself; the omp's own children are the work. It has been quiet for `IDLE_RELEASE_QUIET_MS`,
 * and the largest such tree goes first, one per sample, so a short spell frees what it needs and no more. A released
 * tab reads asleep and starts again on its session file the way a restored tab does: when it is shown or messaged.
 */
import type { MemoryReading, WatchProcesses } from "./memory-sampler";

/** Headroom below which memory reads as short: 15 % of RAM (2.4 GB on 16 GB), before the kernel's warn level. */
const RESERVE_FRACTION = 0.15;

/** How long a tab stays quiet before it may be released. */
export const IDLE_RELEASE_QUIET_MS = 5 * 60_000;

export interface ReleaseTab {
	tabId: string;
	/** Its omp's pid; none while no omp runs. */
	pid?: number;
	/** The pool's word that nothing in it is live (`SidecarPool.memoryTabs`). */
	quiet?: boolean;
}

/** Memory is short now: the OS's pressure, or less than the reserve available. Unknown is not short. */
export function memoryShort(reading: MemoryReading | null): boolean {
	if (!reading) return false;
	return reading.pressure !== "normal" || reading.availableBytes < reading.totalBytes * RESERVE_FRACTION;
}

/** Look up the native facts for the tabs the pool knows now, not the ones it knew before the OS read. */
export function idleFootprints(sample: WatchProcesses, tabs: readonly ReleaseTab[]): Map<number, number> {
	const bytes = new Map<number, number>();
	if (sample.busyParents !== null) {
		for (const tab of tabs) if (tab.quiet === true && tab.pid !== undefined) bytes.set(tab.pid, 0);
		for (const pid of sample.busyParents) bytes.delete(pid);
		if (bytes.size) {
			for (const row of sample.rows) if (bytes.has(row.pid)) bytes.set(row.pid, row.bytes);
		}
	}
	for (const [pid, size] of sample.quietTrees) bytes.set(pid, size);
	return bytes;
}

export class IdleRelease {
	readonly #quietMs: number;
	/** Since when each quiet tab has been quiet with no child process. */
	readonly #quietSince = new Map<string, number>();

	constructor(quietMs = IDLE_RELEASE_QUIET_MS) {
		this.#quietMs = quietMs;
	}

	/** One sample: the tab to release now, or null. A tab picked starts its quiet time again. */
	pick<T extends ReleaseTab>(
		now: number,
		reading: MemoryReading | null,
		tabs: readonly T[],
		sample: WatchProcesses,
	): { tab: T; bytes: number } | null {
		const footprints = idleFootprints(sample, tabs);
		const seen = new Set<string>();
		for (const tab of tabs) {
			seen.add(tab.tabId);
			if (tab.quiet === true && tab.pid !== undefined && footprints.has(tab.pid)) {
				if (!this.#quietSince.has(tab.tabId)) this.#quietSince.set(tab.tabId, now);
			} else this.#quietSince.delete(tab.tabId);
		}
		for (const tabId of this.#quietSince.keys()) if (!seen.has(tabId)) this.#quietSince.delete(tabId);
		if (!memoryShort(reading)) return null;
		let best: { tab: T; bytes: number } | null = null;
		for (const tab of tabs) {
			const since = this.#quietSince.get(tab.tabId);
			if (since === undefined || now - since < this.#quietMs || tab.pid === undefined) continue;
			const bytes = footprints.get(tab.pid);
			if (bytes === undefined) continue;
			if (!best || bytes > best.bytes) best = { tab, bytes };
		}
		if (best) this.#quietSince.delete(best.tab.tabId);
		return best;
	}
}
