/**
 * Whose process is it, and what a closed session leaves behind (the owner's report, 12 Nov 2026: finished work left dev
 * servers, browsers and an emulator running until a 16 GB Mac froze).
 *
 * Every tab's omp is spawned with a tag in its environment (`SESSION_TAG_ENV`, one random value per tab, kept for
 * every omp the tab starts). Whatever the omp starts inherits it, however deep, and keeps it after its parent is gone
 * (a daemon, a double fork, `nohup`, `&`), so the core process can read back, for any running process, which tab
 * started it (`procs.list`) and end exactly a tab's processes (`procs.end`: asked first, killed after a grace).
 *
 * A session's processes live as long as its tab:
 * - The tab closes (the person, an agent, a deleted session, a hosted tab whose grace ended, a closed window): once its
 *   omp has exited, every process that still carries its tag is ended.
 * - The app quits: nothing is ended. Tabs come back at the next launch, and a tab that comes back on its session takes
 *   its tag over, so a dev server its next turn needs is still there.
 * - The next launch (`sweep`) ends the processes of every tag the last one left whose session did not come back: no tab
 *   in the restored layout and no marker of interrupted work. This is also what cleans up after a crash or a forced
 *   quit, where no close ever ran.
 * - Of a tag it keeps, the launch reports whose output path is closed (`procs.list`'s `outputClosed`, a write to it
 *   fails, with what is known of its other end: `closed`, `open` or `unknown`): its pid, name, start, ports and the
 *   CPU it uses, marked spinning at `SPIN_PERCENT` (the relaunch of 20 Nov 2026: next-server logged each failed write
 *   and spun at 100 % CPU). It ends, while `endSpinning` holds (the hidden pref `endSpinningOnClosedOutput`, default
 *   on: the owner's answer of 20 Nov 2026), only one whose other end is confirmed closed and that spins in each of
 *   `SPIN_SAMPLES` samples `SPIN_SAMPLE_GAP_MS` apart. The tab that takes the tag over tells its session what still runs
 *   and what was ended (`leftover`).
 *
 * Never the wrong process: only tags this file wrote are ever ended (`<userData>/session-processes.json`), so a
 * process started outside OMPdesk, by another OMPdesk (another userData) or by a tab that is still open is not
 * touched. Stock omp's own shared workers (`STOCK_WORKER_ARG`: the project's service broker, whose services stop with
 * the project's last omp or stay while `launch.persist` is on, the LSP multiplexer, the blob broker) and what they
 * started are left to stock. A tag the app itself runs under (it was started from that session's shell) is refused by
 * the core.
 *
 * Not seen: a process that cleared its environment, one started through the system instead of as a child (macOS `open`,
 * a launchd job, a VM's XPC service), and on Windows a process this user may not read (elevated).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, normalize, relative } from "node:path";
import { z } from "zod";
import type { LeftProcess, LeftProcesses, OutputPeer } from "../../resources/gui-bridge/restart-core";
import type { SessionUse } from "../shared/ipc-types";
import { writeFileAtomicDeferred } from "./atomic-file";
import { core } from "./core/process";
import { SESSION_TAG_ENV } from "./omp-launch";
import type { SessionScratch } from "./session-scratch";

/** The file in userData that names every tab's tag. */
export const SESSION_PROCESSES_FILE = "session-processes.json";
/** Stock omp's worker selectors (`cli/worker-selectors.ts`): a process started with one is stock's own, never a session's leftover. */
export const STOCK_WORKER_ARG = "__omp_worker_";
/** How long a process asked to end gets before it is killed. */
export const END_GRACE_MS = 5_000;
/** The longest one `procs.end` may take in the core, and what main waits for it. */
const END_TIMEOUT_MS = 20_000;
const END_CALL_TIMEOUT_MS = END_TIMEOUT_MS + 5_000;
/** How long one process listing with its tags may take. */
export const LIST_TIMEOUT_MS = 10_000;
/**
 * How long after an end that left something running (stock's worker kept, a process that survived the kill) the tag is
 * tried once more: a worker whose omp is gone ends itself within seconds, and what it started then carries the tag alone.
 */
export const RETRY_REMAINING_MS = 60_000;

/**
 * The share of one core, in percent, over `SPIN_SAMPLE_MS`, at which a process with a closed output path reads as
 * spinning. The relaunch's loop used 99-100 % without pause; the same server with nothing to write used 0 %, so half a
 * core over 3 s tells the two apart without making the restore wait long.
 */
export const SPIN_PERCENT = 50;
export const SPIN_SAMPLE_MS = 3_000;
/**
 * Before a launch ends a spinning process whose output's other end is closed, it must spin in this many samples, each
 * starting this long after the one before: three over a minute. The loop never paused in any sample measured (99-100 %
 * every time, macOS and Windows); a dev server busy compiling after a relaunch works in bursts and falls back to idle
 * within a minute, so it drops under the mark in one of them and is only reported.
 */
export const SPIN_SAMPLES = 3;
export const SPIN_SAMPLE_GAP_MS = 30_000;
/** At most this many processes in one log line's `found`, spinning ones first: gui-runtime.jsonl keeps a detail to 4 KiB. */
const FOUND_MAX = 16;
/** Why a launch ends a process, in the log. */
const REASON_SPINNING = "kept spinning on a closed output path whose other end is closed";

/** One process as `procs.list` answers it. */
export interface TaggedProcess {
	pid: number;
	ppid: number;
	/** Resident bytes. */
	bytes: number;
	/** When it started, ms since the epoch; absent when the OS did not say. */
	startedMs?: number;
	/** Its executable's file name. */
	name: string;
	/** The tag in its environment; absent when it has none or its environment cannot be read. */
	tag?: string;
	/** For the tags asked: its working folder. */
	cwd?: string;
	/** For the tags asked: stock's shared worker or under one. */
	stock?: true;
	/** For the tags asked: its output path is closed (a write fails), and what is known of the other end. */
	outputClosed?: OutputPeer;
	/** Of one whose output path is closed, when measured: percent of one core over the sample. */
	cpuPercent?: number;
	/** Of one whose output path is closed: the TCP ports it listens on. */
	ports?: number[];
}

interface EndedProcess {
	pid: number;
	name: string;
	bytes: number;
	/** It did not end when asked and was killed. */
	forced: boolean;
}

/** What `procs.end` answers. */
export interface EndResult {
	ended: EndedProcess[];
	/** Still running after the kill. */
	left: Array<{ pid: number; name: string }>;
	/** Stock's own workers and what they started. */
	kept: Array<{ pid: number; name: string }>;
	/** Tags the core refused: the app itself runs under them. */
	own: string[];
}

/** Every process with its tag; null when the core cannot answer in time. */
export async function listTaggedProcesses(): Promise<TaggedProcess[] | null> {
	try {
		const answer = await core().call<TaggedProcess[]>(
			"procs.list",
			{ env: SESSION_TAG_ENV, timeoutMs: LIST_TIMEOUT_MS },
			{ timeoutMs: LIST_TIMEOUT_MS },
		);
		return answer.result;
	} catch {
		return null;
	}
}

/**
 * The processes of `tags` with their folder and whether their output has a reader; of those without one, their ports
 * and, with `sampleMs`, their CPU. Rejects when the core cannot answer.
 */
async function surveyTaggedProcesses(tags: readonly string[], sampleMs?: number): Promise<TaggedProcess[]> {
	const timeoutMs = LIST_TIMEOUT_MS + (sampleMs ?? 0);
	const answer = await core().call<TaggedProcess[]>(
		"procs.list",
		{
			env: SESSION_TAG_ENV,
			timeoutMs: LIST_TIMEOUT_MS,
			tags,
			keepArg: STOCK_WORKER_ARG,
			...(sampleMs !== undefined ? { sampleMs } : {}),
		},
		{ timeoutMs },
	);
	return answer.result;
}

/** Ends every process that carries one of `tags`; with `only`, just those processes, each by its id and start. */
async function endTaggedProcesses(
	tags: readonly string[],
	only?: ReadonlyArray<{ pid: number; startedMs: number }>,
): Promise<EndResult> {
	const answer = await core().call<EndResult>(
		"procs.end",
		{
			env: SESSION_TAG_ENV,
			tags,
			keepArg: STOCK_WORKER_ARG,
			...(only ? { only } : {}),
			graceMs: END_GRACE_MS,
			timeoutMs: END_TIMEOUT_MS,
		},
		{ timeoutMs: END_CALL_TIMEOUT_MS },
	);
	return answer.result;
}

/** What a tab's omp is launched with that says whose its processes are. */
export interface SessionProcessFacts {
	cwd: string;
	/** The session file the tab is on; absent while stock has not written it. */
	sessionPath?: string;
	/** The paired device this computer runs the tab for. */
	device?: string;
}

/** One tab's tag in the file. A record of another shape (a damaged file, a tag that is no tag) is dropped. */
const TagRecordSchema = z.object({
	tag: z.string().regex(/^[0-9a-f]{32}$/),
	cwd: z.string(),
	sessionPath: z.string().optional(),
	device: z.string().optional(),
	/** When the tag was made. */
	since: z.number(),
});
type TagRecord = z.infer<typeof TagRecordSchema>;

/**
 * `live`: a tab of this launch holds it. `left`: the last launch wrote it and no tab has taken it over yet. `ending`:
 * its processes are being ended; it is never handed to a tab again.
 */
type TagState = "live" | "left" | "ending";

/** What a launch saw of a tag the last one left: its processes then (stock's workers left out), and what it ended. */
interface Survey {
	rows: TaggedProcess[];
	ended: LeftProcess[];
}

interface TagEntry {
	record: TagRecord;
	state: TagState;
	/** The tab's omp now, for the memory record's title. */
	pid?: number;
	/** Set only after a close or launch sweep started ending this tag. Unset for a tab still due to restore. */
	releasedBy?: "closed" | "relaunch";
	/** This launch's look at what the last launch left for the tag (`#survey`), once started. */
	survey?: Promise<Survey>;
	/** When a tab of this launch took the tag over. */
	takenAt?: number;
}

/** A tab's hold on its tag. */
export interface SessionProcessHandle {
	readonly tag: string;
	/** The tab's scratch folder, named by its tag (session-scratch.ts); absent where none is kept. */
	readonly scratch?: string;
	/** The tab moved: another folder, another session file. */
	update(facts: Partial<SessionProcessFacts>): void;
	/** The tab's omp now (undefined: none runs). */
	setPid(pid: number | undefined): void;
	/** The tab is gone and its omp has exited: end what it left running. Nothing is ended during a quit. */
	close(): Promise<void>;
	/**
	 * What the session's commands left running across the relaunch, for the tab that took its tag over: each process
	 * with no parent among them and each whose output path is closed, by name, never arguments; and what the launch
	 * ended (only with the switch on). Undefined for a tab that took nothing over, or when nothing was left.
	 */
	leftover(): Promise<LeftProcesses | undefined>;
}

/** A tag and whose it is, for the memory record. */
export interface TagOwner extends SessionProcessFacts {
	tag: string;
	pid?: number;
}

export type SessionProcessLogDetails = Record<string, string | number | boolean>;

export interface SessionProcessesDeps {
	/** A quit is underway: its tab closes end nothing, and the tags stay in the file for the next launch. */
	frozen(): boolean;
	log(message: string, details: SessionProcessLogDetails): void;
	/** Ends the processes of `tags` (default: the core's `procs.end`). */
	end?(tags: readonly string[]): Promise<EndResult>;
	/** `tags`' processes in detail, the CPU of those with a closed output path over `sampleMs` (default: `procs.list`). */
	survey?(tags: readonly string[], sampleMs?: number): Promise<TaggedProcess[]>;
	/** Ends just these processes of `tags`, each by its id and start (default: `procs.end` with `only`). */
	endOnly?(tags: readonly string[], only: ReadonlyArray<{ pid: number; startedMs: number }>): Promise<EndResult>;
	/**
	 * Whether a launch ends a kept session's process whose output's other end is closed and that keeps spinning
	 * (default: on; index.ts reads the hidden pref `endSpinningOnClosedOutput`, which only a stored `false` turns off).
	 */
	endSpinning?(): boolean;
	/** A new tag (default: 16 random bytes as hex). */
	newTag?(): string;
	now?(): number;
	/** Runs `run` after `ms` (default: an unref'd timer). */
	later?(run: () => void, ms: number): void;
	/** The folder each tag gets for its tab's throwaway files, and which sessions it served. */
	scratch?: Pick<SessionScratch, "open" | "session">;
}

/** What the launch's sweep keeps. */
export interface SweepOptions {
	/** Session files of this computer's own tabs that come back: the restored layouts and the markers of interrupted work. */
	keep: ReadonlySet<string>;
	/** Whether a tab this computer runs for a paired device holds the session now. */
	hostedHeld(sessionPath: string): boolean;
	/** How long a device has to come back for its tab (`HOST_TAB_GRACE_MS`): its session's processes wait as long. */
	hostedGraceMs: number;
}

/** A session file as a key: Windows names the same file in either case and with either slash. */
function sessionKey(path: string): string {
	const normal = normalize(path);
	return process.platform === "win32" ? normal.toLowerCase() : normal;
}

/** `node×3, chrome×5`, the most frequent first, at most six names. */
function nameCounts(processes: ReadonlyArray<{ name: string }>): string {
	const counts = new Map<string, number>();
	for (const { name } of processes) counts.set(name, (counts.get(name) ?? 0) + 1);
	return [...counts]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 6)
		.map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
		.join(", ");
}

export class SessionProcesses {
	readonly #file: string;
	readonly #deps: SessionProcessesDeps;
	readonly #end: (tags: readonly string[]) => Promise<EndResult>;
	readonly #survey: (tags: readonly string[], sampleMs?: number) => Promise<TaggedProcess[]>;
	readonly #endOnly: (
		tags: readonly string[],
		only: ReadonlyArray<{ pid: number; startedMs: number }>,
	) => Promise<EndResult>;
	readonly #newTag: () => string;
	readonly #now: () => number;
	readonly #later: (run: () => void, ms: number) => void;
	readonly #entries = new Map<string, TagEntry>();
	/** Ends under way; `settled()` waits for them. */
	readonly #ending = new Set<Promise<void>>();
	#cancelWrite: (() => void) | null = null;

	constructor(file: string, deps: SessionProcessesDeps) {
		this.#file = file;
		this.#deps = deps;
		this.#end = deps.end ?? endTaggedProcesses;
		this.#survey = deps.survey ?? surveyTaggedProcesses;
		this.#endOnly = deps.endOnly ?? endTaggedProcesses;
		this.#newTag = deps.newTag ?? (() => randomBytes(16).toString("hex"));
		this.#now = deps.now ?? Date.now;
		this.#later = deps.later ?? ((run, ms) => void setTimeout(run, ms).unref());
		for (const record of this.#read()) this.#entries.set(record.tag, { record, state: "left" });
	}

	/**
	 * A tab's first omp is about to start: its tag. A tab back on the session the last launch left a tag for takes
	 * that tag over, so what the session started before the relaunch is still its own; any other tab gets a new one.
	 * A tag whose processes are being ended is never taken over (a session reopened while its closed tab's leftovers
	 * are still going down starts clean).
	 */
	open(facts: SessionProcessFacts): SessionProcessHandle {
		const key = facts.sessionPath === undefined ? undefined : sessionKey(facts.sessionPath);
		let entry = key === undefined ? undefined : this.#left(key, facts.device)[0];
		if (entry) {
			entry.state = "live";
			entry.releasedBy = undefined;
			entry.record = { ...entry.record, ...facts };
			entry.takenAt = this.#now();
		} else {
			entry = { record: { tag: this.#newTag(), ...facts, since: this.#now() }, state: "live" };
			this.#entries.set(entry.record.tag, entry);
		}
		this.#save();
		const held = entry;
		const scratch = this.#deps.scratch?.open(held.record.tag, facts.sessionPath) ?? undefined;
		return {
			tag: held.record.tag,
			...(scratch !== undefined ? { scratch } : {}),
			update: next => {
				if (held.state !== "live") return;
				if (next.sessionPath !== undefined) this.#deps.scratch?.session(held.record.tag, next.sessionPath);
				const record = { ...held.record, ...next };
				if (
					record.cwd === held.record.cwd &&
					record.sessionPath === held.record.sessionPath &&
					record.device === held.record.device
				)
					return;
				held.record = record;
				this.#save();
			},
			setPid: pid => {
				held.pid = pid;
			},
			close: () => {
				held.pid = undefined;
				if (held.state !== "live" || this.#deps.frozen()) return Promise.resolve();
				return this.#endEntry(held, "closed");
			},
			leftover: () => this.#leftover(held),
		};
	}

	/**
	 * A tab on `sessionPath` was released: what the last launch left for the session and no tab took over ends with
	 * it (a restored tab closed before it ever started its omp; a tag an earlier close could not end).
	 */
	sessionReleased(sessionPath: string): void {
		if (this.#deps.frozen()) return;
		for (const entry of this.#left(sessionKey(sessionPath), undefined)) void this.#endEntry(entry, "closed");
	}

	/**
	 * Once the launch's tabs are known: ends the processes of every tag the last launch left whose session did not come
	 * back. A tag kept here waits for its tab to start (`open`), for the tab's close (`sessionReleased`), or for the next
	 * launch. A hosted session's device may still be reconnecting, so its tag gets the host tab's own grace first. Of
	 * every tag kept, what lost the reader of its output is reported (`#surveyAll`).
	 */
	async sweep(options: SweepOptions): Promise<void> {
		const keep = new Set([...options.keep].map(sessionKey));
		const now: TagEntry[] = [];
		const kept: TagEntry[] = [];
		let hosted = false;
		for (const entry of this.#entries.values()) {
			// A restored tab that started before the sweep already took its tag over.
			if (entry.state === "live" && entry.takenAt !== undefined) kept.push(entry);
			if (entry.state !== "left") continue;
			const { sessionPath, device } = entry.record;
			if (device !== undefined) hosted = true;
			if (device === undefined && (sessionPath === undefined || !keep.has(sessionKey(sessionPath)))) now.push(entry);
			else kept.push(entry);
		}
		if (hosted) {
			this.#later(() => {
				if (this.#deps.frozen()) return;
				for (const entry of this.#entries.values()) {
					const { sessionPath, device } = entry.record;
					if (entry.state !== "left" || device === undefined) continue;
					if (sessionPath !== undefined && options.hostedHeld(sessionPath)) continue;
					void this.#endEntry(entry, "relaunch");
				}
			}, options.hostedGraceMs);
		}
		await Promise.all([...now.map(entry => this.#endEntry(entry, "relaunch")), this.#surveyAll(kept)]);
	}

	/** Retry only known releases. A restored or hosted tab waiting to open has no releasedBy. */
	async retryReleased(): Promise<void> {
		if (this.#deps.frozen()) return;
		const pending: Promise<void>[] = [];
		for (const entry of this.#entries.values()) {
			if (entry.state === "left" && entry.releasedBy) pending.push(this.#endEntry(entry, entry.releasedBy));
		}
		await Promise.all(pending);
	}

	/** Scratch stays in use until the core confirms the tag is gone, including while its end is in flight. */
	held(): Set<string> {
		return new Set(this.#entries.keys());
	}

	/** Every tag this app knows and whose it is. */
	owners(): TagOwner[] {
		return [...this.#entries.values()].map(({ record, pid }) => ({
			tag: record.tag,
			cwd: record.cwd,
			...(record.sessionPath !== undefined ? { sessionPath: record.sessionPath } : {}),
			...(record.device !== undefined ? { device: record.device } : {}),
			...(pid !== undefined ? { pid } : {}),
		}));
	}

	/**
	 * What each live session holds now (after Orca's resource usage, `status-bar/resources/*`, FB100/FS101): its
	 * processes, its omp first, from one listing, the largest session first. Null when the core cannot list in time.
	 */
	async use(list: () => Promise<TaggedProcess[] | null> = listTaggedProcesses): Promise<SessionUse[] | null> {
		const rows = await list();
		if (!rows) return null;
		const byTag = new Map<string, TaggedProcess[]>();
		for (const row of rows) {
			if (!row.tag || this.#entries.get(row.tag)?.state !== "live") continue;
			byTag.set(row.tag, [...(byTag.get(row.tag) ?? []), row]);
		}
		const use: SessionUse[] = [];
		for (const [tag, processes] of byTag) {
			const entry = this.#entries.get(tag);
			if (!entry) continue;
			const { record, pid } = entry;
			const listed = processes
				.map(row => ({
					pid: row.pid,
					name: row.name,
					bytes: row.bytes,
					...(row.startedMs !== undefined ? { startedMs: row.startedMs } : {}),
					omp: row.pid === pid,
				}))
				.sort((a, b) => Number(b.omp) - Number(a.omp) || b.bytes - a.bytes);
			use.push({
				...(pid !== undefined ? { ompPid: pid } : {}),
				cwd: record.cwd,
				...(record.sessionPath !== undefined ? { sessionPath: record.sessionPath } : {}),
				...(record.device !== undefined ? { device: record.device } : {}),
				bytes: listed.reduce((sum, row) => sum + row.bytes, 0),
				processes: listed,
			});
		}
		return use.sort((a, b) => b.bytes - a.bytes);
	}

	/**
	 * The person's Stop on one process of a live session (the session whose omp is `ompPid`), never that omp itself:
	 * ended by pid and start, so a pid the OS gave a later process is never touched; stock's own workers are kept.
	 */
	async endProcess(ompPid: number, pid: number, startedMs: number): Promise<boolean> {
		if (pid === ompPid) return false;
		const entry = [...this.#entries.values()].find(candidate => candidate.pid === ompPid);
		if (entry?.state !== "live") return false;
		try {
			const result = await this.#endOnly([entry.record.tag], [{ pid, startedMs }]);
			return result.ended.some(ended => ended.pid === pid);
		} catch {
			return false;
		}
	}

	/** Resolves once every end under way has settled (tests). */
	async settled(): Promise<void> {
		while (this.#ending.size > 0) await Promise.all([...this.#ending]);
	}

	/** The tags the last launch left for this session, not yet taken over. */
	#left(key: string, device: string | undefined): TagEntry[] {
		return [...this.#entries.values()].filter(({ state, record }) => {
			if (state !== "left" || record.sessionPath === undefined || sessionKey(record.sessionPath) !== key)
				return false;
			return (record.device !== undefined) === (device !== undefined);
		});
	}

	/**
	 * Ends what carries the entry's tag and forgets the tag. The entry stays in the file until the core answered, so a
	 * crash meanwhile leaves it for the next launch; a failed end puts it back as left for the same reason, and so does
	 * one that left something running. One short retry gives a stock worker time to exit; disk care retries survivors.
	 */
	#endEntry(entry: TagEntry, reason: "closed" | "relaunch"): Promise<void> {
		const first = entry.releasedBy === undefined;
		entry.releasedBy = reason;
		entry.state = "ending";
		const { record } = entry;
		const run = (async () => {
			let result: EndResult;
			try {
				result = await this.#end([record.tag]);
			} catch (error) {
				entry.state = "left";
				this.#deps.log("not ended", {
					level: "warn",
					reason,
					...this.#whose(record),
					error: error instanceof Error ? error.message : String(error),
				});
				return;
			}
			if (result.kept.length > 0 || result.left.length > 0) {
				entry.state = "left";
				if (first) {
					this.#later(() => {
						if (entry.record === record && entry.state === "left" && !this.#deps.frozen()) {
							void this.#endEntry(entry, reason);
						}
					}, RETRY_REMAINING_MS);
				}
			} else {
				this.#entries.delete(record.tag);
				this.#save();
			}
			if (result.own.length > 0) {
				this.#deps.log("refused: OMPdesk itself runs under this session's tag", {
					level: "warn",
					reason,
					...this.#whose(record),
				});
				return;
			}
			// A session that left nothing writes nothing: most closes.
			if (result.ended.length === 0 && result.left.length === 0) return;
			this.#deps.log("ended", {
				level: result.left.length > 0 ? "warn" : "info",
				reason,
				...this.#whose(record),
				processes: result.ended.length,
				forced: result.ended.filter(process => process.forced).length,
				mb: Math.round(result.ended.reduce((sum, process) => sum + process.bytes, 0) / 1024 ** 2),
				names: nameCounts(result.ended),
				...(result.left.length > 0 ? { left: result.left.length, leftNames: nameCounts(result.left) } : {}),
				...(result.kept.length > 0 ? { kept: result.kept.length } : {}),
			});
		})();
		this.#ending.add(run);
		void run.finally(() => this.#ending.delete(run));
		return run;
	}

	#whose(record: TagRecord): SessionProcessLogDetails {
		return {
			folder: record.cwd,
			...(record.sessionPath !== undefined ? { session: basename(record.sessionPath) } : {}),
			...(record.device !== undefined ? { device: record.device } : {}),
		};
	}

	/**
	 * Looks once at what the last launch left for `entries`' tags (one listing for all, the CPU of those whose output
	 * path is closed measured over `SPIN_SAMPLE_MS`) and reports per tag whose output path is closed; with the switch on,
	 * ends those of them spinning whose other end is seen closed. An entry looked at already is not looked at again.
	 */
	#surveyAll(entries: readonly TagEntry[]): Promise<void> {
		const fresh = entries.filter(entry => entry.survey === undefined);
		if (fresh.length > 0) {
			const listed = this.#survey(
				fresh.map(entry => entry.record.tag),
				SPIN_SAMPLE_MS,
			).catch((error: unknown) => {
				this.#deps.log("not surveyed", {
					level: "warn",
					error: error instanceof Error ? error.message : String(error),
				});
				return [];
			});
			for (const entry of fresh) {
				entry.survey = listed.then(rows =>
					this.#surveyed(
						entry,
						rows.filter(row => row.tag === entry.record.tag && !row.stock),
					),
				);
			}
		}
		const run = Promise.all(entries.map(entry => entry.survey)).then(() => undefined);
		this.#ending.add(run);
		void run.finally(() => this.#ending.delete(run));
		return run;
	}

	async #surveyed(entry: TagEntry, rows: TaggedProcess[]): Promise<Survey> {
		const deaf = rows.filter(row => row.outputClosed !== undefined);
		if (deaf.length === 0) return { rows, ended: [] };
		const { record } = entry;
		const spinning = deaf.filter(row => (row.cpuPercent ?? 0) >= SPIN_PERCENT);
		this.#deps.log("output path closed", {
			level: "warn",
			...this.#whose(record),
			processes: deaf.length,
			spinning: spinning.length,
			found: JSON.stringify(
				[...spinning, ...deaf.filter(row => !spinning.includes(row))]
					.slice(0, FOUND_MAX)
					.map(row => this.#described(record, row)),
			),
		});
		// A path closed by the process's own shutdown(SHUT_WR), or one whose other end is unknown, has maybe a live
		// reader: only a peer seen closed counts, and only a process that keeps spinning in every sample.
		const candidates = spinning.filter(row => row.startedMs !== undefined && row.outputClosed === "closed");
		if (!(this.#deps.endSpinning?.() ?? true) || candidates.length === 0 || this.#deps.frozen())
			return { rows, ended: [] };
		const kept = await this.#keptSpinning(record.tag, candidates);
		if (kept.length === 0 || this.#deps.frozen() || !(this.#deps.endSpinning?.() ?? true)) return { rows, ended: [] };
		let result: EndResult;
		try {
			// The core ends each only while its pid still names the process that started then.
			result = await this.#endOnly(
				[record.tag],
				kept.map(({ row }) => ({ pid: row.pid, startedMs: row.startedMs as number })),
			);
		} catch (error) {
			this.#deps.log("not ended", {
				level: "warn",
				reason: REASON_SPINNING,
				...this.#whose(record),
				error: error instanceof Error ? error.message : String(error),
			});
			return { rows, ended: [] };
		}
		const gone = new Set(result.ended.map(process => process.pid));
		const ended = kept.filter(({ row }) => gone.has(row.pid));
		if (ended.length > 0) {
			this.#deps.log("ended", {
				level: "info",
				reason: REASON_SPINNING,
				...this.#whose(record),
				processes: ended.length,
				forced: result.ended.filter(process => process.forced).length,
				found: JSON.stringify(ended.map(({ row, percents }) => this.#described(record, row, percents))),
			});
		}
		return {
			rows: rows.filter(row => !gone.has(row.pid)),
			ended: ended.map(({ row, percents }) => this.#described(record, row, percents)),
		};
	}

	/**
	 * Of `candidates` (each spinning in the first sample), those that spin in each of the `SPIN_SAMPLES - 1` samples
	 * after it, `SPIN_SAMPLE_GAP_MS` apart, with their output path still closed and its other end closed, under the same
	 * pid and start; with every share of a core measured. A quit or a failed look ends the watch with none.
	 */
	async #keptSpinning(
		tag: string,
		candidates: readonly TaggedProcess[],
	): Promise<Array<{ row: TaggedProcess; percents: number[] }>> {
		let watched = candidates.map(row => ({ row, percents: [row.cpuPercent ?? 0] }));
		for (let sample = 1; sample < SPIN_SAMPLES && watched.length > 0; sample++) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#later(resolve, SPIN_SAMPLE_GAP_MS - SPIN_SAMPLE_MS);
			await promise;
			if (this.#deps.frozen()) return [];
			let rows: TaggedProcess[];
			try {
				rows = await this.#survey([tag], SPIN_SAMPLE_MS);
			} catch {
				return [];
			}
			watched = watched.flatMap(({ row, percents }) => {
				const now = rows.find(
					next =>
						next.pid === row.pid &&
						next.startedMs === row.startedMs &&
						next.outputClosed === "closed" &&
						(next.cpuPercent ?? 0) >= SPIN_PERCENT,
				);
				return now ? [{ row, percents: [...percents, now.cpuPercent ?? 0] }] : [];
			});
		}
		return watched;
	}

	/**
	 * A process as the session and the log name it: never its arguments, its folder only inside the session's own;
	 * `percents` are the shares of a core of every sample that kept it spinning, when it was watched over them.
	 */
	#described(record: TagRecord, row: TaggedProcess, percents?: readonly number[]): LeftProcess {
		const inside = row.cwd === undefined ? undefined : relative(record.cwd, row.cwd);
		return {
			pid: row.pid,
			name: row.name,
			...(row.startedMs !== undefined ? { started: new Date(row.startedMs).toISOString() } : {}),
			...(inside === undefined
				? {}
				: inside.startsWith("..") || isAbsolute(inside)
					? { outside: true as const }
					: { folder: inside === "" ? "." : inside }),
			...(row.ports?.length ? { ports: row.ports } : {}),
			...(row.outputClosed !== undefined ? { outputClosed: row.outputClosed } : {}),
			...(row.cpuPercent !== undefined
				? {
						cpu: { percent: row.cpuPercent, seconds: SPIN_SAMPLE_MS / 1000 },
						...(row.cpuPercent >= SPIN_PERCENT ? { spinning: true as const } : {}),
					}
				: {}),
			...(percents && percents.length > 1
				? { sustained: { percents: [...percents], seconds: ((percents.length - 1) * SPIN_SAMPLE_GAP_MS) / 1000 } }
				: {}),
		};
	}

	/**
	 * What the last launch left for a tag this tab took over, from the launch's look at it: the processes with no parent
	 * among them and those whose output path is closed, leaving out the tab's own omp and what started after the
	 * takeover; and what the launch ended.
	 */
	async #leftover(entry: TagEntry): Promise<LeftProcesses | undefined> {
		const takenAt = entry.takenAt;
		if (takenAt === undefined) return undefined;
		await this.#surveyAll([entry]);
		const survey = await entry.survey;
		if (!survey) return undefined;
		const own = new Set<number>(entry.pid === undefined ? [] : [entry.pid]);
		for (let grew = true; grew; ) {
			grew = false;
			for (const row of survey.rows) {
				if (own.has(row.ppid) && !own.has(row.pid)) {
					own.add(row.pid);
					grew = true;
				}
			}
		}
		const old = survey.rows.filter(
			row => !own.has(row.pid) && row.startedMs !== undefined && row.startedMs < takenAt,
		);
		const pids = new Set(old.map(row => row.pid));
		// Windows' console host under a console program is the program's, never a command of the session's own.
		const running = old
			.filter(
				row => (row.outputClosed !== undefined || !pids.has(row.ppid)) && row.name.toLowerCase() !== "conhost.exe",
			)
			.map(row => this.#described(entry.record, row));
		const ended = survey.ended;
		return running.length > 0 || ended.length > 0 ? { running, ended } : undefined;
	}

	#read(): TagRecord[] {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.#file, "utf8"));
			const tags = typeof parsed === "object" && parsed !== null && "tags" in parsed ? parsed.tags : undefined;
			if (!Array.isArray(tags)) return [];
			return tags.flatMap((value: unknown) => {
				const record = TagRecordSchema.safeParse(value);
				return record.success ? [record.data] : [];
			});
		} catch {
			return [];
		}
	}

	#save(): void {
		this.#cancelWrite?.();
		const tags = [...this.#entries.values()].map(entry => entry.record);
		this.#cancelWrite = writeFileAtomicDeferred(this.#file, `${JSON.stringify({ tags })}\n`, { mode: 0o600 }, error =>
			this.#deps.log("tags not saved", { level: "warn", error: String(error) }),
		);
	}
}
