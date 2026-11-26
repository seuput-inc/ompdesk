/**
 * One bot's page (Orca's bot panel, `BotActivityPanel.tsx:52-100`, `BotPanelHeader.tsx:143-276`, `BotPausedBanner`):
 * its header (face with its exception mark, name renamed in place, its now line, Open home chat, the gear for its
 * settings and More: pause or resume, copy its folder) and three tabs: Activity, Chats and Settings (FK-B12, B08).
 * A paused bot says so across the top with Resume (FK-B25).
 */
import { House, MoreHorizontal, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Bot } from "../../../shared/bots";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { refreshBots, useBotsStore } from "../../stores/bots";
import { toast, toastError } from "../../stores/toast";
import { Banner, Button, IconButton, Input, LinkButton, MenuButton, Tabs } from "../common";
import { BotActivity } from "./BotActivity";
import { BotAvatar } from "./BotAvatar";
import { BotChats } from "./BotChats";
import { BotLineText } from "./BotLineText";
import { BotSettings } from "./BotSettings";
import { openBotHome } from "./bot-launch";
import { type BotPageTab, useBotPage } from "./bot-page";
import type { BotFacts } from "./bot-view";

export function BotPane({ bot, facts, onDeleted }: { bot: Bot; facts: BotFacts; onDeleted: () => void }) {
	const t = useT();
	const tab = useBotPage(s => s.tab);
	const command = useBotsStore(s => s.command);
	const [renaming, setRenaming] = useState(false);
	const [draft, setDraft] = useState(bot.name);
	// A bot writes its picture and soul with its own tools: the page reads them again whenever it shows another bot.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the read is per bot shown
	useEffect(() => refreshBots(), [bot.id]);
	const setPaused = (paused: boolean) =>
		void command({ action: "update", id: bot.id, paused }).catch((error: unknown) =>
			toastError({ title: t("bots.pause.failed"), error }),
		);
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
	return (
		<div className="flex min-h-0 min-w-0 flex-col" data-bot-pane={bot.id}>
			{bot.paused && (
				<Banner
					actions={
						<Button onClick={() => setPaused(false)} size="sm" variant="secondary">
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
			<header className="flex items-center gap-3 px-4 pt-4" data-bot-pane-header>
				<BotAvatar bot={bot} mark={mark} size={36} />
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
				<MenuButton
					icon={<MoreHorizontal />}
					items={[
						bot.paused
							? { id: "resume", label: t("bots.menu.resume"), onSelect: () => setPaused(false) }
							: { id: "pause", label: t("bots.menu.pause"), onSelect: () => setPaused(true) },
						{
							id: "copy",
							label: t("bots.menu.copyPath"),
							separatorBefore: true,
							onSelect: () =>
								void navigator.clipboard
									.writeText(bot.folder)
									.then(() => toast({ variant: "success", message: t("bots.menu.pathCopied") }))
									.catch(() => {}),
						},
					]}
					label={t("bots.pane.more")}
					size="sm"
				/>
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
						badge: facts.needsYou > 0 ? facts.needsYou : undefined,
					},
					{ id: "chats", label: t("bots.pane.chats") },
					{ id: "settings", label: t("bots.pane.settings") },
				]}
				variant="underline"
			/>
			<div className="min-h-0 flex-1" role="tabpanel">
				{tab === "activity" && <BotActivity bot={bot} />}
				{tab === "chats" && <BotChats bot={bot} />}
				{tab === "settings" && <BotSettings bot={bot} onDeleted={onDeleted} />}
			</div>
		</div>
	);
}
