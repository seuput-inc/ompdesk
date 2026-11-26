/**
 * What each open tab's processes listen on (`get_session_ports`: the tab's computer lists the TCP ports of the
 * processes carrying its session tag, core `procs.ports`). Orca scans a workspace's listening ports every 30 s while
 * its window shows (`components/ports/WorkspacePortScanner.tsx:25`, `WORKSPACE_PORT_SCAN_INTERVAL_MS`); here the
 * sidebar's rows and the Preview's start page read the tabs they hold the same way, and main answers every tab from
 * one scan (`PORTS_FRESH_MS`). A tab whose computer cannot say (an older paired host, no tag yet) reads none.
 * Reading, ending and opening live in `lib/session-port-actions.ts`, loaded on first use: the phone's first screen
 * holds the sidebar.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { SessionPortProcess } from "../../shared/rpc-types";
import { pollWhileVisible } from "../lib/visible-poll";

/** How often the tabs a surface holds are read while the window shows (Orca's 30 s). */
export const SESSION_PORTS_POLL_MS = 30_000;

interface SessionPortsState {
	/** Each tab's listening processes, by tab id; absent before its first answer. */
	byTab: Record<string, SessionPortProcess[]>;
	reset: () => void;
}

export const useSessionPortsStore = create<SessionPortsState>()(set => ({
	byTab: {},
	reset: () => set({ byTab: {} }),
}));

const NONE: SessionPortProcess[] = [];

/** Keeps the ports of `tabIds` read while the window shows: now, then every `SESSION_PORTS_POLL_MS`. */
export function useSessionPortsPoll(tabIds: readonly string[]): void {
	const key = [...tabIds].sort().join(" ");
	useEffect(() => {
		if (!key) return;
		const ids = key.split(" ");
		const tick = () =>
			void import("../lib/session-port-actions").then(
				actions => {
					for (const id of ids) void actions.readSessionPorts(id);
				},
				() => undefined,
			);
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
