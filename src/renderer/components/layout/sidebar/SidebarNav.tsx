/**
 * The sidebar's nav rows (Orca's `SidebarNav`, the owner's decision of 25 Nov 2026): under the search line, one row per
 * place the app goes besides a session: Agents, Schedules, Bots (only while the bots feature is available,
 * `useBotsAvailable`), Stats and Phone (pairing a phone; not on the phone's own page). A row's right click (long press,
 * Shift+F10) hides it from this device's sidebar; Customize sidebar shows it again (`navHidden`, device-local).
 */
import { BarChart3, Bot, BotMessageSquare, CalendarClock, type LucideIcon, Smartphone } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useState } from "react";
import { useBotsAvailable } from "../../../lib/bots-source";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { actionKbd } from "../../../lib/keymap";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { useUiStore } from "../../../stores/ui";
import { webRuntime } from "../../../web/runtime";
import { anchorFromEvent, Button, ContextMenu, type ContextMenuAnchor, Kbd } from "../../common";

export const SIDEBAR_NAV = ["agents", "schedules", "bots", "stats", "phone"] as const;
export type SidebarNavRow = (typeof SIDEBAR_NAV)[number];

interface NavRowSpec {
	labelKey: string;
	icon: LucideIcon;
	/** The `data-destination` a page row carries (AppShell preloads its page when a pointer reaches it). */
	destination?: "agents" | "bots" | "insights";
	open: () => void;
}

export const SIDEBAR_NAV_ROWS: Record<SidebarNavRow, NavRowSpec> = {
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
	bots: {
		labelKey: "destination.bots",
		icon: BotMessageSquare,
		destination: "bots",
		open: () => useUiStore.getState().openBots(),
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
	const bots = useBotsAvailable();
	const onPhonePage = webRuntime() !== null;
	return SIDEBAR_NAV.filter(row => (row !== "bots" || bots) && (row !== "phone" || !onPhonePage));
}

export function SidebarNav() {
	const t = useT();
	const destination = useUiStore(s => s.destination);
	const settingsTab = useUiStore(s => s.settingsTab);
	const keymapOverrides = useUiStore(s => s.keymapOverrides);
	const hidden = useSidebarFolds(s => s.navHidden);
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
		<nav aria-label={t("sidebar.nav.label")} className="flex flex-col gap-px" data-sidebar-nav>
			{rows.map(row => {
				const { labelKey, icon: Icon, destination: page, open } = SIDEBAR_NAV_ROWS[row];
				const shortcut = row === "agents" ? actionKbd("agents.hub", keymapOverrides) : undefined;
				const here =
					row === "schedules"
						? destination === "settings" && settingsTab.startsWith("schedules")
						: page === destination;
				return (
					<Button
						aria-current={here ? "page" : undefined}
						className={cx(
							"omp-sidebar-nav-row w-full min-w-0 justify-start gap-2.5 px-2.5",
							here ? "bg-(--sc-selected) text-(--sc-text)" : "text-(--sc-text-secondary)",
						)}
						data-destination={page}
						data-sidebar-nav-row={row}
						icon={<Icon strokeWidth={here ? 2.25 : 1.75} />}
						key={row}
						onClick={open}
						onContextMenu={event => setMenu({ row, anchor: anchorFromEvent(event) })}
						onKeyDown={onKeyDown(row)}
						variant="ghost"
					>
						<span className="min-w-0 flex-1 truncate text-left">{t(labelKey)}</span>
						{shortcut && <Kbd className="omp-sidebar-kbd" shortcut={shortcut} />}
					</Button>
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
