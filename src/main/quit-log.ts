/**
 * The `app-quit` lines of gui-runtime.jsonl, so a person can tell afterwards how a run ended: who asked to quit or
 * relaunch (written before the quit work starts), the exit itself (`details.end: true`, the run's end line), and at the
 * next start a run that left no end line. Only a kill (force quit, SIGKILL), a crash or a power loss leaves none, and
 * none of them runs a handler that could say so. Pure: the shell host's `electron` module writes through it too.
 */
import type { RuntimeLogReport } from "./runtime-log-core";

/** Who asked the app to end. */
export type QuitAsker =
	| "app-menu"
	| "tray"
	| "last-window"
	| "command"
	| "update"
	| "restart-prompt"
	| "crash-recovery"
	| "gpu-fallback"
	| "signal"
	| "shell";

const ASKERS: Record<QuitAsker, string> = {
	"app-menu": "the app menu's Quit",
	tray: "the tray menu's Quit",
	"last-window": "closing the last window",
	command: "the quit command",
	update: "the update's restart",
	"restart-prompt": "the restart prompt",
	"crash-recovery": "the window crash prompt",
	"gpu-fallback": "the GPU fallback",
	signal: "a signal",
	shell: "the shell (Dock Quit, logout or the system)",
};

export interface QuitAsk {
	/** The app starts again once it ended. */
	relaunch?: boolean;
	/** What else the asker knows: the update's trigger, the signal's name. */
	detail?: string;
}

export function quitAskedReport(asker: QuitAsker, ask: QuitAsk = {}): RuntimeLogReport {
	const what = ask.relaunch ? "Relaunch" : "Quit";
	return {
		source: "app-quit",
		message: `${what} asked by ${ASKERS[asker]}${ask.detail ? ` (${ask.detail})` : ""}`,
		details: { asker, relaunch: ask.relaunch === true, ...(ask.detail ? { detail: ask.detail } : {}) },
	};
}

/** The run's end line: the last thing main writes before its process exits. */
export function exitReport(code: number, reason?: string): RuntimeLogReport {
	return {
		source: "app-quit",
		message: reason ? `Exiting with code ${code}: ${reason}` : `Exiting with code ${code}`,
		details: { end: true, code, ...(reason ? { reason } : {}) },
	};
}

interface LogEntry {
	pid?: unknown;
	timestamp?: unknown;
	appVersion?: unknown;
	source?: unknown;
	details?: { end?: unknown };
}

function entry(line: string): LogEntry | null {
	try {
		const value: unknown = JSON.parse(line);
		return typeof value === "object" && value !== null ? (value as LogEntry) : null;
	} catch {
		return null;
	}
}

/**
 * The line for a previous run that ended without its end line, from the log's last lines (`tailLogLines`, read before
 * or after this run's first lines: `ownPid`'s are skipped); null when it has one or there is no previous run. A log
 * with no `app-quit` line at all was written by a version that wrote none, and is not judged.
 */
export function uncleanEndReport(lines: readonly string[], ownPid: number): RuntimeLogReport | null {
	const entries = lines.map(entry).filter((e): e is LogEntry => e !== null && e.pid !== ownPid);
	if (!entries.some(e => e.source === "app-quit")) return null;
	const last = entries.at(-1);
	if (!last || typeof last.pid !== "number") return null;
	const run = entries.slice(entries.findLastIndex(e => e.pid !== last.pid) + 1);
	if (run.some(e => e.source === "app-quit" && e.details?.end === true)) return null;
	const at = typeof last.timestamp === "string" ? last.timestamp : null;
	return {
		source: "app-quit",
		message: `The previous run (pid ${last.pid}) ended without a reason: no end line, so it was killed (force quit, SIGKILL), crashed or lost power; its last line was at ${at ?? "an unknown time"}`,
		details: {
			previousPid: last.pid,
			lastLineAt: at,
			previousVersion: typeof last.appVersion === "string" ? last.appVersion : null,
		},
	};
}
