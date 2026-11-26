/**
 * Session links by computer (`window.omp.sessions.links`, answered by src/main/local/session-links.ts on the computer
 * that runs the session), shared by every row: a computer's are read once when its first row asks, again on each
 * `SESSION_LINKS_CHANGED` push naming it (a change from any window, phone page, agent or paired device, or its host
 * coming back online) and on a web page's catch-up after its link was down. `""` is this computer.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { SessionLink } from "../../shared/session-links";
import { webRuntime } from "../web/runtime";

type Links = Record<string, SessionLink[]>;

interface SessionLinksState {
	/** Computer (`""` this one, else a paired host's id) → session path → its links. */
	links: Record<string, Links>;
	reset: () => void;
}

export const useSessionLinksStore = create<SessionLinksState>()(set => ({
	links: {},
	reset: () => {
		stop?.();
		stop = null;
		reads.clear();
		set({ links: {} });
	},
}));

const NONE: SessionLink[] = [];
const NO_LINKS: Links = {};
let stop: (() => void) | null = null;
/** Each computer whose links a row asked for, with its latest read's number. */
const reads = new Map<string, number>();

/** Reads one computer's links; an answer older than a read of it started after it is dropped. */
export async function readSessionLinks(device = ""): Promise<void> {
	const read = (reads.get(device) ?? 0) + 1;
	reads.set(device, read);
	try {
		const links = await window.omp.sessions.links({ type: "session_links" }, device || undefined);
		if (reads.get(device) === read && links && typeof links === "object")
			useSessionLinksStore.setState(state => ({ links: { ...state.links, [device]: links as Links } }));
	} catch {
		// The next change push (or the host's return) reads again.
	}
}

function listen(): void {
	if (stop) return;
	const offChanged = window.omp.events.onSessionLinksChanged(change => {
		const device = change.device ?? "";
		if (reads.has(device)) void readSessionLinks(device);
	});
	const offResynced = webRuntime()?.onResynced(() => {
		for (const device of reads.keys()) void readSessionLinks(device);
	});
	stop = () => {
		offChanged();
		offResynced?.();
	};
}

function start(device: string): void {
	listen();
	if (!reads.has(device)) void readSessionLinks(device);
}

/** The links attached to a session of this computer or of the paired host `device` (newest last). */
export function useSessionLinks(sessionPath: string, device?: string): SessionLink[] {
	const key = device ?? "";
	useEffect(() => start(key), [key]);
	return useSessionLinksStore(state => state.links[key]?.[sessionPath] ?? NONE);
}

/** Every session's links on this computer or on the paired host `device`, by session path (rows read theirs from it). */
export function useAllSessionLinks(device?: string): Readonly<Links> {
	const key = device ?? "";
	useEffect(() => start(key), [key]);
	return useSessionLinksStore(state => state.links[key] ?? NO_LINKS);
}
