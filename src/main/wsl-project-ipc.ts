import { codedError } from "../shared/ipc-error-codes";
import { IPC_COMMANDS, type WslProjectHost } from "../shared/ipc-types";
import { isLocalWindowsProject } from "../shared/sidebar-projects";
import { canonicalCwd, directoryExists } from "./canonical-cwd";
import { core } from "./core/process";
import type { IpcDeps } from "./ipc";
import type { IpcCaller } from "./web/ipc-registry";

type HostDeps = Pick<IpcDeps, "ipc" | "sidecarPool" | "sidebarProjects" | "windowManager">;

/** An explicit choice belongs to this computer's project, never to the agent or viewer of a tab. */
export function registerWslProjectIpc(
	{ ipc, sidecarPool, sidebarProjects, windowManager }: HostDeps,
	profile: string | null,
): void {
	const knownProject = (caller: IpcCaller, requested: unknown) => {
		const win = caller.browserWindow;
		if (!profile || !win || caller.connId !== undefined || !windowManager.recordFor(win))
			throw codedError("wsl_host_local_only", "Choose the execution host on this Windows computer.");
		const target = sidecarPool.tabTarget(win);
		if (
			!target ||
			target.device !== undefined ||
			target.winId !== win.webContents.id ||
			sidecarPool.isHostedView(target.tabId)
		)
			throw codedError("wsl_host_local_only", "Choose the execution host from a local tab.");
		const project = sidebarProjects?.state().projects.find(entry => !entry.missing && entry.path === requested);
		if (!project || !isLocalWindowsProject(project.path))
			throw codedError("wsl_project_unavailable", "Choose an existing local project.");
		return { profile, cwd: canonicalCwd(project.path) };
	};
	const params = async (caller: IpcCaller, requested: unknown) => {
		const project = knownProject(caller, requested);
		if (!(await directoryExists(project.cwd)))
			throw codedError("wsl_project_unavailable", "The project folder is gone.");
		// The folder check yielded; a switch to a paired tab or removal from the list revokes this request.
		return knownProject(caller, requested);
	};
	ipc.handle(IPC_COMMANDS.WSL_PROJECT_GET, async (caller, cwd: unknown, ...extra: unknown[]) => {
		if (extra.length) throw codedError("wsl_host_local_only", "The project host takes no device or profile.");
		const project = await params(caller, cwd);
		return (await core().call<WslProjectHost>("setup.wslProjectGet", project)).result;
	});
	ipc.handle(IPC_COMMANDS.WSL_PROJECT_SET, async (caller, cwd: unknown, id: unknown, ...extra: unknown[]) => {
		if (extra.length) throw codedError("wsl_host_local_only", "The project host takes no device or profile.");
		if (id !== null && typeof id !== "string") throw new Error("Choose Windows or a registered WSL 2 distribution.");
		const project = await params(caller, cwd);
		await core().call("setup.wslProjectSet", { ...project, id });
	});
}
