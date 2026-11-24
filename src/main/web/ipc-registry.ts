/**
 * The one table of main's IPC handlers. `handle` and `on` register a handler once: on `ipcMain` at that moment
 * (same channel, same arguments, same order as registering it there directly), so the app's own windows reach
 * it exactly as before, and in the table `invoke` and `send` dispatch from, for a caller that does not come
 * through Electron (a paired web device).
 *
 * A handler takes the caller where it took Electron's event. For an Electron call `caller.win` is
 * `BrowserWindow.fromWebContents(event.sender)`, looked up again on every read like the call it replaces, and
 * `caller.sender` is `event.sender`.
 *
 * The channels the core serves (`crates/core/src/ipc`, unit 9a) are registered the same way by `routeCore`, which
 * hands the core `IPC_POLICY` as data and takes its table of channels: each call of one goes to the core's
 * `ipc.call`, every other channel stays here and never touches the core, so a core that is down or resting fails
 * only its own channels.
 *
 * The channels the Tauri shell serves itself (`crates/tauri-shell/src/ipc_router.json`) never reach main from an app
 * page. `routeShell` hands the shell the channels main serves (the shell refuses every other one) and registers each
 * native channel here only for main's own callers (a paired page, an agent), which reach the shell's handler through
 * `ipc.call`. `handle`/`on` refuse a native channel: one channel, one owner.
 */
import { BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { CoreAnswer, CoreCallOptions } from "../core/process";
import { tookIpc } from "../slow-steps";
import type { ClientWindow } from "./client-window";

/** The page that made the call: Electron's `event.sender`. */
export interface IpcSender {
	readonly id: number;
	once(event: "destroyed", listener: () => void): unknown;
}

export interface IpcCaller {
	/** The calling window; null when the sender has none. */
	readonly win: ClientWindow | null;
	/** The same window as Electron's own, for a dialog sheet, the title-bar overlay or the preview; null for a web caller. */
	readonly browserWindow: BrowserWindow | null;
	readonly sender: IpcSender;
	/** A paired web page's connection the call came over (a device's pages share one window); absent for an Electron caller. */
	readonly connId?: string;
}

type IpcHandler = (caller: IpcCaller, ...args: unknown[]) => unknown;

/** A channel and the direction it is called in. */
export interface IpcRoute {
	channel: string;
	dir: "invoke" | "send";
}

/** What `routeShell` needs of the Tauri shell (`shell-host/electron/index.ts`). */
export interface IpcShell {
	/** The channels the shell serves itself: `hello`'s `nativeIpc`. */
	readonly channels: readonly IpcRoute[];
	/** `ipc.routes`: the channels main serves, handed over once. */
	routes(main: { invoke: string[]; send: string[] }): Promise<unknown>;
	/** `ipc.call`: a native channel's call for one of main's callers; the handler's value. */
	call(params: IpcRoute & { caller: IpcCallerParams; args: unknown[] }): Promise<unknown>;
}

/** A caller as the core and the shell take it: its lane key (one per window page, one per paired connection). */
interface IpcCallerParams {
	key: string;
	window: number | null;
	connId: string | null;
}

function callerParams(caller: IpcCaller): IpcCallerParams {
	return {
		key: caller.connId === undefined ? `w${caller.sender.id}` : `c${caller.connId}`,
		window: caller.win?.webContents.id ?? null,
		connId: caller.connId ?? null,
	};
}

/** What `routeCore` needs of the core: `CoreProcess`. */
export interface IpcCore {
	readonly pid: number | null;
	call<T>(method: string, params?: unknown, options?: CoreCallOptions): Promise<CoreAnswer<T>>;
}

/** A channel the core serves, as `ipc.start` names it; its direction is `IPC_POLICY`'s. */
interface CoreChannel {
	channel: string;
	dir: "invoke" | "send";
}

/** A core-served channel's call has no deadline of its own, as an Electron handler has none. */
const CORE_CALL_MS = 2 ** 31 - 1;

/** What the registry registers on: Electron's `ipcMain`. */
interface ElectronIpc {
	handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
	on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown;
}

/** An Electron call's caller: its window is looked up on each read, like the `fromWebContents` call it replaces. */
class ElectronCaller implements IpcCaller {
	readonly sender: WebContents;
	constructor(sender: WebContents) {
		this.sender = sender;
	}
	get win(): ClientWindow | null {
		return BrowserWindow.fromWebContents(this.sender);
	}
	get browserWindow(): BrowserWindow | null {
		return BrowserWindow.fromWebContents(this.sender);
	}
}

/** `handler`, with the slow-step probe told how long its answer took and how much of that held main's thread. */
function timed(channel: string, handler: IpcHandler): IpcHandler {
	return (caller, ...args) => {
		const started = performance.now();
		const result = handler(caller, ...args);
		const syncMs = performance.now() - started;
		const done = () => tookIpc(channel, performance.now() - started, syncMs);
		if (result instanceof Promise) void result.then(done, done);
		else done();
		return result;
	};
}

export class IpcRegistry {
	readonly #ipcMain: ElectronIpc;
	readonly #invokeHandlers = new Map<string, IpcHandler>();
	readonly #sendHandlers = new Map<string, IpcHandler>();
	#core: IpcCore | null = null;
	#coreParams: { policy: Record<string, unknown>; testChannels?: boolean } | null = null;
	/** The core that was handed the policy last; a core started again (another pid) is handed it again first. */
	#startedPid: number | null = null;
	#starting: Promise<unknown> | null = null;
	/** Core calls made while the policy was being handed over, in the order they came; given the hand-over's failure. */
	#held: Array<(failure: unknown) => void> = [];
	/** The channels the Tauri shell serves itself; main registers no handler of its own for them. */
	readonly #native = new Set<string>();

	constructor(ipcMain: ElectronIpc) {
		this.#ipcMain = ipcMain;
	}

	/**
	 * Hands the core `policy` (`IPC_POLICY`) and registers each channel it serves, as `handle`/`on` would. Rejects when
	 * the core cannot be started or refuses the policy; the channels main serves are untouched either way.
	 */
	async routeCore(core: IpcCore, policy: Record<string, unknown>, options: { testChannels?: boolean } = {}) {
		this.#core = core;
		this.#coreParams = { policy, ...(options.testChannels ? { testChannels: true } : {}) };
		const channels = await this.#handOver();
		for (const { channel, dir } of channels) {
			if (dir === "invoke")
				this.handle(channel, (caller, ...args) => this.#viaCore(caller, "invoke", channel, args));
			else
				this.on(channel, (caller, ...args) => {
					this.#viaCore(caller, "send", channel, args).catch((error: unknown) =>
						console.warn(`[ipc] ${channel}: ${error instanceof Error ? error.message : String(error)}`),
					);
				});
		}
	}

	/**
	 * Registers each channel the shell serves for main's own callers only (never on `ipcMain`: an app page's call of one
	 * never comes here), then hands the shell the channels of `policy` (`IPC_POLICY`) main serves. Rejects when a
	 * channel would have both owners or the shell refuses the hand-over; call it before the first window opens.
	 */
	async routeShell(shell: IpcShell, policy: Readonly<Record<string, { dir: string; mode?: string }>>): Promise<void> {
		for (const { channel, dir } of shell.channels) {
			if (this.#invokeHandlers.has(channel) || this.#sendHandlers.has(channel))
				throw new Error(`'${channel}' is served by both main and the shell`);
			this.#native.add(channel);
			const call = (caller: IpcCaller, args: unknown[]) =>
				shell.call({ channel, dir, caller: callerParams(caller), args });
			if (dir === "invoke")
				this.#invokeHandlers.set(
					channel,
					timed(channel, (caller, ...args) => call(caller, args)),
				);
			else
				this.#sendHandlers.set(
					channel,
					timed(channel, (caller, ...args) => {
						call(caller, args).catch((error: unknown) =>
							console.warn(`[ipc] ${channel}: ${error instanceof Error ? error.message : String(error)}`),
						);
					}),
				);
		}
		const main: { invoke: string[]; send: string[] } = { invoke: [], send: [] };
		for (const [channel, { dir, mode }] of Object.entries(policy))
			if ((dir === "invoke" || dir === "send") && mode !== "core" && !this.#native.has(channel))
				main[dir].push(channel);
		await shell.routes(main);
	}

	/** `ipc.start` on the running core (starting it), once at a time; its table of channels. */
	#handOver(): Promise<CoreChannel[]> {
		const core = this.#core;
		if (!core || !this.#coreParams) return Promise.reject(new Error("No core to route IPC to"));
		const started = core.call<{ channels: CoreChannel[] }>("ipc.start", this.#coreParams);
		const pid = core.pid;
		const handed = started.then(
			answer => {
				this.#startedPid = pid;
				return answer.result.channels;
			},
			(error: unknown) => {
				this.#startedPid = null;
				throw error;
			},
		);
		this.#starting = handed.then(
			() => undefined,
			(error: unknown) => error ?? new Error("ompdesk-core refused IPC_POLICY"),
		);
		void this.#starting.then(failure => {
			this.#starting = null;
			const held = this.#held;
			this.#held = [];
			for (const send of held) send(failure);
		});
		return handed;
	}

	/**
	 * A call of a core-served channel. Its line is written to the core at once, so a page's calls reach the core in the
	 * order Electron ran their handlers; a call that finds the core started again (or not yet handed the policy) waits,
	 * behind the calls already waiting, until the policy is handed over again.
	 */
	#viaCore(caller: IpcCaller, dir: "invoke" | "send", channel: string, args: unknown[]): Promise<unknown> {
		const core = this.#core;
		if (!core) return Promise.reject(new Error(`No handler registered for '${channel}'`));
		const params = {
			// The lane the call is ordered in, in the core: one per window page, one per paired page's connection.
			caller: callerParams(caller),
			channel,
			dir,
			args,
		};
		const send = (): Promise<unknown> =>
			core
				.call<{ value: unknown }>("ipc.call", params, { timeoutMs: CORE_CALL_MS })
				.then(answer => answer.result.value);
		const current = this.#startedPid !== null && core.pid === this.#startedPid;
		if (current && !this.#starting) return send();
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#held.push(failure => {
			if (failure !== undefined) reject(failure);
			else send().then(resolve, reject);
		});
		if (!this.#starting) this.#handOver().catch(() => undefined);
		return promise;
	}

	/** An invoke channel's handler; its result (or rejection) is the caller's. A second one for a channel throws, as in Electron. */
	handle<A extends unknown[]>(channel: string, handler: (caller: IpcCaller, ...args: A) => unknown): void {
		// The IPC boundary is untyped: each handler checks the arguments it declares.
		if (this.#native.has(channel)) throw new Error(`'${channel}' is the shell's (ipc_router.json), not main's`);
		const run = timed(channel, handler as IpcHandler);
		this.#ipcMain.handle(channel, (event, ...args: unknown[]) => run(new ElectronCaller(event.sender), ...args));
		this.#invokeHandlers.set(channel, run);
	}

	/** A fire-and-forget channel's handler (the renderer's `send`). One per channel. */
	on<A extends unknown[]>(channel: string, handler: (caller: IpcCaller, ...args: A) => void): void {
		if (this.#native.has(channel)) throw new Error(`'${channel}' is the shell's (ipc_router.json), not main's`);
		if (this.#sendHandlers.has(channel)) throw new Error(`Attempted to register a second listener for '${channel}'`);
		const run = timed(channel, handler as IpcHandler);
		this.#ipcMain.on(channel, (event, ...args: unknown[]) => run(new ElectronCaller(event.sender), ...args));
		this.#sendHandlers.set(channel, run);
	}

	/** Run an invoke channel's handler for a caller outside Electron; rejects for a channel nobody handles, as Electron does. */
	async invoke(channel: string, caller: IpcCaller, args: readonly unknown[]): Promise<unknown> {
		const handler = this.#invokeHandlers.get(channel);
		if (!handler) throw new Error(`No handler registered for '${channel}'`);
		return handler(caller, ...args);
	}

	/** Run a fire-and-forget channel's handler for a caller outside Electron; a channel nobody listens on is dropped. */
	send(channel: string, caller: IpcCaller, args: readonly unknown[]): void {
		this.#sendHandlers.get(channel)?.(caller, ...args);
	}
}
