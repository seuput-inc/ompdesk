/**
 * The free space of the volume holding the app's data, read 2 minutes after launch and every 6 hours: under
 * `LOW_DISK_BYTES` the person gets one OS notice, at most once a day, before writes start failing (Orca D136, U176).
 * The disk-full notice of `disk-full.ts` is for writes that already failed and is never held back by this one.
 * Main's event-loop lag is `slow-steps.ts`' `loop` line, not this file's.
 */
import { statfs } from "node:fs/promises";

export const LOW_DISK_BYTES = 10 * 1024 ** 3;
export const LOW_DISK_NOTICE_EVERY_MS = 24 * 60 * 60_000;
const DISK_FIRST_MS = 2 * 60_000;
const DISK_EVERY_MS = 6 * 60 * 60_000;

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
