import { codedError, isIpcErrorCode } from "../shared/ipc-error-codes";
import { CoreError, core } from "./core/process";

export type StatsRead = { ready: true; data: unknown } | { ready: false; exhausted: boolean };
export interface StatsLaunch {
	command: string;
	args: string[];
	/** Overlaid on the inherited environment. */
	env?: NodeJS.ProcessEnv;
}

let nextId = 0;

/** The core owns the child, its port and both restart budgets. A fresh read reopens the host after core loss. */
export class StatsServerManager {
	readonly #id = ++nextId;
	readonly #launch: StatsLaunch;
	#opened?: { generation: number; promise: Promise<void> };
	#stopping?: Promise<void>;

	constructor(launch: StatsLaunch) {
		this.#launch = launch;
	}

	start(): Promise<void> {
		if (this.#stopping) return this.#stopping;
		const client = core();
		if (this.#opened && this.#opened.generation === client.generation) return this.#opened.promise;
		const { command, args, env } = this.#launch;
		const open = client.call("stats.start", { id: this.#id, command, args, env: { ...process.env, ...env } });
		const generation = client.generation;
		const promise = open.then(
			() => {},
			error => {
				if (this.#opened?.generation === generation) this.#opened = undefined;
				throw error;
			},
		);
		this.#opened = { generation, promise };
		return promise;
	}

	async fetch(path: string, params?: Record<string, string>): Promise<StatsRead> {
		await this.start();
		if (this.#stopping) return { ready: false, exhausted: true };
		try {
			const answer = await core().call<StatsRead>(
				"stats.fetch",
				{ id: this.#id, path, params },
				{ generation: this.#opened?.generation },
			);
			return answer.result;
		} catch (error) {
			if (error instanceof CoreError && isIpcErrorCode(error.code)) throw codedError(error.code, error.message);
			throw error;
		}
	}

	kill(): Promise<void> {
		if (this.#stopping) return this.#stopping;
		const generation = this.#opened?.generation;
		this.#stopping =
			generation && core().generation === generation
				? core()
						.call("stats.stop", { id: this.#id }, { generation })
						.then(() => {})
				: Promise.resolve();
		return this.#stopping;
	}
}
