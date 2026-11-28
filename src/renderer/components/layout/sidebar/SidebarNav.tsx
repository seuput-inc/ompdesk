/**
 * The sidebar's nav rows (Orca's `SidebarNav`, the owner's decision of 25 Nov 2026): under the search line, one cell per
 * place the app goes besides a session: All sessions (the board, with how many sessions need the person and work now;
 * Orca's dashboard entry), Agents, Schedules, Stats and Phone (pairing a phone; not on the phone's own page). Bots has
 * no cell, as in Orca (sidebar/chrome/SidebarNav.tsx): the Bots section pinned atop the lists is its entry, its title
 * opening the Bots page (`SidebarBots.tsx`; the owner's call, 27 Nov 2026). Two cells to a row at every width (the
 * owner's request, 26 Nov 2026, restated 27 Nov 2026); All sessions takes a whole row, its counts need the room. A cell
 * too narrow for its words cuts its label after its icon, and the kit tooltip names it whole, with the Agents
 * shortcut a half cell has no room for (also its `aria-keyshortcuts`).
 * A cell's right click (long press, Shift+F10) hides it from this device's sidebar; Customize sidebar shows it again
 * (`navHidden`, device-local).
 */
import { BarChart3, Bot, CalendarClock, Columns3, Inbox, type LucideIcon, Smartphone } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, Suspense, useState } from "react";
import { useShellInput } from "../../../hooks/use-shell-mode";
import { lazyChunk } from "../../../lib/chunk-load";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { actionKbd, ariaKeyShortcut } from "../../../lib/keymap";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { useUiStore } from "../../../stores/ui";
import { webRuntime } from "../../../web/runtime";
import { anchorFromEvent, Button, ContextMenu, type ContextMenuAnchor, Tooltip } from "../../common";

// Its own chunk: the sidebar is on a phone's first screen, the figures are not needed for its first frame.
const BoardNavCounts = lazyChunk(() =>
	import("../../board/board-counts").then(module => ({ default: module.BoardNavCounts })),
);
const InboxCount = lazyChunk(() => import("./InboxCount").then(module => ({ default: module.InboxCount })));

export const SIDEBAR_NAV = ["board", "questions", "agents", "schedules", "stats", "phone"] as const;
export type SidebarNavRow = (typeof SIDEBAR_NAV)[number];

interface NavRowSpec {
	labelKey: string;
	icon: LucideIcon;
	/** The `data-destination` a page row carries (AppShell preloads its page when a pointer reaches it). */
	destination?: "agents" | "board" | "questions" | "insights";
	open: () => void;
}

export const SIDEBAR_NAV_ROWS: Record<SidebarNavRow, NavRowSpec> = {
	board: {
		labelKey: "destination.board",
		icon: Columns3,
		destination: "board",
		open: () => useUiStore.getState().openBoard(),
	},
	questions: {
		labelKey: "inbox.nav",
		icon: Inbox,
		destination: "questions",
		open: () => useUiStore.getState().openDestination("questions"),
	},
	agents: {
		labelKey: "destination.agents",
		icon: Bot,
		destination: "agents",
		open: () => useUiStore.getState().openAgents(),
	},
	schedules: {
		labelKey: "settings.section.schedules",
		icon: CalendarClock,
		open: () => useUiStore.getState().openSettings("schedules"),
	},
	stats: {
		labelKey: "destination.insights",
		icon: BarChart3,
		destination: "insights",
		open: () => useUiStore.getState().openInsights(),
	},
	phone: {
		labelKey: "sidebar.nav.phone",
		icon: Smartphone,
		open: () => useUiStore.getState().openSettings("connections:mobile-web"),
	},
};

/** The rows this view can offer at all (before the person's own hiding). */
export function useOfferedNavRows(): SidebarNavRow[] {
	const onPhonePage = webRuntime() !== null;
	return SIDEBAR_NAV.filter(row => row !== "phone" || !onPhonePage);
}

export function SidebarNav() {
	const t = useT();
	const destination = useUiStore(s => s.destination);
	const settingsTab = useUiStore(s => s.settingsTab);
	const keymapOverrides = useUiStore(s => s.keymapOverrides);
	const hidden = useSidebarFolds(s => s.navHidden);
	const touch = useShellInput() === "touch";
	const rows = useOfferedNavRows().filter(row => hidden[row] !== true);
	const [menu, setMenu] = useState<{ row: SidebarNavRow; anchor: ContextMenuAnchor } | null>(null);
	if (rows.length === 0) return null;
	const onKeyDown = (row: SidebarNavRow) => (event: ReactKeyboardEvent<HTMLElement>) => {
		if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
		event.preventDefault();
		const rect = event.currentTarget.getBoundingClientRect();
		setMenu({ row, anchor: { x: rect.left || 8, y: rect.bottom || 8 } });
	};
	return (
		<nav aria-label={t("sidebar.nav.label")} className="omp-sidebar-nav" data-sidebar-nav>
			{rows.map(row => {
				const { labelKey, icon: Icon, destination: page, open } = SIDEBAR_NAV_ROWS[row];
				const shortcut = row === "agents" ? actionKbd("agents.hub", keymapOverrides) : undefined;
				const here =
					row === "schedules"
						? destination === "settings" && settingsTab.startsWith("schedules")
						: page === destination;
				const cell = (
					<Button
						aria-current={here ? "page" : undefined}
						aria-keyshortcuts={shortcut ? ariaKeyShortcut(shortcut) : undefined}
						className={cx(
							"omp-sidebar-nav-row w-full min-w-0 justify-start gap-2 px-2",
							here ? "bg-(--sc-selected) text-(--sc-text)" : "text-(--sc-text-secondary)",
						)}
						data-destination={page}
						data-sidebar-nav-row={row}
						icon={<Icon strokeWidth={here ? 2.25 : 1.75} />}
						key={row}
						onClick={open}
						onContextMenu={event => setMenu({ row, anchor: anchorFromEvent(event) })}
						onKeyDown={onKeyDown(row)}
						size="sm"
						variant="ghost"
					>
						<span className="min-w-0 flex-1 truncate text-left">{t(labelKey)}</span>
						{row === "board" && (
							<Suspense fallback={null}>
								<BoardNavCounts />
							</Suspense>
						)}
						{row === "questions" && (
							<Suspense fallback={null}>
								<InboxCount />
							</Suspense>
						)}
					</Button>
				);
				// The cell's name in the kit tooltip, whole where a narrow cell cuts it, with the Agents shortcut a half
				// cell has no room for. A finger's long press is the cell's menu, and a phone has no shortcut to show.
				return !touch ? (
					<Tooltip content={t(labelKey)} describe={false} key={row} shortcut={shortcut}>
						{cell}
					</Tooltip>
				) : (
					cell
				);
			})}
			{menu && (
				<ContextMenu
					ariaLabel={t("sidebar.pin.menu", { name: t(SIDEBAR_NAV_ROWS[menu.row].labelKey) })}
					items={[
						{
							id: "nav-hide",
							label: t("sidebar.nav.hide"),
							onSelect: () => {
								setMenu(null);
								useSidebarFolds.getState().setNavHidden(menu.row, true);
							},
						},
					]}
					onClose={() => setMenu(null)}
					x={menu.anchor.x}
					y={menu.anchor.y}
				/>
			)}
		</nav>
	);
}
