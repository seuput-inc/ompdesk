/**
 * Starts a detached process on a worker thread, so the caller's thread never waits for it. Windows runs a
 * freshly downloaded, unsigned file only after Defender's scan of it finishes inside `CreateProcess`, and
 * `child_process.spawn` makes that call on the thread that asked: starting the 113 MB NSIS setup froze the main
 * thread for 5.6 s on the user's PC (a 96 MB unsigned exe built moments before: 2.4 to 4.1 s for its first start
 * and 6 ms for the next, whether or not the bytes had been read before). The spawn is the same
 * (`detached`, no stdio, the process outlives its parent); only the thread that waits for it differs.
 *
 * Electron-free (`node:worker_threads` only) so a test can run it for real. The worker is a string: no second
 * build entry for six lines.
 */
import { Worker } from "node:worker_threads";

const SPAWN_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const options = workerData.env
	? { detached: true, stdio: "ignore", env: workerData.env }
	: { detached: true, stdio: "ignore" };
const child = spawn(workerData.command, workerData.args, options);
child.once("error", error => parentPort.postMessage({ error: { message: error.message, code: error.code } }));
child.once("spawn", () => {
	child.unref();
	parentPort.postMessage({ pid: child.pid });
});
`;

type SpawnReply = { pid: number } | { error: { message: string; code?: string } };

/**
 * Environment for spawning the Windows NSIS setup. A `PSModulePath` inherited from PowerShell 7 breaks
 * Windows PowerShell 5.1 (`IS_POWERSHELL_AVAILABLE` / `Get-CimInstance` in electron-builder's NSIS template),
 * forcing a fallback to `taskkill /IM OMPdesk.exe` that leaves `node.exe`, `ompdesk-core.exe` and the preview
 * browser locking `$INSTDIR`. Returns `undefined` when absent so callers inherit `process.env` unchanged.
 */
export function installerSpawnEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | undefined {
	if (!Object.keys(env).some(key => key.toLowerCase() === "psmodulepath")) return undefined;
	return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
}

/** Resolves with the process id once the process exists; rejects with the spawn error (its `code`: ENOENT, EACCES, UNKNOWN). */
export function spawnDetachedOffThread(
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv | undefined = installerSpawnEnv(),
): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const worker = new Worker(SPAWN_WORKER, { eval: true, workerData: { command, args: [...args], env } });
	worker.once("message", (reply: SpawnReply) => {
		if ("pid" in reply) resolve(reply.pid);
		else reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
	});
	worker.once("error", reject);
	worker.once("exit", () => reject(new Error("the thread that starts the installer ended before it reported")));
	return promise;
}
