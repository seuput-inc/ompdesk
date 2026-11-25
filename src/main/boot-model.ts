/**
 * Stock `omp --mode rpc-ui` exits before `ready` when no model has credentials
 * ("No default model selected…" since 18.7, "No models available…" before), so
 * a first-run user would never reach the onboarding dialog that connects a
 * provider. An explicit `--model` boots it unauthenticated. The selector comes
 * from the installed omp's catalog (resources/gui-bridge/boot-model.ts), once
 * per omp install and version.
 */
import { join } from "node:path";
import { CorePort } from "./core/ports";
import { core } from "./core/process";
import type { OmpRuntime } from "./local/types";
import { ompPackageRoot, ompPathEnv } from "./omp-runtime";
import { spawnPath } from "./shell-env";

/** Used only when the installed omp's catalog cannot be read. */
export const FALLBACK_BOOT_MODEL = "anthropic/claude-sonnet-4-5";

/**
 * The sidecar chooses its exit plan in the same tick, so this reader stays synchronous in main.
 * Stock omp has no exit code or flag for "no usable model": its non-interactive
 * startup prints a headline and exits 1. Matches every headline spelling —
 * "No default model selected." (18.7+), "No models available." (18.6), "No
 * model available matching enabledModels …" — plus the API-key footer that
 * stock appends to all of them, so a reworded headline still recovers. No
 * leading `\b`: omp colors the lines, and the ANSI code ends in a letter
 * (`\x1b[31mNo models…`).
 */
export function isNoModelBootFailure(stderr: string): boolean {
	return /No models? available\b|No default model selected\b|Set an API key environment variable:/.test(stderr);
}

function warnFallback(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	console.warn(`[boot-model] catalog lookup failed (${detail}); using ${FALLBACK_BOOT_MODEL}`);
	return FALLBACK_BOOT_MODEL;
}

/** A catalog `provider/model` selector for booting `runtime` without credentials; never rejects. */
export async function bootModelSelector(runtime: OmpRuntime, bridgeDir: string): Promise<string> {
	const port = new CorePort({
		// Only the first request for an install/version needs main's package lookup and current spawn environment.
		launch: async () => {
			const packageRoot = ompPackageRoot(runtime.bin);
			if (!packageRoot) throw new Error(`cannot locate the omp package behind ${runtime.bin}`);
			const path = ompPathEnv(runtime.bin, await spawnPath());
			return {
				script: join(bridgeDir, "boot-model.ts"),
				cwd: process.cwd(),
				env: { ...process.env, PATH: path, OMP_PACKAGE_ROOT: packageRoot },
			};
		},
		warn: warnFallback,
	});
	try {
		return (
			await core().call<string>("models.bootSelector", {
				bin: runtime.bin,
				version: runtime.version,
				port: port.id,
				fallback: FALLBACK_BOOT_MODEL,
			})
		).result;
	} catch (error) {
		return warnFallback(error);
	} finally {
		port.close();
	}
}
