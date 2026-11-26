/**
 * Reading, ending and opening a tab's listening ports (`stores/session-ports.ts` holds what was read). Loaded on first
 * use, since the phone's first screen holds the sidebar that polls.
 */
import { portAddress } from "../../shared/preview";
import type { SessionPortProcess } from "../../shared/rpc-types";
import { useSessionPortsStore } from "../stores/session-ports";
import { useTabsStore } from "../stores/tabs";
import { useUiStore } from "../stores/ui";
import { hostPortUrl } from "./host-ports";

/** The read under way for each tab: a second ask joins it. */
const reads = new Map<string, Promise<void>>();

/** Reads `tabId`'s listening processes; a failed read keeps what was known. */
export function readSessionPorts(tabId: string): Promise<void> {
	const running = reads.get(tabId);
	if (running) return running;
	// A transport that throws at once (a page whose link is down) fails the read like a refused one.
	const read = Promise.resolve()
		.then(() => window.omp.rpc.commandForTab(tabId, { type: "get_session_ports" }))
		.then(
			response => {
				if (!response?.success || !Array.isArray(response.data)) return;
				const ports = response.data as SessionPortProcess[];
				useSessionPortsStore.setState(state => ({ byTab: { ...state.byTab, [tabId]: ports } }));
			},
			() => undefined,
		)
		.finally(() => reads.delete(tabId));
	reads.set(tabId, read);
	return read;
}

/** Ends one of `tabId`'s listening processes by its id and start, then reads the tab again; whether it is gone. */
export async function endSessionPort(tabId: string, process: SessionPortProcess): Promise<boolean> {
	if (process.startedMs === undefined) return false;
	const response = await window.omp.rpc.commandForTab(tabId, {
		type: "end_session_port",
		pid: process.pid,
		startedMs: process.startedMs,
	});
	await readSessionPorts(tabId);
	return response.success && (response.data as { ended?: unknown } | undefined)?.ended === true;
}

/**
 * Shows `tabId` and opens `port` in its Preview: `localhost`, or the worktree's own `<name>.localhost` for a session
 * in a linked worktree (FX25), so worktrees never share a dev server's cookies. A tab on a paired host opens through
 * this computer's stand-in for the host's server (`preview.hostPort`).
 */
export async function openSessionPort(tabId: string, port: number, worktreeFolder?: string | null): Promise<void> {
	const tabs = useTabsStore.getState();
	const remote = tabs.tabs.find(tab => tab.id === tabId)?.device;
	const url = remote ? await hostPortUrl(tabId, port) : portAddress(port, worktreeFolder);
	if (tabs.activeTabId !== tabId) await tabs.switchTab(tabId);
	useUiStore.getState().openPreview(url);
}
