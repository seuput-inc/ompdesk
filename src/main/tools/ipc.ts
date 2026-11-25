/**
 * IPC of machine setup and the omp, tool CLI and extension updaters, forwarded to the core's `tools` instance
 * (`client.ts`). Each handler is one client call. No handler takes a command, a path, a plan or a version: setup takes
 * item ids and fix/undo, Update now a tool id or a row key of the current state (or nothing); anything else is refused
 * before the core sees it. Runs answer at once; their progress arrives as the `*:state` pushes.
 */
import { isCliToolId } from "../../shared/cli-update";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import { isGitAslrAction, isSetupItemId } from "../../shared/setup";
import type { IpcRegistry } from "../web/ipc-registry";
import type { ToolsClient } from "./client";

export type ToolsIpcClient = Pick<
	ToolsClient,
	"state" | "setupRetry" | "setupCancel" | "setupGitAslr" | "ompNow" | "cliNow" | "cliRescan" | "extNow" | "extRescan"
>;

export function registerToolsIpc(ipc: IpcRegistry, tools: ToolsIpcClient): void {
	ipc.handle(IPC_COMMANDS.SETUP_GET_STATE, () => tools.state().setup);
	ipc.handle(IPC_COMMANDS.SETUP_RETRY, (_caller, item: unknown) => {
		if (!isSetupItemId(item)) throw new Error(`Unknown setup item: ${String(item)}`);
		void tools.setupRetry(item).catch(() => undefined);
	});
	ipc.handle(IPC_COMMANDS.SETUP_CANCEL, () => tools.setupCancel());
	ipc.handle(IPC_COMMANDS.SETUP_GIT_ASLR, (_caller, action: unknown) => {
		if (!isGitAslrAction(action)) throw new Error(`Unknown Git ASLR action: ${String(action)}`);
		return tools.setupGitAslr(action);
	});

	ipc.handle(IPC_COMMANDS.OMP_UPDATE_GET_STATE, () => tools.state().omp);
	ipc.handle(IPC_COMMANDS.OMP_UPDATE_NOW, () => {
		void tools.ompNow().catch(() => undefined);
	});

	ipc.handle(IPC_COMMANDS.CLI_UPDATE_GET_STATE, () => {
		// Settings opened: look for tools a provider connection or an install added since; the answer arrives as a push.
		void tools.cliRescan().catch(() => undefined);
		return tools.state().cli;
	});
	ipc.handle(IPC_COMMANDS.CLI_UPDATE_NOW, (_caller, id: unknown) => {
		if (id !== undefined && id !== null && !isCliToolId(id)) throw new Error(`Unknown tool: ${String(id)}`);
		void tools.cliNow(id ?? undefined).catch(() => undefined);
	});

	ipc.handle(IPC_COMMANDS.EXTENSION_UPDATE_GET_STATE, () => {
		// Settings opened: look for what a plugin install or an MCP edit added since; the answer arrives as a push.
		void tools.extRescan().catch(() => undefined);
		return tools.state().ext;
	});
	ipc.handle(IPC_COMMANDS.EXTENSION_UPDATE_NOW, (_caller, key: unknown) => {
		if (key === undefined || key === null) {
			void tools.extNow().catch(() => undefined);
			return;
		}
		// Only a row of the current state is a handle; anything else (a path, a command) never reaches the core.
		if (typeof key !== "string" || !tools.state().ext.rows.some(row => row.key === key)) {
			throw new Error(`Unknown extension: ${String(key)}`);
		}
		void tools.extNow(key).catch(() => undefined);
	});
}
