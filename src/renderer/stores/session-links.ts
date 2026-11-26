/**
 * This computer's session links (`session_links`, src/main/local/session-links.ts), shared by every row: read once
 * when the first row asks, again on each `SESSION_LINKS_CHANGED` push (a change from any window, phone page or agent)
 * and on a web page's catch-up after its link was down.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { SessionLink } from "../../shared/session-links";
import { webRuntime } from "../web/runtime";

interface SessionLinksState {
	links: Record<string, SessionLink[]>;
	reset: () => void;
}

export const useSessionLinksStore = create<SessionLinksState>()(set => ({
	links: {},
	reset: () => {
		stop?.();
		stop = null;
		reads = 0;
		set({ links: {} });
	},
}));

const NONE: SessionLink[] = [];
let stop: (() => void) | null = null;
let reads = 0;

/** Reads every session's links; an answer older than a read started after it is dropped. */
export async function readSessionLinks(): Promise<void> {
	const read = ++reads;
	try {
		const response = await window.omp.rpc.sessionLinks();
		if (read === reads && response.success && response.data && typeof response.data === "object")
			useSessionLinksStore.setState({ links: response.data as Record<string, SessionLink[]> });
	} catch {
		// The next change push reads again.
	}
}

function start(): void {
	if (stop) return;
	const offChanged = window.omp.events.onSessionLinksChanged(() => void readSessionLinks());
	const offResynced = webRuntime()?.onResynced(() => void readSessionLinks());
	stop = () => {
		offChanged();
		offResynced?.();
	};
	void readSessionLinks();
}

/** The links attached to a session of this computer (newest last). */
export function useSessionLinks(sessionPath: string): SessionLink[] {
	useEffect(start, []);
	return useSessionLinksStore(state => state.links[sessionPath] ?? NONE);
}

/** Every session's links on this computer, by session path (the sidebar's rows read theirs from it). */
export function useAllSessionLinks(): Readonly<Record<string, SessionLink[]>> {
	useEffect(start, []);
	return useSessionLinksStore(state => state.links);
}
