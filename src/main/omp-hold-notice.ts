/**
 * The person is told when runners found that the newest omp breaks this OMPdesk release and OMPdesk holds it back
 * (docs/design/follow-omp.md, the hub's review points 2 and 5): one notification when the hold is first seen, and
 * one more once it has lasted a day, saying for how many days. A hold that is only waiting for runners (`verifying`)
 * is said in Settings alone: runners judge a new omp within the hour. What was told survives a relaunch, so a
 * restart never tells the same hold twice.
 */
import type { OmpUpdateHold } from "../shared/omp-update";

export const HOLD_RETELL_MS = 24 * 60 * 60 * 1000;
/** Prefs key holding the last `HoldTold`. */
export const OMP_HOLD_TOLD_PREF = "ompHoldTold";

/** What this computer has told about a hold: the version, and whether the day-later notification went out too. */
export interface HoldTold {
	version: string;
	retold: boolean;
}

export interface HoldNotice {
	version: string;
	/** Whole days since runners first failed it; 0 within the first day. */
	days: number;
}

/** Whether to notify now, and what is told after it. `told` is returned unchanged when nothing is said. */
export function holdNotice(
	held: OmpUpdateHold | null | undefined,
	told: HoldTold | null,
	now: number,
): { notice: HoldNotice | null; told: HoldTold | null } {
	if (held?.reason !== "failed") return { notice: null, told };
	const since = held.since ? Date.parse(held.since) : Number.NaN;
	const age = Number.isNaN(since) ? 0 : Math.max(0, now - since);
	const notice = { version: held.version, days: Math.floor(age / HOLD_RETELL_MS) };
	// First seen after a day already (the computer was off): one notification says how long, and no second follows.
	if (told?.version !== held.version) {
		return { notice, told: { version: held.version, retold: age >= HOLD_RETELL_MS } };
	}
	if (!told.retold && age >= HOLD_RETELL_MS) return { notice, told: { version: held.version, retold: true } };
	return { notice: null, told };
}

/** A stored `HoldTold`, or null for anything else. */
export function parseHoldTold(value: unknown): HoldTold | null {
	if (typeof value !== "object" || value === null) return null;
	const { version, retold } = value as Record<string, unknown>;
	return typeof version === "string" && typeof retold === "boolean" ? { version, retold } : null;
}
