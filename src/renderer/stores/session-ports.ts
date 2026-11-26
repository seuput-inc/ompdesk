/**
 * What each open tab's processes listen on (`get_session_ports`: the tab's computer lists the TCP ports of the
 * processes carrying its session tag, core `procs.ports`). Orca scans a workspace's listening ports every 30 s while
 * its window shows (`components/ports/WorkspacePortScanner.tsx:25`, `WORKSPACE_PORT_SCAN_INTERVAL_MS`); here the
 * sidebar's rows and the Preview's start page read the tabs they hold the same way, and main answers every tab from
 * one scan (`PORTS_FRESH_MS`). A tab whose computer cannot say (an older paired host, no tag yet) reads none.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { portAddress } from "../../shared/preview";
import type { SessionPortProcess } from "../../shared/rpc-types";
import { pollWhileVisible } from "../lib/visible-poll";
import { useTabsStore } from "./tabs";
import { useUiStore } from "./ui";

/** How often the tabs a surface holds are read while the window shows (Orca's 30 s). */
export const SESSION_PORTS_POLL_MS = 30_000;

interface SessionPortsState {
	/** Each tab's listening processes, by tab id; absent before its first answer. */
	byTab: Record<string, SessionPortProcess[]>;
	reset: () => void;
}

export const useSessionPortsStore = create<SessionPortsState>()(set => ({
	byTab: {},
	reset: () => {
		reads.clear();
		set({ byTab: {} });
	},
}));

const NONE: SessionPortProcess[] = [];
/** The read under way for each tab: a second ask joins it. */
const reads = new Map<string, Promise<void>>();

function portsOf(data: unknown): SessionPortProcess[] {
	if (!Array.isArray(data)) return NONE;
	return data.filter(
		(row): row is SessionPortProcess =>
			typeof row === "object" &&
			row !== null &&
			typeof row.pid === "number" &&
			typeof row.name === "string" &&
			Array.isArray(row.ports) &&
			row.ports.every((port: unknown) => Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536),
	);
}

/** Reads `tabId`'s listening processes; a failed read keeps what was known. */
export function readSessionPorts(tabId: string): Promise<void> {
	const running = reads.get(tabId);
	if (running) return running;
	// A transport that throws at once (a page whose link is down) fails the read like a refused one.
	const read = Promise.resolve()
		.then(() => window.omp.rpc.commandForTab(tabId, { type: "get_session_ports" }))
		.then(
			response => {
				if (!response?.success) return;
				const ports = portsOf(response.data);
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

/** Keeps the ports of `tabIds` read while the window shows: now, then every `SESSION_PORTS_POLL_MS`. */
export function useSessionPortsPoll(tabIds: readonly string[]): void {
	const key = [...tabIds].sort().join(" ");
	useEffect(() => {
		const ids = key ? key.split(" ") : [];
		if (ids.length === 0) return;
		const tick = () => {
			for (const id of ids) void readSessionPorts(id);
		};
		tick();
		return pollWhileVisible(tick, SESSION_PORTS_POLL_MS);
	}, [key]);
}

/** One tab's listening processes (none before its first answer). */
export function useSessionPorts(tabId: string | null | undefined): SessionPortProcess[] {
	return useSessionPortsStore(state => (tabId ? (state.byTab[tabId] ?? NONE) : NONE));
}

/** Every port of a tab's listening processes, ascending, each once. */
export function listeningPorts(processes: readonly SessionPortProcess[]): number[] {
	return [...new Set(processes.flatMap(process => process.ports))].sort((a, b) => a - b);
}

/** A row's ports in words for its tooltip and screen-reader text ("Listening on :3000, :5173"); null without any. */
export function sessionPortsWords(
	t: (key: string, params?: Record<string, string | number>) => string,
	processes: readonly SessionPortProcess[],
): string | null {
	const ports = listeningPorts(processes);
	return ports.length ? t("sidebar.ports.tip", { ports: ports.map(port => `:${port}`).join(", ") }) : null;
}

/**
 * Shows `tabId` and opens `port` in its Preview: `localhost`, or the worktree's own `<name>.localhost` for a session
 * in a linked worktree (FX25), so worktrees never share a dev server's cookies.
 */
export async function openSessionPort(tabId: string, port: number, worktreeFolder?: string | null): Promise<void> {
	const tabs = useTabsStore.getState();
	if (tabs.activeTabId !== tabId) await tabs.switchTab(tabId);
	useUiStore.getState().openPreview(portAddress(port, worktreeFolder));
}
