/**
 * A bot chat's pill in the title bar (Orca's `home-chat/BotHomeBanner.tsx`, FK-B13): the bot's face and name, which
 * opens its page; for its home chat the pill says so. Nothing for a chat that is no bot's, or while bots are off.
 * Hidden on a narrow bar, where the session's own title needs the room.
 */
import type { Bot } from "../../../shared/bots";
import { useBotsAvailable } from "../../lib/bots-source";
import { useT } from "../../lib/i18n";
import { botOfFolder, useBotsStore } from "../../stores/bots";
import { Button } from "../common";
import { BotAvatar } from "./BotAvatar";
import { openBotPage } from "./bot-page";
import { botChatHome } from "./bot-view";

export function BotHomeBanner({
	cwd,
	device,
	sessionPath,
}: {
	cwd: string | null | undefined;
	/** The paired host the tab runs on; absent = this computer. */
	device?: string;
	sessionPath?: string;
}) {
	const t = useT();
	const available = useBotsAvailable();
	const bot: Bot | undefined = useBotsStore(s => botOfFolder(s.state.bots, cwd, device));
	if (!available || !bot) return null;
	const home = sessionPath !== undefined && sessionPath === botChatHome(bot);
	return (
		<Button
			aria-label={t("bots.banner.open", { name: bot.name })}
			className="ml-2 hidden shrink-0 gap-1.5 rounded-full px-2 min-[720px]:inline-flex"
			data-bot-banner={home ? "home" : "chat"}
			onClick={() => openBotPage(bot.id)}
			size="sm"
			variant="ghost"
		>
			<BotAvatar bot={bot} size={16} />
			<span className="max-w-32 truncate">{home ? t("bots.banner.home", { name: bot.name }) : bot.name}</span>
		</Button>
	);
}
