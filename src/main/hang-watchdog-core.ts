import { readFileSync, rmSync, statSync } from "node:fs";

const MAX_MARKER_BYTES = 64 * 1024;

/** What main was doing: launching, running, quitting (the teardown), or applying an update. */
const MAIN_PHASES = ["startup", "running", "quit", "update"] as const;
export type MainPhase = (typeof MAIN_PHASES)[number];
/** Steps a marker names: the stalled one last, the ones before it for context. */
const HANG_STEP_HISTORY = 8;
/** The most facts of the computer a marker is read with. */
const HANG_MACHINE_FACTS = 12;

export interface HangMarker {
	detectedAt: number;
	pid: number;
	unresponsiveMs: number;
	/** False for a marker the stall never cleared (a deadlock, or the app was killed during it). */
	selfRecovered: boolean;
	/** Main's phase and last steps when the stall was detected (absent in markers older builds wrote). */
	phase?: MainPhase;
	steps?: string[];
	/** Native host samples taken during the stall, absent if the app ended first. */
	machine?: Record<string, string | number | boolean>;
}

function parseMarker(raw: string): HangMarker | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const { detectedAt, pid, unresponsiveMs, selfRecovered, phase, steps, machine } = value as Record<string, unknown>;
	if (typeof detectedAt !== "number" || !Number.isFinite(detectedAt)) return null;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
	if (typeof unresponsiveMs !== "number" || !Number.isFinite(unresponsiveMs) || unresponsiveMs < 0) return null;
	const marker: HangMarker = { detectedAt, pid, unresponsiveMs, selfRecovered: selfRecovered === true };
	const knownPhase = MAIN_PHASES.find(name => name === phase);
	if (knownPhase && Array.isArray(steps) && steps.every(step => typeof step === "string")) {
		marker.phase = knownPhase;
		marker.steps = steps.slice(-HANG_STEP_HISTORY);
	}
	if (typeof machine === "object" && machine !== null) {
		const facts = Object.entries(machine).filter(([, fact]) => ["string", "number", "boolean"].includes(typeof fact));
		marker.machine = Object.fromEntries(facts.slice(0, HANG_MACHINE_FACTS)) as HangMarker["machine"];
	}
	return marker;
}

/** Reads and removes the previous run's marker; null when there is none or it is unreadable. */
export function consumeHangMarker(markerPath: string): HangMarker | null {
	let marker: HangMarker | null = null;
	try {
		if (statSync(markerPath).size <= MAX_MARKER_BYTES) marker = parseMarker(readFileSync(markerPath, "utf8"));
	} catch {
		return null;
	}
	try {
		rmSync(markerPath, { force: true });
	} catch {
		// A marker that cannot be removed may be reported twice; it never blocks launch.
	}
	return marker;
}
