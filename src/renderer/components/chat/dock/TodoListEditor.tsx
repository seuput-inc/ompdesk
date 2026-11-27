import { AlertTriangle, X } from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TodoPhase } from "../../../../shared/rpc-types";
import { refreshSessionState } from "../../../hooks/session-hydration";
import { lazyChunk } from "../../../lib/chunk-load";
import { useT } from "../../../lib/i18n";
import { type OptimisticTarget, optimisticWrite } from "../../../lib/optimistic";
import { useTabRpc } from "../../../lib/tab-rpc";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { toastError } from "../../../stores/toast";
import { type TodoStore, type UiTodoPhase, type UiTodoTask, useTodoStore } from "../../../stores/todo";
import { Collapse, DisclosureButton, IconButton } from "../../common";
import type { DockModel } from "./dock-summary";
import { TodoStatusIcon } from "./TodoStatusIcon";
import { useWorkspaceDockFocus } from "./WorkspaceDockFocus";

function todoPayload(phases: UiTodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })),
	}));
}

const TodoSortableList = lazyChunk(() => import("./TodoSortableList").then(m => ({ default: m.TodoSortableList })));

export function TodoListEditor({ model }: { model: DockModel }) {
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const todoStore = sessionRuntimeStore<TodoStore>(tabId, "todo") ?? useTodoStore;
	const t = useT();
	const { managed, focusedCard, focusCard } = useWorkspaceDockFocus();
	const phases = useTodoStore(state => state.phases) ?? [];
	const reminderVisible = useTodoStore(state => state.reminderVisible) ?? false;
	const reminderTodos = useTodoStore(state => state.reminderTodos) ?? [];
	const clearReminder = useTodoStore(state => state.clearReminder);
	const setPhases = useTodoStore(state => state.setPhases);

	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [showClosed, setShowClosed] = useState(false);
	const previousActive = useRef(model.active);
	const [justFinished, setJustFinished] = useState<UiTodoTask>();
	useEffect(() => {
		const previous = previousActive.current;
		previousActive.current = model.active;
		if (
			previous &&
			previous.id !== model.active?.id &&
			model.closed.some(phase =>
				phase.tasks.some(
					task => task.id === previous.id && task.content === previous.content && task.status === "completed",
				),
			)
		)
			setJustFinished(previous);
	}, [model.active, model.closed]);
	useEffect(() => {
		if (!justFinished) return;
		const timer = setTimeout(() => setJustFinished(undefined), 2400);
		return () => clearTimeout(timer);
	}, [justFinished]);

	/* Edits go through setPhases, which archives each change as a transcript
	   snapshot — so both the optimistic value and its rollback go through it
	   instead of assigning `phases` behind the archive's back. */
	const writes = useMemo<OptimisticTarget<TodoStore>>(
		() => ({
			getState: () => todoStore.getState(),
			setState: partial => {
				if (partial.phases) setPhases(partial.phases);
				else todoStore.setState(partial);
			},
		}),
		[setPhases, todoStore],
	);

	const applyPhases = useCallback(
		(next: UiTodoPhase[]) => {
			void optimisticWrite({
				store: writes,
				mutate: () => ({ phases: next }),
				persist: () => rpc.setTodos(todoPayload(next)),
				onFailure: failure => toastError({ title: t("todoPanel.updateFailed"), error: failure }),
				// The rollback went through setPhases, which read it as a change just made: the session says when the
				// list really changed last.
				resync: () => refreshSessionState(tabId ?? undefined),
			});
		},
		[rpc, t, tabId, writes],
	);

	const patchTask = useCallback(
		(phaseId: string, taskId: string, patch: Partial<UiTodoTask>) => {
			applyPhases(
				phases.map(phase =>
					phase.id !== phaseId
						? phase
						: { ...phase, tasks: phase.tasks.map(task => (task.id === taskId ? { ...task, ...patch } : task)) },
				),
			);
		},
		[phases, applyPhases],
	);

	const togglePhase = useCallback((id: string) => {
		setCollapsed(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const closedLabel = [
		model.done > 0 && t("workTree.finished", { count: model.done }),
		model.abandoned > 0 && t("dock.todo.closed", { count: model.abandoned }),
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<>
			{reminderVisible && (
				<div className="mb-1.5 flex items-center gap-2 rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-warning-soft) py-1 pr-1 pl-2.5">
					<AlertTriangle aria-hidden="true" className="shrink-0 text-(--sc-warning)" size={14} />
					<div className="min-w-0 flex-1 text-sc-sm leading-snug text-(--sc-text)">
						<span className="font-medium">{t("todoPanel.reminder")}</span>
						<span className="text-(--sc-text-muted)">
							{` — ${t("todoPanel.reminderCount", { count: reminderTodos.length })}`}
						</span>
					</div>
					<IconButton icon={<X />} label={t("todoPanel.dismissReminder")} onClick={clearReminder} size="sm" />
				</div>
			)}
			{/* Lazy-chunk fallback: the header and summary already show; rows follow in a frame. */}
			<Suspense fallback={null}>
				<TodoSortableList
					collapsed={collapsed}
					model={model}
					onPatch={patchTask}
					onReorder={applyPhases}
					onToggle={togglePhase}
					phases={phases}
				/>
				{!showClosed &&
					justFinished &&
					model.closed.some(phase =>
						phase.tasks.some(
							task =>
								task.id === justFinished.id &&
								task.content === justFinished.content &&
								task.status === "completed",
						),
					) && (
						<div className="flex items-center gap-2 px-2 py-1 text-sc-sm text-(--sc-text-muted)">
							<TodoStatusIcon status="completed" />
							<span className="truncate">{justFinished.content}</span>
						</div>
					)}
				{model.closed.length > 0 && (
					<>
						<DisclosureButton
							className="px-1.5 py-1 text-sc-sm text-(--sc-text-secondary)"
							onToggle={() => {
								if (!showClosed && managed && focusedCard !== "todo") focusCard("todo");
								setShowClosed(!showClosed);
							}}
							open={showClosed}
						>
							{closedLabel}
						</DisclosureButton>
						<Collapse open={showClosed}>
							<TodoSortableList closed model={model} onPatch={patchTask} phases={phases} />
						</Collapse>
					</>
				)}
			</Suspense>
		</>
	);
}
