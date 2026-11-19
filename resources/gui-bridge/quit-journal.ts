/**
 * A stop never cuts a short command and a relaunch never runs one twice (rules: `.omp/rules/interrupted-work.md` ›
 * Quit during a tool, › A command runs once).
 *
 * Stock's dispose records `session_exit` (with the unfinished calls), emits `session_shutdown`, and only then aborts
 * the agent loop; the aborted call's result is journaled by the unwinding loop while the exit already runs. Each
 * `tool_result` handler on the way costs that unwind a few turns of the event loop (stock awaits the handler runner
 * once any extension subscribes, whatever the handler returns), and from the second subscriber on the exit won in
 * every run: the journal ended on the assistant's tool call. The shutdown handler here holds dispose until every
 * started call's result message has been emitted (bounded), so the journaled tail no longer depends on how many
 * handlers sit on that path.
 *
 * A running command (`bash`, `eval`, `ssh`) is not aborted at first: the stop lets it finish for up to
 * `QUIT_COMMAND_DRAIN_MS`, announced on stderr so the core's stop waits, while the `context` hook keeps the loop from
 * its next model request. Its real result reaches the journal and the relaunch continues the turn from it. A command
 * still running then is aborted as before.
 *
 * Stock's restore then `retry`s a batch whose every result is an error with the same call ids and arguments: a cut
 * command, or one that failed, would run a second time. A `tool_call` of a command whose call an earlier process
 * journaled is refused with what that process recorded (`replayOfEarlierLife`).
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { guard } from "./health";
import {
	commandDrainLine,
	createPendingToolCalls,
	isCommandTool,
	QUIT_COMMAND_DRAIN_MS,
	replayOfEarlierLife,
	replayRefusal,
} from "./quit-journal-core";

/** Longer than a tool needs to see its abort and return; a tool that ignores the abort does not hold the quit past it. */
export const QUIT_TOOL_SETTLE_MS = 1_500;

/**
 * The one tool the quit leaves as stock does. A `wait` cut by a quit stayed pending in the journal (its result never
 * reached it, before and after v0.110.0; omp 18.18.2 journals its aborted result and reply after the exit anyway, which
 * `requestCutAtExit` reads), and stock's restore ran it again; with its aborted result and the aborted reply journaled
 * by the hold the restore read the turn as ended and the parent was told by a follow-up instead
 * (`bridge-restore-subagents-stock.test.ts`: "while the parent waited on it", red 10 of 10 with the hold on `wait`).
 */
const LEFT_PENDING_TOOL = "wait";

/** The live registry as omp's package index reaches it: a session's agent loop by its agent id. */
interface RegistryApi {
	pi: {
		AgentRegistry: {
			global(): { get(id: unknown): { session?: { agent?: { abort?: () => void } } } | undefined };
		};
	};
}

/** This process's start: entries journaled before it are an earlier process's. */
const startedAt = performance.timeOrigin;

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	const calls = createPendingToolCalls();
	const commands = createPendingToolCalls();
	/** Set while a stop lets commands finish; resolved once the loop was aborted. */
	let draining: PromiseWithResolvers<void> | undefined;
	pi.on("tool_call", (event, ctx) => {
		if (!isCommandTool(event.toolName)) return undefined;
		const sessions = ctx.sessionManager;
		const replay = replayOfEarlierLife(sessions.getEntries(), sessions.getLeafEntry(), event.toolCallId, startedAt);
		if (!replay) return undefined;
		pi.logger.debug("gui-bridge: a command an earlier process started was not run again");
		return { block: true, reason: replayRefusal(event.toolName, replay.earlier) };
	});
	pi.on("tool_execution_start", event => {
		if (event.toolName === LEFT_PENDING_TOOL) return;
		calls.start(event.toolCallId);
		if (isCommandTool(event.toolName)) commands.start(event.toolCallId);
	});
	pi.on("message_end", event => {
		if (event.message.role !== "toolResult") return;
		calls.settle(event.message.toolCallId);
		commands.settle(event.message.toolCallId);
	});
	// The finished command's turn makes no model request during the stop: the abort below ends it there.
	pi.on("context", async () => {
		if (draining) await draining.promise;
		return undefined;
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (calls.size === 0) return;
		const agent = (pi as unknown as RegistryApi).pi.AgentRegistry.global().get(ctx.agent.id)?.session?.agent;
		if (typeof agent?.abort !== "function") return;
		if (commands.size > 0) {
			draining = Promise.withResolvers<void>();
			process.stderr.write(commandDrainLine(commands.size));
			const finished = await commands.settled(QUIT_COMMAND_DRAIN_MS);
			if (!finished) pi.logger.debug("gui-bridge: a command was still running when the stop's wait ended");
		}
		agent.abort();
		draining?.resolve();
		const settled = await calls.settled(QUIT_TOOL_SETTLE_MS);
		if (!settled) pi.logger.debug("gui-bridge: a tool call did not return before the quit's wait ended");
	});
}

export const methods = guard("quitJournal", {});
