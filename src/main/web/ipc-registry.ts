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
 * The channels the Tauri shell serves itself (`crates/tauri-shell/src/ipc_router.json`) and the channels the shell
 * forwards directly to `ompdesk-core` (`crates/core/src/ipc/channels.json`, H(c)) never reach main from an app page.
 * `routeShell` hands the shell the channels main serves plus `IPC_POLICY` (the shell passes the policy to each core
 * generation via `ipc.start` and refuses every unlisted channel) and registers each shell-routed channel here only for
 * main's own callers (a paired page, an agent), which reach the shell or core through `ipc.call`. `handle`/`on` refuse
 * a shell-routed channel: one channel, one owner.
 */
import { BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
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
	/** The channels the shell serves itself or forwards directly to `ompdesk-core`: `hello`'s `nativeIpc`. */
	readonly channels: readonly IpcRoute[];
	/** `ipc.routes`: the channels main serves plus `IPC_POLICY` for `ompdesk-core`, handed over once. */
	routes(main: {
		invoke: string[];
		send: string[];
		policy: Readonly<Record<string, { dir: string; mode?: string }>>;
	}): Promise<unknown>;
	/** `ipc.call`: a shell-routed (native or core) channel's call for one of main's callers; the handler's value. */
	call(params: IpcRoute & { caller: IpcCallerParams; args: unknown[] }): Promise<unknown>;
}

/** A caller as the shell and the core take it: its lane key (one per window page, one per paired connection). */
interface IpcCallerParams {
	key: string;
	window: number | null;
	connId: string | null;
	deviceId: string | null;
}

function callerParams(caller: IpcCaller): IpcCallerParams {
	const win = caller.win as (ClientWindow & { deviceId?: unknown }) | null;
	const deviceId = win && typeof win.deviceId === "string" ? win.deviceId : null;
	return {
		key: caller.connId === undefined ? `w${caller.sender.id}` : `c${caller.connId}`,
		window: caller.win?.webContents.id ?? null,
		connId: caller.connId ?? null,
		deviceId,
	};
}

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
	/** The channels the Tauri shell serves itself or routes directly to the core; main registers no handler for them. */
	readonly #native = new Set<string>();

	constructor(ipcMain: ElectronIpc) {
		this.#ipcMain = ipcMain;
	}

	/**
	 * Registers each shell-routed channel (shell-native or core-owned) for main's own callers only (never on `ipcMain`:
	 * an app page's call of one never comes here), then hands the shell the channels of `policy` (`IPC_POLICY`) main
	 * serves along with the full policy for `ompdesk-core`. Rejects when a channel would have both owners or the shell
	 * refuses the hand-over; call it before the first window opens.
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
		const main: {
			invoke: string[];
			send: string[];
			policy: Readonly<Record<string, { dir: string; mode?: string }>>;
		} = { invoke: [], send: [], policy };
		for (const [channel, { dir, mode }] of Object.entries(policy))
			if ((dir === "invoke" || dir === "send") && mode !== "core" && !this.#native.has(channel))
				main[dir].push(channel);
		await shell.routes(main);
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
