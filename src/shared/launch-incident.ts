/**
 * What the last launch left for a report (Orca FG62): main builds it at launch from the hang watchdog's report or the
 * launch guard's safe mode and leaves it in prefs; the first window offers it (dialogs/LaunchIncidentNotice). Its own
 * module, apart from shared/feedback.ts, so the phone's first screen (which never offers it) does not carry it.
 */

/** A main-thread hang, or launches that kept failing (safe mode). */
export interface LaunchIncident {
	kind: "hang" | "unstable";
	/** Epoch ms of the hang, or of this launch. */
	at: number;
	/** The record, in English, for the issue's error details. */
	detail: string;
}

/** Prefs key main writes at a launch that has an incident to offer; the first window to read it takes it. */
export const LAUNCH_INCIDENT_PREF = "launchIncident";

/**
 * The incident this launch offers to report: the newest `main-thread-hang` line the shell's watchdog left (its
 * marker, `tauri-shell/src/watchdog/marker.rs`), else safe mode after launches that kept failing. Orca offers the
 * same after a crash or a freeze (renderer/src/components/crash-report/CrashReportDialog.tsx:63).
 */
export function launchIncidentOf(
	reports: readonly { source: string; message: string; details?: object }[],
	safeMode: boolean,
	now: number,
): LaunchIncident | null {
	const hang = reports.findLast(report => report.source === "main-thread-hang");
	if (hang) {
		const details = (hang.details ?? {}) as Record<string, unknown>;
		const at = typeof details.detectedAt === "string" ? Date.parse(details.detectedAt) : Number.NaN;
		const lines = [hang.message];
		for (const key of ["detectedAt", "phase", "steps", "unresponsiveMs"] as const) {
			const value = details[key];
			if (typeof value === "string" || typeof value === "number") lines.push(`${key}: ${value}`);
		}
		return { kind: "hang", at: Number.isFinite(at) ? at : now, detail: `main-thread-hang\n${lines.join("\n")}` };
	}
	if (safeMode)
		return {
			kind: "unstable",
			at: now,
			detail: "launch-guard\nThree launches in a row ended within 10 minutes; this launch started in safe mode.",
		};
	return null;
}

export function parseLaunchIncident(value: unknown): LaunchIncident | null {
	if (typeof value !== "object" || value === null) return null;
	const { kind, at, detail } = value as Record<string, unknown>;
	if ((kind !== "hang" && kind !== "unstable") || typeof at !== "number" || typeof detail !== "string") return null;
	return { kind, at, detail };
}
