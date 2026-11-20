/**
 * The `ompdesk-core` process (native/ompdesk/crates/core), where main's subsystems move one at a time. Started on its
 * first request with an open stdin pipe, so it exits when main does, however main ends. Both ways, one JSON object per
 * line; a frame with `"bin": n` is followed by exactly n raw bytes (file contents, never base64). Requests run
 * concurrently in the core and are matched here by id; events reach subscribers. `{"cancel": id}` stops a request in
 * the core (the processes it runs end, it starts no more) when its caller's signal aborts or its timeout passed.
 *
 * A request fails alone when its timeout passes (its late answer is dropped), and every request waiting on a core that
 * ends without being asked to fails; the next request starts a fresh core. A core that ends three times in a row before
 * answering anything is not started again for 30 s, so a broken binary is never spawned per request.
 *
 * The processes a core starts (git) end with it, so a repository lock's next holder never runs beside a git of a dead
 * core: on POSIX the core leads its own process group and, once it is gone, main kills what is left of the group and
 * settles what waited only when none of it exists; on Windows the core keeps its children in a job object that kills
 * them as its last handle closes (`crates/core/src/sys.rs`).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { redactDiagnosticsText } from "../../../resources/gui-bridge/redactor";
import { nativeBinPath } from "../native-bin";

const REQUEST_TIMEOUT_MS = 30_000;
const STOP_KILL_MS = 5_000;
/** The longest main waits, after a core ended, for its process group to be gone before it settles what waited. */
const GROUP_GONE_MS = 3_000;
const POSIX = process.platform !== "win32";
const MAX_FAILED_STARTS = 3;
const FAILED_START_REST_MS = 30_000;
const NEWLINE = 0x0a;
/** The last stderr lines of a core that ended, and each one's length, in its `ended` report. */
const STDERR_TAIL_LINES = 5;
const STDERR_LINE_CHARS = 300;

/** A request the core refused (`code` from its answer) or that never got an answer (`timeout`, `core_exited`, …). */
export class CoreError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "CoreError";
		this.code = code;
	}
}

/** Whether a process of the group `pgid` still exists (a zombie counts until its new parent reaps it). */
function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Kills the core and every process it started: its process group on POSIX, the core alone (its job) on Windows. */
function killTree(child: ChildProcessWithoutNullStreams): void {
	if (!POSIX || child.pid === undefined) {
		child.kill();
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		// ESRCH: nothing of the group is left.
	}
}

/**
 * After a core ended: kills what is left of its process group and resolves once none of it exists (true), or false when
 * some still does after `GROUP_GONE_MS`. Windows has no group to wait on: the core's job object ended its children.
 */
async function groupGone(pid: number | undefined): Promise<boolean> {
	if (!POSIX || pid === undefined) return true;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// ESRCH: nothing of the group is left.
	}
	for (let waited = 0, pause = 5; groupAlive(pid); waited += pause, pause = Math.min(pause * 2, 200)) {
		if (waited >= GROUP_GONE_MS) return false;
		await sleep(pause);
	}
	return true;
}

export interface CoreCallOptions {
	/** Raw bytes sent after the request's line. */
	bin?: Uint8Array;
	/** Replaces the 30 s default. */
	timeoutMs?: number;
	/**
	 * Stops the request in the core when it aborts: what it runs is ended and it starts nothing more. The call still
	 * settles with the core's answer (`cancelled` when the core stopped it), which comes once all of that ended.
	 */
	signal?: AbortSignal;
	/**
	 * Called once the core is done with the request: when its answer arrives (also one that comes after the timeout
	 * failed the call) or when the core ends. Whatever the request started in the core has ended by then.
	 */
	onEnded?: () => void;
	/**
	 * Only for the core that started with this generation (`generation`, or the third argument an event listener
	 * gets): the request fails `core_exited` at once, and no core is started, when another one runs or none does. An
	 * answer to a question the core asked goes this way, because the numbers a core asks by start over with the next
	 * one, and an answer sent to it would settle another question.
	 */
	generation?: number;
}

export interface CoreAnswer<T> {
	result: T;
	/** The answer's raw bytes: a plain `Uint8Array` that owns its buffer; null when it carried none. */
	bin: Uint8Array | null;
	/** The generation of the core that answered (`CoreProcess.generation` while it runs). */
	generation: number;
}

export interface CoreProcessOptions {
	/** The binary to run, read at each start (`index.ts` configures the packaged location before the first request). */
	binary: () => string;
	/** Each line the core writes to stderr, and this side's own notes. */
	log?: (line: string) => void;
	timeoutMs?: number;
}

/** The event `on` hears, with no data, when a running core ended (crash, kill, `stop`). */
export const CORE_EXITED = "core.exited";

/** A step of a core's loss, as `CoreProcess.report` names it. */
export type CoreLossStep = "abandoned" | "ended" | "rest";

interface Frame {
	id?: number;
	ok?: boolean;
	result?: unknown;
	error?: { code?: string; message?: string };
	event?: string;
	data?: unknown;
	bin?: number;
}

interface Pending {
	method: string;
	child: ChildProcessWithoutNullStreams;
	resolve: (answer: CoreAnswer<unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	/** Removes the caller's abort listener. */
	detach: () => void;
	onEnded?: () => void;
}

/** A request whose caller stopped waiting (its timeout) and that still runs in the core. */
interface Late {
	child: ChildProcessWithoutNullStreams;
	onEnded: () => void;
}

/** JSON carries no lone surrogate (the core's parser refuses one): it goes as U+FFFD, as node writes it to disk. */
const wellFormed = (_key: string, value: unknown): unknown =>
	typeof value === "string" ? value.toWellFormed() : value;

/** Splits stdout into frames, copying each `bin` tail straight into its own exactly sized array. */
class FrameReader {
	#line: Buffer[] = [];
	#bin: { frame: Frame; data: Uint8Array; filled: number } | null = null;
	readonly #deliver: (frame: Frame, bin: Uint8Array | null) => void;
	readonly #log: (line: string) => void;

	constructor(deliver: (frame: Frame, bin: Uint8Array | null) => void, log: (line: string) => void) {
		this.#deliver = deliver;
		this.#log = log;
	}

	push(chunk: Buffer): void {
		let offset = 0;
		while (offset < chunk.length) {
			const bin = this.#bin;
			if (bin) {
				const take = Math.min(bin.data.length - bin.filled, chunk.length - offset);
				bin.data.set(chunk.subarray(offset, offset + take), bin.filled);
				bin.filled += take;
				offset += take;
				if (bin.filled === bin.data.length) {
					this.#bin = null;
					this.#deliver(bin.frame, bin.data);
				}
				continue;
			}
			const end = chunk.indexOf(NEWLINE, offset);
			if (end === -1) {
				this.#line.push(chunk.subarray(offset));
				return;
			}
			this.#line.push(chunk.subarray(offset, end));
			offset = end + 1;
			const text = Buffer.concat(this.#line).toString("utf8");
			this.#line = [];
			let frame: Frame;
			try {
				frame = JSON.parse(text) as Frame;
			} catch {
				this.#log(`ompdesk-core: skipped a line that is not a frame (${text.length} characters)`);
				continue;
			}
			if (typeof frame.bin === "number" && frame.bin > 0) {
				this.#bin = { frame, data: new Uint8Array(frame.bin), filled: 0 };
			} else {
				this.#deliver(frame, typeof frame.bin === "number" ? new Uint8Array(0) : null);
			}
		}
	}
}

export class CoreProcess {
	#child: ChildProcessWithoutNullStreams | null = null;
	#shuttingDown = false;
	#failedStarts = 0;
	#restUntil = 0;
	#sequence = 0;
	readonly #pending = new Map<number, Pending>();
	readonly #late = new Map<number, Late>();
	readonly #stopping = new Set<ChildProcessWithoutNullStreams>();
	/** Resolves after a core ended, with whether its process group is gone. */
	readonly #gone = new WeakMap<ChildProcessWithoutNullStreams, Promise<boolean>>();
	readonly #listeners = new Map<string, Set<(data: unknown, bin: Uint8Array | null, generation: number) => void>>();
	#stops = 0;
	/** Where the running core's hub listens (`hub.ts` connects there), made fresh for each start. */
	#hub: { address: string; token: string; generation: number; folder: string | null } | null = null;
	#starts = 0;
	readonly #binary: () => string;
	readonly #log: (line: string) => void;
	readonly #timeoutMs: number;
	/** Cores abandoned for a missed hub deadline, with when: an `ended` long after says the computer itself stalled. */
	readonly #abandoned = new WeakMap<ChildProcessWithoutNullStreams, number>();
	/** Cores that answered a request: one that ends without is a failed start. */
	readonly #answeredBy = new WeakSet<ChildProcessWithoutNullStreams>();
	/**
	 * Each step of a core's loss, for gui-runtime.jsonl (`index.ts` sets it; source `core-loss`): `abandoned` (main
	 * ended a core that stopped answering, and why), `ended` (a core that was not stopped by the quit ended: its exit,
	 * whether it had answered, the last lines it wrote to stderr), `rest` (it is not started again for a while). The
	 * console only gets these where nothing keeps main's output (a packaged app).
	 */
	report: ((step: CoreLossStep, details: Record<string, string | number | boolean>) => void) | null = null;
	/**
	 * The file in which a worktree removal on Windows writes down an empty folder some process still held
	 * (`OMPDESK_LEFT_BEHIND`, `crates/core/src/git/left_behind.rs`; `index.ts` sets `<userData>/left-behind-worktrees.json`
	 * before the first start). Unset, the core leaves nothing behind and such a removal keeps git's failure.
	 */
	leftBehindFile: string | null = null;

	constructor(options: CoreProcessOptions) {
		this.#binary = options.binary;
		this.#log = options.log ?? (line => console.warn(line));
		this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	}

	/** The running core's process id (null while none runs). */
	get pid(): number | null {
		return this.#child?.pid ?? null;
	}

	/** Subscribes to an event the core sends (the frame's `bin` tail, when it has one, as the second argument); returns the unsubscribe. */
	on(event: string, listener: (data: unknown, bin: Uint8Array | null, generation: number) => void): () => void {
		let listeners = this.#listeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.#listeners.set(event, listeners);
		}
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	/** How many times `stop()` ended a core: a request that fails `core_exited` after the count moved was ended on purpose. */
	get stops(): number {
		return this.#stops;
	}

	/** The running core's generation: it changes with every start (0 while none runs); never starts one. */
	get generation(): number {
		return this.#child ? (this.#hub?.generation ?? 0) : 0;
	}

	/**
	 * Where the running core's hub listens, starting the core when none runs (main's synchronous calls, `hub.ts`).
	 * `generation` changes with every start: a hub connection of an older one is gone.
	 */
	hubEndpoint(): { address: string; token: string; generation: number } {
		this.#start();
		const hub = this.#hub;
		if (!hub) throw new CoreError("core_unavailable", "ompdesk-core has no hub");
		return { address: hub.address, token: hub.token, generation: hub.generation };
	}

	/** The generation of the running core's hub (0 while none runs), without starting one. */
	hubEndpointGeneration(): number {
		return this.generation;
	}

	/**
	 * The running core stopped answering (a hub call passed its deadline): it is killed with what it started, as a core
	 * that died is, so every lane and hub instance is opened again on the next one.
	 */
	abandon(reason: string): void {
		const child = this.#child;
		if (!child) return;
		this.#log(`ompdesk-core: ${reason}; ending it`);
		this.#abandoned.set(child, Date.now());
		this.report?.("abandoned", { generation: this.generation, reason });
		// Forgotten now, not at its exit event: main's thread may call again before that event can run, and that call
		// must start the next core. Its exit still fails what waited on it, as a core that died does.
		this.#child = null;
		this.#stopping.add(child);
		killTree(child);
	}

	call<T>(method: string, params: unknown = {}, options: CoreCallOptions = {}): Promise<CoreAnswer<T>> {
		if (options.generation !== undefined && options.generation !== this.generation) {
			options.onEnded?.();
			return Promise.reject(new CoreError("core_exited", `the ompdesk-core that ${method} was meant for ended`));
		}
		let child: ChildProcessWithoutNullStreams;
		try {
			child = this.#start();
		} catch (error) {
			options.onEnded?.();
			return Promise.reject(error);
		}
		const id = ++this.#sequence;
		const { promise, resolve, reject } = Promise.withResolvers<CoreAnswer<unknown>>();
		const { signal, onEnded } = options;
		const cancel = () => this.#cancel(child, id);
		const detach = () => signal?.removeEventListener("abort", cancel);
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			detach();
			if (onEnded) this.#late.set(id, { child, onEnded });
			cancel();
			reject(new CoreError("timeout", `ompdesk-core did not answer ${method} in time`));
		}, options.timeoutMs ?? this.#timeoutMs);
		this.#pending.set(id, { method, child, resolve, reject, timer, detach, onEnded });
		const bin = options.bin ? { bin: options.bin.byteLength } : {};
		child.stdin.write(`${JSON.stringify({ id, method, params, ...bin }, wellFormed)}\n`);
		if (options.bin) child.stdin.write(options.bin);
		if (signal?.aborted) cancel();
		else signal?.addEventListener("abort", cancel, { once: true });
		return promise as Promise<CoreAnswer<T>>;
	}

	/**
	 * Hands the core work it never answers, handled in the order pushed (a remote link's messages). Starts the core
	 * like a request; a push to a core that ended is lost with whatever it was for. With `generation` it goes only to
	 * the core of that generation: a push that answers a question the core asked (`web.reply`) is dropped, and starts
	 * no core, when another one runs, because the next core numbers its questions from 1 again.
	 */
	push(method: string, params: unknown, bin?: Uint8Array, generation?: number): void {
		if (generation !== undefined && generation !== this.generation) return;
		const child = this.#start();
		const tail = bin ? `,"bin":${bin.byteLength}` : "";
		child.stdin.write(`{"push":${JSON.stringify(method)},"params":${JSON.stringify(params, wellFormed)}${tail}}\n`);
		if (bin) child.stdin.write(bin);
	}

	/**
	 * Ends the core: its stdin closes, it answers what it holds and exits; after 5 s it is killed with every process it
	 * started. Resolves once it and they are gone.
	 */
	async stop(): Promise<void> {
		this.#stops++;
		const child = this.#child;
		if (child) {
			this.#child = null;
			this.#stopping.add(child);
			const gone = this.#gone.get(child);
			if (!gone) {
				killTree(child);
				throw new Error("ompdesk-core has no exit receipt");
			}
			child.stdin.end();
			const kill = setTimeout(() => killTree(child), STOP_KILL_MS);
			void gone.then(() => clearTimeout(kill));
		}
		const gone = await Promise.all([...this.#stopping].map(stopping => this.#gone.get(stopping)));
		if (gone.some(empty => empty !== true))
			throw new CoreError("core_exited", "git processes it started may still run");
	}

	/** Whether {@link shutdown} was called: the core is not started again, every request is refused. */
	get shuttingDown(): boolean {
		return this.#shuttingDown;
	}

	/** Refuses new work and joins every core. A lost shell ends their groups without the normal quit grace. */
	shutdown(force = false): Promise<void> {
		this.#shuttingDown = true;
		if (force) {
			const current = this.#child;
			this.abandon("the shell ended");
			for (const stopping of this.#stopping) {
				if (stopping !== current && stopping.exitCode === null && stopping.signalCode === null) killTree(stopping);
			}
		}
		return this.stop();
	}

	/** Asks the core that has request `id` to stop it; a core that already ended or answered has nothing to stop. */
	#cancel(child: ChildProcessWithoutNullStreams, id: number): void {
		if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ cancel: id })}\n`);
	}

	#start(): ChildProcessWithoutNullStreams {
		if (this.#shuttingDown) throw new CoreError("core_unavailable", "ompdesk-core is shutting down");
		if (this.#child) return this.#child;
		if (Date.now() < this.#restUntil)
			throw new CoreError(
				"core_unavailable",
				`ompdesk-core ended ${MAX_FAILED_STARTS} times in a row before answering; it is not started again for ${FAILED_START_REST_MS / 1000} s`,
			);
		// Detached: on POSIX the core leads a process group of its own, which every git it starts joins. On Windows
		// libuv puts every child that is not detached in a job object that kills it the moment this process dies, so a
		// crashed main took the core, and the omps it runs, down before they could close their sessions (no
		// `session_exit` in the journal, which a relaunch's restore reads: e2e/interrupted-resume.e2e.ts); detached, the
		// core sees main's stdin end and stops them as a quit does (the core gives itself a hidden console then, as a
		// detached process has none: `ensure_console` in crates/core/src/sys.rs). It still ends with stdin's end
		// (main's), and it is never `unref`ed.
		this.#hub = hubPlace(++this.#starts);
		const env = {
			...process.env,
			OMPDESK_HUB: this.#hub.address,
			OMPDESK_HUB_TOKEN: this.#hub.token,
			...(this.leftBehindFile ? { OMPDESK_LEFT_BEHIND: this.leftBehindFile } : {}),
		};
		const child = spawn(this.#binary(), [], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			detached: true,
			env,
		});
		this.#child = child;
		const hubFolder = this.#hub.folder;
		const generation = this.#hub.generation;
		const reader = new FrameReader((frame, bin) => this.#receive(child, generation, frame, bin), this.#log);
		child.stdout.on("data", (chunk: Buffer) => reader.push(chunk));
		// The last lines it wrote, for the report of its end.
		const stderr: string[] = [];
		createInterface({ input: child.stderr }).on("line", line => {
			stderr.push(line);
			if (stderr.length > STDERR_TAIL_LINES) stderr.shift();
			this.#log(line);
		});
		// A write to a core that already ended fails here; its close rejects what waits.
		child.stdin.on("error", () => {});
		const gone = Promise.withResolvers<boolean>();
		this.#gone.set(child, gone.promise);
		const exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
		let ended = false;
		const end = (error: CoreError) => {
			if (ended) return;
			ended = true;
			this.#ended(child, generation, error, gone.resolve, exit, stderr);
		};
		child.on("error", error =>
			end(new CoreError("core_unavailable", `ompdesk-core could not run: ${error.message}`)),
		);
		child.on("close", (code, signal) => {
			if (hubFolder) rmSync(hubFolder, { recursive: true, force: true });
			exit.code = code;
			exit.signal = signal;
			end(new CoreError("core_exited", `ompdesk-core exited (${signal ?? `code ${code}`})`));
		});
		return child;
	}

	#receive(child: ChildProcessWithoutNullStreams, generation: number, frame: Frame, bin: Uint8Array | null): void {
		if (typeof frame.event === "string") {
			for (const listener of this.#listeners.get(frame.event) ?? []) listener(frame.data, bin, generation);
			return;
		}
		if (typeof frame.id !== "number") return;
		if (child === this.#child) this.#failedStarts = 0;
		this.#answeredBy.add(child);
		const pending = this.#pending.get(frame.id);
		if (!pending) {
			const late = this.#late.get(frame.id);
			if (late?.child === child) {
				this.#late.delete(frame.id);
				late.onEnded();
			}
			this.#log(`ompdesk-core: dropped a late answer to request ${frame.id}`);
			return;
		}
		this.#pending.delete(frame.id);
		clearTimeout(pending.timer);
		pending.detach();
		pending.onEnded?.();
		if (frame.ok) pending.resolve({ result: frame.result, bin, generation });
		else
			pending.reject(
				new CoreError(
					frame.error?.code ?? "unknown",
					frame.error?.message ?? `ompdesk-core refused ${pending.method}`,
				),
			);
	}

	#ended(
		child: ChildProcessWithoutNullStreams,
		generation: number,
		error: CoreError,
		gone: (empty: boolean) => void,
		exit: { code: number | null; signal: NodeJS.Signals | null },
		stderr: readonly string[],
	): void {
		const expected = this.#stopping.has(child);
		this.#stopping.add(child);
		const abandonedAt = this.#abandoned.get(child);
		if (!expected || abandonedAt !== undefined)
			this.report?.("ended", {
				generation,
				code: exit.code ?? -1,
				signal: exit.signal ?? "",
				abandoned: abandonedAt !== undefined,
				// How long the killed core took to end: seconds mean the whole computer stalled, not only the core.
				...(abandonedAt !== undefined ? { exitMs: Date.now() - abandonedAt } : {}),
				answered: this.#answeredBy.has(child),
				stderr: stderr.map(line => redactDiagnosticsText(line).slice(0, STDERR_LINE_CHARS)).join("\n"),
			});
		if (this.#child === child) {
			this.#child = null;
			if (!this.#answeredBy.has(child) && ++this.#failedStarts >= MAX_FAILED_STARTS) {
				this.#failedStarts = 0;
				this.#restUntil = Date.now() + FAILED_START_REST_MS;
				this.report?.("rest", { failedStarts: MAX_FAILED_STARTS, restMs: FAILED_START_REST_MS });
			}
		}
		if (!expected) this.#log(error.message);
		// What lived in that core (a remote link, a listener) is gone with it.
		for (const listener of this.#listeners.get(CORE_EXITED) ?? []) listener(null, null, generation);
		const waiting = [...this.#pending].filter(([, pending]) => pending.child === child);
		for (const [id, pending] of waiting) {
			this.#pending.delete(id);
			clearTimeout(pending.timer);
			pending.detach();
		}
		const late = [...this.#late].filter(([, entry]) => entry.child === child);
		for (const [id] of late) this.#late.delete(id);
		// What waited settles once every git the core started is gone: a lock's next holder starts only then.
		void groupGone(child.pid).then(empty => {
			const failure = empty
				? error
				: new CoreError(error.code, `${error.message}; git processes it started may still run`);
			if (!empty) this.#log(`ompdesk-core: ${failure.message} (its process group outlived ${GROUP_GONE_MS} ms)`);
			for (const [, pending] of waiting) {
				pending.onEnded?.();
				pending.reject(failure);
			}
			for (const [, entry] of late) entry.onEnded();
			if (empty) this.#stopping.delete(child);
			gone(empty);
		});
	}
}

/**
 * A new place for a core's hub: on POSIX a socket in a folder only this user may open (0700, `mkdtemp`), on Windows a
 * pipe whose name nobody can guess; with a token the connection proves either way.
 */
function hubPlace(generation: number): { address: string; token: string; generation: number; folder: string | null } {
	const token = randomBytes(24).toString("hex");
	if (!POSIX)
		return {
			address: `\\\\.\\pipe\\ompdesk-hub-${randomBytes(16).toString("hex")}`,
			token,
			generation,
			folder: null,
		};
	const folder = mkdtempSync(join(tmpdir(), "ompdesk-hub-"));
	return { address: join(folder, "h"), token, generation, folder };
}

let instance: CoreProcess | null = null;

/** The app's one core. */
export function core(): CoreProcess {
	instance ??= new CoreProcess({ binary: () => nativeBinPath("ompdesk-core") });
	return instance;
}

/**
 * Whether `error` is the core's refusal of work after the quit began (`shutdown` ran). A timer, a window event or a
 * status listener that reaches the core while the app quits has nothing left to do: its caller drops the error.
 */
export function isCoreShutdown(error: unknown): boolean {
	return error instanceof CoreError && error.code === "core_unavailable" && instance?.shuttingDown === true;
}

/** Ends the app's core (quit); a later request starts it again. */
export function stopCore(): Promise<void> {
	return instance?.stop() ?? Promise.resolve();
}

/** Ends the app's core for good, including when it has not started yet. */
export function shutdownCore(force = false): Promise<void> {
	return core().shutdown(force);
}
