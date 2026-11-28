import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { availableHeavyBinary } from "./lock-slots";

const managed = process.env.OMPDESK_HOOK === "setup";
const bin = managed ? process.env.OMPDESK_SETUP_CLI : await availableHeavyBinary(process.env);
if (managed && (!bin || !isAbsolute(bin))) {
	throw new Error("worktree-setup: no host admission CLI; update OMPdesk on the execution host and retry setup");
}
if (!bin) console.warn("worktree-setup: standalone install without an OMPdesk CLI");
const electronCache =
	process.env.electron_config_cache ||
	(process.platform === "win32"
		? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "electron", "Cache")
		: join(homedir(), "Library", "Caches", "electron"));
const env: NodeJS.ProcessEnv = { ...process.env, electron_config_cache: electronCache };
if (managed) {
	// The checkout's declared writes do not cover the installer's dependency and Electron caches.
	for (const key of Object.keys(env)) if (key.toUpperCase() === "OMPDESK_WRITE_BYTES") delete env[key];
}
const args = ["run", "worktree:install"];
const gate = managed ? ["run", "--heavy", "--fresh-admission"] : ["run", "--heavy"];
const result = spawnSync(bin ?? process.execPath, bin ? [...gate, "--", process.execPath, ...args] : args, {
	env,
	stdio: "inherit",
});
if (result.error && managed) {
	throw new Error(`worktree-setup: cannot start host admission CLI ${bin}; repair OMPdesk on this host`, {
		cause: result.error,
	});
}
if (result.error) throw result.error;
if (managed && result.status === 2) console.error("worktree-setup: verify the host CLI supports --fresh-admission");
process.exitCode = result.status ?? 1;
