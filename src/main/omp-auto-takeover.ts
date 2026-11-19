/**
 * OMPdesk is the one owner of omp updates (docs/design/follow-omp.md, "올리는 길이 둘"): stock omp's own background
 * update (`update.auto`, default off) installs the registry's newest on any interactive launch, verified or not, and
 * takes no version, so the verified list cannot steer it. While "Keep tools up to date" is on, OMPdesk turns a stock
 * `update.auto` that is on off, once, through stock's own settings command (`omp config set`), and records what it
 * found (who, when, which value) in `<userData>/omp-auto-takeover.json`. Turning the switch off gives the value back,
 * but only while stock still holds the value OMPdesk wrote. A person who changes it in between keeps their choice:
 * OMPdesk lets go and leaves it alone until the switch goes off (turning it on again later is a fresh start). The hub's
 * review point 6 (a): round trip, a change in between, originally off, no config file at all.
 */
import { readFileSync } from "node:fs";
import { AtomicSaver } from "./atomic-file";

export const STOCK_AUTO_KEY = "update.auto";

/**
 * What OMPdesk did to stock's value, with when (ISO 8601) and which OMPdesk release:
 * - `taken`: stock had it on and OMPdesk wrote off;
 * - `left`: a person changed it while OMPdesk held it, so OMPdesk keeps its hands off while the switch stays on.
 */
export type TakeoverRecord =
	| { state: "taken"; before: true; wrote: false; at: string; by: string }
	| { state: "left"; current: boolean; at: string; by: string };

export type TakeoverStep =
	| { kind: "take" }
	| { kind: "give-back" }
	/** Stock no longer holds what OMPdesk wrote: remember that, write nothing. */
	| { kind: "let-go"; current: boolean }
	/** The switch went off after OMPdesk let go: forget it, write nothing. */
	| { kind: "forget" }
	| { kind: "none" };

/** What to do, from the switch, stock's current value (null: it could not be read) and the record. */
export function takeoverStep(enabled: boolean, current: boolean | null, record: TakeoverRecord | null): TakeoverStep {
	if (current === null) return { kind: "none" };
	switch (record?.state) {
		case "taken":
			if (current !== record.wrote) return { kind: "let-go", current };
			return enabled ? { kind: "none" } : { kind: "give-back" };
		case "left":
			return enabled ? { kind: "none" } : { kind: "forget" };
		default:
			return enabled && current ? { kind: "take" } : { kind: "none" };
	}
}

/** A short `omp …` run to completion (OmpRuntime.run). */
export type OmpCliRun = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

async function stockConfig(run: OmpCliRun, args: string[]): Promise<Record<string, unknown>> {
	const result = await run(["config", ...args, "--json"]);
	if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().slice(-400) || `exit ${result.code}`);
	const reply: unknown = JSON.parse(result.stdout);
	if (typeof reply !== "object" || reply === null) throw new Error(`omp config ${args[0]}: no JSON object`);
	return reply as Record<string, unknown>;
}

/** Stock's effective `update.auto` (`omp config get update.auto --json` → `{key, value, …}`); null when not a boolean. */
export async function readStockAuto(run: OmpCliRun): Promise<boolean | null> {
	const { value } = await stockConfig(run, ["get", STOCK_AUTO_KEY]);
	return typeof value === "boolean" ? value : null;
}

/**
 * `omp config set update.auto <value> --json`. Stock writes its global config and answers `overriddenBy` when an
 * environment variable or a project's settings still decide the effective value: that is no write that took.
 */
export async function writeStockAuto(run: OmpCliRun, value: boolean): Promise<void> {
	const { overriddenBy } = await stockConfig(run, ["set", STOCK_AUTO_KEY, String(value)]);
	if (typeof overriddenBy === "string") throw new Error(`written, but ${overriddenBy} overrides it`);
}

export interface OmpAutoTakeoverDeps {
	enabled: () => boolean;
	/** Stock's effective `update.auto` (`omp config get update.auto --json`); null when omp cannot tell. */
	read: () => Promise<boolean | null>;
	/** `omp config set update.auto <value>`; rejects when stock refused it. */
	write: (value: boolean) => Promise<void>;
	/** The record's file; null keeps it in memory. */
	file: string | null;
	/** This OMPdesk release, for the record. */
	app: string;
	log: (
		step: "stock-auto-taken" | "stock-auto-given-back" | "stock-auto-let-go" | "stock-auto-failed",
		details: Record<string, unknown>,
	) => void;
	onChanged: () => void;
	now?: () => number;
}

export class OmpAutoTakeover {
	readonly #deps: OmpAutoTakeoverDeps;
	readonly #saver: AtomicSaver;
	#record: TakeoverRecord | null;
	#running: Promise<void> = Promise.resolve();

	constructor(deps: OmpAutoTakeoverDeps) {
		this.#deps = deps;
		this.#saver = new AtomicSaver(deps.file);
		this.#record = deps.file ? readRecord(deps.file) : null;
	}

	/** OMPdesk holds stock `update.auto` turned off now. */
	taken(): boolean {
		return this.#record?.state === "taken";
	}

	/** Settle stock's setting against the switch: at launch once omp is detected, and on each change of the switch. */
	sync(): Promise<void> {
		this.#running = this.#running.then(() => this.#sync());
		return this.#running;
	}

	async #sync(): Promise<void> {
		const current = await this.#deps.read().catch(() => null);
		const step = takeoverStep(this.#deps.enabled(), current, this.#record);
		const stamp = { at: new Date((this.#deps.now ?? Date.now)()).toISOString(), by: `OMPdesk ${this.#deps.app}` };
		const taken = this.#record?.at;
		try {
			switch (step.kind) {
				case "none":
					return;
				case "take":
					await this.#deps.write(false);
					this.#set({ state: "taken", before: true, wrote: false, ...stamp });
					this.#deps.log("stock-auto-taken", { key: STOCK_AUTO_KEY, before: true, wrote: false });
					return;
				case "give-back":
					await this.#deps.write(true);
					this.#set(null);
					this.#deps.log("stock-auto-given-back", { key: STOCK_AUTO_KEY, value: true, taken });
					return;
				case "let-go":
					this.#set({ state: "left", current: step.current, ...stamp });
					this.#deps.log("stock-auto-let-go", { key: STOCK_AUTO_KEY, current: step.current, taken });
					return;
				case "forget":
					this.#set(null);
					return;
			}
		} catch (error) {
			this.#deps.log("stock-auto-failed", {
				key: STOCK_AUTO_KEY,
				step: step.kind,
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#set(record: TakeoverRecord | null): void {
		this.#record = record;
		this.#saver.save(`${JSON.stringify({ record }, null, "\t")}\n`);
		this.#deps.onChanged();
	}
}

function readRecord(file: string): TakeoverRecord | null {
	try {
		const data: unknown = JSON.parse(readFileSync(file, "utf8"));
		const record = typeof data === "object" && data !== null ? Reflect.get(data, "record") : null;
		if (typeof record !== "object" || record === null) return null;
		const { state, before, wrote, current, at, by } = record as Record<string, unknown>;
		if (typeof at !== "string" || typeof by !== "string") return null;
		if (state === "taken" && before === true && wrote === false) return { state, before, wrote, at, by };
		if (state === "left" && typeof current === "boolean") return { state, current, at, by };
		return null;
	} catch {
		return null;
	}
}
