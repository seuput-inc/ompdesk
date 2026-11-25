/**
 * One Web Push message to one subscription: the core signs it with the host's VAPID key, encrypts it for the
 * subscription (RFC 8291) and POSTs it (`crates/core/src/web/push.rs`), behind an injectable transport so tests put a
 * fake push service where the network would be. A single attempt, no backoff: a 404/410 means the browser dropped
 * the subscription (the caller forgets it), any other failure is logged and the notice is lost (a push is a courtesy;
 * the page shows the state when opened).
 */
import type { WebPushPayload, WebPushSubscriptionJson } from "../../shared/web-push";
import { core } from "../core/process";

export type PushUrgency = "very-low" | "low" | "normal" | "high";

export interface PushOptions {
	/** Seconds the push service keeps the message for an offline device. */
	ttl: number;
	urgency: PushUrgency;
}

type Delivery = { outcome: "sent" | "gone" } | { outcome: "failed"; message: string };
export type PushResult = Delivery["outcome"];

/** The wire: delivers `body` (UTF-8 JSON) to the push service behind `subscription`, encrypted and VAPID signed. */
export interface PushTransport {
	send(
		subscription: WebPushSubscriptionJson,
		body: string,
		options: PushOptions & { timeoutMs: number },
	): Promise<Delivery>;
}

/** The core waits `timeoutMs` for the push service; this side waits a little longer for the core's answer. */
const CORE_SLACK_MS = 5_000;

/** The core classifies HTTP replies and oversized payloads. An attempt without an HTTP reply rejects. */
export function coreTransport(userData: string): PushTransport {
	return {
		async send(subscription, body, options) {
			const answer = await core().call<Delivery>(
				"push.send",
				{
					userData,
					subscription,
					payload: body,
					ttl: options.ttl,
					urgency: options.urgency,
					timeoutMs: options.timeoutMs,
				},
				{ timeoutMs: options.timeoutMs + CORE_SLACK_MS },
			);
			return answer.result;
		},
	};
}

const SEND_TIMEOUT_MS = 10_000;

export interface PushSenderDeps {
	/** The folder the core keeps the VAPID keypair in (`web-push.json`). */
	userData: string;
	transport?: PushTransport | undefined;
	log?: ((message: string) => void) | undefined;
}

export class PushSender {
	readonly #deps: PushSenderDeps;
	readonly #transport: PushTransport;

	constructor(deps: PushSenderDeps) {
		this.#deps = deps;
		this.#transport = deps.transport ?? coreTransport(deps.userData);
	}

	/** Never throws: `gone` (404/410) tells the caller to forget the subscription. */
	async send(
		subscription: WebPushSubscriptionJson,
		payload: WebPushPayload,
		options: PushOptions,
	): Promise<PushResult> {
		const body = JSON.stringify(payload);
		try {
			const result = await this.#transport.send(subscription, body, {
				...options,
				timeoutMs: SEND_TIMEOUT_MS,
			});
			if (result.outcome === "failed") this.#deps.log?.(result.message);
			return result.outcome;
		} catch (error) {
			this.#deps.log?.(`web push failed: ${error instanceof Error ? error.message : String(error)}`);
			return "failed";
		}
	}
}
