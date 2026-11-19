/**
 * The tool calls of one session that started and whose result message has not been emitted yet. A quit waits on
 * this set (quit-journal.ts) so an aborted call's result reaches the journal before the process ends.
 */
export interface PendingToolCalls {
	start(toolCallId: string): void;
	settle(toolCallId: string): void;
	readonly size: number;
	/** Resolves true once no call is pending, false after `timeoutMs` with some still pending. */
	settled(timeoutMs: number): Promise<boolean>;
}

export function createPendingToolCalls(): PendingToolCalls {
	const pending = new Set<string>();
	const waiters = new Set<() => void>();
	return {
		start: id => {
			pending.add(id);
		},
		settle: id => {
			if (!pending.delete(id) || pending.size > 0) return;
			for (const release of [...waiters]) release();
		},
		get size() {
			return pending.size;
		},
		settled: timeoutMs => {
			if (pending.size === 0) return Promise.resolve(true);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			const release = () => {
				clearTimeout(timer);
				waiters.delete(release);
				resolve(pending.size === 0);
			};
			const timer = setTimeout(release, timeoutMs);
			waiters.add(release);
			return promise;
		},
	};
}

/**
 * The tools that run commands: a stop lets a running call of theirs finish (quit-journal.ts), and stock's replay after a
 * relaunch never runs one of theirs a second time (`replayOfEarlierLife`).
 */
const COMMAND_TOOLS: Readonly<Record<string, true>> = { bash: true, eval: true, ssh: true };

export function isCommandTool(tool: string): boolean {
	return Object.hasOwn(COMMAND_TOOLS, tool);
}

/**
 * The file in a session's artifacts folder that lists, one call id a line, every plain `bash` call whose command
 * reached the shell: written before the command runs, so a crash cannot lose it. A replayed call missing there never
 * ran (it was cut while its approval card waited, or before it started), so running it now runs it once.
 */
export const RAN_COMMANDS_FILE = "ran-commands";

/** A call whose command runs in the session's embedded shell, where its start is recorded (`RAN_COMMANDS_FILE`). */
export function startsInShell(tool: string, input: Record<string, unknown>): boolean {
	return tool === "bash" && input.pty !== true && input.name === undefined;
}

/** Whether `ran` (the `RAN_COMMANDS_FILE` text) lists call `toolCallId`. */
export function ranBefore(ran: string, toolCallId: string): boolean {
	return ran.split("\n").includes(toolCallId);
}

/**
 * How long a stop lets running commands finish before it aborts them. Inside main's quit watchdog (30 s,
 * quit-watchdog.ts), which ends the core and with it every omp: the stop is told this bound by the exit-hold line
 * (`commandDrainLine`), so it waits instead of ending omp after its 5 s grace (core sidecar/stop.rs `Hold`).
 */
export const QUIT_COMMAND_DRAIN_MS = 20_000;

/** The stderr line the core's stop reads as a wait (`(up to N s)`, stop.rs `waits`). */
export function commandDrainLine(count: number): string {
	const what = count === 1 ? "a running command" : `${count} running commands`;
	return `gui-bridge: finishing ${what} before exit (up to ${Math.ceil(QUIT_COMMAND_DRAIN_MS / 1000)} s)\n`;
}

/** The slice of a journal entry read here (stock `SessionEntry`). */
export interface CallEntry {
	type: string;
	id?: string;
	timestamp?: string;
	message?: { role?: string; content?: unknown; toolCallId?: string };
}

function journaledBefore(entry: CallEntry, at: number): boolean {
	const time = entry.timestamp === undefined ? Number.NaN : Date.parse(entry.timestamp);
	return Number.isFinite(time) && time < at;
}

function hasCall(entry: CallEntry, toolCallId: string): boolean {
	const content = entry.message?.role === "assistant" ? entry.message.content : undefined;
	return (
		Array.isArray(content) &&
		content.some(
			block => typeof block === "object" && block !== null && block.type === "toolCall" && block.id === toolCallId,
		)
	);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (typeof part === "object" && part !== null && part.type === "text" ? String(part.text ?? "") : ""))
		.join("");
}

/**
 * A call stock is about to run again that a process this one replaced already started. Stock's `retry`
 * (turn-recovery.ts `toolReplayStart`) replays a batch whose every result is an error with the same call ids and
 * arguments, after moving the journal's leaf back to the batch's assistant message (`#stripForToolReplay`). After a
 * relaunch that batch is a cut call (`Command aborted`, or stock's "outcome unknown" for a killed process) or one that
 * ran to a failing exit, and a command with an effect would make it twice (the same commit made twice, 19 Nov 2026).
 * So: the last message of the current branch is an assistant message holding `toolCallId` journaled before `startedAt`
 * (this process's start, epoch ms). Entries that are no message may follow it: other `tool_call` hooks journal their
 * own (`ompdesk.checkout-claims`), and stock journals `tool_execution_start`. A first run never matches: the loop
 * dispatches a call before its assistant message is journaled. `earlier` is the result the earlier process journaled
 * for it after that message (the abort's partial output, a real failure), absent when it journaled none.
 */
export function replayOfEarlierLife(
	entries: readonly CallEntry[],
	branch: readonly CallEntry[],
	toolCallId: string,
	startedAt: number,
): { earlier?: string } | undefined {
	const last = branch.findLast(entry => entry.type === "message");
	if (!last || !hasCall(last, toolCallId) || !journaledBefore(last, startedAt)) return undefined;
	const anchor = entries.findIndex(entry => entry === last || (last.id !== undefined && entry.id === last.id));
	const result = entries
		.slice(anchor + 1)
		.find(
			entry =>
				entry.type === "message" &&
				entry.message?.role === "toolResult" &&
				entry.message.toolCallId === toolCallId &&
				journaledBefore(entry, startedAt),
		);
	const earlier = result ? textOf(result.message?.content).trim() : "";
	return earlier ? { earlier } : {};
}

/** How much of the earlier result the refusal carries: its end, where a command's outcome is. */
const EARLIER_RESULT_CHARS = 4_000;

/** The result a refused replay gets instead of running the call again. */
export function replayRefusal(tool: string, earlier: string | undefined): string {
	const head = `Not run again: this ${tool} call had already started before OMPdesk restarted, so running it a second time could repeat what it did.`;
	const then =
		earlier === undefined
			? "Its outcome was not recorded: the process running it ended while it ran."
			: `What it returned then:\n${earlier.length > EARLIER_RESULT_CHARS ? `…${earlier.slice(-EARLIER_RESULT_CHARS)}` : earlier}`;
	return `${head}\n${then}\nCheck what it already changed, then run it again only if the work still needs it.`;
}
