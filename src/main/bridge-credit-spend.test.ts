import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	CREDITS_HELD,
	holdsCredits,
	isCreditProvider,
	NEAR_SPENT_AGE_MS,
	overageCoversAccount,
	overageUntil,
	type PlanLimitLike,
	parseLimited,
	planSpentError,
	planSpentUntil,
	REPORT_LIFE_MS,
	reportTrust,
	setCreditSpend,
	UNREAD_USAGE_ERROR,
	UNTIMED_SPENT_MS,
	withoutCredits,
} from "../../resources/gui-bridge/credit-spend-core";
import { CREDIT_SPEND_OFF_WORDING } from "../shared/credit-spend";
import { isBillingCap, isLimitWording } from "../shared/quota-reset";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const limit = (
	id: string,
	usedFraction: number,
	resetsIn: number,
	extra: Partial<PlanLimitLike> = {},
): PlanLimitLike => ({
	id,
	scope: { shared: true },
	amount: { usedFraction },
	window: { resetsAt: NOW + resetsIn },
	...extra,
});

describe("planSpentUntil", () => {
	it("reads a ChatGPT plan window at 100 % as spent until its reset, and the latest reset when both are spent", () => {
		expect(planSpentUntil("openai-codex", { limits: [limit("openai-codex:primary", 1, 3 * HOUR)] }, NOW)).toBe(
			NOW + 3 * HOUR,
		);
		const both = [limit("openai-codex:primary", 1, 3 * HOUR), limit("openai-codex:secondary", 1, 90 * HOUR)];
		expect(planSpentUntil("openai-codex", { limits: both }, NOW)).toBe(NOW + 90 * HOUR);
	});

	it("leaves a plan with room, a passed reset and Codex's spend cap or extra meters alone", () => {
		const room = [limit("openai-codex:primary", 0.99, 3 * HOUR), limit("openai-codex:secondary", 0.4, 90 * HOUR)];
		expect(planSpentUntil("openai-codex", { limits: room }, NOW)).toBeUndefined();
		expect(planSpentUntil("openai-codex", { limits: [limit("openai-codex:primary", 1, -1)] }, NOW)).toBeUndefined();
		const notPlan = [limit("openai-codex:spend-cap", 1, HOUR), limit("openai-codex:spark:primary", 1, HOUR)];
		expect(planSpentUntil("openai-codex", { limits: notPlan }, NOW)).toBeUndefined();
		expect(planSpentUntil("openai-codex", null, NOW)).toBeUndefined();
	});

	it("takes stock's exhausted status and used/limit counters, not only the fraction", () => {
		const status = limit("openai-codex:primary", 0.97, HOUR, { status: "exhausted" });
		expect(planSpentUntil("openai-codex", { limits: [status] }, NOW)).toBe(NOW + HOUR);
		const counted: PlanLimitLike = {
			id: "anthropic:5h",
			scope: { shared: true },
			amount: { used: 50, limit: 50 },
			window: { resetsAt: NOW + HOUR },
		};
		expect(planSpentUntil("anthropic", { limits: [counted] }, NOW)).toBe(NOW + HOUR);
	});

	it("reads Codex's plan verdict without credits: limit reached under 100 % is spent until the next reset", () => {
		const report = { limits: [limit("openai-codex:primary", 0.98, 2 * HOUR)], metadata: { limitReached: true } };
		expect(planSpentUntil("openai-codex", report, NOW)).toBe(NOW + 2 * HOUR);
		expect(planSpentUntil("openai-codex", { limits: [], metadata: { limitReached: true } }, NOW)).toBe(
			NOW + UNTIMED_SPENT_MS,
		);
	});

	it("reads Claude's shared windows as its plan, never its extra-usage row or a model's own week", () => {
		const fiveHour = limit("anthropic:5h", 1, 2 * HOUR);
		expect(planSpentUntil("anthropic", { limits: [fiveHour, limit("anthropic:7d", 0.4, 80 * HOUR)] }, NOW)).toBe(
			NOW + 2 * HOUR,
		);
		const extra = limit("anthropic:extra", 1, HOUR, { scope: {} });
		const fable = limit("anthropic:7d:fable", 1, HOUR, { scope: {} });
		expect(planSpentUntil("anthropic", { limits: [extra, fable] }, NOW)).toBeUndefined();
		expect(planSpentUntil("anthropic", { limits: [], metadata: { limitReached: true } }, NOW)).toBeUndefined();
	});

	it("stops a Claude model whose own week is spent before its first request, and only when asked for that model", () => {
		const shared = [limit("anthropic:5h", 0.6, 2 * HOUR), limit("anthropic:7d", 0.4, 80 * HOUR)];
		const fable = limit("anthropic:7d:fable", 1, 50 * HOUR, { scope: {} });
		const report = { limits: [...shared, fable] };
		// The rows stock counts for the request's model: the shared windows and that model's own.
		expect(planSpentUntil("anthropic", report, NOW, [...shared, fable])).toBe(NOW + 50 * HOUR);
		// Another model of the account: its rows hold no spent window.
		expect(planSpentUntil("anthropic", report, NOW, shared)).toBeUndefined();
		const opus = limit("anthropic:7d:opus", 0.99, HOUR, { scope: {} });
		expect(planSpentUntil("anthropic", report, NOW, [opus])).toBeUndefined();
		// Without a reset time it stays limited for stock's default block; a reset that passed is not spent.
		const untimed: PlanLimitLike = { id: "anthropic:7d:fable", scope: {}, amount: { usedFraction: 1 } };
		expect(planSpentUntil("anthropic", report, NOW, [untimed])).toBe(NOW + UNTIMED_SPENT_MS);
		const passed = limit("anthropic:7d:fable", 1, -1, { scope: {} });
		expect(planSpentUntil("anthropic", report, NOW, [passed])).toBeUndefined();
		// Codex's other meters (its spend cap, Spark) are never its plan, whatever rows are handed in.
		const codex = { limits: [limit("openai-codex:primary", 0.5, HOUR)] };
		const cap = limit("openai-codex:spend-cap", 1, HOUR, { scope: {} });
		expect(planSpentUntil("openai-codex", codex, NOW, [cap])).toBeUndefined();
	});
});

describe("reportTrust", () => {
	const report = (used: number, age: number, credits = true) => ({
		limits: [limit("openai-codex:primary", used, 3 * HOUR), limit("openai-codex:secondary", 0, 90 * HOUR)],
		metadata: credits ? { [CREDITS_HELD]: true } : {},
		fetchedAt: NOW - age,
	});

	it("lets a report under 90 % be as old as the plan it shows left, and asks for a read past that", () => {
		const cases: Array<[used: number, age: number, trust: string]> = [
			[0, REPORT_LIFE_MS, "current"],
			[0, REPORT_LIFE_MS + 1, "aging"],
			[0.5, REPORT_LIFE_MS / 2, "current"],
			[0.5, REPORT_LIFE_MS / 2 + 1_000, "aging"],
			[0.89, 32_000, "current"],
			[0.89, 34_000, "aging"],
		];
		for (const [used, age, trust] of cases) expect(reportTrust(report(used, age), NOW), `${used} ${age}`).toBe(trust);
		// A request of this omp since the read changes nothing while the plan has room.
		expect(reportTrust(report(0.5, 1_000), NOW, NOW)).toBe("current");
	});

	it("from 90 % on lets nothing out once this omp sent a request since the read, or 15 s passed", () => {
		const fresh = report(0.9, 1_000);
		expect(reportTrust(fresh, NOW)).toBe("current");
		// Sent before the read: the read already counts it.
		expect(reportTrust(fresh, NOW, fresh.fetchedAt - 1)).toBe("current");
		expect(reportTrust(fresh, NOW, fresh.fetchedAt)).toBe("unconfirmed");
		expect(reportTrust(fresh, NOW, NOW)).toBe("unconfirmed");
		expect(reportTrust(report(0.97, NEAR_SPENT_AGE_MS), NOW)).toBe("current");
		expect(reportTrust(report(0.97, NEAR_SPENT_AGE_MS + 1), NOW)).toBe("unconfirmed");
	});

	it("reads the fuller of the two plan windows, and never Codex's other meters", () => {
		const weekly = {
			limits: [limit("openai-codex:primary", 0.1, HOUR), limit("openai-codex:secondary", 0.9, 90 * HOUR)],
			metadata: { [CREDITS_HELD]: true },
			fetchedAt: NOW - 31_000,
		};
		expect(reportTrust(weekly, NOW)).toBe("unconfirmed");
		const spark = { ...weekly, limits: [limit("openai-codex:spark:primary", 0.99, HOUR)] };
		expect(reportTrust(spark, NOW)).toBe("current");
	});

	it("leaves an account without credits, and a report that names no read time, to stock", () => {
		expect(reportTrust(report(0.99, REPORT_LIFE_MS, false), NOW, NOW)).toBe("current");
		expect(reportTrust({ limits: [], metadata: { [CREDITS_HELD]: true } }, NOW)).toBe("current");
		expect(reportTrust(null, NOW)).toBe("current");
	});
});

describe("holdsCredits", () => {
	it("is true for a balance or unlimited credits, false for anything else", () => {
		expect(holdsCredits({ credits: { has_credits: true, unlimited: false, balance: "500" } })).toBe(true);
		expect(holdsCredits({ credits: { has_credits: false, unlimited: true } })).toBe(true);
		for (const none of [{ credits: { has_credits: false } }, { credits: null }, { rate_limit: {} }, null, "text"]) {
			expect(holdsCredits(none)).toBe(false);
		}
	});
});

describe("parseLimited", () => {
	it("keeps the entries still ahead and reads anything malformed as empty", () => {
		const text = JSON.stringify({
			"anthropic\u00007": NOW + HOUR,
			"anthropic\u00008": NOW - 1,
			"openai-codex\u00002": "soon",
		});
		expect(parseLimited(text, NOW)).toEqual({ "anthropic\u00007": NOW + HOUR });
		for (const bad of ["", "not json", "[1]", "null", '"text"']) expect(parseLimited(bad, NOW)).toEqual({});
	});
});

describe("overageUntil", () => {
	const seconds = (ms: number) => String((NOW + ms) / 1000);

	it("is the claimed window's reset while Claude serves on extra usage", () => {
		const headers = {
			"anthropic-ratelimit-unified-overage-in-use": "true",
			"anthropic-ratelimit-unified-representative-claim": "seven_day",
			"anthropic-ratelimit-unified-5h-reset": seconds(HOUR),
			"anthropic-ratelimit-unified-7d-reset": seconds(50 * HOUR),
		};
		expect(overageUntil(headers, NOW)).toBe(NOW + 50 * HOUR);
		expect(overageUntil({ ...headers, "anthropic-ratelimit-unified-representative-claim": "five_hour" }, NOW)).toBe(
			NOW + HOUR,
		);
	});

	it("falls back to the unified reset, then stock's default block, and is nothing on the plan", () => {
		const inUse = { "anthropic-ratelimit-unified-overage-in-use": "true" };
		expect(overageUntil({ ...inUse, "anthropic-ratelimit-unified-reset": seconds(2 * HOUR) }, NOW)).toBe(
			NOW + 2 * HOUR,
		);
		expect(overageUntil(inUse, NOW)).toBe(NOW + UNTIMED_SPENT_MS);
		expect(overageUntil({ "anthropic-ratelimit-unified-overage-in-use": "false" }, NOW)).toBeUndefined();
		expect(overageUntil({}, NOW)).toBeUndefined();
	});

	it("covers the whole account only for a window all its models share", () => {
		const claim = (name: string) => ({ "anthropic-ratelimit-unified-representative-claim": name });
		expect(overageCoversAccount(claim("five_hour"))).toBe(true);
		expect(overageCoversAccount(claim("seven_day"))).toBe(true);
		// A model's own weekly window, or a claim this build has not heard of, leaves the account's other models alone.
		expect(overageCoversAccount(claim("seven_day_opus"))).toBe(false);
		expect(overageCoversAccount(claim("seven_day_sonnet"))).toBe(false);
		expect(overageCoversAccount(claim("something_new"))).toBe(false);
		expect(overageCoversAccount({})).toBe(false);
		// Its reset is still the weekly one.
		expect(
			overageUntil(
				{
					"anthropic-ratelimit-unified-overage-in-use": "true",
					...claim("seven_day_opus"),
					"anthropic-ratelimit-unified-7d-reset": seconds(50 * HOUR),
				},
				NOW,
			),
		).toBe(NOW + 50 * HOUR);
	});
});

describe("withoutCredits", () => {
	it("drops only the credits block of a Codex usage answer", () => {
		const answer = {
			rate_limit: { limit_reached: true },
			credits: { has_credits: true, balance: "500" },
			plan_type: "plus",
		};
		expect(withoutCredits(answer)).toEqual({ rate_limit: { limit_reached: true }, plan_type: "plus" });
		expect(answer.credits).toEqual({ has_credits: true, balance: "500" });
		for (const other of [null, "text", [1], { rate_limit: {} }]) expect(withoutCredits(other)).toEqual(other);
	});
});

describe("the switch and the refusal", () => {
	it("accepts exactly {enabled: boolean}", () => {
		for (const bad of [null, {}, { enabled: "true" }, { enabled: 1 }]) {
			expect(() => setCreditSpend(bad)).toThrow(/credit_spend_set/);
		}
		expect(setCreditSpend({ enabled: true })).toEqual({ enabled: true });
		expect(setCreditSpend({ enabled: false })).toEqual({ enabled: false });
	});

	it("covers ChatGPT and Claude only", () => {
		expect(["openai-codex", "anthropic", "openai", "google-gemini-cli"].map(isCreditProvider)).toEqual([
			true,
			true,
			false,
			false,
		]);
	});

	it("words the refusal as a usage limit, with the provider and the wait", () => {
		const message = planSpentError("openai-codex", NOW + 3 * HOUR, NOW);
		expect(message).toMatch(/^usage_limit_reached: /);
		expect(message).toContain("ChatGPT");
		expect(message).toContain("about 3 hours");
		expect(planSpentError("anthropic", NOW + 20 * 60_000, NOW)).toContain("about 20 minutes");
	});

	it("words it so the turn it ends waits for the limit and the card says credit use is off", () => {
		// The rows the core's copy of the limit rules is held to (its test and src/shared/quota-reset.test.ts read them).
		const captured = JSON.parse(
			readFileSync(
				new URL("../../native/ompdesk/crates/core/src/resume/classifiers-captured.json", import.meta.url),
				"utf8",
			),
		) as Array<{ message?: string; limit: boolean }>;
		for (const provider of ["openai-codex", "anthropic"] as const) {
			const message = planSpentError(provider, NOW + 3 * HOUR, NOW);
			expect(isLimitWording(message)).toBe(true);
			expect(isBillingCap(message)).toBe(false);
			expect(message).toMatch(CREDIT_SPEND_OFF_WORDING);
			// Stock's hint as credit-spend.ts appends it (pi-ai utils/retry-after.ts).
			const row = captured.find(entry => entry.message === `${message} retry-after-ms=${3 * HOUR}`);
			expect(row, provider).toMatchObject({ limit: true });
		}
		// The wait while a nearly spent ChatGPT account's usage cannot be read reads the same way.
		expect(isBillingCap(UNREAD_USAGE_ERROR)).toBe(false);
		expect(UNREAD_USAGE_ERROR).toMatch(CREDIT_SPEND_OFF_WORDING);
		expect(captured.find(entry => entry.message === `${UNREAD_USAGE_ERROR} retry-after-ms=60000`)).toMatchObject({
			limit: true,
		});
	});
});
