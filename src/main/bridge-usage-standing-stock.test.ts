/**
 * `accountWideLimits` (resources/gui-bridge/usage-standing.ts) copies the pool stock's `omp usage` judges an account
 * by (pi-coding-agent cli/usage-cli.ts `computePolicyDiagnostics`, not exported). Its exported caller
 * `annotateUsagePolicy` answers here on the installed omp: the exhausted rows stock lists as outside the account-wide
 * state (`scopedExhausted`) are exactly the ones the copy leaves out, and stock calls the account exhausted exactly
 * when a row the copy keeps is.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { accountWideLimits, type StandingLimit } from "../../resources/gui-bridge/usage-standing";
import { runStock as stock, stockSource } from "./test-bridge-probe";

const usageCli = stockSource("pi-coding-agent", path.join("cli", "usage-cli.ts"));

const RESETS = 1_900_000_000_000;

const row = (
	provider: string,
	id: string,
	usedFraction: number,
	status: string,
	scope: Omit<StandingLimit["scope"], "provider"> & { tier?: string } = { shared: true },
) => ({
	id,
	label: id,
	scope: { provider, windowId: "7d", ...scope },
	window: { id: "7d", label: "7 days", resetsAt: RESETS },
	amount: { usedFraction, unit: "percent" },
	status,
});

const REPORTS = [
	// The Mac mini's Claude account of 20 Nov 2026: only its Fable week spent.
	{
		provider: "anthropic",
		fetchedAt: 0,
		metadata: { email: "claude@example.test" },
		limits: [
			row("anthropic", "anthropic:7d", 0.94, "warning"),
			row("anthropic", "anthropic:7d:fable", 1, "exhausted", { tier: "fable" }),
		],
	},
	// A ChatGPT account whose Spark meter is spent while its plan has room.
	{
		provider: "openai-codex",
		fetchedAt: 0,
		metadata: { email: "spark@example.test" },
		limits: [
			row("openai-codex", "openai-codex:secondary", 0.4, "ok"),
			row("openai-codex", "openai-codex:spark:secondary", 1, "exhausted", { shared: true, modelId: "spark" }),
		],
	},
	// A ChatGPT plan used up and not served.
	{
		provider: "openai-codex",
		fetchedAt: 0,
		metadata: { email: "spent@example.test" },
		limits: [row("openai-codex", "openai-codex:secondary", 1, "exhausted")],
	},
];

describe.skipIf(!usageCli)("the account-wide rows usage-standing.ts copies from `omp usage` (installed omp)", () => {
	it("leaves out exactly the exhausted rows stock keeps out of the account-wide state", () => {
		const policies = stock<Array<{ state: string; scopedExhausted?: string[] }>>(
			`const { annotateUsagePolicy } = await import(${JSON.stringify(usageCli)});
				const { reports } = annotateUsagePolicy(${JSON.stringify(REPORTS)}, [], [], {
					globalReservePct: 0,
					getAccountPolicy: () => ({}),
				});
				console.log(JSON.stringify(reports.map(report => report.policy)));`,
		);
		const ours = REPORTS.map(report => {
			const kept = accountWideLimits(report.limits);
			return {
				exhausted: kept.some(limit => limit.status === "exhausted"),
				scopedExhausted: report.limits
					.filter(limit => !kept.includes(limit) && limit.status === "exhausted")
					.map(limit => limit.id),
			};
		});
		expect(ours).toEqual(
			policies.map(policy => ({
				exhausted: policy.state === "exhausted",
				scopedExhausted: policy.scopedExhausted ?? [],
			})),
		);
		expect(ours.map(account => account.exhausted)).toEqual([false, false, true]);
	}, 90_000);
});
