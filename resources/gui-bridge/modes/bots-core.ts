/**
 * The rules of a bot's chat (modes/bots.ts): what main's payload may hold, the prompt section that tells the agent it
 * is a bot, and the per-turn note of what changed (after Orca's bot preamble and turn context notes, re-implemented).
 * No omp imports: the GUI's vitest loads it directly.
 */
import { AGENT_MESSAGE_START } from "../agent-control-contracts";
import {
	BOT_ENTRY,
	BOT_NOTE_TYPE,
	type BotContext,
	type BotItemBrief,
	OWNER_REMINDER_EVERY,
	SOUL_MAX,
} from "./bots-contracts";

const TEXT_MAX = 400;
const LIST_MAX = 50;

function field(value: unknown, name: string): unknown {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined;
}

function line(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX) : "";
}

function brief(value: unknown): BotItemBrief | null {
	const number = field(value, "number");
	const title = line(field(value, "title"));
	const status = line(field(value, "status"));
	if (typeof number !== "number" || !Number.isSafeInteger(number) || !title || !status) return null;
	const out: BotItemBrief = { number, title, status };
	const question = field(value, "question");
	const text = line(field(question, "text"));
	if (text) {
		const options = field(question, "options");
		const recommended = field(question, "recommended");
		out.question = {
			text,
			options: Array.isArray(options) ? options.map(line).filter(Boolean).slice(0, 10) : [],
			...(typeof recommended === "number" && Number.isSafeInteger(recommended) ? { recommended } : {}),
		};
	}
	return out;
}

function briefs(value: unknown): BotItemBrief[] {
	return Array.isArray(value)
		? value
				.map(brief)
				.filter((item): item is BotItemBrief => item !== null)
				.slice(0, LIST_MAX)
		: [];
}

/** Main's payload, checked at the trust boundary; null when it names no bot. */
export function parseBotContext(params: unknown): BotContext | null {
	const bot = field(params, "bot");
	const id = line(field(bot, "id"));
	const name = line(field(bot, "name"));
	const folder = typeof field(bot, "folder") === "string" ? (field(bot, "folder") as string) : "";
	if (!id || !name || !folder) return null;
	const live = field(params, "live");
	return {
		bot: { id, name, folder, paused: field(bot, "paused") === true },
		items: briefs(field(params, "items")),
		needsYou: briefs(field(params, "needsYou")),
		live: Array.isArray(live) ? live.map(line).filter(Boolean).slice(0, LIST_MAX) : [],
	};
}

/** The newest payload this branch keeps (`ompdesk.bot` entries, oldest first). */
export function latestBot(branch: readonly unknown[]): BotContext | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (field(entry, "type") === "custom" && field(entry, "customType") === BOT_ENTRY) {
			return parseBotContext(field(entry, "data")) ?? undefined;
		}
	}
	return undefined;
}

/** Whether `next` says something the kept payload does not (the journal gets an entry only then). */
export function sameBot(kept: BotContext | undefined, next: BotContext): boolean {
	return kept !== undefined && JSON.stringify(kept) === JSON.stringify(next);
}

/**
 * The prompt section: who the bot is and how it works. It reads only the name, the folder and `SOUL.md` (null while
 * the file does not exist: the first-run rules instead), so it stays the same text turn after turn and the prompt
 * cache holds; what changes every turn goes in the note.
 */
export function botSection(bot: BotContext["bot"], soul: string | null): string {
	const who = soul?.trim()
		? `Who you are, in your own words (${"SOUL.md"} in your folder; change it when the owner changes what you are for):\n${soul.trim().slice(0, SOUL_MAX)}`
		: [
				"This is your first run: there is no SOUL.md in your folder yet.",
				"- Learn from the owner who you should be and what you work on: ask, briefly, and listen.",
				"- Then write SOUL.md in your folder: your name, what you are for, how you work, what you must never do. Keep it short; it is read before every turn.",
			].join("\n");
	return `<ompdesk-bot>
You are the bot "${bot.name}", working for the owner from the folder ${bot.folder}. This session is one of your chats.
- Keep what you work on as items with ompdesk_item: add one for each piece of work, keep its status true (planned, working, waiting, needs_you, done, canceled), close it with a note when done.
- A choice only the owner can make goes on the item as a question (ompdesk_item set with ask and options); never guess it. Go on with other work meanwhile.
- Hand code work to sessions with ompdesk_session_open, naming the item (item), and follow them through their reports.
- Wake yourself later with ompdesk_schedule {"target":"self"}; never poll or wait in a loop.
- Talk with other sessions in a room with ompdesk_room when one is named.
- Your memory is your folder: write what you must remember into files there.
${who}
</ompdesk-bot>`;
}

function item(entry: BotItemBrief): string {
	const ask = entry.question
		? ` — asks: ${entry.question.text}${entry.question.options.length ? ` (${entry.question.options.join(" / ")})` : ""}`
		: "";
	return `- #${entry.number} ${entry.title} [${entry.status}]${ask}`;
}

/** What the bot should know at this turn's start: its open items, what waits on the owner, its other chats at work. */
export function botDigest(context: BotContext): string {
	const parts = [
		context.bot.paused ? "You are paused: nothing wakes you until the owner resumes you." : "",
		context.items.length ? `Open items:\n${context.items.map(item).join("\n")}` : "No open items.",
		context.needsYou.length ? `Waiting on the owner:\n${context.needsYou.map(item).join("\n")}` : "",
		context.live.length ? `Your other chats at work now: ${context.live.join("; ")}.` : "",
	];
	return parts.filter(Boolean).join("\n\n");
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (field(part, "type") === "text" ? String(field(part, "text") ?? "") : "")).join("");
}

/** A prompt the owner typed, as opposed to another session's message, a mail or a wake-up. */
export function ownerPrompt(prompt: string): boolean {
	return (
		prompt.trim().length > 0 &&
		!AGENT_MESSAGE_START.test(prompt) &&
		!prompt.trimStart().startsWith("<ompdesk-") &&
		!/\[ompdesk (?:dispatch|request) /.test(prompt)
	);
}

/** The digest of the newest note this branch holds since its last compaction (the model no longer sees older ones). */
function latestDigest(branch: readonly unknown[]): string | undefined {
	let digest: string | undefined;
	for (const entry of branch) {
		const type = field(entry, "type");
		if (type === "compaction") digest = undefined;
		else if (type === "custom_message" && field(entry, "customType") === BOT_NOTE_TYPE) {
			const kept = field(field(entry, "details"), "digest");
			digest = typeof kept === "string" ? kept : undefined;
		}
	}
	return digest;
}

/** How many turns the owner typed on this branch before this one. */
function ownerTurns(branch: readonly unknown[]): number {
	let count = 0;
	for (const entry of branch) {
		const message = field(entry, "message");
		if (field(entry, "type") === "message" && field(message, "role") === "user") {
			if (ownerPrompt(text(field(message, "content")))) count++;
		}
	}
	return count;
}

export const OWNER_REMINDER = "Put any question still waiting for the owner on an item (ompdesk_item set with ask).";

/**
 * The note this turn starts with, or null: the digest when it differs from the newest one the model holds, and on
 * every `OWNER_REMINDER_EVERY`th turn the owner typed the reminder to put open questions on items.
 */
export function botNote(
	context: BotContext,
	branch: readonly unknown[],
	prompt: string,
): { content: string; digest: string } | null {
	const digest = botDigest(context);
	const changed = digest !== latestDigest(branch);
	const remind = ownerPrompt(prompt) && (ownerTurns(branch) + 1) % OWNER_REMINDER_EVERY === 0;
	if (!changed && !remind) return null;
	const content = [changed ? digest : "", remind ? OWNER_REMINDER : ""].filter(Boolean).join("\n\n");
	return { content: `<ompdesk-bot-note>\n${content}\n</ompdesk-bot-note>`, digest };
}
