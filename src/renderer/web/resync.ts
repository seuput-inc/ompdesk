/**
 * Catching up after a reconnect that missed events (ws-transport.ts `onResync`), in place: the page reads its state
 * again (resync-page.ts: the tab list, the visible tabs' transcripts and session state, the open asks and the
 * snapshots the missed pushes would have replaced) instead of loading itself again, so a phone that lost its link
 * mid-reply keeps its scroll, its draft and whatever the person was doing. A failed pass is tried again after a
 * short wait (`retryMs`, growing); only after `maxFailures` failures in a row does the page give up and reload,
 * and that reload waits for a moment nobody uses the page (sw-update.ts `reloadWhenUnused`).
 */
import type { ShellStreamReset } from "../../preload/shell";

interface DeferredReload {
	recheck(): void;
	cancel(): void;
}

export interface PageResyncOptions {
	/** Read the page's state again; false (or a throw) when it could not (the link dropped again, the host refused). */
	run: () => Promise<boolean>;
	/** A run exhausted its attempts. A new link can cancel a deferred reload and recover in place. */
	giveUp: (failures: number) => DeferredReload | void;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	retryMs?: number;
	maxFailures?: number;
}

export class PageResync {
	readonly #options: PageResyncOptions;
	#running = false;
	#again: "required" | "if-failed" | null = null;
	#failures = 0;
	#retry: unknown = null;
	#lastResort: DeferredReload | void = undefined;
	/** Passes that completed, for the tests and the runtime log. */
	passes = 0;

	constructor(options: PageResyncOptions) {
		this.#options = options;
	}

	/** The page must catch up: a pass runs now, or once more after the one in flight. */
	request(): void {
		this.#lastResort?.cancel();
		this.#lastResort = undefined;
		if (this.#failures >= (this.#options.maxFailures ?? 3)) this.#failures = 0;
		if (this.#retry !== null) {
			(this.#options.clearTimer ?? clearTimeout)(this.#retry as ReturnType<typeof setTimeout>);
			this.#retry = null;
		}
		if (this.#running) {
			this.#again = "required";
			return;
		}
		void this.#pass();
	}

	/** A resumed socket or a paired host came back. A page already caught up has nothing to read. */
	linkAvailable(): void {
		if (this.#running) this.#again ??= "if-failed";
		else if (this.#failures > 0) {
			// A hello reporting missed events calls request() in this same tick. One pass covers both signals.
			queueMicrotask(() => {
				if (!this.#running && this.#failures > 0) this.request();
			});
		}
	}

	recheckReload(): void {
		this.#lastResort?.recheck();
	}

	async #pass(): Promise<void> {
		this.#running = true;
		this.#again = null;
		let ok: boolean;
		try {
			ok = await this.#options.run();
		} catch {
			ok = false;
		}
		this.#running = false;
		if (ok) {
			this.passes++;
			this.#failures = 0;
			if (this.#again === "required") this.request();
			return;
		}
		this.#failures++;
		if (this.#again) {
			this.request();
			return;
		}
		const max = this.#options.maxFailures ?? 3;
		if (this.#failures >= max) {
			this.#lastResort = this.#options.giveUp(this.#failures);
			return;
		}
		const wait = (this.#options.retryMs ?? 2000) * this.#failures;
		this.#retry = (this.#options.setTimer ?? setTimeout)(() => {
			this.#retry = null;
			this.request();
		}, wait);
	}
}

/** The serving computer's link to another host can recover without a new page socket. */
export function onHostOnline(wake: () => void): (() => void) | undefined {
	let online = new Set<string>();
	return window.omp?.remote?.onState?.(state => {
		const next = new Set(state.hosts.filter(host => host.state === "online").map(host => host.deviceId));
		const gained = [...next].some(device => !online.has(device));
		online = next;
		if (gained) wake();
	});
}

export function installShellResync(
	stream: ShellStreamReset,
	run: () => Promise<boolean>,
	onFailure: (failures: number) => void,
): () => void {
	let disposed = false;
	const wake = () => {
		if (!disposed && stream.pending()) resync.request();
	};
	const resync = new PageResync({
		run: async () => {
			const token = stream.pending();
			if (!token) return true;
			const ok = await run();
			if (ok) stream.acknowledge(token);
			return ok;
		},
		giveUp: onFailure,
	});
	const unsubscribe = stream.onReset(wake);
	const visible = () => {
		if (document.visibilityState === "visible") wake();
	};
	document.addEventListener("visibilitychange", visible);
	window.addEventListener("online", wake);
	const unsubscribeRemote = onHostOnline(wake);
	return () => {
		disposed = true;
		unsubscribe();
		unsubscribeRemote?.();
		document.removeEventListener("visibilitychange", visible);
		window.removeEventListener("online", wake);
	};
}
