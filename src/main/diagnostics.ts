/**
 * "Copy diagnostics" (Settings › Updates & about): one redacted text report of this computer's
 * OMPdesk (versions, machine setup state, the last lines of the runtime log), built on demand
 * in main and handed to the renderer for a preview and a copy. Nothing is uploaded or written
 * anywhere; the report is the only thing that leaves, as the user's own clipboard paste.
 * Electron-free: the app's facts come in as `DiagnosticsSystem`, so tests need no app.
 */

import { redactDiagnosticsText } from "../../resources/gui-bridge/redactor";
import { IPC_COMMANDS } from "../shared/ipc-types";
import type { SetupItemState, SetupPresence, SetupState } from "../shared/setup";
import type { IpcRegistry } from "./web/ipc-registry";

/** Runtime-log entries in a report, newest last (a run of one line folded is one entry). */
const DIAGNOSTICS_LOG_LINES = 100;
/** One log line is cut here: a stack can run to tens of kilobytes. */
const MAX_LINE_CHARS = 3_000;
const MAX_DETAIL_CHARS = 300;
export const DIAGNOSTICS_PROBE_LINES = 30;

export interface DiagnosticsSystem {
	appVersion: string;
	packaged: boolean;
	/** The browser engine's shell (`shellEngine()`); the key keeps the shared shape's name. */
	electron: string;
	chrome: string;
	node: string;
	platform: string;
	arch: string;
	/** `os.release()`: the kernel version. */
	osRelease: string;
	/** `systemVersion()`: the OS marketing version (macOS 15.5.0, Windows 10.0.22631). */
	osVersion: string;
	language: string | null;
}

export interface DiagnosticsInput {
	generatedAt: Date;
	system: DiagnosticsSystem;
	/** null until main's setup service exists. */
	setup: SetupState | null;
	/** Runtime-log lines, oldest first. */
	logLines: readonly string[];
	/** The newest probe lines across both logs, oldest first; none: the section is left out. */
	probeLines?: readonly string[];
	/** The OMPdesk versions of the paired computers connected now, never their names: a mismatch explains a refusal. */
	paired?: PairedVersions | null;
	/** How the window draws: a bug seen only in software rendering or under Reduce motion is told apart by it. */
	display?: DiagnosticsDisplay | null;
	/** Callers a given-up hub call cut off since main started (main-failures.ts); none: the line is left out. */
	cutOffCallers?: number;
}

export interface DiagnosticsDisplay {
	/** `software`: no GPU compositing (a crash fallback, safe mode, a VM). */
	rendering: "hardware" | "software";
	/** The OS's Reduce motion setting; null where Electron cannot tell. */
	reducedMotion: boolean | null;
}

export interface PairedVersions {
	/** Hosts this computer is connected to. */
	hosts: readonly string[];
	/** Devices connected to this computer. */
	devices: readonly string[];
}

function pairedLine(label: string, versions: readonly string[]): string {
	return `${label}: ${versions.length === 0 ? "none connected" : `${versions.length} connected (${versions.join(", ")})`}`;
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function presenceText(presence: SetupPresence | null): string {
	if (!presence) return "not checked yet";
	switch (presence.kind) {
		case "present":
			return `present${presence.version ? ` ${presence.version}` : ""}${presence.path ? ` (${presence.path})` : ""}`;
		case "missing":
			return "missing";
		case "outdated":
			return `outdated ${presence.version} < ${presence.minimum}`;
		case "broken":
			return `broken: ${clip(presence.detail, MAX_DETAIL_CHARS)}`;
	}
}

function setupItemLine(item: SetupItemState): string {
	const failure = item.failure
		? `; failed: ${item.failure.reason}${item.failure.exitCode != null ? ` exit ${item.failure.exitCode}` : ""}${item.failure.detail ? ` ${clip(item.failure.detail, MAX_DETAIL_CHARS)}` : ""}`
		: "";
	return `- ${item.id}${item.required ? " (required)" : ""}: ${item.phase}; ${presenceText(item.presence)}${failure}`;
}

function setupLines(setup: SetupState | null): string[] {
	if (!setup) return ["Machine setup: not started"];
	return [
		`Machine setup: omp ${setup.ompReady ? "ready" : "not ready"}, automatic install ${setup.automatic ? "on" : "off"}`,
		...setup.items.map(setupItemLine),
	];
}

/** The whole report, already redacted. */
export function buildDiagnosticsReport(input: DiagnosticsInput): string {
	const { system, setup } = input;
	const omp = setup?.items.find(item => item.id === "omp")?.presence;
	const ompVersion = omp?.kind === "present" ? omp.version : omp?.kind === "outdated" ? omp.version : null;
	const lines = [
		"OMPdesk diagnostics",
		"Redacted on this computer; nothing was uploaded. Check it before you share it.",
		`Generated: ${input.generatedAt.toISOString()}`,
		"",
		"## Versions",
		`OMPdesk: ${system.appVersion}${system.packaged ? "" : " (dev build)"}`,
		`omp: ${ompVersion ?? "not detected"}`,
		`Shell: ${system.electron}, Chrome ${system.chrome}, Node ${system.node}`,
		`OS: ${system.platform} ${system.osVersion} (kernel ${system.osRelease}), ${system.arch}`,
		`Language: ${system.language ?? "unknown"}`,
		...(input.display
			? [
					`Display: ${input.display.rendering} rendering, Reduce motion ${input.display.reducedMotion === null ? "unknown" : input.display.reducedMotion ? "on" : "off"}`,
				]
			: []),
		...(input.cutOffCallers
			? [`Hub calls given up that cut off their caller (core kept): ${input.cutOffCallers}`]
			: []),
		"",
		"## Machine setup",
		...setupLines(setup),
		"",
		...(input.paired
			? [
					"## Paired computers",
					pairedLine("Hosts this computer uses", input.paired.hosts),
					pairedLine("Devices using this computer", input.paired.devices),
					"",
				]
			: []),
		...(input.probeLines?.length
			? [
					`## Probes (console windows, slow steps, long waits, stalls; last ${DIAGNOSTICS_PROBE_LINES})`,
					...input.probeLines.map(line => clip(redactDiagnosticsText(line), MAX_LINE_CHARS)),
					"",
				]
			: []),
		`## Runtime log (last ${DIAGNOSTICS_LOG_LINES} entries, repeats folded)`,
		...(input.logLines.length > 0
			? input.logLines.map(line => clip(redactDiagnosticsText(line), MAX_LINE_CHARS))
			: ["(empty)"]),
	];
	return redactDiagnosticsText(lines.join("\n"));
}

export interface DiagnosticsDeps {
	system: () => DiagnosticsSystem;
	setupState: () => SetupState | null;
	readLog: (selection: "recent" | "probes") => Promise<string[]>;
	/** The connected paired computers' versions; absent before remote devices exist. */
	pairedVersions?: () => PairedVersions | null;
	/** How the window draws (software rendering, Reduce motion). */
	display?: () => Promise<DiagnosticsDisplay>;
	cutOffCallers?: () => number;
	now?: () => Date;
}

/** The report as of now: what the preview shows and what the diagnostic bundle (diagnostic-bundle.ts) carries. */
export async function currentDiagnosticsReport(deps: DiagnosticsDeps): Promise<string> {
	return buildDiagnosticsReport({
		generatedAt: (deps.now ?? (() => new Date()))(),
		system: deps.system(),
		setup: deps.setupState(),
		logLines: await deps.readLog("recent"),
		probeLines: await deps.readLog("probes"),
		paired: deps.pairedVersions?.() ?? null,
		display: deps.display ? await deps.display().catch(() => null) : null,
		cutOffCallers: deps.cutOffCallers?.() ?? 0,
	});
}

export function registerDiagnosticsIpc(ipc: Pick<IpcRegistry, "handle">, deps: DiagnosticsDeps): void {
	ipc.handle(IPC_COMMANDS.DIAGNOSTICS_BUILD, () => currentDiagnosticsReport(deps));
}
