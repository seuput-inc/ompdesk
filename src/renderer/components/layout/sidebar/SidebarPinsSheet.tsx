/**
 * "Customize sidebar…": one switch per nav row this view offers (`SidebarNav`, device-local `navHidden`) and one per
 * footer shortcut (`RAIL_PINS`), the only place besides a row's own context menu that shows and hides them.
 * `toggleRailPin` is the single writer of the stored `railPins`.
 */

import { createElement, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { FOOTER_PINS, type FooterPin } from "../../../../shared/sidebar-prefs";
import { useT } from "../../../lib/i18n";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { RAIL_PIN_LABEL_KEYS, useSidebarPrefs } from "../../../stores/sidebar-prefs";
import { anchorFromEvent, ContextMenu, type ContextMenuAnchor, Modal, SwitchTile } from "../../common";
import { RAIL_PIN_ICONS } from "./rail-pin-icons";
import { SIDEBAR_NAV_ROWS, useOfferedNavRows } from "./SidebarNav";

export function SidebarPinsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
	const t = useT();
	const railPins = useSidebarPrefs(s => s.railPins);
	const navHidden = useSidebarFolds(s => s.navHidden);
	const navRows = useOfferedNavRows();
	return (
		<Modal onClose={onClose} open={open} size="sm" title={t("help.customizeSidebar")}>
			<div className="flex flex-col gap-px" data-sidebar-pins>
				{navRows.map(row => (
					<SwitchTile
						checked={navHidden[row] !== true}
						icon={createElement(SIDEBAR_NAV_ROWS[row].icon)}
						id={`sidebar-nav-${row}`}
						key={row}
						label={t(SIDEBAR_NAV_ROWS[row].labelKey)}
						onCheckedChange={shown => useSidebarFolds.getState().setNavHidden(row, !shown)}
					/>
				))}
				{FOOTER_PINS.map(pin => (
					<SwitchTile
						checked={railPins.includes(pin)}
						icon={createElement(RAIL_PIN_ICONS[pin])}
						id={`sidebar-pin-${pin}`}
						key={pin}
						label={t(RAIL_PIN_LABEL_KEYS[pin])}
						onCheckedChange={() => void useSidebarPrefs.getState().toggleRailPin(pin)}
					/>
				))}
			</div>
		</Modal>
	);
}

export interface PinMenuState {
	pin: FooterPin;
	anchor: ContextMenuAnchor;
}

/** Handlers that open a pinned row's menu: right click, long press on touch (the shell sends it as a contextmenu), Shift+F10. */
export function pinMenuHandlers(pin: FooterPin, open: (menu: PinMenuState) => void) {
	return {
		onContextMenu: (event: ReactMouseEvent) => open({ pin, anchor: anchorFromEvent(event) }),
		onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
			if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
			event.preventDefault();
			const rect = event.currentTarget.getBoundingClientRect();
			open({
				pin,
				anchor: {
					x: Number.isFinite(rect.left) ? rect.left : 8,
					y: Number.isFinite(rect.bottom) ? rect.bottom : 8,
				},
			});
		},
	};
}

export function PinMenu({
	menu,
	onCustomize,
	onClose,
}: {
	menu: PinMenuState;
	onCustomize: () => void;
	onClose: () => void;
}) {
	const t = useT();
	return (
		<ContextMenu
			ariaLabel={t("sidebar.pin.menu", { name: t(RAIL_PIN_LABEL_KEYS[menu.pin]) })}
			items={[
				{
					id: "pin-unpin",
					label: t("sidebar.pin.unpin"),
					onSelect: () => void useSidebarPrefs.getState().toggleRailPin(menu.pin),
				},
				{ id: "pin-customize", label: t("help.customizeSidebar"), onSelect: onCustomize },
			]}
			onClose={onClose}
			x={menu.anchor.x}
			y={menu.anchor.y}
		/>
	);
}
