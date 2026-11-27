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
import type { RowSelectionOf } from "../layout/sidebar/row-selection";
import { openBotChat } from "./bot-launch";
import { remoteBotTree } from "./bot-view";

export function RemoteBotChats({ bot, selectionOf }: { bot: Bot; selectionOf: RowSelectionOf }) {
	const t = useT();
	const online = useHostView(bot.device)?.state === "online";
	const { sessions } = useSessionList("global", bot.device, { read: online });
	const tabs = useTabsStore(s => s.tabs);
	const { chats, children } = remoteBotTree(bot, sessions, useProjectList(bot.device, online));
	const render = (session: SessionInfo) => {
		const home = session.path === bot.home;
		const tab = tabs.find(tab => tab.device === bot.device && tab.sessionPath === session.path);
		const { selected: active, current } = selectionOf(tab?.id);
		return (
			<ListRow
				key={session.path}
				buttonProps={{ "data-roving-item": `device-session:${bot.device}:${session.path}`, tabIndex: -1 }}
				className="omp-sidebar-session-row"
				leading={home ? <House aria-hidden className="size-4 text-(--sc-accent)" /> : undefined}
				meta={<TimeAgo className="text-(--sc-text-subtle)" iso={session.modified} />}
				onClick={() => void openBotChat(bot, session.path, undefined, session.cwd).catch(() => {})}
				rowProps={{ "data-active": active, "data-current": (active && current) || undefined }}
				selected={active}
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
