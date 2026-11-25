import { app, powerMonitor } from "electron";

type MainPhase = "startup" | "running" | "quit" | "update";

export type WatchdogSignal =
	| { type: "start"; pid: number }
	| { type: "heartbeat" | "suspend" | "resume" | "shutdown" }
	| { type: "step"; phase: MainPhase; step: string };

let postStep: ((message: WatchdogSignal) => void) | null = null;

/**
 * Main is about to run `step` of `phase`: the watchdog's marker names the last few steps, so a stall reads as
 * the step that never returned. Call it before a step that could block (sync fs, a native call, a teardown).
 * A no-op where the watchdog is off.
 */
export function markMainStep(phase: MainPhase, step: string): void {
	postStep?.({ type: "step", phase, step });
}

export function installHangWatchdog(post: (signal: WatchdogSignal) => void): void {
	if (process.env.VITEST) return;
	if (!app.isPackaged && process.env.OMP_GUI_HANG_WATCHDOG !== "1") return;
	post({ type: "start", pid: process.pid });
	postStep = post;
	const timer = setInterval(() => post({ type: "heartbeat" }), 1_000);
	timer.unref();
	const onSuspend = (): void => post({ type: "suspend" });
	const onResume = (): void => post({ type: "resume" });
	const stop = (): void => {
		postStep = null;
		clearInterval(timer);
		powerMonitor.off("suspend", onSuspend);
		powerMonitor.off("resume", onResume);
		post({ type: "shutdown" });
	};
	powerMonitor.on("suspend", onSuspend);
	powerMonitor.on("resume", onResume);
	app.once("will-quit", stop);
}
