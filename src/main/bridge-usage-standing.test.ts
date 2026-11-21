import { describe, expect, it } from "vitest";
import { type StandingLimit, usageStanding } from "../../resources/gui-bridge/usage-standing";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

/** Stock's `usageResetAtMs` for these rows: the latest reset ahead among the exhausted ones. */
const resetAtMs = (limits: StandingLimit[], now: number) => {
	const resets = limits
		.filter(limit => limit.status === "exhausted")
		.map(limit => limit.window?.resetsAt ?? 0)
		.filter(at => at > now);
	return resets.length > 0 ? Math.max(...resets) : undefined;
};

const row = (
	id: string,
	usedFraction: number,
	status: string,
	resetsIn: number,
	scope: StandingLimit["scope"] = { shared: true },
): StandingLimit => ({ id, status, scope, amount: { usedFraction }, window: { resetsAt: NOW + resetsIn } });

const standing = (provider: string, limits: StandingLimit[], creditSpend: boolean) =>
	usageStanding({ provider, limits }, { now: NOW, creditSpend, resetAtMs });

describe("usageStanding", () => {
	it("does not limit a Claude account whose only exhausted row is one model's week", () => {
		const limits = [
			row("anthropic:7d", 0.94, "warning", 100 * HOUR),
			// Stock leaves a model's own week unshared (pi-ai usage/claude.ts): it gates only that model.
			row("anthropic:7d:fable", 1, "exhausted", 100 * HOUR, {}),
		];
		expect(standing("anthropic", limits, true)).toEqual({});
	});

	it("does not limit a ChatGPT account on an exhausted Spark meter", () => {
		const spark = row("openai-codex:spark:secondary", 1, "exhausted", 50 * HOUR, { shared: true, modelId: "spark" });
		expect(standing("openai-codex", [row("openai-codex:secondary", 0.4, "ok", 50 * HOUR), spark], true)).toEqual({});
	});

	it("limits the account on an exhausted account-wide window", () => {
		const reset = 80 * HOUR;
		expect(standing("openai-codex", [row("openai-codex:secondary", 1, "exhausted", reset)], true)).toEqual({
			limitedUntil: NOW + reset,
			planSpentUntil: NOW + reset,
		});
	});

	it("says a ChatGPT plan used up but still served is used up, and limits it only where Credit use is off", () => {
		// Stock writes 100 % as `warning` while ChatGPT serves it (credits funding the overage).
		const plan = [row("openai-codex:secondary", 1, "warning", 107 * HOUR)];
		expect(standing("openai-codex", plan, true)).toEqual({ planSpentUntil: NOW + 107 * HOUR });
		expect(standing("openai-codex", plan, false)).toEqual({
			limitedUntil: NOW + 107 * HOUR,
			planSpentUntil: NOW + 107 * HOUR,
		});
	});

	it("keeps every row of a provider that marks none account-wide", () => {
		const limits = [row("other:week", 1, "exhausted", 5 * HOUR, {})];
		expect(standing("other", limits, false)).toEqual({ limitedUntil: NOW + 5 * HOUR });
	});
});
