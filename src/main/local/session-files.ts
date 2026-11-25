import { tmpdir } from "node:os";
import { core } from "../core/process";
import { ompRunEnv } from "../omp-runtime";
import type { OmpRuntime } from "./types";

/** Stock writes the title. The core waits for its rename reply, including a model-restore retry. */
export async function renameStoredSession(
	{ bin, basePath }: Pick<OmpRuntime, "bin" | "basePath">,
	sessionPath: string,
	name: string,
): Promise<void> {
	if (basePath === undefined) throw new Error("No resolved omp launcher for stored session rename");
	await core().call(
		"omp.renameStoredSession",
		{ bin, env: ompRunEnv(bin, basePath), cwd: tmpdir(), sessionPath, name },
		{ timeoutMs: 70_000 },
	);
}
