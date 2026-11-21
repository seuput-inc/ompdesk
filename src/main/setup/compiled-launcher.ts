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
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { SetupPlatform } from "../../shared/setup";
import { CoreError, core } from "../core/process";
import { throwIfStepStalled, trackEffect } from "../serial-chain";
import { NO_TIMEOUT_MS } from "./download";
import type { RunOutcome } from "./runner";

/** Keep the setup queue held until this install no longer owns an aside, even if its step stalls. */
export async function withCompiledLauncherAside(
	bunInstall: string,
	platform: SetupPlatform,
	now: number,
	install: () => Promise<RunOutcome | null>,
): Promise<RunOutcome | null> {
	const repair = {
		bunInstall: resolve(bunInstall),
		windows: platform === "win32",
		now,
		nonce: randomBytes(6).readUIntBE(0, 6),
	};
	const hold = Promise.withResolvers<void>();
	trackEffect("compiled omp launcher repair", hold.promise);
	const request = async <R>(method: "setup.setAsideCompiledOmp" | "setup.settleCompiledOmp", installed = false) => {
		const ended = Promise.withResolvers<void>();
		try {
			const params = method === "setup.settleCompiledOmp" ? { ...repair, installed } : repair;
			return (await core().call<R>(method, params, { timeoutMs: NO_TIMEOUT_MS, onEnded: ended.resolve })).result;
		} catch (error) {
			if (error instanceof CoreError && error.code === "timeout") await ended.promise;
			throw error;
		}
	};
	let restore = false;
	let installed = false;
	try {
		try {
			restore = await request<boolean>("setup.setAsideCompiledOmp");
		} catch (error) {
			// A lost reply is not evidence that the rename failed.
			restore = error instanceof CoreError && (error.code === "core_exited" || error.code === "timeout");
			throw error;
		}
		if (!restore) hold.resolve();
		throwIfStepStalled();
		const outcome = await install();
		installed = outcome?.kind === "succeeded";
		return outcome;
	} finally {
		try {
			if (restore) await request("setup.settleCompiledOmp", installed);
		} finally {
			hold.resolve();
		}
	}
}
