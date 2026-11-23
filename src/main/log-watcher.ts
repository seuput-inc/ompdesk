import { resolve } from "node:path";
import type { LogBatch } from "../shared/ipc-types";
import { agentDir } from "./agent-paths";
import { CORE_EXITED, core } from "./core/process";

let nextWatcher = 0;

interface Checkpoint {
	/** Only Rust interprets a cursor. Main keeps its latest value until the file is gone. */
	files: Record<string, unknown>;
	lines: string[];
}

interface Update {
	watcher: number;
	batch: LogBatch;
	changes: Record<string, unknown>;
	retained: number;
}

export class LogWatcher {
	readonly #id = ++nextWatcher;
	readonly #root: string;
	#sequence = 0;
	#generation = 0;
	#checkpoint: Checkpoint | null = null;
	#operations: Promise<void> = Promise.resolve();
	#unsubscribe: (() => void) | null = null;

	onLines: ((batch: LogBatch) => void) | null = null;

	constructor(logsDir?: string) {
		this.#root = logsDir === undefined ? resolve(agentDir(), "..", "logs") : resolve(logsDir);
	}

	#after<T>(work: () => Promise<T>): Promise<T> {
		const result = this.#operations.then(work);
		this.#operations = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	start(): Promise<void> {
		return this.#after(async () => {
			if (!this.#unsubscribe) {
				const offLines = core().on("logs.lines", (data, _bin, generation) => {
					const { watcher, batch, changes, retained } = data as Update;
					if (watcher !== this.#id || generation !== this.#generation) return;
					const saved: Checkpoint = (this.#checkpoint ??= { files: {}, lines: [] });
					for (const [name, mark] of Object.entries(changes)) {
						if (mark === null) delete saved.files[name];
						else saved.files[name] = mark;
					}
					const keep = Math.max(0, retained - batch.lines.length);
					saved.lines.splice(0, saved.lines.length - keep);
					if (batch.lines.length <= retained) saved.lines.push(...batch.lines);
					else saved.lines.push(...batch.lines.slice(batch.lines.length - retained));
					this.#sequence = batch.nextSequence;
					if (batch.lines.length) this.onLines?.(batch);
				});
				const reopen = () => {
					void this.#after(async () => {
						if (this.#unsubscribe && !core().shuttingDown) await this.#open();
					}).catch((error: unknown) => console.warn("[log-watcher] reopen failed:", error));
				};
				const offReady = core().on("ready", (_data, _bin, generation) => {
					if (generation !== this.#generation && generation === core().generation) reopen();
				});
				const offExit = core().on(CORE_EXITED, (_data, _bin, generation) => {
					if (generation === this.#generation) reopen();
				});
				this.#unsubscribe = () => {
					offReady();
					offExit();
					offLines();
				};
			}
			await this.#open();
		});
	}

	async #open(): Promise<void> {
		const process = core();
		if (this.#generation && this.#generation === process.generation) return;
		const opening = process.call("logs.start", {
			watcher: this.#id,
			root: this.#root,
			nextSequence: this.#sequence,
			checkpoint: this.#checkpoint,
		});
		this.#generation = process.generation;
		try {
			await opening;
		} catch (error) {
			this.#generation = 0;
			throw error;
		}
	}

	getSnapshot(): Promise<LogBatch> {
		return this.#after(async () => {
			if (!this.#unsubscribe) return { lines: [], nextSequence: this.#sequence };
			await this.#open();
			const { result } = await core().call<LogBatch>(
				"logs.snapshot",
				{ watcher: this.#id },
				{ generation: this.#generation },
			);
			return result;
		});
	}

	stop(): Promise<void> {
		return this.#after(async () => {
			if (!this.#unsubscribe) return;
			try {
				const generation = core().generation;
				if (generation) await core().call("logs.close", { watcher: this.#id }, { generation });
			} finally {
				this.#unsubscribe();
				this.#unsubscribe = null;
				this.#generation = 0;
				this.#checkpoint = null;
			}
		});
	}
}
