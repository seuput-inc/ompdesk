/**
 * Stock's compiled omp in the place of Bun's omp launcher, moved aside so `bun install -g` can link the package's own.
 *
 * Stock's launcher repair (`updateViaManager`) writes its standalone build over `<BUN_INSTALL>/bin/omp` (`omp.exe`
 * on Windows) whenever the new launcher does not answer `--version`. `bun install -g @oh-my-pi/pi-coding-agent` cannot
 * put the launcher back over it: on POSIX it fails `error: failed to link @oh-my-pi/pi-coding-agent: EEXIST` (Bun
 * 1.4.4, measured 29 Oct 2026 on a regular file in the launcher's place), and on Windows it overwrites `omp.exe` but
 * ignores EBUSY while that `omp.exe` runs anywhere (`src/install/bin.rs` `create_windows_shim`), exits 0 and leaves
 * the compiled omp. Renaming is what works on both: Windows lets a running executable be renamed (`bun upgrade` and
 * stock rename their own running exe), only not deleted or overwritten.
 */
import { resolve } from "node:path";
import type { SetupPlatform } from "../../shared/setup";
import { core } from "../core/process";
import { NO_TIMEOUT_MS } from "./download";

/** A package script or Bun's Windows shim is usable; a standalone omp cannot load the bridge. */
export async function isCompiledOmp(file: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
	return (await core().call<boolean>("setup.isCompiledOmp", { file, windows: platform === "win32" })).result;
}

interface LauncherRepair {
	bunInstall: string;
	windows: boolean;
	now: number;
}

export async function setAsideCompiledOmp(
	bunInstall: string,
	platform: SetupPlatform,
	now: number,
): Promise<LauncherRepair | null> {
	const repair = { bunInstall: resolve(bunInstall), windows: platform === "win32", now };
	const { result } = await core().call<boolean>("setup.setAsideCompiledOmp", repair, { timeoutMs: NO_TIMEOUT_MS });
	return result ? repair : null;
}

export async function settleSetAside(repair: LauncherRepair): Promise<void> {
	await core().call("setup.settleCompiledOmp", repair, { timeoutMs: NO_TIMEOUT_MS });
}
