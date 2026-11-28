/**
 * IPC for the 3 desktop OS-action channels of `window.omp.aiMemory` (`open-web`, `copy-web-password`, `reveal-data`).
 *
 * The other 23 channels (17 wiki/data + `get-state`, `retry`, `purge`, `set-terminal`, `care`, `care-undo`) route
 * directly from `tauri-shell` to `ompdesk-core` (`crates/core/src/aimemory/ipc.rs`).
 */
import { IPC_COMMANDS } from "../../shared/ipc-types";
import type { IpcRegistry } from "../web/ipc-registry";
import type { AiMemoryService } from "./service";

export interface AiMemoryIpcDeps {
	/** http(s) only; main checks the host before calling. */
	openExternal: (url: string) => Promise<void>;
	openPath: (path: string) => Promise<string>;
	copyPassword: (text: string) => Promise<void>;
}

export function registerAiMemoryIpc(
	ipc: IpcRegistry,
	service: Pick<AiMemoryService, "state" | "token">,
	deps: AiMemoryIpcDeps,
): void {
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
}
