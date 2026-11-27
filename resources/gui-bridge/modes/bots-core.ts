/**
 * The rules of a bot's chat (modes/bots.ts): what main's payload may hold, the prompt section that tells the agent it
 * is a bot, and the per-turn note of what changed (after Orca's bot preamble and turn context notes, re-implemented).
 * No omp imports: the GUI's vitest loads it directly.
 */
import { AGENT_MESSAGE_START, MAIL_CUSTOM_TYPE } from "../agent-control-contracts";
import {
	BOT_ENTRY,
	BOT_NOTE_TYPE,
	type BotChatFacts,
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
	// Several questions asked at once: each with its quick replies, after the words around them.
	const decisions = field(question, "decisions");
	const asked = Array.isArray(decisions)
		? decisions
				.map(decision => {
					const prompt = line(field(decision, "question"));
					const replies = field(decision, "options");
					const said = Array.isArray(replies) ? replies.map(line).filter(Boolean) : [];
					return prompt && said.length ? `${prompt} (${said.join(" / ")})` : prompt;
				})
				.filter(Boolean)
				.slice(0, 5)
		: [];
	const text = [line(field(question, "text")), ...asked].filter(Boolean).join("; ");
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
		bot: { id, name, folder, paused: field(bot, "paused") === true, firstRun: field(bot, "firstRun") === true },
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
 * Orca's first-run rules (`bot-preamble.ts:94-102`), in the home chat of a bot in its first run: OMPdesk's kickoff
 * gets a greeting and one question, the owner's first task one small real piece of work shown, then SOUL.md.
 */
const FIRST_RUN_RULES = [
	"First run (until the owner's first message in this chat is handled; then these rules no longer apply):",
	'- When OMPdesk tells you that you were just created, run no commands and read nothing. Reply with one short sentence: a greeting that ends with your one first question, e.g. "Hi! What should I start on?" in your own words for your job. Don\'t restate your name or what you are for; nothing else: no list of what you can do, no ideas, no choices.',
	"- When OMPdesk's first message gives you setup steps (bringing over a bot from another app, a template), that is your setup: follow it instead of greeting.",
	"- When the owner answers, work from what they said. If you can't tell where to look (which project or folder), ask that one question. Otherwise look only at what the answer needs, do one small real piece of the work now, and show the result in a few lines.",
	'- Then write SOUL.md in your folder from what you know: what you are for in one sentence first (keep what it already says), then "## How I work" with where you look and where you report. Keep any "## Never" section as it is. Tell the owner in one line what you saved and that they can change it by telling you.',
	"- Don't ask how to check in or what is off-limits, and don't give a tour.",
].join("\n");

/**
 * The prompt section: who the bot is and how it works. It reads only the name, the folder, its first run and
 * `SOUL.md`, so it stays the same text turn after turn and the prompt cache holds; what changes every turn goes in the
 * note. The first-run rules ride while the core says the first run lasts (`firstRun`), whether or not SOUL.md exists:
 * a bot made with a purpose has one from the start.
 */
export function botSection(bot: BotContext["bot"], soul: string | null): string {
	const who = soul?.trim()
		? `Who you are, in your own words (${"SOUL.md"} in your folder; change it when the owner changes what you are for):\n${soul.trim().slice(0, SOUL_MAX)}`
		: 'There is no SOUL.md in your folder yet: write it once you know what you are for (one sentence first, then "## How I work"). Keep it short; it is read before every turn.';
	return `<ompdesk-bot>
You are the bot "${bot.name}", working for the owner from the folder ${bot.folder}. This session is one of your chats.
- Keep what you work on as items with ompdesk_item: add one for each piece of work, keep its status true (planned, working, waiting, needs_you, done, canceled), close it with a note when done.
- A choice only the owner can make goes on the item as a question (ompdesk_item set with ask and options); never guess it. Go on with other work meanwhile.
- Hand code work to sessions with ompdesk_session_open. Name the project folder (folder) and item (item), and follow their reports. A new worker in a local Git project outside your bot folder gets its own worktree unless you set worktree: false.
- When the owner hands you an existing session, find it with ompdesk_sessions and use ompdesk_bot {"action":"hand","session":<its id>,"text":"Where does the work stand?"}. Its reports then come to your home chat.
- Change Look around with ompdesk_bot look_around only when your owner asks.
- Wake yourself later with ompdesk_schedule {"target":"self"}; never poll or wait in a loop.
- Talk with other sessions in a room with ompdesk_room when one is named.
- Keep each fact you must remember as one list line in MEMORY.md in your folder, edited with your file tools (forget a fact by deleting its line); read MEMORY.md when a turn needs it.
- When a turn has nothing worth saying to the owner (a routine run, a look around that found nothing), end your answer with a last line NO_REPLY.
${who}${bot.firstRun ? `\n${FIRST_RUN_RULES}` : ""}
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

/** What the branch says for the core's first run (`BotChatFacts`); `kickoff` names the newest kickoff's mail id. */
export function chatFacts(branch: readonly unknown[], kickoff: string | undefined, streaming: boolean): BotChatFacts {
	let state: BotChatFacts["kickoff"] = "none";
	for (const entry of branch) {
		if (
			kickoff &&
			field(entry, "type") === "custom_message" &&
			field(entry, "customType") === MAIL_CUSTOM_TYPE &&
			field(field(entry, "details"), "id") === kickoff
		)
			state = "queued";
		const message = field(entry, "message");
		// An answer with no words (one that only called tools, or failed) is silent.
		if (state !== "none" && field(entry, "type") === "message" && field(message, "role") === "assistant")
			state = state === "spoke" || text(field(message, "content")).trim() ? "spoke" : "silent";
	}
	return { ownerTurns: ownerTurns(branch), streaming, kickoff: state };
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
