import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	bridgeAt,
	type Frame,
	fakeAgent,
	realAgent,
	sse,
	startOmp,
	startProvider,
	todoOps,
	toolCall,
} from "./bridge-todo-stock-rig";
import { INSTALLED_OMP as omp, runStock, stockSource } from "./test-bridge-probe";

/**
 * A long session appended round after round to one todo list until the work board read 33/38 (todo-compact-core.ts).
 * The bridge keeps unfinished items and their statuses and asks the agent to append new work by phase.
 *
 * 1. Installed omp, scripted provider, no spend: the line reaches the model in the request right after the append that
 *    passed 20 items, not after the append that reached 20, and a `done` on the long list adds no second one.
 * 2. Opt-in (`OMP_GUI_REAL_WORK=1`, `TODO_COMPACT_BEFORE_REF=<commit before the feature>`): the user's real `smol`
 *    model takes a blocked item and then batch after batch of small file tasks, each tracked in its todo list, on the
 *    bridge of that commit and on this one; prints `TODO_COMPACT_REAL` lines with each turn's list size and ops.
 */

const LINE = "Your todo list now holds";

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

describe.skipIf(!existsSync(omp))("a todo list grown long by appends, on stock omp", () => {
	it("keeps finished history in place after the append that made the list long", async () => {
		const items = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
		const script = [
			toolCall("todo", { op: "init", list: [{ phase: "Rounds", items: items("round", 12) }] }),
			toolCall("todo", { op: "done", phase: "Rounds" }),
			toolCall("todo", { op: "append", phase: "Rounds", items: items("next", 8) }),
			toolCall("todo", { op: "append", phase: "Rounds", items: ["review round 21"] }),
			toolCall("todo", { op: "done", task: "next 1" }),
		];
		const provider = await startProvider(step =>
			step <= script.length ? sse(script[step - 1], "tool_calls") : sse([{ content: "DONE" }], "stop"),
		);
		const session = await startOmp({
			...fakeAgent(provider.url),
			model: "fake/m1",
			bridge: resolve("resources/gui-bridge/index.ts"),
		});
		const frames = await session.turn("Run the review rounds");
		expect(todoOps(frames)).toEqual(["init", "done", "append", "append", "done"]);
		const [, , , atTwenty, atTwentyOne, afterDone] = provider.bodies;
		expect(occurrences(atTwenty, LINE)).toBe(0);
		expect(occurrences(atTwentyOne, LINE)).toBe(1);
		expect(atTwentyOne).toContain("now holds 21 items, 12 of them finished");
		expect(atTwentyOne).toContain("Leave finished history in place");
		expect(atTwentyOne).not.toContain("Fold the finished items with your next todo call");
		// After the call's result: the cached prefix in front of it stays as it was.
		expect(atTwentyOne.lastIndexOf(LINE)).toBeGreaterThan(atTwentyOne.lastIndexOf("review round 21"));
		expect(occurrences(afterDone, LINE)).toBe(1);
	}, 180_000);

	it("refuses replacement before stock loses unfinished work, including two edits prepared in one response", async () => {
		const old = { op: "append", phase: "Earlier", items: ["Active", "Pending"] };
		const fresh = { list: [{ phase: "New", items: ["Later"] }] };
		const script = [
			[...toolCall("todo", old), ...toolCall("todo", { op: "init", ...fresh }, 1)],
			toolCall("todo", { op: "init", ...fresh }),
			toolCall("todo", fresh),
			toolCall("todo", { op: "append", phase: "New", items: ["Later"] }),
			toolCall("todo", { op: "done", phase: "Earlier" }),
			toolCall("todo", { op: "drop", task: "Later" }),
			toolCall("todo", { op: "init", list: [{ phase: "Next", items: ["Next project"] }] }),
			toolCall("todo", { op: "done", task: "Next project" }),
		];
		const provider = await startProvider(step =>
			step <= script.length ? sse(script[step - 1], "tool_calls") : sse([{ content: "DONE" }], "stop"),
		);
		const session = await startOmp({
			...fakeAgent(provider.url),
			model: "fake/m1",
			bridge: resolve("resources/gui-bridge/index.ts"),
		});
		const frames = await session.turn("Track the earlier request alongside the new one");
		const results = frames.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "todo");
		expect(results.map(frame => !!frame.isError)).toEqual([
			false,
			true,
			true,
			true,
			false,
			false,
			false,
			false,
			false,
		]);
		expect(provider.bodies[2]).toContain("Append new items with a phase");
		expect(results[4].result?.details?.phases).toEqual([
			{
				name: "Earlier",
				tasks: [
					{ content: "Active", status: "in_progress" },
					{ content: "Pending", status: "pending" },
				],
			},
			{ name: "New", tasks: [{ content: "Later", status: "pending" }] },
		]);
		expect(results[7].result?.details?.phases?.flatMap(phase => phase.tasks)).toEqual([
			{ content: "Next project", status: "in_progress" },
		]);
	}, 180_000);

	it("keeps a legacy blocked task and its reason while another agent starts its own list", () => {
		const source = stockSource("pi-coding-agent", "tools/todo.ts");
		if (!source) throw new Error("installed TodoTool not found");
		const old = [
			{ name: "Review", tasks: [{ content: "Review data", status: "blocked", reason: "Waiting for data" }] },
		];
		const read = runStock(`
			import { TodoTool } from ${JSON.stringify(pathToFileURL(source).href)};
			import { install } from ${JSON.stringify(pathToFileURL(resolve("resources/gui-bridge/todo-compact.ts")).href)};
			const hooks = new Map();
			const states = new Map([["parent", ${JSON.stringify(old)}], ["child", []]]);
			const session = id => ({
				getSessionFile: () => undefined, getTodoPhases: () => states.get(id),
				setTodoPhases: phases => states.set(id, phases),
			});
			const registry = { get: id => ({ session: session(id) }) };
			install({ on: (name, hook) => hooks.set(name, hook), pi: { AgentRegistry: { global: () => registry } } });
			async function init(id) {
				const input = { op: "init", list: [{ phase: "Child work", items: ["Next"] }] };
				const event = { toolName: "todo", toolCallId: "call", input };
				const ctx = { agent: { id } };
				const refusal = hooks.get("tool_call")(event, ctx);
				if (refusal?.block) return refusal.reason;
				await new TodoTool(session(id)).execute("call", input);
				return "ran";
			}
			const child = await init("child");
			const parent = await init("parent");
			console.log(JSON.stringify({ child, parent, states: Object.fromEntries(states) }));
		`);
		expect(read).toEqual({
			child: "ran",
			parent: expect.stringContaining("unfinished work"),
			states: { parent: old, child: [{ name: "Child work", tasks: [{ content: "Next", status: "in_progress" }] }] },
		});
	});
});

const real =
	process.env.OMP_GUI_REAL_WORK === "1" && process.env.TODO_COMPACT_BEFORE_REF !== undefined && existsSync(omp);
const RUNS = Number(process.env.TODO_COMPACT_REAL_RUNS ?? 1);
const BATCHES = Number(process.env.TODO_COMPACT_REAL_BATCHES ?? 8);
const BLOCKED = "Benchmark the parser";

function script(): string[] {
	const batch = (n: number) => [3 * n + 1, 3 * n + 2, 3 * n + 3];
	const files = (n: number) => batch(n).map(i => `f${i}.txt holding ${i}`);
	return [
		`We will do a series of small file tasks in this session; track every task in your todo list. First add the item "${BLOCKED} (waiting for the owner's dataset)": it stays open until I send the data. Then create ${files(0).join(", ")}, one todo item each, and mark each done.`,
		...Array.from(
			{ length: BATCHES - 1 },
			(_, k) => `Next: create ${files(k + 1).join(", ")}. Track each as a todo item and mark each done.`,
		),
	];
}

type Phases = NonNullable<NonNullable<Frame["result"]>["details"]>["phases"];

function lastList(frames: readonly Frame[]): Phases | undefined {
	return frames.findLast(
		frame =>
			frame.type === "tool_execution_end" &&
			frame.toolName === "todo" &&
			!frame.isError &&
			frame.result?.details?.op !== "view",
	)?.result?.details?.phases;
}

describe.skipIf(!real)("a todo list grown long by appends, on the user's real smol model", () => {
	it("keeps the earlier request unfinished across batches", async () => {
		const results: Array<{ variant: string; turns: Array<{ size: number; ops: string[] }>; blocked: string }> = [];
		for (let run = 0; run < RUNS; run++)
			for (const [variant, bridge] of [
				["before", bridgeAt(process.env.TODO_COMPACT_BEFORE_REF ?? "")],
				["after", resolve("resources/gui-bridge/index.ts")],
			] as const) {
				const { agentDir, isolated, smol } = realAgent();
				const session = await startOmp({ agentDir, isolated, model: smol, bridge });
				const turns: Array<{ size: number; ops: string[] }> = [];
				let phases: Phases | undefined;
				for (const prompt of script()) {
					const frames = await session.turn(prompt);
					phases = lastList(frames) ?? phases;
					turns.push({ size: phases?.flatMap(phase => phase.tasks).length ?? 0, ops: todoOps(frames) });
				}
				const blocked = phases?.flatMap(phase => phase.tasks).find(task => task.content.includes(BLOCKED));
				const line = { run, variant, model: smol, turns, blocked: blocked?.status ?? "missing", final: phases };
				results.push(line);
				console.log(`TODO_COMPACT_REAL=${JSON.stringify(line)}`);
			}
		for (const line of results)
			if (line.variant === "after") expect(["blocked", "pending", "in_progress"]).toContain(line.blocked);
	}, 3_600_000);
});
