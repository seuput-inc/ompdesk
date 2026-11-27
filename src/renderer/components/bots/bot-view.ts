/**
 * What the sidebar, the Bots page and the palette say of a bot, decided once from its chats' rows and its items (the
 * sidebar's "one source" rule: a bot row reads its chats' summaries, never a second status). After Orca's
 * `shared/bots/bot-row-line.ts:89-167` (the second line), `bot-sidebar-view.ts:26-105` (sort and filter) and
 * `bot-collapsed-preview.ts:24-33` (the folded faces' order), re-implemented on OMPdesk's rows.
 */
import type { Bot } from "../../../shared/bots";
import type { SessionInfo } from "../../../shared/ipc-types";
import { isOmpdeskWorktreeFolder } from "../../../shared/project-origin";
import type { SidebarProjectsState } from "../../../shared/sidebar-projects";
import type { RowGroup } from "../../../shared/sidebar-rows";
import { sessionHasContent } from "../../lib/session-title";

/** One chat of a bot as its sidebar row reads it. */
export interface BotChatFacts {
	path: string;
	title: string;
	/** ISO time it last did something. */
	modified: string;
	/** What it waits on the person for, in words (a question, an approval, a child waiting); null when nothing. */
	waiting: string | null;
	running: boolean;
	failed: boolean;
	/** Finished since the person last looked. */
	unread: boolean;
}

export type BotLine =
	| { kind: "paused" }
	| { kind: "waiting"; label: string; chat: string }
	| { kind: "needsYou"; count: number }
	| { kind: "working"; chat: string }
	| { kind: "failed"; chat: string }
	| { kind: "done"; chat: string }
	| { kind: "purpose"; text: string }
	| { kind: "hello" }
	| { kind: "idle" };

export interface BotFacts {
	/** Its chats waiting on the person plus its items set to Needs you. */
	needsYou: number;
	working: boolean;
	failed: boolean;
	unread: boolean;
	/** ISO time of its newest activity (its newest chat, else when it was made). */
	latest: string;
	line: BotLine;
}

const newestFirst = (a: BotChatFacts, b: BotChatFacts) => Date.parse(b.modified) - Date.parse(a.modified);

/** The bot's facts: `chats` are its chats' rows (any order), `itemsNeedingYou` its items waiting on the owner. */
export function botFacts(bot: Bot, chats: readonly BotChatFacts[], itemsNeedingYou: number): BotFacts {
	const sorted = chats.toSorted(newestFirst);
	// The home chat wins a tie (Orca's bot-row-line.ts:111).
	const pick = (match: (chat: BotChatFacts) => boolean) =>
		sorted.find(chat => match(chat) && chat.path === bot.home) ?? sorted.find(match);
	const waiting = pick(chat => chat.waiting !== null);
	const working = pick(chat => chat.running);
	const newest = sorted[0];
	const waitingCount = chats.filter(chat => chat.waiting !== null).length;
	const line: BotLine = bot.paused
		? { kind: "paused" }
		: waiting
			? { kind: "waiting", label: waiting.waiting ?? "", chat: waiting.title }
			: itemsNeedingYou > 0
				? { kind: "needsYou", count: itemsNeedingYou }
				: working
					? { kind: "working", chat: working.title }
					: newest?.failed
						? { kind: "failed", chat: newest.title }
						: newest?.unread
							? { kind: "done", chat: newest.title }
							: bot.specialty
								? { kind: "purpose", text: bot.specialty }
								: chats.length === 0
									? { kind: "hello" }
									: { kind: "idle" };
	return {
		needsYou: waitingCount + itemsNeedingYou,
		working: working !== undefined,
		failed: newest?.failed === true,
		unread: chats.some(chat => chat.unread),
		latest: newest && Date.parse(newest.modified) > Date.parse(bot.createdAt) ? newest.modified : bot.createdAt,
		line,
	};
}

export const BOT_SORTS = ["manual", "smart", "recent", "name"] as const;
export type BotSort = (typeof BOT_SORTS)[number];

/**
 * The bots in the order the person picked (`manual`: their own order, a bot not in it on top; `smart`: the ones that
 * need the person first, then the most recent; `recent`; `name`), paused ones left out when `hidePaused`.
 */
export function sortBots(
	bots: readonly Bot[],
	sort: BotSort,
	order: readonly string[],
	facts: ReadonlyMap<string, BotFacts>,
	hidePaused: boolean,
): Bot[] {
	const placed = (bot: Bot) => {
		const at = order.indexOf(bot.id);
		// A bot the order does not name yet is newer than every one it does: on top, newest first.
		return at === -1 ? -1 - Date.parse(bot.createdAt) / 1e13 : at;
	};
	const recency = (bot: Bot) => Date.parse(facts.get(bot.id)?.latest ?? bot.createdAt);
	const collator = new Intl.Collator(undefined, { sensitivity: "base" });
	const shown = bots.filter(bot => !(hidePaused && bot.paused));
	const byPlace = (a: Bot, b: Bot) => placed(a) - placed(b);
	switch (sort) {
		case "name":
			return shown.toSorted((a, b) => collator.compare(a.name, b.name) || byPlace(a, b));
		case "recent":
			return shown.toSorted((a, b) => recency(b) - recency(a) || byPlace(a, b));
		case "smart":
			return shown.toSorted(
				(a, b) =>
					Number((facts.get(b.id)?.needsYou ?? 0) > 0) - Number((facts.get(a.id)?.needsYou ?? 0) > 0) ||
					recency(b) - recency(a) ||
					byPlace(a, b),
			);
		default:
			return shown.toSorted(byPlace);
	}
}

/** The faces a folded Bots header shows: who needs the person, then unread, then working, then the rest. */
export function foldedFaces(bots: readonly Bot[], facts: ReadonlyMap<string, BotFacts>): Bot[] {
	const rank = (bot: Bot) => {
		const fact = facts.get(bot.id);
		if (!fact) return 3;
		if (fact.needsYou > 0 || fact.failed) return 0;
		if (fact.unread) return 1;
		if (fact.working) return 2;
		return 3;
	};
	return bots.toSorted((a, b) => rank(a) - rank(b));
}

/** Whether `query` finds the bot by its name or what it is for (case- and accent-insensitive). */
export function botMatches(bot: Bot, query: string): boolean {
	const fold = (text: string) =>
		text
			.normalize("NFKD")
			.replace(/\p{Diacritic}/gu, "")
			.toLocaleLowerCase();
	const wanted = fold(query.trim());
	return !wanted || fold(bot.name).includes(wanted) || fold(bot.specialty ?? "").includes(wanted);
}

/** The bot record, not the cwd an older journal remembers, owns its saved chats. */
export function botChatFolders(bots: readonly Bot[]): Map<string, string> {
	const folders = new Map<string, string>();
	for (const bot of bots) {
		if (bot.home) folders.set(bot.home, bot.folder);
		for (const file of bot.sessions) folders.set(file, bot.folder);
	}
	return folders;
}

/** Only join saved files on one host. An older worker without a proven opener stays in its project. */
export function botWorkerChildren<T extends SessionInfo>(
	bot: Bot,
	chats: readonly T[],
	sessions: ReadonlyMap<string, T>,
	parents: Readonly<Record<string, string>> | undefined,
): Map<string, T[]> {
	const shown = new Set(chats.map(chat => chat.path));
	const children = new Map<string, T[]>();
	for (const worker of (bot.device ? bot.workerLinks : bot.workers) ?? []) {
		const row = sessions.get(worker.session);
		const opener = row?.openedBySession ?? worker.openedBySession;
		if (
			!row ||
			row.promptOriginDevice ||
			(row.device && row.device !== bot.device) ||
			!opener ||
			opener === row.path ||
			!shown.has(opener)
		)
			continue;
		if (worker.openedBySession && opener !== worker.openedBySession) continue;
		if (opener !== bot.home && !bot.sessions.includes(opener)) continue;
		if (parents?.[row.path] !== undefined && parents[row.path] !== opener) continue;
		const siblings = children.get(opener);
		if (siblings) siblings.push(row);
		else children.set(opener, [row]);
	}
	return children;
}

/** Both paired sections must agree on which saved rows the bot actually presents. */
export function remoteBotTree(bot: Bot, sessions: readonly SessionInfo[], projects: SidebarProjectsState) {
	const archived = new Set(projects.layout?.archivedSessions);
	const gone = new Set(projects.gone);
	const available = new Map(
		sessions
			.filter(
				row =>
					(!row.device || row.device === bot.device) &&
					!archived.has(row.id) &&
					sessionHasContent(row) &&
					(row.heldOnHost || !gone.has(row.cwd) || !isOmpdeskWorktreeFolder(row.cwd)),
			)
			.map(row => [row.path, row]),
	);
	const chats = [...available.values()]
		.filter(row => row.cwd === bot.folder || row.path === bot.home || bot.sessions.includes(row.path))
		.toSorted(
			(a, b) =>
				Number(b.path === bot.home) - Number(a.path === bot.home) ||
				Date.parse(b.modified) - Date.parse(a.modified),
		);
	return { chats, children: botWorkerChildren(bot, chats, available, projects.layout?.sessionParents) };
}

export function withoutBotWorkers(groups: RowGroup[], nested: ReadonlySet<string>): RowGroup[] {
	if (!nested.size) return groups;
	return groups.flatMap(group => {
		const sessions = group.sessions.filter(row => !nested.has(row.path));
		const folded = group.folded.filter(row => !nested.has(row.path));
		if (sessions.length === group.sessions.length && folded.length === group.folded.length) return [group];
		return sessions.length || folded.length || group.listed || group.open
			? [{ ...group, sessions, folded, sleeping: group.sleeping.filter(path => !nested.has(path)) }]
			: [];
	});
}

/** A free name: `name`, else `name 2`, `name 3`… (Orca's `freeBotName`). */
export function freeBotName(name: string, bots: readonly Bot[]): string {
	const taken = new Set(bots.map(bot => bot.name.toLocaleLowerCase()));
	if (!taken.has(name.toLocaleLowerCase())) return name;
	for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`.toLocaleLowerCase())) return `${name} ${n}`;
}
