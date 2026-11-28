/**
 * A bot's chat (rules: bots-core.ts; contracts: bots-contracts.ts; the bots themselves are the core's agent control,
 * control-tools.md › Bots, items and rooms). Main hands every bot chat it sees its payload (`agent_control.bot`: the
 * bot, its open items, what waits on the owner, its other chats at work) whenever that changed; this module
 * - keeps the newest payload as a journal entry (`ompdesk.bot`), so a restarted omp still knows it is a bot,
 * - adds the `ompdesk-bot` section (who it is, its rules, its `SOUL.md`, and in a first-run home chat the first-run
 *   rules) to the main agent's prompts: the same text turn after turn while the name, folder, first run and soul stay,
 * - appends the session host's clock to each new prompt (ordinary chats too), sharing the hidden message with the
 *   bot digest when it changes and with the owner reminder every fifth typed turn,
 * - answers what the branch says for the core's first run (`BotChatFacts`: the owner's turns, whether a turn runs,
 *   what became of the kickoff the call names).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { guard } from "../health";
import { type JournalEntry, type PromptSectionHost, registerPromptSection } from "../prompt-sections";
import { turnClock } from "../turn-clock";
import {
	BOT_ENTRY,
	BOT_HOME_PERSIST,
	BOT_METHOD,
	BOT_NOTE_TYPE,
	BOT_SECTION_ID,
	type BotHomeManager,
	botHomeOf,
	requireBotHome,
	SOUL_FILE,
} from "./bots-contracts";
import { botNote, botSection, chatFacts, latestBot, parseBotContext, sameBot } from "./bots-core";

/** The slice of omp's ExtensionAPI this module uses (no omp imports, like prompt-sections.ts). */
interface BotHost extends PromptSectionHost {
	on(
		event: "before_agent_start",
		handler: (
			event: { prompt?: string; systemPrompt: string[] },
			ctx: { agent: { kind: string }; sessionManager: { getBranch(): readonly JournalEntry[] } },
		) => { message: Record<string, unknown> } | undefined,
	): void;
}

/** `SOUL.md` in the bot's folder; null when it does not exist (yet) or cannot be read. */
function readSoul(folder: string): string | null {
	try {
		return readFileSync(join(folder, SOUL_FILE), "utf8");
	} catch {
		return null;
	}
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: BotHost): void {
	registerPromptSection(pi, BOT_SECTION_ID, ctx => {
		if (ctx.agent.kind !== "main") return undefined;
		const context = latestBot(ctx.sessionManager.getBranch());
		return context ? botSection(context.bot, readSoul(context.bot.folder)) : undefined;
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.agent.kind !== "main") return undefined;
		const branch = ctx.sessionManager.getBranch();
		const context = latestBot(branch);
		const note = context ? botNote(context, branch, typeof event.prompt === "string" ? event.prompt : "") : null;
		const clock = turnClock();
		return {
			message: {
				customType: note ? BOT_NOTE_TYPE : "ompdesk.turn-clock",
				content: note ? `${clock}\n${note.content}` : clock,
				display: false,
				details: note ? { digest: note.digest } : undefined,
				attribution: "agent",
			},
		};
	});
}

interface BotSession {
	isStreaming: boolean;
	sessionManager: BotHomeManager & {
		getBranch(): readonly JournalEntry[];
		appendCustomEntry(customType: string, data: unknown): unknown;
		ensureOnDisk(): Promise<void>;
		flush(): Promise<void>;
	};
}

export const methods = guard("bots", {
	[BOT_HOME_PERSIST]: async (expected, env) => {
		const session = env.session() as unknown as BotSession;
		const manager = session.sessionManager;
		requireBotHome(expected, botHomeOf(manager));
		// Stock otherwise defers a fresh journal until the first assistant message.
		await manager.ensureOnDisk();
		requireBotHome(expected, botHomeOf(env.session().sessionManager));
		return {};
	},
	/**
	 * `BotContext` and `kickoff?` → `{changed}` and `BotChatFacts`: journaled only when it says something the newest
	 * entry does not.
	 */
	[BOT_METHOD]: async (params, env) => {
		const context = parseBotContext(params);
		if (!context) throw new Error(`${BOT_METHOD} needs a bot with an id, a name and a folder`);
		const session = env.session() as unknown as BotSession;
		const manager = session.sessionManager;
		const expected =
			params && typeof params === "object" && "expectedHome" in params ? params.expectedHome : undefined;
		if (expected !== undefined) requireBotHome(expected, botHomeOf(manager));
		const branch = manager.getBranch();
		const kickoff = (params as { kickoff?: unknown } | null)?.kickoff;
		const facts = chatFacts(branch, typeof kickoff === "string" ? kickoff : undefined, session.isStreaming === true);
		const changed = !sameBot(latestBot(branch), context);
		if (changed) manager.appendCustomEntry(BOT_ENTRY, context);
		if (expected !== undefined) await manager.flush();
		return { changed, ...facts };
	},
});
