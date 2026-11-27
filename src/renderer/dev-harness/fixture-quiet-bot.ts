import type { Bot } from "../../shared/bots";

export const quietScenario = typeof location !== "undefined" ? new URLSearchParams(location.search).get("quiet") : null;

export function quietBots(home: string): Bot[] {
	return quietScenario === "bot"
		? [
				{
					id: "fixture-quiet",
					name: "Synthetic bot",
					folder: "/fixture/renamed-bot",
					home,
					sessions: [home],
					paused: false,
					model: null,
					autoApprove: false,
					reach: [],
					staleDays: null,
					lookAround: null,
					tidy: null,
					quiet: [],
					createdAt: "2026-10-01T00:00:00Z",
				},
			]
		: [];
}

export function quietMessages(base: number): Record<string, unknown>[] {
	const answer = (text: string) => ({
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 23, output: 12, totalTokens: 35 },
	});
	const quiet = (id: string) => [
		{
			role: "developer",
			content:
				"<system-reminder>\nYou stopped with 1 incomplete todo item(s):\n- Test\n  - Check fixture\n\nPlease continue working on these tasks or mark them complete if finished.\n(Reminder 1/3)\n</system-reminder>",
		},
		{
			role: "custom",
			customType: "advisor",
			content: "Synthetic suggestion",
			details: { notes: [{ severity: "nit", note: "Synthetic suggestion" }] },
		},
		{
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", name: "read", id, arguments: { path: "fixture.txt" } }],
		},
		{
			role: "toolResult",
			toolName: "read",
			toolCallId: id,
			isError: false,
			content: [{ type: "text", text: "fixture" }],
		},
		answer("NO_REPLY"),
	];
	return [
		{ role: "user", content: "NO_REPLY를 인용한 사용자 메시지" },
		answer("보존할 사용자 결과"),
		...quiet("r1"),
		...quiet("r2"),
		{
			role: "custom",
			customType: "ompdesk.mail",
			display: true,
			details: { id: "question-control", kind: "question", from: "child", text: "응답할 질문" },
			content: "응답할 질문",
		},
	].map((message, i) => ({ ...message, timestamp: base + i * 1000 }));
}
