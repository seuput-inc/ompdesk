/**
 * How current the session's todo list is, said the same way on every surface that shows its "now" row or progress
 * (the dock's todo card, the work board's plan zone, the status strip): when the list last changed, and a warning
 * with its reason when the agent worked on without keeping it (the bridge's reading, `TodoDriftState`). A list whose
 * last change is unknown says nothing.
 */
import { AlertTriangle } from "lucide-react";
import { cx, formatAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useAgeLabels } from "../../../lib/now-tick";
import { useTodoStore } from "../../../stores/todo";

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
}

/** One identity for `useAgeLabels` (a new one restarts its clock), and one argument: `map`'s index is no `now`. */
const agoLabel = (value: string | number | null | undefined): string => formatAgo(value);

/** The list's freshness in words, moving on the shared clock; null while its last change is unknown. */
export function useTodoFreshness(): TodoFreshness | null {
	const t = useT();
	const changedAt = useTodoStore(state => state.drift?.changedAt) ?? null;
	const stale = useTodoStore(state => state.drift?.stale) ?? null;
	const ago = useAgeLabels([changedAt], agoLabel)[0] ?? "";
	if (changedAt === null || ago === "") return null;
	const reason = stale ? t(STALE_REASON[stale]) : null;
	const updated = t("todoPanel.updated", { ago });
	return { stale, reason, ago, updated, title: reason ? `${reason}\n${updated}` : updated };
}

/**
 * The one drawing of it. `line`: the warning with its reason, then "Updated 12m ago" (the dock card). `strip`: the
 * same with the bare "12m ago", for a one-line strip. `figure`: the warning mark and "12m ago" alone, for a section
 * head whose row says the reason (the words stay for screen readers and the tooltip).
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
