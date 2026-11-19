/** What the GUI reads of a todo list behind the work (rules: todo-drift-core.ts; wiring: todo-drift.ts). */

/** get_state `todoDrift` and the `todo_drift` frame: when the list last changed, and why it is behind the work. */
export interface TodoDriftState {
	/** Epoch ms of the list's last change (an agent's todo call or a person's edit); null without a list. */
	changedAt: number | null;
	/**
	 * The panel's warning. `drift`: a long run of tool calls or active time without a change (old, whatever came);
	 * `instruction`: `RECEIVED_WARN` or more instructions piled up after that change and the agent worked on. Null for
	 * one or two fresh ones: the panel lists them as news, since the reading never knows whether the list covers them.
	 */
	stale: "instruction" | "drift" | null;
	/**
	 * The instructions received since that change (a person's message or an opening agent's, at a turn's start or
	 * steered in), newest last, by first line: the newest `RECEIVED_SHOWN` of `receivedCount`. Recorded by the bridge
	 * whatever the agent does with its list; empty again once the list changes.
	 */
	received: Array<{ at: number; text: string }>;
	receivedCount: number;
}

/** The frame the bridge pushes when `TodoDriftState` changes; it carries `state`. */
export const TODO_DRIFT_EVENT = "todo_drift";

/** The custom entry the bridge journals once per session it reads (scripts/todo-truth-stats.ts: before or after). */
export const TODO_DRIFT_MARKER = "ompdesk.todo-drift";
