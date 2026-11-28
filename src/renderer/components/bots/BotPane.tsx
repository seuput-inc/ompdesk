/**
 * One bot's page (Orca's bot panel, `BotActivityPanel.tsx:52-100`, `BotPanelHeader.tsx:143-276`, `BotPausedBanner`):
 * its header (face with its exception mark, name renamed in place, its now line, Open home chat, the gear for its
 * settings and More: pause or resume, copy its folder) and four tabs: Activity, Items (its count of what needs the
 * person; FK-B35), Chats and Settings (FK-B12, B08).
 * A paused bot says so across the top with Resume (FK-B25).
 */
import { House, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { type Bot, itemsNeedingYou } from "../../../shared/bots";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { listedBotItems, refreshBots, useBotsStore } from "../../stores/bots";
import { toastError } from "../../stores/toast";
import { Banner, Button, IconButton, Input, LinkButton, Tabs } from "../common";
import { BotActionsMenu, setBotPaused } from "./BotActionsMenu";
import { BotActivity } from "./BotActivity";
import { BotAvatar } from "./BotAvatar";
import { BotChats } from "./BotChats";
import { BotLineText } from "./BotLineText";
import { BotOwner, useBotHostName, useOfflineBotHosts } from "./BotOwner";
import { BotSettings } from "./BotSettings";
import { openBotHome } from "./bot-launch";
import { type BotPageTab, botPageKey, useBotPage } from "./bot-page";
import type { BotFacts } from "./bot-view";
import { ItemsPane } from "./items/ItemsPane";

export function BotPane({ bot, facts, onDeleted }: { bot: Bot; facts: BotFacts; onDeleted: () => void }) {
	const t = useT();
	const tab = useBotPage(s => s.tab);
	const command = useBotsStore(s => s.command);
	const [renaming, setRenaming] = useState(false);
	const [draft, setDraft] = useState(bot.name);
	// A bot may have edited its soul since its page last opened.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the read is per bot shown
	useEffect(() => refreshBots(), [bot.id]);
	// At launch the last read may predate the end of the kickoff. The core checks the chat before retrying.
	// biome-ignore lint/correctness/useExhaustiveDependencies: check once per page open, not on every turn
	useEffect(() => {
		if (!bot.device && bot.firstRun && !bot.paused && bot.kickoffs?.length === 1)
			void command({ action: "kickoff", id: bot.id }).catch(() => {});
	}, [bot.id]);
	const rename = () => {
		setRenaming(false);
		const name = draft.trim();
		if (!name || name === bot.name) return;
		void command({ action: "update", id: bot.id, name }).catch((error: unknown) => {
			setDraft(bot.name);
			toastError({ title: t("bots.rename.failed"), error });
		});
	};
	const mark = bot.paused ? "paused" : facts.needsYou > 0 ? "needsYou" : facts.failed ? "failed" : null;
	const state = useBotsStore(s => s.state);
	const openItems = itemsNeedingYou(
		listedBotItems(state, bot.device, bot.id).filter(item => !item.stale),
		null,
		Date.now(),
	).length;
	// A paired host's bot lives there: while the host's link stays lost its page shows the last copy and says so.
	const hostName = useBotHostName(bot.device);
	const offline = useOfflineBotHosts().has(bot.device ?? "");
	// Suggestions its looks made since the owner last saw the list (Orca's `bot-look-around-seen.ts`).
	const newSuggestions = useBotsStore(s => {
		if (bot.device) return 0;
		const looks = s.state.looks?.find(look => look.bot === bot.id);
		return looks ? looks.items.filter(item => item.createdAt > looks.seenAt).length : 0;
	});
	return (
		<div className="flex min-h-0 min-w-0 flex-col" data-bot-pane={bot.id}>
			{bot.paused && (
				<Banner
					actions={
						<Button onClick={() => setBotPaused(bot, false)} size="sm" variant="secondary">
							{t("bots.settings.resume")}
						</Button>
					}
					className="m-4 mb-0"
					data-bot-paused-banner
					variant="warning"
				>
					{t("bots.paused.banner")}
				</Banner>
			)}
			{offline && (
				<Banner className="m-4 mb-0" data-bot-offline-banner variant="warning">
					{t("bots.remote.offlineBanner", { device: hostName })}
				</Banner>
			)}
			<header className="flex items-center gap-3 px-4 pt-4" data-bot-pane-header>
				<BotAvatar bot={bot} mark={mark} size={36} working={facts.working} />
				<div className="flex min-w-0 flex-1 flex-col">
					{renaming ? (
						<Input
							aria-label={t("bots.rename.label", { name: bot.name })}
							autoFocus
							controlSize="sm"
							maxLength={80}
							onBlur={rename}
							onChange={event => setDraft(event.target.value)}
							onKeyDown={event => {
								if (isImeKeyEvent(event)) return;
								if (event.key === "Enter") rename();
								else if (event.key === "Escape") {
									setDraft(bot.name);
									setRenaming(false);
								}
							}}
							value={draft}
						/>
					) : (
						<LinkButton
							aria-label={t("bots.rename.label", { name: bot.name })}
							className="self-start truncate text-sc-md font-semibold"
							onClick={() => {
								setDraft(bot.name);
								setRenaming(true);
							}}
							tone="inherit"
						>
							{bot.name}
						</LinkButton>
					)}
					<BotOwner device={bot.device} />
					<BotLineText bot={bot} className="text-sc-xs text-(--sc-text-muted)" line={facts.line} />
				</div>
				<Button data-bot-open-home icon={<House />} onClick={() => openBotHome(bot)} size="sm" variant="secondary">
					{t("bots.pane.openHome")}
				</Button>
				<IconButton
					data-bot-pane-gear
					icon={<Settings2 />}
					label={t("bots.menu.settings")}
					onClick={() => useBotPage.setState({ tab: "settings" })}
					size="sm"
				/>
				<BotActionsMenu bot={bot} />
			</header>
			<Tabs
				activeId={tab}
				ariaLabel={bot.name}
				className="px-4 pt-2"
				data-bot-pane-tabs
				onChange={id => useBotPage.setState({ tab: id as BotPageTab })}
				tabs={[
					{
						id: "activity",
						label: t("bots.pane.activity"),
						badge: facts.needsYou + newSuggestions > 0 ? facts.needsYou + newSuggestions : undefined,
					},
					{ id: "items", label: t("bots.pane.items"), badge: openItems > 0 ? openItems : undefined },
					{ id: "chats", label: t("bots.pane.chats") },
					{ id: "settings", label: t("bots.pane.settings") },
				]}
				variant="underline"
			/>
			<div className="flex min-h-0 flex-1 flex-col" role="tabpanel">
				{tab === "activity" && <BotActivity bot={bot} />}
				{tab === "items" && <ItemsPane bots={[bot]} group={false} owner={botPageKey(bot.id, bot.device)} />}
				{tab === "chats" && <BotChats bot={bot} />}
				{tab === "settings" && <BotSettings bot={bot} onDeleted={onDeleted} />}
			</div>
		</div>
	);
}
