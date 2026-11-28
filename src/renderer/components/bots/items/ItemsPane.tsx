/**
 * Items in their pane: the list, or one item in the list's place with Back to it (Orca's `BotItemPane.tsx`). The open
 * item and the list's order are kept per bot or group. An archive row remains addressable without being in the feed.
 */
import { useRef, useState } from "react";
import type { Bot } from "../../../../shared/bots";
import type { ListedItem } from "../../../../shared/items-v2";
import { useT } from "../../../lib/i18n";
import { itemCounts, itemEpoch, listedItem, listedItemByNumber, useBotsStore } from "../../../stores/bots";
import { Button } from "../../common";
import { botPageKey } from "../bot-page";
import { BotItemPage } from "./BotItemPage";
import { BotItems } from "./BotItems";
import { useItemHistory } from "./item-detail";
import { itemPlace } from "./item-place";
import { openItem, setOrder, useItemsUi } from "./item-store";

export function ItemsPane({ owner, bots, group }: { owner: string; bots: readonly Bot[]; group: boolean }) {
	const open = useItemsUi(s => s.open[owner] ?? null);
	const order = useItemsUi(s => s.order[owner]);
	const walked = useRef<readonly ListedItem[]>([]);
	const [visitedList, setVisitedList] = useState(!open);
	if (!open && !visitedList) setVisitedList(true);
	const [ownerKey, id] = open?.startsWith("\0")
		? (JSON.parse(open.slice(1)) as [string, string | number])
		: [owner, open];
	const bot = bots.find(entry => botPageKey(entry.id, entry.device) === ownerKey);
	const inspecting = !!bot && id != null;
	const epoch = useBotsStore(() => itemEpoch(bot?.device ?? null));
	return (
		<>
			{(visitedList || !inspecting) && (
				<div hidden={inspecting} className="min-h-0 overflow-y-auto">
					<BotItems
						bots={bots}
						group={group}
						active={!inspecting}
						onOpen={picked => openItem(owner, itemPlace(picked.bot, picked.device, picked.id))}
						onOrder={
							inspecting
								? undefined
								: (next, rows) => {
										walked.current = rows;
										setOrder(owner, next);
									}
						}
					/>
				</div>
			)}
			{inspecting && (
				<ItemInspector
					key={`${epoch}:${open}`}
					bot={bot}
					id={id}
					order={order ?? []}
					summary={walked.current.find(row => row.id === id && row.bot === bot.id && row.device === bot.device)}
					onBack={() => openItem(owner, null)}
					onStep={place => openItem(owner, place)}
				/>
			)}
		</>
	);
}

function ItemInspector({
	bot,
	id,
	summary,
	order,
	onBack,
	onStep,
}: {
	bot: Bot;
	id: string | number;
	summary?: ListedItem;
	order: readonly string[];
	onBack: () => void;
	onStep: (place: string) => void;
}) {
	const t = useT();
	const row = useBotsStore(s =>
		typeof id === "string"
			? listedItem(s.state, bot.device, id)
			: listedItemByNumber(s.state, bot.device, bot.id, id),
	);
	const online = useBotsStore(s => !bot.device || !!s.state.remote?.find(host => host.device === bot.device)?.online);
	const archiveRevision = useBotsStore(() => (row ? undefined : itemCounts(bot.device, bot.id)?.archiveRevision));
	const legacy = row && row.bot === bot.id && "events" in row ? row : undefined;
	const signal = row ?? archiveRevision;
	const { detail, earlier, error, paging, retry } = useItemHistory(bot.id, id, bot.device, signal, !!legacy, online);
	const history = detail?.item;
	const item =
		legacy ??
		(history && row && row.bot === bot.id && row.version > history.version
			? { ...history, ...row, question: row.question, wait: row.wait, snoozedUntil: row.snoozedUntil }
			: (history ?? (row?.bot === bot.id ? row : summary)));
	const failure = error && (
		<div role="alert">
			{error}{" "}
			<Button onClick={retry} size="sm" variant="ghost">
				{t("common.retry")}
			</Button>
		</div>
	);
	return item ? (
		<BotItemPage
			bot={bot}
			item={item}
			asks={detail?.asks}
			order={order}
			onBack={onBack}
			onStep={onStep}
			earlier={detail?.beforeEvent ? earlier : undefined}
			paging={paging}
			failure={failure}
		/>
	) : (
		<div className="p-3">
			<Button onClick={onBack} size="sm" variant="ghost">
				{t("bots.items.view.back")}
			</Button>
			{typeof id === "number" && <span className="tabular-nums">#{id}</span>}
			{failure}
		</div>
	);
}
