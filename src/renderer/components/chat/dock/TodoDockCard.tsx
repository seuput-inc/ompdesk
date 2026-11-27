/** The dock's disclosure and its expanded header use the same session counts. */

import { ListTodo } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useT } from "../../../lib/i18n";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { selectTodoCardVisible, useTodoStore } from "../../../stores/todo";
import { ProgressBar } from "../../common";
import { DockCard } from "./DockCard";
import { buildDockModel, buildTodoDockPeek } from "./dock-summary";
import { TodoFreshnessMark, TodoReceived, useTodoFreshness } from "./TodoFreshness";
import { TodoListEditor } from "./TodoListEditor";
import { useDockFacts } from "./use-dock-facts";
import { useWorkspaceDockFocus } from "./WorkspaceDockFocus";

export function TodoDockCard({ exiting = false }: { exiting?: boolean }) {
	const t = useT();
	const { focusedCard, clearFocus } = useWorkspaceDockFocus();
	const focused = focusedCard === "todo";
	const phases = useTodoStore(state => state.phases) ?? [];
	const visible = useTodoStore(selectTodoCardVisible);
	const tabId = useRuntimeTabId();
	const facts = useDockFacts(visible && !exiting);
	const model = useMemo(() => buildDockModel(phases, facts), [phases, facts]);
	const peek = buildTodoDockPeek(model);
	const freshness = useTodoFreshness();
	const dockFreshness =
		freshness?.level === "warning"
			? {
					...freshness,
					stale: null,
					level: freshness.receivedCount ? ("info" as const) : null,
					reason: null,
					summary: freshness.receivedCount ? freshness.summary : null,
					title: [
						freshness.receivedHeader,
						freshness.receivedHeader && t("todoPanel.receivedNote"),
						freshness.updated,
					]
						.filter(Boolean)
						.join("\n"),
				}
			: freshness;

	useEffect(() => {
		if (focused && !visible) clearFocus();
	}, [clearFocus, focused, visible]);

	if (!visible && !exiting) return null;

	const progress = peek.total > 0 && (
		<ProgressBar
			ariaLabel={t("dock.todo")}
			ariaValueText={`${peek.done}/${peek.total}`}
			className="w-24 shrink-0"
			height={4}
			tone="progress"
			value={peek.done / peek.total}
			valueText={`${peek.done}/${peek.total}`}
		/>
	);
	return (
		<DockCard
			exiting={exiting}
			icon={ListTodo}
			badge={progress}
			id="todo"
			peek={
				peek.total > 0 ? (
					<>
						{progress}
						{peek.current && (
							<span className="min-w-0 truncate text-(--sc-text-secondary)" title={peek.current.content}>
								{peek.current.status === "in_progress"
									? model.lines.find(line => line.kind === "active")?.text
									: t("dock.todo.next", { task: peek.current.content })}
							</span>
						)}
						<TodoFreshnessMark className="ms-auto" freshness={dockFreshness} />
					</>
				) : undefined
			}
			title={t("dock.todo")}
		>
			<div className="px-2 py-1.5">
				<TodoFreshnessMark className="mb-1 px-1 text-sc-xs text-(--sc-text-subtle)" freshness={dockFreshness} />
				<TodoReceived freshness={dockFreshness} list />
				<TodoListEditor key={tabId} model={model} />
			</div>
		</DockCard>
	);
}
