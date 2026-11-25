/**
 * Opening a path a reply or tool card names. `shell.openPath` hands the file to
 * LaunchServices / ShellExecute, which RUN an app, a `.command`, an `.exe`,
 * a `.lnk` and the like. Model text (steered by a web page, README or issue)
 * can link such a file, and one click would launch it with no prompt, so
 * launcher types are revealed in Finder / Explorer instead, never opened.
 */

import { core } from "./core/process";

export async function isLauncherPath(file: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
	return (await core().call<boolean>("fs.isLauncherPath", { file, windows: platform === "win32" })).result;
}

export interface OpenShell {
	openPath(file: string): Promise<string>;
	showItemInFolder(file: string): void;
}

/**
 * Opens `file` in its default app, or reveals it: always for a launcher, and as
 * the fallback when no app handles the file.
 */
export async function openLocalPath(
	file: string,
	shell: OpenShell,
	platform: NodeJS.Platform = process.platform,
): Promise<"opened" | "revealed"> {
	if (await isLauncherPath(file, platform)) {
		shell.showItemInFolder(file);
		return "revealed";
	}
	if (await shell.openPath(file)) {
		shell.showItemInFolder(file);
		return "revealed";
	}
	return "opened";
}
