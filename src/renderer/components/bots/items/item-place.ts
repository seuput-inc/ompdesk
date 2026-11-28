import type { Bot, Item } from "../../../../shared/bots";
import { botPageKey, openBotPage } from "../bot-page";
import { openItem } from "./item-store";

/** Kept by the list's walk, even when an archived row is not in the feed. */
export const itemPlace = (bot: string, device: string | undefined, id: string | number) =>
	`\0${JSON.stringify([botPageKey(bot, device), id])}`;

const places = new WeakMap<Pick<Item, "bot" | "device" | "id">, string>();
export function rowPlace(row: Pick<Item, "bot" | "device" | "id">): string {
	let key = places.get(row);
	if (key === undefined) {
		key = itemPlace(row.bot, row.device, row.id);
		places.set(row, key);
	}
	return key;
}

export function showBotItem(bot: Pick<Bot, "id" | "device">, id: string | number): void {
	openItem(botPageKey(bot.id, bot.device), itemPlace(bot.id, bot.device, id));
	openBotPage(bot.id, "items", bot.device);
}
