import { type ReactNode, useMemo } from "react";
import type { SessionStats } from "../../../shared/rpc-types";
import { formatCost, formatDuration, formatPercent, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { useMessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";
import { useToolsStore } from "../../stores/tools";
import { sessionCacheHitPercent, sessionExecutionDurationMs } from "./session-metrics";

function StatRow({ label, hint, value }: { label: string; hint?: string; value: ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-6 py-1.5">
			<dt className="min-w-0">
				<span className="block text-sc-sm text-(--sc-text-secondary)">{label}</span>
				{hint && <span className="block text-sc-xs text-(--sc-text-muted)">{hint}</span>}
			</dt>
			<dd className="shrink-0 text-sc-sm font-medium tabular-nums text-(--sc-text)">{value}</dd>
		</div>
	);
}

/**
 * Execution time of the session. Mounted only while the status popover is
 * open (Popover unmounts closed content), so the bar itself never subscribes
 * to the tools store or re-runs the range merge on every tool event.
 */
function ExecutionDurationRow() {
	const t = useT();
	const isStreaming = useSessionStore(s => s.isStreaming);
	const awaitingModelSince = useSessionStore(s => s.awaitingModelSince);
	const messages = useMessagesStore(s => s.messages);
	const streamingMessage = useMessagesStore(s => s.streamingMessage);
	const liveTools = useToolsStore(s => s.liveTools);
	const finishedTools = useToolsStore(s => s.finishedTools);
	const finishedVersion = useToolsStore(s => s.finishedVersion);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the finished map changes in place; its version marks each change.
	const tools = useMemo(
		() => [...liveTools.values(), ...finishedTools.values()],
		[liveTools, finishedTools, finishedVersion],
	);
	// Only live (pending/running) calls keep the clock alive; history-aborted
	// calls never end and are finished entries.
	const now = useNowTick(isStreaming || liveTools.size > 0);
	const executionDuration = sessionExecutionDurationMs({
		messages,
		streamingMessage,
		tools,
		awaitingModelSince,
		isStreaming,
		now,
	});
	return (
		<StatRow
			label={t("sessionStatus.duration")}
			value={executionDuration > 0 ? formatDuration(executionDuration) : t("time.secondsShort", { count: 0 })}
		/>
	);
}

export default function SessionUsageFigures({ stats }: { stats: SessionStats }) {
	const t = useT();
	return (
		<dl className="border-y border-(--sc-divider) py-1">
			<StatRow
				hint={stats.history ? t("sessionStatus.historyHint") : undefined}
				label={t("sessionStatus.tokens")}
				value={formatTokens(stats.history?.totalTokens ?? stats.tokens.total)}
			/>
			<StatRow label={t("sessionStatus.cost")} value={formatCost(stats.history?.cost ?? stats.cost, 4)} />
			<StatRow label={t("sessionStatus.cache")} value={formatPercent(sessionCacheHitPercent(stats), 0)} />
			<ExecutionDurationRow />
		</dl>
	);
}
