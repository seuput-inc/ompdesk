import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { createMessagesStore } from "../../stores/messages";
import { buildHistoryRows } from "./chat-stream-utils";

// Shapes from a real omp 18.10 session: a detached agent the user stopped waiting for, whose
// result stock delivered after the stop (async-result) to wake a follow-up reply.
const user = (text: string, timestamp: number): AgentMessage => ({ role: "user", content: text, timestamp });
const spawn: AgentMessage[] = [
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "task-1", name: "task", arguments: { tasks: [{ name: "Sleeper" }] } }],
		stopReason: "toolUse",
		timestamp: 2,
	},
	{
		role: "toolResult",
		toolCallId: "task-1",
		toolName: "task",
		content: [{ type: "text", text: "Spawned agent `Sleeper` (job `Sleeper`)." }],
		details: { async: { state: "running", jobId: "Sleeper", type: "task" } },
		timestamp: 3,
	},
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "wait-1", name: "wait", arguments: {} }],
		stopReason: "toolUse",
		timestamp: 4,
	},
	{
		role: "toolResult",
		toolCallId: "wait-1",
		toolName: "wait",
		content: [{ type: "text", text: "Operation aborted" }],
		isError: true,
		timestamp: 5,
	},
	{ role: "assistant", content: [], stopReason: "aborted", timestamp: 6 },
];
const delivery: AgentMessage = {
	role: "custom",
	customType: "async-result",
	content: "<system-notice>\nBackground job Sleeper has completed.\n</system-notice>",
	display: true,
	details: { jobs: [{ jobId: "Sleeper", type: "task", status: "completed", agentId: "Sleeper", durationMs: 64_057 }] },
	timestamp: 60,
};
const reply: AgentMessage = {
	role: "assistant",
	content: [{ type: "text", text: "Sleeper finished." }],
	stopReason: "stop",
	timestamp: 61,
};

describe("background job deliveries", () => {
	it("omits stock's progress and inventory notices from live and reloaded chat, not the input or result", () => {
		const output = '{"tools":[{"name":"read"}]}';
		const progress = {
			role: "custom",
			customType: "async-notify",
			display: true,
			content: `<system-notice>\nBackground job bg_1 (list-tools) is still running. Its output matched /tools/:\n${output}\n</system-notice>`,
			attribution: "agent",
			details: {
				reports: [
					{
						id: "bg_1",
						type: "bash",
						pattern: "tools",
						lines: [output],
						omitted: 0,
						running: true,
						stopped: false,
					},
				],
			},
			timestamp: 2,
		} satisfies AgentMessage;
		const transcript: AgentMessage[] = [
			user(progress.content, 1),
			progress,
			{ role: "custom", customType: "xdev-mount-notice", display: false, content: output, timestamp: 3 },
			{ role: "developer", content: "<system-reminder>Use the mounted tools.</system-reminder>", timestamp: 4 },
			{ role: "custom", customType: "extension-question", display: true, content: "Which tool?", timestamp: 5 },
			delivery,
			reply,
		];
		const live = createMessagesStore();
		live.getState().applyEvents(transcript.map(message => ({ type: "message_end", message })));
		const restored = createMessagesStore();
		const journal = transcript.map(message => ({ ...message, entryId: String(message.timestamp) }));
		restored.getState().reconcileFetched(journal);
		for (const messages of [live.getState().liveMessages, restored.getState().messages]) {
			expect(messages).toHaveLength(transcript.length);
			for (const detail of ["compact", "full"] as const) {
				const rows = buildHistoryRows(messages, detail);
				expect(rows.map(row => row.kind === "message" && row.message.content)).toEqual([
					progress.content, // The identical text pasted by the person.
					"Which tool?",
					delivery.content,
					reply.content,
				]);
			}
		}
	});

	it("join the card of a run that stopped before replying", () => {
		const rows = buildHistoryRows([user("Start Sleeper", 1), ...spawn, delivery, reply], "compact");
		expect(rows.map(row => row.kind)).toEqual(["message", "process", "message"]);
		const work = rows[1];
		expect(work?.kind === "process" && work.notes).toEqual([delivery]);
	});

	it("keep their place after the run's reply or once the user started another turn", () => {
		for (const between of [reply, user("Next", 30)]) {
			const rows = buildHistoryRows([user("Start Sleeper", 1), ...spawn, between, delivery], "compact");
			expect(rows.at(-1)).toEqual({ kind: "message", message: delivery });
		}
	});
});

// Stock numbers background jobs per omp process, so a later run opens `bg_3` again (27 Oct 2026: 14 `bg_1` in one
// session). A delivery belongs to the run whose call opened the id last before it.
describe("a job id that comes back", () => {
	const open = (callId: string, at: number): AgentMessage[] => [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: `bun test ${callId}` } }],
			stopReason: "toolUse",
			timestamp: at,
		},
		{
			role: "toolResult",
			toolCallId: callId,
			toolName: "bash",
			content: [{ type: "text", text: "Backgrounded as job bg_3" }],
			details: { async: { state: "running", jobId: "bg_3", type: "bash" } },
			timestamp: at + 1,
		},
	];
	const reply = (at: number): AgentMessage => ({
		role: "assistant",
		content: [{ type: "text", text: "Started." }],
		stopReason: "stop",
		timestamp: at,
	});
	const delivered = (status: string, at: number): AgentMessage => ({
		role: "custom",
		customType: "async-result",
		content: `<system-notice>\nBackground job bg_3 has ${status}.\n</system-notice>`,
		display: true,
		details: { jobs: [{ jobId: "bg_3", type: "bash", status }] },
		timestamp: at,
	});

	it("charges a failed job to the run that opened it before the delivery, not to a later run that reused the id", () => {
		const rows = buildHistoryRows(
			[
				user("Run A", 1),
				...open("call-a", 2),
				reply(4),
				delivered("failed", 5),
				user("Run B", 10),
				...open("call-b", 11),
				reply(13),
				delivered("completed", 14),
			],
			"compact",
		);
		const failedEvents = rows.flatMap(row => (row.kind === "process" ? [row.failedEvents] : []));
		expect(failedEvents).toEqual([1, 0]);
	});

	it("folds a delivery into the card of the run that opened the id before it", () => {
		const stopped: AgentMessage = { role: "assistant", content: [], stopReason: "aborted", timestamp: 5 };
		const rows = buildHistoryRows(
			[
				user("Run A", 1),
				...open("call-a", 2),
				stopped,
				delivered("failed", 6),
				user("Run B", 10),
				...open("call-b", 11),
				reply(13),
			],
			"compact",
		);
		const [work] = rows.flatMap(row => (row.kind === "process" ? [row] : []));
		expect(work?.failedEvents).toBe(1);
		expect(work?.notes?.map(note => note.customType)).toEqual(["async-result"]);
	});
});
