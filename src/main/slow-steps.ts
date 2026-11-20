/**
 * "Windows feels slow" came with no measurement, so the next slow step leaves one: a `gui-runtime.jsonl` line (source
 * `slow-step`) naming what was slow and for how long. Observation only; nothing installs it under vitest. Each step
 * is timed where it already runs:
 * - `loop`: main's thread did not get to its timers for `ms` (Node's event-loop delay, read every `LOOP_CHECK_MS`),
 *   with the CPU main itself used in that window (`cpuMs`: far below `ms`, main waited for the disk, another process
 *   or a CPU and computed nothing) and `during`, the steps below that held the thread meanwhile.
 * - `ipc`: a handler's answer (`web/ipc-registry.ts`); `syncMs` of it ran on main's thread before its first await.
 * - `hub`: one synchronous wait of main on the core (`core/hub.ts`).
 * - `stock`: one stock helper request (`stock-helper.ts`).
 * - `tab-open`: an omp's start up to `ready`, with the time of each stage (`sidecar.ts`).
 *
 * A stall past 5 s that never ends is the hang watchdog's (hang-watchdog.ts), a late model call turn-stages'.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { LineBudget } from "./line-budget";

export type SlowKind = "loop" | "ipc" | "hub" | "stock" | "tab-open";

type Details = Record<string, string | number | boolean>;

/** From how many ms a step is slow. */
export const SLOW_STEP_MS: Record<SlowKind, number> = {
	loop: 200,
	ipc: 1_000,
	hub: 100,
	stock: 1_000,
	"tab-open": 5_000,
};
/** A handler that held main's thread this long before its first await is slow whatever its answer took. */
export const SLOW_SYNC_MS = 100;
/** A step that held main's thread at least this long is named on the next `loop` line. */
const HELD_MS = 20;
const HELD_KEPT = 32;
/** One step is written at most once in this long; the times between are counted on its next line. */
export const SLOW_REPEAT_MS = 10 * 60_000;
/** Lines an hour over all steps; the ones past it are counted on the next line written (`dropped`). */
export const SLOW_LINES_PER_HOUR = 60;
const LOOP_RESOLUTION_MS = 100;
const LOOP_CHECK_MS = 5_000;
// shortcut: a longer gap is taken for the computer's sleep, which main's own thread cannot tell from a block;
// read the powerMonitor's suspend here if a real stall of that length must be told (the hang watchdog keeps it).
const LOOP_LAG_MAX_MS = 30_000;

export interface SlowStepsDeps {
	log(message: string, details: Details): void;
	now?: () => number;
}

export class SlowSteps {
	readonly #log: SlowStepsDeps["log"];
	readonly #now: () => number;
	/** Per step: when its last line was written, and what the limit kept out since. */
	readonly #written = new Map<string, { at: number; again: number; worstMs: number }>();
	#held: Array<{ name: string; ms: number }> = [];
	readonly #budget = new LineBudget(SLOW_LINES_PER_HOUR);

	constructor(deps: SlowStepsDeps) {
		this.#log = deps.log;
		this.#now = deps.now ?? Date.now;
	}

	took(kind: SlowKind, name: string, ms: number, extra: Details = {}): void {
		if (ms >= SLOW_STEP_MS[kind]) this.#write(kind, name, ms, extra);
	}

	/** A handler answered after `ms`, `syncMs` of it on main's thread. */
	ipc(channel: string, ms: number, syncMs: number): void {
		this.#hold(`ipc ${channel}`, syncMs);
		if (ms >= SLOW_STEP_MS.ipc || syncMs >= SLOW_SYNC_MS)
			this.#write("ipc", channel, ms, { syncMs: Math.round(syncMs) });
	}

	/** Main's thread waited `ms` for the core's answer. */
	hub(method: string, ms: number): void {
		this.#hold(`hub ${method}`, ms);
		this.took("hub", method, ms);
	}

	/** The longest main's thread was kept from its timers since the last call, and the CPU main used meanwhile. */
	loop(lagMs: number, cpuMs: number): void {
		const during = this.#held.sort((a, b) => b.ms - a.ms).slice(0, 5);
		this.#held = [];
		if (lagMs < SLOW_STEP_MS.loop || lagMs > LOOP_LAG_MAX_MS) return;
		this.#write("loop", during[0]?.name ?? "unknown", lagMs, {
			cpuMs: Math.round(cpuMs),
			...(during.length > 0
				? { during: during.map(step => `${step.name} ${Math.round(step.ms)}ms`).join(", ") }
				: {}),
		});
	}

	#hold(name: string, ms: number): void {
		if (ms >= HELD_MS && this.#held.length < HELD_KEPT) this.#held.push({ name, ms });
	}

	#write(kind: SlowKind, name: string, ms: number, extra: Details): void {
		const now = this.#now();
		const key = `${kind} ${name}`;
		const last = this.#written.get(key);
		if (last && now - last.at < SLOW_REPEAT_MS) {
			last.again++;
			last.worstMs = Math.max(last.worstMs, ms);
			return;
		}
		const dropped = this.#budget.take(now);
		if (dropped === null) return;
		this.#written.set(key, { at: now, again: 0, worstMs: 0 });
		this.#log(`${key} took ${Math.round(ms)} ms`, {
			kind,
			name,
			ms: Math.round(ms),
			...extra,
			...(last && last.again > 0 ? { again: last.again, worstMs: Math.round(last.worstMs) } : {}),
			...(dropped > 0 ? { dropped } : {}),
		});
	}
}

let active: SlowSteps | null = null;
let loopMax: (() => number) | null = null;

/** The longest main's thread was kept from its timers in the last 5 to 10 s, in ms; null where no probe is installed. */
export function loopMaxMs(): number | null {
	return loopMax?.() ?? null;
}

/** Starts the probe for this process and the watch on main's own thread (index.ts, once the app is ready). */
export function installSlowSteps(deps: SlowStepsDeps): void {
	const steps = new SlowSteps(deps);
	active = steps;
	const delay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
	delay.enable();
	let cpu = process.cpuUsage();
	// The histogram holds each timer interval whole: the delay is what its longest ran past the resolution.
	const lag = (): number => Math.max(0, delay.max / 1e6 - LOOP_RESOLUTION_MS);
	let lastLagMs = 0;
	loopMax = () => Math.round(Math.max(lastLagMs, lag()));
	setInterval(() => {
		const used = process.cpuUsage(cpu);
		cpu = process.cpuUsage();
		lastLagMs = lag();
		delay.reset();
		steps.loop(lastLagMs, (used.user + used.system) / 1_000);
	}, LOOP_CHECK_MS).unref();
}

export function tookStep(kind: SlowKind, name: string, ms: number, extra?: Details): void {
	active?.took(kind, name, ms, extra);
}

export function tookIpc(channel: string, ms: number, syncMs: number): void {
	active?.ipc(channel, ms, syncMs);
}

export function tookHub(method: string, ms: number): void {
	active?.hub(method, ms);
}
