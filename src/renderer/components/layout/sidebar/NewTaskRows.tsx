/**
 * The rows of new tasks being made (`stores/new-tasks.ts`): in the sidebar group of the project they are cut from, or
 * at the top of the list when no group shows that project yet; a task on a paired computer in that computer's section.
 * A running task says the step it is on and how long the task has taken; a failed one says why, with Retry and Close.
 * Orca FB17 (`rows/PendingWorktreeRow.tsx:40-113`, MIT).
 */
import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { errorDetail } from "../../../lib/error-detail";
import { formatBytes, formatElapsed } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { dismissNewTask, type NewTask, retryNewTask, useNewTasksStore } from "../../../stores/new-tasks";
import { IconButton, ListRow, Spinner } from "../../common";

/** Ticks once a second while something runs (Orca `worktree-creation-clock.ts:4-15`). */
function useNow(running: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);
	return now;
}

function NewTaskRow({ task }: { task: NewTask }) {
	const t = useT();
	const failed = task.status === "failed";
	const now = useNow(!failed);
	const step = task.steps.find(entry => entry.state === "running" || entry.state === "failed");
	const done = task.steps.filter(entry => entry.state === "done").length;
	const wait = task.wait;
	let where = step ? t(`newTask.step.${step.id}`) : "";
	if (wait?.reason === "disk")
		where = t("newTask.wait.disk", { free: formatBytes(wait.free), need: formatBytes(wait.need) });
	else if (wait?.reason === "queue") where = t("newTask.wait.queue", { ahead: wait.ahead });
	else if (wait) where = t(`newTask.wait.${wait.reason}`);
	const title = task.name ?? (task.request.prompt.trim().split("\n")[0] || t("worktree.title"));
	const elapsed = formatElapsed(now - task.startedAt);
	// The headline only says the task did not start; the line names what refused it, the tooltip both.
	const headline = task.error?.message ?? t("newTask.failed");
	const reason = errorDetail(task.error?.cause) || headline;
	return (
		<ListRow
			accessibleName="row"
			actionCount={failed ? 2 : 1}
			actions={
				<>
					{failed && (
						<IconButton
							data-new-task-retry
							icon={<RotateCcw />}
							label={t("common.retry")}
							onClick={() => retryNewTask(task.id)}
							size="sm"
						/>
					)}
					<IconButton
						data-new-task-close
						disabled={!failed}
						disabledReason={t("newTask.closeWhileRunning")}
						icon={<X />}
						label={t("common.close")}
						onClick={() => dismissNewTask(task.id)}
						size="sm"
					/>
				</>
			}
			actionsAtRest={failed}
			description={
				failed ? reason : t("newTask.progress", { step: where, n: done + 1, total: task.steps.length, elapsed })
			}
			leading={failed ? <AlertTriangle className="size-3.5 text-(--sc-danger)" /> : <Spinner size="sm" spin />}
			rowProps={{
				"data-new-task": task.id,
				"data-new-task-state": task.status,
				...(failed && reason !== headline ? { title: `${headline}\n${reason}` } : {}),
			}}
			size="sm"
			title={title}
		/>
	);
}
/**
 * The tasks on `device` (absent: this computer) cut from `cwd`, or with `except`, those whose project is none of those
 * folders. This computer's list (`except`, no `device`) also lists a paired computer's tasks when `sections` (the
 * paired computers the sidebar draws a section for) lacks it, so a task on an unpaired computer can still be closed.
 */
export function NewTaskRows({
	device,
	cwd,
	except,
	sections,
}: {
	device?: string;
	cwd?: string;
	except?: readonly string[];
	sections?: readonly string[];
}) {
	const tasks = useNewTasksStore(state => state.tasks);
	const shown = Object.values(tasks).filter(task =>
		task.request.device === device
			? cwd !== undefined
				? task.request.baseCwd === cwd
				: !except?.includes(task.request.baseCwd)
			: device === undefined && sections !== undefined && !sections.includes(task.request.device ?? ""),
	);
	if (shown.length === 0) return null;
	return (
		<div className="space-y-px" data-new-tasks={cwd ?? "other"}>
			{shown.map(task => (
				<NewTaskRow key={task.id} task={task} />
			))}
		</div>
	);
}
