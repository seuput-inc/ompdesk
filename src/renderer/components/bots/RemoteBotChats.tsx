/**
 * A paired host's bot's chats under its row in the sidebar's Bots section (orca-bots-remote): its chats are that host's
 * sessions in the bot's folder, which the host's own section leaves out of its projects, as this computer's bot chats
 * leave its projects. Each opens as a tab of the host; the home chat first, the newest after.
 */
import { House } from "lucide-react";
import { Fragment } from "react";
import type { Bot } from "../../../shared/bots";
import type { SessionInfo } from "../../../shared/ipc-types";
import { useSessionList } from "../../hooks/use-session-list";
import { useT } from "../../lib/i18n";
import { sessionDisplayTitle } from "../../lib/session-title";
import { useHostView } from "../../stores/remote";
import { useProjectList } from "../../stores/sidebar-projects";
import { useTabsStore } from "../../stores/tabs";
import { ListRow, TimeAgo } from "../common";
import { openBotChat } from "./bot-launch";
import { remoteBotTree } from "./bot-view";

export function RemoteBotChats({ bot }: { bot: Bot }) {
	const t = useT();
	const online = useHostView(bot.device)?.state === "online";
	const { sessions } = useSessionList("global", bot.device, { read: online });
	const activeTab = useTabsStore(s => s.tabs.find(tab => tab.id === s.activeTabId));
	const { chats, children } = remoteBotTree(bot, sessions, useProjectList(bot.device, online));
	const render = (session: SessionInfo) => {
		const home = session.path === bot.home;
		return (
			<ListRow
				key={session.path}
				leading={home ? <House aria-hidden className="size-4 text-(--sc-accent)" /> : undefined}
				meta={<TimeAgo className="text-(--sc-text-subtle)" iso={session.modified} />}
				onClick={() => void openBotChat(bot, session.path, undefined, session.cwd).catch(() => {})}
				selected={activeTab?.device === bot.device && activeTab?.sessionPath === session.path}
				size="sm"
				title={home ? t("bots.chats.home") : sessionDisplayTitle(session, "") || t("bots.chats.untitled")}
			/>
		);
	};
	return chats.map(chat => (
		<Fragment key={chat.path}>
			{render(chat)}
			{children.has(chat.path) && (
				<div className="pl-3" data-bot-worker-rows={chat.path}>
					{children.get(chat.path)?.map(render)}
				</div>
			)}
		</Fragment>
	));
}
