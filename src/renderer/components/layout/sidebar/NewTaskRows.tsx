/**
 * The rows of new tasks being made (`stores/new-tasks.ts`): in the sidebar group of the project they are cut from, or
 * at the top of the list when no group shows that project yet. A running task says the step it is on and how long the
 * task has taken; a failed one says why, with Retry and Close. Orca FB17 (`rows/PendingWorktreeRow.tsx:40-113`, MIT).
 */
import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { formatElapsed } from "../../../lib/format";
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
	const where = step ? t(`newTask.step.${step.id}`) : "";
	const title = task.name ?? (task.request.prompt.trim().split("\n")[0] || t("newTask.untitled"));
	const elapsed = formatElapsed(now - task.startedAt);
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
							label={t("newTask.retry")}
							onClick={() => retryNewTask(task.id)}
							size="sm"
						/>
					)}
					<IconButton
						data-new-task-close
						disabled={!failed}
						disabledReason={t("newTask.closeWhileRunning")}
						icon={<X />}
						label={t("newTask.close")}
						onClick={() => dismissNewTask(task.id)}
						size="sm"
					/>
				</>
			}
			actionsAtRest={failed}
			description={
				failed
					? (task.error?.message ?? t("newTask.failed"))
					: t("newTask.progress", { step: where, n: done + 1, total: task.steps.length, elapsed })
			}
			leading={failed ? <AlertTriangle className="size-3.5 text-(--sc-danger)" /> : <Spinner size="sm" spin />}
			rowProps={{ "data-new-task": task.id, "data-new-task-state": task.status }}
			size="sm"
			title={title}
		/>
	);
}

/** The tasks cut from `cwd`, or with `except`, those whose project is none of those folders. */
export function NewTaskRows({ cwd, except }: { cwd?: string; except?: readonly string[] }) {
	const tasks = useNewTasksStore(state => state.tasks);
	const shown = Object.values(tasks).filter(task =>
		cwd !== undefined
			? task.request.device === undefined && task.request.baseCwd === cwd
			: task.request.device !== undefined || !except?.includes(task.request.baseCwd),
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
