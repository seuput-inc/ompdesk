/**
 * Main's synchronous connection to the core's hub (`native/ompdesk/crates/core/src/hub`): the pool and turn resume run
 * there, and main's code reads and changes them in the same tick it always did, so main's thread waits for each call.
 *
 * A worker thread holds the socket (a pipe on Windows) and keeps every line the hub sends, in order. Main posts a
 * request to the worker and blocks on `Atomics.wait` until the worker has the call's answer, or a question the hub asks
 * synchronously (`sync: true`), which main answers at once and then waits again: a rule in the core can suspend on
 * main (a sidecar it starts emits as it starts, a hook runs) and the nested calls that causes are answered meanwhile,
 * as listeners ran inside the TypeScript method. Lines that come while main does not wait (a timer of the core, an
 * answer to a question main answered later) make the worker ping, and main fetches them on its next turn; one
 * consumer, so nothing is reordered.
 *
 * A wait the core leaves silent for {@link HUB_CALL_DEADLINE_MS}, or a wait past {@link HUB_WAIT_LIMIT_MS}, gives up
 * that call only: main's thread is never held longer than the limit per wait, and the caller gets `hub_unknown`,
 * because the request went out before main waited and the core may still carry it out. Its late answer is dropped by
 * its id (and logged); what the core pushed meanwhile reaches main in order, as any line does. Whether the core lives
 * is decided on the worker's thread, by liveness alone: a connection that ends (the core exited), or a core that sends
 * nothing at all, beats included, for {@link HUB_LIVENESS_MS} while a request waits, or whose hub thread beats
 * {@link HUB_LIVENESS_MS} into one job. That is the loss of the hub: every instance is told (`lost`), the core is
 * abandoned, the connection is dropped, and the next call opens a new one to the core then running; an instance
 * re-seeds itself there.
 */
import { Worker } from "node:worker_threads";
import { tookHub } from "../slow-steps";
import { CoreError, core } from "./process";

/**
 * How long the core may stay silent while main waits for one call: no answer, no line, no heartbeat. The hub answers
 * from memory: measured calls take 0.03–0.2 ms, the slowest rule (a 20-tab restore) a few ms. Two seconds of silence
 * is far past any of them, so that call is given up (`hub_unknown`). The core is not ended for it: a starved computer
 * holds a live core silent for seconds (CI, 26 Nov 2026: a 2 s silence abandoned the core under 100 % CPU and cut a
 * session's tool call), and losing the core costs every tab's omp, the stock workers and the shells (the Mac mini,
 * 26 Nov 2026: one stall killed the core and cut 13 running turns). A core whose hub thread sits in one job says so
 * every 250 ms (`busy`, the core's `hub/mod.rs`), and main waits for it up to {@link HUB_WAIT_LIMIT_MS}.
 */
export const HUB_CALL_DEADLINE_MS = 2_000;

/**
 * The longest main's thread waits for one answer: while its worker has not reached the hub (the worker thread starts,
 * and the core may be starting, spawned by this very call; over 2 s on a loaded Windows runner), and while the core
 * says its hub thread is busy. Under the hang watchdog's 5 s, the owner's bound on any wait of main's thread; the call
 * is given up past it.
 */
export const HUB_WAIT_LIMIT_MS = 4_000;

/** How often main's blocked thread looks whether the core is still sending (the core beats every 250 ms). */
const HUB_SLICE_MS = 250;

/**
 * How long a core may send nothing at all (no answer, no item, no beat) while a request of main's waits, or keep its
 * hub thread in one job, before it counts as dead: abandoned, killed and started again. Judged on the worker's thread
 * with the real clock, never by a call main gave up.
 */
export const HUB_LIVENESS_MS = 10_000;

/**
 * A request the core has left unanswered this long, with nothing else from the core meanwhile, makes the worker send a
 * `hub.sync` of its own: its answer proves the hub thread ran everything before it, so a request still unanswered
 * waits in an async rule of a live core (no more watching), while a core that answers nothing is dead after
 * {@link HUB_LIVENESS_MS}.
 */
const HUB_PING_AFTER_MS = 1_000;

/** The worker's own request ids (its pings), past any main numbers. */
const PING_BASE = 2 ** 52;

/** How many given-up calls are remembered for their late answer's log line. */
const GAVE_UP_KEPT = 64;

/** Control words of the shared buffer: [state, length]; the lines follow at {@link DATA_OFFSET}. */
export const STATE = 0;
export const LENGTH = 1;
/** Set by the worker once its socket reached the hub. */
const CONNECTED = 2;
const IDLE = 0;
const WAITING = 1;
const READY = 2;
/** The worker claimed the hand-over and writes it: main waits for READY (a wait main gave up never sees this). */
const WRITING = 3;
export const DATA_OFFSET = 16;
const INITIAL_BYTES = 1 << 16;
const MAX_BYTES = 1 << 30;

/**
 * The process's own clock, kept from load: a test's fake timers replace `globalThis.performance` (with the faked
 * `Date`'s epoch as its origin), and a lost wait's trace compares main's time with the times the worker writes on its
 * own, unfaked clock (`lossTrace`).
 */
const realPerformance = performance;

const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const net = require("node:net");
const { sab, times: timesBuffer } = workerData;
const times = new Float64Array(timesBuffer);
const control = new Int32Array(sab, 0, 4);
const encoder = new TextEncoder();
const { StringDecoder } = require("node:string_decoder");
let socket = null;
let connecting = false;
let lost = null;
let partial = "";
let lines = [];
/** The id main waits for (null: none), or "drain": hand over what there is. */
let waiting = null;
let pinged = false;
/**
 * Main's requests the core has not answered yet, by id: when each went out (\`callLater\`'s are left out: an async rule
 * may run for minutes, an omp update). While one waits, the core's liveness is watched (\`watchLiveness\`).
 */
const unanswered = new Map();
/** When the oldest of \`unanswered\` began to wait with nothing from the core since (\`times[0]\` moves it on). */
let quietSince = 0;
let watching = null;
/** The worker's own \`hub.sync\` in flight (null: none): its id and when it went out. */
let ping = null;
let pings = ${PING_BASE};
/** The core's last beat: how long its hub thread had sat in one job, and when the beat came. */
let busyMs = 0;
let busyAt = 0;

function wall() {
	return performance.timeOrigin + performance.now();
}

function track(id) {
	if (unanswered.size === 0) quietSince = wall();
	unanswered.set(id, wall());
	watching ??= setInterval(watchLiveness, ${HUB_SLICE_MS});
}

/** Off main's thread: a core that sends nothing, or whose hub thread is held in one job, past the window is dead. */
function watchLiveness() {
	if (unanswered.size === 0 || lost) {
		clearInterval(watching);
		watching = null;
		return;
	}
	// Before the socket reached the hub, the connect's own deadline bounds the wait.
	if (!socket) return;
	const now = wall();
	const quiet = now - Math.max(quietSince, times[0]);
	const held = now - busyAt < ${HUB_SLICE_MS * 4} ? busyMs : 0;
	if (quiet >= ${HUB_LIVENESS_MS} || held >= ${HUB_LIVENESS_MS}) {
		lost =
			quiet >= ${HUB_LIVENESS_MS}
				? "the core sent nothing, beats included, for " + Math.round(quiet) + " ms while " + unanswered.size + " request(s) waited"
				: "the core's hub thread sat " + Math.round(held) + " ms in one job (request " + times[3] + ")";
		look();
		return;
	}
	if (quiet >= ${HUB_PING_AFTER_MS} && ping === null) {
		ping = { id: ++pings, at: now };
		socket.write(JSON.stringify({ id: ping.id, method: "hub.sync", params: {} }) + "\\n");
	}
}

function handOver() {
	// Main may have given up this wait: then it set the state back to idle, and the lines stay for its next look.
	if (Atomics.compareExchange(control, ${STATE}, ${WAITING}, ${WRITING}) !== ${WAITING}) {
		waiting = null;
		pinged = false;
		look();
		return;
	}
	const text = JSON.stringify({ lines, lost });
	lines = [];
	const bytes = encoder.encode(text);
	const need = ${DATA_OFFSET} + bytes.length;
	if (sab.byteLength < need) sab.grow(Math.min(${MAX_BYTES}, Math.max(need, sab.byteLength * 2)));
	new Uint8Array(sab, ${DATA_OFFSET}, bytes.length).set(bytes);
	Atomics.store(control, ${LENGTH}, bytes.length);
	waiting = null;
	pinged = false;
	Atomics.store(control, ${STATE}, ${READY});
	Atomics.notify(control, ${STATE});
}

/** Whether the lines hold what main waits for: its answer and the tick that ends its microtasks, or a question it must answer now. */
function settled() {
	if (waiting === "drain") return true;
	let answered = false;
	for (const line of lines) {
		if (line.id !== undefined && line.id === waiting) answered = true;
		else if (line.tick && answered) return true;
		else if (line.event === "hub.out" && line.data.items.some(item => item.k === "ask" && item.sync === true)) return true;
	}
	return false;
}

function look() {
	if (waiting === null) {
		if ((lines.length > 0 || lost) && !pinged) {
			pinged = true;
			parentPort.postMessage("ping");
		}
		return;
	}
	// A drain hands over at once, even nothing: its ping may be older than a hand-over that already took the lines.
	if (lost || waiting === "drain" || (lines.length > 0 && settled())) handOver();
}

function connect(endpoint, deadline) {
	connecting = true;
	const attempt = () => {
		const candidate = net.connect(endpoint.address);
		candidate.once("connect", () => {
			connecting = false;
			socket = candidate;
			Atomics.store(control, ${CONNECTED}, 1);
			socket.setNoDelay?.(true);
			socket.write(JSON.stringify({ token: endpoint.token }) + "\\n");
			for (const line of queued) socket.write(line);
			queued.length = 0;
		});
		candidate.once("error", error => {
			if (socket === candidate) return;
			if (Date.now() < deadline && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
				setTimeout(attempt, 2);
				return;
			}
			connecting = false;
			lost = "the hub did not accept a connection: " + error.message;
			look();
		});
		// One decoder per connection: a multibyte character split across two chunks stays whole.
		const decoder = new StringDecoder("utf8");
		candidate.on("data", chunk => {
			times[0] = performance.timeOrigin + performance.now();
			partial += decoder.write(chunk);
			let end;
			while ((end = partial.indexOf("\\n")) >= 0) {
				const text = partial.slice(0, end);
				partial = partial.slice(end + 1);
				if (!text) continue;
				const line = JSON.parse(text);
				// A heartbeat: the hub's thread has sat in one job for busy.ms; it keeps main waiting (lossTrace) and the
				// core alive, up to the liveness window.
				if (line.busy) {
					times[2] = line.busy.ms;
					times[3] = line.busy.request;
					busyMs = line.busy.ms;
					busyAt = times[0];
				} else if (ping !== null && line.id === ping.id) {
					// Everything sent before the ping ran: what of it is unanswered waits in an async rule of a live core.
					for (const [id, sent] of unanswered) if (sent <= ping.at) unanswered.delete(id);
					ping = null;
				} else {
					if (line.id !== undefined) unanswered.delete(line.id);
					lines.push(line);
				}
			}
			look();
		});
		candidate.on("close", () => {
			if (socket !== candidate) return;
			lost = lost ?? "the hub's connection ended";
			look();
		});
	};
	attempt();
}

const queued = [];
parentPort.on("message", message => {
	if (message.endpoint && !socket && !connecting) connect(message.endpoint, Date.now() + ${HUB_WAIT_LIMIT_MS});
	if (message.line) {
		if (message.track !== undefined) track(message.track);
		if (socket) socket.write(message.line);
		else queued.push(message.line);
	}
	if (message.wait !== undefined) {
		times[1] = performance.timeOrigin + performance.now();
		times[2] = 0;
		waiting = message.wait;
		look();
	}
	// Main gave up its wait: what comes from now on is fetched on main's next turn, as any line main did not wait for.
	if (message.cancel) {
		waiting = null;
		pinged = false;
		look();
	}
});
`;

interface Line {
	tick?: true;
	id?: number;
	ok?: boolean;
	result?: unknown;
	error?: { code?: string; message?: string };
	event?: string;
	data?: { to: number; items: HubItem[] };
}

/** One thing an instance told main: `k` names it. A question (`k: "ask"`) carries `ask`, `q` and `sync`. */
export interface HubItem {
	k: string;
	[key: string]: unknown;
}

/** What main does with what one instance tells it. */
export interface HubInstanceHandler {
	/** An item the instance pushed, in order. */
	item(item: HubItem): void;
	/**
	 * A question: return the answer, or (only for `sync: false`) a promise of it. A throw answers the error, with its
	 * `code` when it has one.
	 */
	ask(q: string, item: HubItem): unknown;
	/** The hub was lost (the core ended or stopped answering): the instance is gone there. */
	lost(error: CoreError): void;
}

/** Per-call timing of main's blocked waits, for the ledger's measurement (`OMP_GUI_HUB_STATS=1` logs it). */
export interface HubStats {
	calls: number;
	/** Every wait's duration in microseconds, in order (kept only while measuring). */
	waitsUs: number[];
	totalUs: number;
	/** Calls per method (kept only while measuring). */
	methods: Map<string, number>;
}

export class Connection {
	readonly worker: Worker;
	readonly sab: SharedArrayBuffer;
	readonly control: Int32Array;
	readonly generation: number;
	dead: CoreError | null = null;
	/**
	 * Written by the worker (`lossTrace`): [last line from the core, last wait the worker took] as wall times, then the
	 * core's last heartbeat in this wait (0: none): [ms its hub thread had sat in one job, main's request it was].
	 */
	readonly times: Float64Array;

	constructor(endpoint: { address: string; token: string }, generation: number) {
		this.generation = generation;
		this.sab = new SharedArrayBuffer(DATA_OFFSET + INITIAL_BYTES, { maxByteLength: DATA_OFFSET + MAX_BYTES });
		this.control = new Int32Array(this.sab, 0, 4);
		const times = new SharedArrayBuffer(32);
		this.times = new Float64Array(times);
		this.worker = new Worker(WORKER, { eval: true, name: "ompdesk-hub", workerData: { sab: this.sab, times } });
		this.worker.unref();
		this.worker.postMessage({ endpoint });
	}
}

/**
 * Which side of a lost wait was silent, for the `abandoned` line: whether main's worker took the wait at all (a starved
 * worker or a lost message), when the core last sent it a line (a core that stopped answering), and, when the core
 * kept beating, which job its hub thread sat in (the blocking work to move off it).
 */
function lossTrace(times: Float64Array, waitedAt: number, id: number | "drain"): string {
	const [lastLine = 0, lastWait = 0, busyMs = 0, busyRequest = 0] = times;
	const took =
		lastWait >= waitedAt
			? `its thread took the wait after ${Math.round(lastWait - waitedAt)} ms`
			: "its thread never took the wait";
	const line =
		lastLine === 0
			? "the core sent no line yet"
			: lastLine >= waitedAt
				? `the core's last line came ${Math.round(lastLine - waitedAt)} ms into the wait`
				: `the core's last line came ${Math.round(waitedAt - lastLine)} ms before the wait`;
	if (busyMs <= 0) return `${took}; ${line}`;
	const job = busyRequest === id ? "this call" : busyRequest === 0 ? "a job of its own" : `request ${busyRequest}`;
	return `${took}; ${line}; the core's hub thread was ${Math.round(busyMs)} ms into ${job} at its last beat`;
}

function realNow(): number {
	return realPerformance.timeOrigin + realPerformance.now();
}

/** The method a `hub.call` request runs, for the log of a call main gave up. */
function callMethod(params: unknown): string {
	const method = (params as { method?: unknown } | null)?.method;
	return typeof method === "string" ? method : "hub.call";
}

export class Hub {
	#connection: Connection | null = null;
	readonly #instances = new Map<number, HubInstanceHandler>();
	readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	#sequence = 0;
	/** Calls main waits for now (nested ones count): a question answered inside one must not wait itself. */
	#depth = 0;
	/**
	 * The sync calls on main's stack, each with its answer once read: a call nested in another's handling (a question's
	 * answer, a listener) can read the outer call's answer, which the outer call takes when it waits again.
	 */
	readonly #calling = new Map<number, Line | null>();
	/**
	 * Calls main gave up (`hub_unknown`), by id: the core may still answer one, and that answer is dropped here, logged,
	 * and never taken for another call's. The oldest go past {@link GAVE_UP_KEPT}.
	 */
	readonly #gaveUp = new Map<number, { method: string; at: number }>();
	readonly stats: HubStats = { calls: 0, waitsUs: [], totalUs: 0, methods: new Map() };
	measuring = process.env.OMP_GUI_HUB_STATS === "1";
	/** Where the hub listens: the running core's, or a test's that nobody answers. */
	readonly #endpoint: () => { address: string; token: string; generation: number };

	constructor(endpoint = () => core().hubEndpoint()) {
		this.#endpoint = endpoint;
	}

	/** A new instance id, unique in this process (the core keys instances by it); the instance is opened with {@link open}. */
	nextId(): number {
		return ++instanceCount;
	}

	/** Opens instance `id` of `kind` and routes what it says to `handler`. */
	open(id: number, kind: string, opts: unknown, handler: HubInstanceHandler): void {
		this.#instances.set(id, handler);
		try {
			this.#call("hub.open", { id, kind, opts });
		} catch (error) {
			this.#instances.delete(id);
			throw error;
		}
	}

	close(id: number): void {
		if (!this.#instances.delete(id) || !this.#connection || this.#connection.dead) return;
		this.#write({ id: ++this.#sequence, method: "hub.close", params: { id } });
	}

	/**
	 * Returns once main has handled everything the core told it before now: a rule's continuation that already ran in
	 * the core (its check passed, its command written) reaches main first. A path that acts on omp by itself, with no
	 * call into the core, calls this before it acts, as the TypeScript's continuation ran to its send in one tick.
	 */
	barrier(): void {
		this.#call("hub.sync", {});
	}

	/** A synchronous call of instance `to`'s `method`: its value, after every item it made was handled. */
	call<T>(to: number, method: string, params: unknown = {}): T {
		if (this.measuring) this.stats.methods.set(method, (this.stats.methods.get(method) ?? 0) + 1);
		const started = performance.now();
		try {
			return this.#call("hub.call", { to, method, params }) as T;
		} finally {
			// With the items the call made handled: all of it held main's thread.
			tookHub(method, performance.now() - started);
		}
	}

	/**
	 * A call of the instance `instance()` opens or returns: when the hub is lost under it (the core died or stopped
	 * answering), the instance's `lost` handler has run, so `instance()` opens it on the next core and the call is made
	 * once more. Everything the lost core knew is gone, so the second call lands where a call after the loss would:
	 * `params` given as a function is read for each attempt, so what it reads of main (a pool's facts) is read after
	 * the loss and after whatever the new instance's opening changed. A call main gave up (`hub_unknown`) is never made
	 * again: the core it went to lives and may have carried it out.
	 */
	callOnce<T>(instance: () => number, method: string, params: unknown | (() => unknown) = {}): T {
		const read = () => (typeof params === "function" ? (params as () => unknown)() : params);
		try {
			return this.call<T>(instance(), method, read());
		} catch (error) {
			if (!(error instanceof CoreError) || error.code !== "hub_lost") throw error;
			const id = instance();
			return this.call<T>(id, method, read());
		}
	}

	/** A call main does not wait for: what the instance's async rule answers when it is done. */
	callLater<T>(to: number, method: string, params: unknown = {}): Promise<T> {
		const stale = this.#dropStale();
		if (stale) return Promise.reject(stale);
		const connection = this.#connect();
		const id = ++this.#sequence;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#pending.set(id, { resolve, reject });
		this.#post(connection, { id, method: "hub.call", params: { to, method, params } }, false);
		return promise as Promise<T>;
	}

	/** The generation of the connection now in use (a new one after each loss); 0 when none is open. */
	get generation(): number {
		return this.#connection?.generation ?? 0;
	}

	#connect(): Connection {
		const current = this.#connection;
		if (current && !current.dead) return current;
		const endpoint = this.#endpoint();
		const connection = new Connection(endpoint, endpoint.generation);
		connection.worker.on("message", () => this.#drain(connection));
		connection.worker.on("error", error =>
			this.#lose(connection, new CoreError("hub_lost", `the hub's thread failed: ${error.message}`)),
		);
		this.#connection = connection;
		return connection;
	}

	/** Sends a request; `watched`: the core's liveness is watched until it answers (never a `callLater`'s, see the worker). */
	#post(connection: Connection, request: { id: number; method: string; params: unknown }, watched = true): void {
		connection.worker.postMessage({
			line: `${JSON.stringify(request)}\n`,
			...(watched ? { track: request.id } : {}),
		});
	}

	#write(request: { id: number; method: string; params: unknown }): void {
		if (this.#dropStale()) return;
		const connection = this.#connect();
		this.#post(connection, request);
	}

	/**
	 * Loses the connection when the core it reached was abandoned or ended: main knows before the core's socket
	 * closes (the owner kills it on another thread), and nothing main sends may reach it or be answered by it.
	 */
	#dropStale(): CoreError | null {
		const current = this.#connection;
		if (!current || current.dead || current.generation === core().hubEndpointGeneration()) return null;
		this.#lose(current, new CoreError("hub_lost", "the core this hub connection reached was ended"));
		return current.dead ?? null;
	}

	#call(method: string, params: unknown): unknown {
		const stale = this.#dropStale();
		if (stale) throw stale;
		const connection = this.#connect();
		const id = ++this.#sequence;
		this.#post(connection, { id, method, params });
		this.stats.calls++;
		this.#depth++;
		this.#calling.set(id, null);
		try {
			for (;;) {
				let answer = this.#calling.get(id) ?? undefined;
				const after: Line[] = [];
				if (!answer) {
					const lines = this.#wait(connection, id, method === "hub.call" ? callMethod(params) : method);
					if (lines instanceof CoreError) throw lines;
					for (const line of lines) {
						// An outer call's answer is its own now, even behind this one's: the outer call reads it before it
						// waits again, which is before this call's microtasks run.
						if (line.id !== undefined && line.id !== id && this.#calling.has(line.id))
							this.#calling.set(line.id, line);
						else if (answer) after.push(line);
						else if (line.id === id) answer = line;
						else this.#handle(line);
					}
				}
				if (connection.dead) throw connection.dead;
				if (answer) {
					// What the call's own promise continuations made runs as they did: in microtasks after the caller's code.
					if (after.length > 0)
						queueMicrotask(() => {
							for (const line of after) this.#handle(line);
						});
					if (answer.ok) return answer.result;
					throw new CoreError(answer.error?.code ?? "hub_error", answer.error?.message ?? "the hub failed");
				}
			}
		} finally {
			this.#calling.delete(id);
			this.#depth--;
		}
	}

	/**
	 * Waits for the worker's hand-over until the core, once the worker reached it, sent nothing (no line, no heartbeat)
	 * for {@link HUB_CALL_DEADLINE_MS}, or the wait reached {@link HUB_WAIT_LIMIT_MS}: either gives up the call.
	 */
	#block(connection: Connection, waitedAt: number): "ok" | "not-equal" | "silent" | "limit" {
		const { control, times } = connection;
		// Silent since: the wait's start, the worker's last byte from the core, or the last look before it connected.
		let since = waitedAt;
		// Both bounds read main's real clock (`realPerformance`, never a test's fake one) against the worker's wall times,
		// as `lossTrace` does: a timed wait oversleeps on a loaded computer, so counting slices would pass the limit.
		for (;;) {
			const left = waitedAt + HUB_WAIT_LIMIT_MS - realNow();
			if (left <= 0) return "limit";
			const outcome = Atomics.wait(control, STATE, WAITING, Math.min(HUB_SLICE_MS, left));
			if (outcome !== "timed-out") return outcome;
			if (Atomics.load(control, CONNECTED) !== 1) since = realNow();
			else if (realNow() - Math.max(since, times[0] ?? 0) >= HUB_CALL_DEADLINE_MS) return "silent";
		}
	}

	/**
	 * Blocks until the worker handed over the lines that settle `id` (or `"drain"`: whatever there is). A wait past its
	 * bound gives up the call `id` alone: the error its caller gets (`hub_unknown`, since the core may still carry the
	 * call out); the connection and the core stay.
	 */
	#wait(connection: Connection, id: number | "drain", method: string): Line[] | CoreError {
		const { control, worker } = connection;
		Atomics.store(control, STATE, WAITING);
		// Wall time on the real clock, as the worker writes its own (`lossTrace`).
		const waitedAt = realNow();
		worker.postMessage({ wait: id });
		const started = this.measuring ? performance.now() : 0;
		const outcome = this.#block(connection, waitedAt);
		if (this.measuring) {
			const us = Math.round((performance.now() - started) * 1000);
			this.stats.waitsUs.push(us);
			this.stats.totalUs += us;
		}
		// The worker may claim the hand-over at the same moment: whichever side moves the state from WAITING wins.
		if (
			(outcome === "silent" || outcome === "limit") &&
			Atomics.compareExchange(control, STATE, WAITING, IDLE) === WAITING
		) {
			worker.postMessage({ cancel: true });
			const reason =
				outcome === "silent"
					? `the hub did not answer and the core sent nothing for ${HUB_CALL_DEADLINE_MS} ms`
					: `the hub did not answer within ${HUB_WAIT_LIMIT_MS} ms`;
			const trace = lossTrace(connection.times, waitedAt, id);
			const waitedMs = Math.round(realNow() - waitedAt);
			core().report?.("gave-up", { method, waitedMs, reason: `${reason} (${trace})` });
			if (id === "drain") return [];
			this.#gaveUp.set(id, { method, at: realNow() });
			for (const old of this.#gaveUp.keys()) {
				if (this.#gaveUp.size <= GAVE_UP_KEPT) break;
				this.#gaveUp.delete(old);
			}
			return new CoreError(
				"hub_unknown",
				`${method}: ${reason}, so the call was given up; the core may still carry it out (${trace})`,
			);
		}
		while (Atomics.load(control, STATE) === WRITING) Atomics.wait(control, STATE, WRITING, HUB_SLICE_MS);
		const length = Atomics.load(control, LENGTH);
		const text = new TextDecoder().decode(new Uint8Array(connection.sab, DATA_OFFSET, length).slice());
		Atomics.store(control, STATE, IDLE);
		const handed = JSON.parse(text) as { lines: Line[]; lost: string | null };
		// Lost now, not in a microtask: the caller's loop reads `dead` before it waits again.
		if (handed.lost) this.#lose(connection, new CoreError("hub_lost", handed.lost));
		return handed.lines;
	}

	/** The worker has lines and main is not waiting: fetch and handle them now. */
	#drain(connection: Connection): void {
		if (connection.dead || this.#connection !== connection) return;
		const lines = this.#wait(connection, "drain", "drain");
		if (lines instanceof CoreError) return;
		for (const line of lines) this.#handle(line);
	}

	/** One line, at once, also inside another's handling: a nested call's effects run inside it, as a listener did. */
	#handle(line: Line): void {
		if (line.id !== undefined) {
			if (this.#calling.has(line.id)) {
				this.#calling.set(line.id, line);
				return;
			}
			const waiting = this.#pending.get(line.id);
			if (!waiting) {
				const gaveUp = this.#gaveUp.get(line.id);
				if (gaveUp) {
					this.#gaveUp.delete(line.id);
					core().report?.("late-answer", {
						method: gaveUp.method,
						lateMs: Math.round(realNow() - gaveUp.at),
						ok: line.ok === true,
					});
				}
				return;
			}
			this.#pending.delete(line.id);
			if (line.ok) waiting.resolve(line.result);
			else waiting.reject(new CoreError(line.error?.code ?? "hub_error", line.error?.message ?? "the hub failed"));
			return;
		}
		if (line.event !== "hub.out" || !line.data) return;
		const handler = this.#instances.get(line.data.to);
		if (!handler) return;
		for (const item of line.data.items) {
			if (item.k === "ask") this.#answer(handler, item);
			else handler.item(item);
		}
	}

	#answer(handler: HubInstanceHandler, item: HubItem): void {
		const ask = item.ask as number;
		// The core that asked: a promise that settles after it was lost has nobody to answer, and the next core numbers
		// its asks from 1 again, so the answer must never reach that one.
		const asker = this.#connection;
		const send = (body: { value?: unknown; error?: { code?: string; message: string } }) => {
			if (!asker || asker.dead || this.#connection !== asker) return;
			const params = { ask, ...body };
			// Inside a call main waits for, the answer goes and that wait picks up what it wakes; otherwise main waits
			// for the continuation it wakes, as a promise's continuation ran in the resolving tick's microtasks.
			if (this.#depth > 0) this.#write({ id: ++this.#sequence, method: "hub.answer", params });
			else {
				try {
					this.#call("hub.answer", params);
				} catch {
					// A lost hub told every instance already; a given-up answer was logged.
				}
			}
		};
		const fail = (error: unknown) =>
			send({
				error: {
					...(error instanceof Error && "code" in error && typeof error.code === "string"
						? { code: error.code }
						: {}),
					message: error instanceof Error ? error.message : String(error),
				},
			});
		let value: unknown;
		try {
			value = handler.ask(item.q as string, item);
		} catch (error) {
			fail(error);
			return;
		}
		if (value instanceof Promise) {
			if (item.sync === true) {
				fail(new Error(`main answered the synchronous question ${String(item.q)} with a promise`));
				return;
			}
			value.then(resolved => send({ value: resolved ?? null }), fail);
			return;
		}
		send({ value: value ?? null });
	}

	#lose(connection: Connection, error: CoreError): void {
		if (connection.dead) return;
		connection.dead = error;
		// A core whose hub stopped answering, or whose hub connection ended, is a lost core: ended, and everything it ran
		// opens again on the next one (a core that already died is only forgotten).
		if (core().hubEndpointGeneration() === connection.generation) core().abandon(error.message);
		void connection.worker.terminate();
		if (this.#connection === connection) this.#connection = null;
		for (const [id, waiting] of this.#pending) {
			this.#pending.delete(id);
			waiting.reject(error);
		}
		const instances = [...this.#instances];
		this.#instances.clear();
		for (const [, handler] of instances) handler.lost(error);
	}
}

let instanceCount = 0;
let shared: Hub | null = null;

/** The one hub connection of this process. */
export function hub(): Hub {
	shared ??= new Hub();
	return shared;
}

/**
 * An instance of `kind` that holds nothing of main's (rules that only compute): opened on first use and again after a
 * lost core. Returns what {@link Hub.callOnce} takes. `ask` answers the questions its rules ask, if any.
 */
export function sharedInstance(kind: string, ask: HubInstanceHandler["ask"] = noQuestions): () => number {
	let id: number | null = null;
	return () => {
		if (id !== null) return id;
		const opened = hub().nextId();
		hub().open(
			opened,
			kind,
			{},
			{
				item: () => {},
				ask,
				lost: () => {
					if (id === opened) id = null;
				},
			},
		);
		id = opened;
		return opened;
	};
}

function noQuestions(q: string): never {
	throw new Error(`these rules ask nothing (${q})`);
}

/** One minute of main's blocked waits on the hub, for the ledger's measurement (`OMP_GUI_HUB_STATS=1`). */
export interface HubMinute {
	calls: number;
	waits: number;
	p50Us: number;
	p99Us: number;
	maxUs: number;
	totalMs: number;
	/** The five most called methods, `name:count`. */
	top: string;
}

/** The waits recorded since the last read, summarized; they are dropped. Null when nothing was measured. */
export function takeHubMinute(): HubMinute | null {
	const { stats } = hub();
	const waits = stats.waitsUs.splice(0).sort((a, b) => a - b);
	const calls = stats.calls;
	const top = [...stats.methods]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([name, count]) => `${name}:${count}`)
		.join(" ");
	stats.methods.clear();
	stats.calls = 0;
	stats.totalUs = 0;
	if (waits.length === 0) return null;
	const at = (q: number) => waits[Math.min(waits.length - 1, Math.floor(q * waits.length))] ?? 0;
	return {
		calls,
		waits: waits.length,
		p50Us: at(0.5),
		p99Us: at(0.99),
		maxUs: waits.at(-1) ?? 0,
		totalMs: Math.round(waits.reduce((sum, us) => sum + us, 0) / 100) / 10,
		top,
	};
}
