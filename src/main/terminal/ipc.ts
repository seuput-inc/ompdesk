import { ipcErrorCode } from "../../shared/ipc-error-codes";
import {
	TERMINAL_OUTPUT_BUDGET,
	TERMINAL_POLL_MAX_WAIT_MS,
	type TerminalLeaseState,
	type TerminalOperation,
	type TerminalShell,
	type TerminalSnapshot,
} from "../../shared/terminal-types";
import { controlEnvFor } from "../control-socket/env";
import { core } from "../core/process";
import type { RemoteDevices } from "../remote/devices";
import type { SidecarPool } from "../sidecar-pool";
import { stockHelperHost } from "../stock-helper";
import { isWebWindow } from "../web/client-window";
import type { IpcRegistry } from "../web/ipc-registry";
import { terminalReadOptions } from "./agent-tool";
import { disposeTerminals, readTerminalOutput, terminalRequest, validTerminalOperation } from "./requests";
import { detectShells } from "./shells";

const owners = new Set<string>();
export function closeTabTerminals(windowId: number, tabId: string): void {
	const owner = `${windowId}:${tabId}`;
	if (owners.delete(owner)) disposeTerminals(owner);
}
/** Reads on the machine that owns this tab's PTYs. Unopened local tabs do not start a worker. */
export async function readTabTerminals(
	remoteDevices: Pick<RemoteDevices, "request">,
	tab: { tabId: string; webContentsId: number; cwd: string; device: string | undefined },
	args: Record<string, unknown>,
): Promise<string | null> {
	const read = terminalReadOptions(args);
	if (tab.device) {
		try {
			const text = await remoteDevices.request<unknown>(tab.device, "terminal.read", { rtab: tab.tabId, read });
			if (text !== null && typeof text !== "string") throw new Error("Invalid terminal.read response");
			return text;
		} catch (error) {
			if (ipcErrorCode(error) !== "unsupported") throw error;
		}
		// shortcut: protocol 1 hosts may only list PTYs; remove when protocol 2 requires terminal.read.
		const snapshots = await remoteDevices.request<TerminalSnapshot[]>(tab.device, "terminal.request", {
			rtab: tab.tabId,
			operation: { action: "list" },
		});
		if (!snapshots.length) return null;
		const pick = Number(read.pick) - 1;
		const rows = snapshots.map(({ exited, exitCode, error, output }, index) => ({
			exited,
			exitCode,
			error,
			output: index === pick ? output : undefined,
		}));
		const { bin } = await core().call(
			"terminal.projectLegacy",
			{},
			{ bin: Buffer.from(JSON.stringify({ rows, read })) },
		);
		if (!bin) throw new Error("Missing terminal.read response");
		return JSON.parse(Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength).toString()) as string | null;
	}
	const owner = `${tab.webContentsId}:${tab.tabId}`;
	return owners.has(owner) ? readTerminalOutput(owner, tab.cwd, read) : null;
}
export function registerTerminalIpc(
	ipc: IpcRegistry,
	pool: SidecarPool,
	remoteDevices: Pick<RemoteDevices, "request">,
): void {
	const released = pool.onTabReleased;
	pool.onTabReleased = (tabId, exited) => {
		for (const owner of owners) {
			if (!owner.endsWith(`:${tabId}`)) continue;
			owners.delete(owner);
			disposeTerminals(owner);
		}
		released?.(tabId, exited);
	};
	// A paired host's tab lists and runs the host's shells (C114).
	ipc.handle("terminal:shells", async (caller, tabId?: string): Promise<TerminalShell[]> => {
		const win = caller.win;
		const target = win && typeof tabId === "string" ? pool.tabTarget(win, tabId) : null;
		if (target?.device) return remoteDevices.request<TerminalShell[]>(target.device, "terminal.shells", {});
		return detectShells();
	});
	ipc.handle("terminal:request", async (caller, tabId: string, operation: TerminalOperation) => {
		const win = caller.win;
		const target = win && typeof tabId === "string" ? pool.tabTarget(win, tabId) : null;
		if (!target) throw new Error("Terminal tab not found");
		if (!validTerminalOperation(operation)) throw new Error("Invalid terminal operation");
		// The host owns the PTYs of its tabs and disposes them with the tab.
		if (target.device)
			return remoteDevices.request<TerminalSnapshot[]>(target.device, "terminal.request", {
				rtab: tabId,
				operation,
			});
		// The tab's PTYs are one set whichever window shows it (multi-viewer), keyed by its owner window;
		// the owner's page going away closes them, a viewer's does not.
		const owner = `${target.winId}:${tabId}`;
		if (!owners.has(owner)) {
			owners.add(owner);
			if (caller.sender.id === target.winId)
				caller.sender.once("destroyed", () => closeTabTerminals(target.winId, tabId));
		}
		const viewer = caller.sender.id;
		// A list is a long poll with an output budget (the acknowledgement is the viewer's next request): a web
		// viewer's whatever it asked for, a desktop window's as its viewport asks (bounded by validTerminalOperation).
		let forwarded: TerminalOperation = operation;
		if (operation.action === "list" && isWebWindow(viewer)) {
			forwarded = {
				...operation,
				waitMs: Math.min(operation.waitMs ?? 0, TERMINAL_POLL_MAX_WAIT_MS),
				budget: Math.min(operation.budget ?? TERMINAL_OUTPUT_BUDGET, TERMINAL_OUTPUT_BUDGET),
			};
		}
		// A terminal of a tab the phone page owns is told control is off, as that tab's omp is.
		const host = stockHelperHost();
		const result = await terminalRequest(
			owner,
			target.sidecar.cwd,
			forwarded,
			controlEnvFor(isWebWindow(target.winId)),
			viewer,
		);
		// A tab can close while the lazy Bun worker is starting.
		if (!owners.has(owner)) {
			disposeTerminals(owner);
			return [];
		}
		if (!result.length) return result;
		const standings = await core().call<TerminalLeaseState[]>("terminal.viewerSeen", {
			host,
			owner,
			viewer,
			ids: result.map(snapshot => snapshot.id),
			now: Date.now(),
		});
		if (!owners.has(owner)) return [];
		for (const [i, snapshot] of result.entries()) snapshot.lease = standings.result[i];
		return result;
	});
}
