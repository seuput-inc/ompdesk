/**
 * The Bots page (Orca's bots, back by the owner's decision of 25 Nov 2026): the destination the sidebar's Bots row,
 * a bot row's menu, a chat's bot banner, the palette and Settings › Bots open. Its bots on the left (face, name, second
 * line), the chosen bot's page on the right (`BotPane`); one pane at a time on a phone. "New bot" offers a blank bot,
 * the templates or an import. With no bot yet: what a bot is, with New bot and Templates.
 */
import { Bot as BotIcon, Download, LayoutTemplate, Plus, UsersRound } from "lucide-react";
import { useEffect } from "react";
import { useT } from "../../lib/i18n";
import { ensureBots, useBotsStore } from "../../stores/bots";
import { useBotsView } from "../../stores/bots-view";
import { Button, EmptyState, ListRow, MasterDetail, MenuButton, PageLayout, SectionLabel } from "../common";
import { BotAvatar } from "./BotAvatar";
import { BotLineText } from "./BotLineText";
import { BotPane } from "./BotPane";
import { openBotDialog } from "./bot-launch";
import { useBotPage } from "./bot-page";
import { sortBots } from "./bot-view";
import { BotRoom, GroupFaces, roomBots, roomPreview } from "./rooms/BotRoom";
import { useBotFacts } from "./use-bot-facts";

export function BotsPage() {
	const t = useT();
	const bots = useBotsStore(s => s.state.bots);
	const rooms = useBotsStore(s => s.state.rooms);
	const botId = useBotPage(s => s.botId);
	const roomId = useBotPage(s => s.roomId);
	const view = useBotsView();
	const facts = useBotFacts(bots);
	useEffect(() => ensureBots(), []);
	const sorted = sortBots(bots, view.sort, view.order, facts, false);
	const bot = bots.find(known => known.id === botId) ?? null;
	const room = rooms?.find(known => known.id === roomId) ?? null;
	// Beside the list (a window, a tablet) the first bot shows until one is chosen; a phone shows the list first.
	const shown = bot ?? sorted[0] ?? null;
	const fact = shown ? facts.get(shown.id) : undefined;
	const addMenu = (
		<MenuButton
			icon={<Plus />}
			items={[
				{ id: "new", label: t("bots.add.new"), icon: BotIcon, onSelect: () => openBotDialog({ kind: "new" }) },
				{
					id: "templates",
					label: t("bots.add.templates"),
					icon: LayoutTemplate,
					onSelect: () => openBotDialog({ kind: "templates" }),
				},
				{
					id: "import",
					label: t("bots.add.import"),
					icon: Download,
					onSelect: () => openBotDialog({ kind: "import" }),
				},
				{
					id: "group",
					label: t("bots.add.group"),
					icon: UsersRound,
					separatorBefore: true,
					disabled: bots.length === 0,
					disabledReason: t("bots.groups.needBots"),
					onSelect: () => openBotDialog({ kind: "group" }),
				},
			]}
			label={t("bots.add.label")}
			size="sm"
			variant="secondary"
		>
			{t("bots.add.new")}
		</MenuButton>
	);
	return (
		<PageLayout actions={addMenu} body="fill" description={t("bots.page.description")} title={t("destination.bots")}>
			{bots.length === 0 ? (
				<div className="flex min-h-64 flex-1 items-center justify-center" data-bots-page>
					<EmptyState
						actions={
							<>
								<Button icon={<Plus />} onClick={() => openBotDialog({ kind: "new" })} variant="primary">
									{t("bots.add.new")}
								</Button>
								<Button
									icon={<LayoutTemplate />}
									onClick={() => openBotDialog({ kind: "templates" })}
									variant="secondary"
								>
									{t("bots.add.templatesShort")}
								</Button>
							</>
						}
						description={t("bots.empty.description")}
						icon={<BotIcon />}
						title={t("bots.section.emptyTitle")}
					/>
				</div>
			) : (
				<div className="flex min-h-0 min-w-0 flex-1" data-bots-page>
					<MasterDetail
						backLabel={t("destination.bots")}
						className="min-h-0 min-w-0"
						detail={
							room ? (
								<BotRoom key={room.id} room={room} />
							) : shown && fact ? (
								<BotPane
									bot={shown}
									facts={fact}
									key={shown.id}
									onDeleted={() => useBotPage.setState({ botId: null })}
								/>
							) : (
								<EmptyState
									description={t("bots.page.pick")}
									icon={<BotIcon />}
									title={t("bots.page.pickTitle")}
								/>
							)
						}
						label={t("destination.bots")}
						list={[
							...sorted.map(item => {
								const itemFacts = facts.get(item.id);
								return (
									<ListRow
										buttonProps={{ "data-bots-page-row": item.id }}
										className={item.paused ? "opacity-60" : undefined}
										key={item.id}
										leading={
											<BotAvatar
												bot={item}
												mark={item.paused ? "paused" : (itemFacts?.needsYou ?? 0) > 0 ? "needsYou" : null}
												size={28}
											/>
										}
										onClick={() => useBotPage.setState({ botId: item.id, roomId: null })}
										secondary={itemFacts ? <BotLineText bot={item} line={itemFacts.line} /> : undefined}
										selected={room === null && item.id === shown?.id}
										title={item.name}
									/>
								);
							}),
							...(rooms?.length
								? [
										<SectionLabel className="mt-3 px-2.5" key="groups-label">
											{t("bots.groups.section")}
										</SectionLabel>,
										...rooms.map(entry => (
											<ListRow
												buttonProps={{ "data-bots-page-room": entry.id }}
												key={entry.id}
												leading={<GroupFaces bots={roomBots(entry, bots)} />}
												onClick={() => useBotPage.setState({ roomId: entry.id })}
												secondary={<span className="truncate">{roomPreview(entry, bots, t)}</span>}
												selected={entry.id === room?.id}
												title={entry.name}
											/>
										)),
									]
								: []),
						]}
						onBack={() => useBotPage.setState({ botId: null, roomId: null })}
						open={bot !== null || room !== null}
					/>
				</div>
			)}
		</PageLayout>
	);
}
