/**
 * Finds the local inference engines of `LOCAL_ENGINES` (FreeToken, colibri) on loopback and keeps a models.yml
 * provider for each one that answers, so its models are listed without the person adding anything. The detector runs
 * in the core (`native/ompdesk/crates/core/src/models/detect.rs`): the probes, the rules, the ledger and the switch
 * pref are its own. This side opens it with this launch's table, routes its two events, hands it the switch and opens
 * it again on the next core when one dies. A paired computer runs its own detector over its own file.
 */
import { LOCAL_ENGINES, type LocalEngineSpec } from "../shared/local-engines";
import { agentDir } from "./agent-paths";
import { CoreError, core } from "./core/process";
import { stockHelperHost } from "./stock-helper";

export const LOCAL_ENGINE_INTERVAL_MS = 60_000;
/** The open request is kept open on the core: it fails when the core dies, which is how this side learns it. */
const HOLD_MS = 2 ** 31 - 1;
/** How long after a core refused the detector it is opened again. */
const REOPEN_MS = 30_000;

/** The engine table and the pause between passes of this launch. */
export interface LocalEngineSettings {
	engines: readonly LocalEngineSpec[];
	intervalMs: number;
}

function isEngineSpec(value: unknown): value is LocalEngineSpec {
	const record = value as Record<string, unknown>;
	return (
		typeof value === "object" &&
		value !== null &&
		["id", "name", "baseUrl"].every(key => typeof record[key] === "string")
	);
}

/**
 * Test seam, unpackaged launches only: `OMP_GUI_TEST_LOCAL_ENGINES` (a JSON array of `LocalEngineSpec`) replaces the
 * table so a spec can serve a fake engine on any loopback port, `OMP_GUI_TEST_LOCAL_ENGINE_INTERVAL_MS` the pause.
 */
export function localEngineSettings(env: NodeJS.ProcessEnv, packaged: boolean): LocalEngineSettings {
	if (packaged) return { engines: LOCAL_ENGINES, intervalMs: LOCAL_ENGINE_INTERVAL_MS };
	let engines: readonly LocalEngineSpec[] = LOCAL_ENGINES;
	try {
		const parsed: unknown = env.OMP_GUI_TEST_LOCAL_ENGINES ? JSON.parse(env.OMP_GUI_TEST_LOCAL_ENGINES) : null;
		if (Array.isArray(parsed) && parsed.every(isEngineSpec)) engines = parsed;
	} catch {
		// An unreadable table is no table: the real one stays.
	}
	const interval = Number(env.OMP_GUI_TEST_LOCAL_ENGINE_INTERVAL_MS);
	return { engines, intervalMs: Number.isFinite(interval) && interval > 0 ? interval : LOCAL_ENGINE_INTERVAL_MS };
}

export interface LocalEnginesOptions extends LocalEngineSettings {
	/** Passes run by themselves; without it only the switch runs one (a test launch never probes real ports). */
	start: boolean;
	/** `prefs.json`, which holds the switch and the ledger. */
	prefs: string;
	/** models.yml was changed: windows read the model list again. */
	changed(): void;
	/** A read or write failed; the next pass tries again. `engine` is null when models.yml could not be read. */
	failed(error: string, engine: string | null): void;
}

export class LocalEngines {
	readonly #options: LocalEnginesOptions;
	/** The stock helper the open detector edits models.yml through. */
	#host = "";
	#retry: NodeJS.Timeout | null = null;
	readonly #unsubscribe: (() => void)[];
	#disposed = false;

	constructor(options: LocalEnginesOptions) {
		this.#options = options;
		this.#unsubscribe = [
			core().on("models.localEngines.changed", () => {
				if (!this.#disposed) options.changed();
			}),
			core().on("models.localEngines.failed", data => {
				if (this.#disposed) return;
				const { engine, error } = data as { engine: string | null; error: string };
				options.failed(error, engine);
				// An omp update replaced the stock helper: the detector still names the old one.
				if (stockHelperHost() !== this.#host) this.open();
			}),
		];
	}

	/** Opens the detector in the core, replacing one opened before; when that core dies, opens it on the next. */
	open(): void {
		if (this.#disposed) return;
		clearTimeout(this.#retry ?? undefined);
		this.#host = stockHelperHost();
		const { engines, intervalMs, start, prefs } = this.#options;
		core()
			.call(
				"models.localEngines.open",
				{ dir: agentDir(), host: this.#host, prefs, engines, intervalMs, start },
				{ timeoutMs: HOLD_MS },
			)
			.catch((error: unknown) => {
				if (this.#disposed) return;
				if (error instanceof CoreError && (error.code === "core_exited" || error.code === "timeout")) {
					this.open();
					return;
				}
				console.error("[local-engines] couldn't open in ompdesk-core:", error);
				this.#retry = setTimeout(() => this.open(), REOPEN_MS);
				this.#retry.unref();
			});
	}

	/**
	 * The switch, called after `LOCAL_ENGINE_DETECT_PREF` is stored: the core's detector waits for a pass under way,
	 * then off removes the entries it wrote and stops the timer, on runs a pass now (an entry the person deleted stays
	 * deleted).
	 */
	async setEnabled(on: boolean): Promise<void> {
		await core().call("models.localEngines.set", { enabled: on }, { timeoutMs: HOLD_MS });
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearTimeout(this.#retry ?? undefined);
		for (const off of this.#unsubscribe) off();
		// Only the running core: a quit never starts one to close a detector it does not have.
		const generation = core().generation;
		if (generation !== 0)
			core()
				.call("models.localEngines.close", {}, { generation })
				.catch(() => undefined);
	}
}
