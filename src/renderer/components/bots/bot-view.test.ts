import { describe, expect, it } from "vitest";
import type { Bot } from "../../../shared/bots";
import { botTemplateWords } from "../../locales/bot-templates";
import { BOT_TEMPLATES } from "./bot-templates";
import { type BotChatFacts, type BotFacts, botFacts, botMatches, freeBotName, sortBots } from "./bot-view";

const bot = (id: string, over: Partial<Bot> = {}): Bot => ({
	id,
	name: `Bot ${id}`,
	folder: `/b/${id}`,
	home: `/s/${id}-home.jsonl`,
	sessions: [],
	paused: false,
	model: null,
	autoApprove: false,
	reach: [],
	staleDays: 7,
	lookAround: null,
	tidy: null,
	quiet: [],
	createdAt: "2026-11-01T00:00:00.000Z",
	...over,
});

const chat = (path: string, over: Partial<BotChatFacts> = {}): BotChatFacts => ({
	path,
	title: path,
	modified: "2026-11-20T00:00:00.000Z",
	waiting: null,
	running: false,
	failed: false,
	unread: false,
	...over,
});

describe("a bot row's second line", () => {
	it("says paused first, then what waits on the person, its home chat winning a tie", () => {
		const ada = bot("a");
		const chats = [
			chat("/s/side", { waiting: "Waiting for your answer" }),
			chat("/s/a-home.jsonl", { waiting: "Wants your approval", title: "Home" }),
		];
		expect(botFacts({ ...ada, paused: true }, chats, 0).line).toEqual({ kind: "paused" });
		expect(botFacts(ada, chats, 2)).toMatchObject({
			needsYou: 4,
			line: { kind: "waiting", label: "Wants your approval", chat: "Home" },
		});
	});

	it("falls back from items needing the owner to work, an unseen end, the purpose and a first hello", () => {
		const ada = bot("a", { specialty: "Reviews pull requests." });
		expect(botFacts(ada, [chat("/s/x", { running: true })], 1).line).toEqual({ kind: "needsYou", count: 1 });
		expect(botFacts(ada, [chat("/s/x", { running: true, title: "Fix" })], 0).line).toEqual({
			kind: "working",
			chat: "Fix",
		});
		expect(botFacts(ada, [chat("/s/x", { unread: true, title: "Fix" })], 0).line).toEqual({
			kind: "done",
			chat: "Fix",
		});
		expect(botFacts(ada, [chat("/s/x")], 0).line).toEqual({ kind: "purpose", text: "Reviews pull requests." });
		expect(botFacts(bot("b"), [], 0).line).toEqual({ kind: "hello" });
	});
});

describe("the Bots section's order", () => {
	const facts = (entries: [string, Partial<BotFacts>][]) =>
		new Map(
			entries.map(([id, fact]) => [
				id,
				{
					needsYou: 0,
					working: false,
					failed: false,
					unread: false,
					latest: "2026-11-01T00:00:00.000Z",
					line: { kind: "idle" },
					...fact,
				} as BotFacts,
			]),
		);

	it("keeps the person's order with a bot it does not name on top, and drops paused ones on request", () => {
		const bots = [bot("a"), bot("b"), bot("c", { paused: true }), bot("new", { createdAt: "2026-11-25T00:00:00Z" })];
		const order = sortBots(bots, "manual", ["c", "a", "b"], facts([]), false).map(b => b.id);
		expect(order).toEqual(["new", "c", "a", "b"]);
		expect(sortBots(bots, "manual", ["c", "a", "b"], facts([]), true).map(b => b.id)).toEqual(["new", "a", "b"]);
	});

	it("puts a bot that needs the person first, then the most recent", () => {
		const bots = [bot("a"), bot("b"), bot("c")];
		const known = facts([
			["a", { latest: "2026-11-10T00:00:00Z" }],
			["b", { latest: "2026-11-02T00:00:00Z", needsYou: 1 }],
			["c", { latest: "2026-11-20T00:00:00Z" }],
		]);
		expect(sortBots(bots, "smart", [], known, false).map(b => b.id)).toEqual(["b", "c", "a"]);
		expect(sortBots(bots, "recent", [], known, false).map(b => b.id)).toEqual(["c", "a", "b"]);
	});
});

describe("finding and naming bots", () => {
	it("matches the name or the purpose without accents or case", () => {
		const cafe = bot("a", { name: "Café helper", specialty: "Triage für Fehler" });
		expect(botMatches(cafe, "cafe")).toBe(true);
		expect(botMatches(cafe, "FUR")).toBe(true);
		expect(botMatches(cafe, "release")).toBe(false);
	});

	it("numbers a taken name", () => {
		expect(freeBotName("Scout", [bot("a", { name: "scout" }), bot("b", { name: "Scout 2" })])).toBe("Scout 3");
		expect(freeBotName("Rex", [bot("a", { name: "Scout" })])).toBe("Rex");
	});
});

describe("template words", () => {
	it("every template has its own words in English and in Korean", () => {
		for (const template of BOT_TEMPLATES) {
			const en = botTemplateWords("en", template.id);
			const ko = botTemplateWords("ko", template.id);
			for (const part of ["name", "line", "first", "example"] as const) {
				expect(en[part], `${template.id}.${part}`).not.toBe("");
				expect(ko[part], `${template.id}.${part}`).not.toBe(en[part]);
			}
		}
	});
});
