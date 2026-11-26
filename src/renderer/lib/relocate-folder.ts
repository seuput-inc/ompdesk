import { pathBaseName } from "../../shared/project-origin";
import { useSidebarProjects } from "../stores/sidebar-projects";
import { toast, toastError } from "../stores/toast";
import { translate } from "./i18n";
import { LOCAL_DEVICE } from "./sidebar-memory";
import { pickWorkspaceDirectory } from "./workspace-dirs";

/** `cwd` is `folder` or lies under it, either separator; the part below it, else null. */
function below(folder: string, cwd: string): string | null {
	if (cwd === folder) return "";
	const base = folder.replace(/[\\/]+$/, "");
	return cwd.startsWith(`${base}/`) || cwd.startsWith(`${base}\\`) ? cwd.slice(base.length) : null;
}

/**
 * A folder that moved, found again (Orca's Set project location, existing-folder half:
 * new-workspace/project-location/SetProjectLocationDialog.tsx:89-294). The person picks where it is now; every stored
 * session that ran in it (or below it) is moved there with `sessions.move` on the computer that owns it, the new
 * folder is listed as a project and the old one leaves the list. A session a tab holds is refused and stays where it
 * was; the notice counts what moved. Returns the new folder, or null when nothing was picked.
 */
export async function relocateFolder({
	device,
	from,
	sessions,
}: {
	device?: string;
	from: string;
	sessions: readonly { path: string; cwd: string }[];
}): Promise<string | null> {
	const to = await pickWorkspaceDirectory({
		title: translate("sidebar.project.locateTitle", { name: pathBaseName(from) || from }),
		...(device === undefined ? {} : { device }),
	});
	if (!to || to === from) return null;
	let moved = 0;
	let failure: unknown = null;
	for (const session of sessions) {
		const rest = below(from, session.cwd);
		if (rest === null) continue;
		try {
			await window.omp.sessions.move(session.path, `${to.replace(/[\\/]+$/, "")}${rest}`, device);
			moved += 1;
		} catch (error) {
			failure ??= error;
		}
	}
	const projects = useSidebarProjects.getState();
	const listed = projects.lists[device ?? LOCAL_DEVICE]?.projects.some(project => project.path === from) === true;
	await projects.add(device, to);
	if (listed) await projects.remove(device, from);
	if (failure) toastError({ title: translate("sidebar.project.locateSomeStayed", { count: moved }), error: failure });
	else
		toast({
			variant: "success",
			message: translate("sidebar.project.located", { count: moved, name: pathBaseName(to) || to }),
		});
	return to;
}
