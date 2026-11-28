import { Bot, Check, Eye, Wrench, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import { useFrameSelector } from "../../../hooks/use-frame-selector";
import { basename, cx, formatDuration, formatElapsed, formatTokens, headLines, resultText } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useNowTick } from "../../../lib/now-tick";
import { asArray, asNumber, asRecord, asString } from "../../../lib/wire-value";
import { useSessionRuntime } from "../../../stores/session-runtime-context";
import { type SubagentsStore, useSubagentsStore } from "../../../stores/subagents";
import { SubagentRunCard, type SubagentRunState } from "../../chat/work/SubagentRunCard";
import { SubagentSurface } from "../../chat/work/WorkMap";
import { Badge, ErrorDetail, IconButton, LinkButton } from "../../common";
import type { ToolRendererProps } from "../ToolCard";
import { resultDetails } from "./result";
import { ToolTextPreview } from "./ToolTextPreview";
import {
	extractMissingYieldWarning,
	extractReviewResult,
	FINDING_CAP,
	formatTaskId,
	MAX_NESTED_DEPTH,
	normalizeYieldData,
	OUTPUT_PREVIEW_LINES,
	orderProgressForDisplay,
	orderResultsForDisplay,
	PRIORITY_COLOR,
	PRIORITY_ORD,
	type RenderYieldItem,
	type ReviewResult,
	YIELD_CAP,
	yieldLabels,
} from "./task-render-utils";

/**
 * Task (subagent spawn): live & settled Orca-grade subagent run cards. Mirrors the TUI task
 * renderer (packages/coding-agent/src/task/render.ts) with framed `SubagentRunCard` rows:
 * status dot, role badge, per-agent stats (tools/requests/context%/$cost/model), current tool +
 * elapsed, retry badge/countdown, nested task trees, yields/review findings, collapsible output
 * peek, inline transcript inspection, and a hairline-framed run-summary footer.
 *
 * Wire shape: `{ content, details }` where details is `TaskToolDetails`:
 *   { results: SingleResult[], progress?: AgentProgress[], totalDurationMs }
 * Live updates arrive in `partialResult` while the call runs.
 */

interface StatOpts {
	toolCount?: number;
	requests?: number;
	contextTokens?: number;
	contextWindow?: number;
	cost?: number;
	resolvedModel?: string;
}

/** Per-agent stats: compact `8 🔧 · 3 req · 7.1% · $0.14` (full window & model in hover title). */
function AgentStats({ stats }: { stats: StatOpts }) {
	const t = useT();
	const contextShort =
		stats.contextTokens != null && stats.contextTokens > 0
			? stats.contextWindow != null && stats.contextWindow > 0
				? `${((stats.contextTokens / stats.contextWindow) * 100).toFixed(1)}%`
				: formatTokens(stats.contextTokens)
			: null;
	const contextFull =
		stats.contextTokens != null && stats.contextTokens > 0 && stats.contextWindow != null && stats.contextWindow > 0
			? `${formatTokens(stats.contextTokens)} / ${formatTokens(stats.contextWindow)}`
			: undefined;
	const hasAny =
		(stats.toolCount != null && stats.toolCount > 0) ||
		(stats.requests != null && stats.requests > 0) ||
		Boolean(contextShort) ||
		(stats.cost != null && stats.cost > 0);
	if (!hasAny) return null;
	const tooltipParts = [contextFull, stats.resolvedModel].filter(Boolean).join(" · ");
	return (
		<span
			className="flex shrink-0 items-center gap-1.5 font-mono text-sc-xs text-(--sc-text-muted) tabular-nums"
			title={tooltipParts || undefined}
		>
			{stats.toolCount != null && stats.toolCount > 0 && (
				<span className="inline-flex shrink-0 items-center gap-0.5">
					{stats.toolCount}
					<Wrench aria-hidden className="size-3" />
				</span>
			)}
			{stats.requests != null && stats.requests > 0 && (
				<span className="shrink-0">{t("tools.task.requests", { count: stats.requests })}</span>
			)}
			{contextShort && <span className="shrink-0">{contextShort}</span>}
			{stats.cost != null && stats.cost > 0 && (
				<span className="shrink-0 text-(--sc-warning)">${stats.cost.toFixed(2)}</span>
			)}
		</span>
	);
}

/** Usage cost from a SingleResult's aggregated `usage` envelope. */
function resultCost(row: Record<string, unknown>): number {
	return asNumber(asRecord(asRecord(row.usage)?.cost)?.total) ?? 0;
}

// ---------------------------------------------------------------------------
// Yields + review rendering
// ---------------------------------------------------------------------------

// Stock pi-coding-agent ui/tools/task/rows.ts `typedYieldRows`: since omp 18.22.1 a data-less yield finalizes the
// sections.
function yieldPreview(item: RenderYieldItem, finalizeLabel: string): string {
	if (item.data === undefined) return finalizeLabel;
	if (typeof item.data === "string") return item.data.replace(/\s+/g, " ").trim();
	try {
		return JSON.stringify(item.data) ?? "null";
	} catch {
		return String(item.data);
	}
}

/** `yield[label]: preview` lines for typed yield sections (last N). */
function YieldLines({ value }: { value: unknown }) {
	const t = useT();
	const typed: Array<{ item: RenderYieldItem; labels: string[] }> = [];
	for (const item of normalizeYieldData(value)) {
		const labels = yieldLabels(item.type);
		if (labels.length > 0) typed.push({ item, labels });
	}
	if (typed.length === 0) return null;
	const visible = typed.slice(-YIELD_CAP);
	return (
		<div className="flex flex-col gap-0.5">
			{visible.map(({ item, labels }, i) => (
				<div key={i} className="flex gap-1.5 font-mono text-sc-xs leading-relaxed">
					<span aria-hidden className="shrink-0 text-(--sc-text-subtle)">
						└
					</span>
					<span className="min-w-0 truncate" title={yieldPreview(item, t("tools.task.yieldFinalize"))}>
						<span className="text-(--sc-text-muted)">
							{t("tools.task.yieldLabel", { suffix: Array.isArray(item.type) ? "+" : "" })}[{labels.join(", ")}]:
						</span>{" "}
						<span className="text-(--sc-text-secondary)">
							{yieldPreview(item, t("tools.task.yieldFinalize"))}
						</span>
					</span>
				</div>
			))}
			{typed.length > visible.length && (
				<div className="pl-3.5 font-mono text-sc-xs text-(--sc-text-muted)">
					{t("tools.task.moreYields", {
						count: typed.length - visible.length,
						plural: typed.length - visible.length === 1 ? "" : "s",
					})}
				</div>
			)}
		</div>
	);
}

/** Review verdict + findings list (submit_review data carried by yields). */
function ReviewBlock({ review }: { review: ReviewResult }) {
	const t = useT();
	const correct = review.correctness === "correct";
	const sorted = [...review.findings].sort(
		(a, b) => (PRIORITY_ORD[a.priority] ?? 3) - (PRIORITY_ORD[b.priority] ?? 3),
	);
	const visible = sorted.slice(0, FINDING_CAP);
	const counts: Record<string, number> = {};
	for (const finding of review.findings) {
		counts[finding.priority] = (counts[finding.priority] ?? 0) + 1;
	}
	const flat = review.explanation.replace(/\s+/g, " ").trim();
	const preview = flat.split(/[.!?]/)[0]?.trim();
	return (
		<div className="flex flex-col gap-1.5 rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-1) px-2.5 py-2">
			<div className="flex flex-wrap items-center gap-1.5 text-sc-sm">
				{correct ? (
					<Check aria-hidden className="size-3.5 shrink-0 text-(--sc-success)" />
				) : (
					<X aria-hidden className="size-3.5 shrink-0 text-(--sc-danger)" />
				)}
				<span className={cx("font-medium", correct ? "text-(--sc-success)" : "text-(--sc-danger)")}>
					{t("tools.task.patchVerdict", {
						verdict: t(correct ? "tools.task.verdict.correct" : "tools.task.verdict.incorrect"),
					})}
				</span>
				<span className="font-mono text-sc-xs text-(--sc-text-muted) tabular-nums">
					({t("tools.task.confidence", { pct: (review.confidence * 100).toFixed(0) })})
				</span>
				<span className="ml-auto flex items-center gap-1.5 font-mono text-sc-xs tabular-nums">
					<span className="text-(--sc-text-muted)">
						{review.findings.length === 0 ? t("tools.task.findingsNone") : t("tools.task.findings")}
					</span>
					{review.findings.length > 0 &&
						["P0", "P1", "P2", "P3"].map(label => (
							<span key={label} style={{ color: PRIORITY_COLOR[label] }}>
								{label}:{counts[label] ?? 0}
							</span>
						))}
				</span>
			</div>
			{preview && (
				<div className="truncate text-sc-xs text-(--sc-text-secondary)" title={flat}>
					{preview}.
				</div>
			)}
			{visible.length > 0 && (
				<div className="flex flex-col gap-1 border-t border-(--sc-divider) pt-1.5">
					{visible.map((finding, i) => (
						<div key={i} className="flex min-w-0 items-center gap-1.5 text-sc-xs leading-relaxed">
							<span
								className="shrink-0 rounded-(--sc-radius-xs) bg-(--sc-surface-2) px-1 font-mono font-semibold"
								style={{ color: PRIORITY_COLOR[finding.priority] }}
							>
								{finding.priority}
							</span>
							<span className="min-w-0 flex-1 truncate text-(--sc-text)" title={finding.title}>
								{finding.title}
							</span>
							<span className="shrink-0 font-mono text-sc-xs text-(--sc-text-muted)">
								{basename(finding.filePath)}:{finding.lineStart}
							</span>
						</div>
					))}
					{sorted.length > visible.length && (
						<div className="font-mono text-sc-xs text-(--sc-text-muted)">
							{t("tools.task.moreFindings", {
								count: sorted.length - visible.length,
								plural: sorted.length - visible.length === 1 ? "" : "s",
							})}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Nested task trees
// ---------------------------------------------------------------------------

interface TreeCtx {
	seen: Set<object>;
	now: number;
	store: StoreApi<SubagentsStore>;
}

/** A TaskToolDetails-shaped record carries a results and/or progress array. */
function asTaskDetails(value: unknown): Record<string, unknown> | undefined {
	const r = asRecord(value);
	if (!r) return undefined;
	if (!Array.isArray(r.results) && !Array.isArray(r.progress)) return undefined;
	return r;
}

/** Interleaved completed/in-flight nested subagent snapshots, indented one level. */
function NestedTaskTree({ list, depth, ctx }: { list: Record<string, unknown>[]; depth: number; ctx: TreeCtx }) {
	const t = useT();
	return (
		<div className="ml-1.5 flex flex-col gap-1.5 border-l border-(--sc-divider) pl-2.5">
			{list.map((details, i) => {
				if (ctx.seen.has(details)) {
					return (
						<div key={i} className="font-mono text-sc-xs text-(--sc-text-muted)">
							{t("tools.task.cycle")}
						</div>
					);
				}
				if (depth >= MAX_NESTED_DEPTH) {
					return (
						<div key={i} className="font-mono text-sc-xs text-(--sc-text-muted)">
							{t("tools.task.depthLimit")}
						</div>
					);
				}
				ctx.seen.add(details);
				try {
					const results = asArray(details.results)
						.map(asRecord)
						.filter((r): r is Record<string, unknown> => r != null);
					const progress = asArray(details.progress)
						.map(asRecord)
						.filter((r): r is Record<string, unknown> => r != null);
					if (results.length > 0) {
						return (
							<div key={i} className="flex flex-col gap-1.5">
								{orderResultsForDisplay(results).map((row, j) => (
									<ResultAgentRow
										key={`${asString(row.id) ?? j}-${j}`}
										ctx={ctx}
										depth={depth + 1}
										row={row}
									/>
								))}
							</div>
						);
					}
					if (progress.length > 0) {
						return (
							<div key={i} className="flex flex-col gap-1.5">
								{orderProgressForDisplay(progress).map((row, j) => (
									<ProgressAgentRow
										key={`${asString(row.id) ?? j}-${j}`}
										ctx={ctx}
										depth={depth + 1}
										row={row}
									/>
								))}
							</div>
						);
					}
					return null;
				} finally {
					ctx.seen.delete(details);
				}
			})}
		</div>
	);
}

/** Nested snapshots = completed `task` extractions plus the in-flight call. */
function nestedSnapshots(row: Record<string, unknown>): Record<string, unknown>[] {
	const extracted = asRecord(row.extractedToolData);
	const completed = asArray(extracted?.task)
		.map(asTaskDetails)
		.filter((r): r is Record<string, unknown> => r != null);
	const inflight = asTaskDetails(row.inflightTaskDetails);
	return inflight ? [...completed, inflight] : completed;
}

// ---------------------------------------------------------------------------
// Agent rows
// ---------------------------------------------------------------------------

/** Optional inline transcript inspector button when this subagent exists in the live store. */
function useSubagentInspector(rawId: string, store: StoreApi<SubagentsStore>) {
	const t = useT();
	const [inspecting, setInspecting] = useState(false);
	const known = useFrameSelector(store, s => (rawId ? s.subagents.has(rawId) : false));
	const button = known ? (
		<IconButton
			aria-pressed={inspecting}
			className={cx(inspecting && "bg-(--sc-selected) text-(--sc-text)")}
			icon={<Eye />}
			label={t("chat.work.map")}
			onClick={() => setInspecting(value => !value)}
			size="sm"
		/>
	) : undefined;
	const panel =
		known && inspecting ? (
			<div className="rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-1) p-2">
				<SubagentSurface id={rawId} store={store} />
			</div>
		) : null;
	return { button, panel, inspecting };
}

/** Live agent row: framed `SubagentRunCard` with status, live tool line, retry, yields, and nested tree. */
function ProgressAgentRow({ row, depth, ctx }: { row: Record<string, unknown>; depth: number; ctx: TreeCtx }) {
	const t = useT();
	const status = asString(row.status) ?? "running";
	const rawId = asString(row.id) ?? "?";
	const id = formatTaskId(rawId);
	const description = asString(row.description)?.trim() || undefined;
	const agent = asString(row.agent);
	const retryState = asRecord(row.retryState);
	const retryFailure = asRecord(row.retryFailure);
	const currentTool = asString(row.currentTool);
	const toolDetail = asString(row.lastIntent) ?? asString(row.currentToolArgs);
	const currentToolStartMs = asNumber(row.currentToolStartMs);
	const recentTool = asRecord(asArray(row.recentTools)[0]);
	const assignment = asString(row.assignment) ?? asString(row.task);
	const yieldValue = asRecord(row.extractedToolData)?.yield;
	const review = status === "completed" ? extractReviewResult(normalizeYieldData(yieldValue)) : undefined;
	const nested = nestedSnapshots(row);
	const inspector = useSubagentInspector(rawId, ctx.store);

	const runState: SubagentRunState =
		status === "pending"
			? "pending"
			: status === "running"
				? "running"
				: status === "completed"
					? "done"
					: status === "aborted"
						? "cancelled"
						: "failed";
	const elapsed = currentToolStartMs != null ? ctx.now - currentToolStartMs : 0;
	const durationMs = asNumber(row.durationMs) ?? 0;
	const retryRemainingMs =
		retryState != null
			? Math.max(0, (asNumber(retryState.startedAtMs) ?? 0) + (asNumber(retryState.delayMs) ?? 0) - ctx.now)
			: 0;

	const badge =
		retryState && status === "running" ? (
			<Badge variant="warning">{t("tools.task.badge.retrying")}</Badge>
		) : retryFailure && (status === "failed" || status === "aborted") ? (
			<Badge variant="error">{t("tools.task.badge.rateLimited")}</Badge>
		) : status === "failed" ? (
			<Badge variant="error">{t("subagent.status.failed")}</Badge>
		) : status === "aborted" ? (
			<Badge variant="error">{t("subagent.status.cancelled")}</Badge>
		) : undefined;

	const summaryText = description ?? (status === "running" ? assignment : undefined);
	const hasBody =
		Boolean(assignment && summaryText !== assignment) ||
		Boolean(status === "running" && (currentTool || recentTool)) ||
		Boolean(retryState && status === "running") ||
		Boolean(retryFailure && status !== "running") ||
		Boolean(review) ||
		normalizeYieldData(yieldValue).some(item => yieldLabels(item.type).length > 0) ||
		nested.length > 0 ||
		Boolean(inspector.panel);

	return (
		<SubagentRunCard
			badge={badge}
			defaultOpen
			elapsed={durationMs > 0 ? formatElapsed(durationMs) : undefined}
			headerAction={inspector.button}
			metrics={
				status === "running" || status === "completed" ? (
					<AgentStats
						stats={{
							toolCount: asNumber(row.toolCount),
							requests: asNumber(row.requests),
							contextTokens: asNumber(row.contextTokens),
							contextWindow: asNumber(row.contextWindow),
							cost: asNumber(row.cost),
							resolvedModel: asString(row.resolvedModel),
						}}
					/>
				) : undefined
			}
			name={id}
			role={agent}
			state={runState}
			summary={summaryText}
		>
			{hasBody ? (
				<>
					{assignment && summaryText !== assignment && (
						<div className="truncate text-sc-xs text-(--sc-text-muted)" title={assignment}>
							{assignment}
						</div>
					)}

					{status === "running" &&
						(currentTool ? (
							<div className="flex min-w-0 items-center gap-1.5 font-mono text-sc-xs leading-relaxed">
								<span aria-hidden className="shrink-0 text-(--sc-accent)">
									└
								</span>
								<span
									className="min-w-0 truncate text-(--sc-text-secondary)"
									title={toolDetail ? `${currentTool}: ${toolDetail}` : currentTool}
								>
									{currentTool}
									{toolDetail && <span className="text-(--sc-text-muted)">: {toolDetail}</span>}
								</span>
								{elapsed > 5000 && (
									<span className="shrink-0 text-(--sc-warning) tabular-nums">
										· {formatDuration(elapsed)}
									</span>
								)}
							</div>
						) : (
							recentTool && (
								<div className="flex min-w-0 items-center gap-1.5 font-mono text-sc-xs leading-relaxed">
									<span aria-hidden className="shrink-0 text-(--sc-text-subtle)">
										└
									</span>
									<span className="min-w-0 truncate text-(--sc-text-muted)">
										{asString(recentTool.tool)}
										{(asString(row.lastIntent) ?? asString(recentTool.args)) && (
											<span>: {asString(row.lastIntent) ?? asString(recentTool.args)}</span>
										)}
									</span>
								</div>
							)
						))}

					{retryState && status === "running" && (
						<div className="flex min-w-0 items-center gap-1.5 font-mono text-sc-xs leading-relaxed">
							<span aria-hidden className="shrink-0 text-(--sc-warning)">
								└
							</span>
							<span className="min-w-0 truncate text-(--sc-warning)" title={asString(retryState.errorMessage)}>
								{t(retryRemainingMs > 0 ? "tools.task.retryWait" : "tools.task.retryNow", {
									attempt: asNumber(retryState.attempt) ?? 0,
									max: asNumber(retryState.maxAttempts) ?? 0,
									duration: formatDuration(retryRemainingMs),
									message: asString(retryState.errorMessage) ?? "",
								})}
							</span>
						</div>
					)}
					{retryFailure && status !== "running" && (
						<div className="flex min-w-0 items-center gap-1.5 font-mono text-sc-xs leading-relaxed">
							<span aria-hidden className="shrink-0 text-(--sc-danger)">
								└
							</span>
							<span className="min-w-0 truncate text-(--sc-danger)" title={asString(retryFailure.errorMessage)}>
								{t("tools.task.retryGaveUp", {
									count: asNumber(retryFailure.attempt) ?? 0,
									plural: (asNumber(retryFailure.attempt) ?? 0) === 1 ? "" : "s",
									message: asString(retryFailure.errorMessage) ?? "",
								})}
							</span>
						</div>
					)}

					{review ? <ReviewBlock review={review} /> : <YieldLines value={yieldValue} />}
					{inspector.panel}
					{nested.length > 0 && <NestedTaskTree ctx={ctx} depth={depth} list={nested} />}
				</>
			) : null}
		</SubagentRunCard>
	);
}

/** Finalized agent row: framed `SubagentRunCard` with verdict/output peek, nested results, and error. */
function ResultAgentRow({ row, depth, ctx }: { row: Record<string, unknown>; depth: number; ctx: TreeCtx }) {
	const t = useT();
	const rawId = asString(row.id) ?? "?";
	const id = formatTaskId(rawId);
	const description = asString(row.description)?.trim() || undefined;
	const agent = asString(row.agent);
	const aborted = row.aborted === true;
	const error = asString(row.error);
	const mergeFailed = !aborted && (asNumber(row.exitCode) ?? 0) === 0 && !!error;
	const success = !aborted && (asNumber(row.exitCode) ?? 0) === 0 && !error;
	const output = asString(row.output) ?? "";
	const { warning: missingYieldWarning, rest: outputRest } = extractMissingYieldWarning(output);
	const needsWarning = Boolean(missingYieldWarning) && success;
	const assignment = asString(row.assignment) ?? asString(row.task);
	const yieldValue = asRecord(row.extractedToolData)?.yield;
	const yieldItems = normalizeYieldData(yieldValue);
	const review = extractReviewResult(yieldItems);
	const nested = nestedSnapshots(row);
	const retryFailure = asRecord(row.retryFailure);
	const inspector = useSubagentInspector(rawId, ctx.store);

	const runState: SubagentRunState = aborted
		? "cancelled"
		: needsWarning || mergeFailed
			? "warning"
			: success
				? "done"
				: "failed";
	const statusVariant =
		runState === "done" ? "success" : runState === "failed" || runState === "cancelled" ? "error" : "warning";
	const statusLabel = aborted
		? t("subagent.status.cancelled")
		: !success && !mergeFailed
			? t("subagent.status.failed")
			: success && !needsWarning
				? t("tools.task.badge.done")
				: mergeFailed
					? t("tools.task.badge.mergeFailed")
					: t("tools.task.badge.warning");

	const hasCustomRendering = review != null || yieldItems.some(item => yieldLabels(item.type).length > 0);
	const hasBody =
		Boolean(assignment && assignment !== description) ||
		Boolean(aborted && asString(row.abortReason)) ||
		Boolean(review) ||
		yieldItems.some(item => yieldLabels(item.type).length > 0) ||
		Boolean(!hasCustomRendering && outputRest.trim()) ||
		Boolean(missingYieldWarning) ||
		nested.length > 0 ||
		Boolean(
			!aborted && (asNumber(row.exitCode) ?? 0) === 0 && (asString(row.patchPath) || asString(row.branchName)),
		) ||
		Boolean(error && (!success || mergeFailed) && (!aborted || error !== asString(row.abortReason))) ||
		Boolean(inspector.panel);

	return (
		<SubagentRunCard
			badge={
				<span className="inline-flex shrink-0 items-center gap-1">
					<Badge size="xs" variant={statusVariant}>
						{statusLabel}
					</Badge>
					{retryFailure && (aborted || !success) && (
						<Badge size="xs" variant="error">
							{t("tools.task.badge.rateLimited")}
						</Badge>
					)}
					{row.truncated === true && (
						<Badge size="xs" variant="warning">
							{t("tools.task.badge.truncated")}
						</Badge>
					)}
				</span>
			}
			defaultOpen
			elapsed={formatDuration(asNumber(row.durationMs) ?? 0)}
			headerAction={inspector.button}
			metrics={
				<AgentStats
					stats={{
						toolCount: asNumber(row.toolCount),
						requests: asNumber(row.requests),
						contextTokens: asNumber(row.contextTokens),
						contextWindow: asNumber(row.contextWindow),
						cost: resultCost(row),
						resolvedModel: asString(row.resolvedModel),
					}}
				/>
			}
			name={id}
			role={agent}
			state={runState}
			summary={description}
		>
			{hasBody ? (
				<>
					{assignment && assignment !== description && (
						<div className="truncate text-sc-xs text-(--sc-text-muted)" title={assignment}>
							{assignment}
						</div>
					)}

					{aborted && asString(row.abortReason) && (
						<div className="flex min-w-0 items-center gap-1.5 text-sc-xs">
							<X aria-hidden className="size-3 shrink-0 text-(--sc-danger)" />
							<span className="min-w-0 truncate text-(--sc-text-muted)" title={asString(row.abortReason)}>
								{asString(row.abortReason)}
							</span>
						</div>
					)}

					{review ? (
						<ReviewBlock review={review} />
					) : (
						<>
							<YieldLines value={yieldValue} />
							{!hasCustomRendering && outputRest.trim() && <ResultOutputPreview text={outputRest} />}
						</>
					)}

					{missingYieldWarning && (
						<div className="truncate font-mono text-sc-xs text-(--sc-warning)" title={missingYieldWarning}>
							{missingYieldWarning}
						</div>
					)}

					{inspector.panel}

					{nested.length > 0 && <NestedTaskTree ctx={ctx} depth={depth} list={nested} />}

					{!aborted && (asNumber(row.exitCode) ?? 0) === 0 && asString(row.patchPath) && (
						<div className="truncate font-mono text-sc-xs text-(--sc-text-muted)" title={asString(row.patchPath)}>
							{t("tools.task.patch", { path: asString(row.patchPath) ?? "" })}
						</div>
					)}
					{!aborted &&
						(asNumber(row.exitCode) ?? 0) === 0 &&
						!asString(row.patchPath) &&
						asString(row.branchName) && (
							<div
								className="truncate font-mono text-sc-xs text-(--sc-text-muted)"
								title={asString(row.branchName)}
							>
								{t("tools.task.branch", { name: asString(row.branchName) ?? "" })}
							</div>
						)}

					{error && (!success || mergeFailed) && (!aborted || error !== asString(row.abortReason)) && (
						<div
							className={cx("min-w-0 text-sc-xs", mergeFailed ? "text-(--sc-warning)" : "text-(--sc-danger)")}
							title={error}
						>
							{t(mergeFailed ? "tools.task.mergeFailedHeading" : "tools.task.failedHeading")}
							<ErrorDetail className="truncate" error={error} />
						</div>
					)}
				</>
			) : null}
		</SubagentRunCard>
	);
}

/** Collapsible output preview: first lines + inline expand/collapse toggle when longer. */
function ResultOutputPreview({ text }: { text: string }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const { head, omitted } = headLines(text, OUTPUT_PREVIEW_LINES);
	return (
		<div className="rounded-(--sc-radius-md) border border-(--sc-code-border) bg-(--sc-code-bg) px-2.5 py-2">
			<pre className="max-h-40 overflow-auto font-mono text-sc-xs leading-relaxed whitespace-pre-wrap text-(--sc-text-secondary)">
				{expanded ? text : head}
			</pre>
			{omitted > 0 && (
				<div className="mt-1 flex items-center">
					<LinkButton className="font-mono text-sc-xs" onClick={() => setExpanded(value => !value)} tone="muted">
						{expanded ? t("common.showLess") : t("tools.read.more", { count: omitted })}
					</LinkButton>
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Task renderer
// ---------------------------------------------------------------------------

/** Task (subagent spawn): agent badge, name, status, live/settled subagent run cards. */
export function TaskRenderer({
	args,
	result,
	isError,
	isPartial,
	partialResult,
	livePreview,
	toolCallId,
}: ToolRendererProps) {
	const t = useT();
	const runtime = useSessionRuntime();
	const store = (runtime?.stores.get("subagents") as StoreApi<SubagentsStore> | undefined) ?? useSubagentsStore;
	const agent = typeof args.agent === "string" ? args.agent : "task";
	const name = typeof args.name === "string" ? args.name : null;
	const description =
		typeof args.i === "string" ? args.i : typeof args.description === "string" ? args.description : "";
	const taskText = typeof args.task === "string" ? args.task : "";

	const statusLabel = isError
		? t("subagent.status.failed")
		: isPartial
			? t("subagent.status.started")
			: t("subagent.status.completed");
	const statusTone = isError ? "error" : isPartial ? "accent" : "success";

	const effective = isPartial && partialResult != null ? partialResult : result;
	const details = resultDetails(result) ?? resultDetails(partialResult);
	const text = resultText(effective);

	const results = asArray(details?.results)
		.map(asRecord)
		.filter((r): r is Record<string, unknown> => r != null);
	const progress = asArray(details?.progress)
		.map(asRecord)
		.filter((r): r is Record<string, unknown> => r != null);
	const totalDurationMs = asNumber(details?.totalDurationMs) ?? 0;
	const hasResults = results.length > 0;
	// Result rows win once any exist; progress rows for spawns without a result
	// (a mixed call's async subset) render as a supplement below.
	const supplemental = hasResults
		? progress.filter(row => !results.some(res => asString(res.id) === asString(row.id)))
		: [];

	// Live rows carry elapsed times and retry countdowns — tick once a second
	// while the call runs so they stay fresh between partial emissions.
	const now = useNowTick(isPartial);

	if (livePreview && !isError) {
		return (
			<TaskWorkPreview
				args={args}
				progress={progress}
				results={results}
				toolCallId={toolCallId}
				active={isPartial === true}
			/>
		);
	}
	// Run-summary counts: one pass derives footer counts + request total.
	let abortedCount = 0;
	let failCount = 0;
	let mergeFailedCount = 0;
	let successCount = 0;
	let requestTotal = 0;
	for (const row of results) {
		requestTotal += asNumber(row.requests) ?? 0;
		if (row.aborted === true) abortedCount++;
		else if ((asNumber(row.exitCode) ?? 0) !== 0) failCount++;
		else if (asString(row.error)) mergeFailedCount++;
		else successCount++;
	}
	const summaryParts: ReactNode[] = [];
	if (abortedCount > 0)
		summaryParts.push(
			<span key="aborted" className="text-(--sc-danger)">
				{t("tools.task.footer.aborted", { count: abortedCount })}
			</span>,
		);
	if (successCount > 0)
		summaryParts.push(
			<span key="succeeded" className="text-(--sc-success)">
				{t("tools.task.footer.succeeded", { count: successCount })}
			</span>,
		);
	if (mergeFailedCount > 0)
		summaryParts.push(
			<span key="merge" className="text-(--sc-warning)">
				{t("tools.task.footer.mergeFailed", { count: mergeFailedCount })}
			</span>,
		);
	if (failCount > 0)
		summaryParts.push(
			<span key="failed" className="text-(--sc-danger)">
				{t("tools.task.footer.failed", { count: failCount })}
			</span>,
		);
	if (requestTotal > 0)
		summaryParts.push(<span key="req">{t("tools.task.footer.requests", { count: requestTotal })}</span>);
	summaryParts.push(
		<span key="duration" className="tabular-nums">
			{formatDuration(totalDurationMs)}
		</span>,
	);

	// Cycle guard for nested task trees: one set per render pass, threaded down.
	const ctx: TreeCtx = { seen: new Set<object>(), now, store };

	const markerIndex = (() => {
		const lines = text.split("\n");
		return lines.findIndex(
			line =>
				line.includes("<system-notification>") ||
				line.startsWith("Applied patches:") ||
				line.startsWith("No changes to apply."),
		);
	})();
	const trailingLines =
		markerIndex >= 0
			? text
					.split("\n")
					.slice(markerIndex)
					.filter(line => line.trim())
			: [];

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2 text-sc-sm">
				<span className="flex size-5 shrink-0 items-center justify-center rounded-(--sc-radius-sm) border border-(--sc-border-subtle) bg-(--sc-surface-1) text-(--sc-accent)">
					<Bot aria-hidden className="size-3.5" />
				</span>
				{name && <span className="truncate font-mono font-semibold text-(--sc-text)">{name}</span>}
				<span className="shrink-0 rounded-(--sc-radius-sm) border border-(--sc-border-subtle) bg-(--sc-surface-1) px-1.5 py-px font-mono text-sc-xs font-medium text-(--sc-text-muted)">
					{agent}
				</span>
				<span className="ml-auto shrink-0">
					<Badge dot size="xs" variant={statusTone}>
						{statusLabel}
					</Badge>
				</span>
			</div>
			{description && <div className="text-sc-sm text-(--sc-text-muted)">{description}</div>}
			{taskText && (
				<div className="max-h-32 overflow-auto rounded-(--sc-radius-md) border border-(--sc-code-border) bg-(--sc-code-bg) px-2.5 py-2 text-sc-sm leading-relaxed whitespace-pre-wrap text-(--sc-text-secondary)">
					{taskText}
				</div>
			)}

			{!hasResults && progress.length > 0 && (
				<div className="flex max-h-96 flex-col gap-2 overflow-auto pr-0.5">
					{orderProgressForDisplay(progress).map((row, i) => (
						<ProgressAgentRow key={`${asString(row.id) ?? i}-${i}`} ctx={ctx} depth={0} row={row} />
					))}
				</div>
			)}

			{hasResults && (
				<div className="flex max-h-96 flex-col gap-2 overflow-auto pr-0.5">
					{orderResultsForDisplay(results).map((row, i) => (
						<ResultAgentRow key={`${asString(row.id) ?? i}-${i}`} ctx={ctx} depth={0} row={row} />
					))}
					{supplemental.length > 0 &&
						orderProgressForDisplay(supplemental).map((row, i) => (
							<ProgressAgentRow key={`sup-${asString(row.id) ?? i}-${i}`} ctx={ctx} depth={0} row={row} />
						))}
				</div>
			)}

			{hasResults && (
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-(--sc-divider) pt-1.5 font-mono text-sc-xs text-(--sc-text-muted)">
					{summaryParts.map((part, i) => (
						<span key={i} className="inline-flex items-center gap-2">
							{i > 0 && (
								<span aria-hidden className="text-(--sc-text-subtle)">
									·
								</span>
							)}
							{part}
						</span>
					))}
				</div>
			)}

			{trailingLines.map((line, i) => (
				<div key={i} className="font-mono text-sc-xs text-(--sc-text-muted)">
					{line}
				</div>
			))}

			{!hasResults && progress.length === 0 && !text.trim() && details != null && (
				<div className="text-sc-sm text-(--sc-text-muted)">{t("tools.task.noResults")}</div>
			)}

			{details == null && text && <ToolTextPreview text={text} isError={isError} />}
		</div>
	);
}

/** A compact presentation of the same parsed task rows, enriched by live roster activity. */
function TaskWorkPreview({
	args,
	progress,
	results,
	toolCallId,
	active,
}: {
	args: Record<string, unknown>;
	progress: Record<string, unknown>[];
	results: Record<string, unknown>[];
	toolCallId?: string;
	active: boolean;
}) {
	const runtime = useSessionRuntime();
	const store = (runtime?.stores.get("subagents") as StoreApi<SubagentsStore> | undefined) ?? useSubagentsStore;
	const rosterKey = useFrameSelector(store, s =>
		Array.from(s.subagents.values())
			.filter(agent => agent.parentToolCallId === toolCallId && toolCallId !== undefined)
			.map(agent => agent.id)
			.join("\n"),
	);
	const rows = [...results, ...progress.filter(row => !results.some(result => result.id === row.id))];
	for (const id of rosterKey.split("\n").filter(Boolean)) {
		if (!rows.some(row => row.id === id)) rows.push({ id });
	}
	if (rows.length === 0) {
		const tasks = asArray(args.tasks)
			.map(asRecord)
			.filter((row): row is Record<string, unknown> => row !== undefined);
		rows.push(...(tasks.length > 0 ? tasks : [args]));
	}
	return (
		<div className="flex flex-col gap-1.5" data-agent-work>
			{rows.map((row, index) => (
				<TaskWorkRow key={asString(row.id) ?? index} row={row} store={store} active={active} />
			))}
		</div>
	);
}

function TaskWorkRow({
	row,
	store,
	active,
}: {
	row: Record<string, unknown>;
	store: Pick<StoreApi<SubagentsStore>, "getState" | "subscribe">;
	active: boolean;
}) {
	const t = useT();
	const id = asString(row.id) ?? "";
	const name = useFrameSelector(store, s => s.subagents.get(id)?.id ?? "");
	const role = useFrameSelector(store, s => s.subagents.get(id)?.agent ?? "");
	const status = useFrameSelector(store, s => s.subagents.get(id)?.status ?? "");
	const activity = useFrameSelector(store, s => {
		const agent = s.subagents.get(id);
		return (
			agent?.progress?.currentToolIntent ||
			agent?.progress?.lastIntent ||
			agent?.progress?.currentToolArgs ||
			agent?.progress?.currentTool ||
			agent?.description ||
			""
		);
	});
	const title = name || asString(row.name) || asString(row.id) || asString(row.agent) || t("tools.label.task");
	const agentRole = role || asString(row.agent) || "";
	const currentStatus = status || asString(row.status);
	const running = currentStatus ? currentStatus === "running" || currentStatus === "pending" : active;
	const detail =
		currentStatus === "restart-cut"
			? t("subagent.status.restartCut")
			: activity ||
				asString(row.lastIntent) ||
				asString(row.currentToolArgs) ||
				asString(row.currentTool) ||
				asString(row.description) ||
				t(running ? "subagent.status.started" : "subagent.status.completed");
	return (
		<div
			className="flex min-w-0 items-center gap-2 rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-1) px-2.5 py-1.5 text-sc-sm"
			data-agent-status={status || asString(row.status)}
		>
			<Bot aria-hidden className="omp-live-step-icon text-(--sc-accent)" />
			<span className="shrink-0 font-mono font-medium text-(--sc-text)">{title}</span>
			{agentRole && agentRole !== "task" && (
				<span className="shrink-0 rounded-(--sc-radius-xs) border border-(--sc-border-subtle) bg-(--sc-elevated) px-1 py-px font-mono text-sc-xs text-(--sc-text-muted)">
					{agentRole}
				</span>
			)}
			<span className="min-w-0 truncate text-(--sc-text-muted)" title={detail}>
				{detail}
			</span>
		</div>
	);
}
