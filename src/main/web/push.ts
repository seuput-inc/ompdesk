/**
 * One Web Push message to one subscription: the core signs it with the host's VAPID key, encrypts it for the
 * subscription (RFC 8291) and POSTs it (`crates/core/src/web/push.rs`), behind an injectable transport so tests put a
 * fake push service where the network would be. A send that got no answer, or a push service fault or rate limit
 * (5xx, 429; the core marks it `retry`), is tried once more after 2 s unless a newer push with the same tag went out
 * meanwhile; a 404/410 means the browser dropped the subscription (the caller forgets it); any other failure is logged
 * and the notice is lost (a push is a courtesy; the page shows the state when opened).
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { WebPushPayload, WebPushSubscriptionJson } from "../../shared/web-push";
import { core } from "../core/process";

export type PushUrgency = "very-low" | "low" | "normal" | "high";

export interface PushOptions {
	/** Seconds the push service keeps the message for an offline device. */
	ttl: number;
	urgency: PushUrgency;
}

/** What one attempt came to: the core's classification, or this side's when the core gave no answer. */
export type PushDelivery = { outcome: "sent" | "gone" } | { outcome: "failed"; message: string; retry?: boolean };
export type PushResult = PushDelivery["outcome"];

/** The wire: delivers `body` (UTF-8 JSON) to the push service behind `subscription`, encrypted and VAPID signed. */
export interface PushTransport {
	send(
		subscription: WebPushSubscriptionJson,
		body: string,
		options: PushOptions & { timeoutMs: number },
	): Promise<PushDelivery>;
}

/** The core waits `timeoutMs` for the push service; this side waits a little longer for the core's answer. */
const CORE_SLACK_MS = 5_000;

/** The core classifies HTTP replies and oversized payloads. An attempt without an HTTP reply rejects. */
export function coreTransport(userData: string): PushTransport {
	return {
		async send(subscription, body, options) {
			const answer = await core().call<PushDelivery>(
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
export const PUSH_RETRY_DELAY_MS = 2_000;

export interface PushSenderDeps {
	/** The folder the core keeps the VAPID keypair in (`web-push.json`). */
	userData: string;
	transport?: PushTransport | undefined;
	log?: ((message: string) => void) | undefined;
	/** The pause before the one retry; tests resolve it at once. */
	wait?: ((ms: number) => Promise<void>) | undefined;
}

export class PushSender {
	readonly #deps: PushSenderDeps;
	readonly #transport: PushTransport;
	readonly #wait: (ms: number) => Promise<void>;
	/** The newest send per subscription and tag: a retry never lands over a newer push (a `clear` undone). */
	readonly #latest = new Map<string, number>();
	#sends = 0;

	constructor(deps: PushSenderDeps) {
		this.#deps = deps;
		this.#transport = deps.transport ?? coreTransport(deps.userData);
		this.#wait = deps.wait ?? (ms => sleep(ms));
	}

	/** Never throws: `gone` (404/410) tells the caller to forget the subscription. */
	async send(
		subscription: WebPushSubscriptionJson,
		payload: WebPushPayload,
		options: PushOptions,
	): Promise<PushResult> {
		const body = JSON.stringify(payload);
		const key = `${subscription.endpoint}\n${payload.tag}`;
		const mine = ++this.#sends;
		this.#latest.set(key, mine);
		try {
			let result = await this.#attempt(subscription, body, options);
			if (result.outcome === "failed" && result.retry) {
				await this.#wait(PUSH_RETRY_DELAY_MS);
				if (this.#latest.get(key) !== mine) {
					this.#deps.log?.(`${result.message}; not retried: a newer push with its tag went out`);
					return "failed";
				}
				result = await this.#attempt(subscription, body, options);
			}
			if (result.outcome === "failed") this.#deps.log?.(result.message);
			return result.outcome;
		} finally {
			if (this.#latest.get(key) === mine) this.#latest.delete(key);
		}
	}

	/** One attempt; no answer at all (the core faulted, the network failed) is worth a retry too. */
	async #attempt(subscription: WebPushSubscriptionJson, body: string, options: PushOptions): Promise<PushDelivery> {
		try {
			return await this.#transport.send(subscription, body, { ...options, timeoutMs: SEND_TIMEOUT_MS });
		} catch (error) {
			return {
				outcome: "failed",
				message: `web push failed: ${error instanceof Error ? error.message : String(error)}`,
				retry: true,
			};
		}
	}
}
