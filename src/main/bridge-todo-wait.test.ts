import { describe, expect, it } from "vitest";
import { isWaitingItem, onlyWaitingItems } from "../../resources/gui-bridge/todo-wait-core";

describe("a session whose open items are all written as waiting", () => {
	it("recognises an item that says it waits, in English and Korean", () => {
		for (const content of [
			"Wait for the inquiry tab's reply",
			"Waiting on CI",
			"awaiting the owner's decision",
			"Blocked on the release job",
			"대기: 문의 탭 답변",
			"기다리는 중: 빌드 결과",
			"문의 탭 응답 대기",
			"빌드 결과 기다리기",
		])
			expect(isWaitingItem(content), content).toBe(true);
	});

	it("never takes an actionable item for waiting", () => {
		for (const content of [
			"Fix the sidebar bug",
			"Add a Korean label",
			"Write the waiting-room page",
			"대기열 화면 고치기",
		])
			expect(isWaitingItem(content), content).toBe(false);
	});

	it("gives no reminder when every open item waits, whatever is done or abandoned", () => {
		const phases = [
			{
				tasks: [
					{ content: "Fix the bug", status: "completed" },
					{ content: "Drop the idea", status: "abandoned" },
					{ content: "Wait for the reply", status: "pending" },
					{ content: "대기: CI 결과", status: "in_progress" },
				],
			},
		];
		expect(onlyWaitingItems(phases)).toBe(true);
	});

	it("keeps the reminder when one open item can be acted on, or none is open", () => {
		expect(
			onlyWaitingItems([
				{ tasks: [{ content: "Wait for the reply", status: "in_progress" }] },
				{ tasks: [{ content: "Classify local branches", status: "pending" }] },
			]),
		).toBe(false);
		expect(onlyWaitingItems([{ tasks: [{ content: "Wait", status: "completed" }] }])).toBe(false);
		expect(onlyWaitingItems([])).toBe(false);
	});
});
