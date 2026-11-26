/**
 * A paired host's bot's chats under its row in the sidebar's Bots section (orca-bots-remote): its chats are that host's
 * sessions in the bot's folder, which the host's own section leaves out of its projects, as this computer's bot chats
 * leave its projects. Each opens as a tab of the host; the home chat first, the newest after.
 */
import { House } from "lucide-react";
import type { Bot } from "../../../shared/bots";
import { useSessionList } from "../../hooks/use-session-list";
import { useT } from "../../lib/i18n";
import { sessionDisplayTitle, sessionHasContent } from "../../lib/session-title";
import { useHostView } from "../../stores/remote";
import { useTabsStore } from "../../stores/tabs";
import { ListRow, TimeAgo } from "../common";
import { openBotChat } from "./bot-launch";

export function RemoteBotChats({ bot }: { bot: Bot }) {
	const t = useT();
	const online = useHostView(bot.device)?.state === "online";
	const { sessions } = useSessionList("global", bot.device, { read: online });
	const activeTab = useTabsStore(s => s.tabs.find(tab => tab.id === s.activeTabId));
	const chats = sessions
		.filter(session => session.cwd === bot.folder && sessionHasContent(session))
		.toSorted(
			(a, b) =>
				Number(b.path === bot.home) - Number(a.path === bot.home) ||
				Date.parse(b.modified) - Date.parse(a.modified),
		);
	return chats.map(session => {
		const home = session.path === bot.home;
		return (
			<ListRow
				data-bot-chat={home ? "home" : "side"}
				key={session.path}
				leading={home ? <House aria-hidden className="size-4 text-(--sc-accent)" /> : undefined}
				meta={<TimeAgo className="text-(--sc-text-subtle)" iso={session.modified} />}
				onClick={() => void openBotChat(bot, session.path).catch(() => {})}
				selected={activeTab?.device === bot.device && activeTab?.sessionPath === session.path}
				size="sm"
				title={home ? t("bots.chats.home") : sessionDisplayTitle(session, "") || t("bots.chats.untitled")}
			/>
		);
	});
}
