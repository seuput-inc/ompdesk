/**
 * Guards against four measured wastes of agent sessions (rules and text: waste-guards-core.ts, `.omp/rules/waste-guards.md`).
 * A `bash` service start whose `ready.log` cannot match is refused before it runs (stock's public `tool_call` hook,
 * `block`). A poll (sleep then check, `gh run`, `pgrep`, `tail -f`, `read proc://`) and an `edit` the tool refused for
 * anchors or a tag the session never got each get one line, once per kind in this process, appended to the end of the
 * result through the public `tool_result` hook's `content` (stock lets a handler replace the result's content array,
 * a failed call's too; `details` and `isError` stay as they were). `wait` is re-registered (public `registerTool` over a
 * built-in) to call stock's own `wait` (`ctx.invokeTool`) again whenever its window ran out with the jobs still running,
 * so it returns only with news. A `bash` call that pushes or commits past the repository's git hooks (`--no-verify`) is
 * refused too: bypassing them is a person's call (AGENTS.md), and `probe/*` and `refs/archive/*` are the lawful ways.
 * On Windows the first `bash` of each project folder waits until this process holds its connection to stock's service
 * broker, so the first `wait` never makes it while a job runs.
 */
import type { AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { guard } from "./health";
import {
	createHints,
	NO_VERIFY_REASON,
	READY_LOG_REASON,
	readyLogCannotMatch,
	skipsGitHooks,
	WAIT_DESCRIPTION,
	waitWindowElapsed,
} from "./waste-guards-core";

/** One per omp process: the main agent and every subagent rebinding this module share it. */
const hints = createHints();

/**
 * Per project folder, this process's first connection to stock's service broker (Windows only). Stock's `wait` lists
 * the project's services before it blocks (`listServicesTolerant`), and the first list connects the process to the
 * broker. On Windows a shell job that runs while that connection is made never runs another step: its trace stays at
 * its first frame and the `wait` streams it `running` until the job's own timeout. Measured on omp-latest's Windows
 * runner (omp 18.22.0): 8 of 8 jobs stalled when the connection came during the job, 0 of 8 when it came before, and 3
 * of 5 with the broker already started by another omp, so it is the connection, not the broker's start. macOS and
 * Linux never stalled; there the broker is left to start when a service or a `wait` first needs it.
 */
const brokerConnections = new Map<string, Promise<unknown>>();

/**
 * Stock's own `WaitTool` over a session that owns no job, service or agent: it connects the process-wide broker client
 * for `cwd` (stock's `daemonClientForProject`, the one every later `wait` and service call of the folder reuses) and
 * returns "Nothing to wait for". Stock bounds the connection (10 s) and the list request; a failure leaves `wait` to
 * try again, as stock's `wait` tolerates a broker it cannot reach.
 */
function connectBroker(pi: ExtensionAPI, cwd: string): Promise<unknown> {
	let connection = brokerConnections.get(cwd);
	if (!connection) {
		const session = { cwd, settings: pi.pi.Settings.instance } satisfies Partial<ToolSession>;
		connection = new pi.pi.WaitTool(session as ToolSession).execute("ompdesk-broker", {}).catch(() => undefined);
		brokerConnections.set(cwd, connection);
	}
	return connection;
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	registerWait(pi);
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		if (skipsGitHooks(event.input)) {
			pi.logger.debug("gui-bridge: a git push or commit past the hooks refused");
			return { block: true, reason: NO_VERIFY_REASON };
		}
		if (readyLogCannotMatch(event.input)) {
			pi.logger.debug("gui-bridge: bash with a ready.log that cannot match refused");
			return { block: true, reason: READY_LOG_REASON };
		}
		if (process.platform === "win32") await connectBroker(pi, ctx.cwd);
		return undefined;
	});
	pi.on("tool_result", event => {
		const text = event.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
		const hint = hints.note(event.toolName, event.input, { isError: event.isError, text });
		return hint === undefined ? undefined : { content: [...event.content, { type: "text", text: `\n${hint}` }] };
	});
}

/**
 * Stock's `wait` returns after a window (5 s up to 300 s) while every job it watches still runs, and the model is
 * asked again only to wait again. This `wait` calls stock's until it returns anything else: a job settled, a service
 * ended, a message or reply came, nothing was left to wait on, or the call was interrupted; stock keeps its own ladder,
 * delivery and interrupt handling. No limit of its own: the job's own timeout, a message (the tool is interruptible,
 * as stock's is) and the user's stop end it.
 */
function registerWait(pi: ExtensionAPI): void {
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

/** Hooks, a re-registered built-in, and stock's `WaitTool` from the package index (capabilities.ts `wasteGuards`). */
export const methods = guard("wasteGuards", {});
