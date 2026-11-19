/**
 * A todo list that stopped following the work (rules; wiring and the panel's reading: todo-drift.ts).
 * The owner's report (20 Nov 2026): sessions kept a "now" row from hours ago through several releases, a child that
 * worked 58 min showed 0/16 with its first playbook step as "now", and an instruction sent while a turn ran never got
 * a row. Stock reminds an agent only to finish open items (completion reminder) and, inside a turn, after 12 edits or
 * commands at most twice until the list changes (`todo.midRunNudges` "capped", session/todo-tracker.ts, text
 * "N todo items still open. If you finished a task … otherwise keep working"): nothing names the row the list shows as
 * "now", and nothing speaks when a new instruction arrives inside a running turn (a steer), where OMPdesk's stale-list
 * rule (todo-stale-core.ts, at a turn's start only) never runs.
 *
 * Measured on the Mac mini's sessions since 6 Nov (scripts/todo-truth-stats.ts; 54 sessions with a list): 952 steers
 * met an open list and 30.6% of them got a row before the next instruction; after stock's mid-run nudge the list
 * changed within 3 calls 17.9% of the time; 258 spans of 15+ active minutes went without a change. Lists made of a
 * playbook's copied steps changed as often as others (median 11 vs 10 calls between changes, p90 54 vs 52), so the
 * copied steps are not why lists stall; while one was open its "now" row was a playbook step in 80% of the calls.
 *
 * The bridge reads the journal after each tool call and tells the agent (`todoNudge`) and the panel
 * (`todoDriftState`). Both see the same steps:
 *
 * - `list`: a todo call that changed the list (not a view, not a refused call);
 * - `call`: any other finished tool call;
 * - `instruction`: a new request from the person or an opening agent (todo-stale-core `isNewRequest`), at a turn's
 *   start or delivered into a running turn;
 * - `nudge`: a reminder already given (journaled; `nudgeKindOf`);
 * - `compaction`: the reminders before it left the model's context.
 *
 * A list with open items is behind the work when an instruction came after its last change and a tool call followed
 * (the agent works on something the list may not name), or when `DRIFT_CALLS` tool calls or `DRIFT_ACTIVE_MS` of work
 * went by without a change. No omp imports: the GUI's vitest runs it.
 */
import { COMPACT_LEAD } from "./todo-compact-core";
import type { TodoDriftState } from "./todo-drift-contracts";
import { isNewRequest, STALE_TODO_MESSAGE_TYPE } from "./todo-stale-core";

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
	| { kind: "nudge"; at: number; nudge: NudgeKind }
	/** A compaction: the reminders before it left the model's context, so they count as never given. */
	| { kind: "compaction"; at: number };

export interface TodoDriftPhase {
	name: string;
	tasks: ReadonlyArray<{ content: string; status: string }>;
}

export type NudgeKind = "instruction" | "drift" | "stale" | "compact" | "stock-mid-run" | "stock-completion";

/** Instructions the panel lists by their first line (the newest; `receivedCount` says how many came). */
export const RECEIVED_SHOWN = 5;
const RECEIVED_LINE_CHARS = 120;

/** An instruction's first line as the panel lists it: no agent-message wrapper, no `Title:` lead, at most 120 chars. */
export function instructionLine(text: string): string {
	const line =
		text
			.replace(/^\s*<ompdesk-agent-message\b[^>]*>/, "")
			.replace(/<\/ompdesk-agent-message>\s*$/, "")
			.split("\n")
			.map(part => part.trim())
			.find(part => part !== "") ?? "";
	const chars = [...line.replace(/^Title:\s*/, "")];
	return chars.length > RECEIVED_LINE_CHARS ? `${chars.slice(0, RECEIVED_LINE_CHARS).join("")}…` : chars.join("");
}

/** The part of the reading the GUI shows (todo-drift-contracts.ts). */
export function todoDriftState(drift: TodoDrift): TodoDriftState {
	return {
		changedAt: drift.changedAt ?? null,
		stale: drift.stale ?? null,
		received: drift.received.slice(-RECEIVED_SHOWN).map(item => ({ at: item.at, text: instructionLine(item.text) })),
		receivedCount: drift.received.length,
	};
}

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
	/** Every new request since the list's last change, oldest first. */
	received: Array<{ at: number; text: string }>;
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
	let received: TodoDrift["received"] = [];
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
			received = [];
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
			received.push({ at: event.at, text: event.text });
		} else if (event.kind === "compaction") {
			if (instruction) instruction.nudged = false;
			driftNudges = 0;
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
		received,
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

/** How each reminder opens: `nudgeKindOf` finds a journaled one by it. */
export const INSTRUCTION_LEAD = "A new instruction arrived after your todo list last changed";
export const DRIFT_LEAD = "Your todo list has not changed for";
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
			? `${INSTRUCTION_LEAD}: "${clip(drift.instruction?.text ?? "")}". The list still shows ${nowPhrase(drift)} (${figure}). If that instruction is work of its own, add it as an item and start it now (todo append, then start), mark it done when it is finished, then start the item you return to. If it only continues the current item, say so with todo start on that item, so the list shows it is current.`
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
 * Whether the newest assistant message calls `todo` (not a view) and that call's result is not journaled yet: the
 * list is changing in this very batch of calls, so a call beside it says nothing about a list left behind. Seen with
 * a real model (20 Nov 2026): a steer answered by `write` and `todo append` in one message got the instruction
 * reminder after the `write`.
 */
export function todoCallInFlight(branch: readonly TodoDriftEntry[]): boolean {
	for (let index = branch.length - 1; index >= 0; index--) {
		const message = branch[index].type === "message" ? branch[index].message : undefined;
		if (message?.role === "toolResult" && message.toolName === "todo") return false;
		if (message?.role !== "assistant") continue;
		return (
			Array.isArray(message.content) &&
			message.content.some(
				part =>
					typeof part === "object" &&
					part !== null &&
					part.type === "toolCall" &&
					part.name === "todo" &&
					part.arguments?.op !== "view",
			)
		);
	}
	return false;
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
		if (entry.type === "compaction") {
			events.push({ kind: "compaction", at });
			continue;
		}
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
