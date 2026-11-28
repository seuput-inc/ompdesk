/**
 * Which bot the Bots page shows and on which tab (Orca's bot panel place, `settings-view/bot-settings-place.ts`):
 * the sidebar's row menu, a chat's bot banner, the palette and Settings › Bots open it here.
 */
import { create } from "zustand";
import { useUiStore } from "../../stores/ui";

export const BOT_PAGE_TABS = ["activity", "items", "chats", "settings"] as const;
export type BotPageTab = (typeof BOT_PAGE_TABS)[number];

/** The Bots page's detail: a bot (on one of its tabs) or a group's room (`roomId`, which wins while set). */
export const useBotPage = create<{ botId: string | null; tab: BotPageTab; roomId: string | null }>()(() => ({
	botId: null,
	tab: "activity",
	roomId: null,
}));

export function botPageKey(id: string, device?: string): string {
	return device ? `${device}\0${id}` : id;
}

/** Shows the bot on the Bots page (its Activity, or `tab`). */
export function openBotPage(botId: string, tab: BotPageTab = "activity", device?: string): void {
	useBotPage.setState({ botId: botPageKey(botId, device), tab, roomId: null });
	useUiStore.getState().openBots();
}

/** Shows a group's room on the Bots page. */
export function openRoomPage(roomId: string): void {
	useBotPage.setState({ roomId });
	useUiStore.getState().openBots();
}
