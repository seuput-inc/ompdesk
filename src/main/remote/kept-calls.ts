/**
 * The control calls a paired device's session here made while that device was away, which only the device can carry
 * out (`ompdesk_report` to its opener, `ompdesk_notify` on its screen): this computer answered the session at once and
 * keeps each call until the device, back, has taken it over (host-services.ts `#takeOver`, `#handKept`).
 *
 * One file, `<userData>/kept-host-calls.json` (mode 0o600), written before the session is told its call is kept and
 * again when the device answers one, never in a quit hook; newest `KEPT_CALLS_MAX`, none older than
 * `KEPT_CALLS_TTL_MS`. The device answers a handed-over call by its id (`kept:<omp's request id>`), the same on every
 * attempt, and its opener's bridge drops a report whose id it already holds, so a call handed over twice (its answer
 * lost with the link) still lands once.
 */
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../atomic-file";

export const KEPT_CALLS_MAX = 200;
export const KEPT_CALLS_TTL_MS = 3 * 24 * 60 * 60_000;
/** The id a kept call is handed to its device with: never one of omp's own request ids. */
export const KEPT_CALL_PREFIX = "kept:";

export interface KeptCall {
	/** The paired device the session runs for (its peer id). */
	device: string;
	/** The session's file here. */
	sessionPath: string;
	/** `KEPT_CALL_PREFIX` + the omp's request id. */
	id: string;
	toolName: string;
	arguments: Record<string, unknown>;
	at: number;
}

function parse(text: string): KeptCall[] {
	const value: unknown = JSON.parse(text);
	if (!Array.isArray(value)) return [];
	return value.filter(
		(entry): entry is KeptCall =>
			typeof entry === "object" &&
			entry !== null &&
			typeof entry.device === "string" &&
			typeof entry.sessionPath === "string" &&
			typeof entry.id === "string" &&
			typeof entry.toolName === "string" &&
			typeof entry.arguments === "object" &&
			entry.arguments !== null &&
			typeof entry.at === "number",
	);
}

export class KeptCalls {
	readonly #file: string;
	readonly #now: () => number;
	#calls: KeptCall[];
	/** Writes in the order the changes were made: a later one never lands under an earlier one. */
	#writing: Promise<void> = Promise.resolve();

	constructor(file: string, now: () => number = Date.now) {
		this.#file = file;
		this.#now = now;
		let calls: KeptCall[] = [];
		try {
			calls = parse(readFileSync(file, "utf8"));
		} catch {
			// None kept yet, or a file no build of this app wrote: nothing to hand over.
		}
		this.#calls = calls;
	}

	/** Kept once it is on disk; a failed write keeps nothing and throws, so the session hears it was not kept. */
	async keep(call: KeptCall): Promise<void> {
		this.#calls = [...this.#current().filter(held => held.id !== call.id), call].slice(-KEPT_CALLS_MAX);
		try {
			await this.#save();
		} catch (error) {
			this.#calls = this.#calls.filter(held => held.id !== call.id);
			throw error;
		}
	}

	/** What waits for `device`'s tab on `sessionPath`, oldest first. */
	for(device: string, sessionPath: string): KeptCall[] {
		return this.#current().filter(call => call.device === device && call.sessionPath === sessionPath);
	}

	/** The device took the call over. */
	settle(id: string): void {
		const left = this.#calls.filter(call => call.id !== id);
		if (left.length === this.#calls.length) return;
		this.#calls = left;
		void this.#save().catch(() => {
			// The device answers a call handed over again by the same id, and its opener keeps one copy.
		});
	}

	#current(): KeptCall[] {
		const oldest = this.#now() - KEPT_CALLS_TTL_MS;
		return this.#calls.filter(call => call.at >= oldest);
	}

	#save(): Promise<void> {
		const data = JSON.stringify(this.#current());
		const write = this.#writing.then(() => writeFileAtomic(this.#file, data, { mode: 0o600 }));
		this.#writing = write.catch(() => {});
		return write;
	}
}
