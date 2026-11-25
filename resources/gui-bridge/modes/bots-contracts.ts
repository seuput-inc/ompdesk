/**
 * What main hands a bot's chat (modes/bots.ts) and what the chat keeps of it. Dependency-free: main imports it to
 * build the payload, the bridge to read it.
 */

/** The bridge method main calls (through the local command `agent_control_bot`) whenever the payload changed. */
export const BOT_METHOD = "agent_control.bot";
/** The journal entry holding the newest payload, read back after a restart. */
export const BOT_ENTRY = "ompdesk.bot";
/** The custom message that tells the bot what changed in its items and its other chats since it last heard. */
export const BOT_NOTE_TYPE = "ompdesk.bot-note";
export const BOT_SECTION_ID = "ompdesk-bot";
/** Who the bot is, written by the bot itself in its folder on its first run. */
export const SOUL_FILE = "SOUL.md";
/** The most of `SOUL.md` the section carries. */
export const SOUL_MAX = 8192;
/** Every this many turns the owner typed, the note reminds the bot to put open questions on items (Orca's every 5th). */
export const OWNER_REMINDER_EVERY = 5;

export interface BotItemBrief {
	number: number;
	title: string;
	status: string;
	question?: { text: string; options: string[]; recommended?: number };
}

export interface BotContext {
	bot: { id: string; name: string; paused: boolean; folder: string };
	/** Open, unsnoozed items of this bot. */
	items: BotItemBrief[];
	/** Items waiting on the owner's answer. */
	needsYou: BotItemBrief[];
	/** Titles of this bot's other chats that are working now. */
	live: string[];
}
