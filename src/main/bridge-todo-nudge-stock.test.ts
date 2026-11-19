import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DRIFT_LEAD, INSTRUCTION_LEAD } from "../../resources/gui-bridge/todo-drift-core";
import {
	A,
	A2,
	B,
	BRIDGE,
	CHILD_PROMPT,
	count,
	driftState,
	firstWith,
	type JournalEntry,
	journalBranch,
	journalList,
	listIn,
	nowOf,
	PHASE,
	PLAYBOOK,
	panel,
	reply,
	SMALL_COMPACTION,
	STEER,
	start,
	statuses,
	steerAgent,
	steeredTurn,
} from "./bridge-todo-drift-rig";
import { bridgeAt, realAgent, startOmp } from "./bridge-todo-stock-rig";
import { INSTALLED_OMP as omp } from "./test-bridge-probe";

/**
 * The agent's reminder of a todo list behind the work (todo-nudge.ts): an instruction steered into a running turn, or
 * a long run of calls, is named to the model after a tool call. Installed omp, the bridge, a scripted agent that
 * catches its list up only when a reminder reaches it in a request (no spend), so the journal shows the list caught
 * up only where the reminder came at the right point: work on A, instruction B steered in and finished in the same
 * turn, back to A; the same across a compaction, a relaunch and in a child whose list is a playbook's steps. With
 * `TODO_DRIFT_BRIDGE_REF=<commit>` every case runs on that commit's bridge (red on one without todo-nudge.ts).
 */

describe.skipIf(!existsSync(omp))("the agent's reminder of a todo list behind the work, on stock omp", () => {
	it("names an instruction steered into a running turn after the next call; the list then adds it, finishes it and returns to A", async () => {
		const agent = steerAgent(fresh => fresh);
		const { provider, session } = await start(agent.respond);
		await steeredTurn(session);

		// The reminder comes in the request after the first call that followed the steer, once.
		const steered = provider.bodies.findIndex(body => body.includes(STEER));
		expect(firstWith(provider.bodies, INSTRUCTION_LEAD)).toBe(steered + 1);
		expect(count(provider.bodies.at(-1) ?? "", INSTRUCTION_LEAD)).toBe(1);

		const journal = await journalList(session);
		expect(statuses(journal)).toEqual({ [A]: "in_progress", [A2]: "pending", [B]: "completed" });
		expect(await panel(session)).toEqual({ hydrated: A, live: A });
		expect(await driftState(session)).toMatchObject({ stale: null, receivedCount: 0 });
	}, 180_000);

	it("says nothing to an agent that adds the row beside its first call for the instruction", async () => {
		let answered = false;
		const respond = (step: number, body: string): string => {
			if (step === 1) return reply.todo({ op: "init", list: [{ phase: PHASE, items: [A, A2] }] });
			if (step === 2) return reply.bash("sleep 3; echo parsed");
			if (body.includes(STEER) && !answered) {
				answered = true;
				return reply.calls([
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
	}, 180_000);

	it("names the instruction again after a compaction took the first reminder away, and the list catches up", async () => {
		let compacted = false;
		const agent = steerAgent(fresh => compacted && fresh);
		const { provider, session } = await start(agent.respond, SMALL_COMPACTION);
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
	}, 240_000);

	it("keeps the reminder across a relaunch, and the list catches up after it", async () => {
		let relaunched = false;
		const agent = steerAgent((_fresh, nudges) => relaunched && nudges > 0);
		const first = await start(agent.respond);
		await steeredTurn(first.session);
		await first.session.quit();

		relaunched = true;
		const session = await startOmp({ ...first.agent, model: "fake/m1", bridge: BRIDGE, resume: first.session.root });
		await session.turn("Where were we?");
		const journal = await journalList(session);
		expect(statuses(journal)).toEqual({ [A]: "in_progress", [A2]: "pending", [B]: "completed" });
		expect((await panel(session)).hydrated).toBe(nowOf(journal));
		expect((await driftState(session)).stale).toBeNull();
	}, 240_000);

	it("names a steer in a child whose list is a playbook's steps; it adds it, finishes it and returns to A", async () => {
		const agent = steerAgent(
			fresh => fresh,
			[
				{ phase: "Bug fix playbook", items: PLAYBOOK },
				{ phase: PHASE, items: [A, A2] },
			],
		);
		const { provider, session } = await start(agent.respond);
		await steeredTurn(session, CHILD_PROMPT);

		const steered = provider.bodies.findIndex(body => body.includes(STEER));
		expect(firstWith(provider.bodies, INSTRUCTION_LEAD)).toBe(steered + 1);
		const journal = await journalList(session);
		expect(statuses(journal)).toMatchObject({ [A]: "in_progress", [A2]: "pending", [B]: "completed" });
		expect(nowOf(journal)).toBe(A);
		expect(await panel(session)).toEqual({ hydrated: A, live: A });
	}, 180_000);

	it("tells a playbook child after a long run of calls, and it moves its 'now' on", async () => {
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
						{ phase: "Bug fix playbook", items: PLAYBOOK },
						{ phase: "Work", items: ["Fix the date parser", "Add a regression test"] },
					],
				});
			if (fresh && !moved) {
				moved = true;
				return reply.todo({ op: "done", task: PLAYBOOK[0] });
			}
			if (readsLeft-- > 0) return reply.read("notes.md");
			return reply.text("Reported.");
		};
		const { provider, session } = await start(respond);
		writeFileSync(join(session.root, "notes.md"), "the date parser drops the time zone\n");
		await session.turn(CHILD_PROMPT);

		// One reminder, in the request after the 20th call without a change.
		expect(firstWith(provider.bodies, DRIFT_LEAD)).toBe(21);
		const journal = await journalList(session);
		expect(statuses(journal)[PLAYBOOK[0]]).toBe("completed");
		expect(nowOf(journal)).toBe(PLAYBOOK[1]);
		expect(await panel(session)).toEqual({ hydrated: PLAYBOOK[1], live: PLAYBOOK[1] });
	}, 240_000);
});

const real =
	process.env.OMP_GUI_REAL_WORK === "1" && process.env.TODO_DRIFT_BEFORE_REF !== undefined && existsSync(omp);
const RUNS = Number(process.env.TODO_DRIFT_REAL_RUNS ?? 3);

/**
 * `plain`: a short listed task and a steer that says it is separate work. `casual`: a longer task the model plans
 * itself, and a steer in a person's offhand words several calls in. `long`: a playbook's steps as the list and thirty
 * reads, with no steer.
 */
interface RealScenario {
	task: string;
	steer?: string;
	/** Words of the steer, to find it in the journal. */
	marker: string;
	seed?: (root: string) => void;
}
const REAL_SCENARIOS: Record<string, RealScenario> = {
	plain: {
		task: "Create notes.md with three short facts about Bun, then count.txt holding the number 3. Track these steps in your todo list before you start. Then run `sleep 10 && echo ready` once, and only after that write the files.",
		steer: "Also, as separate work: create b.txt containing the single word B. Do it now, then continue.",
		marker: "b.txt",
	},
	casual: {
		task: "Plan this in your todo list, then do it: create src/math.ts exporting add, sub, mul and div (div throws on division by zero), then src/math.test.ts with one bun test per function, run `bun test`, and write NOTES.md with two lines on what you built. After writing src/math.ts, run `sleep 15 && echo warm` once before you write the tests.",
		steer: "oh and the readme says teh instead of the, fix that too",
		marker: "readme says teh",
		seed: root => writeFileSync(join(root, "README.md"), "# Math\n\nA small library for teh basic operations.\n"),
	},
	long: {
		task: "Follow the bug fix playbook and put its steps in your todo list first: 1. Reproduce, 2. Find the cause, 3. Fix, 4. Verify, 5. Report. The report says the total in data/ is wrong. Read every file in data/ with the read tool, one file per call (never several files in one call), then write SUM.md with the total of the numbers they hold.",
		marker: "\u0000",
		seed: root => {
			mkdirSync(join(root, "data"));
			for (let index = 1; index <= 30; index++)
				writeFileSync(join(root, "data", `f${String(index).padStart(2, "0")}.txt`), `${index}\n`);
		},
	},
};
const SCENARIO_NAMES = (process.env.TODO_DRIFT_REAL_SCENARIOS ?? "plain")
	.split(",")
	.filter(name => REAL_SCENARIOS[name]);

/** The run's shape: each assistant message's calls by tool (`read×6`), `N:<kind>` for a reminder. */
function shape(branch: readonly JournalEntry[], text: (entry: JournalEntry) => string): string {
	return branch
		.flatMap(entry => {
			const message = entry.message;
			if (message?.role === "developer") {
				const words = text(entry);
				return words.includes(INSTRUCTION_LEAD) ? ["N:instruction"] : words.includes(DRIFT_LEAD) ? ["N:drift"] : [];
			}
			if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
			const names = (message.content as Array<{ type?: string; name?: string }>)
				.filter(part => part.type === "toolCall")
				.map(part => part.name ?? "?");
			if (names.length === 0) return [];
			const counts = new Map<string, number>();
			for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
			return [[...counts].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join("+")];
		})
		.join(" ");
}

/**
 * Opt-in (`OMP_GUI_REAL_WORK=1`, `TODO_DRIFT_BEFORE_REF=<commit before todo-nudge.ts>`, `TODO_DRIFT_REAL_SCENARIOS`
 * of `plain,casual,long`): the user's real `smol` model gets a task and, while its `sleep` runs, a steer naming more
 * work; on the bridge of that commit and on this one. Prints `TODO_DRIFT_REAL` lines: whether the list got a row for
 * the steer, the run's shape, the longest stretch of calls without a list change, and each reminder. Only measures.
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
					seed?.(session.root);
					const from = session.frames.length;
					const turn = session.turn(task, 900_000);
					if (steer) {
						const sleeping = () =>
							session.frames
								.slice(from)
								.some(
									frame =>
										frame.type === "tool_execution_start" &&
										frame.toolName === "bash" &&
										String((frame.args as { command?: unknown } | undefined)?.command ?? "").includes(
											"sleep",
										),
								);
						await expect.poll(sleeping, { timeout: 300_000, interval: 200 }).toBe(true);
						await session.send({ type: "steer", message: steer });
					}
					await turn;
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
						steerJournaled: steerAt >= 0,
						reminded: reminderAt >= 0,
						rowAdded: rowAt >= 0,
						rowAfterReminder: reminderAt >= 0 && rowAt > reminderAt,
						shape: shape(branch, text),
						// The longest run of work calls between two todo calls that changed the list, while it had open items.
						longestUnchanged: branch.reduce(
							(state, entry) => {
								const list = listIn(entry);
								if (list) {
									const open = list.some(phase =>
										phase.tasks.some(task => /pending|in_progress/.test(task.status)),
									);
									return { open, now: 0, max: state.max };
								}
								if (entry.message?.role !== "toolResult" || !state.open) return state;
								return { open: true, now: state.now + 1, max: Math.max(state.max, state.now + 1) };
							},
							{ open: false, now: 0, max: 0 },
						).max,
					};
					console.log(`TODO_DRIFT_REAL=${JSON.stringify(line)}`);
					await session.quit();
				}
	}, 3_600_000);
});
