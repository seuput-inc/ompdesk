/**
 * The last lines one omp process wrote to its own log, for a start that stays silent on stderr. Stock writes one log
 * per process, `<logs>/omp.<local YYYY-MM-DD>.<pid>.log` (pi-utils `getLogPath`, named by the local day like its
 * rotating sink), as JSON lines. An omp whose stderr says nothing while it starts still logs there: on 9 Nov 2026 every
 * stalled omp of a MacBook had empty stderr and 4-5 log lines.
 *
 * The pid is the spawned process's; on Windows a `.cmd` launcher's shell is not omp, so its log is not found there.
 */
import { join } from "node:path";
import { agentDir } from "./agent-paths";
import { core } from "./core/process";

/** `YYYY-MM-DD` of `date` in this computer's time zone. */
export function localDay(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Reads the newer local day's log first when a start crossed midnight.
 */
export async function ompLogTail(
	pid: number,
	spawnedAt: Date,
	options: { logsDir?: string; now?: Date } = {},
): Promise<string[]> {
	const { result } = await core().call<string[]>("omp.logTail", {
		logsDir: options.logsDir ?? join(agentDir(), "..", "logs"),
		pid,
		today: localDay(options.now ?? new Date()),
		spawnDay: localDay(spawnedAt),
	});
	return result;
}
