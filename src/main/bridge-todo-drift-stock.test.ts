import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TodoDriftState } from "../../resources/gui-bridge/todo-drift-contracts";
import { DRIFT_LEAD, INSTRUCTION_LEAD } from "../../resources/gui-bridge/todo-drift-core";
import { buildTodoDockPeek } from "../renderer/components/chat/dock/dock-summary";
import { createTodoStore } from "../renderer/stores/todo";
import type { TodoPhase } from "../shared/rpc-types";
import {
	bridgeAt,
	fakeAgent,
	type Omp,
	realAgent,
	sse,
	startOmp,
	startProvider,
	toolCall,
} from "./bridge-todo-stock-rig";
import { INSTALLED_OMP as omp } from "./test-bridge-probe";

/**
 * An agent's todo list stops following its work (todo-drift-core.ts): an instruction that arrives while a turn runs (a
 * steer) gets no row, and a long run of calls leaves the first step of a list as "now". The bridge (todo-drift.ts)
 * names it to the model after a tool call and tells the panel when the list last changed and whether it is behind.
 *
 * Installed omp, the bridge, a scripted provider (no spend). The scripted agent forgets its list until a reminder
 * reaches it in a request, and then does what the reminder asks; so the journal shows the list caught up only where
 * the reminder came at the right point. Each case reads the session file omp wrote (the journal) and checks the panel
 * (the renderer's todo store fed with get_state and the frames omp sent, and the bridge's `todoDrift.state`) against
 * it: the work on A, instruction B sent as a steer and finished in the same turn, then back to A; the same across a
 * compaction and across a relaunch; a child opened by another agent whose list is a playbook's steps.
 */

const A = "Write the parser";
const A2 = "Test the parser";
const B = "Fix the README typo";
const STEER = "Also fix the typo in README.md right away: teh should read the.";
const PHASE = "Parser";

const reply = {
	todo: (args: Record<string, unknown>) => sse(toolCall("todo", args), "tool_calls"),
	bash: (command: string) => sse(toolCall("bash", { command }), "tool_calls"),
	read: (path: string) => sse(toolCall("read", { path }), "tool_calls"),
	text: (text: string) => sse([{ content: text }], "stop"),
};

function count(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

/**
 * The agent of the steer cases: lists `list` (A and its test by default), works on A, works on B once the steer is in
 * its request without touching the list, and when `react` allows, adds B, finishes it and starts A again. `call` makes
 * one more work call first.
 */
function steerAgent(
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

/** The prompt, and the steer while its first bash runs. */
async function steeredTurn(
	session: Omp,
	prompt = "Build the parser module for the config files and test it.",
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
	await session.send({ type: "steer", message: STEER });
	await turn;
}

interface JournalEntry {
	type?: string;
	id?: string;
	parentId?: string | null;
	message?: {
		role?: string;
		toolName?: string;
		isError?: boolean;
		content?: unknown;
		details?: { op?: string; phases?: TodoPhase[] };
	};
}

/** The newest branch of the session file omp wrote, root first. */
async function journalBranch(session: Omp): Promise<JournalEntry[]> {
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
function listIn(entry: JournalEntry): TodoPhase[] | undefined {
	const message = entry.message;
	if (message?.role !== "toolResult" || message.toolName !== "todo" || message.isError) return undefined;
	return message.details?.op !== "view" ? message.details?.phases : undefined;
}

/** The todo list the session file holds: the newest branch's last committed todo result. */
async function journalList(session: Omp): Promise<TodoPhase[]> {
	return (await journalBranch(session)).map(listIn).findLast(Boolean) ?? [];
}

function statuses(phases: readonly TodoPhase[]): Record<string, string> {
	return Object.fromEntries(phases.flatMap(phase => phase.tasks.map(task => [task.content, task.status])));
}

function nowOf(phases: readonly TodoPhase[]): string | undefined {
	const tasks = phases.flatMap(phase => phase.tasks);
	return (
		tasks.find(task => task.status === "in_progress") ??
		tasks.find(task => task.status === "pending" || task.status === "blocked")
	)?.content;
}

/**
 * What the panel shows, built as the renderer builds it: hydrated from get_state (a window opened now) and, for the
 * live window, fed every todo result omp sent since `from`, on top of the state it hydrated when the run began.
 */
async function panel(session: Omp): Promise<{ hydrated: string | undefined; live: string | undefined }> {
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

async function driftState(session: Omp): Promise<TodoDriftState> {
	return session.bridge.request<TodoDriftState>("todoDrift.state");
}

function lastDriftFrame(session: Omp): TodoDriftState | undefined {
	return session.bridgeEvents.findLast(event => event.type === "todo_drift")?.state as TodoDriftState | undefined;
}

/**
 * This checkout's bridge, or with `TODO_DRIFT_BRIDGE_REF=<commit>` the bridge as it was there: the cases then show
 * what that bridge did (before todo-drift.ts: no reminder, so the scripted agent never catches its list up).
 */
const BRIDGE = process.env.TODO_DRIFT_BRIDGE_REF
	? bridgeAt(process.env.TODO_DRIFT_BRIDGE_REF)
	: resolve("resources/gui-bridge/index.ts");

/** omp on the scripted provider; `config` is the agent dir's config.yml. */
async function start(respond: (step: number, body: string) => string, config?: string) {
	const provider = await startProvider(respond);
	const agent = fakeAgent(provider.url);
	if (config) writeFileSync(join(agent.agentDir, "config.yml"), config);
	const session = await startOmp({ ...agent, model: "fake/m1", bridge: BRIDGE });
	return { provider, agent, session };
}

/** The first request (0-based) whose body carries `lead`. */
function firstWith(bodies: readonly string[], lead: string): number {
	return bodies.findIndex(body => body.includes(lead));
}

describe.skipIf(!existsSync(omp))("a todo list behind the work, on stock omp", () => {
	it("an instruction steered into a running turn is named after the next call; the list then adds it, finishes it and returns to A", async () => {
		const agent = steerAgent(fresh => fresh);
		const { provider, session } = await start(agent.respond);
		await steeredTurn(session);

		// The reminder comes in the request after the first call that followed the steer, once.
		const steered = provider.bodies.findIndex(body => body.includes(STEER));
		expect(firstWith(provider.bodies, INSTRUCTION_LEAD)).toBe(steered + 1);
		expect(count(provider.bodies.at(-1) ?? "", INSTRUCTION_LEAD)).toBe(1);

		const journal = await journalList(session);
		expect(statuses(journal)).toEqual({ [A]: "in_progress", [A2]: "pending", [B]: "completed" });
		const shown = await panel(session);
		expect(shown).toEqual({ hydrated: nowOf(journal), live: nowOf(journal) });
		expect(nowOf(journal)).toBe(A);
		const drift = await driftState(session);
		expect(drift.stale).toBeNull();
		// The frame after a todo call is stamped as the hook runs, the journal entry a moment later.
		expect(lastDriftFrame(session)?.stale).toBeNull();
		expect(Math.abs((lastDriftFrame(session)?.changedAt ?? 0) - (drift.changedAt ?? 0))).toBeLessThan(1_000);
	}, 180_000);

	it("an agent that ignores the reminder leaves a list the panel marks as behind the instruction", async () => {
		const agent = steerAgent(() => false);
		const { session } = await start(agent.respond);
		await steeredTurn(session);

		const journal = await journalList(session);
		expect(Object.keys(statuses(journal))).not.toContain(B);
		expect(await panel(session)).toEqual({ hydrated: A, live: A });
		const drift = await driftState(session);
		expect(drift).toMatchObject({ stale: "instruction" });
		expect(drift.changedAt).toBeGreaterThan(0);
		expect(lastDriftFrame(session)).toEqual(drift);
	}, 180_000);

	it("an agent that adds the row beside its first call for the instruction gets no reminder", async () => {
		const both = (calls: Array<[string, Record<string, unknown>]>) =>
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
			);
		let answered = false;
		const respond = (step: number, body: string): string => {
			if (step === 1) return reply.todo({ op: "init", list: [{ phase: PHASE, items: [A, A2] }] });
			if (step === 2) return reply.bash("sleep 3; echo parsed");
			if (body.includes(STEER) && !answered) {
				answered = true;
				return both([
					["bash", { command: "echo the > README.md" }],
					["todo", { op: "append", phase: PHASE, items: [B] }],
				]);
			}
			return reply.text("Done.");
		};
		const { provider, session } = await start(respond);
		await steeredTurn(session);

		expect(provider.bodies.some(body => body.includes(INSTRUCTION_LEAD))).toBe(false);
		expect(Object.keys(statuses(await journalList(session)))).toContain(B);
		expect((await driftState(session)).stale).toBeNull();
	}, 180_000);

	it("after a compaction the instruction still without a row is named again, and the list catches up", async () => {
		let compacted = false;
		const agent = steerAgent(fresh => compacted && fresh);
		// Small enough that a compaction of this short session has something to summarize.
		const { provider, session } = await start(
			agent.respond,
			"compaction:\n  keepRecentTokens: 50\n  v2RetainedMessageBudget: 50\n",
		);
		await steeredTurn(session);
		expect(Object.keys(statuses(await journalList(session)))).not.toContain(B);

		const compaction = await session.send({ type: "compact" });
		expect(compaction, JSON.stringify(compaction)).toMatchObject({ success: true });
		compacted = true;
		agent.state.call = true;
		const before = provider.bodies.length;
		await session.turn("Where were we?");

		expect(provider.bodies.slice(before).some(body => body.includes(INSTRUCTION_LEAD))).toBe(true);
		const journal = await journalList(session);
		expect(statuses(journal)).toEqual({ [A]: "in_progress", [A2]: "pending", [B]: "completed" });
		expect(await panel(session)).toEqual({ hydrated: A, live: A });
		expect((await driftState(session)).stale).toBeNull();
	}, 240_000);

	it("a relaunch keeps the panel's reading from the journal, and the list catches up after it", async () => {
		let relaunched = false;
		const agent = steerAgent((_fresh, nudges) => relaunched && nudges > 0);
		const first = await start(agent.respond);
		await steeredTurn(first.session);
		expect(await driftState(first.session)).toMatchObject({ stale: "instruction" });
		await first.session.quit();

		relaunched = true;
		const session = await startOmp({
			...first.agent,
			model: "fake/m1",
			bridge: BRIDGE,
			resume: first.session.root,
		});
		// A window opened after the relaunch: get_state's reading, from the journal alone.
		expect(await driftState(session)).toMatchObject({ stale: "instruction" });
		expect(await panel(session)).toMatchObject({ hydrated: A });

		await session.turn("Where were we?");
		const journal = await journalList(session);
		expect(statuses(journal)).toEqual({ [A]: "in_progress", [A2]: "pending", [B]: "completed" });
		expect((await panel(session)).hydrated).toBe(nowOf(journal));
		expect((await driftState(session)).stale).toBeNull();
	}, 240_000);

	it("a child whose list is a playbook's steps gets the steered instruction named, adds it, finishes it and returns to A", async () => {
		const steps = ["1. Reproduce it", "2. Find the cause", "3. Plan the fix", "4. Verify", "5. Commit", "6. Report"];
		const agent = steerAgent(
			fresh => fresh,
			[
				{ phase: "Bug fix playbook", items: steps },
				{ phase: PHASE, items: [A, A2] },
			],
		);
		const { provider, session } = await start(agent.respond);
		await steeredTurn(
			session,
			'<ompdesk-agent-message from="Main" session="01a1">\nTitle: Build the parser\n\nBuild the parser module for the config files and test it, following the bug fix playbook.\n</ompdesk-agent-message>',
		);

		const steered = provider.bodies.findIndex(body => body.includes(STEER));
		expect(firstWith(provider.bodies, INSTRUCTION_LEAD)).toBe(steered + 1);
		const journal = await journalList(session);
		expect(statuses(journal)).toMatchObject({ [A]: "in_progress", [A2]: "pending", [B]: "completed" });
		expect(nowOf(journal)).toBe(A);
		expect(await panel(session)).toEqual({ hydrated: A, live: A });
		expect((await driftState(session)).stale).toBeNull();
	}, 180_000);

	it("a child whose list is a playbook's steps is told after a long run of calls, and moves its 'now' on", async () => {
		const steps = ["1. Reproduce it", "2. Find the cause", "3. Plan the fix", "4. Verify", "5. Commit", "6. Report"];
		let readsLeft = 30;
		let seen = 0;
		let moved = false;
		const respond = (step: number, body: string): string => {
			const nudges = count(body, DRIFT_LEAD);
			const fresh = nudges > seen;
			seen = nudges;
			if (step === 1)
				return reply.todo({
					op: "init",
					list: [
						{ phase: "Bug fix playbook", items: steps },
						{ phase: "Work", items: ["Fix the date parser", "Add a regression test"] },
					],
				});
			if (fresh && !moved) {
				moved = true;
				return reply.todo({ op: "done", task: steps[0] });
			}
			if (readsLeft-- > 0) return reply.read("notes.md");
			return reply.text("Reported.");
		};
		const { provider, session } = await start(respond);
		writeFileSync(join(session.root, "notes.md"), "the date parser drops the time zone\n");
		await session.turn(
			'<ompdesk-agent-message from="Main" session="01a1">\nTitle: Fix the date parser\n\nThe date parser drops the time zone. Fix it with a regression test, follow the bug fix playbook.\n</ompdesk-agent-message>',
		);

		// One reminder, in the request after the 20th call without a change.
		expect(firstWith(provider.bodies, DRIFT_LEAD)).toBe(21);
		const journal = await journalList(session);
		expect(statuses(journal)[steps[0]]).toBe("completed");
		expect(nowOf(journal)).toBe(steps[1]);
		expect(await panel(session)).toEqual({ hydrated: steps[1], live: steps[1] });
	}, 240_000);
});

const real =
	process.env.OMP_GUI_REAL_WORK === "1" && process.env.TODO_DRIFT_BEFORE_REF !== undefined && existsSync(omp);
const RUNS = Number(process.env.TODO_DRIFT_REAL_RUNS ?? 3);
/**
 * `plain`: a short listed task and a steer that says it is separate work. `casual`: a longer task the model plans
 * itself, and a steer in a person's offhand words several calls in (the shape the owner's sessions show).
 */
const REAL_SCENARIOS = {
	plain: {
		task: "Create notes.md with three short facts about Bun, then count.txt holding the number 3. Track these steps in your todo list before you start. Then run `sleep 10 && echo ready` once, and only after that write the files.",
		steer: "Also, as separate work: create b.txt containing the single word B. Do it now, then continue.",
		marker: "b.txt",
		seed: undefined,
	},
	casual: {
		task: "Plan this in your todo list, then do it: create src/math.ts exporting add, sub, mul and div (div throws on division by zero), then src/math.test.ts with one bun test per function, run `bun test`, and write NOTES.md with two lines on what you built. After writing src/math.ts, run `sleep 15 && echo warm` once before you write the tests.",
		steer: "oh and the readme says teh instead of the, fix that too",
		marker: "readme says teh",
		seed: { file: "README.md", text: "# Math\n\nA small library for teh basic operations.\n" },
	},
} as const;
const SCENARIO_NAMES = (process.env.TODO_DRIFT_REAL_SCENARIOS ?? "plain")
	.split(",")
	.filter((name): name is keyof typeof REAL_SCENARIOS => name in REAL_SCENARIOS);

/**
 * Opt-in (`OMP_GUI_REAL_WORK=1`, `TODO_DRIFT_BEFORE_REF=<commit before todo-drift.ts>`, `TODO_DRIFT_REAL_SCENARIOS`
 * of `plain,casual`): the user's real `smol` model gets a task and, while its `sleep` runs, a steer naming more work;
 * on the bridge of that commit and on this one. Prints `TODO_DRIFT_REAL` lines: whether the list got a row for the
 * steer, whether the reminder came, and whether a row came after it. Only measures; asserts nothing about the model.
 */
describe.skipIf(!real)("a steer into a listed task, on the user's real smol model", () => {
	it("measures how often the list gets a row for the steer", async () => {
		for (const scenario of SCENARIO_NAMES)
			for (let run = 0; run < RUNS; run++)
				for (const [variant, bridge] of [
					["before", bridgeAt(process.env.TODO_DRIFT_BEFORE_REF ?? "")],
					["after", resolve("resources/gui-bridge/index.ts")],
				] as const) {
					const { task, steer, marker, seed } = REAL_SCENARIOS[scenario];
					const { agentDir, isolated, smol } = realAgent();
					const session = await startOmp({ agentDir, isolated, model: smol, bridge });
					if (seed) writeFileSync(join(session.root, seed.file), seed.text);
					const from = session.frames.length;
					const turn = session.turn(task, 900_000);
					const sleeping = () =>
						session.frames
							.slice(from)
							.some(
								frame =>
									frame.type === "tool_execution_start" &&
									frame.toolName === "bash" &&
									String((frame.args as { command?: unknown } | undefined)?.command ?? "").includes("sleep"),
							);
					await expect.poll(sleeping, { timeout: 300_000, interval: 200 }).toBe(true);
					await session.send({ type: "steer", message: steer });
					await turn;
					// Journal order: the steer, then (after the bridge's change) the reminder, and the first list with a new row.
					const branch = await journalBranch(session);
					const text = (entry: JournalEntry) => JSON.stringify(entry.message?.content ?? "");
					const steerAt = branch.findIndex(
						entry => entry.message?.role === "user" && text(entry).includes(marker),
					);
					const known = new Set(
						(branch.slice(0, steerAt).map(listIn).findLast(Boolean) ?? []).flatMap(phase =>
							phase.tasks.map(task => task.content),
						),
					);
					const reminderAt = branch.findIndex(
						(entry, at) =>
							at > steerAt && entry.message?.role === "developer" && text(entry).includes(INSTRUCTION_LEAD),
					);
					const rowAt = branch.findIndex(
						(entry, at) =>
							at > steerAt &&
							(listIn(entry) ?? []).some(phase => phase.tasks.some(task => !known.has(task.content))),
					);
					const line = {
						scenario,
						run,
						variant,
						model: smol,
						listedBeforeSteer: known.size > 0,
						steerJournaled: steerAt >= 0,
						reminded: reminderAt >= 0,
						rowAdded: rowAt >= 0,
						rowAfterReminder: reminderAt >= 0 && rowAt > reminderAt,
						// What the journal held from the steer to the reminder: a reminder after the row means something
						// after it read as a new instruction.
						path:
							reminderAt < 0
								? []
								: branch
										.slice(steerAt, reminderAt + 1)
										.map(entry =>
											[entry.type, entry.message?.role, entry.message?.toolName, text(entry).slice(0, 60)]
												.filter(Boolean)
												.join(":"),
										),
						final: statuses(branch.map(listIn).findLast(Boolean) ?? []),
					};
					console.log(`TODO_DRIFT_REAL=${JSON.stringify(line)}`);
					await session.quit();
				}
	}, 3_600_000);
});
