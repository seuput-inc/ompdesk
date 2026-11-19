/**
 * The rows of `ChildrenAtWork` (ChildrenAtWork.tsx loads this lazily: it only shows once a session has opened children,
 * so it stays out of the phone's first-screen JavaScript). While the pane's work board docks beside the transcript it
 * lists the same children (a waiting one under Needs you, the others under Now), so the transcript leaves out each row
 * whose board section is open; a folded section, the strip and a phone keep the line here.
 */
import { useLiveReview } from "../../../hooks/use-live-review";
import { cx, formatElapsed } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useNowTick } from "../../../lib/now-tick";
import { useWorkBoardStore } from "../../../stores/work-board";
import { Tooltip } from "../../common";
import { openedChildOpener } from "../../layout/work-board/open-peer";
import { childActivity, type OpenedChildRow } from "../../layout/work-board/opened-children";
import { useChildrenAtWork } from "./ChildrenAtWork";
import { useBoardDocked } from "./use-board-docked";

function ChildLine({ row, now }: { row: OpenedChildRow; now: number }) {
	const t = useT();
	const title = row.title || t("workBoard.review.untitled");
	const activity = childActivity(row) ?? (row.status === "waiting" ? t("workBoard.opened.status.waiting") : null);
	const clock = row.status === "running" && row.since ? formatElapsed(Math.max(0, now - row.since)) : "";
	const open = openedChildOpener(row);
	const body = (
		<>
			<span aria-hidden className="omp-children-at-work-dot" data-status={row.status ?? "open"} />
			<span className="omp-children-at-work-title">{title}</span>
			{activity ? <span className="omp-children-at-work-step">{activity}</span> : null}
			{clock ? <span className="omp-children-at-work-clock">{clock}</span> : null}
		</>
	);
	const data = { "data-child-at-work": row.key, "data-status": row.status ?? "open" };
	return (
		<li>
			<Tooltip content={[title, activity].filter(Boolean).join(" · ")} describe={false}>
				{open ? (
					// controls-ok: the omp-children-at-work-row class draws the whole control
					<button className="omp-children-at-work-row" onClick={open} type="button" {...data}>
						{body}
					</button>
				) : (
					// A paired host's child still starting: no tab here and no file yet, so nothing to open (open-peer.ts).
					<div className="omp-children-at-work-row" {...data}>
						{body}
					</div>
				)}
			</Tooltip>
		</li>
	);
}

export function ChildrenAtWorkList({ className }: { className?: string }) {
	const t = useT();
	const { tabId, rows: atWork } = useChildrenAtWork();
	const docked = useBoardDocked();
	const folded = useWorkBoardStore(state => state.collapsed);
	const rows = docked ? atWork.filter(row => folded[row.status === "waiting" ? "needs" : "now"]) : atWork;
	const running = rows.some(row => row.status === "running");
	useLiveReview(tabId, running);
	const now = useNowTick(running);
	if (rows.length === 0) return null;
	return (
		<section
			aria-label={t("workBoard.opened")}
			className={cx("omp-children-at-work", className)}
			data-children-at-work
		>
			<ul>
				{rows.map(row => (
					<ChildLine key={row.key} now={now} row={row} />
				))}
			</ul>
		</section>
	);
}
