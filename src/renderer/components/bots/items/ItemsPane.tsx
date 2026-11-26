/**
 * Items in their pane: the list, or one item in the list's place with Back to it (Orca's `BotItemPane.tsx`). The open
 * item and the list's order are kept per bot or group (`item-store.ts`), so the pane comes back to the item it showed;
 * an item that left the state (deleted with its bot, or closed a week ago) falls back to the list.
 */
import type { Bot } from "../../../../shared/bots";
import { useBotsStore } from "../../../stores/bots";
import { BotItemPage } from "./BotItemPage";
import { BotItems } from "./BotItems";
import { openItem, setOrder, useItemsUi } from "./item-store";

export function ItemsPane({ owner, bots, group }: { owner: string; bots: readonly Bot[]; group: boolean }) {
	const open = useItemsUi(s => s.open[owner] ?? null);
	const order = useItemsUi(s => s.order[owner]);
	const item = useBotsStore(s => (open ? s.state.items.find(entry => entry.id === open) : undefined));
	const bot = item ? bots.find(known => known.id === item.bot) : undefined;
	if (item && bot)
		return (
			<BotItemPage
				bot={bot}
				item={item}
				key={item.id}
				onBack={() => openItem(owner, null)}
				onStep={id => openItem(owner, id)}
				order={order ?? []}
			/>
		);
	return (
		<BotItems
			bots={bots}
			group={group}
			onOpen={picked => openItem(owner, picked.id)}
			onOrder={next => setOrder(owner, next)}
		/>
	);
}
