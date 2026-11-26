/**
 * Bots and their items (Orca's local-first bot model on stock omp sessions; the owner's decision, 25 Nov 2026,
 * reversing the bot's removal in 0a5d4f0d7). A bot is a folder on this computer (`~/.omp/bots/<slug>` unless the
 * owner picks one) whose sessions are its chats: every session whose folder is the bot's is one of them, its home chat
 * the one the registry names. `SOUL.md` in the folder says who it is (the bot writes it on its first run); `MEMORY.md`
 * there is what it remembers. Items are what a bot works on for its owner and what it needs from them; a group is
 * bots the owner put together, talking with the owner in the group's room. The core's agent control holds all of it
 * (`native/ompdesk/crates/core/src/agentctl`); this file is the contract main, the renderer and the tests share.
 *
 * Dependency-free.
 */

/**
 * Whether this build has bots: the registry and a way to make the first one (`ompdesk_bot create`, the `ompdesk bot`
 * CLI). The Bots navigation row and page (orca-look-shell) show only while it is true.
 */
export const BOTS_AVAILABLE = true;
export const BOTS_COMMAND = "bots:command";
export const BOTS_STATE = "bots:state";

/** Where a new bot's folder goes, under the home folder, unless the owner picks one. */
export const BOTS_FOLDER = ".omp/bots";
/** Days an open item may go untouched before it reads as stale, unless the bot says otherwise. */
export const ITEM_STALE_DAYS = 7;
/** Days a closed item stays in the state after it closed. */
export const ITEM_CLOSED_KEPT_DAYS = 7;
/** A bot answer ending in this line (any Markdown around it) is a quiet result: nothing is posted or notified. */
export const NO_REPLY = "NO_REPLY";

export interface Bot {
	id: string;
	name: string;
	/** Absolute folder its chats run in. */
	folder: string;
	/** Its home chat's session file: the one chat that always exists (null until its first chat). */
	home: string | null;
	/** Session files of its chats on this computer, oldest first. */
	sessions: string[];
	/** A paused bot is woken by nothing: its mail is held until it is resumed, sends to it are refused. */
	paused: boolean;
	/** `--model` selector its new chats and its routines use; null = omp's default. */
	model: string | null;
	/** Its routines run every tool without asking (`--yolo`); a chat still asks as any session does. */
	autoApprove: boolean;
	/** Paired devices (by id) whose agents may message it; empty = this computer's only. */
	reach: string[];
	/** Days an open item goes untouched before it reads as stale; null = never. */
	staleDays: number | null;
	/** Its Look around routine (a schedule id in Settings › Schedules); null when off. */
	lookAround: string | null;
	/** Its memory upkeep routine (a schedule id); null when off. */
	tidy: string | null;
	/** Notification kinds turned off for its chats (`BOT_QUIET_KINDS`); empty = all on. */
	quiet: BotQuietKind[];
	/** The first paragraph of its SOUL.md that is not a heading, about 120 characters: what it is for. */
	specialty?: string;
	/** Its picture (`picture.png|jpg|webp` in its folder) as a data URI; absent = its drawn face. */
	picture?: string;
	createdAt: string;
	/** The newest item event the owner had seen when they last opened its Items tab (`itemsOpened`). */
	itemsSeen?: number;
	/** Its first run lasts: its home chat is sent the kickoff and carries the first-run rules until the owner's first
	 *  turn there ends (the core's `bot_first_run.rs`). */
	firstRun?: boolean;
	/** The kickoffs sent to its home chat (their mail ids), oldest first. */
	kickoffs?: string[];
	/** The newest kickoff's turn ended without a word: its page offers Try again. */
	kickoffSilent?: boolean;
}

/** What a bot's chats can notify (Orca's per-bot notification toggles): an approval or question, a finished turn, a failure. */
export const BOT_QUIET_KINDS = ["permission", "done", "failed"] as const;
export type BotQuietKind = (typeof BOT_QUIET_KINDS)[number];
/** The longest purpose a new bot is given (Orca's `BOT_PURPOSE_MAX_LENGTH`; the core refuses a longer one). */
export const BOT_PURPOSE_MAX = 200;
/** The largest picture the core keeps (`bot_files.rs` `PICTURE_MAX`). */
export const BOT_PICTURE_MAX_BYTES = 512 * 1024;

export const ITEM_STATUSES = ["planned", "working", "waiting", "needs_you", "done", "canceled"] as const;
/** `waiting`: on something outside the bot and its owner; `needs_you`: on the owner's answer. */
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const ITEM_OPEN_STATUSES: readonly ItemStatus[] = ["planned", "working", "waiting", "needs_you"];

export interface ItemDecision {
	question: string;
	options: string[];
	recommended?: number;
	/** The owner may pick several of its options. */
	multi?: boolean;
}

export interface ItemQuestion {
	/** The bot's words: the question itself, or with `decisions` the words around them. */
	text: string;
	/** Quick answers the owner can pick (may be empty: then only a written answer). */
	options: string[];
	/** Index into `options` the bot recommends. */
	recommended?: number;
	/** The event that asked it: an answer names it, so one to a question the bot has since replaced is refused. */
	id?: number;
	/** Several questions asked at once (at most `ITEM_DECISIONS_MAX`), answered together. */
	decisions?: ItemDecision[];
}

/** Questions one ask holds, at most. */
export const ITEM_DECISIONS_MAX = 5;
/** What a Waiting item waits on, at most: one line. */
export const ITEM_WAIT_MAX = 200;
/** A comment or an answer, at most. */
export const ITEM_TEXT_MAX = 8_000;

export type ItemLinkKind = "session" | "pr" | "url" | "file" | "schedule";

export interface ItemLink {
	kind: ItemLinkKind;
	/** A session file, a URL, an absolute path or a schedule id. */
	ref: string;
	title?: string;
	/** A linked session's state as read now (sessions only). */
	state?: "working" | "waiting" | "done" | "failed" | "stopped" | "gone";
}

export interface ItemEvent {
	/** Counted across all items: what an item's question, an answer and a bot's seen mark name. */
	id: number;
	at: string;
	actor: "bot" | "owner";
	kind:
		| "made"
		| "edited"
		| "status"
		| "commented"
		| "asked"
		| "answered"
		| "linked"
		| "snoozed"
		| "unsnoozed"
		| "worker";
	/** A comment's, an ask's or an answer's words; a status's new status; a link's ref; a snooze's time; `made`: its status. */
	text?: string;
	/** `status`: the status it left, and why (what it waits on, a close note). */
	from?: string;
	note?: string;
	/** `edited`: the field and its words before and after. */
	field?: "title" | "description" | "doneMeans";
	before?: string;
	after?: string;
	/** An owner comment's or answer's request id: the same request again changes nothing. */
	request?: string;
	/** `answered`: the question event it answers. */
	question?: number;
	/** `unsnoozed`: a question or a close ended it before its time. */
	early?: boolean;
	/** `worker`: the linked session (`link`) and how it ended (`done`, `blocked`); `text` is its report's first line. */
	link?: string;
	state?: string;
}

export interface Item {
	id: string;
	bot: string;
	/** Per bot, from 1. */
	number: number;
	/** The bot chat it belongs to (a session file): the owner's changes are mailed there. */
	session: string;
	title: string;
	description?: string;
	/** What "done" means for it. */
	doneMeans?: string;
	status: ItemStatus;
	/** Set while `status` is `needs_you`. */
	question?: ItemQuestion;
	/** What a `waiting` item waits on, and until when if known. */
	wait?: { text: string; until?: string; at?: string };
	links: ItemLink[];
	/** Hidden from the board until then. */
	snoozedUntil?: string;
	createdAt: string;
	updatedAt: string;
	closedAt?: string;
	closeNote?: string;
	/** Newest last, capped. */
	events: ItemEvent[];
	/** Raised by every change; a change's mail is named by it, so a repeat is delivered once. */
	version: number;
	/** Read-time: open and untouched for its bot's `staleDays`. */
	stale?: boolean;
	/** Read-time: every live session it links waits for a usage limit; the earliest reset (ISO). */
	limitUntil?: string;
}

export interface BotsState {
	bots: Bot[];
	/** Open items, and closed ones for `ITEM_CLOSED_KEPT_DAYS`. */
	items: Item[];
	/** The bot groups and their rooms (absent in a state read before groups). */
	rooms?: Room[];
	/** The owner's answer named a question the bot has since replaced: nothing was written. */
	refused?: "question_changed";
}

/** One member asked to reply to a room post: `failed` says why in `error` (a bot with no chat yet). */
export interface RoomTurn {
	bot: string;
	/** Its name when it was asked. */
	name: string;
	state: "asked" | "replied" | "stopped" | "failed";
	at: string;
	error?: string;
}

export interface RoomMessage {
	id: string;
	seq: number;
	at: string;
	/** `owner`, or the bot's id. */
	author: string;
	/** The bot's name when it posted; empty for the owner. */
	name: string;
	text: string;
	/** The members it asked to reply. */
	turns: RoomTurn[];
	/** Hand-offs from the owner's post to this one. */
	hops: number;
}

/** Who answers the owner in a room: everyone, only those @mentioned, or one bot (`bot:<id>`) and any @mentioned. */
export type RoomReplyMode = "all" | "mentions" | `bot:${string}`;

/** A bot group and its room (Orca's bot groups): its members answer the owner there, each in its own home chat. */
export interface Room {
	id: string;
	name: string;
	/** Its bots' ids. */
	members: string[];
	replyMode: RoomReplyMode;
	createdAt: string;
	/** The newest posts, oldest first. */
	messages: RoomMessage[];
	lastSeq: number;
	/** Per member, the newest post it was shown. */
	seen: Record<string, number>;
}

/** A group's name, at most; one post, at most. */
export const ROOM_NAME_MAX = 80;
export const ROOM_POST_MAX = 20_000;

/** A skill a new bot starts with: written once as `.omp/skills/<name>/SKILL.md` in its folder. */
export interface BotSeedSkill {
	/** a-z, 0-9 and `-`. */
	name: string;
	content: string;
}

export type BotsRequest =
	| { action: "get" }
	| {
			action: "create";
			name: string;
			folder?: string;
			/** What it is for, `BOT_PURPOSE_MAX` characters at most: its SOUL.md's first paragraph unless `soul` is given. */
			purpose?: string;
			/** Its whole SOUL.md (a template's seed). A file already in the folder is kept. */
			soul?: string;
			skills?: BotSeedSkill[];
			/** The first message OMPdesk sends its home chat in place of the plain kickoff (a template's, an import's). */
			kickoff?: string;
	  }
	| {
			action: "update";
			id: string;
			name?: string;
			paused?: boolean;
			model?: string | null;
			autoApprove?: boolean;
			reach?: string[];
			staleDays?: number | null;
			/** Turn its Look around routine on (daily at `time`, local `HH:MM`, default 09:00) or off. */
			lookAround?: { on: boolean; time?: string };
			/** Turn its memory upkeep routine on (daily at `time`, default 03:00) or off. */
			tidy?: { on: boolean; time?: string };
			quiet?: BotQuietKind[];
			/** A `data:image/(png|jpeg|webp);base64,…` picture, or null for its drawn face. */
			picture?: string | null;
	  }
	| { action: "delete"; id: string }
	/** The owner's change to an item (`id`), or one move of several (`ids`): each chat is mailed once. */
	| {
			action: "item";
			id?: string;
			ids?: string[];
			status?: ItemStatus;
			/** Why it moved (a close note); with `wait`, what a Waiting item waits on. */
			note?: string;
			wait?: string;
			/** An answer to its question: one of its options, or written; `question` names the question it answers. */
			answer?: { choice?: number; text?: string; question?: number };
			comment?: string;
			/** A comment's or an answer's request id: sent again, it posts once. */
			requestId?: string;
			snoozeUntil?: string | null;
	  }
	/** The owner opened the bot's Items tab: its items as they are now are seen. */
	| { action: "itemsOpened"; id: string }
	/** Its page opened (the kickoff's one retry, `asked` false) or the owner's Try again (`asked`): sent again only
	 *  when its turn ended without a word and the owner wrote nothing there. */
	| { action: "kickoff"; id: string; asked?: boolean }
	| { action: "roomCreate"; name: string; bots: string[] }
	| { action: "roomUpdate"; id: string; name?: string; bots?: string[]; replyMode?: RoomReplyMode }
	| { action: "roomDelete"; id: string }
	/** The owner's post; `messageId` makes a resend post once. */
	| { action: "roomPost"; id: string; text: string; messageId: string }
	/** Ends every ask still open; a member chat at work is stopped. */
	| { action: "roomStop"; id: string }
	/** Hand a session to a bot: the bot's home chat becomes its opener and gets `text` as mail. */
	| { action: "handTo"; id: string; session: string; text: string };

/**
 * One of a bot's own files (`SOUL.md`, `MEMORY.md`, `memory/<name>.md`, `memory/history/<name>.md`): read, or written
 * when `content` is given. A write names the `expectedMtimeMs` it read; a file changed since is kept (`changed`).
 */
export interface BotFileRequest {
	action: "file";
	id: string;
	file: string;
	content?: string;
	expectedMtimeMs?: number;
	force?: boolean;
}

export interface BotFile {
	exists: boolean;
	content: string;
	mtimeMs: number;
	/** The `.md` files in its `memory/` folder (topic files and the archive). */
	topics: string[];
	/** The `.md` files in `memory/history/` (memory upkeep's copies and change lists), oldest first. */
	history: string[];
	/** A write found the file changed on disk since `expectedMtimeMs`: nothing was written; this is what is there. */
	changed?: true;
}

/** A bot of another app on this computer an import can bring over (Orca's `bot-import-sources.ts`). */
export interface BotImportSource {
	app: "openclaw" | "hermes" | "openbot";
	name: string;
	folder: string;
}

/** Everything `BOTS_COMMAND` takes: a change to the state, a file, or the import sources. */
export type BotsCall = BotsRequest | BotFileRequest | { action: "importSources" };
export type BotsAnswer<C extends BotsCall> = C extends BotFileRequest
	? BotFile
	: C extends { action: "importSources" }
		? { sources: BotImportSource[] }
		: BotsState;

export interface BotsApi {
	command(request: BotsRequest): Promise<BotsState>;
	file(request: Omit<BotFileRequest, "action">): Promise<BotFile>;
	importSources(): Promise<{ sources: BotImportSource[] }>;
	onState(callback: (state: BotsState) => void): () => void;
}

/**
 * Whether a bot's (or a routine's) answer is a quiet result: its last non-empty line, Markdown dressing aside
 * (`**`, `_`, backticks, a heading's or a list's mark, a trailing period), is `NO_REPLY`. After Orca's
 * `bot-quiet-result.ts`, re-implemented.
 */
export function isQuietResult(answer: string): boolean {
	const last = answer
		.trim()
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.at(-1);
	if (!last) return false;
	return last.replace(/^(?:#+\s*|[-*>]\s+)/, "").replace(/^[*_`~\s]+|[*_`~.\s]+$/g, "") === NO_REPLY;
}

/** The open items a bot chat's owner has to answer (Needs you), unsnoozed at `now`. */
export function itemsNeedingYou(items: readonly Item[], session: string | null, now: number): Item[] {
	return items.filter(
		item =>
			item.status === "needs_you" &&
			(session === null || item.session === session) &&
			!(item.snoozedUntil && Date.parse(item.snoozedUntil) > now),
	);
}
