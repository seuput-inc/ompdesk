/**
 * Shared framed card chrome for inline interactive chat cards (bot offers, connector installs,
 * approval summaries, and structured agent prompts), bringing Orca's `NativeChatCardFrame`
 * scanability rhythm onto OMPdesk's `--sc-*` token set.
 */

import type { ReactNode } from "react";
import { cx } from "../../lib/format";

export type ChatCardTone = "accent" | "success" | "warning" | "danger" | "muted";

const STATUS_DOT: Record<ChatCardTone, string> = {
	accent: "bg-(--sc-accent)",
	success: "bg-(--sc-success)",
	warning: "bg-(--sc-warning)",
	danger: "bg-(--sc-danger)",
	muted: "bg-(--sc-text-subtle)",
};

const STATUS_SURFACE: Record<ChatCardTone, string> = {
	accent: "bg-(--sc-accent-soft) text-(--sc-accent-on-soft)",
	success: "bg-(--sc-success-soft) text-(--sc-success-on-soft)",
	warning: "bg-(--sc-warning-soft) text-(--sc-warning-on-soft)",
	danger: "bg-(--sc-danger-soft) text-(--sc-danger-on-soft)",
	muted: "bg-(--sc-surface-2) text-(--sc-text-muted)",
};

/** Compact inline status pill with a semantic dot, safe for both Dark and Light surfaces. */
export function ChatCardStatus({
	label,
	tone = "muted",
	meta,
	pulse = false,
	className,
}: {
	label: ReactNode;
	tone?: ChatCardTone;
	meta?: ReactNode;
	pulse?: boolean;
	className?: string;
}) {
	return (
		<span
			className={cx(
				"inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-sc-xs font-medium",
				STATUS_SURFACE[tone],
				className,
			)}
			data-chat-card-status={tone}
		>
			<span
				aria-hidden
				className={cx("size-1.5 shrink-0 rounded-full", STATUS_DOT[tone], pulse && "omp-pulse-dot")}
			/>
			<span className="truncate">{label}</span>
			{meta ? <span className="font-mono opacity-80 tabular-nums">{meta}</span> : null}
		</span>
	);
}

/** Action bar inside a `ChatCardFrame` footer: primary/secondary buttons plus optional trailing context. */
export function ChatCardActions({
	children,
	aside,
	className,
}: {
	children: ReactNode;
	aside?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cx("flex flex-wrap items-center justify-between gap-2", className)} data-chat-card-actions>
			<div className="flex flex-wrap items-center gap-1.5">{children}</div>
			{aside ? <div className="flex items-center gap-2 text-sc-xs text-(--sc-text-muted)">{aside}</div> : null}
		</div>
	);
}

export interface ChatCardFrameProps {
	/** Small leading visual: avatar, framed icon, or status glyph. */
	leading?: ReactNode;
	/** Primary card heading (bot name, connector name, or prompt label). */
	title: ReactNode;
	/** Quiet category eyebrow rendered above or beside the title. */
	eyebrow?: ReactNode;
	/** Status pill or badge rendered on the header's right cluster. */
	status?: ReactNode;
	/** Trailing header control (e.g. HideButton or step counter). */
	headerAside?: ReactNode;
	/** Main card body; omitted cleanly when a compact card carries only header + footer. */
	children?: ReactNode;
	/** Hairline-separated footer band for actions and quiet metadata. */
	footer?: ReactNode;
	className?: string;
	"data-card-kind"?: string;
}

/**
 * Framed inline chat card: subtle elevated shell, tinted header band separated by a hairline
 * divider, comfortable body rhythm, and an optional footer strip for interactive actions.
 */
export function ChatCardFrame({
	leading,
	title,
	eyebrow,
	status,
	headerAside,
	children,
	footer,
	className,
	"data-card-kind": cardKind,
}: ChatCardFrameProps) {
	return (
		<div
			className={cx(
				"overflow-hidden rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-elevated) text-(--sc-text) shadow-(--sc-shadow-sm)",
				className,
			)}
			data-chat-card-frame=""
			data-card-kind={cardKind}
		>
			<div className="flex min-w-0 items-center gap-2.5 border-b border-(--sc-divider) bg-(--sc-surface-1) px-3.5 py-2">
				{leading ? <div className="shrink-0">{leading}</div> : null}
				<div className="flex min-w-0 flex-1 flex-col">
					{eyebrow ? (
						<span className="truncate text-sc-xs leading-tight font-medium text-(--sc-text-muted)">
							{eyebrow}
						</span>
					) : null}
					<div className="flex min-w-0 items-center gap-2">
						<span className="min-w-0 truncate text-sc-md leading-snug font-semibold text-(--sc-text)">
							{title}
						</span>
						{status}
					</div>
				</div>
				{headerAside ? <div className="flex shrink-0 items-center gap-1.5">{headerAside}</div> : null}
			</div>
			{children ? <div className="px-3.5 py-2.5 text-sc-sm text-(--sc-text-secondary)">{children}</div> : null}
			{footer ? (
				<div className="border-t border-(--sc-divider) bg-(--sc-surface-1) px-3.5 py-2">{footer}</div>
			) : null}
		</div>
	);
}
