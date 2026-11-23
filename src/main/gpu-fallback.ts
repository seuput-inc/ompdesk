import { app } from "electron";
import { writeRuntimeLog } from "./runtime-log";
import type { RuntimeLogReport } from "./runtime-log-core";

export interface LaunchStart {
	guard: boolean;
	safeMode: boolean;
	software: boolean;
	stableAfterMs: number;
	logs: RuntimeLogReport[];
}

export type LaunchDecision = { log: RuntimeLogReport; relaunch?: true } | null;

/** The host has already written the marker and launch history before any callback can restart the app. */
export function applyLaunchDecision(decision: LaunchDecision): void {
	if (!decision) return;
	writeRuntimeLog(decision.log);
	if (decision.relaunch) {
		app.relaunch();
		app.exit(0);
	}
}

/**
 * Whether this launch composites in software: the crash marker or `--disable-gpu` turned hardware
 * acceleration off, or Chromium itself fell back (no GPU, a blocklisted driver, a CI runner). Chromium fills
 * `getGPUFeatureStatus()` only once the GPU process has reported, so this waits for `getGPUInfo("complete")`
 * first (read earlier, even a healthy GPU reports `disabled_software`; `basic` resolves too soon, `complete` does not). Asked once per launch and logged.
 */
export function softwareCompositing(): Promise<boolean> {
	softwareCompositingResult ??= app
		.getGPUInfo("complete")
		.catch(() => undefined)
		.then(() => {
			const features = app.getGPUFeatureStatus();
			const status = String(features.gpu_compositing);
			const software = !status.startsWith("enabled");
			writeRuntimeLog({
				source: "gpu-fallback",
				message: `gpu_compositing: ${status} (${software ? "software" : "hardware"})`,
				details: { features },
			});
			return software;
		});
	return softwareCompositingResult;
}

let softwareCompositingResult: Promise<boolean> | undefined;
