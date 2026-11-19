import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TODO_DRIFT_MARKER } from "../../resources/gui-bridge/todo-drift-contracts";
import {
	A,
	A2,
	B,
	BRIDGE,
	CHILD_PROMPT,
	driftState,
	journalBranch,
	journalList,
	lastDriftFrame,
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
import { startOmp } from "./bridge-todo-stock-rig";
import { INSTALLED_OMP as omp } from "./test-bridge-probe";

/**
 * The to-do panel tells the truth even when the agent forgets its list (todo-drift.ts): when the list last changed,
 * the instructions received since, and a mark when it is behind the work. Installed omp, the bridge, a scripted
 * agent that never updates its list after the steer (no spend). Each case reads the session file omp wrote and checks
 * the bridge's reading (`todoDrift.state`, what get_state carries, and the last `todo_drift` frame) and the panel's
 * "now" (the renderer's todo store fed with get_state and the frames omp sent) against it: a steer during a running
 * turn, the same across a compaction and a relaunch, a child whose list is a playbook's steps (steered, and after a
 * long run of calls). The agent's reminder is bridge-todo-nudge-stock.test.ts.
 */

const forgets = () => steerAgent(() => false);

async function markers(session: Parameters<typeof journalBranch>[0]): Promise<number> {
	return (await journalBranch(session)).filter(
		entry => entry.type === "custom" && entry.customType === TODO_DRIFT_MARKER,
	).length;
}

describe.skipIf(!existsSync(omp))("the to-do panel's reading of a list behind the work, on stock omp", () => {
	it("lists an instruction steered into a running turn and marks the list behind once the agent works on", async () => {
		const { session } = await start(forgets().respond);
		await steeredTurn(session);

		const journal = await journalList(session);
		expect(Object.keys(statuses(journal))).not.toContain(B);
		expect(await panel(session)).toEqual({ hydrated: nowOf(journal), live: nowOf(journal) });
		const drift = await driftState(session);
		expect(drift).toMatchObject({ stale: "instruction", receivedCount: 1, received: [{ text: STEER }] });
		expect(drift.changedAt).toBeGreaterThan(0);
		expect(lastDriftFrame(session)).toEqual(drift);
		// Journaled once, so the stats script can tell sessions on this bridge from the rest.
		expect(await markers(session)).toBe(1);
	}, 180_000);

	it("folds the received instruction once the list changes", async () => {
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
			if (step === 4) return reply.bash("cat README.md");
			return reply.text("Done.");
		};
		const { session } = await start(respond);
		await steeredTurn(session);

		expect(Object.keys(statuses(await journalList(session)))).toContain(B);
		const drift = await driftState(session);
		expect(drift).toMatchObject({ stale: null, receivedCount: 0, received: [] });
		expect(lastDriftFrame(session)).toEqual(drift);
	}, 180_000);

	it("reads the same after a compaction", async () => {
		const agent = forgets();
		const { session } = await start(agent.respond, SMALL_COMPACTION);
		await steeredTurn(session);
		const compaction = await session.send({ type: "compact" });
		expect(compaction, JSON.stringify(compaction)).toMatchObject({ success: true });
		agent.state.call = true;
		await session.turn("Where were we?");

		expect(await driftState(session)).toMatchObject({
			stale: "instruction",
			receivedCount: 1,
			received: [{ text: STEER }],
		});
		expect(await panel(session)).toEqual({ hydrated: A, live: A });
	}, 240_000);

	it("reads the same after a relaunch, from the journal alone", async () => {
		const agent = forgets();
		const first = await start(agent.respond);
		await steeredTurn(first.session);
		await first.session.quit();

		const session = await startOmp({ ...first.agent, model: "fake/m1", bridge: BRIDGE, resume: first.session.root });
		// A window opened after the relaunch: get_state's reading.
		expect(await driftState(session)).toMatchObject({
			stale: "instruction",
			receivedCount: 1,
			received: [{ text: STEER }],
		});
		expect(await panel(session)).toMatchObject({ hydrated: A });
		agent.state.call = true;
		await session.turn("Where were we?");
		expect(await markers(session)).toBe(1);
	}, 240_000);

	it("lists a steer in a child whose list is a playbook's steps, by its own first line", async () => {
		const agent = steerAgent(
			() => false,
			[
				{ phase: "Bug fix playbook", items: PLAYBOOK },
				{ phase: PHASE, items: [A, A2] },
			],
		);
		const { session } = await start(agent.respond);
		await steeredTurn(session, CHILD_PROMPT);

		const journal = await journalList(session);
		// The opening agent's message made the list, so it is not one received since.
		expect(await driftState(session)).toMatchObject({
			stale: "instruction",
			receivedCount: 1,
			received: [{ text: STEER }],
		});
		expect(await panel(session)).toEqual({ hydrated: nowOf(journal), live: nowOf(journal) });
	}, 180_000);

	it("marks a playbook child's list behind after a long run of calls without a change", async () => {
		let reads = 25;
		const respond = (step: number): string => {
			if (step === 1)
				return reply.todo({
					op: "init",
					list: [
						{ phase: "Bug fix playbook", items: PLAYBOOK },
						{ phase: PHASE, items: [A, A2] },
					],
				});
			return reads-- > 0 ? reply.read("notes.md") : reply.text("Reported.");
		};
		const { session } = await start(respond);
		writeFileSync(join(session.root, "notes.md"), "the parser drops the time zone\n");
		await session.turn(CHILD_PROMPT);

		const journal = await journalList(session);
		expect(await driftState(session)).toMatchObject({ stale: "drift", receivedCount: 0 });
		expect(await panel(session)).toEqual({ hydrated: nowOf(journal), live: nowOf(journal) });
	}, 240_000);
});
