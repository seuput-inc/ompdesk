import { core } from "../core/process";
import { stockHelperHost } from "../stock-helper";
import type { AiMemoryServer } from "./client";

// A rebuild may have many pages. Each server and tokenizer request has its own timeout.
const REFRESH_TIMEOUT_MS = 2 ** 31 - 1;

export class RecallTermsIndex {
	readonly #server: () => AiMemoryServer;
	readonly #file: string;
	readonly #log: ((message: string, details?: object) => void) | undefined;
	#running: Promise<void> | undefined;

	constructor(deps: {
		server: () => AiMemoryServer;
		file: string;
		log?: (message: string, details?: object) => void;
	}) {
		this.#server = deps.server;
		this.#file = deps.file;
		this.#log = deps.log;
	}

	/** Reads the rows after the saved cursors and writes the file when something changed. One at a time; never throws. */
	refresh(): Promise<void> {
		this.#running ??= this.#run().finally(() => {
			this.#running = undefined;
		});
		return this.#running;
	}

	async #run(): Promise<void> {
		try {
			await core().call(
				"memsync.refreshRecallTerms",
				{ file: this.#file, server: this.#server(), stockHost: stockHelperHost() },
				{ timeoutMs: REFRESH_TIMEOUT_MS },
			);
		} catch (failure) {
			this.#log?.("recall-terms-failed", { error: failure instanceof Error ? failure.message : String(failure) });
		}
	}
}
