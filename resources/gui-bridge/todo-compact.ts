/** Keep unfinished items in the calling agent's stock todo list. No list is copied into the bridge. */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { guard } from "./health";
import { compactTodoText, isClosedTodo, type TodoCompactPhase, todoCompaction } from "./todo-compact-core";

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	// Stock prepares every tool_call in a response before executing the first. An init needs a settled list.
	const pending = new Map<string, Map<string, boolean>>();
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "todo") return;
		const { op, list } = event.input;
		if (op === "view") return;
		const init = op === "init" || (op === undefined && Array.isArray(list) && list.length > 0);
		const agent = ctx.agent.id;
		const edits = pending.get(agent);
		if (edits) {
			for (const otherInit of edits.values()) {
				if (init || otherInit)
					return {
						block: true,
						reason:
							"Another todo edit has not finished. View the list after it finishes, then append new work by phase.",
					};
			}
		}
		if (init) {
			const phases = pi.pi.AgentRegistry.global().get(agent)?.session?.getTodoPhases?.();
			if (!phases)
				return {
					block: true,
					reason: "Cannot verify this agent's todo list. Use append with a phase instead of init.",
				};
			if (phases.some(phase => phase.tasks.some(task => !isClosedTodo(task.status))))
				return {
					block: true,
					reason:
						"This todo list still has unfinished work. Append new items with a phase. Mark individual tasks done when finished or drop them only when explicitly cancelled.",
				};
		}
		const calls = edits ?? new Map<string, boolean>();
		calls.set(event.toolCallId, init);
		if (!edits) pending.set(agent, calls);
	});
	pi.on("turn_end", (_event, ctx) => {
		pending.delete(ctx.agent.id);
	});
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "todo") return undefined;
		const edits = pending.get(ctx.agent.id);
		if (edits?.delete(event.toolCallId) && edits.size === 0) pending.delete(ctx.agent.id);
		if (event.isError) return undefined;
		const details = event.details as { op?: unknown; phases?: unknown } | undefined;
		if (!Array.isArray(details?.phases)) return undefined;
		const long = todoCompaction(details.op, details.phases as TodoCompactPhase[]);
		if (!long) return undefined;
		pi.logger.debug("gui-bridge: long todo list kept by phase", { ...long });
		return { additionalContext: compactTodoText(long) };
	});
}

/** The compatibility probe checks the session's live todo reader. */
export const methods = guard("todoCompact", {});
