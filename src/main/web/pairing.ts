/**
 * The desktop's say over a new web device (Settings › Mobile web › "approve new devices on this computer", off by
 * default). A device that Tailscale vouches for is held by `PairingConfirmations` until the desktop approves (a
 * dialog in the desktop renderer) or 60 s pass; with the setting off it is never asked.
 */
import { randomUUID } from "node:crypto";
import type { WebPairingRequest, WebPairingResponse } from "../../shared/mobile-web";
import { DEFAULT_WEB_GRANTS, type WebPermission } from "../../shared/web-protocol";
import { core } from "../core/process";

export const PAIRING_CONFIRM_TIMEOUT_MS = 60_000;

export interface PairingDetails {
	/** Another OMPdesk computer (src/main/remote/) rather than a browser; absent = a browser. */
	kind?: "computer";
	name: string;
	userAgent: string;
	tailscaleLogin: string | null;
	ip: string | null;
}

export type PairingOutcome =
	| { approved: true; grants: WebPermission[] }
	| { approved: false; reason: "declined" | "timeout" };

/** The desktop publishes the prompt. The core owns its deadline and the first answer. */
export class PairingConfirmations {
	readonly #notify: (request: WebPairingRequest) => void;
	readonly #now: () => number;
	readonly #host: number;

	constructor(host: number, opts: { notify: (request: WebPairingRequest) => void; now?: () => number }) {
		this.#host = host;
		this.#notify = opts.notify;
		this.#now = opts.now ?? Date.now;
	}

	/** Ask the desktop; settles with the answer, or `timeout` after 60 s. */
	async request(details: PairingDetails): Promise<PairingOutcome> {
		const request: WebPairingRequest = {
			...details,
			id: randomUUID(),
			grants: [...DEFAULT_WEB_GRANTS],
			expiresAt: this.#now() + PAIRING_CONFIRM_TIMEOUT_MS,
		};
		// Write the registration before notify: a desktop may list or answer from inside that callback.
		const outcome = core()
			.call<PairingOutcome>(
				"web.pairing.request",
				{ host: this.#host, request, deadlineMs: Date.now() + PAIRING_CONFIRM_TIMEOUT_MS },
				{ timeoutMs: PAIRING_CONFIRM_TIMEOUT_MS + 5_000 },
			)
			.then(
				({ result }) => result,
				(): PairingOutcome => ({ approved: false, reason: "declined" }),
			);
		this.#notify(request);
		return outcome;
	}

	/** The desktop's answer; false for an id that already settled or never existed. */
	async respond(response: WebPairingResponse): Promise<boolean> {
		const process = core();
		if (!process.generation) return false;
		return (await process.call<boolean>("web.pairing.respond", { ...response, host: this.#host })).result;
	}

	/** Requests a desktop window that just opened should show. */
	async pending(): Promise<WebPairingRequest[]> {
		const process = core();
		if (!process.generation) return [];
		return (await process.call<WebPairingRequest[]>("web.pairing.pending", { host: this.#host })).result;
	}
}
