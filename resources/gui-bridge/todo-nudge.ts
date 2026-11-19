/**
 * The agent's reminder of a todo list behind the work (rules and text: todo-drift-core.ts `todoNudge`,
 * `todoNudgeText`; the reading: todo-drift.ts). After a main-agent tool call, an instruction since the list's last
 * change is named once, after the first call that follows it, and a list unchanged for `DRIFT_CALLS` calls is named
 * with backoff. Stock's public `tool_result` hook with `additionalContext` (as todo-compact.ts): the line rides the
 * next request of the same run and stock journals it, which is how the rule knows it was given.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { guard } from "./health";
import { driftOf, readsTodo } from "./todo-drift";
import { todoNudge, todoNudgeText } from "./todo-drift-core";

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName === "todo") return undefined;
		const branch = ctx.sessionManager.getBranch();
		if (!readsTodo(pi, ctx.agent.kind, branch)) return undefined;
		const drift = driftOf(branch, [{ kind: "call", at: Date.now() }]);
		const kind = drift && todoNudge(drift);
		if (!drift || !kind) return undefined;
		pi.logger.debug("gui-bridge: todo list behind the work named", { kind, calls: drift.callsSince });
		return { additionalContext: todoNudgeText(kind, drift) };
	});
}

/** Hook only; `capabilities` reports the feature when an internal it needs is gone. */
export const methods = guard("todoNudge", {});
