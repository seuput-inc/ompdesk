import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../../shared/ipc-types";
import type { SessionSummary } from "../../../shared/session-summary";
import type { SessionTab } from "../../stores/tabs";
import { boardCards, boardLanes, matchesBoard } from "./board-cards";

function info(id: string, modified: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: `/s/${id}.jsonl`,
		id,
		title: id,
		cwd: `/code/${id}`,
		created: modified,
		modified,
		messageCount: 2,
		size: 10,
		status: "complete",
		firstMessage: `hello ${id}`,
		...overrides,
	};
}

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		sessionPath: `/s/${id}.jsonl`,
		tabId: `tab-${id}`,
		cwd: `/code/${id}`,
		kind: "agent",
		status: "ready",
		agents: [],
		...overrides,
	};
}

const tab = (id: string, overrides: Partial<SessionTab> = {}): SessionTab =>
	({
		id: `tab-${id}`,
		cwd: `/code/${id}`,
		status: "ready",
		sessionPath: `/s/${id}.jsonl`,
		unreadDone: false,
		...overrides,
	}) as SessionTab;

describe("boardCards", () => {
	it("puts each session in one lane by its computer's summary and this window's unseen finish", () => {
		const cards = boardCards(
			[
				{
					sessions: [
						info("ask", "2026-11-26T10:00:00Z"),
						info("run", "2026-11-26T09:00:00Z"),
						info("done", "2026-11-26T08:00:00Z"),
						info("old", "2026-11-20T08:00:00Z"),
						info("agents", "2026-11-26T07:00:00Z"),
					],
					summaries: [
						summary("ask", { status: "running", ask: "approval" }),
						summary("run", { status: "running", since: Date.parse("2026-11-26T11:00:00Z") }),
						summary("done"),
						summary("agents", {
							agents: [{ id: "a", index: 0, agent: "task", status: "running", startedAt: 0 }],
						}),
					],
				},
			],
			[tab("done", { unreadDone: true })],
		);
		const lanes = boardLanes(cards);
		expect(lanes.needs.map(card => card.info?.id)).toEqual(["ask"]);
		// A running turn's start counts as its newest change.
		expect(lanes.working.map(card => card.info?.id)).toEqual(["run", "agents"]);
		expect(lanes.done.map(card => card.info?.id)).toEqual(["done"]);
		expect(lanes.idle.map(card => card.info?.id)).toEqual(["old"]);
		expect(cards[0]?.info?.id).toBe("run");
	});

	it("names a paired computer's card by it, keeps a live tab with no file yet, and leaves out empty and archived rows", () => {
		const cards = boardCards(
			[
				{
					sessions: [info("empty", "2026-11-26T10:00:00Z", { messageCount: 0, title: null, firstMessage: "" })],
					summaries: [],
				},
				{
					device: "pc-b",
					name: "PC-B",
					sessions: [info("hosted", "2026-11-26T09:00:00Z"), info("kept", "2026-11-26T08:00:00Z")],
					summaries: [summary("tab:new", { sessionPath: "tab:new", status: "running" })],
				},
			],
			[],
			new Set(["kept"]),
		);
		expect(cards.map(card => [card.sessionPath, card.deviceName, card.lane])).toEqual([
			["/s/hosted.jsonl", "PC-B", "idle"],
			["tab:new", "PC-B", "working"],
		]);
	});
});

describe("matchesBoard", () => {
	it("narrows by text, project and computer together", () => {
		const [card] = boardCards(
			[{ device: "pc-b", name: "PC-B", sessions: [info("x", "2026-11-26T10:00:00Z")], summaries: [] }],
			[],
		);
		if (!card) throw new Error("no card");
		const projectOf = () => "acme";
		const none = { query: "", projects: [], computers: [] };
		expect(matchesBoard(card, { ...none, query: "hello pc-b" }, projectOf, "Fix login")).toBe(true);
		expect(matchesBoard(card, { ...none, query: "nothing" }, projectOf, "Fix login")).toBe(false);
		expect(matchesBoard(card, { ...none, projects: ["acme"], computers: ["pc-b"] }, projectOf, "t")).toBe(true);
		expect(matchesBoard(card, { ...none, computers: [""] }, projectOf, "t")).toBe(false);
	});
});
