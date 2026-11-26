/**
 * The `ompdesk` command on PATH: a launcher in the app's own `bin` folder (reaches every process OMPdesk spawns,
 * terminals included) and, in the packaged app, one in Bun's global bin folder next to `omp`, so a terminal outside
 * OMPdesk finds it too. The launcher runs the CLI the app ships (the `ompdesk` executable built from
 * `native/ompdesk/crates/cli`) by its absolute path, which moves with the app: every launch writes it again.
 */
import { join } from "node:path";
import type { SetupPlatform } from "../../shared/setup";
import { core } from "../core/process";
import { bunInstallDir, mergePathLists } from "../setup/paths";

export interface CliInstallOptions {
	/** The `ompdesk` executable (`ompdesk.exe` on Windows). */
	binary: string;
	userData: string;
	platform: SetupPlatform;
	packaged: boolean;
	/** Read for `BUN_INSTALL` and `OMP_GUI_HEADLESS`; its PATH gets the launcher folder appended. */
	env: NodeJS.ProcessEnv;
	home: string;
}

/** The app's own bin folder, and Bun's global bin in a packaged app (a terminal outside OMPdesk finds it there). */
function launcherDirs(options: CliInstallOptions): { appBin: string; bunBin: string | undefined } {
	const { userData, packaged, env, home } = options;
	return {
		appBin: join(userData, "bin"),
		bunBin: packaged && env.OMP_GUI_HEADLESS !== "1" ? join(bunInstallDir(env, home), "bin") : undefined,
	};
}

/** Writes the launchers and puts the app's bin folder on `env.PATH`; returns the folders that now hold ours. */
export async function installCliLaunchers(options: CliInstallOptions): Promise<string[]> {
	const { binary, platform, env } = options;
	const { appBin, bunBin } = launcherDirs(options);
	env.PATH = mergePathLists(env.PATH ?? "", [appBin], platform);
	try {
		return (
			await core().call<string[]>("control.installCli", { binary, windows: platform === "win32", appBin, bunBin })
		).result;
	} catch (error) {
		console.warn(`[cli-install] ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

/** "Remove OMPdesk from this computer": the launchers this app wrote leave both folders; returns the files removed. */
export async function removeCliLaunchers(options: CliInstallOptions): Promise<string[]> {
	const { appBin, bunBin } = launcherDirs(options);
	return (await core().call<string[]>("control.removeCli", { dirs: bunBin ? [appBin, bunBin] : [appBin] })).result;
}
