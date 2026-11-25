/**
 * Local inference engines OMPdesk looks for on loopback and lists the models of by itself (the core's
 * `models/detect.rs`, opened by main's `local-engines.ts`; renderer: the one switch under Settings › Models &
 * accounts). Dependency-free: both sides import it.
 */

/** Boolean pref; never stored = on. */
export const LOCAL_ENGINE_DETECT_PREF = "localEngineDetect";

/** One engine: `id` is the models.yml provider id it is registered under. */
export interface LocalEngineSpec {
	id: string;
	name: string;
	/** OpenAI-compatible root, `/models` is read below it. */
	baseUrl: string;
}

// FreeToken: https://github.com/FlashML-org/FreeToken, colibri: https://github.com/JustVugg/colibri
export const LOCAL_ENGINES: readonly LocalEngineSpec[] = [
	{ id: "freetoken", name: "FreeToken", baseUrl: "http://127.0.0.1:1919/v1" },
	{ id: "colibri", name: "colibri", baseUrl: "http://127.0.0.1:8000/v1" },
];

/** The detection switch of one computer, as `LOCAL_ENGINES_GET|SET` and `host.localEngines.*` answer. */
export interface LocalEngineDetectState {
	enabled: boolean;
}

export function localEngineDetectEnabled(value: unknown): boolean {
	return value !== false;
}
