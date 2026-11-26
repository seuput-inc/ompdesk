/**
 * The sidebar's Bots section above the projects (Orca's `SidebarBotsSection.tsx:174-385`; the owner's decision of
 * 25 Nov 2026): one header like the Chats section's (fold, the folded bots' faces, collapse all, options, "+"), then
 * one row per bot, each unfolding to its chats (the session rows the list draws for the bot's folder, so a chat keeps
 * its status, menu and family). Mounted only while the bots feature is available (`useBotsAvailable`).
 *
 * - "+" (Orca's :247-297): New bot, Browse templates, Import from another app. Share by link is Orca Cloud's and
 *   groups come with the room view (orca-bots-items), so neither is here.
 * - Options (`BotSidebarOptionsMenu.tsx:16-90`): Sort by Manual, Agent activity, Recent or Name; Hide paused bots.
 * - A row (`BotRow.tsx:51-287`, looks C18, S7, S8, S9): the bot's face with its exception mark, its name and age, its
 *   second line (`botFacts`), the working mark or its fold strip at the end; dimmed while paused. A click opens its
 *   home chat; its menu renames it in place, opens its page or settings, pauses it, copies its folder, moves it in the
 *   person's order (Alt+↑/↓ too) and deletes it. Hovering it shows its details (`BotHoverCard`).
 * - The sidebar's search finds bots by name and purpose, and a bot whose chats match (FK-B09).
 * - With no bot: one quiet card with New bot and Templates (`SidebarBotsEmptyState.tsx:9-45`).
 */
import {
	ArrowDown,
	ArrowUp,
	Bot as BotIcon,
	BotMessageSquare,
	ChevronDown,
	ChevronsDownUp,
	ChevronsUpDown,
	Copy,
	Download,
	LayoutTemplate,
	PanelRight,
	Pause,
	Pencil,
	Play,
	Plus,
	Settings2,
	SlidersHorizontal,
	Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type { Bot } from "../../../../shared/bots";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { useBotsStore } from "../../../stores/bots";
import { useBotsView } from "../../../stores/bots-view";
import { toast, toastError } from "../../../stores/toast";
import { BotAvatar, type BotMark } from "../../bots/BotAvatar";
import { BotHoverCard } from "../../bots/BotHoverCard";
import { BotLineText } from "../../bots/BotLineText";
import { openBotDialog, openBotHome } from "../../bots/bot-launch";
import { openBotPage } from "../../bots/bot-page";
import { type BotFacts, foldedFaces, sortBots } from "../../bots/bot-view";
import {
	anchorFromEvent,
	Button,
	Collapse,
	ConfirmDialog,
	ContextMenu,
	type ContextMenuItem,
	EmptyState,
	HoverCard,
	IconButton,
	Input,
	ListRow,
	MenuButton,
	TimeAgo,
	WorkingArc,
} from "../../common";
import { SidebarFoldButton } from "./SidebarFoldButton";

export interface SidebarBotEntry {
	bot: Bot;
	facts: BotFacts;
	/** Its chats' rows as the list draws them. */
	chats: ReactNode;
	chatCount: number;
	/** The shown session is one of its chats. */
	current: boolean;
}

/** The exception its face marks (S7): needs the person, failed, paused. */
export function botMark(bot: Bot, facts: BotFacts | undefined): BotMark {
	if (bot.paused) return "paused";
	if ((facts?.needsYou ?? 0) > 0) return "needsYou";
	if (facts?.failed) return "failed";
	return null;
}

export function SidebarBots({ entries, filtering }: { entries: readonly SidebarBotEntry[]; filtering: boolean }) {
	const t = useT();
	const view = useBotsView();
	const command = useBotsStore(s => s.command);
	const total = useBotsStore(s => s.state.bots.length);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [menu, setMenu] = useState<{ x: number; y: number; bot: Bot } | null>(null);
	const [deleting, setDeleting] = useState<Bot | null>(null);
	const facts = new Map(entries.map(entry => [entry.bot.id, entry.facts]));
	const byId = new Map(entries.map(entry => [entry.bot.id, entry]));
	const sorted = sortBots(
		entries.map(entry => entry.bot),
		filtering ? "smart" : view.sort,
		view.order,
		facts,
		view.hidePaused && !filtering,
	);
	const folded = view.folded && !filtering;
	const allOpen = sorted.length > 0 && sorted.every(bot => view.open.includes(bot.id));
	const needsYou = entries.reduce((sum, entry) => sum + entry.facts.needsYou, 0);

	const moveBot = (bot: Bot, delta: -1 | 1) => {
		const ids = sorted.map(known => known.id);
		const at = ids.indexOf(bot.id);
		const to = at + delta;
		if (at < 0 || to < 0 || to >= ids.length) return false;
		[ids[at], ids[to]] = [ids[to] as string, ids[at] as string];
		view.setSort("manual");
		view.setOrder(ids);
		return true;
	};
	const rename = (bot: Bot) => {
		const name = draft.trim();
		setRenaming(null);
		if (!name || name === bot.name) return;
		void command({ action: "update", id: bot.id, name }).catch((error: unknown) =>
			toastError({ title: t("bots.rename.failed"), error }),
		);
	};
	const setPaused = (bot: Bot, paused: boolean) =>
		void command({ action: "update", id: bot.id, paused }).catch((error: unknown) =>
			toastError({ title: t("bots.pause.failed"), error }),
		);
	const menuItems = (bot: Bot): ContextMenuItem[] => {
		const at = sorted.findIndex(known => known.id === bot.id);
		return [
			{
				id: "rename",
				label: t("bots.menu.rename"),
				icon: Pencil,
				onSelect: () => {
					setDraft(bot.name);
					setRenaming(bot.id);
				},
			},
			{ id: "page", label: t("bots.menu.page"), icon: PanelRight, onSelect: () => openBotPage(bot.id) },
			{
				id: "settings",
				label: t("bots.menu.settings"),
				icon: Settings2,
				onSelect: () => openBotPage(bot.id, "settings"),
			},
			bot.paused
				? { id: "resume", label: t("bots.menu.resume"), icon: Play, onSelect: () => setPaused(bot, false) }
				: { id: "pause", label: t("bots.menu.pause"), icon: Pause, onSelect: () => setPaused(bot, true) },
			{
				id: "copy",
				label: t("bots.menu.copyPath"),
				icon: Copy,
				separatorBefore: true,
				onSelect: () =>
					void navigator.clipboard
						.writeText(bot.folder)
						.then(() => toast({ variant: "success", message: t("bots.menu.pathCopied") }))
						.catch(() => {}),
			},
			{
				id: "up",
				label: t("bots.menu.moveUp"),
				icon: ArrowUp,
				disabled: filtering || at <= 0,
				onSelect: () => moveBot(bot, -1),
			},
			{
				id: "down",
				label: t("bots.menu.moveDown"),
				icon: ArrowDown,
				disabled: filtering || at < 0 || at >= sorted.length - 1,
				onSelect: () => moveBot(bot, 1),
			},
			{
				id: "delete",
				label: t("bots.menu.delete"),
				icon: Trash2,
				danger: true,
				separatorBefore: true,
				onSelect: () => setDeleting(bot),
			},
		];
	};

	const header = (
		<div
			className="omp-sidebar-head group/head flex items-center rounded-(--sc-radius-md) hover:bg-(--sc-hover)"
			data-flip-key="bots"
		>
			<SidebarFoldButton
				aria-label={t("bots.section.fold", {
					total,
					needsYou,
				})}
				className="text-(--sc-text-muted) hover:text-(--sc-text)"
				data-roving-item="bots"
				data-sidebar-bots-toggle
				folded={folded}
				icon={<BotMessageSquare aria-hidden className="size-(--sc-icon-sm) shrink-0" />}
				onClick={() => view.setFolded(!folded)}
				tabIndex={-1}
			>
				<span className="min-w-0 truncate">{t("destination.bots")}</span>
				{folded && (
					<span className="ml-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden" data-bot-faces>
						{foldedFaces(sorted, facts)
							.slice(0, 6)
							.map(bot => (
								<BotAvatar bot={bot} key={bot.id} mark={botMark(bot, facts.get(bot.id))} size={16} />
							))}
					</span>
				)}
				{!folded && <span className="flex-1" />}
			</SidebarFoldButton>
			{!folded && sorted.length > 1 && (
				<IconButton
					className="text-(--sc-text-subtle) hover:text-(--sc-text)"
					data-bots-collapse-all
					icon={allOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
					label={allOpen ? t("bots.section.collapseAll") : t("bots.section.expandAll")}
					onClick={() => view.setAllOpen(allOpen ? [] : sorted.map(bot => bot.id))}
					size="sm"
					tabIndex={-1}
				/>
			)}
			{!folded && total > 0 && (
				<MenuButton
					className="text-(--sc-text-subtle) hover:text-(--sc-text)"
					icon={<SlidersHorizontal />}
					items={[
						...(["manual", "smart", "recent", "name"] as const).map(
							(sort): ContextMenuItem => ({
								id: `sort-${sort}`,
								label: t(`bots.options.sort.${sort}`),
								description:
									sort === "manual" || sort === "smart" ? t(`bots.options.sort.${sort}Hint`) : undefined,
								checked: view.sort === sort,
								onSelect: () => view.setSort(sort),
							}),
						),
						{
							id: "hide-paused",
							label: t("bots.options.hidePaused"),
							icon: Pause,
							checked: view.hidePaused,
							separatorBefore: true,
							onSelect: () => view.setHidePaused(!view.hidePaused),
						},
					]}
					label={view.hidePaused ? t("bots.options.labelFiltered", { count: 1 }) : t("bots.options.label")}
					size="sm"
				/>
			)}
			<MenuButton
				className="mr-1 text-(--sc-text-subtle) hover:text-(--sc-text)"
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
				]}
				label={t("bots.add.label")}
				size="sm"
			/>
		</div>
	);

	const row = (bot: Bot) => {
		const entry = byId.get(bot.id);
		if (!entry) return null;
		const open = filtering || view.open.includes(bot.id);
		const fact = entry.facts;
		const key = `bot:${bot.id}`;
		if (renaming === bot.id)
			return (
				<div className="px-1 py-0.5" key={bot.id}>
					<Input
						aria-label={t("bots.rename.label", { name: bot.name })}
						autoFocus
						controlSize="sm"
						maxLength={80}
						onBlur={() => rename(bot)}
						onChange={event => setDraft(event.target.value)}
						onFocus={event => event.currentTarget.select()}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							if (event.key === "Enter") {
								event.preventDefault();
								rename(bot);
							} else if (event.key === "Escape") {
								event.preventDefault();
								setRenaming(null);
							}
						}}
						value={draft}
					/>
				</div>
			);
		return (
			<div data-bot-entry={bot.id} data-flip-key={key} key={bot.id}>
				<HoverCard content={<BotHoverCard bot={bot} facts={fact} />}>
					<div
						className={cx("omp-sidebar-bot", bot.paused && "opacity-60")}
						data-bot-paused={bot.paused ? "" : undefined}
						onContextMenu={event => {
							event.preventDefault();
							setMenu({ ...anchorFromEvent(event), bot });
						}}
					>
						<ListRow
							buttonProps={{
								tabIndex: -1,
								"data-roving-item": key,
								"data-bot-row": bot.id,
								onKeyDown: event => {
									if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
										event.preventDefault();
										const box = event.currentTarget.getBoundingClientRect();
										setMenu({ x: box.left, y: box.bottom, bot });
									} else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
										if (moveBot(bot, event.key === "ArrowUp" ? -1 : 1)) event.preventDefault();
									} else if (event.key === "F2") {
										event.preventDefault();
										setDraft(bot.name);
										setRenaming(bot.id);
									} else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
										if ((event.key === "ArrowRight") === open || entry.chatCount === 0) return;
										event.preventDefault();
										view.setOpen(bot.id, !open);
									}
								},
							}}
							leading={<BotAvatar bot={bot} mark={botMark(bot, fact)} size={28} />}
							meta={
								fact.working ? (
									<WorkingArc state="turn" />
								) : (
									<TimeAgo className="text-(--sc-text-subtle)" iso={fact.latest} />
								)
							}
							onClick={() => openBotHome(bot)}
							secondary={<BotLineText bot={bot} line={fact.line} />}
							selected={entry.current}
							title={<span className={cx(fact.unread && "font-semibold")}>{bot.name}</span>}
							trailing={
								entry.chatCount > 0 ? (
									<IconButton
										aria-expanded={open}
										className="omp-sidebar-bot-fold"
										data-bot-fold={bot.id}
										icon={<ChevronDown className={cx("transition-transform", !open && "-rotate-90")} />}
										label={
											open
												? t("bots.row.fold", { name: bot.name })
												: t("bots.row.unfold", { name: bot.name })
										}
										onClick={() => view.setOpen(bot.id, !open)}
										size="sm"
										tabIndex={-1}
									/>
								) : undefined
							}
						/>
					</div>
				</HoverCard>
				<Collapse open={open && entry.chatCount > 0}>
					<div className="space-y-px pl-3" data-bot-chats={bot.id}>
						{entry.chats}
					</div>
				</Collapse>
			</div>
		);
	};

	return (
		<section aria-label={t("destination.bots")} className="mb-1" data-sidebar-bots>
			{header}
			<Collapse open={!folded}>
				<div className="space-y-px" data-bot-lane>
					{total === 0 ? (
						<EmptyState
							actions={
								<>
									<Button
										icon={<Plus />}
										onClick={() => openBotDialog({ kind: "new" })}
										size="sm"
										variant="primary"
									>
										{t("bots.add.new")}
									</Button>
									<Button onClick={() => openBotDialog({ kind: "templates" })} size="sm" variant="secondary">
										{t("bots.add.templatesShort")}
									</Button>
								</>
							}
							className="omp-sidebar-empty"
							data-sidebar-bots-empty
							description={t("bots.section.emptyDescription")}
							size="sm"
							title={t("bots.section.emptyTitle")}
						/>
					) : sorted.length === 0 && !filtering ? (
						<div className="omp-sidebar-empty-line">
							<span>{t("bots.section.allHidden")}</span>
							<Button onClick={() => view.setHidePaused(false)} size="sm" variant="ghost">
								{t("bots.section.showPaused")}
							</Button>
						</div>
					) : (
						sorted.map(row)
					)}
				</div>
			</Collapse>
			{menu && (
				<ContextMenu
					ariaLabel={t("bots.menu.label", { name: menu.bot.name })}
					items={menuItems(menu.bot)}
					onClose={() => setMenu(null)}
					x={menu.x}
					y={menu.y}
				/>
			)}
			<ConfirmDialog
				confirmLabel={t("bots.delete.confirm")}
				message={t("bots.delete.message", { folder: deleting?.folder ?? "" })}
				onCancel={() => setDeleting(null)}
				onConfirm={() => {
					const bot = deleting;
					setDeleting(null);
					if (bot)
						void command({ action: "delete", id: bot.id }).catch((error: unknown) =>
							toastError({ title: t("bots.delete.failed"), error }),
						);
				}}
				open={deleting !== null}
				title={t("bots.delete.title", { name: deleting?.name ?? "" })}
			/>
		</section>
	);
}
