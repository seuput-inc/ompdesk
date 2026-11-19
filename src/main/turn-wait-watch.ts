/**
 * A turn sat for 18 hours and nothing said what it waited on. A tab with work on, or with a wait held for it, that
 * made no step for `WAIT_REPORT_MS` leaves one `gui-runtime.jsonl` line (source `turn-wait`) naming what it waits
 * on, and one more each time that wait has doubled. Observation only: nothing is stopped, retried or woken.
 *
 * A step is what the pool announces as one (`TabActivity` `step`: a tool call started or ended, a reply was written)
 * or a question answered. A run that starts or ends is none, and a run that failed made none: a retry that fails
 * every ten minutes for a day is one wait. A tab this computer runs for a paired device announces no steps here, so
 * only its held waits are read, never its running turn.
 */
import { basename } from "node:path";
import type { IpcScheduledRetry } from "../shared/ipc-types";
import type { TabActivity } from "./sidecar-pool";
import type { ResumeFact } from "./turn-resume";

type Details = Record<string, string | number | boolean>;

/** A tab without a step this long is written; then at twice, four times, eight times this. */
export const WAIT_REPORT_MS = 10 * 60_000;
/** How often the tabs are looked at. */
export const WAIT_SWEEP_MS = 60_000;
/** The end of a session's journal read for its open tool calls: a reply with a large file in a call's arguments. */
export const WAIT_JOURNAL_LINES = 400;
export const WAIT_JOURNAL_BYTES = 1024 * 1024;
const ERROR_CHARS = 300;
const TOOLS_NAMED = 8;

export type WaitFact = Pick<
	ResumeFact,
	| "tabId"
	| "device"
	| "peer"
	| "sessionFile"
	| "running"
	| "settling"
	| "awaitingUi"
	| "awaitingConnection"
	| "retry"
	| "lastRun"
>;

export type WaitOn = "ask" | "connection" | "limit" | "retry" | "stock-retry" | "resuming" | "background" | "turn";

/** Everything the tab waits on, the most telling first; empty for a tab that waits for nothing. */
export function waitsOn(fact: WaitFact, retry: IpcScheduledRetry | undefined, resuming: boolean): WaitOn[] {
	const on: WaitOn[] = [];
	if (fact.awaitingUi) on.push("ask");
	if (fact.awaitingConnection) on.push("connection");
	if (retry) on.push(retry.limit ? "limit" : "retry");
	if (fact.retry) on.push("stock-retry");
	if (resuming) on.push("resuming");
	if (fact.running && !fact.peer) on.push(fact.settling ? "background" : "turn");
	return on;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * What a session's journal ends on: the tool calls of its last reply that have no result yet (`tools`, since
 * `toolsMs`), and its last message (`journal`, `journalMs` ago). Names only, never a call's arguments.
 */
export function journalWait(lines: readonly string[], now: number): Details {
	let calls = new Map<string, string>();
	let callsAt: number | undefined;
	let last: { kind: string; at: number | undefined } | undefined;
	for (const line of lines) {
		let entry: Record<string, unknown> | null = null;
		try {
			entry = record(JSON.parse(line));
		} catch {
			// The tail's first line can start inside an entry.
		}
		const message = record(entry?.message);
		if (entry?.type !== "message" || !message) continue;
		const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		const at = Number.isFinite(time) ? time : undefined;
		const { role, stopReason, content, toolCallId } = message;
		last = { kind: [role, stopReason].filter(part => typeof part === "string").join("/"), at };
		if (role === "toolResult") {
			if (typeof toolCallId === "string") calls.delete(toolCallId);
			continue;
		}
		// A reply opens its own calls, and a prompt a new turn: what an older reply called is over either way.
		calls = new Map();
		callsAt = at;
		if (role !== "assistant" || !Array.isArray(content)) continue;
		for (const block of content) {
			const call = record(block);
			if (call?.type === "toolCall" && typeof call.id === "string" && typeof call.name === "string")
				calls.set(call.id, call.name);
		}
	}
	return {
		...(calls.size > 0 ? { tools: [...calls.values()].slice(0, TOOLS_NAMED).join(", ") } : {}),
		...(calls.size > 0 && callsAt !== undefined ? { toolsMs: now - callsAt } : {}),
		...(last ? { journal: last.kind } : {}),
		...(last?.at !== undefined ? { journalMs: now - last.at } : {}),
	};
}

/** `SidecarPool.settleFacts`' answer under the line's own flat keys (the log keeps no nested value). */
const STOCK_KEYS: ReadonlyArray<[string, string]> = [
	["isStreaming", "streaming"],
	["isCompacting", "compacting"],
	["queuedMessageCount", "queued"],
	["hasPendingAsyncWork", "asyncWork"],
	["isSettled", "settled"],
	["messageCount", "messages"],
];

function ompDetails(facts: Record<string, unknown>): Details {
	if (facts.gone === true) return { omp: "no window tab" };
	const details: Details = { omp: "answered" };
	if (typeof facts.status === "string") details.status = facts.status;
	const stock = record(facts.stock);
	for (const [key, name] of STOCK_KEYS) {
		const value = stock?.[key];
		if (typeof value === "boolean" || typeof value === "number") details[name] = value;
	}
	return details;
}

export interface TurnWaitDeps {
	/** Every tab's facts, as the resume rules read them (`resumeFacts`). */
	tabs(): readonly WaitFact[];
	/** What the tab's omp answers now (`SidecarPool.settleFacts`); a rejection is an omp that did not answer. */
	facts(tabId: string): Promise<Record<string, unknown>>;
	/** The tab's own reading of its omp (`starting`, `restarting`, `error`), told for an omp that did not answer. */
	status(tabId: string): string | undefined;
	/** The last lines of a session's journal. */
	journal(sessionFile: string): Promise<string[]>;
	log(details: Details): void;
	now?: () => number;
	reportMs?: number;
}

interface Wait {
	since: number;
	/** Of the wait, how long the sweeps stood still: the computer slept. */
	asleepMs: number;
	/** The awake wait at which the next line is due. */
	nextMs: number;
	reports: number;
	/** A step since the last sweep, unless its run then failed. */
	steppedAt?: number;
}

export class TurnWaitWatch {
	readonly #deps: TurnWaitDeps;
	readonly #now: () => number;
	readonly #reportMs: number;
	readonly #waits = new Map<string, Wait>();
	readonly #retries = new Map<string, IpcScheduledRetry>();
	readonly #resuming = new Set<string>();
	#sweptAt: number | null = null;

	constructor(deps: TurnWaitDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#reportMs = deps.reportMs ?? WAIT_REPORT_MS;
	}

	/** The retry `TurnResume` armed for the tab (a backoff or a provider's limit), or that it holds none now. */
	noteRetry(tabId: string, retry: IpcScheduledRetry | undefined): void {
		if (retry) this.#retries.set(tabId, retry);
		else this.#retries.delete(tabId);
	}

	/** The tab's relaunch continuation waits for its omp, or no longer does. */
	noteResuming(tabId: string, resuming: boolean): void {
		if (resuming) this.#resuming.add(tabId);
		else this.#resuming.delete(tabId);
	}

	/** What the pool announces of its tabs (`SidecarPool.observeTabs`). */
	activity(activity: TabActivity): void {
		if (activity.type === "released") {
			this.#waits.delete(activity.tabId);
			this.#retries.delete(activity.tabId);
			this.#resuming.delete(activity.tabId);
			return;
		}
		const wait = this.#waits.get(activity.tabId);
		if (!wait) return;
		if (activity.type === "step" || activity.type === "askClosed") wait.steppedAt = this.#now();
		// The failed reply's end was announced as a step: the run got nowhere.
		else if (activity.type === "idle" && activity.outcome?.stopReason === "error") wait.steppedAt = undefined;
	}

	/** One look at every tab (each `WAIT_SWEEP_MS`): a wait begins, goes on, is written, or is over. */
	sweep(): void {
		const now = this.#now();
		const gap = this.#sweptAt === null ? 0 : now - this.#sweptAt;
		this.#sweptAt = now;
		// The looks come a minute apart: a far longer gap is the computer asleep, which the line tells apart.
		const asleepMs = gap > WAIT_SWEEP_MS * 3 ? gap - WAIT_SWEEP_MS : 0;
		let facts: readonly WaitFact[];
		try {
			facts = this.#deps.tabs();
		} catch {
			// The core is gone (the quit, a loss): the next look reads again.
			return;
		}
		const waiting = new Set<string>();
		for (const fact of facts) {
			// A paired host's tab: the host holds its turn and writes its waits.
			if (fact.device) continue;
			const retry = this.#retries.get(fact.tabId);
			const on = waitsOn(fact, retry, this.#resuming.has(fact.tabId)).join(",");
			if (!on) continue;
			waiting.add(fact.tabId);
			const wait = this.#waits.get(fact.tabId);
			if (!wait || wait.steppedAt !== undefined) {
				const since = wait?.steppedAt ?? now;
				this.#waits.set(fact.tabId, { since, asleepMs: 0, nextMs: this.#reportMs, reports: 0 });
				continue;
			}
			wait.asleepMs += asleepMs;
			if (now - wait.since - wait.asleepMs < wait.nextMs) continue;
			wait.nextMs *= 2;
			wait.reports++;
			void this.#report(fact, on, retry, wait, now);
		}
		for (const tabId of [...this.#waits.keys()]) if (!waiting.has(tabId)) this.#waits.delete(tabId);
	}

	async #report(
		fact: WaitFact,
		on: string,
		retry: IpcScheduledRetry | undefined,
		wait: Wait,
		now: number,
	): Promise<void> {
		const { since, asleepMs, reports } = wait;
		const [omp, journal] = await Promise.all([
			this.#deps.facts(fact.tabId).then(ompDetails, (error: unknown): Details => {
				const status = this.#deps.status(fact.tabId);
				return {
					omp: `no answer: ${error instanceof Error ? error.message : String(error)}`,
					...(status ? { status } : {}),
				};
			}),
			fact.sessionFile
				? this.#deps.journal(fact.sessionFile).then(
						lines => journalWait(lines, now),
						(): Details => ({}),
					)
				: {},
		]);
		// It stepped, ended or closed while its omp was asked: nothing waits any more.
		if (this.#waits.get(fact.tabId) !== wait || wait.steppedAt !== undefined) return;
		const error = fact.lastRun?.errorMessage;
		// The keys every line has first: the log keeps a line's first 24.
		this.#deps.log({
			tab: fact.tabId,
			...(fact.sessionFile ? { session: basename(fact.sessionFile) } : {}),
			on,
			waitedMs: now - since,
			report: reports,
			...(asleepMs > 0 ? { asleepMs } : {}),
			...(fact.peer ? { peer: true } : {}),
			...(retry ? { retryAt: new Date(retry.at).toISOString(), attempt: retry.attempt } : {}),
			...(fact.lastRun ? { lastStop: fact.lastRun.stopReason } : {}),
			...(error ? { lastError: error.length > ERROR_CHARS ? `${error.slice(0, ERROR_CHARS)}…` : error } : {}),
			...journal,
			...omp,
		});
	}
}
