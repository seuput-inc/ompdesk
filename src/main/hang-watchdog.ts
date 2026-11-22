import { app, powerMonitor } from "electron";
import { writeRuntimeLog } from "./runtime-log";

type MainPhase = "startup" | "running" | "quit" | "update";

export interface HangMarker {
	detectedAt: number;
	pid: number;
	unresponsiveMs: number;
	selfRecovered: boolean;
	phase?: MainPhase;
	steps?: string[];
	machine?: Record<string, string | number | boolean>;
}

export function reportPreviousHang(marker: HangMarker | null): void {
	if (!marker) return;
	writeRuntimeLog({
		source: "main-thread-hang",
		message: marker.selfRecovered
			? `Main thread stalled for ${Math.round(marker.unresponsiveMs / 1000)}s and recovered`
			: `Main thread stalled for ${Math.round(marker.unresponsiveMs / 1000)}s and never recovered`,
		details: {
			unresponsiveMs: Math.round(marker.unresponsiveMs),
			selfRecovered: marker.selfRecovered,
			detectedAt: new Date(marker.detectedAt).toISOString(),
			previousPid: marker.pid,
			phase: marker.phase ?? null,
			// The runtime log keeps primitives only: an array would be dropped from the line.
			steps: marker.steps?.join(" > ") ?? null,
		},
	});
	// The next launch reports the sample from the stall, not the state of the computer now.
	if (marker.machine)
		writeRuntimeLog({
			source: "machine-state",
			message: "hang during",
			details: {
				trigger: "hang",
				when: "during",
				at: new Date(marker.detectedAt).toISOString(),
				...marker.machine,
			},
		});
}

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
