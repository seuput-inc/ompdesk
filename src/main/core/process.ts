/**
 * The `ompdesk-core` process (native/ompdesk/crates/core), where main's subsystems move one at a time. Main decides
 * when a core starts (on its first request) and mints its generation and endpoints; the core's owner spawns it with
 * main's environment, holds its stdio and reports its end (`crates/core/src/owner.rs`: the Tauri shell, or
 * `ompdesk-core --own` where no shell runs, in vitest). Main speaks to it over a connection of its own (`clients.rs`),
 * one JSON object per line both ways; a frame with `"bin": n` is followed by exactly n raw bytes (file contents, never
 * base64). Requests run concurrently in the core and are matched here by id; events reach subscribers.
 * `{"cancel": id}` stops a request in the core (the processes it runs end, it starts no more) when its caller's signal
 * aborts or its timeout passed.
 *
 * A request fails alone when its timeout passes (its late answer is dropped), and every request waiting on a core that
 * ends without being asked to fails; the next request starts a fresh core. A core that ends three times in a row before
 * answering anything is not started again for 30 s, so a broken binary is never spawned per request.
 *
 * The processes a core starts (git) end with it, so a repository lock's next holder never runs beside a git of a dead
 * core: on POSIX the core leads its own process group and, once it is gone, its owner kills what is left of the group
 * and says so only when none of it exists (`core.gone`); on Windows the core keeps its children in a job object that
 * kills them as its last handle closes (`crates/core/src/sys.rs`). What waited settles only on `core.gone`.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { redactDiagnosticsText } from "../../../resources/gui-bridge/redactor";
import { nativeBinPath } from "../native-bin";

const REQUEST_TIMEOUT_MS = 30_000;
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

/**
 * Who spawns the cores (`crates/core/src/owner.rs`): requests `core.start {generation, binary, cwd, env}` (answers
 * `{pid}`), `core.abandon {generation}`, `core.stop {generation}`; events `core.stderr {generation, line}`,
 * `core.ended {generation, code, signal}` and `core.gone {generation, empty}`.
 */
export interface CoreOwner {
	call<T>(method: string, params: unknown): Promise<T>;
	on(event: string, listener: (data: unknown) => void): () => void;
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

/**
 * A step of a core's loss, as `CoreProcess.report` names it; and the calls short of one: `gave-up` (main gave up one
 * hub call, the core kept), `late-answer` (that call's answer came after, and was dropped).
 */
export type CoreLossStep = "abandoned" | "ended" | "rest" | "gave-up" | "late-answer";

interface Frame {
	id?: number;
	ok?: boolean;
	result?: unknown;
	error?: { code?: string; message?: string };
	event?: string;
	data?: unknown;
	bin?: number;
}

/** A private place to listen: a socket in a 0700 folder on POSIX, an unguessable pipe on Windows; with a token. */
interface Place {
	address: string;
	token: string;
	folder: string | null;
}

/** One started core: its connection, its stderr tail, and the two moments of its end. */
interface Running {
	generation: number;
	link: Link;
	pid: number | null;
	hub: Place;
	clients: Place;
	stderr: string[];
	/** Its process ended (`core.ended`), or never ran. */
	ended: boolean;
	/** Resolves once its process group is gone (true) or still holds a process past the owner's bound (false). */
	gone: PromiseWithResolvers<boolean>;
}

interface Pending {
	method: string;
	core: Running;
	resolve: (answer: CoreAnswer<unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	/** Removes the caller's abort listener. */
	detach: () => void;
	onEnded?: () => void;
}

/** A request whose caller stopped waiting (its timeout) and that still runs in the core. */
interface Late {
	core: Running;
	onEnded: () => void;
}

/** JSON carries no lone surrogate (the core's parser refuses one): it goes as U+FFFD, as node writes it to disk. */
const wellFormed = (_key: string, value: unknown): unknown =>
	typeof value === "string" ? value.toWellFormed() : value;

/** Splits a stream into frames, copying each `bin` tail straight into its own exactly sized array. */
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

/**
 * Main's connection to one core (`clients.rs`). It is usable at once: writes wait in order until `open()`, which comes
 * with the owner's answer to `core.start` (the core said `ready`, so it listens). Its first line proves the token. A
 * connection that fails or ends takes nothing more; what waits on it settles on the owner's `core.gone`.
 */
class Link {
	#socket: Socket | null = null;
	#queue: Array<string | Uint8Array> = [];
	#closed = false;
	readonly #place: Place;
	readonly #receive: (chunk: Buffer) => void;
	readonly #log: (line: string) => void;

	constructor(place: Place, receive: (chunk: Buffer) => void, log: (line: string) => void) {
		this.#place = place;
		this.#receive = receive;
		this.#log = log;
		this.#queue.push(`${JSON.stringify({ token: place.token, client: "main" })}\n`);
	}

	get writable(): boolean {
		return !this.#closed;
	}

	write(data: string | Uint8Array): void {
		if (this.#closed) return;
		if (this.#socket) this.#socket.write(data);
		else this.#queue.push(data);
	}

	/** The core ended: nothing more goes to it. */
	close(): void {
		this.#closed = true;
		this.#queue = [];
		this.#socket?.destroy();
	}

	/** Connects, now that the core listens, and sends what waited. */
	open(): void {
		if (this.#closed || this.#socket) return;
		const socket = connect(this.#place.address);
		// Written at once: a connecting socket keeps what is written, in order, until it connected.
		this.#socket = socket;
		for (const data of this.#queue) socket.write(data);
		this.#queue = [];
		socket.on("data", (chunk: Buffer) => this.#receive(chunk));
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (!this.#closed) this.#log(`ompdesk-core: main's connection failed: ${error.code ?? error.message}`);
		});
		socket.on("close", () => {
			this.#closed = true;
		});
	}
}

/** Where the owner link's worker reaches the owner: the shell's owner socket (`facts.coreOwner`) or a child it spawns. */
export type OwnerTarget = { connect: string; token: string } | { spawn: string };

/**
 * The worker that carries main's owner traffic. A thread blocked in a hub wait sends only the first of its pipe writes
 * on Windows (libuv completes a pipe write on the loop that the wait holds), and a lost hub call needs two: the
 * abandon and the next core's start. Main posts them here instead; this thread's loop never waits.
 */
const OWNER_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
let write;
const closed = () => parentPort.postMessage({ closed: true });
const data = chunk => parentPort.postMessage({ data: chunk });
if (workerData.connect) {
	const socket = require("node:net").connect(workerData.connect);
	socket.on("data", data);
	socket.on("error", error => parentPort.postMessage({ log: "the core's owner: " + error.message }));
	socket.on("close", closed);
	socket.write(workerData.token + "\\n");
	write = line => socket.write(line);
} else {
	const child = require("node:child_process").spawn(workerData.spawn, ["--own"], {
		// Its own folder, never main's: it lives as long as main, and a folder it stands in cannot be removed on Windows.
		cwd: require("node:path").dirname(workerData.spawn),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	child.stdout.on("data", data);
	child.stderr.on("data", chunk => parentPort.postMessage({ log: chunk.toString("utf8").trimEnd() }));
	child.stdin.on("error", () => {});
	child.on("error", error => parentPort.postMessage({ log: "ompdesk-core --own: " + error.message }));
	child.on("close", closed);
	write = line => child.stdin.write(line);
}
parentPort.on("message", line => write(line));
`;

/** Main's link to the core's owner, over a worker thread (`OWNER_WORKER`). */
function ownerLink(target: OwnerTarget, log: (line: string) => void): CoreOwner {
	const worker = new Worker(OWNER_WORKER, { eval: true, name: "ompdesk-core-owner", workerData: target });
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const pending = new Map<number, PromiseWithResolvers<unknown>>();
	let next = 0;
	let closed = false;
	const reader = new FrameReader(frame => {
		if (typeof frame.event === "string") {
			for (const listener of listeners.get(frame.event) ?? []) listener(frame.data);
			return;
		}
		const waiting = typeof frame.id === "number" ? pending.get(frame.id) : undefined;
		if (!waiting || frame.id === undefined) return;
		pending.delete(frame.id);
		if (frame.ok) waiting.resolve(frame.result);
		else waiting.reject(new CoreError(frame.error?.code ?? "failed", frame.error?.message ?? "owner refused"));
	}, log);
	const close = (): void => {
		closed = true;
		for (const waiting of pending.values())
			waiting.reject(new CoreError("core_unavailable", "the core's owner ended"));
		pending.clear();
	};
	worker.on("message", (message: { data?: Uint8Array; log?: string; closed?: true }) => {
		if (message.data) reader.push(Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength));
		else if (message.log) log(message.log);
		else if (message.closed) close();
	});
	worker.on("error", error => {
		log(`the core's owner link failed: ${error.message}`);
		close();
	});
	// After the listeners: Bun refs a worker again when one is added.
	worker.unref();
	return {
		call<T>(method: string, params: unknown): Promise<T> {
			if (closed) return Promise.reject(new CoreError("core_unavailable", "the core's owner ended"));
			const id = ++next;
			const waiting = Promise.withResolvers<unknown>();
			pending.set(id, waiting);
			worker.postMessage(`${JSON.stringify({ id, method, params })}\n`);
			return waiting.promise as Promise<T>;
		},
		on(event: string, listener: (data: unknown) => void): () => void {
			const set = listeners.get(event) ?? new Set();
			listeners.set(event, set);
			set.add(listener);
			return () => set.delete(listener);
		},
	};
}

export class CoreProcess {
	#child: Running | null = null;
	#shuttingDown = false;
	#failedStarts = 0;
	#restUntil = 0;
	#sequence = 0;
	readonly #pending = new Map<number, Pending>();
	readonly #late = new Map<number, Late>();
	readonly #stopping = new Set<Running>();
	readonly #cores = new Map<number, Running>();
	readonly #listeners = new Map<string, Set<(data: unknown, bin: Uint8Array | null, generation: number) => void>>();
	#stops = 0;
	#starts = 0;
	#owner: CoreOwner | null = null;
	readonly #binary: () => string;
	readonly #log: (line: string) => void;
	readonly #timeoutMs: number;
	/** Cores abandoned for a lost hub, with when: an `ended` long after says the computer itself stalled. */
	readonly #abandoned = new WeakMap<Running, number>();
	/** Cores that answered a request: one that ends without is a failed start. */
	readonly #answeredBy = new WeakSet<Running>();
	/**
	 * Each step of a core's loss, for gui-runtime.jsonl (`index.ts` sets it; source `core-loss`): `abandoned` (main
	 * ended a core that stopped answering, and why), `ended` (a core that was not stopped by the quit ended: its exit,
	 * whether it had answered, the last lines it wrote to stderr), `rest` (it is not started again for a while); and
	 * `gave-up` (main gave up one hub call and kept the core; why, and what the core last sent) and `late-answer` (that
	 * call's answer came after, and was dropped). The console only gets these where nothing keeps main's output (a
	 * packaged app).
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

	/** Who spawns the cores: the shell's owner socket (`shell-host/electron/index.ts`, before the first start); without
	 * one, the first start spawns `ompdesk-core --own`. */
	ownBy(target: OwnerTarget): void {
		if (this.#owner) throw new Error("ompdesk-core already has an owner");
		this.#adopt(ownerLink(target, this.#log));
	}

	/**
	 * The running core's process id, for what needs the OS process (watchdogs, process lists): null while none runs and
	 * until its owner answered the start. Which core it is, and whether one runs, is `generation`.
	 */
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
		return this.#child?.generation ?? 0;
	}

	/**
	 * Where the running core's hub listens, starting the core when none runs (main's synchronous calls, `hub.ts`).
	 * `generation` changes with every start: a hub connection of an older one is gone.
	 */
	hubEndpoint(): { address: string; token: string; generation: number } {
		const core = this.#start();
		return { address: core.hub.address, token: core.hub.token, generation: core.generation };
	}

	/** The generation of the running core's hub (0 while none runs), without starting one. */
	hubEndpointGeneration(): number {
		return this.generation;
	}

	/**
	 * The running core is dead to main's hub (it sent nothing past the liveness window, or its hub thread sat in one
	 * job past it, `hub.ts`): it is killed with what it started, as a core
	 * that died is, so every lane and hub instance is opened again on the next one.
	 */
	abandon(reason: string): void {
		const core = this.#child;
		if (!core) return;
		this.#log(`ompdesk-core: ${reason}; ending it`);
		this.#abandoned.set(core, Date.now());
		this.report?.("abandoned", { generation: core.generation, reason });
		// Forgotten now, not at its exit event: main's thread may call again before that event can run, and that call
		// must start the next core. Its exit still fails what waited on it, as a core that died does.
		this.#child = null;
		this.#stopping.add(core);
		this.#tell("core.abandon", core);
	}

	call<T>(method: string, params: unknown = {}, options: CoreCallOptions = {}): Promise<CoreAnswer<T>> {
		if (options.generation !== undefined && options.generation !== this.generation) {
			options.onEnded?.();
			return Promise.reject(new CoreError("core_exited", `the ompdesk-core that ${method} was meant for ended`));
		}
		let core: Running;
		try {
			core = this.#start();
		} catch (error) {
			options.onEnded?.();
			return Promise.reject(error);
		}
		const id = ++this.#sequence;
		const { promise, resolve, reject } = Promise.withResolvers<CoreAnswer<unknown>>();
		const { signal, onEnded } = options;
		const cancel = () => this.#cancel(core, id);
		const detach = () => signal?.removeEventListener("abort", cancel);
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			detach();
			if (onEnded) this.#late.set(id, { core, onEnded });
			cancel();
			reject(new CoreError("timeout", `ompdesk-core did not answer ${method} in time`));
		}, options.timeoutMs ?? this.#timeoutMs);
		this.#pending.set(id, { method, core, resolve, reject, timer, detach, onEnded });
		const bin = options.bin ? { bin: options.bin.byteLength } : {};
		core.link.write(`${JSON.stringify({ id, method, params, ...bin }, wellFormed)}\n`);
		if (options.bin) core.link.write(options.bin);
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
		const core = this.#start();
		const tail = bin ? `,"bin":${bin.byteLength}` : "";
		core.link.write(`{"push":${JSON.stringify(method)},"params":${JSON.stringify(params, wellFormed)}${tail}}\n`);
		if (bin) core.link.write(bin);
	}

	/**
	 * Ends the core: its stdin closes, it answers what it holds and exits; after 5 s its owner kills it with every
	 * process it started. Resolves once it and they are gone.
	 */
	async stop(): Promise<void> {
		this.#stops++;
		const core = this.#child;
		if (core) {
			this.#child = null;
			this.#stopping.add(core);
			this.#tell("core.stop", core);
		}
		const gone = await Promise.all([...this.#stopping].map(stopping => stopping.gone.promise));
		if (gone.some(empty => !empty)) throw new CoreError("core_exited", "git processes it started may still run");
	}

	/** Whether {@link shutdown} was called: the core is not started again, every request is refused. */
	get shuttingDown(): boolean {
		return this.#shuttingDown;
	}

	/** Refuses new work and joins every core. `force` (the quit lost its grace) kills them without waiting. */
	shutdown(force = false): Promise<void> {
		this.#shuttingDown = true;
		if (force) {
			const current = this.#child;
			this.abandon("the shell ended");
			for (const stopping of this.#stopping)
				if (stopping !== current && !stopping.ended) this.#tell("core.abandon", stopping);
		}
		return this.stop();
	}

	/** Asks the core that has request `id` to stop it; a core that already ended or answered has nothing to stop. */
	#cancel(core: Running, id: number): void {
		if (core.link.writable) core.link.write(`${JSON.stringify({ cancel: id })}\n`);
	}

	/** Tells the owner to end `core`; an owner that is gone has nothing left to end. */
	#tell(method: "core.stop" | "core.abandon", core: Running): void {
		this.#ownerOf()
			.call(method, { generation: core.generation })
			.catch((error: unknown) =>
				this.#log(`ompdesk-core: ${method} failed: ${error instanceof Error ? error.message : String(error)}`),
			);
	}

	#ownerOf(): CoreOwner {
		if (!this.#owner) this.#adopt(ownerLink({ spawn: nativeBinPath("ompdesk-core") }, this.#log));
		return this.#owner as CoreOwner;
	}

	#adopt(owner: CoreOwner): void {
		this.#owner = owner;
		owner.on("core.stderr", data => {
			const { generation, line } = data as { generation: number; line: string };
			const core = this.#cores.get(generation);
			if (!core) return;
			core.stderr.push(line);
			if (core.stderr.length > STDERR_TAIL_LINES) core.stderr.shift();
			this.#log(line);
		});
		owner.on("core.ended", data => {
			const { generation, code, signal } = data as {
				generation: number;
				code: number | null;
				signal: string | null;
			};
			const core = this.#cores.get(generation);
			if (core)
				this.#ended(core, new CoreError("core_exited", `ompdesk-core exited (${signal ?? `code ${code}`})`), {
					code,
					signal,
				});
		});
		owner.on("core.gone", data => {
			const { generation, empty } = data as { generation: number; empty: boolean };
			const core = this.#cores.get(generation);
			if (!core) return;
			this.#cores.delete(generation);
			core.gone.resolve(empty === true);
		});
		// Where no shell is (`--own`), a core's pushes to desktop windows (`pages.rs`) come here, as the event
		// `page.push {win, ch, pushed, data}` of that core.
		owner.on("core.page", data => {
			const { generation, ...push } = data as { generation: number };
			for (const listener of this.#listeners.get("page.push") ?? []) listener(push, null, generation);
		});
	}

	#start(): Running {
		if (this.#shuttingDown) throw shutdownRefusal();
		if (this.#child) return this.#child;
		if (Date.now() < this.#restUntil)
			throw new CoreError(
				"core_unavailable",
				`ompdesk-core ended ${MAX_FAILED_STARTS} times in a row before answering; it is not started again for ${FAILED_START_REST_MS / 1000} s`,
			);
		const owner = this.#ownerOf();
		const generation = ++this.#starts;
		const hub = place("hub");
		const clients = place("clients");
		const env = {
			...process.env,
			OMPDESK_HUB: hub.address,
			OMPDESK_HUB_TOKEN: hub.token,
			OMPDESK_CLIENTS: clients.address,
			OMPDESK_CLIENTS_TOKEN: clients.token,
			...(this.leftBehindFile ? { OMPDESK_LEFT_BEHIND: this.leftBehindFile } : {}),
		};
		const reader = new FrameReader((frame, bin) => this.#receive(core, frame, bin), this.#log);
		const core: Running = {
			generation,
			link: new Link(clients, chunk => reader.push(chunk), this.#log),
			pid: null,
			hub,
			clients,
			stderr: [],
			ended: false,
			gone: Promise.withResolvers<boolean>(),
		};
		this.#child = core;
		this.#cores.set(generation, core);
		owner.call<{ pid: number }>("core.start", { generation, binary: this.#binary(), cwd: process.cwd(), env }).then(
			({ pid }) => {
				core.pid = pid;
				core.link.open();
			},
			(error: unknown) => {
				// It never ran: nothing of it to wait for.
				const message = error instanceof Error ? error.message : String(error);
				this.#ended(core, new CoreError("core_unavailable", message), { code: null, signal: null });
				this.#cores.delete(generation);
				core.gone.resolve(true);
			},
		);
		return core;
	}

	#receive(core: Running, frame: Frame, bin: Uint8Array | null): void {
		if (typeof frame.event === "string") {
			for (const listener of this.#listeners.get(frame.event) ?? []) listener(frame.data, bin, core.generation);
			return;
		}
		if (typeof frame.id !== "number") return;
		if (core === this.#child) this.#failedStarts = 0;
		this.#answeredBy.add(core);
		const pending = this.#pending.get(frame.id);
		if (!pending) {
			const late = this.#late.get(frame.id);
			if (late?.core === core) {
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
		if (frame.ok) pending.resolve({ result: frame.result, bin, generation: core.generation });
		else
			pending.reject(
				new CoreError(
					frame.error?.code ?? "internal",
					frame.error?.message ?? `ompdesk-core refused ${pending.method}`,
				),
			);
	}

	#ended(core: Running, error: CoreError, exit: { code: number | null; signal: string | null }): void {
		if (core.ended) return;
		core.ended = true;
		core.link.close();
		for (const folder of [core.hub.folder, core.clients.folder])
			if (folder) rmSync(folder, { recursive: true, force: true });
		const expected = this.#stopping.has(core);
		this.#stopping.add(core);
		const abandonedAt = this.#abandoned.get(core);
		if (!expected || abandonedAt !== undefined)
			this.report?.("ended", {
				generation: core.generation,
				code: exit.code ?? -1,
				signal: exit.signal ?? "",
				abandoned: abandonedAt !== undefined,
				// How long the killed core took to end: seconds mean the whole computer stalled, not only the core.
				...(abandonedAt !== undefined ? { exitMs: Date.now() - abandonedAt } : {}),
				answered: this.#answeredBy.has(core),
				stderr: core.stderr.map(line => redactDiagnosticsText(line).slice(0, STDERR_LINE_CHARS)).join("\n"),
			});
		if (this.#child === core) {
			this.#child = null;
			if (!this.#answeredBy.has(core) && ++this.#failedStarts >= MAX_FAILED_STARTS) {
				this.#failedStarts = 0;
				this.#restUntil = Date.now() + FAILED_START_REST_MS;
				this.report?.("rest", { failedStarts: MAX_FAILED_STARTS, restMs: FAILED_START_REST_MS });
			}
		}
		if (!expected) this.#log(error.message);
		// What lived in that core (a remote link, a listener) is gone with it.
		for (const listener of this.#listeners.get(CORE_EXITED) ?? []) listener(null, null, core.generation);
		const waiting = [...this.#pending].filter(([, pending]) => pending.core === core);
		for (const [id, pending] of waiting) {
			this.#pending.delete(id);
			clearTimeout(pending.timer);
			pending.detach();
		}
		const late = [...this.#late].filter(([, entry]) => entry.core === core);
		for (const [id] of late) this.#late.delete(id);
		// What waited settles once every git the core started is gone: a lock's next holder starts only then.
		void core.gone.promise.then(empty => {
			const failure = empty
				? error
				: new CoreError(error.code, `${error.message}; git processes it started may still run`);
			if (!empty) this.#log(`ompdesk-core: ${failure.message} (its process group outlived its bound)`);
			for (const [, pending] of waiting) {
				pending.onEnded?.();
				pending.reject(failure);
			}
			for (const [, entry] of late) entry.onEnded();
			if (empty) this.#stopping.delete(core);
		});
	}
}

/**
 * A new private place to listen: on POSIX a socket in a folder only this user may open (0700, `mkdtemp`), on Windows a
 * pipe whose name nobody can guess; with a token the connection proves either way.
 */
function place(name: string): Place {
	const token = randomBytes(24).toString("hex");
	if (!POSIX)
		return { address: `\\\\.\\pipe\\ompdesk-${name}-${randomBytes(16).toString("hex")}`, token, folder: null };
	const folder = mkdtempSync(join(tmpdir(), `ompdesk-${name}-`));
	return { address: join(folder, "s"), token, folder };
}

let instance: CoreProcess | null = null;

/** The app's one core. */
export function core(): CoreProcess {
	instance ??= new CoreProcess({ binary: () => nativeBinPath("ompdesk-core") });
	return instance;
}

/**
 * Whether `error` is the core's refusal of work after the quit began (`shutdown` ran). A timer, a window event or a
 * status listener that reaches the core while the app quits has nothing left to do: its caller drops the error, and
 * one that does not is handled as a `core-shutdown` line by main's last-resort handlers (main-failures.ts).
 */
export function isCoreShutdown(error: unknown): boolean {
	return error instanceof CoreError && error.code === "core_unavailable" && instance?.shuttingDown === true;
}

/**
 * Whether `error` is a hub call main gave up (`hub_unknown`, `core/hub.ts`): the core lives and may still carry the call
 * out. A caller on a timer or a listener drops it and waits for its next turn; one that does not is handled as one `hub`
 * line by main's last-resort handlers (main-failures.ts), never by ending main.
 */
export function isHubGivenUp(error: unknown): boolean {
	return error instanceof CoreError && error.code === "hub_unknown";
}

/**
 * The refusal `#start` throws once `shutdown` ran. Main's hub and pool frames take nine of V8's default ten (the 0.134.0
 * quit logged 6,175 of it with every caller cut off), so it keeps enough frames to name who called.
 */
function shutdownRefusal(): CoreError {
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = Math.max(limit, 40);
	try {
		return new CoreError("core_unavailable", "ompdesk-core is shutting down");
	} finally {
		Error.stackTraceLimit = limit;
	}
}

/** Ends the app's core (quit); a later request starts it again. */
export function stopCore(): Promise<void> {
	return instance?.stop() ?? Promise.resolve();
}

/** Ends the app's core for good, including when it has not started yet. */
export function shutdownCore(force = false): Promise<void> {
	return core().shutdown(force);
}
