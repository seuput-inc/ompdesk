import { describe, expect, it } from "vitest";
import type { UiTodoPhase, UiTodoTask } from "../../../stores/todo";
import { buildDockModel, reorderOpenTasks } from "./dock-summary";

function task(id: string, status: UiTodoTask["status"]): UiTodoTask {
	return { id, content: id, status };
}

const phase = (id: string, tasks: UiTodoTask[]): UiTodoPhase => ({ id, name: id, tasks });

describe("todo dock model", () => {
	it("pins the active row and its phase without changing the order stored by the session", () => {
		const phases = Array.from({ length: 33 }, (_, i) => phase(String(i + 1), []));
		for (const i of [0, 2, 5, 10, 18, 24, 30, 32]) {
			phases[i]!.tasks = [
				task(`${i}a`, "pending"),
				task(`${i}b`, i === 24 ? "in_progress" : "blocked"),
				task(`${i}c`, "pending"),
			];
		}
		const model = buildDockModel(phases);
		expect(model.total).toBe(24);
		expect(model.phases.map(p => p.id)).toEqual(["25", "1", "3", "6", "11", "19", "31", "33"]);
		expect(model.phases[0]?.tasks.map(t => t.id)).toEqual(["24b", "24a", "24c"]);
		expect(phases[24]?.tasks.map(t => t.id)).toEqual(["24a", "24b", "24c"]);
	});

	it("counts completed, not abandoned, in phase and overall progress and retains all closed rows", () => {
		const phases = [
			phase("mix", [
				...Array.from({ length: 4 }, (_, i) => task(`done${i}`, "completed")),
				...Array.from({ length: 6 }, (_, i) => task(`open${i}`, "pending")),
				task("drop1", "abandoned"),
				task("drop2", "abandoned"),
			]),
		];
		const model = buildDockModel(phases);
		expect(model).toMatchObject({ done: 4, total: 10 });
		expect(model.phaseCounts.get("mix")).toEqual({ done: 4, total: 10 });
		expect(model.closed[0]?.tasks.map(t => t.id)).toEqual(["done0", "done1", "done2", "done3", "drop1", "drop2"]);
	});

	it("ranks facts ahead of next and finished without assigning a turn clock to the task", () => {
		const model = buildDockModel([phase("work", [task("Next", "pending"), task("Active", "in_progress")])], {
			attention: "Approve?",
			failure: "Check failed",
			finished: "One passed",
			step: "Reading file",
			runners: [{ id: "runner", title: "Review", step: "Reviewing tests" }],
			nextLabel: name => `Next: ${name}`,
		});
		expect(model.lines.map(l => [l.kind, l.text])).toEqual([
			["attention", "Approve?"],
			["failure", "Check failed"],
			["active", "Active · Reading file"],
			["running", "Review · Reviewing tests"],
			["next", "Next: Next"],
			["finished", "One passed"],
		]);
	});

	it("requires the exact session and a unique task matching the item number token or full title", () => {
		const link = { number: 1, session: "worker", title: "Exact title" };
		const runner = { id: "r", session: "worker", title: "Review" };
		const match = (names: string[], session = "worker") =>
			buildDockModel(
				[
					phase(
						"work",
						names.map(n => task(n, "pending")),
					),
				],
				{
					links: [link],
					runners: [{ ...runner, session }],
				},
			).runners[0]?.taskId;
		expect(match(["issue #10", "review (#1)"])).toBe("review (#1)");
		expect(match(["Exact title"])).toBe("Exact title");
		expect(match(["prefix Exact title", "issue #10", "x#1", "#1a"])).toBeUndefined();
		expect(match(["review #1"], "worker-2")).toBeUndefined();
		expect(match(["review #1", "Exact title"])).toBeUndefined();
	});

	it("moves only draggable open slots, leaving active, finished and abandoned positions alone", () => {
		const tasks = [
			task("a", "pending"),
			task("done", "completed"),
			task("b", "blocked"),
			task("pin", "in_progress"),
			task("drop", "abandoned"),
			task("c", "pending"),
		];
		expect(reorderOpenTasks(tasks, "c", "a").map(t => t.id)).toEqual(["c", "done", "a", "pin", "drop", "b"]);
		expect(reorderOpenTasks(tasks, "a", "pin")).toBe(tasks);
	});
});
