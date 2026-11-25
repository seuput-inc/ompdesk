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
