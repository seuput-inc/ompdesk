/**
 * Shared world of the todo-list-behind-the-work stock tests: a scripted agent, the steer during a running turn, and
 * the journal and the panel read the same way in each.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { TodoDriftState } from "../../resources/gui-bridge/todo-drift-contracts";
import { INSTRUCTION_LEAD } from "../../resources/gui-bridge/todo-drift-core";
import { buildTodoDockPeek } from "../renderer/components/chat/dock/dock-summary";
import { createTodoStore } from "../renderer/stores/todo";
import type { TodoPhase } from "../shared/rpc-types";
import { bridgeAt, fakeAgent, type Omp, sse, startOmp, startProvider, toolCall } from "./bridge-todo-stock-rig";

export const A = "Write the parser";
export const A2 = "Test the parser";
export const B = "Fix the README typo";
export const STEER = "Also fix the typo in README.md right away: teh should read the.";
export const PHASE = "Parser";
export const PLAYBOOK = [
	"1. Reproduce it",
	"2. Find the cause",
	"3. Plan the fix",
	"4. Verify",
	"5. Commit",
	"6. Report",
];
export const CHILD_PROMPT =
	'<ompdesk-agent-message from="Main" session="01a1">\nTitle: Build the parser\n\nBuild the parser module for the config files and test it, following the bug fix playbook.\n</ompdesk-agent-message>';

export const reply = {
	todo: (args: Record<string, unknown>) => sse(toolCall("todo", args), "tool_calls"),
	bash: (command: string) => sse(toolCall("bash", { command }), "tool_calls"),
	read: (path: string) => sse(toolCall("read", { path }), "tool_calls"),
	text: (text: string) => sse([{ content: text }], "stop"),
	/** Several calls in one assistant message. */
	calls: (calls: Array<[string, Record<string, unknown>]>) =>
		sse(
			[
				{
					tool_calls: calls.map(([name, args], index) => ({
						index,
						id: `call_${name}_${index}`,
						type: "function",
						function: { name, arguments: JSON.stringify(args) },
					})),
				},
			],
			"tool_calls",
		),
};

export function count(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

/**
 * The agent of the steer cases: lists `list` (A and its test by default), works on A, works on B once the steer is in
 * its request without touching the list, and when `react` allows, adds B, finishes it and starts A again. `call` makes
 * one more work call first.
 */
export function steerAgent(
	react: (fresh: boolean, nudges: number) => boolean,
	list: Array<{ phase: string; items: string[] }> = [{ phase: PHASE, items: [A, A2] }],
) {
	const state = { listed: false, workedA: false, workedB: false, reacted: false, seen: 0, call: false };
	const queue: string[] = [];
	const respond = (_step: number, body: string): string => {
		const nudges = count(body, INSTRUCTION_LEAD);
		const fresh = nudges > state.seen;
		state.seen = nudges;
		const next = queue.shift();
		if (next) return next;
		if (!state.listed) {
			state.listed = true;
			return reply.todo({ op: "init", list });
		}
		if (!state.workedA) {
			state.workedA = true;
			return reply.bash("sleep 3; echo parsed");
		}
		if (body.includes(STEER) && !state.workedB) {
			state.workedB = true;
			return reply.bash("echo the > README.md");
		}
		if (state.workedB && !state.reacted && react(fresh, nudges)) {
			state.reacted = true;
			queue.push(
				reply.todo({ op: "start", task: B }),
				reply.bash("cat README.md"),
				reply.todo({ op: "done", task: B }),
				reply.todo({ op: "start", task: A }),
				reply.text("Back on the parser."),
			);
			return reply.todo({ op: "append", phase: PHASE, items: [B] });
		}
		if (state.call) {
			state.call = false;
			return reply.bash("echo resume");
		}
		return reply.text("Done.");
	};
	return { respond, state };
}

/** The prompt, and the steer while its first bash runs (`steers`: the commands that deliver it, in order). */
export async function steeredTurn(
	session: Omp,
	prompt = "Build the parser module for the config files and test it.",
	steers: ReadonlyArray<Record<string, unknown>> = [{ type: "steer", message: STEER }],
): Promise<void> {
	const from = session.frames.length;
	const turn = session.turn(prompt);
	await expect
		.poll(
			() =>
				session.frames
					.slice(from)
					.some(frame => frame.type === "tool_execution_start" && frame.toolName === "bash"),
			{ timeout: 60_000 },
		)
		.toBe(true);
	for (const steer of steers) expect((await session.send(steer)).success, JSON.stringify(steer)).toBe(true);
	await turn;
}

export interface JournalEntry {
	type?: string;
	id?: string;
	parentId?: string | null;
	customType?: string;
	message?: {
		role?: string;
		toolName?: string;
		isError?: boolean;
		content?: unknown;
		details?: { op?: string; phases?: TodoPhase[] };
	};
}

/** The newest branch of the session file omp wrote, root first. */
export async function journalBranch(session: Omp): Promise<JournalEntry[]> {
	const state = (await session.send({ type: "get_state" })) as { data?: { sessionFile?: string } };
	const file = state.data?.sessionFile;
	if (!file) throw new Error("get_state named no session file");
	const entries = readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as JournalEntry);
	const byId = new Map(entries.filter(entry => entry.id).map(entry => [entry.id, entry]));
	const branch: JournalEntry[] = [];
	for (let at = entries.findLast(entry => entry.id); at; at = at.parentId ? byId.get(at.parentId) : undefined)
		branch.unshift(at);
	return branch;
}

/** A committed todo result's list (not a view, not refused), or undefined for any other entry. */
export function listIn(entry: JournalEntry): TodoPhase[] | undefined {
	const message = entry.message;
	if (message?.role !== "toolResult" || message.toolName !== "todo" || message.isError) return undefined;
	return message.details?.op !== "view" ? message.details?.phases : undefined;
}

/** The todo list the session file holds: the newest branch's last committed todo result. */
export async function journalList(session: Omp): Promise<TodoPhase[]> {
	return (await journalBranch(session)).map(listIn).findLast(Boolean) ?? [];
}

export function statuses(phases: readonly TodoPhase[]): Record<string, string> {
	return Object.fromEntries(phases.flatMap(phase => phase.tasks.map(task => [task.content, task.status])));
}

export function nowOf(phases: readonly TodoPhase[]): string | undefined {
	const tasks = phases.flatMap(phase => phase.tasks);
	return (
		tasks.find(task => task.status === "in_progress") ??
		tasks.find(task => task.status === "pending" || task.status === "blocked")
	)?.content;
}

/**
 * What the panel shows, built as the renderer builds it: hydrated from get_state (a window opened now) and, for the
 * live window, fed every todo result omp sent.
 */
export async function panel(session: Omp): Promise<{ hydrated: string | undefined; live: string | undefined }> {
	const state = (await session.send({ type: "get_state" })) as { data?: { todoPhases?: TodoPhase[] } };
	const hydrated = createTodoStore();
	hydrated.getState().setPhases(state.data?.todoPhases ?? []);
	const live = createTodoStore();
	live.getState().setPhases([]);
	for (const frame of session.frames) {
		if (frame.type !== "tool_execution_end" || frame.toolName !== "todo" || frame.isError) continue;
		const phases = frame.result?.details?.phases;
		if (Array.isArray(phases)) live.getState().setPhases(phases as TodoPhase[]);
	}
	return {
		hydrated: buildTodoDockPeek(hydrated.getState().phases).current?.content,
		live: buildTodoDockPeek(live.getState().phases).current?.content,
	};
}

/** The bridge's reading as main's get_state merges it. */
export async function driftState(session: Omp): Promise<TodoDriftState> {
	return session.bridge.request<TodoDriftState>("todoDrift.state");
}

export function lastDriftFrame(session: Omp): TodoDriftState | undefined {
	return session.bridgeEvents.findLast(event => event.type === "todo_drift")?.state as TodoDriftState | undefined;
}

/**
 * This checkout's bridge, or with `TODO_DRIFT_BRIDGE_REF=<commit>` the bridge as it was there: the cases then show
 * what that bridge did.
 */
export const BRIDGE = process.env.TODO_DRIFT_BRIDGE_REF
	? bridgeAt(process.env.TODO_DRIFT_BRIDGE_REF)
	: resolve("resources/gui-bridge/index.ts");

/** omp on the scripted provider; `config` is the agent dir's config.yml. */
export async function start(respond: (step: number, body: string) => string, config?: string) {
	const provider = await startProvider(respond);
	const agent = fakeAgent(provider.url);
	if (config) writeFileSync(join(agent.agentDir, "config.yml"), config);
	const session = await startOmp({ ...agent, model: "fake/m1", bridge: BRIDGE });
	return { provider, agent, session };
}

/** Small enough that a compaction of a short session has something to summarize. */
export const SMALL_COMPACTION = "compaction:\n  keepRecentTokens: 50\n  v2RetainedMessageBudget: 50\n";

/** The first request (0-based) whose body carries `lead`. */
export function firstWith(bodies: readonly string[], lead: string): number {
	return bodies.findIndex(body => body.includes(lead));
}
