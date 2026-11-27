import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../../shared/rpc-types";
import { compactBotHistory } from "./quiet-turns";

const marker: AgentMessage = { role: "assistant", stopReason: "stop", content: "**NO_REPLY**" };
const quote: AgentMessage = { role: "user", content: "NO_REPLY" };
const result: AgentMessage = { ...marker, content: "Changes saved.\nNO_REPLY" };
const call = (name: string): AgentMessage => ({
	role: "assistant",
	stopReason: "toolUse",
	content: [{ type: "toolCall", name, id: "r1", arguments: {} }],
});
const reply = (toolName: string): AgentMessage => ({
	role: "toolResult",
	toolName,
	toolCallId: "r1",
	isError: false,
	content: "fixture",
});
const advisor = (severity: string): AgentMessage => ({
	role: "custom",
	customType: "advisor",
	details: { notes: [{ severity, note: "advice" }] },
});

describe("compact bot history", () => {
	it("omits consecutive internal lookup turns without losing the preceding answer or a later question", () => {
		const question: AgentMessage = {
			role: "custom",
			customType: "ompdesk.mail",
			details: { kind: "question" },
			content: "Continue?",
		};
		const quietly = [advisor("nit"), call("read"), reply("read"), marker];
		const journal = [quote, result, ...quietly, ...quietly, question];
		expect(compactBotHistory(journal)).toEqual([quote, result, question]);
		expect(journal.filter(entry => entry === marker)).toHaveLength(2);
	});
	it.each(["ask", "a2ui", "write", "bash"])("retains %s and its response even before a quiet ending", name => {
		const pair = [call(name), reply(name)];
		expect(compactBotHistory([...pair, marker])).toEqual(pair);
	});
	it("keeps thinking blocks addressed to the reader even beside a marker", () => {
		const narrated: AgentMessage = {
			...marker,
			content: [
				{ type: "thinking", narration: true, thinking: "Please review the report." },
				{ type: "text", text: "NO_REPLY" },
			],
		};
		expect(compactBotHistory([narrated])).toEqual([narrated]);
	});
	it("keeps an incomplete lookup, a failed result, mismatched call ID, an advisor blocker and an interrupted reply", () => {
		const interrupted = { ...marker, stopReason: "aborted" };
		for (const entries of [
			[call("read")],
			[call("read"), { ...reply("read"), isError: true }],
			[call("read"), { ...reply("read"), toolCallId: "other" }],
			[advisor("blocker")],
			[interrupted],
		])
			expect(compactBotHistory([...entries, marker])).toEqual(entries);
		expect(compactBotHistory([quote, interrupted, result])).toEqual([quote, interrupted, result]);
	});
});
