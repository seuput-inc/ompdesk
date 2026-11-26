/**
 * Whether the person is at a desktop, for the paired phones' pushes (web-push-notifier.ts) and the desktop banner of a
 * focused window (`SYSTEM_DESKTOP_AWAY`). Away = the screen is locked, or no keyboard or mouse input for
 * `DESKTOP_AWAY_SECONDS`; a sleeping computer runs nothing and its paired link drops. A paired computer reports its own
 * presence to every host it is connected to (`presence.report`, every `PRESENCE_REPORT_MS`), so a person at that
 * computer, who sees the host's sessions in its sidebar, keeps the host's phones quiet too. A report counts only while
 * fresh: a computer whose link or reporter stopped stops counting.
 *
 * Unknown presence never silences a phone (after Orca's desktop-away state, stablyai/orca
 * `src/main/notifications/desktop-away-state.ts`, MIT; re-implemented).
 */

/** Idle seconds after which a desktop counts as away (Orca's threshold). */
export const DESKTOP_AWAY_SECONDS = 180;
/** How often a paired computer tells its hosts whether the person is at it. */
export const PRESENCE_REPORT_MS = 30_000;
/** A report older than this no longer counts (three missed reports). */
export const PRESENCE_FRESH_MS = 3 * PRESENCE_REPORT_MS;

/** Electron's `powerMonitor`, narrowed to what is read. */
export interface IdleMonitor {
	getSystemIdleState(threshold: number): string;
	getSystemIdleTime(): number;
}

/** True when this computer's person is away, false when present, undefined when it cannot be told. */
export function readDesktopAway(monitor: IdleMonitor): boolean | undefined {
	try {
		const state = monitor.getSystemIdleState(DESKTOP_AWAY_SECONDS);
		if (state === "locked" || state === "idle") return true;
		const idle = monitor.getSystemIdleTime();
		return Number.isFinite(idle) && idle >= 0 ? idle >= DESKTOP_AWAY_SECONDS : undefined;
	} catch {
		return undefined;
	}
}

export class DesktopPresence {
	readonly #local: () => boolean | undefined;
	readonly #now: () => number;
	/** Paired computers' last reports: away, and when. */
	readonly #peers = new Map<string, { away: boolean; at: number }>();

	constructor(local: () => boolean | undefined, now: () => number = Date.now) {
		this.#local = local;
		this.#now = now;
	}

	/** A paired computer said whether its person is at it. */
	report(deviceId: string, away: boolean): void {
		this.#peers.set(deviceId, { away, at: this.#now() });
	}

	/** Its link ended: it says nothing any more. */
	forget(deviceId: string): void {
		this.#peers.delete(deviceId);
	}

	/** False while a person is at this computer or at a paired one that reported lately; else this computer's read. */
	away(): boolean | undefined {
		const now = this.#now();
		for (const [deviceId, report] of this.#peers) {
			if (now - report.at > PRESENCE_FRESH_MS) this.#peers.delete(deviceId);
			else if (!report.away) return false;
		}
		return this.#local();
	}
}
