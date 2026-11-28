/**
 * Every bot's facts (`botFacts`) for the surfaces outside the sidebar (the Bots page, the palette, the composer's
 * `@` list): its chats from the session list, each read by the one run rule (`sessionRun` over the computer's
 * summaries, as the sidebar's rows read them), and its items set to Needs you.
 */
import { useMemo } from "react";
import { type Bot, itemsNeedingYou } from "../../../shared/bots";
import { useSessionList } from "../../hooks/use-session-list";
import { ATTENTION_LABEL_KEY } from "../../lib/attention";
import { useT } from "../../lib/i18n";
import { sessionRun } from "../../lib/session-run";
import { sessionDisplayTitle } from "../../lib/session-title";
import { useBotsStore } from "../../stores/bots";
import { tabSummary, useHostedSessionsStore } from "../../stores/hosted-sessions";
import { useTabsStore } from "../../stores/tabs";
import { type BotChatFacts, type BotFacts, botChatHome, botFacts } from "./bot-view";

export function useBotFacts(bots: readonly Bot[]): ReadonlyMap<string, BotFacts> {
	const t = useT();
	const { sessions } = useSessionList("global");
	const items = useBotsStore(s => s.state.items);
	const tabs = useTabsStore(s => s.tabs);
	const summaries = useHostedSessionsStore(s => s.summaries);
	return useMemo(() => {
		const now = Date.now();
		return new Map(
			bots.map(bot => {
				// A paired host's bot chats there: its sessions are that host's, never this computer's list.
				const home = botChatHome(bot);
				const chats = sessions
					.filter(session => !bot.device && session.cwd === bot.folder)
					.map((session): BotChatFacts => {
						const tab = tabs.find(entry => entry.sessionPath === session.path && !entry.device);
						const run = sessionRun(
							tabSummary({ summaries }, tab ?? { id: "", sessionPath: session.path }),
							tab?.unreadDone,
						);
						return {
							path: session.path,
							title: session.path === home ? t("bots.chats.home") : sessionDisplayTitle(session, ""),
							modified: session.modified,
							waiting: run.ask ? t(ATTENTION_LABEL_KEY[run.ask]) : null,
							running: run.running,
							failed: run.failed,
							unread: run.done,
						};
					});
				const needing = itemsNeedingYou(
					items.filter(item => item.bot === bot.id),
					null,
					now,
				).length;
				return [bot.id, botFacts(bot, chats, needing)] as const;
			}),
		);
	}, [bots, sessions, items, tabs, summaries, t]);
}
