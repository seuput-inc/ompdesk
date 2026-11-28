import { expect, it } from "vitest";
import {
	claudeDispatch,
	claudeReplayBlocked,
	claudeRouteRefusal,
	DISPATCH_ENTRY,
	journalPin,
	ROUTE_ENTRY,
	readClaudeApiRoute,
} from "../../resources/gui-bridge/claude-api-route-core";

const pin = {
	modelId: "fixture",
	provider: "anthropic-api-key-2",
	skipped: [{ provider: "anthropic-api-key", reason: "disabled" as const }],
};
const entry = { type: "custom", customType: ROUTE_ENTRY, data: pin };

it("restores only the active branch's automatic choice and not a later explicit choice of the identical model", () => {
	expect(journalPin([entry, { type: "message" }])).toEqual(pin);
	expect(journalPin([entry, { type: "model_change", role: "fallback" }])).toEqual(pin);
	expect(journalPin([entry, { type: "model_change", role: "default" }])).toBeUndefined();
	expect(journalPin([{ type: "model_change", role: "default" }])).toBeUndefined();
});

it("restores an unsent prompt but never automatically replays a journaled dispatch", () => {
	const user = { type: "message", message: { role: "user" } };
	const sent = { type: "custom", customType: DISPATCH_ENTRY };
	expect(claudeReplayBlocked([entry, user])).toBe(false);
	expect(claudeReplayBlocked([entry, user, sent])).toBe(true);
	expect(claudeReplayBlocked([entry, user, sent, user])).toBe(false);
	expect(claudeReplayBlocked([entry, user, sent, { type: "model_change" }])).toBe(false);
});

it("drops malformed receipt fields without exposing other values from a saved transcript", () => {
	expect(readClaudeApiRoute({ ...pin, skipped: [null] })).toBeUndefined();
	expect(readClaudeApiRoute({ ...pin, skipped: [{ provider: "anthropic", reason: "disabled" }] })).toBeUndefined();
	expect(readClaudeApiRoute({ ...pin, skipped: [{ provider: pin.provider, reason: "constructor" }] })).toBeUndefined();
	expect(readClaudeApiRoute({ ...pin, extra: "dummy", skipped: [{ ...pin.skipped[0], extra: "dummy" }] })).toEqual({
		provider: pin.provider,
		skipped: pin.skipped,
	});
	expect(readClaudeApiRoute({ ...pin, refusal: "billing" })?.refusal).toBe("billing");
	expect(readClaudeApiRoute({ ...pin, refusal: "dummy raw body" })).toEqual({
		provider: pin.provider,
		skipped: pin.skipped,
	});
	expect(journalPin([{ ...entry, data: { ...pin, refusal: "lowCredit" } }])).toEqual(pin);
});

it("stores only documented Messages API refusal fields and reads the same safe receipt after restart", () => {
	const resume = "You will regain access on 2026-09-01 at 00:00 UTC.";
	const rate = (code?: string, message = "fixture") => ({
		type: "error",
		error: { type: "rate_limit_error", message, details: code ? { error_code: code } : undefined },
	});
	const invalid = (message: string) => ({ type: "error", error: { type: "invalid_request_error", message } });
	const monthly = (message: string) => rate("enforced_spend_limit_reached", message);
	const cases = [
		[429, "12", rate(), { kind: "transient", retryAfterSeconds: 12 }],
		[429, "0", rate("ramp_limit_exceeded"), { kind: "transient", retryAfterSeconds: 0 }],
		[429, null, monthly(resume), { kind: "monthly", resumesAt: Date.UTC(2026, 8, 1) }],
		[429, null, monthly("no date"), { kind: "monthly" }],
		[429, null, monthly(resume.replace("09-01", "13-01")), { kind: "monthly" }],
		[429, null, monthly(resume.replace("09-01", "09-02")), { kind: "monthly" }],
		[429, null, monthly(resume.replace(" UTC", " PST")), { kind: "monthly" }],
		[429, null, monthly("some other date: 2026-09-01 at 00:00 UTC."), { kind: "monthly" }],
		[400, null, invalid("You have reached your specified API usage limits."), { kind: "console" }],
		[400, null, invalid("You have reached your specified workspace API usage limits."), { kind: "console" }],
		[429, "2", monthly(resume), "rateLimit"],
		[429, "2", rate("unknown"), "rateLimit"],
		[429, null, rate("ramp_limit_exceeded"), "rateLimit"],
		[429, "1", invalid("You have reached your specified API usage limits"), "rateLimit"],
		[429, "2", "not JSON", "rateLimit"],
		[400, "1", rate("ramp_limit_exceeded"), undefined],
		[400, null, invalid("Earlier: You have reached your specified API usage limits"), undefined],
		[500, "2", rate("ramp_limit_exceeded"), undefined],
	] as const;
	for (const [status, after, body, expected] of cases) {
		const refusal = claudeRouteRefusal(status, after, body);
		expect(refusal).toEqual(expected);
		expect(readClaudeApiRoute({ ...pin, refusal })?.refusal).toEqual(expected);
	}
	for (const header of ["", "-1", "1 second", "1.5", "1e2", "Thu, 01 Oct 2026 00:00:00 GMT", "9007199254740992"])
		expect(claudeRouteRefusal(429, header, rate())).toBe("rateLimit");
	for (const legacy of ["spendLimit", "rateLimit", "lowCredit", "billing"])
		expect(readClaudeApiRoute({ ...pin, refusal: legacy })?.refusal).toBe(legacy);
	for (const refusal of [
		{ kind: "monthly", resumesAt: "2026-09-01" },
		{ kind: "monthly", resumesAt: Date.UTC(2026, 8, 2) },
		{ kind: "transient", retryAfterSeconds: -1 },
		{ kind: "transient", retryAfterSeconds: Infinity },
		{ kind: "transient", retryAfterSeconds: "12" },
		{ kind: "unknown" },
	])
		expect(readClaudeApiRoute({ ...pin, refusal })?.refusal).toBeUndefined();
	const saved = { ...pin, refusal: { kind: "transient", retryAfterSeconds: 2, body: "private", key: "dummy" } };
	expect(readClaudeApiRoute(saved)?.refusal).toEqual({ kind: "transient", retryAfterSeconds: 2 });
	expect(journalPin([{ ...entry, data: saved }])).toEqual(pin);
});

it("permits stock's bounded probe ladder before the answer and consumes the answer before its outcome", () => {
	const turn = claudeDispatch(13);
	for (let i = 0; i < 13; i++) expect(turn.attempt()).toBe("probe");
	turn.answer();
	expect(turn.attempt()).toBe("answer");
	expect(() => turn.attempt()).toThrow("already sent");
	expect(() => turn.answer()).toThrow("already sent");
});

it("each refused main request authorizes only one transport retry, never a fresh onPayload or later replay", () => {
	const turn = claudeDispatch(0);
	turn.answer();
	expect(turn.attempt("body")).toBe("answer");
	turn.retryAnswer("body");
	expect(turn.attempt("body")).toBe("answer");
	expect(() => turn.attempt()).toThrow("already sent");
	const restarted = claudeDispatch(0);
	restarted.answer();
	restarted.attempt("body");
	restarted.retryAnswer("body");
	expect(() => restarted.answer()).toThrow("already sent");
	expect(() => restarted.attempt()).toThrow("already sent");
	const changed = claudeDispatch(0);
	changed.answer();
	changed.attempt("body");
	changed.retryAnswer("body");
	expect(() => changed.attempt("different")).toThrow("request changed");
});

it("a probe refusal blocks both late probes and the answer", () => {
	const turn = claudeDispatch(13);
	expect(turn.attempt()).toBe("probe");
	expect(() => turn.stop("HTTP 429")).toThrow("429");
	expect(() => turn.answer()).toThrow("429");
	expect(() => turn.attempt()).toThrow("429");
});
