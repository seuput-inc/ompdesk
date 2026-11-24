/**
 * Per-device model-use limits on the host (D65): main's client of the core's `quota` hub instance
 * (`native/ompdesk/crates/core/src/remote/quota.rs`), which keeps how many model requests (prompts, steers,
 * follow-ups, compactions…) and tokens a paired device may spend on this computer's models per day, counts them per
 * local calendar day on the device's record (`remote-peers.json` for a paired computer, `web-devices.json` for a
 * Mobile web device) and writes them after it answers.
 *
 * LocalHostServices and the web router `reserve` a request before they forward a model command (which commands:
 * quota-commands.ts) or start a benchmark, a model setup run or a saved schedule, and `refund` it when that work did
 * not run. `reserve` is a synchronous hub call answered from the core's memory under one lock, so N parallel requests
 * at limit - 1 let exactly one through. Tokens come from each assistant `message_end`'s usage (`record`, a call main
 * does not wait for). A turn already running when the limit is crossed finishes; the next request is refused.
 */
import type { PeerLimits, PeerUsageView } from "../../shared/ipc-types";
import { hub } from "../core/hub";

export type QuotaRefusal = "requests" | "tokens";

/** A request counted ahead of its work: give it back with `refund` when the work did not run. */
export type QuotaReservation = { ok: true; refund(): void } | { ok: false; refusal: QuotaRefusal };

/** A device's limits and today's usage, as Settings shows them. */
export interface QuotaView {
	limits: PeerLimits;
	usage: PeerUsageView;
}

type Reserved = { ok: true; day: string } | { ok: false; refusal: QuotaRefusal };

export class PeerQuota {
	readonly #store: "peers" | "web";
	readonly #userData: string;
	readonly #changed: (deviceId: string) => void;
	#id: number | null = null;

	/** `store`: whose records under `userData` (a paired computer's or a Mobile web device's). */
	constructor(store: "peers" | "web", userData: string, changed: (deviceId: string) => void) {
		this.#store = store;
		this.#userData = userData;
		this.#changed = changed;
	}

	/** The core's instance, opened on first use and again after a lost core (which reads the files again). */
	#instance = (): number => {
		if (this.#id !== null) return this.#id;
		const opened = hub().nextId();
		hub().open(
			opened,
			"quota",
			{ store: this.#store, userData: this.#userData },
			{
				item: () => {},
				ask: question => {
					throw new Error(`the quota asks nothing (${question})`);
				},
				lost: () => {
					if (this.#id === opened) this.#id = null;
				},
			},
		);
		this.#id = opened;
		return opened;
	};

	/**
	 * Refuse, or count `requests` now. A weighted reservation (a benchmark's models × runs) is refused whole when it
	 * would take the day's count past the limit, never let through to cross it.
	 */
	reserve(deviceId: string, requests = 1): QuotaReservation {
		const reserved = hub().callOnce<Reserved>(this.#instance, "reserve", { deviceId, requests });
		if (!reserved.ok) return reserved;
		this.#changed(deviceId);
		let refunded = false;
		return {
			ok: true,
			refund: () => {
				if (refunded) return;
				refunded = true;
				hub().callOnce(this.#instance, "refund", { deviceId, day: reserved.day, requests });
				this.#changed(deviceId);
			},
		};
	}

	/** Counts spent tokens (or requests): called from the reply's events, so a core that cannot be reached drops it. */
	record(deviceId: string, spent: { requests?: number; tokens?: number }): void {
		let instance: number;
		try {
			instance = this.#instance();
		} catch {
			return;
		}
		void hub()
			.callLater(instance, "record", { deviceId, ...spent })
			.catch(() => undefined);
		this.#changed(deviceId);
	}

	/** Replace a device's limits; an empty object removes them. False for an unknown device. */
	setLimits(deviceId: string, limits: PeerLimits): boolean {
		return hub().callOnce<boolean>(this.#instance, "setLimits", { deviceId, limits });
	}

	/** A device's limits and today's usage (zero once the stored day is over); null for an unknown device. */
	view(deviceId: string): QuotaView | null {
		return hub().callOnce<QuotaView | null>(this.#instance, "view", { deviceId });
	}

	/** Lets go of the core's instance. */
	close(): void {
		if (this.#id !== null) hub().close(this.#id);
		this.#id = null;
	}
}
