const HOUR_MS = 60 * 60_000;

/** How many lines an hour a probe may write to `gui-runtime.jsonl`, so no symptom fills the log. */
export class LineBudget {
	readonly #perHour: number;
	#hourAt = 0;
	#lines = 0;
	#dropped = 0;

	constructor(perHour: number) {
		this.#perHour = perHour;
	}

	/** For a line to write: how many were left out since the last one written. Null: this one is left out too. */
	take(now: number): number | null {
		if (now - this.#hourAt >= HOUR_MS) {
			this.#hourAt = now;
			this.#lines = 0;
		}
		if (this.#lines >= this.#perHour) {
			this.#dropped++;
			return null;
		}
		this.#lines++;
		const dropped = this.#dropped;
		this.#dropped = 0;
		return dropped;
	}
}
