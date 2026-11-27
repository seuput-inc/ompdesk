/**
 * The todo dock card's task list: phase sections with drag reorder (@dnd-kit),
 * status cycling and inline edit. Split from TodoDockCard so @dnd-kit loads
 * with the first todo list instead of at app startup — TodoDockCard imports
 * this module lazily.
 */

import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { AlertCircle, Check, GripVertical, Pencil, X, XCircle } from "lucide-react";
import { memo, useCallback, useState } from "react";
import type { TodoTask } from "../../../../shared/rpc-types";
import { formatElapsed } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { onEscape } from "../../../lib/keymap";
import { useNowTick } from "../../../lib/now-tick";
import type { UiTodoPhase, UiTodoTask } from "../../../stores/todo";
import {
	anchorFromEvent,
	Collapse,
	ContextMenu,
	type ContextMenuAnchor,
	type ContextMenuItem,
	DisclosureButton,
	IconButton,
	SectionLabel,
	StatusDot,
} from "../../common";
import { type DockModel, reorderOpenTasks } from "./dock-summary";
import { TODO_STATUS_LABEL_KEY, TodoStatusIcon } from "./TodoStatusIcon";

/**
 * Blocked and abandoned are verdicts about a task, not steps on the way to done,
 * so they stay out of the click loop: one click on a finished task used to claim
 * it was stuck, which the agent then re-planned around. They are set from the
 * row's context menu, and a click on such a task returns it to pending.
 */
const STATUS_CYCLE: TodoTask["status"][] = ["pending", "in_progress", "completed"];

function nextStatus(current: TodoTask["status"]): TodoTask["status"] {
	return STATUS_CYCLE[(STATUS_CYCLE.indexOf(current) + 1) % STATUS_CYCLE.length] ?? "pending";
}
interface SortableTaskRowProps {
	task: UiTodoTask;
	phaseId: string;
	onPatch: (phaseId: string, taskId: string, patch: Partial<UiTodoTask>) => void;
}

const SortableTaskRow = memo(function SortableTaskRow({ task, phaseId, onPatch }: SortableTaskRowProps) {
	const t = useT();
	const movable = task.status === "pending" || task.status === "blocked";
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: task.id,
		disabled: !movable,
	});
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(task.content);
	const [statusMenu, setStatusMenu] = useState<ContextMenuAnchor>();
	const statusItems: ContextMenuItem[] = [
		{
			id: "blocked",
			icon: AlertCircle,
			label: t("todoPanel.markBlocked"),
			onSelect: () => {
				setStatusMenu(undefined);
				onPatch(phaseId, task.id, { status: "blocked" });
			},
		},
		{
			danger: true,
			id: "abandoned",
			icon: XCircle,
			label: t("todoPanel.markAbandoned"),
			onSelect: () => {
				setStatusMenu(undefined);
				onPatch(phaseId, task.id, { status: "abandoned" });
			},
		},
	];
	const commit = () => {
		const content = draft.trim();
		setEditing(false);
		if (content && content !== task.content) onPatch(phaseId, task.id, { content });
		else setDraft(task.content);
	};

	return (
		<div
			className={`group flex min-h-8 items-center gap-2 rounded-(--sc-radius-md) py-0.5 pr-1 pl-0.5 text-sc-md transition-colors ${
				isDragging ? "z-10 bg-(--sc-selected) shadow-(--sc-shadow-md)" : "hover:bg-(--sc-hover)"
			}`}
			ref={setNodeRef}
			style={{
				transform: transform
					? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`
					: undefined,
				transition,
			}}
		>
			{movable && (
				<IconButton
					className="cursor-grab opacity-0 group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing [@media(hover:none)]:opacity-100"
					icon={<GripVertical />}
					size="sm"
					tooltip={false}
					{...attributes}
					{...listeners}
					label={t("todoPanel.reorder")}
				/>
			)}
			<IconButton
				className="rounded-(--sc-radius-full)"
				icon={<TodoStatusIcon status={task.status} />}
				label={t("todoPanel.statusAria", {
					status: t(TODO_STATUS_LABEL_KEY[task.status] ?? "todoPanel.status.pending"),
				})}
				onClick={() => onPatch(phaseId, task.id, { status: nextStatus(task.status) })}
				onContextMenu={event => setStatusMenu(anchorFromEvent(event))}
				size="sm"
			/>
			{task.status === "in_progress" && (
				<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">{t("todoPanel.status.inProgress")}</span>
			)}
			{statusMenu && (
				<ContextMenu
					items={statusItems}
					onClose={() => setStatusMenu(undefined)}
					x={statusMenu.x}
					y={statusMenu.y}
				/>
			)}
			{editing ? (
				<span className="flex min-w-0 flex-1 items-center gap-1">
					<input
						aria-label={t("todoPanel.edit")}
						autoFocus
						className="w-full min-w-0 rounded-(--sc-radius-sm) border border-(--sc-accent) bg-(--sc-field) px-1.5 py-0.5 text-sc-md text-(--sc-text) focus:outline-none"
						onBlur={commit}
						onChange={event => setDraft(event.target.value)}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							if (event.key === "Enter") commit();
							onEscape(event, () => {
								setDraft(task.content);
								setEditing(false);
							});
						}}
						value={draft}
					/>
					<IconButton icon={<Check />} label={t("common.save")} onClick={commit} size="sm" />
					<IconButton
						icon={<X />}
						label={t("common.cancel")}
						onClick={() => {
							setDraft(task.content);
							setEditing(false);
						}}
						size="sm"
					/>
				</span>
			) : (
				<>
					<span
						className={`min-w-0 flex-1 truncate ${
							task.status === "abandoned"
								? "text-(--sc-text-subtle) line-through"
								: task.status === "completed"
									? "text-(--sc-text-muted)"
									: "text-(--sc-text)"
						}`}
						onDoubleClick={() => {
							setDraft(task.content);
							setEditing(true);
						}}
						title={task.content}
					>
						{task.content}
					</span>
					<IconButton
						className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
						icon={<Pencil />}
						label={t("todoPanel.edit")}
						onClick={() => {
							setDraft(task.content);
							setEditing(true);
						}}
						size="sm"
					/>
				</>
			)}
		</div>
	);
});

function Elapsed({ start }: { start: number }) {
	const now = useNowTick(true);
	return <span className="shrink-0 tabular-nums">{formatElapsed(Math.max(0, now - start))}</span>;
}

function RunningRows({ model }: { model: DockModel }) {
	const t = useT();
	if (!model.runners.length) return null;
	return (
		<ul aria-label={t("todoPanel.status.inProgress")} className="mb-1 ps-2">
			{model.runners.map(runner => {
				return (
					<li
						className="py-1 text-sc-sm"
						data-dock-runner={runner.id}
						data-task-id={runner.taskId}
						key={runner.id}
					>
						<div className="flex min-w-0 items-center gap-2">
							<StatusDot label={t("todoPanel.status.inProgress")} tone="working" />
							<span className="min-w-0 flex-1 truncate font-medium">{runner.title}</span>
							{runner.startedAt !== undefined && <Elapsed start={runner.startedAt} />}
						</div>
						{(runner.taskTitle || runner.step) && (
							<div className="ps-3.5 text-(--sc-text-muted)">
								{[runner.taskTitle && `${t("dock.todo")}: ${runner.taskTitle}`, runner.step]
									.filter(Boolean)
									.join(" · ")}
							</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}

export function TodoSortableList({
	phases,
	model,
	closed = false,
	collapsed,
	onToggle,
	onPatch,
	onReorder,
}: {
	phases: UiTodoPhase[];
	model: DockModel;
	closed?: boolean;
	collapsed?: ReadonlySet<string>;
	onToggle?: (phaseId: string) => void;
	onPatch: SortableTaskRowProps["onPatch"];
	onReorder?: (next: UiTodoPhase[]) => void;
}) {
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const onDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			const phase = phases.find(p => p.tasks.some(task => task.id === active.id));
			if (!phase) return;
			const tasks = reorderOpenTasks(phase.tasks, String(active.id), String(over.id));
			if (tasks !== phase.tasks) onReorder?.(phases.map(p => (p === phase ? { ...p, tasks } : p)));
		},
		[phases, onReorder],
	);

	const t = useT();
	if (closed)
		return model.closed.map(phase => (
			<section className="mb-1.5 ps-2" key={phase.id}>
				<SectionLabel>{phase.name}</SectionLabel>
				{phase.tasks.map(task => (
					<SortableTaskRow key={task.id} onPatch={onPatch} phaseId={phase.id} task={task} />
				))}
			</section>
		));

	return (
		<DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd} sensors={sensors}>
			{!model.active && <RunningRows model={model} />}
			{model.phases.map(phase => {
				const count = model.phaseCounts.get(phase.id)!;
				const pinned = model.active && phase.tasks[0] === model.active ? model.active : undefined;
				const rest = pinned ? phase.tasks.slice(1) : phase.tasks;
				const open = !collapsed?.has(phase.id);
				const label = (
					<>
						<span className="min-w-0 flex-1 truncate">{phase.name}</span>
						<span className="shrink-0 text-sc-xs tabular-nums">
							{count.done}/{count.total}
						</span>
					</>
				);
				return (
					<section className="mb-1.5" key={phase.id}>
						{rest.length ? (
							<DisclosureButton
								className="gap-1.5 px-1.5 py-1 text-sc-sm text-(--sc-text-secondary)"
								onToggle={() => onToggle?.(phase.id)}
								open={open}
							>
								{label}
							</DisclosureButton>
						) : (
							<div className="flex items-center gap-1.5 px-1.5 py-1 text-sc-sm text-(--sc-text-secondary)">
								{label}
							</div>
						)}
						{pinned && (
							<>
								<SortableTaskRow onPatch={onPatch} phaseId={phase.id} task={pinned} />
								{(model.step || model.startedAt !== undefined) && (
									<div className="mb-1 flex items-baseline gap-2 ps-2 text-sc-sm text-(--sc-text-muted)">
										<span className="shrink-0">{t("dock.todo.turn")}</span>
										{model.step && (
											<span className="min-w-0 flex-1 truncate" title={model.step}>
												{model.step}
											</span>
										)}
										{model.startedAt !== undefined && <Elapsed start={model.startedAt} />}
									</div>
								)}
								<RunningRows model={model} />
							</>
						)}
						{rest.length > 0 && (
							<Collapse open={open}>
								<SortableContext items={rest.map(task => task.id)} strategy={verticalListSortingStrategy}>
									<div className="ms-2 border-s border-(--sc-border-subtle) ps-2">
										{rest.map(task => (
											<SortableTaskRow key={task.id} onPatch={onPatch} phaseId={phase.id} task={task} />
										))}
									</div>
								</SortableContext>
							</Collapse>
						)}
					</section>
				);
			})}
		</DndContext>
	);
}
