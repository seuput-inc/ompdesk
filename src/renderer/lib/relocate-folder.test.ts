import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRepoInput } from "../components/agents/github/GithubRepos";
import { useSidebarProjects } from "../stores/sidebar-projects";
import { useToastStore } from "../stores/toast";
import { relocateFolder } from "./relocate-folder";

function installOmp(picked: string | null, refuse: ReadonlySet<string> = new Set()) {
	const lists: Record<
		string,
		{ projects: { path: string; addedAt: number }[]; removed: string[]; worktrees: object }
	> = {
		local: { projects: [{ path: "/old/alpha", addedAt: 1 }], removed: [], worktrees: {} },
	};
	const omp = {
		system: { showOpenDialog: vi.fn(async () => (picked ? [picked] : undefined)) },
		sessions: {
			move: vi.fn(async (path: string, cwd: string) => {
				if (refuse.has(path)) throw new Error("Session is open in a tab");
				return `${cwd}/${path.split("/").at(-1)}`;
			}),
		},
		sidebarProjects: {
			command: vi.fn(async (request: { action: string; path: string }) => {
				const list = lists.local;
				if (!list) throw new Error("no list");
				if (request.action === "add") list.projects = [...list.projects, { path: request.path, addedAt: 2 }];
				if (request.action === "remove") {
					list.projects = list.projects.filter(project => project.path !== request.path);
					list.removed = [...list.removed, request.path];
				}
				return { ...list };
			}),
			onState: vi.fn(() => () => {}),
		},
	};
	vi.stubGlobal("window", { omp });
	useSidebarProjects.setState({
		lists: { local: { projects: [{ path: "/old/alpha", addedAt: 1 }], removed: [], worktrees: {} } },
	});
	return omp;
}

const SESSIONS = [
	{ path: "/s/one.jsonl", cwd: "/old/alpha" },
	{ path: "/s/two.jsonl", cwd: "/old/alpha/packages/web" },
	{ path: "/s/three.jsonl", cwd: "/old/alphabet" },
	{ path: "/s/four.jsonl", cwd: "/elsewhere" },
];

afterEach(() => {
	vi.unstubAllGlobals();
	useSidebarProjects.getState().reset();
	useToastStore.setState({ toasts: [] });
});

describe("relocateFolder", () => {
	it("moves the folder's sessions, subfolders kept, lists the new folder and drops the old one", async () => {
		const omp = installOmp("/new/alpha");
		expect(await relocateFolder({ from: "/old/alpha", sessions: SESSIONS })).toBe("/new/alpha");
		// A folder that only starts with the same letters (`/old/alphabet`) is another folder.
		expect(omp.sessions.move.mock.calls).toEqual([
			["/s/one.jsonl", "/new/alpha", undefined],
			["/s/two.jsonl", "/new/alpha/packages/web", undefined],
		]);
		expect(omp.sidebarProjects.command.mock.calls.map(call => call[0])).toEqual([
			{ action: "add", path: "/new/alpha" },
			{ action: "remove", path: "/old/alpha" },
		]);
		expect(useSidebarProjects.getState().lists.local?.projects.map(project => project.path)).toEqual(["/new/alpha"]);
	});

	it("moves nothing when the picker is cancelled", async () => {
		const omp = installOmp(null);
		expect(await relocateFolder({ from: "/old/alpha", sessions: SESSIONS })).toBeNull();
		expect(omp.sessions.move).not.toHaveBeenCalled();
		expect(omp.sidebarProjects.command).not.toHaveBeenCalled();
	});

	it("leaves a session a tab holds where it was and says some stayed", async () => {
		installOmp("/new/alpha", new Set(["/s/one.jsonl"]));
		await relocateFolder({ from: "/old/alpha", sessions: SESSIONS });
		const toast = useToastStore.getState().toasts.at(-1);
		expect(toast?.variant).toBe("error");
		expect(toast?.title).toContain("1");
	});
});

describe("parseRepoInput", () => {
	it("reads OWNER/NAME, a URL and an SSH address, with the host only when it is not github.com", () => {
		expect(parseRepoInput(" stablyai/orca ")).toEqual({ repo: "stablyai/orca" });
		expect(parseRepoInput("https://github.com/stablyai/orca.git")).toEqual({ repo: "stablyai/orca" });
		expect(parseRepoInput("git@github.com:stablyai/orca.git")).toEqual({ repo: "stablyai/orca" });
		expect(parseRepoInput("https://ghe.example.com/team/tool/")).toEqual({
			repo: "team/tool",
			host: "ghe.example.com",
		});
		expect(parseRepoInput("not a repo")).toBeNull();
		expect(parseRepoInput("https://github.com/stablyai")).toBeNull();
	});
});
