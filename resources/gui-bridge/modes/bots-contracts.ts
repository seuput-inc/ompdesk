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
	/** `firstRun`: the home chat of a bot in its first run (the core's `bot_first_run.rs`), which carries its rules. */
	bot: { id: string; name: string; paused: boolean; folder: string; firstRun: boolean };
	/** Open, unsnoozed items of this bot. */
	items: BotItemBrief[];
	/** Items waiting on the owner's answer. */
	needsYou: BotItemBrief[];
	/** Titles of this bot's other chats that are working now. */
	live: string[];
}

/**
 * What `agent_control.bot` answers besides `changed`: what the chat's branch says, read by the core's first run. Asked
 * with `kickoff` (the newest kickoff's mail id): `none` while the journal does not hold it, `queued` with no answer
 * after it yet, `silent` answered without a word, `spoke`.
 */
export interface BotChatFacts {
	ownerTurns: number;
	streaming: boolean;
	kickoff: "none" | "queued" | "silent" | "spoke";
}
