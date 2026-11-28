/**
 * gui-bridge agent-control.ts worker contract: a session another agent opened journals `ompdesk.worker`
 * (`agent_control.worker`, once), and from then on its main agent's prompt carries the contract; a session without
 * the entry (the parent, anything the user opened) and a worker's own subagents never do.
 */
import { describe, expect, it } from "vitest";
import { install, methods, WORKER_CONTRACT, WORKER_ENTRY } from "../../resources/gui-bridge/agent-control";
import type { JournalEntry, PromptSectionContext, PromptSectionHost } from "../../resources/gui-bridge/prompt-sections";

type BridgeEnv = Parameters<NonNullable<(typeof methods)[string]>>[1];
type Handler = Parameters<PromptSectionHost["on"]>[1];

/** Every `before_agent_start` hook `install` adds, run in order as stock runs them; the last answer wins. */
function hook(): Handler {
	const handlers: Handler[] = [];
	const on = (event: string, handler: Handler) => {
		if (event === "before_agent_start") handlers.push(handler);
	};
	install({ on: on as Parameters<typeof install>[0]["on"] });
	return (event, ctx) =>
		handlers.reduce<ReturnType<Handler>>((answer, handler) => handler(event, ctx) ?? answer, undefined);
}

function session(entries: JournalEntry[], kind = "main"): PromptSectionContext {
	return { sessionManager: { getBranch: () => entries }, agent: { kind } };
}

const BASE = ["You are omp."];

describe("worker contract", () => {
	it("is in the child's prompt and not in the parent's", () => {
		const on = hook();
		const child = on({ systemPrompt: BASE }, session([{ type: "custom", customType: WORKER_ENTRY, data: {} }]));
		const parent = on({ systemPrompt: BASE }, session([{ type: "custom", customType: "ompdesk.agent-answer" }]));
		expect(parent?.systemPrompt).toContainEqual(expect.stringContaining("<ompdesk-session-messages>"));
		expect(parent?.systemPrompt).not.toContain(WORKER_CONTRACT);
		expect(child?.systemPrompt).toEqual([...(parent?.systemPrompt ?? []), WORKER_CONTRACT]);
	});

	it("asks the worker to end its answer with a Result line the app reads", () => {
		expect(WORKER_CONTRACT).toContain("Result: ok");
		expect(WORKER_CONTRACT).toContain("Result: problem — <reason>");
	});

	it("leaves a worker's own subagents to its brief", () => {
		const entries = [{ type: "custom", customType: WORKER_ENTRY }];
		expect(hook()({ systemPrompt: BASE }, session(entries, "subagent"))).toBeUndefined();
	});

	it("stores a work-answer receipt without displaying or retaining the answer", async () => {
		const entry = { at: 42, target: "worker", requestId: "exact/id", actor: "bot:ada" };
		const journal: JournalEntry[] = [];
		const env = {
			session: () => ({
				sessionManager: {
					appendCustomEntry: (customType: string, data: unknown) =>
						journal.push({ type: "custom", customType, data }),
					flush: async () => {},
				},
			}),
		} as unknown as BridgeEnv;
		await methods["agent_control.workAnswer"]?.({ ...entry, answers: ["private"] }, env);
		expect(journal).toEqual([
			{ type: "custom", customType: "ompdesk.work-answer", data: { stage: "submitted", ...entry } },
		]);
	});

	it("is journaled once by agent_control.worker", async () => {
		const journal: JournalEntry[] = [];
		const env = {
			session: () => ({
				sessionManager: {
					getBranch: () => journal,
					appendCustomEntry: (customType: string, data: unknown) =>
						journal.push({ type: "custom", customType, data }),
				},
			}),
		} as unknown as BridgeEnv;
		await methods["agent_control.worker"]?.({ from: "Boss" }, env);
		await methods["agent_control.worker"]?.({ from: "Boss" }, env);
		expect(journal).toHaveLength(1);
		expect(journal[0]).toMatchObject({ customType: WORKER_ENTRY, data: { from: "Boss" } });
		await expect(methods["agent_control.worker"]?.({}, env)).rejects.toThrow("from");
	});
});
