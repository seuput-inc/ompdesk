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
import { codedError, ipcErrorCode } from "../../shared/ipc-error-codes";
import {
	EMPTY_SIDEBAR_PROJECTS,
	parseSidebarProjects,
	type SidebarLayout,
	type SidebarLayoutChange,
	type SidebarProjectsRequest,
	type SidebarProjectsState,
} from "../../shared/sidebar-projects";
import { translate } from "../lib/i18n";
import { lastRead, rememberRead } from "../lib/last-read";
import { LOCAL_DEVICE } from "../lib/sidebar-memory";
import { useRemoteStore } from "./remote";
import { toastError } from "./toast";

const SNAPSHOT_KEY = "sidebar-projects";
const pending = new Map<string, symbol>();
/**
 * A host's project folders removed while its link was down, by device, sent when it comes back. In `localStorage`
 * (as the outbox is), so a removal outlives a reload or a restart; memory only where there is none.
 */
const OWED_KEY = "omp.sidebar.owedRemovals.v1";
const owedInMemory: Record<string, string[]> = {};

function owedAll(): Record<string, string[]> {
	try {
		const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(OWED_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : owedInMemory;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, string[]>) : {};
	} catch {
		return owedInMemory;
	}
}

const owedOf = (device: string): string[] => {
	const paths = owedAll()[device];
	return Array.isArray(paths) ? paths.filter(path => typeof path === "string") : [];
};

function setOwed(device: string, paths: string[]): void {
	const all = { ...owedAll(), [device]: paths };
	if (paths.length === 0) delete all[device];
	Object.assign(owedInMemory, { [device]: paths });
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(OWED_KEY, JSON.stringify(all));
	} catch {
		// Private mode or a full quota: memory only, as on the first launch.
	}
}

function online(device: string): boolean {
	return (
		useRemoteStore.getState().state?.hosts.some(host => host.deviceId === device && host.state === "online") === true
	);
}

interface SidebarProjectsStore {
	/** By device (`LOCAL_DEVICE` for this computer). */
	lists: Record<string, SidebarProjectsState>;
	/** A cached list still paints, but only a layout received on the current link can authorize an edit. */
	liveLayouts: Record<string, SidebarLayout | undefined>;
	changeLayout: (device: string, layout: SidebarLayout, change: SidebarLayoutChange) => Promise<void>;
	/** Read (again) a computer's list: at mount, and for a host each time its link comes up. */
	load: (device?: string, read?: boolean) => void;
	/** "Remove from sidebar": its sessions stay, listed under no project. */
	remove: (device: string | undefined, path: string) => Promise<void>;
	/** The person adds a folder (a dropped folder, Show in the deleted list, a moved folder found again), as opening it
	 *  would: listed as theirs, out of the removed list. */
	add: (device: string | undefined, path: string) => Promise<boolean>;
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
	const run = async (device: string | undefined, request: SidebarProjectsRequest) => {
		const key = keyOf(device);
		const token = Symbol();
		pending.set(key, token);
		try {
			const state = parseSidebarProjects(await window.omp.sidebarProjects.command(request, device));
			if (pending.get(key) === token && (device === undefined || online(device))) accept(device, state);
			if (request.action === "layout" && !state.layout) throw codedError("remote_protocol", "No host layout");
		} finally {
			if (pending.get(key) === token) pending.delete(key);
		}
	};
	return {
		lists: {},
		liveLayouts: {},
		changeLayout: async (device, layout, change) => {
			if (!online(device)) throw codedError("remote_offline", "Host is offline");
			if (get().liveLayouts[device] !== layout) throw new Error(translate("prefs.unreadable"));
			await run(device, { action: "layout", change });
		},
		load: (device, read = true) => {
			if (!window.omp?.sidebarProjects) return;
			if (get().lists[keyOf(device)] === undefined) {
				const seed = cached(device);
				if (seed) set(current => ({ lists: { ...current.lists, [keyOf(device)]: seed } }));
			}
			// A list that cannot be read keeps what was known; the sidebar still groups by sessions meanwhile.
			if (read)
				void replayOwed(device)
					.then(() => run(device, { action: "get" }))
					.catch(() => undefined);
		},
		remove: async (device, path) => {
			const before = get().lists[keyOf(device)] ?? EMPTY_SIDEBAR_PROJECTS;
			// The row leaves at once; a refused write puts it back.
			const optimistic = {
				...before,
				projects: before.projects.filter(entry => entry.path !== path),
				removed: [...before.removed.filter(entry => entry !== path), path],
			};
			apply(device, optimistic);
			try {
				await run(device, { action: "remove", path });
			} catch (error) {
				// The host is out of reach: the removal waits for its link, and the row stays gone meanwhile.
				if (device !== undefined && ipcErrorCode(error) === "remote_offline") {
					setOwed(device, [...owedOf(device).filter(entry => entry !== path), path]);
					return;
				}
				if (get().lists[keyOf(device)] === optimistic) apply(device, before);
				toastError({ title: translate("sidebar.removeProjectFailed"), error });
			}
		},
		add: async (device, path) => {
			const before = get().lists[keyOf(device)] ?? EMPTY_SIDEBAR_PROJECTS;
			// It leaves the removed list at once; the host's answer lists the project, a refusal puts it back.
			const optimistic = { ...before, removed: before.removed.filter(entry => entry !== path) };
			apply(device, optimistic);
			try {
				await run(device, { action: "add", path });
				return true;
			} catch (error) {
				if (get().lists[keyOf(device)] === optimistic) apply(device, before);
				toastError({ title: translate("sidebar.project.addFailed"), error });
				return false;
			}
		},
		reset: () => {
			pending.clear();
			set({ lists: {}, liveLayouts: {} });
		},
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
		setOwed(
			device,
			owedOf(device).filter(entry => entry !== path),
		);
	}
}

function accept(device: string | undefined, state: SidebarProjectsState): void {
	const key = keyOf(device);
	pending.delete(key);
	rememberRead(device, SNAPSHOT_KEY, state);
	useSidebarProjects.setState(current => ({
		lists: { ...current.lists, [key]: state },
		...(device === undefined ? {} : { liveLayouts: { ...current.liveLayouts, [device]: state.layout } }),
	}));
}

/** One subscription to every computer's pushed list while any sidebar list is mounted. */
let followers = 0;
let unfollow: (() => void) | null = null;

function follow(): () => void {
	followers += 1;
	if (!unfollow) {
		const stopPush = window.omp?.sidebarProjects?.onState(({ device, state }) => {
			if (device === undefined || online(device)) accept(device, parseSidebarProjects(state));
		});
		const stopLink = useRemoteStore.subscribe((next, prev) => {
			for (const host of prev.state?.hosts ?? []) {
				if (
					host.state !== "online" ||
					next.state?.hosts.some(h => h.deviceId === host.deviceId && h.state === "online")
				)
					continue;
				pending.delete(host.deviceId);
				useSidebarProjects.setState(current => ({
					liveLayouts: { ...current.liveLayouts, [host.deviceId]: undefined },
				}));
			}
		});
		unfollow = () => {
			stopPush?.();
			stopLink();
			pending.clear();
			useSidebarProjects.setState({ liveLayouts: {} });
		};
	}
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
		useSidebarProjects.getState().load(device, read);
	}, [device, read]);
	return useSidebarProjects(state => state.lists[keyOf(device)] ?? EMPTY_SIDEBAR_PROJECTS);
}
