/**
 * The built app every e2e launches: `<OMP_GUI_E2E_OUT ?? out>/main/index.js`, which the Tauri host
 * (`e2e/fixture/shell-launch.ts`) starts Node on. Without it every test would spend its own launch failing, so a run
 * without a build stops before any host starts (`playwright.config.ts` globalSetup), and `launchApp` asserts the same
 * before it spawns.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export function appEntry(env: NodeJS.ProcessEnv = process.env): string {
	return path.resolve(env.OMP_GUI_E2E_OUT ?? "out", "main/index.js");
}

/** Throws, naming the missing file and how to build, when the app entry does not exist. Returns the entry. */
export function assertAppBuilt(env: NodeJS.ProcessEnv = process.env): string {
	const entry = appEntry(env);
	if (!fs.existsSync(entry)) {
		throw new Error(
			`No build: ${entry} does not exist, so no test can start the app. ` +
				"Run `bun run build` or `bun run check:changed` first (or point OMP_GUI_E2E_OUT at a built out/).",
		);
	}
	return entry;
}
