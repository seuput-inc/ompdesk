/**
 * A bot's chat (rules: bots-core.ts; contracts: bots-contracts.ts; the bots themselves are the core's agent control,
 * control-tools.md › Bots, items and rooms). Main hands every bot chat it sees its payload (`agent_control.bot`: the
 * bot, its open items, what waits on the owner, its other chats at work) whenever that changed; this module
 * - keeps the newest payload as a journal entry (`ompdesk.bot`), so a restarted omp still knows it is a bot,
 * - adds the `ompdesk-bot` section (who it is, its rules, its `SOUL.md` or the first-run rules) to the main agent's
 *   prompts: the same text turn after turn while the name, folder and soul stay,
 * - starts a turn with one `ompdesk.bot-note` message when the digest differs from the newest one the model holds,
 *   and on every fifth turn the owner typed, with the reminder to put open questions on items.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { guard } from "../health";
import { type JournalEntry, type PromptSectionHost, registerPromptSection } from "../prompt-sections";
import { BOT_ENTRY, BOT_METHOD, BOT_NOTE_TYPE, BOT_SECTION_ID, SOUL_FILE } from "./bots-contracts";
import { botNote, botSection, latestBot, parseBotContext, sameBot } from "./bots-core";

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
		if (!note) return undefined;
		return {
			message: {
				customType: BOT_NOTE_TYPE,
				content: note.content,
				display: false,
				details: { digest: note.digest },
				attribution: "agent",
			},
		};
	});
}

interface BotSession {
	sessionManager: {
		getBranch(): readonly JournalEntry[];
		appendCustomEntry(customType: string, data: unknown): unknown;
	};
}

export const methods = guard("bots", {
	/** `BotContext` → `{changed}`: journaled only when it says something the newest entry does not. */
	[BOT_METHOD]: async (params, env) => {
		const context = parseBotContext(params);
		if (!context) throw new Error(`${BOT_METHOD} needs a bot with an id, a name and a folder`);
		const manager = (env.session() as unknown as BotSession).sessionManager;
		if (sameBot(latestBot(manager.getBranch()), context)) return { changed: false };
		manager.appendCustomEntry(BOT_ENTRY, context);
		return { changed: true };
	},
});
