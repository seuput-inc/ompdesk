/**
 * Settings › Schedules › All runs: every kept run across schedules in one table (schedule, trigger, status, start,
 * duration, usage), each with View log, Open session (a fresh run's saved session, opened as a tab where it lives) and
 * Run again (its schedule's Run now). A worktree run names its worktree under the schedule.
 */
import { ChevronDown, ChevronRight, MessageSquare, Play } from "lucide-react";
import { Fragment } from "react";
import type { Schedule, ScheduleRun } from "../../../../shared/schedules";
import { basename, cx, durationBetween, formatClock, formatTimeAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { frequencySummary, RUN_STATUS_BADGE, runUsageText } from "../../../lib/schedule-text";
import { Badge, Card, EmptyState, IconButton } from "../../common";
import { RunLog } from "./RunLog";

const CELL = "border-b border-(--sc-divider) px-2 py-1.5 align-middle";
const HEAD = cx(CELL, "text-sc-xs font-medium whitespace-nowrap text-(--sc-text-muted)");

export function RunsTable({
	runs,
	schedules,
	device,
	openLog,
	onToggleLog,
	onRunAgain,
	onOpenSession,
}: {
	runs: readonly ScheduleRun[];
	schedules: readonly Schedule[];
	device: string | undefined;
	openLog: string | null;
	onToggleLog: (runId: string) => void;
	onRunAgain: (scheduleId: string) => void;
	onOpenSession: (run: ScheduleRun) => void;
}) {
	const t = useT();
	if (runs.length === 0) return <EmptyState size="row" title={t("schedules.allRuns.empty")} />;
	const byId = new Map(schedules.map(schedule => [schedule.id, schedule]));
	return (
		<Card className="overflow-x-auto" data-schedule-runs-table padding="none">
			<table className="w-full min-w-[40rem] border-separate border-spacing-0 text-left text-sc-sm">
				<thead>
					<tr>
						<th className={HEAD} scope="col">
							{t("schedules.allRuns.schedule")}
						</th>
						<th className={HEAD} scope="col">
							{t("schedules.allRuns.trigger")}
						</th>
						<th className={HEAD} scope="col">
							{t("schedules.allRuns.status")}
						</th>
						<th className={HEAD} scope="col">
							{t("schedules.allRuns.started")}
						</th>
						<th className={HEAD} scope="col">
							{t("schedules.allRuns.duration")}
						</th>
						<th className={HEAD} scope="col">
							{t("schedules.allRuns.usage")}
						</th>
						<th className={HEAD} scope="col">
							<span className="sr-only">{t("schedules.allRuns.actions")}</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{runs.map(run => {
						const schedule = byId.get(run.scheduleId);
						const name = schedule?.name ?? t("schedules.deletedSchedule");
						const open = openLog === run.id;
						const Chevron = open ? ChevronDown : ChevronRight;
						const duration = run.status === "skipped" ? null : durationBetween(run.startedAt, run.endedAt);
						return (
							<Fragment key={run.id}>
								<tr data-schedule-table-run={run.id}>
									<td className={cx(CELL, "max-w-[14rem]")}>
										<div className="truncate text-(--sc-text)">{name}</div>
										{run.worktree && (
											<div
												className="truncate text-sc-xs text-(--sc-text-muted)"
												data-schedule-run-worktree
												title={run.worktree}
											>
												{t("schedules.allRuns.worktree", { name: basename(run.worktree) || run.worktree })}
											</div>
										)}
									</td>
									<td className={cx(CELL, "max-w-[12rem] truncate text-(--sc-text-muted)")}>
										{run.trigger === "schedule"
											? schedule
												? frequencySummary(schedule.frequency)
												: "—"
											: t(`schedules.trigger.${run.trigger}`)}
									</td>
									<td className={CELL}>
										<Badge variant={RUN_STATUS_BADGE[run.status]}>
											{t(`schedules.status.${run.status}`)}
										</Badge>
									</td>
									<td
										className={cx(CELL, "whitespace-nowrap text-(--sc-text-muted)")}
										title={formatClock(run.startedAt)}
									>
										{formatTimeAgo(run.startedAt)}
									</td>
									<td className={cx(CELL, "whitespace-nowrap tabular-nums text-(--sc-text-muted)")}>
										{duration ?? "—"}
									</td>
									<td className={cx(CELL, "whitespace-nowrap tabular-nums text-(--sc-text-muted)")}>
										{run.usage ? runUsageText(run.usage) : "—"}
									</td>
									<td className={cx(CELL, "whitespace-nowrap")}>
										<div className="flex items-center justify-end gap-0.5">
											{run.status !== "skipped" && (
												<IconButton
													aria-expanded={open}
													icon={<Chevron />}
													label={open ? t("schedules.hideLog") : t("schedules.allRuns.viewLog")}
													onClick={() => onToggleLog(run.id)}
													size="sm"
												/>
											)}
											{run.session && (
												<IconButton
													data-schedule-open-session
													icon={<MessageSquare />}
													label={t("schedules.allRuns.openSession")}
													onClick={() => onOpenSession(run)}
													size="sm"
												/>
											)}
											{schedule && (
												<IconButton
													icon={<Play />}
													label={t("schedules.allRuns.runAgain", { name })}
													onClick={() => onRunAgain(schedule.id)}
													size="sm"
												/>
											)}
										</div>
									</td>
								</tr>
								{open && (
									<tr>
										<td className="px-2 pt-1" colSpan={7}>
											<RunLog device={device} run={run} />
										</td>
									</tr>
								)}
							</Fragment>
						);
					})}
				</tbody>
			</table>
		</Card>
	);
}
