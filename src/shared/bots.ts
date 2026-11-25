/**
 * Bots and their items (Orca's local-first bot model on stock omp sessions; the owner's decision, 25 Nov 2026,
 * reversing the bot's removal in 0a5d4f0d7). A bot is a folder on this computer (`~/.omp/bots/<slug>` unless the
 * owner picks one) whose sessions are its chats: every session whose folder is the bot's is one of them, its home chat
 * the one the registry names. `SOUL.md` in the folder says who it is (the bot writes it on its first run); `MEMORY.md`
 * there is what it remembers. Items are what a bot works on for its owner and what it needs from them. The core's
 * agent control holds both (`native/ompdesk/crates/core/src/agentctl`); this file is the contract main, the renderer
 * and the tests share.
 *
 * Dependency-free.
 */

/**
 * Whether this build has bots: the registry and a way to make the first one (`ompdesk_bot create`, the `ompdesk bot`
 * CLI). The Bots navigation row and page (orca-look-shell) show only while it is true.
 */
export const BOTS_AVAILABLE = false;
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
	/** The first paragraph of its SOUL.md that is not a heading, about 120 characters: what it is for. */
	specialty?: string;
	createdAt: string;
}

export const ITEM_STATUSES = ["planned", "working", "waiting", "needs_you", "done", "canceled"] as const;
/** `waiting`: on something outside the bot and its owner; `needs_you`: on the owner's answer. */
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const ITEM_OPEN_STATUSES: readonly ItemStatus[] = ["planned", "working", "waiting", "needs_you"];

export interface ItemQuestion {
	text: string;
	/** Quick answers the owner can pick (may be empty: then only a written answer). */
	options: string[];
	/** Index into `options` the bot recommends. */
	recommended?: number;
}

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
	at: string;
	actor: "bot" | "owner";
	kind: "made" | "edited" | "status" | "commented" | "linked" | "snoozed" | "answered";
	text?: string;
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
	wait?: { text: string; until?: string };
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
}

export type BotsRequest =
	| { action: "get" }
	| { action: "create"; name: string; folder?: string }
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
	  }
	| { action: "delete"; id: string }
	/** The owner's change to an item: each one is mailed to the item's chat once. */
	| {
			action: "item";
			id: string;
			status?: ItemStatus;
			/** An answer to its question: one of its options, or written. */
			answer?: { choice?: number; text?: string };
			comment?: string;
			snoozeUntil?: string | null;
	  }
	/** Hand a session to a bot: the bot's home chat becomes its opener and gets `text` as mail. */
	| { action: "handTo"; id: string; session: string; text: string };

export interface BotsApi {
	command(request: BotsRequest): Promise<BotsState>;
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
	return last.replace(/^(?:#+\s*|[-*>]\s+)/, "").replace(/[*_`~.\s]/g, "") === NO_REPLY;
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
