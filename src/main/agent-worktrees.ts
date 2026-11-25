/** The core runs stock's orphan-only worktree commands. Do not retry a clear whose reply was lost. */
import type { RpcAgentWorktree, RpcAgentWorktreeClear } from "../shared/rpc-types";
import { CoreError, core } from "./core/process";
import { LocalCommandError } from "./local/types";

export interface OmpCliLaunch {
	bin: string;
	env: NodeJS.ProcessEnv;
}

async function worktrees<T>(action: "list" | "clear", launch: OmpCliLaunch, cwd = process.cwd()): Promise<T> {
	try {
		// The child owns its deadline; leave time for the core's timeout reply.
		const timeoutMs = action === "list" ? 70_000 : 310_000;
		return (await core().call<T>("omp.worktrees", { ...launch, cwd, action }, { timeoutMs })).result;
	} catch (error) {
		if (error instanceof CoreError && error.code === "worktree_cli_failed") {
			throw new LocalCommandError(error.message, error.code);
		}
		throw error;
	}
}

export function listAgentWorktrees(launch: OmpCliLaunch, cwd?: string): Promise<{ entries: RpcAgentWorktree[] }> {
	return worktrees("list", launch, cwd);
}

export function clearAgentWorktrees(launch: OmpCliLaunch, cwd?: string): Promise<RpcAgentWorktreeClear> {
	return worktrees("clear", launch, cwd);
}
