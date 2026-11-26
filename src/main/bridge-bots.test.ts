import { describe, expect, it } from "vitest";
import { MAIL_CUSTOM_TYPE } from "../../resources/gui-bridge/agent-control-contracts";
import { BOT_ENTRY, BOT_NOTE_TYPE, type BotContext } from "../../resources/gui-bridge/modes/bots-contracts";
import {
	botNote,
	botSection,
	chatFacts,
	latestBot,
	OWNER_REMINDER,
	ownerPrompt,
	parseBotContext,
} from "../../resources/gui-bridge/modes/bots-core";
import { NO_REPLY } from "../shared/bots";

const context = (over: Partial<BotContext> = {}): BotContext => ({
	bot: { id: "b1", name: "Scout", paused: false, folder: "/Users/me/.omp/bots/scout", firstRun: false },
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

	it("carries the first-run rules while the core says the first run lasts, SOUL.md or not", () => {
		const first = { ...context().bot, firstRun: true };
		// A bot made with a purpose has SOUL.md from the start: first run still runs (Orca bot-preamble.ts:94-102).
		for (const soul of [null, "Keeps the changelog honest."]) {
			const text = botSection(first, soul);
			expect(text).toContain("First run");
			expect(text).toContain("a greeting that ends with your one first question");
			expect(text).toContain("do one small real piece of the work now, and show the result");
			expect(text).toContain("Then write SOUL.md in your folder");
		}
		// Ended by the owner's first turn, not by SOUL.md: without the flag a missing SOUL.md only asks for one.
		const after = botSection(context().bot, null);
		expect(after).not.toContain("First run");
		expect(after).toContain("There is no SOUL.md in your folder yet");
	});

	it("keeps memory in MEMORY.md, one fact per line, and ends a turn with nothing to say in NO_REPLY", () => {
		const text = botSection(context().bot, "I keep the owner's CI green.");
		expect(text).toContain("one list line in MEMORY.md in your folder");
		expect(text).toContain("forget a fact by deleting its line");
		expect(text).toContain("read MEMORY.md when a turn needs it");
		// The literal in the prompt is the contract's word the notify triage reads.
		expect(text).toContain(`end your answer with a last line ${NO_REPLY}.`);
		expect(text).not.toContain("Your memory is your folder");
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

describe("what a first-run home chat tells the core", () => {
	const kickoff = { type: "custom_message", customType: MAIL_CUSTOM_TYPE, details: { id: "kickoff-a-1" } };
	const answer = (content: unknown) => ({ type: "message", message: { role: "assistant", content } });

	it("follows the kickoff it names: not held, waiting, answered without a word, or spoken", () => {
		expect(chatFacts([], "kickoff-a-1", false).kickoff).toBe("none");
		expect(chatFacts([kickoff], undefined, false).kickoff).toBe("none");
		expect(chatFacts([kickoff], "kickoff-a-1", true)).toEqual({ ownerTurns: 0, streaming: true, kickoff: "queued" });
		// A turn that only called a tool, or failed, said nothing.
		const toolOnly = answer([{ type: "toolCall", id: "c1", name: "read", arguments: {} }]);
		expect(chatFacts([kickoff, toolOnly, answer([])], "kickoff-a-1", false).kickoff).toBe("silent");
		expect(chatFacts([kickoff, toolOnly, answer("Hi! What should I start on?")], "kickoff-a-1", false).kickoff).toBe(
			"spoke",
		);
		// An answer before the kickoff is not its answer.
		expect(chatFacts([answer("earlier"), kickoff], "kickoff-a-1", false).kickoff).toBe("queued");
	});

	it("counts only what the owner typed as the owner's turns", () => {
		const branch = [
			kickoff,
			answer("Hi! What should I start on?"),
			{
				type: "message",
				message: { role: "user", content: '<ompdesk-agent-message from="x">hi</ompdesk-agent-message>' },
			},
			owner("Check the README"),
		];
		expect(chatFacts(branch, "kickoff-a-1", false).ownerTurns).toBe(1);
	});
});
