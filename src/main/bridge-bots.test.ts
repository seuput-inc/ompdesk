import { describe, expect, it } from "vitest";
import { BOT_ENTRY, BOT_NOTE_TYPE, type BotContext } from "../../resources/gui-bridge/modes/bots-contracts";
import {
	botNote,
	botSection,
	latestBot,
	OWNER_REMINDER,
	ownerPrompt,
	parseBotContext,
} from "../../resources/gui-bridge/modes/bots-core";

const context = (over: Partial<BotContext> = {}): BotContext => ({
	bot: { id: "b1", name: "Scout", paused: false, folder: "/Users/me/.omp/bots/scout" },
	items: [{ number: 1, title: "Triage CI", status: "working" }],
	needsYou: [],
	live: [],
	...over,
});

const owner = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const noteEntry = (digest: string) => ({ type: "custom_message", customType: BOT_NOTE_TYPE, details: { digest } });

describe("a bot chat's prompt section", () => {
	it("is the same text while the name, folder and soul stay, whatever the items do", () => {
		const soul = "I keep the owner's CI green.";
		const first = botSection(context().bot, soul);
		expect(botSection(context({ items: [] }).bot, soul)).toBe(first);
		expect(first).toContain('You are the bot "Scout"');
		expect(first).toContain(soul);
		expect(first).not.toContain("first run");
	});

	it("carries the first-run rules until SOUL.md exists", () => {
		const text = botSection(context().bot, null);
		expect(text).toContain("This is your first run");
		expect(text).toContain("write SOUL.md in your folder");
		expect(botSection(context().bot, "")).toContain("This is your first run");
	});
});

describe("the bot's payload", () => {
	it("refuses one without a bot and caps what it keeps", () => {
		expect(parseBotContext({ items: [] })).toBeNull();
		const parsed = parseBotContext({
			bot: { id: "b1", name: "Scout", folder: "/f", paused: true },
			items: [{ number: 2, title: "  two\nlines ", status: "planned" }, { title: "no number" }],
			needsYou: [
				{ number: 3, title: "Pick", status: "needs_you", question: { text: "Which?", options: ["a", "b"] } },
			],
		});
		expect(parsed?.bot.paused).toBe(true);
		expect(parsed?.items).toEqual([{ number: 2, title: "two lines", status: "planned" }]);
		expect(parsed?.needsYou[0]?.question).toEqual({ text: "Which?", options: ["a", "b"] });
	});

	it("is read back from the newest journal entry", () => {
		const older = context({ live: ["old"] });
		const newer = context({ live: ["new"] });
		const branch = [
			{ type: "custom", customType: BOT_ENTRY, data: older },
			owner("hi"),
			{ type: "custom", customType: BOT_ENTRY, data: newer },
		];
		expect(latestBot(branch)?.live).toEqual(["new"]);
		expect(latestBot([owner("hi")])).toBeUndefined();
	});
});

describe("the turn note", () => {
	it("comes once per change of what the bot should know", () => {
		const first = botNote(context(), [], "hello");
		expect(first?.content).toContain("#1 Triage CI [working]");
		const branch = [noteEntry(first?.digest ?? ""), owner("hello")];
		expect(botNote(context(), branch, "next")).toBeNull();
		const changed = botNote(
			context({ needsYou: [{ number: 4, title: "Deploy?", status: "needs_you" }] }),
			branch,
			"x",
		);
		expect(changed?.content).toContain("Waiting on the owner");
	});

	it("comes again after a compaction dropped the last one", () => {
		const first = botNote(context(), [], "hello");
		const branch = [noteEntry(first?.digest ?? ""), { type: "compaction" }];
		expect(botNote(context(), branch, "again")).not.toBeNull();
	});

	it("reminds on every fifth turn the owner typed, never on another session's message", () => {
		const digest = botNote(context(), [], "x")?.digest ?? "";
		const typed = [noteEntry(digest), owner("1"), owner("2"), owner("3"), owner("4")];
		expect(botNote(context(), typed, "5")?.content).toContain(OWNER_REMINDER);
		expect(botNote(context(), typed, "<ompdesk-agent-message from=x>hi</ompdesk-agent-message>")).toBeNull();
		expect(botNote(context(), typed.slice(0, 4), "4")).toBeNull();
		const withAgents = [...typed.slice(0, 4), owner("[ompdesk dispatch d1: report] do it")];
		expect(botNote(context(), withAgents, "5th owner turn")).toBeNull();
	});

	it("tells an owner's prompt from another session's", () => {
		expect(ownerPrompt("fix the build")).toBe(true);
		expect(ownerPrompt("<ompdesk-mail from=x>done</ompdesk-mail>")).toBe(false);
		expect(ownerPrompt("[ompdesk request r1] status?")).toBe(false);
		expect(ownerPrompt("  ")).toBe(false);
	});
});
