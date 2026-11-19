/**
 * Startup compatibility self-check for the gui-bridge extension. omp internals
 * carry no semver, so after `omp update` a bridge method can lose what it
 * relies on. Once per omp version per app launch, the first sidecar whose
 * bridge connects is asked for `capabilities` (resources/gui-bridge/capabilities.ts);
 * missing features, or a bridge that never connected at all, become one warning
 * the renderer takes (BRIDGE_HEALTH_TAKE) and toasts in the UI language.
 *
 * The result for an omp this computer runs is also kept and written down: one
 * `bridge-health` line in gui-runtime.jsonl per omp version and launch (never per
 * tab), and `report()` answers the latest result per version, with how many omps of
 * it run now, for `ompdesk_app` `omp.bridge_health` and a paired device
 * (`host.bridgeHealth.get`). A paired host's tab reports here only for the toast:
 * the host keeps and logs its own.
 */
import type { BridgeHealthReport, BridgeHealthResult, BridgeHealthWarning } from "../shared/ipc-types";
import type { BridgeClient } from "./local/types";
import type { RuntimeLogReport } from "./runtime-log-core";

/** What a sidecar reports once its bridge connect settles (SidecarManager `bridge` event). */
export type BridgeConnectResult =
	| { connected: true; ompVersion: string; bridge: Pick<BridgeClient, "request"> }
	| { connected: false; ompVersion: string; error: string };

/** An omp this computer runs (its SidecarManager): counted per version while its process lives. */
export interface LocalOmp {
	readonly processAlive: boolean;
}

interface Capabilities {
	ompVersion?: unknown;
	unavailable?: unknown;
}

/** Feature ids from a `capabilities` result; anything malformed reads as none. */
export function unavailableFeatures(result: unknown): string[] {
	return unavailableEntries(result).map(entry => entry.feature);
}

/** Each unavailable feature of a `capabilities` result once, with its missing labels; malformed entries are dropped. */
function unavailableEntries(result: unknown): BridgeHealthResult["unavailable"] {
	const unavailable = (result as Capabilities | null)?.unavailable;
	if (!Array.isArray(unavailable)) return [];
	const entries: BridgeHealthResult["unavailable"] = [];
	for (const entry of unavailable) {
		if (typeof entry !== "object" || entry === null || !("feature" in entry)) continue;
		const feature = entry.feature;
		if (typeof feature !== "string" || entries.some(known => known.feature === feature)) continue;
		const missing: unknown[] = "missing" in entry && Array.isArray(entry.missing) ? entry.missing : [];
		entries.push({ feature, missing: missing.filter((label): label is string => typeof label === "string") });
	}
	return entries;
}

export interface BridgeHealthOptions {
	/** A gui-runtime.jsonl line (`writeRuntimeLog`). */
	log?: (report: RuntimeLogReport) => void;
	now?: () => number;
}

export class BridgeHealth {
	readonly #notify: () => void;
	readonly #onIncompatible: (ompVersion: string) => void;
	readonly #log: (report: RuntimeLogReport) => void;
	readonly #now: () => number;
	/** omp versions whose repair already ran this launch: one attempt per version, never a loop. */
	readonly #repaired = new Set<string>();
	/** `<kind>@<version>` already checked (or in flight) this launch. */
	readonly #seen = new Set<string>();
	/** `<kind>@<version>` already kept and logged for an omp of this computer (or in flight). */
	readonly #recorded = new Set<string>();
	/** Unavailable feature ids per omp version whose probe answered. */
	readonly #unavailable = new Map<string, readonly string[]>();
	/** The latest result per omp version this computer ran in this launch. */
	readonly #results = new Map<string, Omit<BridgeHealthResult, "running">>();
	/** The omps of this computer by the version they last reported. */
	readonly #omps = new Map<LocalOmp, string>();
	#pending: BridgeHealthWarning[] = [];

	/** `notify` tells every window that warnings are waiting. */
	constructor(
		notify: () => void,
		/** An omp of this computer that lacks what the bridge needs (or that the bridge never reached): the app updates omp itself. */
		onIncompatible: (ompVersion: string) => void = () => {},
		{ log = () => {}, now = Date.now }: BridgeHealthOptions = {},
	) {
		this.#notify = notify;
		this.#onIncompatible = onIncompatible;
		this.#log = log;
		this.#now = now;
	}

	/**
	 * Settles once the probe (if any) is done; never rejects. `local` is the omp of this computer that connected;
	 * without it the result is a paired host's, which keeps its own record and repairs its own omp.
	 */
	async observe(result: BridgeConnectResult, local?: LocalOmp): Promise<void> {
		if (local) this.#omps.set(local, result.ompVersion);
		if (!result.connected) {
			const key = `unavailable@${result.ompVersion}`;
			if (local && !this.#recorded.has(key)) {
				this.#recorded.add(key);
				this.#keep({ ompVersion: result.ompVersion, ok: false, unavailable: [], unreachable: result.error });
			}
			if (local) this.#repair(result.ompVersion);
			if (this.#seen.has(key)) return;
			this.#seen.add(key);
			this.#push({ kind: "unavailable", ompVersion: result.ompVersion, reason: result.error });
			return;
		}
		const key = `capabilities@${result.ompVersion}`;
		const warn = !this.#seen.has(key);
		const record = local !== undefined && !this.#recorded.has(key);
		if (!warn && !record) return;
		if (warn) this.#seen.add(key);
		if (record) this.#recorded.add(key);
		let capabilities: unknown;
		try {
			capabilities = await result.bridge.request("capabilities");
		} catch (error) {
			// The next sidecar to connect retries; a dropped socket says nothing about omp.
			if (warn) this.#seen.delete(key);
			if (record) this.#recorded.delete(key);
			console.warn(
				`[bridge-health] capabilities check failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const entries = unavailableEntries(capabilities);
		if (record) this.#keep({ ompVersion: result.ompVersion, ok: entries.length === 0, unavailable: entries });
		if (local && entries.length > 0) this.#repair(result.ompVersion);
		if (!warn) return;
		const features = entries.map(entry => entry.feature);
		this.#unavailable.set(result.ompVersion, features);
		if (features.length === 0) return;
		console.warn(
			`[bridge-health] omp ${result.ompVersion} lacks internals: ${JSON.stringify((capabilities as Capabilities).unavailable)}`,
		);
		const reported = (capabilities as Capabilities).ompVersion;
		this.#push({
			kind: "unsupported",
			ompVersion: typeof reported === "string" && reported ? reported : result.ompVersion,
			features,
		});
	}

	/**
	 * Whether omp `ompVersion` serves `feature` (capabilities.ts id), from this
	 * launch's probe; null before a sidecar of that version has answered one.
	 */
	supports(ompVersion: string, feature: string): boolean | null {
		const unavailable = this.#unavailable.get(ompVersion);
		return unavailable ? !unavailable.includes(feature) : null;
	}

	/** The latest result per omp version of this computer: running versions first, then the newest. */
	report(): BridgeHealthReport {
		const running = new Map<string, number>();
		for (const [omp, version] of this.#omps) {
			if (!omp.processAlive) this.#omps.delete(omp);
			else running.set(version, (running.get(version) ?? 0) + 1);
		}
		const results = [...this.#results.values()].map(result => ({
			...result,
			running: running.get(result.ompVersion) ?? 0,
		}));
		results.sort((a, b) => Number(b.running > 0) - Number(a.running > 0) || b.at - a.at);
		return { results };
	}

	/** Hand every pending warning to the caller (one window), clearing them. */
	take(): BridgeHealthWarning[] {
		const pending = this.#pending;
		this.#pending = [];
		return pending;
	}

	#keep(result: Omit<BridgeHealthResult, "at" | "running">): void {
		this.#results.set(result.ompVersion, { ...result, at: this.#now() });
		const { ompVersion, ok, unavailable, unreachable } = result;
		this.#log(
			unreachable === undefined
				? {
						source: "bridge-health",
						message: "probed",
						details: { ompVersion, ok, ...loggedUnavailable(unavailable), ...(ok ? {} : { level: "warn" }) },
					}
				: {
						source: "bridge-health",
						message: "unreachable",
						details: { ompVersion, ok, reason: unreachable, level: "warn" },
					},
		);
	}

	#push(warning: BridgeHealthWarning): void {
		this.#pending.push(warning);
		this.#notify();
	}

	/** An omp of this computer lacks what the bridge needs: updating this computer's omp can help, once per version. */
	#repair(ompVersion: string): void {
		if (this.#repaired.has(ompVersion)) return;
		this.#repaired.add(ompVersion);
		this.#onIncompatible(ompVersion);
	}
}

/** Room for the `unavailable` list on one log line: runtime-log-core's 4 096-character detail bound, less a margin. */
const UNAVAILABLE_LOG_BUDGET = 4_000;

/**
 * The `unavailable` entries that fit one log line, whole and in order, and how many were left out, so a widespread
 * incompatibility still logs a list a reader can parse rather than a cut string.
 */
function loggedUnavailable(entries: BridgeHealthResult["unavailable"]): {
	unavailable: BridgeHealthResult["unavailable"];
	unavailableOmitted?: number;
} {
	const kept: BridgeHealthResult["unavailable"] = [];
	let size = 2;
	for (const entry of entries) {
		const add = JSON.stringify(entry).length + (kept.length > 0 ? 1 : 0);
		if (size + add > UNAVAILABLE_LOG_BUDGET) break;
		kept.push(entry);
		size += add;
	}
	const omitted = entries.length - kept.length;
	return omitted > 0 ? { unavailable: kept, unavailableOmitted: omitted } : { unavailable: kept };
}
