/**
 * What one account's usage report means for this omp's requests, for the agent's `usage.read`: whether the account
 * is limited and until when, and whether its plan is used up.
 * Pure: no omp imports, so the GUI's vitest runs it (src/main/bridge-usage-standing.test.ts).
 *
 * Two readings this answers that stock's `usageResetAtMs` over every row of a report does not:
 * - A model's own meter (a Claude Fable week, Codex Spark) gates only that model's requests, so an exhausted one does
 *   not limit the account. Stock's `omp usage` keeps such rows out of the account-wide state the same way.
 * - Whether a plan used up still gets requests depends on this omp's Credit use (credit-spend.ts): off, its checks
 *   refuse the account until the plan resets, so it is limited until then whatever stock's report says; on, requests
 *   go out while the provider allows them. What pays for them is not in the report, so nothing here claims it.
 */
import { isCreditProvider, planSpentUntil } from "./credit-spend-core";

/** The slice of stock's `UsageLimit` read here. */
export interface StandingLimit {
	id: string;
	status?: string;
	scope: { shared?: boolean; sharedGroup?: string; modelId?: string };
	amount: { usedFraction?: number; used?: number; limit?: number };
	window?: { resetsAt?: number };
}

/**
 * The rows that hold for every request of the account. A copy of the pool in stock's `omp usage`
 * (pi-coding-agent cli/usage-cli.ts `computePolicyDiagnostics`, not exported): shared rows that name neither a
 * subpool (`sharedGroup`) nor one model (`modelId`); a provider that marks none keeps every row.
 */
export function accountWideLimits<T extends StandingLimit>(limits: readonly T[]): T[] {
	const accountWide = limits.filter(
		limit =>
			limit.scope.shared === true && limit.scope.sharedGroup === undefined && limit.scope.modelId === undefined,
	);
	return accountWide.length > 0 ? accountWide : [...limits];
}

export interface Standing {
	/** Until when this omp sends the account no request, epoch ms; absent while it does. */
	limitedUntil?: number;
	/** Until when the account's plan is used up (credit providers only); absent while it has plan left. */
	planSpentUntil?: number;
}

/**
 * `resetAtMs` is stock's `usageResetAtMs` (when every exhausted row of those given has reset), passed in so this file
 * stays free of omp imports.
 */
export function usageStanding<T extends StandingLimit>(
	report: { provider: string; limits: readonly T[]; metadata?: Record<string, unknown> },
	options: { now: number; creditSpend: boolean; resetAtMs: (limits: T[], now: number) => number | undefined },
): Standing {
	const { now } = options;
	const { provider } = report;
	const exhausted = options.resetAtMs(accountWideLimits(report.limits), now);
	const planSpent = isCreditProvider(provider) ? planSpentUntil(provider, report, now) : undefined;
	const refused = options.creditSpend ? undefined : planSpent;
	const limitedUntil =
		exhausted === undefined ? refused : refused === undefined ? exhausted : Math.max(exhausted, refused);
	return {
		...(limitedUntil !== undefined ? { limitedUntil } : {}),
		...(planSpent !== undefined ? { planSpentUntil: planSpent } : {}),
	};
}
