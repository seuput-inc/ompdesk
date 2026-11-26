import { beforeEach, describe, expect, it, vi } from "vitest";
import { codedError } from "../../shared/ipc-error-codes";
import type { HostView, RemoteState } from "../../shared/ipc-types";
import type { SidebarProjectsRequest, SidebarProjectsState } from "../../shared/sidebar-projects";
import { resetLastReadForTest } from "../lib/last-read";
import { useRemoteStore } from "./remote";
import { useSidebarProjects } from "./sidebar-projects";
import { useToastStore } from "./toast";

const HOST = "pc-b";
const listed = (paths: readonly string[]): SidebarProjectsState => ({
	projects: paths.map(path => ({ path, addedAt: 1 })),
	removed: [],
	worktrees: {},
});

/** The host's own list and its link, answered as main would. */
const pc = { paths: [] as string[], online: true, refuse: null as string | null };
const command = vi.fn(async (request: SidebarProjectsRequest, device?: string) => {
	if (device !== HOST) throw new Error("only the host here");
	if (!pc.online) throw codedError("remote_offline", "pc-b is offline");
	if (request.action === "remove") {
		if (request.path === pc.refuse) throw new Error("the host refused");
		pc.paths = pc.paths.filter(path => path !== request.path);
	}
	return listed(pc.paths);
});
(globalThis as Record<string, unknown>).window = { omp: { sidebarProjects: { command, onState: () => () => {} } } };
/** The page's `localStorage`, where an owed removal outlives a restart. */
const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
	getItem: (key: string) => storage.get(key) ?? null,
	setItem: (key: string, value: string) => storage.set(key, value),
};

function setOnline(online: boolean): void {
	pc.online = online;
	const view: Pick<HostView, "deviceId" | "state"> = { deviceId: HOST, state: online ? "online" : "offline" };
	const state: Pick<RemoteState, "hosts"> = { hosts: [view as HostView] };
	useRemoteStore.setState({ state: state as RemoteState });
}

const shown = () => useSidebarProjects.getState().lists[HOST]?.projects.map(project => project.path);

/** The link comes up: the sidebar reads the host's list again, and the read lands. */
async function linkUp(): Promise<void> {
	setOnline(true);
	const reads = command.mock.calls.filter(([request]) => request.action === "get").length;
	useSidebarProjects.getState().load(HOST);
	await vi.waitFor(() =>
		expect(command.mock.calls.filter(([request]) => request.action === "get").length).toBe(reads + 1),
	);
	await command.mock.results.at(-1)?.value;
}

beforeEach(async () => {
	resetLastReadForTest();
	useSidebarProjects.getState().reset();
	useToastStore.setState({ toasts: [] });
	command.mockClear();
	Object.assign(pc, { paths: ["/a", "/b"], online: true, refuse: null });
	await linkUp();
});

describe("a paired host's project removed while its link is down", () => {
	it("leaves the row at once and reaches the host, once, when its link comes back", async () => {
		setOnline(false);
		await useSidebarProjects.getState().remove(HOST, "/a");
		expect(shown()).toEqual(["/b"]);
		expect(pc.paths).toEqual(["/a", "/b"]);
		expect(useToastStore.getState().toasts).toEqual([]);
		await linkUp();
		expect(pc.paths).toEqual(["/b"]);
		expect(shown()).toEqual(["/b"]);
		command.mockClear();
		await linkUp();
		expect(command.mock.calls.map(([request]) => request.action)).toEqual(["get"]);
	});

	it("brings the row back with a toast when the host refuses the owed removal", async () => {
		setOnline(false);
		await useSidebarProjects.getState().remove(HOST, "/a");
		pc.refuse = "/a";
		await linkUp();
		expect(shown()).toEqual(["/a", "/b"]);
		expect(useToastStore.getState().toasts).toHaveLength(1);
	});

	it("sends a removal owed from before a restart, kept in the page's storage", async () => {
		storage.set("omp.sidebar.owedRemovals.v1", JSON.stringify({ [HOST]: ["/a"] }));
		await linkUp();
		expect(pc.paths).toEqual(["/b"]);
		expect(JSON.parse(storage.get("omp.sidebar.owedRemovals.v1") ?? "{}")).toEqual({});
	});
});
