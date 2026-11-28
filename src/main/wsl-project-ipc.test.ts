import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_COMMANDS } from "../shared/ipc-types";
import type { IpcCaller } from "./web/ipc-registry";
import { registerWslProjectIpc } from "./wsl-project-ipc";

const { call, exists } = vi.hoisted(() => ({ call: vi.fn(), exists: vi.fn() }));
vi.mock("./core/process", () => ({ core: () => ({ call }) }));
vi.mock("./canonical-cwd", () => ({ canonicalCwd: (cwd: string) => cwd, directoryExists: exists }));

const cwd = String.raw`\\wsl.localhost\Distro\home\Project`;
const profile = String.raw`C:\test-profile`;
const id = "{bbcd0123-1234-5678-90ab-0123456789ab}";
const get = IPC_COMMANDS.WSL_PROJECT_GET;
const set = IPC_COMMANDS.WSL_PROJECT_SET;

function rig(hostProfile: string | null = profile) {
	const handlers = new Map<string, (caller: IpcCaller, ...args: unknown[]) => Promise<unknown>>();
	const win = { webContents: { id: 10 } };
	const caller = { browserWindow: win, win, sender: { id: 10 } } as unknown as IpcCaller;
	const tab = { tabId: "tab", winId: 10, device: undefined as string | undefined };
	const projects = [{ path: cwd, missing: false }];
	const hosted = vi.fn(() => false);
	const windowRecord = vi.fn<() => object | null>(() => ({}));
	registerWslProjectIpc(
		{
			ipc: { handle: handlers.set.bind(handlers) },
			sidecarPool: { tabTarget: () => tab, isHostedView: hosted },
			sidebarProjects: { state: () => ({ projects }) },
			windowManager: { recordFor: windowRecord },
		} as unknown as Parameters<typeof registerWslProjectIpc>[0],
		hostProfile,
	);
	const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(caller, ...args);
	return { invoke, caller, tab, projects, hosted, windowRecord };
}

beforeEach(() => {
	exists.mockReset().mockResolvedValue(true);
	call.mockReset();
});

describe("project execution host IPC", () => {
	it("uses the profile and exact project known to main, preserving guest path case", async () => {
		const { invoke } = rig();
		const result = { selected: id, distributions: [{ id, name: "Distro", version: 2, isDefault: false }] };
		call.mockResolvedValue({ result });
		expect(await invoke(get, cwd)).toEqual(result);
		await invoke(set, cwd, id);
		expect(await invoke(set, cwd, null)).toBeUndefined();
		expect(call.mock.calls).toEqual([
			["setup.wslProjectGet", { profile, cwd }],
			["setup.wslProjectSet", { profile, cwd, id }],
			["setup.wslProjectSet", { profile, cwd, id: null }],
		]);
	});

	it.each(["other OS", "agent", "web", "remote tab", "viewer", "hosted", "not an app window"])(
		"refuses both methods for %s before consulting storage",
		async kind => {
			const r = rig(kind === "other OS" ? null : profile);
			if (kind === "agent") Object.assign(r.caller, { browserWindow: null });
			if (kind === "web") Object.assign(r.caller, { connId: "paired-page" });
			if (kind === "remote tab") r.tab.device = "paired-computer";
			if (kind === "viewer") r.tab.winId++;
			if (kind === "hosted") r.hosted.mockReturnValue(true);
			if (kind === "not an app window") r.windowRecord.mockReturnValue(null);
			await expect(r.invoke(get, cwd)).rejects.toThrow("[wsl_host_local_only]");
			await expect(r.invoke(set, cwd, id)).rejects.toThrow("[wsl_host_local_only]");
			expect(exists).not.toHaveBeenCalled();
			expect(call).not.toHaveBeenCalled();
		},
	);

	it("does not treat an explicit remote target, caller-chosen profile or omitted id as a local call", async () => {
		const { invoke } = rig();
		await expect(invoke(get, cwd, "paired-host")).rejects.toThrow();
		await expect(invoke(set, cwd, id, { profile: "C:\\other" })).rejects.toThrow();
		await expect(invoke(set, cwd)).rejects.toThrow();
		expect(call).not.toHaveBeenCalled();
	});

	it("never probes a renderer path, network share or missing project", async () => {
		const r = rig();
		const network = String.raw`\\some-server\share`;
		r.projects.push({ path: network, missing: false });
		for (const path of [cwd.toLowerCase(), "C:\\elsewhere", network, { cwd, profile: "other" }])
			await expect(r.invoke(get, path)).rejects.toThrow("[wsl_project_unavailable]");
		r.projects[0]!.missing = true;
		await expect(r.invoke(set, cwd, null)).rejects.toThrow("[wsl_project_unavailable]");
		expect(exists).not.toHaveBeenCalled();
		expect(call).not.toHaveBeenCalled();
	});

	it("refuses a folder that disappeared or a local tab that switched while checking it", async () => {
		const r = rig();
		exists.mockResolvedValueOnce(false);
		await expect(r.invoke(set, cwd, id)).rejects.toThrow("[wsl_project_unavailable]");
		exists.mockImplementationOnce(async () => {
			r.tab.device = "paired";
			return true;
		});
		await expect(r.invoke(set, cwd, id)).rejects.toThrow("[wsl_host_local_only]");
		expect(call).not.toHaveBeenCalled();
	});
});
