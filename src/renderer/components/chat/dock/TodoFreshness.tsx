/**
 * How current the session's todo list is, said the same way on every surface that shows its "now" row or progress
 * (the dock's todo card, the work board's plan zone, the status strip): when the list last changed, a warning with
 * its reason when the agent worked on without keeping it, and the instructions received since that change (the
 * bridge's reading, `TodoDriftState`). A list whose last change is unknown says nothing.
 */
import { AlertTriangle, CornerDownRight } from "lucide-react";
import type { TodoDriftState } from "../../../../../resources/gui-bridge/todo-drift-contracts";
import { cx, formatAgo, formatClock } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useAgeLabels } from "../../../lib/now-tick";
import { useTodoStore } from "../../../stores/todo";
import { BoardRow, KindMark } from "../../layout/work-board/board-parts";

/** The mark of a list behind the work, for a surface that draws its own lead icon (a work board row). */
export const TodoStaleIcon = AlertTriangle;

const STALE_REASON = {
	instruction: "todoPanel.stale.instruction",
	drift: "todoPanel.stale.drift",
} as const;

export interface TodoFreshness {
	stale: keyof typeof STALE_REASON | null;
	/** Why the list is behind the work, in the person's words; null while it follows it. */
	reason: string | null;
	/** "12m ago". */
	ago: string;
	/** "Updated 12m ago". */
	updated: string;
	/** Everything in words, for a tooltip: the reason, then when the list last changed. */
	title: string;
	/** The instructions received since the list last changed, newest last: the ones the bridge kept of `receivedCount`. */
	received: TodoDriftState["received"];
	receivedCount: number;
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
	const receivedCount = useTodoStore(state => state.drift?.receivedCount) ?? 0;
	const ago = useAgeLabels([changedAt], agoLabel)[0] ?? "";
	if (changedAt === null || ago === "") return null;
	const reason = stale ? t(STALE_REASON[stale]) : null;
	const updated = t("todoPanel.updated", { ago });
	return {
		stale,
		reason,
		ago,
		updated,
		title: reason ? `${reason}\n${updated}` : updated,
		received,
		// Never fewer than the lines shown, whatever a reading says.
		receivedCount: Math.max(receivedCount, received.length),
	};
}

/**
 * The one drawing of it. `line`: the warning with its reason, then "Updated 12m ago" (the dock card). `strip`: the
 * same with the bare "12m ago", for a one-line strip. `figure`: the warning mark and "12m ago" alone, for a section
 * head whose first row says it (the reason, or the instructions received: `TodoReceived`); the words stay for
 * screen readers and the tooltip.
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
	// Only the reason gives way in a narrow line: the mark and the time are never cut.
	const words = freshness.stale !== null && form !== "figure";
	return (
		<span
			className={cx("flex items-center gap-1.5", words ? "min-w-0" : "shrink-0", className)}
			data-todo-freshness={freshness.stale ?? "fresh"}
			title={freshness.title}
		>
			{freshness.stale && (
				<>
					<TodoStaleIcon aria-hidden className="size-3.5 shrink-0 text-(--sc-warning)" />
					<span className={words ? "min-w-0 truncate text-(--sc-text-secondary)" : "sr-only"}>
						{freshness.reason}
					</span>
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
 * board's plan zone, the strip panel's, the opened dock card): how many, then each by its first line (one line, the
 * time and the whole line as its tooltip), then how many more the reading left out. Rows of a board list; `list`
 * brings the list element where there is none (the dock card). Nothing while none came.
 */
export function TodoReceived({ freshness, list = false }: { freshness: TodoFreshness | null; list?: boolean }) {
	const t = useT();
	if (!freshness || freshness.receivedCount === 0) return null;
	const { received, receivedCount } = freshness;
	const count = t("todoPanel.received", { count: receivedCount });
	const more = receivedCount - received.length;
	// A list the agent worked past them on carries the warning here: this line stands for the reason's row.
	const behind = freshness.stale === "instruction";
	const rows = (
		<>
			<BoardRow
				data={{ "data-todo-received": String(receivedCount) }}
				flipKey="todo-received"
				label={count}
				lead={<KindMark icon={behind ? TodoStaleIcon : CornerDownRight} tone={behind ? "warning" : "muted"} />}
				title={`${count}\n${freshness.title}`}
			/>
			{received.map((line, index) => (
				<BoardRow
					data={{ "data-todo-received-line": "" }}
					flipKey={`todo-received:${line.at}:${index}`}
					key={`${line.at}:${index}`}
					label={<span className="text-(--sc-text-subtle)">{line.text}</span>}
					lead={null}
					title={`${formatClock(line.at)}\n${line.text}`}
				/>
			))}
			{more > 0 && (
				<li className="omp-work-board-more" data-todo-received-more={more}>
					{t("workBoard.moreTodos", { count: more })}
				</li>
			)}
		</>
	);
	return list ? <ul className="omp-work-board-list mb-1">{rows}</ul> : rows;
}
