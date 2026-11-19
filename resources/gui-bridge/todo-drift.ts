/**
 * A todo list that stopped following the work (rules and text: todo-drift-core.ts). After each tool call of the main
 * agent the bridge reads the journal from the list's last change: a new instruction since then (a steer included) is
 * named once after the first call that follows it, and a list unchanged for `DRIFT_CALLS` calls is named with
 * backoff. Stock's public `tool_result` hook with `additionalContext` (as todo-compact.ts): the line rides the next
 * request of the same run and stock journals it, which is how the rule knows it was given. The same reading goes to
 * the GUI as `TodoDriftState` (get_state `todoDrift` through `todoDrift.state`, and the `todo_drift` frame when it
 * changes), so the panel says when the list last changed and marks one behind the work even when the agent ignores
 * the reminder.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { guard } from "./health";
import { autopilotRunning } from "./modes/autopilot-core";
import { emit } from "./modes/shared";
import { getLatestTodoPhasesFromEntries, getLatestTodoSnapshotIdentity } from "./omp/pi-coding-agent/tools/todo";
import { TODO_DRIFT_EVENT, type TodoDriftState } from "./todo-drift-contracts";
import {
	journalDriftEvents,
	type TodoDrift,
	type TodoDriftEntry,
	type TodoDriftEvent,
	todoCallInFlight,
	todoDrift,
	todoDriftState,
	todoNudge,
	todoNudgeText,
} from "./todo-drift-core";

type Branch = Parameters<typeof getLatestTodoSnapshotIdentity>[0];

/** The drift the journal shows, plus `extra` steps not journaled yet; undefined without a list. */
function driftOf(branch: Branch, extra: readonly TodoDriftEvent[] = []): TodoDrift | undefined {
	const snapshot = getLatestTodoSnapshotIdentity(branch);
	const listAt = snapshot ? branch.findIndex(entry => entry.id === snapshot.sourceEntryId) : -1;
	if (listAt < 0) return undefined;
	const events = journalDriftEvents(branch as TodoDriftEntry[], listAt, getLatestTodoPhasesFromEntries(branch));
	return todoDrift([...events, ...extra]);
}

const NO_LIST: TodoDriftState = { changedAt: null, stale: null };
let sent: TodoDriftState | undefined;

function push(state: TodoDriftState): void {
	if (sent && sent.changedAt === state.changedAt && sent.stale === state.stale) return;
	sent = state;
	emit({ type: TODO_DRIFT_EVENT, state });
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	pi.on("tool_result", (event, ctx) => {
		if (ctx.agent.kind !== "main") return undefined;
		const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
		if (!session?.getActiveToolNames().includes("todo") || session.getPlanModeState()?.enabled) return undefined;
		const branch = ctx.sessionManager.getBranch();
		if (autopilotRunning(branch)) return undefined;
		if (event.toolName === "todo") {
			const details = event.details as { op?: unknown; phases?: unknown } | undefined;
			// This call's result is not journaled yet: a change starts the count again now.
			if (!event.isError && details?.op !== "view" && Array.isArray(details?.phases))
				push({ changedAt: Date.now(), stale: null });
			return undefined;
		}
		// A todo call in the same batch is changing the list now: no word, and no reading until it lands.
		if (todoCallInFlight(branch as TodoDriftEntry[])) return undefined;
		const drift = driftOf(branch, [{ kind: "call", at: Date.now() }]);
		push(drift ? todoDriftState(drift) : NO_LIST);
		const kind = drift && todoNudge(drift);
		if (!drift || !kind) return undefined;
		pi.logger.debug("gui-bridge: todo list behind the work named", { kind, calls: drift.callsSince });
		return { additionalContext: todoNudgeText(kind, drift) };
	});
}

export const methods = guard("todoDrift", {
	/** The panel's reading for get_state: the journal as it is now. The frame keeps comparing with what it last sent. */
	"todoDrift.state": async (_params, env) => {
		const drift = driftOf(env.session().sessionManager.getBranch());
		return drift ? todoDriftState(drift) : NO_LIST;
	},
});
