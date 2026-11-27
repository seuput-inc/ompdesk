import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { availableHeavyBinary } from "./lock-slots";

// A fresh checkout has no dependencies yet. Use the installed CLI; never build a CLI to admit an install.
const bin = await availableHeavyBinary(process.env);
if (!bin) console.warn("worktree-setup: no OMPdesk CLI available; install has no host admission check");
const electronCache =
	process.env.electron_config_cache ||
	(process.platform === "win32"
		? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "electron", "Cache")
		: join(homedir(), "Library", "Caches", "electron"));
const env = { ...process.env, electron_config_cache: electronCache };
const args = ["run", "worktree:install"];
const result = spawnSync(bin ?? process.execPath, bin ? ["run", "--heavy", "--", process.execPath, ...args] : args, {
	env,
	stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
