/**
 * Compact live/settled subagent run card for the chat stream (Orca `NativeChatSubagentRun` parity):
 * renders a scannable framed row with status indicator dot, monospace subagent name, role badge,
 * elapsed/telemetry cluster, live activity line, and a collapsible output or transcript peek.
 */

import { type ReactNode, useState } from "react";
import { cx } from "../../../lib/format";
import { DisclosureButton } from "../../common";

export type SubagentRunState = "pending" | "running" | "done" | "warning" | "failed" | "cancelled";

const DOT_CLASS: Record<SubagentRunState, string> = {
	pending: "border border-(--sc-border) bg-transparent",
	running: "bg-(--sc-accent) omp-pulse-dot",
	done: "bg-(--sc-success)",
	warning: "bg-(--sc-warning)",
	failed: "bg-(--sc-danger)",
	cancelled: "bg-(--sc-text-subtle)",
};

export interface SubagentRunCardProps {
	/** Monospace subagent name or breadcrumb id. */
	name: string;
	/** Optional role badge (e.g. `explore`, `reviewer`, `worker`). */
	role?: string;
	state: SubagentRunState;
	/** Optional compact status badge or tag beside the role. */
	badge?: ReactNode;
	/** Short description or current action shown beneath the header. */
	summary?: ReactNode;
	/** Right-aligned telemetry cluster (tool count, requests, context %, cost). */
	metrics?: ReactNode;
	/** Right-aligned elapsed or total duration (tabular-nums). */
	elapsed?: ReactNode;
	/** Collapsible body content (output peek, review verdict, nested tasks, or live transcript). */
	children?: ReactNode;
	/** Whether the collapsible body starts open (default true for running/review/errors). */
	defaultOpen?: boolean;
	/** Accessible label for the collapse/inspect toggle. */
	toggleLabel?: string;
	/** Optional extra right-aligned action (e.g. inspect transcript button). */
	headerAction?: ReactNode;
	className?: string;
}

export function SubagentRunCard({
	name,
	role,
	state,
	badge,
	summary,
	metrics,
	elapsed,
	children,
	defaultOpen = true,
	toggleLabel,
	headerAction,
	className,
}: SubagentRunCardProps) {
	const [open, setOpen] = useState(defaultOpen);
	const hasBody = Boolean(children);
	return (
		<div
			className={cx(
				"overflow-hidden rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-surface-1) text-(--sc-text)",
				state === "running" && "border-(--sc-accent-border)",
				className,
			)}
			data-status={state}
			data-subagent-run-card=""
		>
			<div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
				<span
					aria-hidden
					className={cx("size-2 shrink-0 rounded-full", DOT_CLASS[state])}
					data-subagent-dot={state}
				/>
				<span className="min-w-0 shrink-0 truncate font-mono text-sc-sm font-semibold text-(--sc-text)">
					{name}
				</span>
				{role && role !== "task" && (
					<span
						className="shrink-0 rounded-(--sc-radius-sm) border border-(--sc-border-subtle) bg-(--sc-elevated) px-1.5 py-px font-mono text-sc-xs font-medium text-(--sc-text-muted)"
						data-subagent-role={role}
					>
						{role}
					</span>
				)}
				{badge}
				<div className="ml-auto flex min-w-0 shrink items-center gap-2">
					{metrics}
					{elapsed ? (
						<span
							className="shrink-0 font-mono text-sc-xs text-(--sc-text-muted) tabular-nums"
							data-subagent-elapsed
						>
							{elapsed}
						</span>
					) : null}
					{headerAction}
					{hasBody && (
						<DisclosureButton
							aria-label={toggleLabel ?? name}
							chevron="start"
							className="size-6 shrink-0 justify-center rounded-(--sc-radius-sm) text-(--sc-text-muted) hover:bg-(--sc-hover) hover:text-(--sc-text)"
							data-subagent-toggle
							inline
							onToggle={() => setOpen(value => !value)}
							open={open}
						/>
					)}
				</div>
			</div>
			{summary ? (
				<div className="truncate px-2.5 pb-1.5 pl-6 text-sc-xs text-(--sc-text-muted)" data-subagent-summary>
					{summary}
				</div>
			) : null}
			{hasBody && open && (
				<div className="flex flex-col gap-1.5 border-t border-(--sc-divider) bg-(--sc-elevated) px-2.5 py-2">
					{children}
				</div>
			)}
		</div>
	);
}
