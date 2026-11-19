/** What the GUI reads of a todo list behind the work (rules: todo-drift-core.ts; wiring: todo-drift.ts). */

/** get_state `todoDrift` and the `todo_drift` frame: when the list last changed, and why it is behind the work. */
export interface TodoDriftState {
	/** Epoch ms of the list's last change (an agent's todo call or a person's edit); null without a list. */
	changedAt: number | null;
	/** `instruction`: a new instruction came after that change and the agent worked on; `drift`: a long run of tool calls or active time without a change. */
	stale: "instruction" | "drift" | null;
}

/** The frame the bridge pushes when `TodoDriftState` changes; it carries `state`. */
export const TODO_DRIFT_EVENT = "todo_drift";
