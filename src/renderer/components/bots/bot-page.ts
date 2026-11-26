/**
 * Which bot the Bots page shows and on which tab (Orca's bot panel place, `settings-view/bot-settings-place.ts`):
 * the sidebar's row menu, a chat's bot banner, the palette and Settings › Bots open it here.
 */
import { create } from "zustand";
import { useUiStore } from "../../stores/ui";

export const BOT_PAGE_TABS = ["activity", "chats", "settings"] as const;
export type BotPageTab = (typeof BOT_PAGE_TABS)[number];

export const useBotPage = create<{ botId: string | null; tab: BotPageTab }>()(() => ({
	botId: null,
	tab: "activity",
}));

/** Shows the bot on the Bots page (its Activity, or `tab`). */
export function openBotPage(botId: string, tab: BotPageTab = "activity"): void {
	useBotPage.setState({ botId, tab });
	useUiStore.getState().openBots();
}
