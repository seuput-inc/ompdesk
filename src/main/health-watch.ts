/**
 * Two readings of main's health that act before something breaks, each a `gui-runtime.jsonl` line:
 * - the event loop's delay: once a minute, a line when its 99th percentile passed `LOOP_DELAY_LOG_MS` (the hang
 *   watchdog sees only stalls over 5 s; this catches the seconds-long jank below that), paused while the computer
 *   sleeps so a suspend never reads as a stall;
 * - the free space of the volume holding the app's data: read 2 minutes after launch and every 6 hours; under
 *   `LOW_DISK_BYTES` the person gets one OS notice, at most once a day, before writes start failing (the disk-full
 *   notice of `disk-full.ts` is for writes that already failed and is never held back by this one).
 */
import { statfs } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";

export const LOOP_DELAY_LOG_MS = 250;
export const LOW_DISK_BYTES = 10 * 1024 ** 3;
export const LOW_DISK_NOTICE_EVERY_MS = 24 * 60 * 60_000;
const DISK_FIRST_MS = 2 * 60_000;
const DISK_EVERY_MS = 6 * 60 * 60_000;

export interface PowerEvents {
	on(event: "suspend" | "resume", listener: () => void): unknown;
}

/** One line a minute while main's event loop lags; nothing while it keeps up. */
export function startEventLoopWatch(power: PowerEvents, log: (details: Record<string, number>) => void): void {
	const histogram = monitorEventLoopDelay({ resolution: 20 });
	histogram.enable();
	power.on("suspend", () => histogram.disable());
	power.on("resume", () => {
		histogram.reset();
		histogram.enable();
	});
	setInterval(() => {
		const p99 = histogram.percentile(99) / 1e6;
		if (histogram.count > 0 && p99 > LOOP_DELAY_LOG_MS)
			log({
				p99Ms: Math.round(p99),
				maxMs: Math.round(histogram.max / 1e6),
				meanMs: Math.round(histogram.mean / 1e6),
			});
		histogram.reset();
	}, 60_000).unref();
}

export interface LowDiskDeps {
	/** The folder whose volume is read (userData). */
	path: string;
	/** Free bytes for this user on that volume; the default asks the OS. */
	freeBytes?: (path: string) => Promise<number>;
	/** When the last notice was shown (ms), kept across launches. */
	lastNoticeAt(): number | undefined;
	setLastNoticeAt(at: number): void;
	notify(freeBytes: number): void;
	now?: () => number;
}

const osFreeBytes = async (path: string): Promise<number> => {
	const stats = await statfs(path);
	return stats.bavail * stats.bsize;
};

/** Reads once now; returns whether a notice was shown. */
export async function checkLowDisk(deps: LowDiskDeps): Promise<boolean> {
	const free = await (deps.freeBytes ?? osFreeBytes)(deps.path).catch(() => null);
	if (free === null || free >= LOW_DISK_BYTES) return false;
	const now = (deps.now ?? Date.now)();
	const last = deps.lastNoticeAt();
	if (last !== undefined && now - last < LOW_DISK_NOTICE_EVERY_MS) return false;
	deps.setLastNoticeAt(now);
	deps.notify(free);
	return true;
}

export function startLowDiskWatch(deps: LowDiskDeps): void {
	setTimeout(() => {
		void checkLowDisk(deps);
		setInterval(() => void checkLowDisk(deps), DISK_EVERY_MS).unref();
	}, DISK_FIRST_MS).unref();
}
