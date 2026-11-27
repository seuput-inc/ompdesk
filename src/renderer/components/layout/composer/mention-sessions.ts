/**
 * Sessions in the composer's `@` menu (Orca's chat and crew mentions, `native-chat-mention-chats.ts` and
 * `orchestration-crew/native-chat-crew-mentions.tsx`, MIT, re-implemented): the sessions this one's agent opened
 * first, then this project's other sessions. A pick writes the session's title and saved id into the message, the
 * address every `ompdesk_session_*` tool takes, so the agent can read it or write to it.
 */
import { useBotsFeature } from "../../../lib/bots-source";
import { ensureBots, useBotsStore } from "../../../stores/bots";
import { sessionListFeed } from "../../../stores/session-list";
import { useTabsStore } from "../../../stores/tabs";
import type { CompletionItem } from "./use-completion-menu";

export interface MentionSession {
	/** The saved id (stock's session id): the same on every computer and after a relaunch. */
	id: string;
	title: string;
	/** This session's agent opened it (`ompdesk_session_open`). */
	child: boolean;
}

/** At most this many sessions join the `@` menu. */
const SESSION_MENTION_LIMIT = 8;

/** What a picked session puts in the message: its title, and the saved id every `ompdesk_session_*` tool takes. */
export function sessionMentionText(session: Pick<MentionSession, "id" | "title">): string {
	return `session “${session.title}” (${session.id}) `;
}

/** The sessions whose title holds `query` (all of them for an empty one), children first, as `@` menu rows. */
export function sessionMentionItems(
	sessions: readonly MentionSession[],
	query: string,
	labels: { child: string; session: string },
): CompletionItem[] {
	const needle = query.replace(/^"/, "").toLocaleLowerCase();
	const items: CompletionItem[] = [];
	for (const session of sessions) {
		const at = session.title.toLocaleLowerCase().indexOf(needle);
		if (at === -1) continue;
		items.push({
			value: sessionMentionText(session),
			label: session.title,
			description: session.child ? labels.child : labels.session,
			highlights: needle ? [[at, at + needle.length]] : [],
		});
		if (items.length >= SESSION_MENTION_LIMIT) break;
	}
	return items;
}

/**
 * Tab `tabId`'s opened sessions, then the other sessions of its folder on the computer it runs on, newest first, as
 * the stores hold them when the `@` menu is derived (each keystroke derives it again).
 */
export function mentionSessions(cwd: string, tabId: string | null): MentionSession[] {
	const { tabs } = useTabsStore.getState();
	const own = tabs.find(tab => tab.id === tabId);
	const seen = new Set<string>(own?.sessionId ? [own.sessionId] : []);
	const sessions: MentionSession[] = [];
	for (const tab of tabs) {
		if (!tab.sessionId || seen.has(tab.sessionId)) continue;
		const opened = tab.openedBy === tabId || (own?.sessionPath && tab.openedBySession === own.sessionPath);
		if (!opened) continue;
		seen.add(tab.sessionId);
		sessions.push({ id: tab.sessionId, title: tab.title || tab.sessionId, child: true });
	}
	// The whole list of the computer the tab runs on (the sidebar holds it open); this folder's rows are kept.
	const rows = sessionListFeed("global", own?.device)
		.store.getState()
		.sessions.filter(row => row.cwd === cwd && !seen.has(row.id) && row.title)
		.sort((a, b) => b.modified.localeCompare(a.modified));
	for (const row of rows) sessions.push({ id: row.id, title: row.title ?? row.id, child: false });
	return sessions;
}

/** At most this many bots join the `@` menu. */
const BOT_MENTION_LIMIT = 6;

/**
 * This computer's bots whose name or purpose holds `query`, as `@` menu rows above the files (Orca's bot mention
 * targets, `use-bot-mention-targets.tsx:15-23`, and `use-bot-chat-composer-room.tsx:46-193`). A pick writes
 * `bot “<name>” (bot:<name>) `, the address `ompdesk_session_send` and `ompdesk_report` take for its home chat; a
 * paused bot is listed as paused (a send to it is refused). None while the bots feature is off.
 */
export function botMentionItems(query: string, labels: { paused: string; bot: string }): CompletionItem[] {
	if (!useBotsFeature.getState().available) return [];
	ensureBots();
	const needle = query.replace(/^"/, "").toLocaleLowerCase();
	const items: CompletionItem[] = [];
	for (const bot of useBotsStore.getState().state.bots) {
		if (bot.device) continue;
		const at = bot.name.toLocaleLowerCase().indexOf(needle);
		if (at === -1 && !(needle && bot.specialty?.toLocaleLowerCase().includes(needle))) continue;
		items.push({
			value: `bot “${bot.name}” (bot:${bot.name}) `,
			label: bot.name,
			description: bot.paused ? labels.paused : (bot.specialty ?? labels.bot),
			highlights: needle && at >= 0 ? [[at, at + needle.length]] : [],
		});
		if (items.length >= BOT_MENTION_LIMIT) break;
	}
	return items;
}
