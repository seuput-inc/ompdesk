/**
 * Main-side IPC for `setup:git-aslr`, forwarded to the core's `tools` instance (`client.ts`).
 *
 * The other 9 setup/updater channels (`setup:get-state`, `setup:retry`, `setup:cancel`, `omp-update:get-state`,
 * `omp-update:now`, `cli-update:get-state`, `cli-update:now`, `extension-update:get-state`, `extension-update:now`)
 * route directly from `tauri-shell` to `ompdesk-core` (`crates/core/src/tools/ipc.rs`).
 */
import { IPC_COMMANDS } from "../../shared/ipc-types";
import { isGitAslrAction } from "../../shared/setup";
import type { IpcRegistry } from "../web/ipc-registry";
import type { ToolsClient } from "./client";

export type ToolsIpcClient = Pick<ToolsClient, "setupGitAslr">;

export function registerToolsIpc(ipc: IpcRegistry, tools: ToolsIpcClient): void {
	ipc.handle(IPC_COMMANDS.SETUP_GIT_ASLR, (_caller, action: unknown) => {
		if (!isGitAslrAction(action)) throw new Error(`Unknown Git ASLR action: ${String(action)}`);
		return tools.setupGitAslr(action);
	});
}
