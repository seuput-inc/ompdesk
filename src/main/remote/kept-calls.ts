import { core } from "../core/process";

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
}

/** The core owns the file and orders keep, lookup and settlement in arrival order. */
export class KeptCalls {
	readonly #file: string;

	constructor(file: string) {
		this.#file = file;
	}

	async keep(call: KeptCall): Promise<void> {
		await core().call("remote.keptCalls", { file: this.#file, op: "keep", ...call });
	}

	async for(device: string, sessionPath: string): Promise<KeptCall[]> {
		const { result } = await core().call<KeptCall[]>("remote.keptCalls", {
			file: this.#file,
			op: "list",
			device,
			sessionPath,
		});
		return result;
	}

	async settle(device: string, sessionPath: string, id: string): Promise<void> {
		await core().call("remote.keptCalls", { file: this.#file, op: "settle", device, sessionPath, id });
	}
}
