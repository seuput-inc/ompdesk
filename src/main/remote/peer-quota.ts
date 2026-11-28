/**
 * Per-device model-use limits on the host (D65): main's client of the core's `quota` hub instance
 * (`native/ompdesk/crates/core/src/remote/quota.rs`), which keeps how many model requests (prompts, steers,
 * follow-ups, compactions…) and tokens a paired device may spend on this computer's models per day, counts them per
 * local calendar day. Reservations and refunds are written before the core answers.
 *
 * LocalHostServices and the web router `reserve` a request before they forward a model command (which commands:
 * quota-commands.ts) or start a benchmark, a model setup run or a saved schedule, and `refund` it when that work did
 * not run. The durable receipt belongs to the authenticated device and survives day turnover. Token events remain
 * best effort; a turn already running when the limit is crossed finishes.
 */
import { randomUUID } from "node:crypto";
import { codedError } from "../../shared/ipc-error-codes";
import type { PeerLimits, PeerUsageView } from "../../shared/ipc-types";
import { MODEL_NOT_STARTED } from "../../shared/rpc-types";
import { hub } from "../core/hub";

export type QuotaRefusal = "requests" | "tokens";

/** A request counted ahead of its work: give it back with `refund` when the work did not run. */
export type QuotaReservation = { ok: true; refund(): void } | { ok: false; refusal: QuotaRefusal };

/** A device's limits and today's usage, as Settings shows them. */
export interface QuotaView {
	limits: PeerLimits;
	usage: PeerUsageView;
}

type Reserved =
	| { ok: true }
	| { ok: false; refusal: QuotaRefusal }
	| { ok: false; refusal: "duplicate"; charged: boolean };

export class DuplicateReservation extends Error {
	constructor(readonly charged: boolean) {
		super(codedError("quota_duplicate", "This request was already reserved. Check its original result.").message);
	}
}

/** Only the host which rejected the call before dispatch can mark the result refundable. */
export function machineModelNotStarted(result: unknown): boolean {
	return (
		typeof result === "object" && result !== null && MODEL_NOT_STARTED in result && result[MODEL_NOT_STARTED] === true
	);
}

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
	reserve(deviceId: string, requests: number, reservationId: string): QuotaReservation {
		const reserved = this.#reserve(deviceId, requests, reservationId);
		if (!reserved.ok) {
			if (reserved.refusal === "duplicate") throw new DuplicateReservation(reserved.charged);
			return reserved;
		}
		this.#changed(deviceId);
		return {
			ok: true,
			refund: () => {
				hub().callOnce(this.#instance, "refund", { deviceId, reservationId });
				this.#changed(deviceId);
			},
		};
	}

	/** Coalesced inputs need a delivery receipt but only the resulting run consumes quota. */
	remember(deviceId: string, reservationId: string): boolean {
		const received = this.#reserve(deviceId, 0, reservationId);
		if (!received.ok && received.refusal !== "duplicate") throw new Error("A delivery receipt cannot consume quota");
		return received.ok;
	}

	#reserve(deviceId: string, requests: number, reservationId: string): Reserved {
		return hub().callOnce<Reserved>(this.#instance, "reserve", {
			deviceId,
			requests,
			reservationId,
			attemptId: randomUUID(),
		});
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
