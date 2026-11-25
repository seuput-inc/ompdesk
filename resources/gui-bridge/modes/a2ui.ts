/**
 * A2UI (docs/design/a2ui.md): the `a2ui` tool. The main agent sends A2UI v1.0 messages; they are checked here
 * (a2ui-core.ts) and drawn by the renderer from the tool call itself. A surface with an event button waits for the
 * person through stock's blocking form channel (`ctx.ui.formDialog` with the marker form of a2ui-contracts.ts), so the
 * question's attention, notification, first-answer rule, paired relay and phone are the ask form's.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { guard } from "../health";
import { validateJsonSchemaValue } from "../omp/pi-ai";
import { A2UI_ANSWER_FIELD, A2UI_TOOL, type A2uiToolDetails, a2uiMarkerForm } from "./a2ui-contracts";
import { a2uiAnswer, a2uiErrorText, a2uiPriorCalls, a2uiToolDescription, checkA2uiCall } from "./a2ui-core";

function result(text: string, details: A2uiToolDetails, isError = false) {
	return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	const z = pi.pi.z;
	pi.registerTool({
		name: A2UI_TOOL,
		label: "A2UI",
		description: a2uiToolDescription(),
		parameters: z.object({
			messages: z.array(z.record(z.string(), z.unknown())).describe("A2UI v1.0 messages, applied in order"),
		}),
		// Only the main agent's transcript has a person looking at it: activated for it below, never for a subagent.
		defaultInactive: true,
		loadMode: "essential",
		approval: "read",
		async execute(
			toolCallId: string,
			params: { messages?: unknown },
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			if (ctx.agent.kind !== "main") throw new Error("Only the main agent shows surfaces to the person.");
			const check = checkA2uiCall(
				params.messages,
				a2uiPriorCalls(ctx.sessionManager.getBranch(), A2UI_TOOL, toolCallId),
				validateJsonSchemaValue,
			);
			if (check.errors.length > 0) return result(a2uiErrorText(check.errors), { errors: check.errors }, true);
			if (!check.interactive) {
				return result(`Shown to the person: ${check.touched.join(", ") || "nothing left"}. It needs no answer.`, {
					shown: check.touched,
				});
			}
			if (!ctx.hasUI || typeof ctx.ui.formDialog !== "function") {
				throw new Error("No one can answer here: this session has no OMPdesk window. Ask in text instead.");
			}
			const answer = await ctx.ui.formDialog(a2uiMarkerForm(toolCallId), { signal });
			if (signal?.aborted) throw new Error("Stopped before the person answered.");
			if (!answer) return result("The person dismissed the surface without acting.", { dismissed: true });
			const { text, details } = a2uiAnswer(answer.data[A2UI_ANSWER_FIELD]);
			return result(text, details);
		},
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return undefined;
		const active = pi.getActiveTools();
		if (!active.includes(A2UI_TOOL)) await pi.setActiveTools([...active, A2UI_TOOL]);
		return undefined;
	});
}

/** Tool and hook only. */
export const methods = guard("a2ui", {});
