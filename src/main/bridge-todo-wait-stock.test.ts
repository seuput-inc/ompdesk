import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeAgent, type Omp, sse, startOmp, startProvider, toolCall } from "./bridge-todo-stock-rig";
import { INSTALLED_OMP as omp } from "./test-bridge-probe";

/**
 * Stock's stop-time todo reminder ("You stopped with N incomplete todo item(s) … (Reminder 1/3)") woke a session that
 * ended its turn only because its open items wait on another session; it wrote a second "still waiting" answer and the
 * person read the same thing twice. The bridge (todo-wait.ts) keeps the reminder from waking such a session, and
 * leaves it for one that has something to continue.
 *
 * The provider scripts the same turns every time: a todo list, one more step or none, then a plain answer. The
 * reminder is read where the model reads it: in the request that follows the answer.
 */

const OPEN = "ompdesk_session_open";
const SEND = "ompdesk_session_send";
const LOCAL_ITEM = "Classify local branches";

interface Script {
	items: string[];
	delegate?: typeof OPEN | typeof SEND;
	answer?: string;
}

/** A delegated review never replies. On a reminder the agent finishes the independent local item. */
async function start(script: Script): Promise<{ bodies: string[]; session: Omp }> {
	const { delegate } = script;
	const provider = await startProvider((step, body) => {
		if (step === 1)
			return sse(toolCall("todo", { op: "init", list: [{ phase: "Work", items: script.items }] }), "tool_calls");
		if (step === 2 && delegate) {
			const args = { message: "Review the build", ...(delegate === SEND ? { session: "Reviewer" } : {}) };
			return sse(toolCall(delegate, args), "tool_calls");
		}
		if (step === 4 && delegate && body.includes("You stopped with"))
			return sse(toolCall("todo", { op: "done", task: LOCAL_ITEM }), "tool_calls");
		return sse([{ content: script.answer ?? "Nothing more to do for now." }], "stop");
	});
	const session = await startOmp({
		...fakeAgent(provider.url),
		model: "fake/m1",
		bridge: resolve("resources/gui-bridge/index.ts"),
		hostTools: delegate
			? {
					[delegate]: {
						description: "Request a review",
						parameters: {
							type: "object",
							properties: { session: { type: "string" }, message: { type: "string" } },
						},
						answer:
							delegate === SEND
								? 'Sent to "Reviewer" (saved id 01a1cd44-3e97-7345-a8cc-e9211a49f216, on Desktop): accepted'
								: "Opened session 15c8906674c31761 in /w. It is working on your message.",
					},
				}
			: undefined,
	});
	return { bodies: provider.bodies, session };
}

/** The main agent's requests that carried stock's reminder. */
function reminded(bodies: readonly string[]): number {
	return bodies.filter(body => body.includes("You stopped with")).length;
}

describe.skipIf(!existsSync(omp))("stock's todo reminder on a session that waits, on stock omp", () => {
	it("still reminds a session that stopped with an item it can act on", async () => {
		const { bodies, session } = await start({ items: ["Integrate the result", "Write the report"] });
		await session.turn("Work through the list");
		expect(reminded(bodies)).toBe(1);
		expect(bodies.at(-1)).toContain("You stopped with 2 incomplete todo item(s)");
	}, 180_000);

	it("does not wake a session whose open items are all written as waiting", async () => {
		const { bodies, session } = await start({ items: ["Wait for the inquiry tab's reply", "대기: CI 결과"] });
		await session.turn("Work through the list");
		expect(bodies).toHaveLength(2);
		expect(reminded(bodies)).toBe(0);
	}, 180_000);

	it.each([OPEN, SEND] as const)("keeps independent work actionable after %s", async delegate => {
		const waiting = "Wait for the review";
		const { bodies, session } = await start({ items: [waiting, LOCAL_ITEM], delegate });
		const frames = await session.turn("Request a review and classify the local branches");
		expect(frames.some(frame => frame.type === "host_tool_call" && frame.toolName === delegate)).toBe(true);
		expect(bodies[3]).toContain("You stopped with 2 incomplete todo item(s)");
		const done = frames.find(frame => frame.type === "tool_execution_end" && frame.result?.details?.op === "done");
		expect(done?.result?.details?.phases?.[0]?.tasks).toEqual([
			{ content: waiting, status: "in_progress" },
			{ content: LOCAL_ITEM, status: "completed" },
		]);
		expect(frames.filter(frame => frame.type === "todo_reminder")).toHaveLength(1);
	}, 180_000);

	it("leaves a request for approval with the person", async () => {
		const { bodies, session } = await start({ items: [LOCAL_ITEM], answer: "May I proceed?" });
		await session.turn("Ask for approval before continuing");
		expect(reminded(bodies)).toBe(0);
	}, 180_000);
});
