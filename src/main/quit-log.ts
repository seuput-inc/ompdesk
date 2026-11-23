/**
 * The `app-quit` lines main writes synchronously before the quit work starts and immediately before exit.
 * The shell-host shim also needs the end line when its connection to the native shell has already closed.
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
