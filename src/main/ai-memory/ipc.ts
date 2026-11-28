/**
 * IPC for the lifecycle and OS-action channels of `window.omp.aiMemory` (`get-state`, `retry`, `purge`,
 * `set-terminal`, `open-web`, `copy-web-password`, `reveal-data`, `care`, `care-undo`).
 *
 * The 17 wiki/data channels (`projects`, `search`, `recent`, `handoffs`, `read-page`, `overview`, `pages`,
 * `sessions`, `observations`, `profile`, `lint`, `sweep`, `write-page`, `delete-page`, `restore-page`,
 * `feedback`, `cancel-handoff`) route directly from `tauri-shell` to `ompdesk-core` (`crates/core/src/aimemory/ipc.rs`).
 */
import { IPC_COMMANDS } from "../../shared/ipc-types";
import type { IpcRegistry } from "../web/ipc-registry";
import type { MemoryCare } from "./care";
import type { AiMemoryService } from "./service";

export interface AiMemoryIpcDeps {
	/** http(s) only; main checks the host before calling. */
	openExternal: (url: string) => Promise<void>;
	openPath: (path: string) => Promise<string>;
	copyPassword: (text: string) => Promise<void>;
	/** Memory's own upkeep (care.ts): its Maintenance line and undo; null until created. */
	care: () => Pick<MemoryCare, "summary" | "undo"> | null;
}

export function registerAiMemoryIpc(
	ipc: IpcRegistry,
	service: Pick<AiMemoryService, "state" | "refresh" | "retry" | "purge" | "setTerminal" | "token">,
	deps: AiMemoryIpcDeps,
): void {
	ipc.handle(IPC_COMMANDS.AI_MEMORY_GET_STATE, () => {
		void service.refresh().catch(() => undefined);
		return service.state();
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_RETRY, () => {
		void service.retry().catch(() => undefined);
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_PURGE, () => service.purge());
	ipc.handle(IPC_COMMANDS.AI_MEMORY_SET_TERMINAL, (_caller, enabled: unknown) => {
		if (typeof enabled !== "boolean") throw new Error("Invalid argument: enabled");
		return service.setTerminal(enabled);
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_OPEN_WEB, async () => {
		const { webUrl } = service.state();
		if (!webUrl) throw new Error("Memory is not running");
		const url = new URL(webUrl);
		if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
			throw new Error("Refusing to open a non-local address");
		}
		await deps.openExternal(url.href);
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_COPY_WEB_PASSWORD, async () => {
		const token = await service.token();
		if (!token) throw new Error("Memory has no token yet");
		await deps.copyPassword(token);
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_REVEAL_DATA, async () => {
		const { dataDir } = service.state();
		if (!dataDir) throw new Error("The data folder is not known yet");
		const failure = await deps.openPath(dataDir);
		if (failure) throw new Error(failure);
	});
	ipc.handle(IPC_COMMANDS.AI_MEMORY_CARE, () => deps.care()?.summary() ?? null);
	ipc.handle(IPC_COMMANDS.AI_MEMORY_CARE_UNDO, () => deps.care()?.undo() ?? 0);
}
