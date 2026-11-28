/**
 * A bot's Items tab, or a group's items (Orca's `BotItemsSection.tsx:1-158`, `BotItemsList.tsx:1-408`,
 * `BotItemRow.tsx:1-384`, `BotItemsFilter.tsx:40-210`, `BotItemSelectionPill.tsx:1-91`, `use-bot-items-seen-mark.ts:1-72`,
 * MIT, re-implemented on the kit; FK-B35, C2-32, C2-39):
 *
 * - Groups: Needs you, In progress and Waiting open; Planned, Snoozed, Stale and Closed folded (a folded group says how
 *   many it holds and how many are new). Each shows five rows, then Show N more; Needs you shows them all.
 * - A row: its status glyph (a checkbox on hover, or while any row is checked), `#n` and title, the new mark and its
 *   age (a snoozed row its wake time); hover or focus swaps the age for Done, Snooze and More. Its question or what it
 *   waits on is the row's tooltip. A group's list puts each row's bot face before its title.
 * - The new mark: rows changed by anyone but the owner since the tab was last opened. The mark is taken as the tab
 *   opens from the core's live read, and a bot's own tab then moves it (`itemsOpened`), so it is shared by every window
 *   and device; the dots stay while the tab stays open. A group's list reads its members' marks and moves none.
 * - Checked rows float a bar: "N selected", Move to (a status, a snooze) and clear. A move of several is one write.
 *   Shift-click checks a range. Stale's header cancels them all, after saying the reason sent to the bot.
 * - Filter: Needs you only (with its chip), and in a group's list which bots, each with its count; Clear filters.
 */
import { Check, Clock, ListChecks, ListFilter, MoreHorizontal, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Bot, Item, ItemStatus } from "../../../../shared/bots";
import { cx, formatTimeAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useBotsStore } from "../../../stores/bots";
import {
	Button,
	Checkbox,
	Chip,
	ConfirmDialog,
	type ContextMenuItem,
	DisclosureButton,
	EmptyState,
	IconButton,
	ListRow,
	MenuButton,
} from "../../common";
import { BotAvatar } from "../BotAvatar";
import { formatSnooze, presetName, SnoozeDialog, WaitDialog } from "./BotItemDialogs";
import { ItemStatusIcon, itemLive, statusName } from "./ItemStatusIcon";
import {
	activityAt,
	filterItems,
	filterOn,
	GROUP_FOLDED,
	GROUP_ROWS,
	groupItems,
	ITEM_GROUPS,
	type ItemFilter,
	type ItemGroupId,
	type ItemGroups,
	isClosed,
	isSnoozed,
	isUnseen,
	NO_FILTER,
	PICKER_STATUSES,
	questionLine,
	snoozePresets,
} from "./item-model";
import { moveItems, snoozeItems } from "./item-store";

/** Each bot's seen mark as this list opened; `own` (a bot's own tab) then marks its items seen. */
function useSeenAtOpen(bots: readonly Bot[], own: boolean): ReadonlyMap<string, number> | null {
	const live = useBotsStore(s => s.live);
	const command = useBotsStore(s => s.command);
	const [atOpen, setAtOpen] = useState<ReadonlyMap<string, number> | null>(null);
	// The kept list of the last run paints first; the mark waits for this run's read so no row flashes as new.
	if (atOpen === null && live) setAtOpen(new Map(bots.map(bot => [bot.id, bot.itemsSeen ?? 0])));
	const [only] = bots;
	const botId = own ? only?.id : undefined;
	useEffect(() => {
		if (!live || !botId) return;
		void command({ action: "itemsOpened", id: botId }).catch(() => {});
	}, [live, botId, command]);
	return atOpen;
}

/** The moves that ask something first (Waiting, a snooze picked by date), as dialogs beside the menus. */
type Asking = { kind: "wait"; items: readonly Item[] } | { kind: "snooze"; items: readonly Item[] } | null;

/** The owner's moves of items; `dialog` is mounted beside the menus that open it. */
export interface ItemMoves {
	move: (items: readonly Item[], status: ItemStatus) => void;
	snooze: (items: readonly Item[], until: number | null) => void;
	pickSnooze: (items: readonly Item[]) => void;
	dialog: ReactNode;
}

export function useItemMoves(onDone?: () => void): ItemMoves {
	const [asking, setAsking] = useState<Asking>(null);
	const move = (items: readonly Item[], status: ItemStatus) => {
		if (status === "waiting") setAsking({ kind: "wait", items });
		else {
			moveItems(items, status);
			onDone?.();
		}
	};
	const snooze = (items: readonly Item[], until: number | null) => {
		snoozeItems(items, until);
		onDone?.();
	};
	const dialog =
		asking?.kind === "wait" ? (
			<WaitDialog
				items={asking.items}
				onClose={() => setAsking(null)}
				onDone={wait => {
					moveItems(asking.items, "waiting", { wait });
					setAsking(null);
					onDone?.();
				}}
			/>
		) : asking?.kind === "snooze" ? (
			<SnoozeDialog
				onClose={() => setAsking(null)}
				onSnooze={until => {
					snooze(asking.items, until);
					setAsking(null);
				}}
			/>
		) : null;
	return { move, snooze, pickSnooze: (items: readonly Item[]) => setAsking({ kind: "snooze", items }), dialog };
}

/** The snooze choices for `items`: the presets, Pick a time…, and Unsnooze while any is snoozed. */
export function snoozeMenu(
	items: readonly Item[],
	moves: ItemMoves,
	t: (key: string, params?: Record<string, string | number>) => string,
	separatorBefore = false,
): ContextMenuItem[] {
	const now = Date.now();
	return [
		...snoozePresets(now).map(
			(preset, index): ContextMenuItem => ({
				id: `snooze-${preset.id}`,
				label: presetName(preset, t),
				hint: formatSnooze(preset.at, now),
				icon: index === 0 ? Clock : undefined,
				separatorBefore: separatorBefore && index === 0,
				onSelect: () => moves.snooze(items, preset.at),
			}),
		),
		{ id: "snooze-pick", label: t("bots.items.snooze.pick"), onSelect: () => moves.pickSnooze(items) },
		...(items.some(item => isSnoozed(item, now))
			? [{ id: "unsnooze", label: t("bots.items.snooze.unsnooze"), onSelect: () => moves.snooze(items, null) }]
			: []),
	];
}

export interface BotItemsProps {
	/** The bot, or a group's members. */
	bots: readonly Bot[];
	/** A group's list: rows carry their bot's face, the filter names the bots, no seen mark moves. */
	group: boolean;
	onOpen: (item: Item) => void;
	/** The list's order as shown, for the item page's previous and next. */
	onOrder?: (order: readonly string[]) => void;
}

export function BotItems({ bots, group, onOpen, onOrder }: BotItemsProps) {
	const t = useT();
	const all = useBotsStore(s => s.state.items);
	const live = useBotsStore(s => s.live);
	const seen = useSeenAtOpen(bots, !group);
	const [filter, setFilter] = useState<ItemFilter>(NO_FILTER);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [anchor, setAnchor] = useState<string | null>(null);
	const [cancelling, setCancelling] = useState<readonly Item[] | null>(null);
	const moves = useItemMoves(() => setSelected(new Set()));
	const now = Date.now();
	const ids = new Set(bots.map(bot => bot.id));
	const items = all.filter(item => ids.has(item.bot));
	const shown = filterItems(items, filter);
	const botOf = (item: Item) => bots.find(bot => bot.id === item.bot);
	const seenOf = (item: Item) => seen?.get(item.bot) ?? Number.POSITIVE_INFINITY;
	const groups = groupItems(shown, seenOf, now);
	const order = ITEM_GROUPS.flatMap(id => groups[id]);
	const orderKey = order.map(item => item.id).join("\n");
	const onOrderRef = useRef(onOrder);
	onOrderRef.current = onOrder;
	useEffect(() => onOrderRef.current?.(orderKey ? orderKey.split("\n") : []), [orderKey]);
	const picked = order.filter(item => selected.has(item.id));
	const select = (item: Item, on: boolean, range: boolean) => {
		setSelected(current => {
			const next = new Set(current);
			const from = anchor ? order.findIndex(entry => entry.id === anchor) : -1;
			const to = order.findIndex(entry => entry.id === item.id);
			const span =
				range && from >= 0
					? order.slice(Math.min(from, to), Math.max(from, to) + 1).map(entry => entry.id)
					: [item.id];
			for (const id of span) {
				if (on) next.add(id);
				else next.delete(id);
			}
			return next;
		});
		setAnchor(item.id);
	};
	const needsYou = items.filter(item => item.status === "needs_you").length;
	const staleDays = bots.length === 1 ? bots[0]?.staleDays : null;
	const staleReason = staleDays
		? t("bots.items.stale.reason", { count: staleDays })
		: t("bots.items.stale.reasonPlain");

	const filterItemsMenu: ContextMenuItem[] = [
		...(group
			? bots.map(
					(bot, index): ContextMenuItem => ({
						id: `bot-${bot.id}`,
						label: bot.name,
						hint: String(items.filter(item => item.bot === bot.id && !isClosed(item.status)).length),
						checked: filter.bots?.includes(bot.id) ?? false,
						separatorBefore: index === 0,
						onSelect: () => {
							const rest = (filter.bots ?? []).filter(id => id !== bot.id);
							const next = filter.bots?.includes(bot.id) ? rest : [...rest, bot.id];
							setFilter({ ...filter, bots: next.length > 0 ? next : null });
						},
					}),
				)
			: []),
		{
			id: "needs-you",
			label: t("bots.items.filter.needsYou"),
			hint: String(needsYou),
			checked: filter.needsYou,
			separatorBefore: group,
			onSelect: () => setFilter({ ...filter, needsYou: !filter.needsYou }),
		},
		...(filterOn(filter)
			? [
					{
						id: "clear",
						label: t("bots.items.filter.clearAll"),
						icon: X,
						separatorBefore: true,
						onSelect: () => setFilter(NO_FILTER),
					},
				]
			: []),
	];

	const allClear =
		live &&
		items.length > 0 &&
		!filterOn(filter) &&
		bots.every(bot => !bot.paused) &&
		groups.needs_you.length === 0 &&
		groups.working.length === 0;

	return (
		<div className="flex flex-col gap-2 px-4 py-3" data-bot-items>
			<div className="flex min-h-(--sc-control-sm) items-center gap-2 border-b border-(--sc-divider) pb-1.5">
				<span className="flex-1 text-sc-xs text-(--sc-text-muted)">
					{allClear ? t("bots.items.allClear") : t("bots.items.count", { count: shown.length })}
				</span>
				<MenuButton
					icon={<ListFilter />}
					items={filterItemsMenu}
					label={filterOn(filter) ? t("bots.items.filter.labelOn") : t("bots.items.filter.label")}
					size="sm"
					variant={filterOn(filter) ? "secondary" : "ghost"}
				/>
			</div>
			{filter.needsYou && (
				<div className="flex flex-wrap gap-1">
					<Chip
						onRemove={() => setFilter({ ...filter, needsYou: false })}
						removeLabel={t("bots.items.filter.remove", { name: t("bots.items.status.needs_you") })}
					>
						{t("bots.items.status.needs_you")}
					</Chip>
				</div>
			)}
			{items.length === 0 ? (
				<EmptyState
					description={t("bots.items.empty.body", { bot: bots.length === 1 ? (bots[0]?.name ?? "") : "" })}
					icon={<ListChecks />}
					size="sm"
					title={t("bots.items.empty.title")}
				/>
			) : shown.length === 0 ? (
				<EmptyState
					actions={
						<Button onClick={() => setFilter(NO_FILTER)} size="sm" variant="secondary">
							{t("bots.items.filter.clearAll")}
						</Button>
					}
					size="sm"
					title={t("bots.items.empty.needsYou")}
				/>
			) : (
				<div
					className="flex flex-col gap-2"
					onKeyDown={event => {
						if (event.key === "Escape" && selected.size > 0) {
							event.preventDefault();
							setSelected(new Set());
						}
					}}
				>
					{ITEM_GROUPS.map(id => (
						<ItemGroup
							botOf={group ? botOf : undefined}
							groups={groups}
							id={id}
							key={id}
							moves={moves}
							now={now}
							onCancelAll={id === "stale" ? () => setCancelling(groups.stale) : undefined}
							onOpen={onOpen}
							onSelect={select}
							seenOf={seenOf}
							selected={selected}
						/>
					))}
				</div>
			)}
			{picked.length > 0 && (
				<div
					className="sticky bottom-2 z-(--sc-z-raised) mx-auto flex items-center gap-1 rounded-(--sc-radius-full) border border-(--sc-dialog-border) bg-(--sc-elevated) px-3 py-1 shadow-(--sc-shadow-md)"
					data-bot-items-selection
				>
					<span className="text-sc-sm">{t("bots.items.selected", { count: picked.length })}</span>
					<MenuButton
						items={[
							...PICKER_STATUSES.map(
								(status): ContextMenuItem => ({
									id: status,
									label: statusName(status, t, true),
									onSelect: () => moves.move(picked, status),
								}),
							),
							...(picked.some(item => !isClosed(item.status))
								? snoozeMenu(
										picked.filter(item => !isClosed(item.status)),
										moves,
										t,
										true,
									)
								: []),
						]}
						label={t("bots.items.pill.moveCount", { count: picked.length })}
						side="above"
						size="sm"
						variant="ghost"
					>
						{t("bots.items.pill.moveTo")}
					</MenuButton>
					<IconButton
						icon={<X />}
						label={t("bots.items.pill.clear")}
						onClick={() => setSelected(new Set())}
						size="sm"
					/>
				</div>
			)}
			{moves.dialog}
			<ConfirmDialog
				confirmLabel={t("bots.items.stale.confirmMany", { count: cancelling?.length ?? 0 })}
				message={t("bots.items.stale.confirmWhy", { reason: staleReason })}
				onCancel={() => setCancelling(null)}
				onConfirm={() => {
					if (cancelling) moveItems(cancelling, "canceled", { note: staleReason });
					setCancelling(null);
				}}
				open={cancelling !== null}
				title={t("bots.items.stale.confirm", { count: cancelling?.length ?? 0 })}
			/>
		</div>
	);
}

function ItemGroup({
	id,
	groups,
	selected,
	seenOf,
	now,
	moves,
	botOf,
	onOpen,
	onSelect,
	onCancelAll,
}: {
	id: ItemGroupId;
	groups: ItemGroups;
	selected: ReadonlySet<string>;
	seenOf: (item: Item) => number;
	now: number;
	moves: ItemMoves;
	botOf?: (item: Item) => Bot | undefined;
	onOpen: (item: Item) => void;
	onSelect: (item: Item, on: boolean, range: boolean) => void;
	onCancelAll?: () => void;
}) {
	const t = useT();
	const items = groups[id];
	const [open, setOpen] = useState(!GROUP_FOLDED[id]);
	const [rows, setRows] = useState(GROUP_ROWS);
	if (items.length === 0) return null;
	const fresh = items.filter(item => isUnseen(item, seenOf(item))).length;
	const all = id === "needs_you";
	const drawn = all ? items : items.slice(0, rows);
	const title = t(`bots.items.group.${id}`);
	return (
		<section aria-label={title} className="flex flex-col gap-0.5" data-bot-items-group={id}>
			<div className="flex min-h-(--sc-control-sm) items-center gap-1">
				<DisclosureButton
					className="flex-1 text-sc-xs font-semibold text-(--sc-text-muted)"
					onToggle={() => setOpen(!open)}
					open={open}
				>
					{title}
					<span className="ml-1.5 font-normal tabular-nums text-(--sc-text-subtle)">
						{items.length}
						{!open && fresh > 0 && (
							<span className="text-(--sc-text)"> · {t("bots.items.group.new", { count: fresh })}</span>
						)}
					</span>
				</DisclosureButton>
				{onCancelAll && (
					<Button onClick={onCancelAll} size="sm" variant="ghost">
						{t("bots.items.stale.cancelAll")}
					</Button>
				)}
			</div>
			{open && (
				<div className="flex flex-col" role="list">
					{drawn.map(item => (
						<ItemRow
							face={botOf?.(item)}
							item={item}
							key={item.id}
							moves={moves}
							muted={id === "stale" || id === "snoozed"}
							now={now}
							onOpen={onOpen}
							onSelect={onSelect}
							selected={selected.has(item.id)}
							selecting={selected.size > 0}
							unseen={isUnseen(item, seenOf(item))}
						/>
					))}
					{!all && items.length > drawn.length && (
						<Button
							className="self-start"
							onClick={() => setRows(rows + Math.max(GROUP_ROWS, items.length))}
							size="sm"
							variant="ghost"
						>
							{t("bots.showMore", { count: items.length - drawn.length })}
						</Button>
					)}
				</div>
			)}
		</section>
	);
}

function ItemRow({
	item,
	face,
	muted,
	unseen,
	selected,
	selecting,
	now,
	moves,
	onOpen,
	onSelect,
}: {
	item: Item;
	face?: Bot;
	muted: boolean;
	unseen: boolean;
	selected: boolean;
	selecting: boolean;
	now: number;
	moves: ItemMoves;
	onOpen: (item: Item) => void;
	onSelect: (item: Item, on: boolean, range: boolean) => void;
}) {
	const t = useT();
	const closed = isClosed(item.status);
	const snoozed = isSnoozed(item, now);
	const tip =
		!muted && item.status === "needs_you" && item.question
			? [item.question.text, ...(item.question.decisions ?? []).map(decision => decision.question)]
					.map(questionLine)
					.filter(Boolean)
					.join("\n")
			: !snoozed && item.status === "waiting"
				? item.wait?.text
				: undefined;
	return (
		<div data-bot-item={item.number} role="listitem">
			<ListRow
				actionCount={3}
				actions={
					closed ? undefined : (
						<>
							<IconButton
								icon={<Check />}
								label={t("bots.items.row.done")}
								onClick={() => moves.move([item], "done")}
								size="sm"
							/>
							<MenuButton
								align="end"
								icon={<Clock />}
								items={snoozeMenu([item], moves, t)}
								label={t("bots.items.snooze.menu")}
								size="sm"
								variant="ghost"
							/>
							<MenuButton
								align="end"
								icon={<MoreHorizontal />}
								items={[
									{ id: "done", label: t("bots.items.row.done"), onSelect: () => moves.move([item], "done") },
									{
										id: "cancel",
										label: t("bots.items.row.cancel"),
										onSelect: () => moves.move([item], "canceled"),
									},
								]}
								label={t("bots.items.row.more")}
								size="sm"
								variant="ghost"
							/>
						</>
					)
				}
				actionsOnHover
				buttonProps={{ "data-bot-item-open": item.id }}
				leading={
					<span className="relative z-(--sc-z-raised) flex size-4 items-center justify-center">
						<span className={cx("flex", selecting || selected ? "hidden" : "group-hover/row:hidden")}>
							<ItemStatusIcon live={itemLive(item)} muted={muted} status={item.status} />
						</span>
						<Checkbox
							aria-label={t("bots.items.row.select", { title: item.title })}
							checked={selected}
							className={cx(!(selecting || selected) && "hidden group-hover/row:block")}
							onChange={() => {}}
							onClick={event => {
								event.preventDefault();
								onSelect(item, !selected, event.shiftKey);
							}}
						/>
					</span>
				}
				meta={
					<span className="flex items-center gap-2">
						{unseen && (
							<span
								aria-label={t("bots.items.row.new")}
								className="size-1.5 rounded-full bg-(--sc-text)"
								data-bot-item-unseen
								role="img"
							/>
						)}
						{snoozed && item.snoozedUntil
							? t("bots.items.snooze.rowUntil", { when: formatSnooze(Date.parse(item.snoozedUntil), now) })
							: formatTimeAgo(activityAt(item, now))}
					</span>
				}
				onClick={() => onOpen(item)}
				selected={selected}
				size="sm"
				title={
					<span className={cx("flex min-w-0 items-center gap-1.5", closed && "text-(--sc-text-muted)")}>
						{face && <BotAvatar bot={face} size={16} />}
						<span className="shrink-0 tabular-nums text-(--sc-text-subtle)">#{item.number}</span>
						<span className="min-w-0 truncate">{item.title}</span>
					</span>
				}
				tooltip={tip}
			/>
		</div>
	);
}
