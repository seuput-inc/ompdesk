/**
 * The person is told when OMPdesk keeps a newer omp off this computer under the verified list (`ompFollowVerified`;
 * docs/design/follow-omp.md, the hub's review points 2 and 5), so the app never stays on an old omp unnoticed:
 * - `failed` (runners found it breaks this release): one notification when the hold is first seen, and one more once
 *   it has lasted a day, saying for how many days.
 * - `verifying` (runners have not judged it): runners judge a new omp within the hour, so a hold this computer has
 *   seen for 6 hours means the hourly run did not reach a verdict (it never ran, failed before it, or could not write
 *   the list). One notification then, and again every 24 hours while it lasts, saying for how long.
 * The `untested-major` hold of the default passes is said in Settings alone. What was told survives a relaunch, so a
 * restart never tells the same hold again before its time; a version that installs or gets verified is no longer
 * held, which ends the notifications.
 */
import { type OmpUpdateHold, VERIFYING_OVERDUE_MS } from "../shared/omp-update";

export const HOLD_RETELL_MS = 24 * 60 * 60 * 1000;
/** A `verifying` hold this computer has seen this long is told. */
export const VERIFYING_TELL_AFTER_MS = VERIFYING_OVERDUE_MS;
/** Prefs key holding the last `HoldTold`. */
export const OMP_HOLD_TOLD_PREF = "ompHoldTold";
/** Prefs key holding the `HeldSeen` of the newest omp held for verification. */
export const OMP_HELD_SEEN_PREF = "ompHeldSeen";

type ToldReason = "verifying" | "failed";

/** What this computer last told about a hold: the version and reason, when, and how many times. */
export interface HoldTold {
	version: string;
	reason: ToldReason;
	/** Epoch milliseconds of the last notification. */
	at: number;
	count: number;
}

export interface HoldNotice {
	version: string;
	reason: ToldReason;
	/** Whole hours since the hold began. */
	hours: number;
	/** Whole days since the hold began; 0 within the first day. */
	days: number;
}

/** Whether to notify now, and what is told after it. `told` is returned unchanged when nothing is said. */
export function holdNotice(
	held: OmpUpdateHold | null | undefined,
	told: HoldTold | null,
	now: number,
): { notice: HoldNotice | null; told: HoldTold | null } {
	const reason = held?.reason;
	if (!held || (reason !== "failed" && reason !== "verifying")) return { notice: null, told };
	const since = held.since ? Date.parse(held.since) : Number.NaN;
	const age = Number.isNaN(since) ? 0 : Math.max(0, now - since);
	const notice = {
		version: held.version,
		reason,
		hours: Math.floor(age / (60 * 60 * 1000)),
		days: Math.floor(age / HOLD_RETELL_MS),
	};
	const same = told?.version === held.version && told.reason === reason ? told : null;
	const tell = (count: number) => ({ notice, told: { version: held.version, reason, at: now, count } });
	if (reason === "verifying") {
		// No `since`: nothing tells how long it waited, so it is never said.
		if (Number.isNaN(since) || age < VERIFYING_TELL_AFTER_MS) return { notice: null, told };
		if (!same) return tell(1);
		return now - same.at >= HOLD_RETELL_MS ? tell(same.count + 1) : { notice: null, told };
	}
	// First seen after a day already (the computer was off): one notification says how long, and no second follows.
	if (!same) return tell(age >= HOLD_RETELL_MS ? 2 : 1);
	return same.count < 2 && age >= HOLD_RETELL_MS ? tell(2) : { notice: null, told };
}

/** A stored `HoldTold`, or null for anything else. */
export function parseHoldTold(value: unknown): HoldTold | null {
	if (typeof value !== "object" || value === null) return null;
	const { version, reason, at, count } = value as Record<string, unknown>;
	return typeof version === "string" &&
		(reason === "verifying" || reason === "failed") &&
		typeof at === "number" &&
		typeof count === "number"
		? { version, reason, at, count }
		: null;
}

/** When this computer first saw `version` held for verification (ISO 8601). */
export interface HeldSeen {
	version: string;
	at: string;
}

/**
 * The first-seen time of `version` from the stored `HeldSeen`, or now for a version not seen before; `store` is the
 * record to keep when it changed (null when the stored one stands).
 */
export function heldSince(stored: unknown, version: string, now: number): { since: string; store: HeldSeen | null } {
	const seen = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
	if (seen.version === version && typeof seen.at === "string" && !Number.isNaN(Date.parse(seen.at))) {
		return { since: seen.at, store: null };
	}
	const at = new Date(now).toISOString();
	return { since: at, store: { version, at } };
}
