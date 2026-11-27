import { describe, expect, it } from "vitest";
import type { Bot, Item } from "../../shared/bots";
import type { Schedule } from "../../shared/schedules";
import type { SessionSummary } from "../../shared/session-summary";
import { questionRows } from "./question-inbox";
import { groupQuestions } from "./question-inbox-view";

const t = (key: string) => key;
const bot: Bot = {
	id: "b",
	name: "Courier",
	folder: "/work/project",
	home: "/s/home",
	sessions: [],
	paused: false,
	model: null,
	autoApprove: false,
	reach: [],
	staleDays: null,
	lookAround: null,
	tidy: null,
	quiet: [],
	createdAt: "",
};
const at = new Date(1000).toISOString();
const item: Item = {
	id: "item",
	number: 1,
	bot: bot.id,
	session: "/s/home",
	title: "Launch",
	status: "needs_you",
	question: { text: "Where?", options: ["Test", "Live"], recommended: 0, id: 11 },
	links: [],
	createdAt: at,
	updatedAt: at,
	events: [{ actor: "bot", kind: "asked", id: 11, at }],
	version: 1,
};
const session: SessionSummary = {
	tabId: "tab",
	sessionPath: "/s/home",
	cwd: bot.folder,
	kind: "agent",
	status: "ready",
	agents: [],
	ask: "approval",
	requests: [
		{ id: "r1", kind: "input", label: "Choose a region", askedAt: 3000 },
		{ id: "r2", kind: "approval", label: "Allow tool: read", askedAt: 2000 },
	],
};
const empty = { schedules: [] };

describe("question inbox", () => {
	it("keeps all requests of an unviewed session, isolates identical hosts' ids and orders a bot's rows by when asked", () => {
		const rows = questionRows(
			{ bots: [bot, { ...bot, device: "peer" }], items: [item, { ...item, device: "peer" }] },
			[{ summaries: [session] }, { device: "peer", name: "Laptop", summaries: [session] }],
			empty,
			5000,
			t,
		);
		expect(new Set(rows.map(row => row.key)).size).toBe(6);
		const groups = groupQuestions(rows);
		expect(groups).toHaveLength(2);
		expect(groups[0]?.key).not.toBe(groups[1]?.key);
		for (const group of groups) {
			expect(group.project).toBe("project");
			expect(group.askers.map(asker => asker.asker)).toEqual(["Courier"]);
			expect(group.askers[0]?.rows.map(row => row.source)).toEqual(["item", "approval", "ask"]);
		}
	});

	it("does not conflate ordinary sessions with the same displayed title in the same project", () => {
		const other = { ...session, title: "Checks" };
		const rows = questionRows(
			{ bots: [], items: [] },
			[{ summaries: [other, { ...other, sessionPath: "/s/other" }] }],
			empty,
			0,
			t,
		);
		expect(groupQuestions(rows)[0]?.askers.map(group => group.rows.length)).toEqual([2, 2]);
	});

	it("removes withdrawn, self-decided, snoozed and closed questions; a replacement keeps the row, not the old answer id", () => {
		const build = (next: Item) => questionRows({ bots: [bot], items: [next] }, [], empty, 2000, t);
		const original = build(item)[0];
		const replaced = build({ ...item, question: { id: 12, text: "When?", options: [] } })[0];
		expect(replaced).toMatchObject({
			key: original?.key,
			detail: "When?",
			item: { question: { id: 12 } },
			askedAt: null,
		});
		for (const kind of ["withdrawn", "self_decided"] as const) {
			expect(
				build({
					...item,
					status: "working",
					question: undefined,
					events: [...item.events, { actor: "bot", kind, id: 12, at, question: 11, text: "Use staging" }],
				}),
			).toEqual([]);
		}
		expect(build({ ...item, closedAt: at })).toEqual([]);
		expect(build({ ...item, snoozedUntil: new Date(2001).toISOString() })).toEqual([]);
		expect(build({ ...item, snoozedUntil: new Date(2000).toISOString() })).toHaveLength(1);
	});

	it("keeps an older host's open ask without inventing its request id or age, and omits a down session", () => {
		const old = { ...session, requests: undefined };
		const rows = questionRows(
			{ bots: [], items: [] },
			[{ summaries: [old, { ...session, status: "exited" }] }],
			empty,
			0,
			t,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ source: "approval", requestId: undefined, askedAt: null });
	});

	it("lists only the bot connector's still-open requests, never grants them, and carries no schedule command", () => {
		const schedule: Schedule = {
			id: "connector",
			cwd: bot.folder,
			name: "Messages",
			prompt: "private",
			enabled: true,
			model: null,
			autoApprove: false,
			createdAt: at,
			frequency: { kind: "event", event: { source: "slack", account: "account", from: ["member"] } },
		};
		const person = { name: "Ada", person: "new", place: "Slack", at };
		const rows = questionRows(
			{ bots: [bot], items: [] },
			[],
			{
				schedules: [schedule],
				asking: {
					connector: [person, { ...person, person: "member" }, { ...person, person: "declined", declined: true }],
				},
			},
			0,
			t,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ source: "access", scheduleId: "connector", person, askedAt: 1000 });
		expect(JSON.stringify(rows)).not.toContain("private");
	});
});
