/**
 * How current the session's todo list is, said the same way on every surface that shows its "now" row or progress
 * (the dock's todo card, the work board's plan zone, the status strip): when the list last changed, the instructions
 * received since that change, and a warning with its reason when the list is behind the work (the bridge's reading,
 * `TodoDriftState`). The reading knows when instructions arrived, never whether the list covers them, so one or two
 * fresh ones are news (a neutral dot) and only old or piled-up ones warn. A list whose last change is unknown says
 * nothing.
 */
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import type { TodoDriftState } from "../../../../../resources/gui-bridge/todo-drift-contracts";
import { cx, formatAgo, formatClock } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useAgeLabels } from "../../../lib/now-tick";
import { useTodoStore } from "../../../stores/todo";
import { StatusDot } from "../../common";
import { BoardRow, KindMark } from "../../layout/work-board/board-parts";

/** The mark of a list behind the work, for a surface that draws its own lead icon (a work board row). */
export const TodoStaleIcon = AlertTriangle;

const STALE_REASON = {
	instruction: "todoPanel.stale.instruction",
	drift: "todoPanel.stale.drift",
} as const;

export interface TodoFreshness {
	stale: keyof typeof STALE_REASON | null;
	/** `warning` while the list is behind the work, `info` while instructions came since it changed, else null. */
	level: "warning" | "info" | null;
	/** Why the list is behind the work, in the person's words; null while it follows it. */
	reason: string | null;
	/** The few words a one-line surface shows: "Since list change: 2" while instructions came, "List out of date" for drift. */
	summary: string | null;
	/** "12m ago". */
	ago: string;
	/** "Updated 12m ago". */
	updated: string;
	/** Everything in words, for a tooltip: the reason, the instructions and what they mean, when the list last changed. */
	title: string;
	/** The instructions received since the list last changed, newest last: the ones the bridge kept of `receivedCount`. */
	received: TodoDriftState["received"];
	receivedCount: number;
	/** "Since last list change: 2 instructions"; null while none came. */
	receivedHeader: string | null;
}

/** One identity for `useAgeLabels` (a new one restarts its clock), and one argument: `map`'s index is no `now`. */
const agoLabel = (value: string | number | null | undefined): string => formatAgo(value);

/** A host older than the received lines sends a reading without them. */
const NONE_RECEIVED: TodoDriftState["received"] = [];

/** The list's freshness in words, moving on the shared clock; null while its last change is unknown. */
export function useTodoFreshness(): TodoFreshness | null {
	const t = useT();
	const changedAt = useTodoStore(state => state.drift?.changedAt) ?? null;
	const stale = useTodoStore(state => state.drift?.stale) ?? null;
	const received = useTodoStore(state => state.drift?.received) ?? NONE_RECEIVED;
	const readCount = useTodoStore(state => state.drift?.receivedCount) ?? 0;
	const ago = useAgeLabels([changedAt], agoLabel)[0] ?? "";
	if (changedAt === null || ago === "") return null;
	// Never fewer than the lines shown, whatever a reading says.
	const receivedCount = Math.max(readCount, received.length);
	const reason = stale ? t(STALE_REASON[stale]) : null;
	const updated = t("todoPanel.updated", { ago });
	const receivedHeader = receivedCount > 0 ? t("todoPanel.received", { count: receivedCount }) : null;
	return {
		stale,
		level: stale ? "warning" : receivedCount > 0 ? "info" : null,
		reason,
		// One-line surfaces get the short words; the full reason stays for the plan zone's row and the tooltip.
		summary:
			receivedCount > 0
				? t("todoPanel.receivedShort", { count: receivedCount })
				: stale === "drift"
					? t("todoPanel.stale.driftShort")
					: reason,
		ago,
		updated,
		title: [reason, receivedHeader, receivedHeader && t("todoPanel.receivedNote"), updated]
			.filter(Boolean)
			.join("\n"),
		received,
		receivedCount,
		receivedHeader,
	};
}

/** The lead of a line about the list: the warning sign while it is behind the work, a neutral dot for news. */
function FreshnessLead({ level }: { level: TodoFreshness["level"] }) {
	if (level === "warning") return <TodoStaleIcon aria-hidden className="size-3.5 shrink-0 text-(--sc-warning)" />;
	return level === "info" ? <StatusDot decorative tone="neutral" /> : null;
}

/**
 * The one drawing of it. `line`: the mark and its words, then "Updated 12m ago" (the dock card). `strip`: the same
 * as "Since list change: 2 · 12m ago", for a one-line strip. `figure`: the warning mark and "12m ago" alone, for a
 * section head whose first rows say the rest (the reason, or the instructions received: `TodoReceived`); the words
 * stay for screen readers and the tooltip.
 */
export function TodoFreshnessMark({
	freshness,
	form = "line",
	className,
}: {
	freshness: TodoFreshness | null;
	form?: "line" | "strip" | "figure";
	className?: string;
}) {
	if (!freshness) return null;
	// Only the words give way in a narrow line, and they lead with the count: the mark and the time are never cut.
	const words = freshness.summary !== null && form !== "figure";
	const { level } = freshness;
	return (
		<span
			className={cx("flex items-center gap-1.5", words ? "min-w-0" : "shrink-0", className)}
			data-todo-freshness={freshness.stale ?? (level === "info" ? "received" : "fresh")}
			title={freshness.title}
		>
			{words ? (
				<>
					<FreshnessLead level={level} />
					<span className="min-w-0 truncate text-(--sc-text-secondary)">{freshness.summary}</span>
					{form === "strip" && <span aria-hidden>·</span>}
				</>
			) : (
				<>
					{level === "warning" && <FreshnessLead level={level} />}
					{freshness.summary && <span className="sr-only">{freshness.summary}</span>}
				</>
			)}
			<span className="shrink-0 whitespace-nowrap tabular-nums">
				{form === "line" ? freshness.updated : freshness.ago}
			</span>
		</span>
	);
}

/**
 * The instructions received since the list last changed, over the list on every surface that lists it (the work
 * board's plan zone, the strip panel's, the opened dock card): how many, then each by its first line (one line; the
 * time and the whole line as its tooltip, and a tap shows it whole in place), then how many more the reading left
 * out. Rows of a board list; `list` brings the list element where there is none (the dock card). Nothing while none
 * came.
 */
export function TodoReceived({ freshness, list = false }: { freshness: TodoFreshness | null; list?: boolean }) {
	const t = useT();
	const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
	if (!freshness?.receivedHeader) return null;
	const { received, receivedCount, receivedHeader } = freshness;
	const more = receivedCount - received.length;
	// A list the agent worked past them on carries the warning here: this line stands for the reason's row.
	const behind = freshness.stale === "instruction";
	const toggle = (key: string) =>
		setOpened(current => {
			const next = new Set(current);
			if (!next.delete(key)) next.add(key);
			return next;
		});
	const rows = (
		<>
			<BoardRow
				data={{ "data-todo-received": String(receivedCount) }}
				flipKey="todo-received"
				label={receivedHeader}
				lead={behind ? <KindMark icon={TodoStaleIcon} tone="warning" /> : <StatusDot decorative tone="neutral" />}
				title={freshness.title}
			/>
			{received.map(line => {
				// By arrival, not position: the reading keeps the newest five, so a sixth shifts every index.
				const key = `${line.at}:${line.text}`;
				const whole = opened.has(key);
				return (
					<BoardRow
						// A tap opens the line in place, so the phone's strip panel stays open for it.
						data={{ "data-todo-received-line": "", "data-board-expands": "", "aria-expanded": String(whole) }}
						flipKey={`todo-received:${key}`}
						key={key}
						label={<span className="text-(--sc-text-subtle)">{line.text}</span>}
						lead={null}
						onClick={() => toggle(key)}
						title={`${formatClock(line.at)}\n${line.text}`}
						wrap={whole}
					/>
				);
			})}
			{more > 0 && (
				<li className="omp-work-board-more" data-todo-received-more={more}>
					{t("workBoard.moreTodos", { count: more })}
				</li>
			)}
		</>
	);
	return list ? <ul className="omp-work-board-list mb-1">{rows}</ul> : rows;
}
