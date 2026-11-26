/**
 * Settings › Bots (Orca's `settings/bots/BotsSettingsPane.tsx` and `BotSettingsGroups.tsx:184-277`, FK-B49, FS70):
 * whether this device's sidebar shows the Bots section (the Bots nav row's own "hide", device-local: no second pref),
 * then this computer's bots, each Active or Paused; a bot opens its settings in place (`BotSettings`, the same view as
 * the bot page's Settings tab) with "Back to Bots". Bots live on this computer, whichever tab is focused.
 */
import { ChevronLeft, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { ensureBots, useBotsStore } from "../../stores/bots";
import { useSidebarFolds } from "../../stores/sidebar-folds";
import { toastError } from "../../stores/toast";
import { BotAvatar } from "../bots/BotAvatar";
import { BotSettings } from "../bots/BotSettings";
import { openBotDialog } from "../bots/bot-launch";
import { ensureHiddenCards, setCardHidden, useHiddenCards } from "../chat/bots/hidden-cards";
import { Badge, Button, EmptyState, ListRow, SectionLabel, SwitchField } from "../common";
import { SettingsSection } from "./SettingsLayout";

export function BotsSection() {
	const t = useT();
	const bots = useBotsStore(s => s.state.bots);
	const shown = useSidebarFolds(s => s.navHidden.bots !== true);
	const [open, setOpen] = useState<string | null>(null);
	useEffect(() => ensureBots(), []);
	const bot = bots.find(known => known.id === open);
	if (bot)
		return (
			<SettingsSection id="settings-bots-bot" scope="app" title={bot.name}>
				<Button
					className="self-start"
					icon={<ChevronLeft />}
					onClick={() => setOpen(null)}
					size="sm"
					variant="ghost"
				>
					{t("bots.settings.backToBots")}
				</Button>
				<BotSettings bot={bot} onDeleted={() => setOpen(null)} />
			</SettingsSection>
		);
	return (
		<SettingsSection
			actions={
				<Button icon={<Plus />} onClick={() => openBotDialog({ kind: "new" })} size="sm" variant="secondary">
					{t("bots.add.new")}
				</Button>
			}
			description={t("bots.settings.sectionDescription")}
			id="settings-bots"
			scope="app"
			title={t("bots.settings.listTitle")}
		>
			<SwitchField
				checked={shown}
				description={t("bots.settings.showInSidebarHint")}
				id="setting-bots-sidebar"
				label={t("bots.settings.showInSidebar")}
				onCheckedChange={on => useSidebarFolds.getState().setNavHidden("bots", !on)}
			/>
			<HiddenCards />
			{bots.length === 0 ? (
				<EmptyState size="row" title={t("bots.section.emptyTitle")} />
			) : (
				<div className="flex flex-col gap-px" data-settings-bots>
					{bots.map(item => (
						<ListRow
							buttonProps={{ "data-settings-bot": item.id }}
							description={item.specialty}
							key={item.id}
							leading={<BotAvatar bot={item} size={28} />}
							meta={
								<Badge size="xs" variant={item.paused ? "muted" : "success"}>
									{item.paused ? t("bots.row.paused") : t("bots.settings.activeState")}
								</Badge>
							}
							onClick={() => setOpen(item.id)}
							title={item.name}
						/>
					))}
				</div>
			)}
		</SettingsSection>
	);
}

/** Bot cards hidden from chats (a card's Hide, FC20), each with Show again; nothing while none is hidden. */
function HiddenCards() {
	const t = useT();
	const hidden = useHiddenCards(s => s.hidden);
	useEffect(() => {
		void ensureHiddenCards().catch(() => {});
	}, []);
	if (hidden.length === 0) return null;
	return (
		<div className="flex flex-col gap-px" data-settings-hidden-cards>
			<SectionLabel>{t("chat.botCards.hiddenTitle")}</SectionLabel>
			{hidden.map(kind => (
				<ListRow
					actions={
						<Button
							onClick={() =>
								void setCardHidden(kind, false).catch((error: unknown) =>
									toastError({ title: t("chat.botCards.hideFailed"), error }),
								)
							}
							size="sm"
							variant="ghost"
						>
							{t("chat.botCards.showAgain")}
						</Button>
					}
					key={kind}
					title={t(`chat.botCards.kind.${kind}`)}
				/>
			))}
		</div>
	);
}
