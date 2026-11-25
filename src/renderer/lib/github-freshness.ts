/**
 * When a GitHub view reads again by itself (PR Center, the Agents › GitHub views): a view shown again reads in place
 * once its last read is a minute old, a failure holds it back 1, 2, 4 … 15 minutes, and a `gh_paused` refusal holds it
 * until the time GitHub's limit or the background pace names.
 */
export interface Freshness {
	/** When the last read of the view ended well (0 = never). */
	readAt: number;
	/** Failed reads since then. */
	failures: number;
	/** No automatic read before this time. */
	holdUntil: number;
}

export const STALE_MS = 60_000;
const MAX_WAIT_MS = 900_000;

/** The wait after `rounds` waits already: 60 s doubling to 15 min (failures, pending checks). */
export function backoff(rounds: number): number {
	return Math.min(STALE_MS * 2 ** rounds, MAX_WAIT_MS);
}

/** A view never read here reads; one read within the minute or held does not. */
export function shouldReread(f: Freshness | undefined, now: number): boolean {
	return !f || (now - f.readAt >= STALE_MS && now >= f.holdUntil);
}

export function afterSuccess(now: number): Freshness {
	return { readAt: now, failures: 0, holdUntil: 0 };
}

export function afterFailure(
	f: Freshness | undefined,
	now: number,
	error: { code?: string | null; message: string },
): Freshness {
	const failures = f?.failures ?? 0;
	const paused = error.code === "gh_paused" ? pausedUntil(error.message) : null;
	return { readAt: f?.readAt ?? 0, failures: failures + 1, holdUntil: paused ?? now + backoff(failures) };
}

/** The end of a `gh_paused` refusal: its message ends with `paused until <ISO-8601 UTC>`. */
export function pausedUntil(message: string): number | null {
	const match = /paused until (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(message);
	const time = match ? Date.parse(match[1]) : Number.NaN;
	return Number.isNaN(time) ? null : time;
}
