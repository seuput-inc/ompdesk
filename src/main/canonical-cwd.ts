import { realpathSync } from "node:fs";
import { CoreError, core } from "./core/process";

/**
 * The sidecar reports `process.cwd()`, which is the resolved path (`/private/var/…`
 * for `/var/…`, `/private/tmp` for `/tmp`). Every tab cwd must match it, or one
 * project splits into two sidebar groups and session/cwd lookups miss. Windows
 * keeps the spelling it was given (no symlinked system dirs; resolving there
 * could swap drive-relative or 8.3 spellings instead).
 */
export function canonicalCwd(cwd: string): string {
	if (process.platform === "win32") return cwd;
	try {
		return realpathSync(cwd);
	} catch {
		return cwd;
	}
}

/** A failed stat is not a directory. A lost core is not evidence that a saved folder is gone. */
export async function directoryExists(path: string): Promise<boolean> {
	try {
		return (await core().call<{ directory: boolean }>("fs.stat", { path })).result.directory;
	} catch (error) {
		if (error instanceof CoreError && (error.code === "file_not_found" || error.code === "io")) return false;
		throw error;
	}
}
