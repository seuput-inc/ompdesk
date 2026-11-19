import { describe, expect, it } from "vitest";
import {
	DRIFT_CALLS,
	journalDriftEvents,
	RECEIVED_SHOWN,
	type TodoDriftEntry,
	type TodoDriftEvent,
	type TodoDriftPhase,
	todoDrift,
	todoDriftState,
	todoNudge,
	todoNudgeText,
} from "../../resources/gui-bridge/todo-drift-core";

const MIN = 60_000;
describe("the panel's received instructions", () => {
	const at = (n: number) => ({ kind: "instruction", at: n, text: `Instruction ${n}\nwith detail` }) as const;
	const listAt = (n: number): TodoDriftEvent => ({
		kind: "list",
		at: n,
		phases: [{ name: "Parser", tasks: [{ content: "Write the parser", status: "in_progress" }] }],
	});

	it("lists every instruction since the list's last change by its first line, the newest five, and clears on a change", () => {
		const received = todoDriftState(todoDrift([listAt(0), ...Array.from({ length: 7 }, (_, i) => at(i + 1))]));
		expect(received.receivedCount).toBe(7);
		expect(received.received.map(item => item.text)).toEqual(
			Array.from({ length: RECEIVED_SHOWN }, (_, i) => `Instruction ${i + 3}`),
		);
		expect(todoDriftState(todoDrift([listAt(0), at(1), listAt(2)]))).toMatchObject({
			received: [],
			receivedCount: 0,
		});
	});

	it("shows an opening agent's message by its title, without the wrapper", () => {
		const text =
			'<ompdesk-agent-message from="Main" session="01a1">\nTitle: Fix the parser\n\nDetails…\n</ompdesk-agent-message>';
		expect(todoDriftState(todoDrift([listAt(0), { kind: "instruction", at: 1, text }])).received).toEqual([
			{ at: 1, text: "Fix the parser" },
		]);
	});
});

const LIST: TodoDriftPhase[] = [
	{
		name: "Parser",
		tasks: [
			{ content: "Write the parser", status: "in_progress" },
			{ content: "Test the parser", status: "pending" },
		],
	},
];

const list = (at = 0, phases = LIST): TodoDriftEvent => ({ kind: "list", at, phases });
const calls = (n: number, from = 1, step = 1_000): TodoDriftEvent[] =>
	Array.from({ length: n }, (_, i) => ({ kind: "call", at: from + i * step }));

/** Steps in order, then what the agent reads after the last one. */
function nudgeAfter(events: TodoDriftEvent[]) {
	return todoNudge(todoDrift(events));
}

describe("todo drift: when a list is behind the work", () => {
	it("names an instruction after the first call that follows it, once", () => {
		const steered: TodoDriftEvent[] = [
			list(),
			...calls(2),
			{ kind: "instruction", at: 5_000, text: "Also fix the README typo" },
		];
		expect(nudgeAfter(steered)).toBeUndefined();
		const worked = [...steered, ...calls(1, 6_000)];
		expect(nudgeAfter(worked)).toBe("instruction");
		expect(todoDrift(worked).stale).toBe("instruction");
		const named = [...worked, { kind: "nudge", at: 7_000, nudge: "instruction" } as const, ...calls(3, 8_000)];
		expect(nudgeAfter(named)).toBeUndefined();
		// The panel keeps the mark until the list changes.
		expect(todoDrift(named).stale).toBe("instruction");
		expect(todoDrift([...named, list(20_000)]).stale).toBeUndefined();
	});

	it("names it again after a compaction took the reminder out of the model's context", () => {
		const named: TodoDriftEvent[] = [
			list(),
			{ kind: "instruction", at: 1, text: "Also fix the README typo" },
			...calls(1, 2),
			{ kind: "nudge", at: 3, nudge: "instruction" },
			{ kind: "compaction", at: 4 },
			...calls(1, 5),
		];
		expect(nudgeAfter(named)).toBe("instruction");
	});

	it("names a list unchanged for DRIFT_CALLS calls, then backs off while it stays ignored", () => {
		expect(nudgeAfter([list(), ...calls(DRIFT_CALLS - 1)])).toBeUndefined();
		const long = [list(), ...calls(DRIFT_CALLS)];
		expect(nudgeAfter(long)).toBe("drift");
		const ignored = [...long, { kind: "nudge", at: 99_000, nudge: "drift" } as const];
		expect(nudgeAfter([...ignored, ...calls(2 * DRIFT_CALLS - 1, 100_000)])).toBeUndefined();
		expect(nudgeAfter([...ignored, ...calls(2 * DRIFT_CALLS, 100_000)])).toBe("drift");
	});

	it("waits a full run after stock's own mid-run nudge, so the agent never reads two at once", () => {
		const events: TodoDriftEvent[] = [list(), ...calls(12), { kind: "nudge", at: 20_000, nudge: "stock-mid-run" }];
		expect(nudgeAfter([...events, ...calls(DRIFT_CALLS - 1, 21_000)])).toBeUndefined();
		expect(nudgeAfter([...events, ...calls(DRIFT_CALLS, 21_000)])).toBe("drift");
	});

	it("marks a list behind after 15 active minutes, a long wait for a person counting five", () => {
		expect(todoDrift([list(), ...calls(4, 0, 5 * MIN)]).stale).toBe("drift");
		expect(todoDrift([list(), ...calls(2, 60 * MIN, 60 * MIN)]).stale).toBeUndefined();
	});

	it("says nothing about a finished list", () => {
		const done: TodoDriftPhase[] = [
			{ name: "Parser", tasks: [{ content: "Write the parser", status: "completed" }] },
		];
		const events: TodoDriftEvent[] = [
			list(0, done),
			{ kind: "instruction", at: 1, text: "Now add a CLI" },
			...calls(30, 2),
		];
		expect(nudgeAfter(events)).toBeUndefined();
		expect(todoDrift(events).stale).toBeUndefined();
	});

	it("tells the agent what the list shows and what to do", () => {
		const drift = todoDrift([
			list(),
			{ kind: "instruction", at: 1, text: "Also fix the README typo" },
			...calls(1, 2),
		]);
		const text = todoNudgeText("instruction", drift);
		expect(text).toContain('"Also fix the README typo"');
		expect(text).toContain('"Write the parser" in progress (0/2 done)');
	});
});

describe("todo drift read from a journal", () => {
	const at = (s: number) => new Date(s * 1_000).toISOString();
	const user = (s: number, text: string, extra: Record<string, unknown> = {}): TodoDriftEntry => ({
		type: "message",
		timestamp: at(s),
		message: { role: "user", content: [{ type: "text", text }], ...extra },
	});
	const result = (s: number, toolName: string): TodoDriftEntry => ({
		type: "message",
		timestamp: at(s),
		message: { role: "toolResult", toolName },
	});

	it("counts work calls and new requests after the list's entry, never questions, synthetic or agent turns", () => {
		const branch: TodoDriftEntry[] = [
			user(0, "Build the parser module and test it"),
			result(1, "todo"),
			result(2, "bash"),
			user(3, "why did the build fail?"),
			user(4, "Continue the parser work please", { synthetic: true }),
			user(5, "Spawned subagent result", { attribution: "agent" }),
			result(6, "todo"),
			user(7, "Also fix the README typo right away"),
			result(8, "read"),
			{ type: "compaction", timestamp: at(9) },
		];
		expect(journalDriftEvents(branch, 1, LIST).map(event => event.kind)).toEqual([
			"list",
			"call",
			"instruction",
			"call",
			"compaction",
		]);
	});

	it("knows its own reminders and stock's once journaled", () => {
		const drift = todoDrift([list(), ...calls(DRIFT_CALLS)]);
		const branch: TodoDriftEntry[] = [
			result(0, "todo"),
			{ type: "message", timestamp: at(1), message: { role: "developer", content: todoNudgeText("drift", drift) } },
			{ type: "custom_message", customType: "mid-run-todo-nudge", timestamp: at(2) },
		];
		expect(journalDriftEvents(branch, 0, LIST).slice(1)).toEqual([
			{ kind: "nudge", at: 1_000, nudge: "drift" },
			{ kind: "nudge", at: 2_000, nudge: "stock-mid-run" },
		]);
	});
});
