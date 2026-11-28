import type { ClaudeApiRoute } from "../../src/shared/rpc-types";
import { isClaudeKeyProvider } from "./claude-key-models";
import { asRecord } from "./params";

export const ROUTE_ENTRY = "ompdesk.claude-api-route";
export const DISPATCH_ENTRY = "ompdesk.claude-api-dispatch";
export type Pin = Omit<ClaudeApiRoute, "refusal"> & { modelId: string };
export const activePins = new WeakMap<object, Pin>();

export function receipt({ provider, skipped }: Pin): ClaudeApiRoute {
	return { provider, skipped };
}

const reasons: Record<ClaudeApiRoute["skipped"][number]["reason"], true> = {
	disabled: true,
	unavailable: true,
	unverified: true,
	"not-offered": true,
	"not-selected": true,
};

type Refusal = ClaudeApiRoute["refusal"];

function validSeconds(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readRefusal(value: unknown): Refusal {
	if (value === "rateLimit" || value === "spendLimit" || value === "billing" || value === "lowCredit") return value;
	const { kind, retryAfterSeconds, resumesAt } = asRecord(value);
	if (kind === "transient" && validSeconds(retryAfterSeconds)) return { kind, retryAfterSeconds };
	if (kind === "console") return { kind };
	if (kind === "monthly") {
		if (resumesAt === undefined) return { kind };
		if (typeof resumesAt === "number" && Number.isSafeInteger(resumesAt)) {
			const date = new Date(resumesAt);
			if (date.getUTCDate() === 1 && resumesAt % 86_400_000 === 0) return { kind, resumesAt };
		}
	}
}

export function readClaudeApiRoute(value: unknown): ClaudeApiRoute | undefined {
	if (
		!value ||
		typeof value !== "object" ||
		!("provider" in value) ||
		typeof value.provider !== "string" ||
		!isClaudeKeyProvider(value.provider) ||
		!("skipped" in value) ||
		!Array.isArray(value.skipped)
	)
		return;
	const skipped: ClaudeApiRoute["skipped"] = [];
	for (const row of value.skipped) {
		if (
			!row ||
			typeof row.provider !== "string" ||
			!isClaudeKeyProvider(row.provider) ||
			typeof row.reason !== "string" ||
			!Object.hasOwn(reasons, row.reason)
		)
			return;
		skipped.push({ provider: row.provider, reason: row.reason });
	}
	const refusal = "refusal" in value && readRefusal(value.refusal);
	return refusal ? { provider: value.provider, skipped, refusal } : { provider: value.provider, skipped };
}

interface JournalRow {
	type: string;
	role?: string;
	customType?: string;
	data?: unknown;
	message?: { role: string };
}

/** A manual pick, even of the very same model, ends automatic routing. */
function changedPin(row: JournalRow): Pin | null | undefined {
	if (row.type === "model_change" && row.role !== "fallback" && row.role !== "prewalk") return null;
	if (row.type !== "custom" || row.customType !== ROUTE_ENTRY) return undefined;
	const pin = row.data;
	if (!pin || typeof pin !== "object" || !("modelId" in pin) || typeof pin.modelId !== "string") return null;
	const route = readClaudeApiRoute(pin);
	return route ? { provider: route.provider, skipped: route.skipped, modelId: pin.modelId } : null;
}

export function journalPin(branch: readonly JournalRow[]): Pin | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const next = changedPin(branch[i]);
		if (next !== undefined) return next ?? undefined;
	}
	return undefined;
}

/** A lost response is indistinguishable from a billed request after process loss. */
export function claudeReplayBlocked(branch: readonly JournalRow[]): boolean {
	for (let i = branch.length - 1; i >= 0; i--) {
		const row = branch[i];
		if (row.type === "custom" && row.customType === DISPATCH_ENTRY) return true;
		if (row.message?.role === "user" || changedPin(row) !== undefined) return false;
	}
	return false;
}

/** Stock replaces onPayload for its thinking probes; only the actual answer calls ours. */
export function claudeDispatch(probeLimit: number) {
	const controller = new AbortController();
	let probes = 0;
	let phase: "probing" | "answer" | "sent" | { retryBody: string } = "probing";
	const stop = (message: string): never => {
		controller.abort(new Error(message));
		throw controller.signal.reason;
	};
	return {
		signal: controller.signal,
		stop,
		answer() {
			controller.signal.throwIfAborted();
			if (phase !== "probing" && phase !== "answer")
				stop("Claude API request was already sent; automatic replay is disabled");
			phase = "answer";
		},
		retryAnswer(body: unknown) {
			controller.signal.throwIfAborted();
			if (phase !== "sent" || typeof body !== "string")
				return stop("Only the same refused Claude API request can retry");
			phase = { retryBody: body };
		},
		attempt(body?: unknown): "probe" | "answer" {
			controller.signal.throwIfAborted();
			if (typeof phase === "object" && phase.retryBody !== body)
				return stop("The refused Claude API request changed; automatic replay is disabled");
			if (phase === "answer" || typeof phase === "object") {
				phase = "sent";
				return "answer";
			}
			if (phase === "probing" && ++probes <= probeLimit) return "probe";
			return stop("Claude API request was already sent; automatic replay is disabled");
		},
	};
}

const lowCredit = "Your credit balance is too low to access the Anthropic API";
const consoleLimit = /^You have reached your specified (?:workspace )?API usage limits\b/;
const monthlyCode = "enforced_spend_limit_reached";

/** Classify the Messages response at the HTTP boundary, before stock formats its error text. */
export function claudeRouteRefusal(status: number, retryAfter: string | null, body: unknown): Refusal {
	if (status === 402) return "billing";
	const envelope = asRecord(body);
	const error = asRecord(envelope.type === "error" ? envelope.error : undefined);
	if (status === 400 && error.type === "invalid_request_error" && typeof error.message === "string") {
		if (consoleLimit.test(error.message)) return { kind: "console" };
		if (error.message.startsWith(lowCredit)) return "lowCredit";
	}
	if (status !== 429) return;
	if (error.type !== "rate_limit_error" || typeof error.message !== "string") return "rateLimit";
	const { details } = error;
	if (details !== undefined && (!details || typeof details !== "object" || Array.isArray(details))) return "rateLimit";
	const code = asRecord(details).error_code;
	if (retryAfter === null && code === monthlyCode) {
		const day = /\bYou will regain access on (\d{4}-(?:0[1-9]|1[0-2])-01) at 00:00 UTC\.$/.exec(error.message)?.[1];
		return day ? { kind: "monthly", resumesAt: Date.parse(`${day}T00:00:00Z`) } : { kind: "monthly" };
	}
	if ((code === undefined || code === "ramp_limit_exceeded") && retryAfter !== null && /^\d+$/.test(retryAfter)) {
		const seconds = Number(retryAfter);
		if (validSeconds(seconds)) return { kind: "transient", retryAfterSeconds: seconds };
	}
	return "rateLimit";
}

/** Anthropic's documented spend refusals (api/rate-limits and api-credits-for-subscribers). */
export function anthropicSpendRefusal(message: string): "spendLimit" | "lowCredit" | undefined {
	if (message.startsWith(lowCredit)) return "lowCredit";
	const http = /\b(400|402|429) (\{.*\})/s.exec(message);
	if (!http) return undefined;
	try {
		const envelope = JSON.parse(http[2]);
		const error = envelope?.type === "error" && envelope.error;
		if (!error || typeof error.message !== "string") return undefined;
		if (error.message.startsWith(lowCredit)) return "lowCredit";
		if (
			(http[1] === "429" && error.type === "rate_limit_error" && error.details?.error_code === monthlyCode) ||
			(http[1] === "400" && error.type === "invalid_request_error" && consoleLimit.test(error.message))
		)
			return "spendLimit";
	} catch {
		// Not a stock HTTP error envelope.
	}
	return undefined;
}
