/**
 * The paired page's recent link events, for Settings › Mobile web's Connection fold: the link dropping and coming
 * back, a catch-up after missed events, a reload of the page (noted once the next page load connects, with its
 * reason). Kept in the page's memory only, the newest `LINK_LOG_MAX`; `web-boot.ts` feeds it. No React here: the
 * boot module imports it.
 */
import type { WsConnectionState } from "./ws-transport";

export type LinkEventKind = "dropped" | "reconnected" | "resynced" | "reloaded";

export interface LinkEvent {
	kind: LinkEventKind;
	/** When it happened (ms since the epoch). */
	at: number;
	/** The resync's cause or the reload's reason. */
	detail?: string;
}

export const LINK_LOG_MAX = 20;

export class LinkLog {
	#entries: readonly LinkEvent[] = [];
	#down = false;
	readonly #listeners = new Set<() => void>();

	readonly entries = (): readonly LinkEvent[] => this.#entries;

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	note(kind: LinkEventKind, detail?: string, at = Date.now()): void {
		this.#entries = [...this.#entries, { kind, at, ...(detail ? { detail } : {}) }].slice(-LINK_LOG_MAX);
		for (const listener of this.#listeners) listener();
	}

	/** The transport's state: a drop of a link that was up, and its return. */
	state(state: WsConnectionState): void {
		if (state === "reconnecting" && !this.#down) {
			this.#down = true;
			this.note("dropped");
		} else if (state === "open" && this.#down) {
			this.#down = false;
			this.note("reconnected");
		}
	}
}

export const linkLog = new LinkLog();
