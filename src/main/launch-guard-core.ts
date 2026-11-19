/**
 * Rules that keep OMPdesk from opening and closing by itself. Pure: `launch-guard.ts` reads and writes the
 * history (`<userData>/launch-history.json`), `gpu-fallback.ts` asks what a GPU process crash leaves behind.
 *
 * A launch is recorded as it starts and marked stable once it ran `STABLE_AFTER_MS` or quit cleanly. A launch
 * that ended any other way (a crash, a kill) stays unstable. When the last `CRASH_LOOP_LAUNCHES` launches all ended
 * unstable within `CRASH_LOOP_WINDOW_MS`, the next one starts in safe mode: software rendering, machine setup paused.
 */

export interface LaunchRecord {
	/** Epoch ms the launch started. */
	at: number;
	/** It ran `STABLE_AFTER_MS` or quit cleanly. */
	stable?: true;
	/** It started in safe mode. */
	safeMode?: true;
}

export const STABLE_AFTER_MS = 20_000;
export const CRASH_LOOP_LAUNCHES = 3;
export const CRASH_LOOP_WINDOW_MS = 10 * 60_000;
/** A second GPU process crash this soon after the first is a GPU that keeps dying. */
export const GPU_CRASH_REPEAT_MS = 10 * 60_000;
/** Launches the history file keeps. */
export const HISTORY_KEEP = 10;

/** An unreadable or foreign history is no history: the guard is advisory and never blocks a start. */
export function parseLaunchHistory(text: string | undefined): LaunchRecord[] {
	if (!text) return [];
	try {
		const value: unknown = JSON.parse(text);
		if (!Array.isArray(value)) return [];
		return value.flatMap((entry): LaunchRecord[] => {
			if (typeof entry !== "object" || entry === null) return [];
			const { at, stable, safeMode } = entry as Record<string, unknown>;
			if (typeof at !== "number" || !Number.isFinite(at)) return [];
			return [
				{
					at,
					...(stable === true ? { stable: true as const } : {}),
					...(safeMode === true ? { safeMode: true as const } : {}),
				},
			];
		});
	} catch {
		return [];
	}
}

/** The previous launches (this one not yet recorded) form a crash loop. */
export function crashLoopDetected(previous: readonly LaunchRecord[], now: number): boolean {
	const recent = previous.slice(-CRASH_LOOP_LAUNCHES);
	if (recent.length < CRASH_LOOP_LAUNCHES) return false;
	return recent.every(launch => !launch.stable && now - launch.at >= 0 && now - launch.at <= CRASH_LOOP_WINDOW_MS);
}

export type GpuCrashDecision =
	| { marker: true; why: "keeps-dying" | "trial" }
	| { marker: false; why: "software" | "safe-mode" | "recovers" };

/**
 * What a GPU process crash leaves for the next launch. The running launch is never relaunched: WebView2 starts a new
 * GPU process and repaints the window by itself (the Tauri host on a Windows runner, installer-check run 44616509774:
 * after each of two crashes 6 s apart the window, grown to an area no earlier frame covered, was fully redrawn), and a
 * relaunch from a launch whose GPU kept dying is what opened and closed v0.44.0 forever. A launch that already renders
 * in software, or in safe mode, records nothing. The first crash of a hardware launch is WebView2's to recover; a
 * crash in a hardware trial (the marker's own test of the GPU), or a second one within `GPU_CRASH_REPEAT_MS`
 * (`crashedBefore`), writes the marker, so the next launch renders in software.
 */
export function gpuCrashDecision(input: {
	software: boolean;
	safeMode: boolean;
	/** This launch tries hardware again under a crash marker. */
	trial: boolean;
	now: number;
	/** When this launch's GPU process crashed before, if it did. */
	crashedBefore?: number;
}): GpuCrashDecision {
	if (input.safeMode) return { marker: false, why: "safe-mode" };
	if (input.software) return { marker: false, why: "software" };
	if (input.trial) return { marker: true, why: "trial" };
	if (input.crashedBefore !== undefined && input.now - input.crashedBefore < GPU_CRASH_REPEAT_MS)
		return { marker: true, why: "keeps-dying" };
	return { marker: false, why: "recovers" };
}
