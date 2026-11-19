/**
 * Software rendering for a GPU that keeps failing. A GPU process crash never relaunches the running app: WebView2
 * starts a new GPU process and repaints the window by itself (measured on the Tauri host, `gpuCrashDecision` in
 * launch-guard-core.ts), and on v0.44.0 a relaunch from a launch whose GPU kept dying opened and closed OMPdesk
 * forever. A GPU that crashes again within 10 minutes, or in the launch that tries hardware again, leaves the marker
 * (`<userData>/gpu-fallback.json`), and the next launch renders in software until the GPU or its driver changes or
 * 7 days pass (gpu-fallback-core.ts).
 *
 * The marker must live on disk and be read before `app.whenReady()` —
 * `app.disableHardwareAcceleration()` is only legal that early.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import {
	type GpuIdentity,
	type GpuMarker,
	gpuChange,
	gpuIdentityOf,
	gpuMarkerDecision,
	MARKER_POLICY,
	markerForTrial,
	parseGpuMarker,
} from "./gpu-fallback-core";
import { launchSafeMode } from "./launch-guard";
import { gpuCrashDecision } from "./launch-guard-core";
import { writeRuntimeLog } from "./runtime-log";

const MARKER_FILENAME = "gpu-fallback.json";

function markerPath(): string {
	return join(app.getPath("userData"), MARKER_FILENAME);
}

function readMarkerText(): string | undefined {
	try {
		return readFileSync(markerPath(), "utf8");
	} catch {
		return undefined;
	}
}

function writeMarker(marker: GpuMarker): void {
	try {
		writeFileSync(markerPath(), JSON.stringify({ ...marker, at: new Date(marker.at).toISOString() }));
	} catch {
		// Without the marker the next launch just retries hardware acceleration.
	}
}

/**
 * Call before `app.whenReady()`: disables GPU compositing in safe mode, when a previous GPU
 * crash tripped the fallback, or when the user passed --disable-gpu /
 * --enable-gpu explicitly (the latter clears a stale marker).
 */
export function applyGpuFallbackIfNeeded(safeMode = false): boolean {
	let disabled = safeMode;
	if (safeMode) {
		// Safe mode renders in software whatever the switches or the marker say.
	} else if (app.commandLine.hasSwitch("enable-gpu")) {
		try {
			rmSync(markerPath(), { force: true });
		} catch {
			// Marker is advisory; failing to clear it must not block startup.
		}
	} else if (app.commandLine.hasSwitch("disable-gpu")) {
		disabled = true;
	} else {
		const text = readMarkerText();
		if (text !== undefined && markerForcesSoftware(text)) {
			const marker = parseGpuMarker(text);
			const now = Date.now();
			const decision = gpuMarkerDecision(marker, now);
			if (decision.software) disabled = true;
			else {
				// Recorded before it runs, so a trial that never gets a verdict is not repeated.
				writeMarker(markerForTrial(marker, now));
				hardwareTrial = true;
				writeRuntimeLog({
					source: "gpu-fallback",
					message: `GPU crash marker: trying hardware acceleration again (${decision.trial})`,
					details: {
						trial: decision.trial,
						crashedOn: marker.gpu ?? null,
						now: marker.seen ?? null,
						crashedAt: marker.at ? new Date(marker.at).toISOString() : null,
					},
				});
			}
		} else if (text !== undefined) {
			try {
				rmSync(markerPath(), { force: true });
			} catch {
				// A marker left in place is ignored on the next launch too.
			}
		}
	}
	softwareLaunch = disabled;
	if (disabled) {
		app.disableHardwareAcceleration();
		writeRuntimeLog({
			source: "gpu-fallback",
			message: safeMode
				? "Hardware acceleration disabled (safe mode)"
				: "Hardware acceleration disabled (crash marker or --disable-gpu)",
		});
	}
	return disabled;
}

/** This launch turned hardware acceleration off before ready. */
let softwareLaunch = false;
/** This launch tries hardware again under a crash marker (driver or GPU changed, or the cool-off passed). */
let hardwareTrial = false;
/** The GPU Chromium named once ready. */
let currentGpu: GpuIdentity | undefined;

/**
 * Once ready: read the GPU (`basic` info names the real adapter even in a software launch) for the crash marker.
 * A software launch under a marker records it as `seen`, so the next launch tries hardware when it changed.
 */
export async function recordGpuIdentity(): Promise<void> {
	let info: unknown;
	try {
		info = await app.getGPUInfo("basic");
	} catch {
		return;
	}
	currentGpu = gpuIdentityOf(
		typeof info === "object" && info !== null && "gpuDevice" in info ? info.gpuDevice : undefined,
	);
	if (!softwareLaunch || !currentGpu) return;
	const text = readMarkerText();
	if (text === undefined || !markerForcesSoftware(text)) return;
	const marker = parseGpuMarker(text);
	if (marker.seen && !gpuChange(marker.seen, currentGpu)) return;
	writeMarker({ ...marker, seen: currentGpu });
	const change = marker.gpu ? gpuChange(marker.gpu, currentGpu) : undefined;
	writeRuntimeLog({
		source: "gpu-fallback",
		message: change
			? `GPU ${change} since the crash: the next launch tries hardware acceleration`
			: "GPU unchanged since the crash: software rendering stays",
		details: { crashedOn: marker.gpu ?? null, now: currentGpu },
	});
}

/** A hardware trial ran long enough without a GPU crash: the marker goes, hardware acceleration stays. */
export function confirmHardwareTrial(): void {
	if (!hardwareTrial || gpuCrashHandled) return;
	hardwareTrial = false;
	try {
		rmSync(markerPath(), { force: true });
	} catch {
		return;
	}
	writeRuntimeLog({ source: "gpu-fallback", message: "GPU crash marker cleared: hardware acceleration works again" });
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

/** This launch left the marker: later crashes change nothing more. */
let gpuCrashHandled = false;
/** When this launch's GPU process last crashed and WebView2 recovered it. */
let gpuCrashedAt: number | undefined;

/**
 * GPU-process exits that mean compositing is dead. clean-exit is lifecycle; killed is an outside
 * termination (Windows logoff, shutdown or an installer ends the whole tree with DBG_TERMINATE_PROCESS),
 * never a GPU failure.
 */
export function isGpuProcessCrash(details: { type: string; reason: string }): boolean {
	return details.type === "GPU" && details.reason !== "clean-exit" && details.reason !== "killed";
}

/** A marker an older build wrote for a non-crash exit (killed) is stale; an unreadable one still counts. */
export function markerForcesSoftware(marker: string): boolean {
	try {
		const reason: unknown = JSON.parse(marker)?.reason;
		return typeof reason !== "string" || isGpuProcessCrash({ type: "GPU", reason });
	} catch {
		return true;
	}
}

/**
 * Called from the `child-process-gone` handler (the Tauri host reports WebView2's `ProcessFailed` of a GPU process
 * as one). Never relaunches (`gpuCrashDecision`): the first crash of a hardware launch is logged and left to WebView2;
 * a crash in a hardware trial, or a second one within 10 minutes, leaves the marker for the next launch.
 */
export function handleGpuProcessGone(details: { type: string; reason: string; exitCode: number | undefined }): void {
	if (!isGpuProcessCrash(details) || gpuCrashHandled) return;
	const exit = { reason: details.reason, exitCode: details.exitCode ?? null };
	const now = Date.now();
	const decision = gpuCrashDecision({
		software: softwareLaunch,
		safeMode: launchSafeMode(),
		trial: hardwareTrial,
		now,
		crashedBefore: gpuCrashedAt,
	});
	if (!decision.marker) {
		if (decision.why === "recovers") gpuCrashedAt = now;
		writeRuntimeLog({
			source: "gpu-fallback",
			message: `GPU process exited (${details.reason}): WebView2 restarts it, no relaunch (${decision.why})`,
			details: { ...exit, why: decision.why },
		});
		return;
	}
	gpuCrashHandled = true;
	// A crash in a hardware trial starts the cool-off again with the GPU it crashed on.
	const before = readMarkerText();
	const gpu = currentGpu ?? (before === undefined ? undefined : parseGpuMarker(before).gpu);
	writeMarker({ at: now, policy: MARKER_POLICY, ...exit, ...(gpu ? { gpu } : {}) });
	writeRuntimeLog({
		source: "gpu-fallback",
		message: `GPU process exited (${details.reason}) ${decision.why === "trial" ? "in the hardware trial" : "again within 10 minutes"}: the next launch renders in software, no relaunch`,
		details: { ...exit, why: decision.why },
	});
}
