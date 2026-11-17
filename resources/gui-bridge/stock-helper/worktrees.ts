/**
 * Stock's worktree location for a repository without a running session (src/main/local/git/worktree.ts
 * `createWorktree` for an agent on another computer opening a session here): the bridge's
 * `git.worktree_location` (worktree-lifecycle.ts) reads it from the live session's process, this reads the same
 * `worktree.base` setting from the folder's config read-only, applies it as stock's own `effect` does
 * (`setWorktreesDir`), and asks pi-utils for the directory and the repo hash. Nothing is written.
 */
import * as path from "node:path";
import { loadOmpModule } from "../omp-package";

interface Handle<T> {
	get(settings: unknown): T;
}

export const methods: Record<string, (params: unknown) => Promise<unknown>> = {
	"git.worktree_location": async params => {
		const primaryRoot = (params as { primaryRoot?: unknown } | null)?.primaryRoot;
		if (typeof primaryRoot !== "string" || !path.isAbsolute(primaryRoot) || primaryRoot.includes("\0"))
			throw new Error("primaryRoot must be an absolute path");
		const [utils, settingsModule, taskSettings] = await Promise.all([
			loadOmpModule<{
				getWorktreesDir(): string;
				hashPath(absPath: string): string;
				setWorktreesDir(dir: string | undefined): string | undefined;
			}>("pi-utils", "getWorktreesDir", "hashPath", "setWorktreesDir"),
			loadOmpModule<{ Settings: { loadReadOnly(options: { cwd: string }): Promise<unknown> } }>(
				"pi-coding-agent/config/settings",
				"Settings",
			),
			loadOmpModule<{ cfgWorktreeBase: Handle<string | undefined> }>(
				"pi-coding-agent/task/settings",
				"cfgWorktreeBase",
			),
		]);
		const settings = await settingsModule.Settings.loadReadOnly({ cwd: primaryRoot });
		const base = taskSettings.cfgWorktreeBase.get(settings)?.trim();
		utils.setWorktreesDir(base || undefined);
		return { root: utils.getWorktreesDir(), hash: utils.hashPath(primaryRoot) };
	},
};
