/**
 * Windows: stock's MCP config writer (`mcp/config-writer.ts` `writeMCPConfigFile`: a temp file, then
 * `fs.promises.rename` over `mcp.json`) gives up on the first refused rename. A sign-in, an add, a turn-on or a
 * removal then failed with `EPERM: operation not permitted, rename '…mcp.json.<pid>.<id>.tmp' -> '…mcp.json'` while
 * something still had the file open: omp-latest 44492095193 (omp 19.0.0, Windows runner, 2 of 2 attempts) and the
 * probe of run 44500767465 (refused at 1 s, no handle on the file 5 s later, the next rename through). In-memory patch:
 * this omp's `fs.promises.rename` tries a refused rename onto an MCP config file again on `rename-retry.ts`'s backoff,
 * as main's `atomic-file.ts` does for its own files; every other rename and every other platform are untouched.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isRenameBlocked, RENAME_RETRY_MS } from "../rename-retry";

type Rename = (from: fs.PathLike, to: fs.PathLike) => Promise<void>;

/** `mcp.json` (omp's own and a project's `.mcp.json`). */
const isMcpConfig = (target: fs.PathLike) => path.basename(String(target)).endsWith("mcp.json");

/** `rename` that tries a held MCP config target again; anything else goes straight through. */
export function retryingRename(
	rename: Rename,
	platform: NodeJS.Platform = process.platform,
	sleep: (ms: number) => Promise<void> = ms => Bun.sleep(ms),
): Rename {
	return async (from, to) => {
		if (platform !== "win32" || !isMcpConfig(to)) return rename(from, to);
		for (let attempt = 0; ; attempt++) {
			try {
				return await rename(from, to);
			} catch (error) {
				const wait = RENAME_RETRY_MS[attempt];
				if (wait === undefined || !isRenameBlocked(error, platform)) throw error;
				await sleep(wait);
			}
		}
	};
}

let installed = false;

/** Once per omp: stock's writer looks `fs.promises.rename` up at each call, so it takes the patched one. */
export function installMcpConfigRenameRetry(): void {
	if (installed || process.platform !== "win32") return;
	installed = true;
	Object.assign(fs.promises, { rename: retryingRename(fs.promises.rename.bind(fs.promises)) });
}
