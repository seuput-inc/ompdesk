/**
 * Two apps lost their core in the same minute of a CI run while unrelated OMPdesk processes stood still too, and no
 * line said whether the computer was starved (memory, disk, processors taken from outside) or OMPdesk's own load held
 * them. So a stall leaves the state around it in `gui-runtime.jsonl` (source `machine-state`): the newest sample
 * taken before it (`when: "before"`) and a fresh one right after (`when: "after"`). Observation only.
 *
 * A sample is the memory watch's reading and process list (memory-watch.ts, every 5 s; the core reads both) beside
 * what main reads of itself and the computer with no core at all, so a sample the core did not answer still says
 * something. Every processor share is of all processors (100: every one busy), so `cpuBusyPct` less `appCpuPct` is
 * what programs that are not OMPdesk's used.
 */
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { LineBudget } from "./line-budget";
import type { MemoryReading, ProcessRow } from "./memory-sampler";

type Details = Record<string, string | number | boolean>;

/** What is taken for a stall: a core main gave up on, main's thread kept from its timers, main's wait on the core. */
export type StallKind = "core-loss" | "loop" | "hub";

/** From how many ms a slow step of main's thread or of its wait on the core is a stall. */
export const STALL_MS = 2_000;
/** Samples kept: a minute of the watch's. */
export const STATE_SAMPLES = 12;
/** One pair of lines per kind of stall in this long; the stalls between are counted on the next pair (`dropped`). */
export const STATE_REPEAT_MS = 60_000;
/** Pairs an hour over all kinds. */
export const STATE_PAIRS_PER_HOUR = 20;
/**
 * The shortest window a processor share is measured over: a stall's fresh sample lands moments after the watch's own,
 * and a share of a few ms of wall time read 7050 % (parity run 44652689900). A shorter one keeps the older baseline.
 */
export const CPU_WINDOW_MS = 1_000;
/** Baselines kept: a stall's fresh sample right after the watch's still finds one a window old. */
const BASELINES = 4;

/** The newest of `readings` taken at least {@link CPU_WINDOW_MS} before `at`. */
function baseline<T extends { at: number }>(readings: readonly T[], at: number): T | undefined {
	return readings.findLast(reading => at - reading.at >= CPU_WINDOW_MS);
}

/** What main reads of itself and the computer without the core. */
export interface OwnReading {
	at: number;
	/** Processor time this process has used so far, in ms. */
	cpuMs: number;
	freeBytes: number;
	totalBytes: number;
	cpus: number;
	/** Processor time all processors have spent so far, and of it not idle, in ms. */
	cpuTotalMs: number;
	cpuBusyMs: number;
	/** The 1-minute load average; Windows has none. */
	load1?: number;
}

export function readOwn(now = Date.now()): OwnReading {
	const used = process.cpuUsage();
	const all = cpus();
	let total = 0;
	let idle = 0;
	// `irq` is left out: Windows counts it inside `sys`, macOS reports none.
	for (const { times } of all) {
		idle += times.idle;
		total += times.user + times.nice + times.sys + times.idle;
	}
	return {
		at: now,
		cpuMs: (used.user + used.system) / 1_000,
		freeBytes: freemem(),
		totalBytes: totalmem(),
		cpus: all.length,
		cpuTotalMs: total,
		cpuBusyMs: total - idle,
		...(process.platform === "win32" ? {} : { load1: loadavg()[0] ?? 0 }),
	};
}

const mb = (bytes: number): number => Math.round(bytes / 1024 ** 2);
const tenth = (value: number): number => Math.round(value * 10) / 10;
const share = (part: number, whole: number): number => tenth((100 * part) / whole);

/**
 * What two of main's own readings say: memory, how busy the processors were between them and how much of them this
 * process took. A blocked main cannot take this sample; the shell watchdog samples its PID independently.
 */
export function ownFacts(own: OwnReading, before: OwnReading): Details {
	const total = own.cpuTotalMs - before.cpuTotalMs;
	const wall = (own.at - before.at) * own.cpus;
	return {
		availMB: mb(own.freeBytes),
		totalMB: mb(own.totalBytes),
		cpus: own.cpus,
		...(total > 0 ? { cpuBusyPct: share(own.cpuBusyMs - before.cpuBusyMs, total) } : {}),
		...(own.load1 !== undefined ? { load1: Math.round(own.load1 * 100) / 100 } : {}),
		...(wall > 0 ? { mainCpuPct: share(own.cpuMs - before.cpuMs, wall) } : {}),
	};
}

/** OMPdesk's own processes, as main knows them without asking the core. */
export interface OwnPids {
	main: number;
	/** The window's shell, when main runs under one. */
	host?: number;
	core?: number;
}

type Role = "main" | "host" | "core" | "workers" | "omp";

/**
 * Whose of OMPdesk's a process is: the nearest of its own processes above it. What the core started besides the omps
 * (the stock helper's workers, a git, a gh) reads `workers`; null is not OMPdesk's.
 */
// shortcut: a parent's pid is taken as listed, so a reused pid can put a stranger under ours for one sample, and a
// process whose parent ended (a daemon) is nobody's; read `procs.list`'s start times and tags (90 ms a listing) once a
// line is doubted for it.
function roleOf(
	row: ProcessRow,
	byPid: ReadonlyMap<number, ProcessRow>,
	pids: OwnPids,
	omps: readonly number[],
): Role | null {
	const seen = new Set<number>();
	for (let at: ProcessRow | undefined = row; at && !seen.has(at.pid); at = byPid.get(at.ppid)) {
		seen.add(at.pid);
		if (omps.includes(at.pid)) return "omp";
		if (at.pid === pids.core) return at === row ? "core" : "workers";
		if (at.pid === pids.main) return "main";
		if (at.pid === pids.host) return "host";
	}
	return null;
}

export interface MachineStateDeps {
	log(message: string, details: Details): void;
	/** A fresh reading and process list (memory-sampler.ts): null for the one the core did not answer in time. */
	read(): Promise<readonly [MemoryReading | null, ProcessRow[] | null]>;
	/** How long `read` waits for the core (`SAMPLE_TIMEOUT_MS`): a fresh sample that took this long is `timedOut`. */
	timeoutMs: number;
	pids(): OwnPids;
	/** The longest main's thread was lately kept from its timers (slow-steps.ts `loopMaxMs`). */
	loopMaxMs?(): number | null;
	own?: (now: number) => OwnReading;
	now?: () => number;
}

export class MachineState {
	readonly #deps: MachineStateDeps;
	readonly #now: () => number;
	readonly #readOwn: (now: number) => OwnReading;
	#samples: Array<{ at: number; facts: Details }> = [];
	/** main's last readings of itself, oldest first: a share is measured from the newest one `CPU_WINDOW_MS` old. */
	#owns: OwnReading[];
	/** Each tab's omp (on Windows its launcher), as the watch last handed them: asking the pool is a wait on the core. */
	#omps: readonly number[] = [];
	/** Each process's processor time at the last listings, oldest first, and when each was asked for. */
	#cpus: Array<{ at: number; byPid: Map<number, number> }> = [];
	readonly #written = new Map<StallKind, number>();
	readonly #budget = new LineBudget(STATE_PAIRS_PER_HOUR);
	#kept = 0;

	constructor(deps: MachineStateDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#readOwn = deps.own ?? readOwn;
		this.#owns = [this.#readOwn(this.#now())];
	}

	/**
	 * One sample: the reading and the process list as the core gave them, null for what it did not answer, and the
	 * tabs' omps when the caller knows them now.
	 */
	sample(
		reading: MemoryReading | null,
		rows: readonly ProcessRow[] | null,
		omps?: readonly number[],
		readAt?: number,
	): Details {
		if (rows && omps) this.#omps = omps;
		const now = this.#now();
		const own = this.#readOwn(now);
		const facts = ownFacts(own, baseline(this.#owns, now) ?? own);
		this.#owns = [...this.#owns, own].slice(-BASELINES);
		if (reading) {
			// The OS's own word for what it can still hand out: node's free memory on macOS leaves out what it would reclaim.
			facts.availMB = mb(reading.availableBytes);
			facts.totalMB = mb(reading.totalBytes);
			if (reading.commitBytes !== undefined && reading.commitLimitBytes)
				facts.commitPct = Math.round((100 * reading.commitBytes) / reading.commitLimitBytes);
			if (reading.swapBytes !== undefined) facts.swapMB = mb(reading.swapBytes);
			facts.pressure = reading.pressure;
			if (reading.runQueue !== undefined) facts.runQueue = tenth(reading.runQueue);
			if (reading.diskQueue !== undefined) facts.diskQueue = tenth(reading.diskQueue);
			if (reading.diskBusyPct !== undefined) facts.diskBusyPct = tenth(reading.diskBusyPct);
		}
		// The listing's processor times stand for when it was asked for, not when its answer came: in a stall the two
		// are seconds apart.
		if (rows) Object.assign(facts, this.#app(rows, readAt ?? now, own.cpus));
		const loopMs = this.#deps.loopMaxMs?.();
		if (typeof loopMs === "number") facts.elMaxMs = loopMs;
		if (!reading || !rows) facts.core = reading ? "no processes" : rows ? "no reading" : "no answer";
		this.#samples.push({ at: now, facts });
		if (this.#samples.length > STATE_SAMPLES) this.#samples.shift();
		return facts;
	}

	/** What OMPdesk's own processes took of the processors since the listing before, and hold of memory. */
	#app(rows: readonly ProcessRow[], at: number, cpuCount: number): Details {
		const pids = this.#deps.pids();
		const byPid = new Map(rows.map(row => [row.pid, row]));
		const before = baseline(this.#cpus, at);
		const times = new Map<number, number>();
		const used: Record<Role, number> = { main: 0, host: 0, core: 0, workers: 0, omp: 0 };
		let bytes = 0;
		for (const row of rows) {
			if (row.cpuMs !== undefined) times.set(row.pid, row.cpuMs);
			const role = roleOf(row, byPid, pids, this.#omps);
			if (!role) continue;
			bytes += row.bytes;
			if (row.cpuMs === undefined) continue;
			const was = before?.byPid.get(row.pid);
			// A pid the listing before did not have started since: all its time is this window's. So is a count that
			// fell: another process under an old pid.
			used[role] += was === undefined || was > row.cpuMs ? row.cpuMs : row.cpuMs - was;
		}
		this.#cpus = [...this.#cpus, { at, byPid: times }].slice(-BASELINES);
		const wall = before ? (at - before.at) * cpuCount : 0;
		return {
			...(wall > 0
				? {
						appCpuPct: share(used.main + used.host + used.core + used.workers + used.omp, wall),
						...(pids.host !== undefined ? { hostCpuPct: share(used.host, wall) } : {}),
						...(pids.core !== undefined
							? { coreCpuPct: share(used.core, wall), workersCpuPct: share(used.workers, wall) }
							: {}),
						ompCpuPct: share(used.omp, wall),
					}
				: {}),
			// The omps that run now: after a lost core the tabs' old ones are gone with it.
			ompCount: this.#omps.filter(pid => byPid.has(pid)).length,
			appMB: mb(bytes),
		};
	}

	/** A `slow-step` line was written (slow-steps.ts): a stall when main's thread or its wait on the core stood this long. */
	slowStep(details: Details): void {
		const kind = details.kind;
		if ((kind === "loop" || kind === "hub") && Number(details.ms) >= STALL_MS) this.stalled(kind);
	}

	/** A stall was logged: the newest sample before it now, a fresh one once the core answered or its time ran out. */
	stalled(kind: StallKind): void {
		const now = this.#now();
		const last = this.#written.get(kind);
		if (last !== undefined && now - last < STATE_REPEAT_MS) {
			this.#kept++;
			return;
		}
		const over = this.#budget.take(now);
		if (over === null) return;
		this.#written.set(kind, now);
		const dropped = over + this.#kept;
		this.#kept = 0;
		const newest = this.#samples[this.#samples.length - 1];
		if (newest)
			this.#deps.log(`${kind} before`, {
				trigger: kind,
				when: "before",
				ageMs: now - newest.at,
				...newest.facts,
				trail: this.#samples
					.map(({ facts }) => [facts.availMB, facts.cpuBusyPct ?? "-", facts.appCpuPct ?? "-"].join("/"))
					.join(" "),
			});
		// On a later turn: a core's loss is told before main lets go of that core, and this read must reach the next one.
		setTimeout(() => void this.#after(kind, now, dropped), 0);
	}

	async #after(kind: StallKind, at: number, dropped: number): Promise<void> {
		const readAt = this.#now();
		const [reading, rows] = await this.#deps.read().catch(() => [null, null] as const);
		const afterMs = this.#now() - at;
		this.#deps.log(`${kind} after`, {
			trigger: kind,
			when: "after",
			afterMs,
			...this.sample(reading, rows, undefined, readAt),
			...(afterMs >= this.#deps.timeoutMs ? { timedOut: true } : {}),
			...(dropped > 0 ? { dropped } : {}),
		});
	}
}
