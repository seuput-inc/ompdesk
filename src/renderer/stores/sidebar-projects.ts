/**
 * The sidebar's project lists (contract `src/shared/sidebar-projects.ts`), one per computer: this computer's
 * (`LOCAL_DEVICE`) and each paired host's own, which the host keeps and pushes. The sidebar paints the last read at
 * its first frame (`lib/last-read.ts`) and the live read replaces it in place.
 *
 * A paired host's project removed while its link is down is owed (`OWED_KEY`, kept beside the list): its row stays
 * gone and the removal is sent when the link comes back, before the list is read again. A removal the host refuses
 * then brings the row back with a toast; only one the host made leaves the list for good (after Orca's pending
 * project-removal replay, stablyai/orca `pending-runtime-repo-removal-replay.ts`, MIT; re-implemented).
 */
import { useEffect } from "react";
import { create } from "zustand";
import {
	EMPTY_SIDEBAR_PROJECTS,
	parseSidebarProjects,
	type SidebarProjectsRequest,
	type SidebarProjectsState,
} from "../../shared/sidebar-projects";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import { translate } from "../lib/i18n";
import { lastRead, rememberRead } from "../lib/last-read";
import { LOCAL_DEVICE } from "../lib/sidebar-memory";
import { toastError } from "./toast";

const SNAPSHOT_KEY = "sidebar-projects";
/** A host's project folders removed while its link was down, sent when it comes back. */
const OWED_KEY = "sidebar-projects-owed";

const owedOf = (device: string) => lastRead<string[]>(device, OWED_KEY) ?? [];

interface SidebarProjectsStore {
	/** By device (`LOCAL_DEVICE` for this computer). */
	lists: Record<string, SidebarProjectsState>;
	/** Read (again) a computer's list: at mount, and for a host each time its link comes up. */
	load: (device?: string) => void;
	/** The person opened a folder there: it joins the list (a worktree as its project), removed before or not. */
	add: (device: string | undefined, path: string) => void;
	/** "Remove from sidebar": its sessions stay, listed under no project. */
	remove: (device: string | undefined, path: string) => Promise<void>;
	reset: () => void;
}

const keyOf = (device: string | undefined) => device ?? LOCAL_DEVICE;

function cached(device: string | undefined): SidebarProjectsState | undefined {
	const value = lastRead<unknown>(device, SNAPSHOT_KEY);
	return value === undefined ? undefined : parseSidebarProjects(value);
}

export const useSidebarProjects = create<SidebarProjectsStore>((set, get) => {
	const apply = (device: string | undefined, state: SidebarProjectsState) => {
		rememberRead(device, SNAPSHOT_KEY, state);
		set(current => ({ lists: { ...current.lists, [keyOf(device)]: state } }));
	};
	const run = (device: string | undefined, request: SidebarProjectsRequest) =>
		window.omp.sidebarProjects.command(request, device).then(state => apply(device, parseSidebarProjects(state)));
	return {
		lists: {},
		load: device => {
			if (!window.omp?.sidebarProjects) return;
			if (get().lists[keyOf(device)] === undefined) {
				const seed = cached(device);
				if (seed) set(current => ({ lists: { ...current.lists, [keyOf(device)]: seed } }));
			}
			// A list that cannot be read keeps what was known; the sidebar still groups by sessions meanwhile.
			void replayOwed(device)
				.then(() => run(device, { action: "get" }))
				.catch(() => undefined);
		},
		add: (device, path) => {
			if (!path || !window.omp?.sidebarProjects) return;
			void run(device, { action: "add", path }).catch(() => undefined);
		},
		remove: async (device, path) => {
			const before = get().lists[keyOf(device)] ?? EMPTY_SIDEBAR_PROJECTS;
			// The row leaves at once; a refused write puts it back.
			apply(device, {
				...before,
				projects: before.projects.filter(entry => entry.path !== path),
				removed: [...before.removed.filter(entry => entry !== path), path],
			});
			try {
				await run(device, { action: "remove", path });
			} catch (error) {
				// The host is out of reach: the removal waits for its link, and the row stays gone meanwhile.
				if (device !== undefined && ipcErrorCode(error) === "remote_offline") {
					rememberRead(device, OWED_KEY, [...owedOf(device).filter(entry => entry !== path), path]);
					return;
				}
				apply(device, before);
				toastError({ title: translate("sidebar.removeProjectFailed"), error });
			}
		},
		reset: () => set({ lists: {} }),
	};
});

/** Send a host the removals it is owed, one by one; a refused one leaves the owed list and the next read shows it. */
async function replayOwed(device: string | undefined): Promise<void> {
	if (device === undefined) return;
	for (const path of owedOf(device)) {
		try {
			await window.omp.sidebarProjects.command({ action: "remove", path }, device);
		} catch (error) {
			// Still out of reach: it stays owed for the next time the link comes up.
			if (ipcErrorCode(error) === "remote_offline") return;
			toastError({ title: translate("sidebar.removeProjectFailed"), error });
		}
		rememberRead(
			device,
			OWED_KEY,
			owedOf(device).filter(entry => entry !== path),
		);
	}
}

/** One subscription to every computer's pushed list while any sidebar list is mounted. */
let followers = 0;
let unfollow: (() => void) | null = null;

function follow(): () => void {
	followers += 1;
	unfollow ??=
		window.omp?.sidebarProjects?.onState(update =>
			useSidebarProjects.setState(current => {
				const state = parseSidebarProjects(update.state);
				rememberRead(update.device, SNAPSHOT_KEY, state);
				return { lists: { ...current.lists, [keyOf(update.device)]: state } };
			}),
		) ?? null;
	return () => {
		followers -= 1;
		if (followers > 0) return;
		unfollow?.();
		unfollow = null;
	};
}

/**
 * A computer's list (empty until known), read at mount and, for a paired host, each time `read` turns on (its link
 * came up: changes it pushed while away were missed).
 */
export function useProjectList(device?: string, read = true): SidebarProjectsState {
	useEffect(follow, []);
	useEffect(() => {
		if (read) useSidebarProjects.getState().load(device);
	}, [device, read]);
	return useSidebarProjects(state => state.lists[keyOf(device)] ?? EMPTY_SIDEBAR_PROJECTS);
}
