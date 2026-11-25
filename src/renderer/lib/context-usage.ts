import type { ContextUsage, RpcContextUsageBreakdown, RpcPromptCacheStatus } from "../../shared/rpc-types";
import { formatClock, formatSpan, formatTokens } from "./format";

/**
 * Context numbers as a display surface should read them.
 *
 * Core reports `contextWindow: 0` for a model whose capacity the host does not
 * publish, while the token reading itself is measured locally and stays valid.
 * Percentages and remainders only mean anything when `capacityKnown` is true.
 */
export interface ContextUsageView {
	capacityKnown: boolean;
	contextWindow: number;
	percent: number;
	remainingTokens: number;
	usedTokens: number;
}

export function contextUsageView(
	usage?: Partial<ContextUsage> | null,
	breakdown?: Pick<RpcContextUsageBreakdown, "contextWindow" | "usedTokens">,
): ContextUsageView {
	const contextWindow = breakdown?.contextWindow || usage?.contextWindow || 0;
	const usedTokens = breakdown?.usedTokens ?? usage?.tokens ?? 0;
	const capacityKnown = contextWindow > 0;
	return {
		capacityKnown,
		contextWindow,
		percent: capacityKnown ? Math.min(100, (usedTokens / contextWindow) * 100) : 0,
		remainingTokens: capacityKnown ? Math.max(0, contextWindow - usedTokens) : 0,
		usedTokens,
	};
}

/** `161.9k/1.0M`, or the bare reading when there is no capacity to compare against. */
export function formatContextUsage(view: ContextUsageView): string {
	return view.capacityKnown
		? `${formatTokens(view.usedTokens)}/${formatTokens(view.contextWindow)}`
		: formatTokens(view.usedTokens);
}

/** The ring turns warning from this share of the compaction point on: one more long turn may compact. */
export const NEAR_COMPACTION = 0.85;

export type ContextTone = "unknown" | "ok" | "warning" | "danger";

/**
 * The composer ring's tone. With an auto-compaction point (`compactAt`, stock's resolved trigger in tokens) it is
 * danger at that point and warning near it; with auto-compaction off the window's own limit is the only edge left,
 * so warning from 80 % of it and danger from 95 %. No known window: nothing to compare against.
 */
export function contextTone(view: ContextUsageView, compactAt?: number): ContextTone {
	if (!view.capacityKnown) return "unknown";
	if (compactAt !== undefined && compactAt > 0) {
		if (view.usedTokens >= compactAt) return "danger";
		return view.usedTokens >= compactAt * NEAR_COMPACTION ? "warning" : "ok";
	}
	return view.percent >= 95 ? "danger" : view.percent >= 80 ? "warning" : "ok";
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * One line on the prompt cache, apart from any usage limit's reset (Orca's cache-expiry row, 25 Nov 2026): stock
 * judges warm or cold and why (`getPromptCacheStatus`); this only words it. A warm entry past its lifetime is one
 * whose refresh is in flight (stock holds expiry off for it), so it reads "refreshing", never "expired" early; an entry
 * with no lifetime names no time.
 */
export function promptCacheText(status: RpcPromptCacheStatus, now: number, t: Translate): string {
	if (status.state === "cold") {
		return status.reason?.kind === "expired" && status.reason.at !== undefined
			? t("contextUsage.cache.expired", { time: formatClock(status.reason.at) })
			: t("contextUsage.cache.changed");
	}
	if (status.ttlMs === undefined) return t("contextUsage.cache.noExpiry");
	const expiresAt = status.touchedAt + status.ttlMs;
	if (expiresAt <= now) return t("contextUsage.cache.refreshing");
	return t(status.inferred ? "contextUsage.cache.likelyKept" : "contextUsage.cache.kept", {
		time: formatClock(expiresAt),
		left: formatSpan(expiresAt - now),
	});
}
