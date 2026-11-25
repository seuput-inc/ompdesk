/** The bounded record the core returns after listing this computer's processes. */
import { CorePort } from "./core/ports";
import { core } from "./core/process";
import { LIST_TIMEOUT_MS, type TagOwner } from "./session-processes";

/** A tab whose omp runs on this computer. */
export interface RecordTab {
	pid?: number;
	/** Its title (a hosted tab's names its device). */
	label: string;
}

export interface RecordProcess {
	name: string;
	pid: number;
	mb: number;
	/** Minutes since it started; absent when the OS did not say. */
	ageMin?: number;
	owner: "session" | "closed session" | "OMPdesk" | "not OMPdesk's";
	session?: string;
	folder?: string;
	device?: string;
}

export interface RecordSession {
	session: string;
	folder?: string;
	device?: string;
	mb: number;
	processes: number;
}

export interface MemoryRecord {
	/** The largest processes, largest first. */
	top: RecordProcess[];
	/** The sessions that hold the most, largest first. */
	sessions: RecordSession[];
	/** Everything sessions hold, what OMPdesk itself holds, and the rest, in MB. */
	sessionsMb: number;
	ompdeskMb: number;
	otherMb: number;
}

const LOCALE = new Intl.Collator().resolvedOptions().locale;

/** Read main's owners and tabs together after the OS scan, not when it starts. */
export async function memoryRecord(
	snapshot: () => { owners: readonly TagOwner[]; tabs: readonly RecordTab[] },
): Promise<MemoryRecord | null> {
	const port = new CorePort({
		snapshot: () => {
			const { owners, tabs } = snapshot();
			return {
				owners: owners.map(({ tag, cwd, pid, device }) => ({ tag, cwd, pid, device })),
				tabs: tabs.map(({ pid, label }) => ({ pid, label })),
				mainPid: process.pid,
				now: Date.now(),
				locale: LOCALE,
			};
		},
	});
	try {
		const answer = await core().call<MemoryRecord>(
			"procs.pressureRecord",
			{ port: port.id, timeoutMs: LIST_TIMEOUT_MS },
			{ timeoutMs: LIST_TIMEOUT_MS },
		);
		return answer.result;
	} catch {
		return null;
	} finally {
		port.close();
	}
}

/** How often the record is written while memory stays short. */
export const RECORD_EVERY_MS = 5 * 60_000;

/** When the record is due: as memory turns short, then every `RECORD_EVERY_MS` while it stays short. */
export class RecordClock {
	#last: number | null = null;

	/** One sample: whether to write the record now. */
	due(now: number, short: boolean): boolean {
		if (!short) {
			this.#last = null;
			return false;
		}
		if (this.#last !== null && now - this.#last < RECORD_EVERY_MS) return false;
		this.#last = now;
		return true;
	}
}

/** A rise of main's own memory that is worth a record (a leak or a runaway in main, whatever the OS has left). */
export const MAIN_RISE_BYTES = 300 * 1024 ** 2;
export const MAIN_RISE_WINDOW_MS = 2 * 60_000;
/** Main grows while it starts (windows, tabs, caches): nothing before this is a rise. */
export const MAIN_RISE_AFTER_MS = 5 * 60_000;
export const MAIN_RISE_EVERY_MS = 60 * 60_000;

/** Main's resident size over the last `MAIN_RISE_WINDOW_MS`: due when it grew `MAIN_RISE_BYTES`, at most hourly. */
export class MainRiseClock {
	readonly #startedAt: number;
	#seen: { at: number; bytes: number }[] = [];
	#last: number | null = null;

	constructor(startedAt: number) {
		this.#startedAt = startedAt;
	}

	/** One sample; the rise in bytes when the record is due, else null. */
	due(now: number, bytes: number): number | null {
		this.#seen = this.#seen.filter(seen => now - seen.at <= MAIN_RISE_WINDOW_MS);
		this.#seen.push({ at: now, bytes });
		if (now - this.#startedAt < MAIN_RISE_AFTER_MS) return null;
		if (this.#last !== null && now - this.#last < MAIN_RISE_EVERY_MS) return null;
		const rise = bytes - Math.min(...this.#seen.map(seen => seen.bytes));
		if (rise < MAIN_RISE_BYTES) return null;
		this.#last = now;
		return rise;
	}
}
