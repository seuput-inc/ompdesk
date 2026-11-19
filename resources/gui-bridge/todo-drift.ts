/**
 * The panel's reading of the todo list (rules: todo-drift-core.ts; contract: todo-drift-contracts.ts). After each tool
 * call of the main agent the bridge reads the journal from the list's last change and sends the GUI when that was,
 * whether the list is behind the work and which instructions arrived since (get_state `todoDrift` through
 * `todoDrift.state`, and the `todo_drift` frame when it changes). It never touches the agent's list and says nothing
 * to the agent. The first reading in a session journals `TODO_DRIFT_MARKER`, so scripts/todo-truth-stats.ts tells the
 * sessions that ran this bridge from those that did not.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { guard } from "./health";
import { autopilotRunning } from "./modes/autopilot-core";
import { emit } from "./modes/shared";
import { getLatestTodoPhasesFromEntries, getLatestTodoSnapshotIdentity } from "./omp/pi-coding-agent/tools/todo";
import { TODO_DRIFT_EVENT, TODO_DRIFT_MARKER, type TodoDriftState } from "./todo-drift-contracts";
import {
	journalDriftEvents,
	type TodoDrift,
	type TodoDriftEntry,
	type TodoDriftEvent,
	todoCallInFlight,
	todoDrift,
	todoDriftState,
} from "./todo-drift-core";

type Branch = Parameters<typeof getLatestTodoSnapshotIdentity>[0];

/** The drift the journal shows, plus `extra` steps not journaled yet; undefined without a list. */
export function driftOf(branch: Branch, extra: readonly TodoDriftEvent[] = []): TodoDrift | undefined {
	const snapshot = getLatestTodoSnapshotIdentity(branch);
	const listAt = snapshot ? branch.findIndex(entry => entry.id === snapshot.sourceEntryId) : -1;
	if (listAt < 0) return undefined;
	const events = journalDriftEvents(branch as TodoDriftEntry[], listAt, getLatestTodoPhasesFromEntries(branch));
	return todoDrift([...events, ...extra]);
}

/**
 * Whether a main-agent tool call is one the todo rules read: `todo` active, not Plan mode, not an Autopilot run, and no
 * `todo` call beside it in the same message (that one is changing the list now; its result lands after).
 */
export function readsTodo(pi: ExtensionAPI, kind: string, branch: Branch): boolean {
	if (kind !== "main") return false;
	const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
	if (!session?.getActiveToolNames().includes("todo") || session.getPlanModeState()?.enabled) return false;
	return !autopilotRunning(branch) && !todoCallInFlight(branch as TodoDriftEntry[]);
}

const NO_LIST: TodoDriftState = { changedAt: null, stale: null, received: [], receivedCount: 0 };
let sent: TodoDriftState | undefined;
const marked = new Set<string>();

function push(state: TodoDriftState): void {
	if (
		sent &&
		sent.changedAt === state.changedAt &&
		sent.stale === state.stale &&
		sent.receivedCount === state.receivedCount
	)
		return;
	sent = state;
	emit({ type: TODO_DRIFT_EVENT, state });
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	pi.on("tool_result", (event, ctx) => {
		// A todo call's own reading comes with the next call: its result is journaled after this hook, and the GUI
		// marks a changed list fresh as it draws it.
		if (event.toolName === "todo") return undefined;
		const branch = ctx.sessionManager.getBranch();
		if (!readsTodo(pi, ctx.agent.kind, branch)) return undefined;
		const id = ctx.sessionManager.getSessionId();
		if (!marked.has(id)) {
			marked.add(id);
			if (!branch.some(entry => entry.type === "custom" && entry.customType === TODO_DRIFT_MARKER))
				ctx.sessionManager.appendCustomEntry(TODO_DRIFT_MARKER, { version: 1 });
		}
		const drift = driftOf(branch, [{ kind: "call", at: Date.now() }]);
		push(drift ? todoDriftState(drift) : NO_LIST);
		return undefined;
	});
}

export const methods = guard("todoDrift", {
	/** The panel's reading for get_state: the journal as it is now. The frame keeps comparing with what it last sent. */
	"todoDrift.state": async (_params, env) => {
		const drift = driftOf(env.session().sessionManager.getBranch());
		return drift ? todoDriftState(drift) : NO_LIST;
	},
});
