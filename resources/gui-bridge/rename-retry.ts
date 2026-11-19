/**
 * The rename a held target refuses on Windows, and how long a non-blocking writer tries it again. A write that stages
 * a temp file and renames it over its target fails (EPERM, sometimes EACCES or EBUSY) while any process (a virus
 * scan, an indexer, a reader that opened the target without delete sharing) has the target open. One policy for main
 * (`src/main/atomic-file.ts`) and the bridge (`extensions/mcp-config-rename.ts`).
 */

/** 20 ms doubling, about 5 s in all. */
export const RENAME_RETRY_MS: readonly number[] = [20, 40, 80, 160, 320, 640, 1_280, 2_560];

/** Windows only: elsewhere EPERM is a real refusal, and retrying cannot help. */
export function isRenameBlocked(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
	if (platform !== "win32" || !(error instanceof Error) || !("code" in error)) return false;
	return error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY";
}
