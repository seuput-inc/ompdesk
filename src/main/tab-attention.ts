/**
 * What main knows of the person looking at a tab: the desktop banners shown about it, closed once the person looks at
 * it (a focused window shows it, or a page switches to it), and when that last happened after its last run ended, so a
 * phone page restoring its saved done marks (renderer lib/unread-marks.ts) drops a mark for a tab seen since. Unread
 * stays each device's own otherwise: another window merely holding a tab on screen counts for nothing.
 * Electron-free: a banner is anything with `close`.
 */

export interface Closable {
	close(): void;
}

export class TabAttention {
	readonly #now: () => number;
	/** Banners about one tab that are still up. */
	readonly #banners = new Map<string, Set<Closable>>();
	readonly #seenAt = new Map<string, number>();
	readonly #settledAt = new Map<string, number>();

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** A banner about `tabId` went up; the returned function forgets it (it was clicked or dismissed). */
	banner(tabId: string, banner: Closable): () => void {
		const shown = this.#banners.get(tabId) ?? new Set<Closable>();
		this.#banners.set(tabId, shown.add(banner));
		return () => {
			shown.delete(banner);
			if (shown.size === 0 && this.#banners.get(tabId) === shown) this.#banners.delete(tabId);
		};
	}

	/** The person looked at the tab: its banners close. */
	seen(tabId: string): void {
		this.#seenAt.set(tabId, this.#now());
		const shown = this.#banners.get(tabId);
		this.#banners.delete(tabId);
		for (const banner of shown ?? []) banner.close();
	}

	/** A run of the tab ended. */
	settled(tabId: string): void {
		this.#settledAt.set(tabId, this.#now());
	}

	/** The tab left the pool. */
	released(tabId: string): void {
		this.#banners.delete(tabId);
		this.#seenAt.delete(tabId);
		this.#settledAt.delete(tabId);
	}

	/** Tabs the person looked at after their last run ended. */
	seenSinceRun(): string[] {
		const seen: string[] = [];
		for (const [tabId, at] of this.#seenAt) if (at >= (this.#settledAt.get(tabId) ?? 0)) seen.push(tabId);
		return seen;
	}
}
