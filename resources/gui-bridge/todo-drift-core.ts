/**
 * A todo list that stopped following the work (rules; wiring: todo-drift.ts; the panel: renderer `lib/todo-drift.ts`).
 * The owner's report (20 Nov 2026): sessions kept a "now" row from hours ago through several releases, a child that
 * worked 58 min showed 0/16 with its first playbook step as "now", and an instruction sent while a turn ran never got
 * a row. Stock reminds an agent only to finish open items (completion reminder) and, inside a turn, after 12 edits or
 * commands at most twice until the list changes (`todo.midRunNudges` "capped", session/todo-tracker.ts, text
 * "N todo items still open. If you finished a task … otherwise keep working"): nothing names the row the list shows as
 * "now", and nothing speaks when a new instruction arrives inside a running turn (a steer), where OMPdesk's stale-list
 * rule (todo-stale-core.ts, at a turn's start only) never runs.
 *
 * One rule read two ways: the bridge reads the journal and tells the agent (`todoNudge`), the panel reads the
 * transcript and tells the person (`todoDrift(…).stale`). Both see the same steps:
 *
 * - `list`: a todo call that changed the list (not a view, not a refused call);
 * - `call`: any other finished tool call;
 * - `instruction`: a new request from the person or an opening agent (todo-stale-core `isNewRequest`), at a turn's
 *   start or delivered into a running turn;
 * - `nudge`: a reminder already given (journaled; `nudgeKindOf`).
 *
 * A list with open items is behind the work when an instruction came after its last change and a tool call followed
 * (the agent works on something the list may not name), or when `DRIFT_CALLS` tool calls went by without a change.
 * No omp imports: the GUI's vitest and the renderer run it.
 */

/** Tool calls without a list change before an open list counts as behind the work. */
export const DRIFT_CALLS = 20;
/** Active minutes (gaps between tool calls, each capped at `IDLE_CAP_MS`) after which the panel marks the list. */
export const DRIFT_ACTIVE_MS = 15 * 60_000;
/** A pause longer than this between two calls counts as this long: waiting for a person is not work. */
export const IDLE_CAP_MS = 5 * 60_000;
/** An ignored drift reminder doubles the calls before the next, at most this many times. */
export const DRIFT_BACKOFF_DOUBLINGS = 3;

export type TodoDriftEvent =
	| { kind: "list"; at: number; phases: readonly TodoDriftPhase[] }
	| { kind: "call"; at: number }
	| { kind: "instruction"; at: number; text: string }
	| { kind: "nudge"; at: number; nudge: NudgeKind };

export interface TodoDriftPhase {
	name: string;
	tasks: ReadonlyArray<{ content: string; status: string }>;
}

export type NudgeKind = "instruction" | "drift" | "stale" | "compact" | "stock-mid-run" | "stock-completion";

export interface TodoDrift {
	/** When the list last changed; undefined when no change is in what was read. */
	changedAt: number | undefined;
	open: boolean;
	/** The row the panel shows as "now": the one in progress, else the next open one. */
	now: { content: string; status: string } | undefined;
	done: number;
	total: number;
	/** Tool calls and active time since the list's last change (or since the first step read). */
	callsSince: number;
	activeMsSince: number;
	/** The newest new request after the list's last change, with the calls since it and whether it was named. */
	instruction: { text: string; callsSince: number; nudged: boolean } | undefined;
	/** Drift reminders since the list's last change, and calls since the newest one. */
	driftNudges: number;
	callsSinceDriftNudge: number;
	/** Why the panel marks the list as behind the work; undefined while it follows it. */
	stale: "instruction" | "drift" | undefined;
}

const OPEN: Record<string, true> = { pending: true, in_progress: true, blocked: true };
const CLOSED: Record<string, true> = { completed: true, abandoned: true };

/** Reads the steps in order. */
export function todoDrift(events: readonly TodoDriftEvent[]): TodoDrift {
	let phases: readonly TodoDriftPhase[] = [];
	let changedAt: number | undefined;
	let callsSince = 0;
	let activeMsSince = 0;
	let lastAt: number | undefined;
	let instruction: TodoDrift["instruction"];
	let driftNudges = 0;
	let callsSinceDriftNudge = 0;
	for (const event of events) {
		if (event.kind === "list") {
			phases = event.phases;
			changedAt = event.at;
			callsSince = 0;
			activeMsSince = 0;
			lastAt = event.at;
			instruction = undefined;
			driftNudges = 0;
			callsSinceDriftNudge = 0;
		} else if (event.kind === "call") {
			callsSince++;
			callsSinceDriftNudge++;
			if (instruction) instruction.callsSince++;
			if (lastAt !== undefined) activeMsSince += Math.min(IDLE_CAP_MS, Math.max(0, event.at - lastAt));
			lastAt = event.at;
		} else if (event.kind === "instruction") {
			instruction = { text: event.text, callsSince: 0, nudged: false };
		} else if (event.nudge === "drift" || event.nudge === "stock-mid-run") {
			// Stock's own mid-run nudge spaces the next one too, so the agent never reads two at once; only ours back off.
			if (event.nudge === "drift") driftNudges++;
			callsSinceDriftNudge = 0;
		} else if (instruction && (event.nudge === "instruction" || event.nudge === "stale")) {
			instruction.nudged = true;
		}
	}
	const tasks = phases.flatMap(phase => phase.tasks).filter(task => task.status !== "abandoned");
	const open = tasks.some(task => OPEN[task.status]);
	const now = tasks.find(task => task.status === "in_progress") ?? tasks.find(task => OPEN[task.status]);
	const stale = !open
		? undefined
		: instruction && instruction.callsSince > 0
			? "instruction"
			: callsSince >= DRIFT_CALLS || activeMsSince >= DRIFT_ACTIVE_MS
				? "drift"
				: undefined;
	return {
		changedAt,
		open,
		now: now && { content: now.content, status: now.status },
		done: tasks.filter(task => CLOSED[task.status]).length,
		total: tasks.length,
		callsSince,
		activeMsSince,
		instruction,
		driftNudges,
		callsSinceDriftNudge,
		stale,
	};
}

/**
 * The reminder the agent reads after the tool call that ends `events` (that call already counted), or undefined.
 * An instruction is named once, after the first call that follows it; drift after `DRIFT_CALLS` calls, then after
 * twice as many each time it went unanswered, until the list changes.
 */
export function todoNudge(drift: TodoDrift): "instruction" | "drift" | undefined {
	if (!drift.open) return undefined;
	if (drift.instruction && !drift.instruction.nudged && drift.instruction.callsSince > 0) return "instruction";
	const needed = DRIFT_CALLS * 2 ** Math.min(drift.driftNudges, DRIFT_BACKOFF_DOUBLINGS);
	return drift.callsSinceDriftNudge >= needed ? "drift" : undefined;
}

const INSTRUCTION_LEAD = "A new instruction arrived after your todo list last changed";
const DRIFT_LEAD = "Your todo list has not changed for";
const MAX_QUOTE_CHARS = 100;

function clip(text: string): string {
	const plain = text
		.replace(/^\s*<ompdesk-agent-message\b[^>]*>/, "")
		.replace(/\s+/g, " ")
		.trim();
	const chars = [...plain];
	return chars.length > MAX_QUOTE_CHARS ? `${chars.slice(0, MAX_QUOTE_CHARS).join("")}…` : plain;
}

function nowPhrase(drift: TodoDrift): string {
	if (!drift.now) return "no item in progress";
	return drift.now.status === "in_progress" ? `"${drift.now.content}" in progress` : `"${drift.now.content}" as next`;
}

/** The text of a reminder, wrapped like stock's own todo reminders. */
export function todoNudgeText(kind: "instruction" | "drift", drift: TodoDrift): string {
	const figure = `${drift.done}/${drift.total} done`;
	const body =
		kind === "instruction"
			? `${INSTRUCTION_LEAD}: "${clip(drift.instruction?.text ?? "")}". The list still shows ${nowPhrase(drift)} (${figure}). If that instruction is work of its own, add it as an item and start it now (todo append, then start), mark it done when it is finished, then start the item you return to. If it only continues the current item, leave the list as it is.`
			: `${DRIFT_LEAD} ${drift.callsSince} tool calls (${Math.round(drift.activeMsSince / 60_000)} min of work); it shows ${nowPhrase(drift)}, ${figure}. Bring it up to date beside your next call: mark what you finished done, start the item you are working on now, and add an item for work the list does not name.`;
	return `<system-reminder>\n${body}\n</system-reminder>`;
}

/** One journal entry as the readers here see it (stock's `SessionEntry`, only the fields used). */
export interface TodoDriftEntry {
	type?: unknown;
	customType?: unknown;
	timestamp?: unknown;
	message?: {
		role?: unknown;
		toolName?: unknown;
		isError?: unknown;
		synthetic?: unknown;
		attribution?: unknown;
		content?: unknown;
		details?: unknown;
		timestamp?: unknown;
	};
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (typeof part === "object" && part !== null && typeof part.text === "string" ? part.text : ""))
		.join("");
}

/** Which reminder a journal entry is, if any: OMPdesk's own and stock's, so a reader can count what each achieved. */
export function nudgeKindOf(entry: TodoDriftEntry): NudgeKind | undefined {
	if (entry.type === "custom_message") {
		// Stock's `MID_RUN_NUDGE_MESSAGE_TYPE` (session/todo-tracker.ts, not exported).
		if (entry.customType === "mid-run-todo-nudge") return "stock-mid-run";
		if (entry.customType === STALE_TODO_MESSAGE_TYPE) return "stale";
		return undefined;
	}
	if (entry.type !== "message" || entry.message?.role !== "developer") return undefined;
	const text = textOf(entry.message.content);
	if (text.includes(INSTRUCTION_LEAD)) return "instruction";
	if (text.includes(DRIFT_LEAD)) return "drift";
	if (text.includes(COMPACT_LEAD)) return "compact";
	// Stock's completion reminder (session/todo-tracker.ts `checkCompletion`).
	if (text.includes("incomplete todo item(s)")) return "stock-completion";
	return undefined;
}

function entryAt(entry: TodoDriftEntry): number {
	return typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
}

/**
 * The steps after the journal entry at `listAt` that holds `phases` (stock's latest todo snapshot), in order. A view,
 * a refused todo call and a todo call that changed nothing count as neither a change nor work.
 */
export function journalDriftEvents(
	branch: readonly TodoDriftEntry[],
	listAt: number,
	phases: readonly TodoDriftPhase[],
): TodoDriftEvent[] {
	const events: TodoDriftEvent[] = [{ kind: "list", at: entryAt(branch[listAt] ?? {}), phases }];
	for (let index = listAt + 1; index < branch.length; index++) {
		const entry = branch[index];
		const at = entryAt(entry);
		const nudge = nudgeKindOf(entry);
		if (nudge) {
			events.push({ kind: "nudge", at, nudge });
			continue;
		}
		const message = entry.type === "message" ? entry.message : undefined;
		if (message?.role === "toolResult" && message.toolName !== "todo") events.push({ kind: "call", at });
		else if (message?.role === "user" && message.synthetic !== true && message.attribution !== "agent") {
			const text = textOf(message.content);
			if (isNewRequest(text)) events.push({ kind: "instruction", at, text });
		}
	}
	return events;
}
