/**
 * The waste guards' `wait` (waste-guards.ts), registered by index.ts's factory on every bind, before stock builds the
 * session: a built-in re-registered on a live session moves to the end of omp 19.2's tool order and rebuilds the prompt,
 * so a turn whose prompt came before the bridge's first use listed the tools in another order than every later turn.
 */
import type { AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { WAIT_DESCRIPTION, waitWindowElapsed } from "./waste-guards-core";

/**
 * Stock's `wait` returns after a window (5 s up to 300 s) while every job it watches still runs, and the model is
 * asked again only to wait again. This `wait` calls stock's until it returns anything else: a job settled, a service
 * ended, a message or reply came, nothing was left to wait on, or the call was interrupted; stock keeps its own ladder,
 * delivery and interrupt handling. No limit of its own: the job's own timeout, a message (the tool is interruptible,
 * as stock's is) and the user's stop end it.
 */
export function registerWait(pi: ExtensionAPI): void {
	const definition = {
		name: "wait",
		label: "Wait",
		description: WAIT_DESCRIPTION,
		parameters: pi.pi.z.object({}),
		strict: true,
		loadMode: "essential" as const,
		approval: "read" as const,
		// Not in `ToolDefinition`'s type; stock's adapter passes every key of the definition to the loop's tool, and
		// without them a queued message would no longer cut the wait short.
		interruptible: true,
		handlesToolInterrupt: true,
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult> {
			const native = ctx.invokeTool;
			if (!native) throw new Error("This omp cannot run its own wait for OMPdesk (no ctx.invokeTool)");
			for (;;) {
				const result = await native(params, { signal, onUpdate });
				if (!waitWindowElapsed(result)) return result;
			}
		},
	};
	pi.registerTool(definition);
}
