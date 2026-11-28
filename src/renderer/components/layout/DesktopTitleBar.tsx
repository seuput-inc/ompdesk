import {
	ArrowLeft,
	ArrowRight,
	Copy,
	Maximize2,
	Minimize2,
	Minus,
	MoreHorizontal,
	PanelLeft,
	PanelRight,
	Square,
	X,
} from "lucide-react";
import { type ReactNode, useEffect } from "react";
import type { ChromeLayout } from "../../lib/chrome-layout";
import { useT } from "../../lib/i18n";
import { actionKbd } from "../../lib/keymap";
import { navigateHistory, useTabHistoryStore } from "../../lib/tab-history";
import { useTabsStore } from "../../stores/tabs";
import { toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { BrandMark, IconButton } from "../common";
import "./desktop-title-bar.css";

export function DesktopTitleBar({
	layout,
	children,
	maximized,
	disabledContent,
}: {
	layout: ChromeLayout;
	children: ReactNode;
	maximized: boolean;
	disabledContent?: boolean;
}) {
	const t = useT();
	const sidebar = useUiStore(s => s.sidebarVisible);
	const session = useUiStore(s => s.destination === "session");
	const panel = useUiStore(s => s.panelVisible);
	const expanded = useUiStore(s => s.paneExpanded);
	const keys = useUiStore(s => s.keymapOverrides);
	const split = useTabsStore(s => s.split !== null);
	const back = useTabHistoryStore(s => s.back.length > 0);
	const forward = useTabHistoryStore(s => s.forward.length > 0);
	const native = window.omp?.windowChrome?.native;
	const ui = useUiStore.getState;
	useEffect(() => {
		if (!split && expanded) useUiStore.setState({ paneExpanded: false });
	}, [split, expanded]);
	const run = (action: Promise<void> | undefined, label: string) => {
		void action?.catch(error => toastError({ title: t(label), error }));
	};
	if (layout.bar !== "desktop") return null;
	return (
		<header className="desktop-title-bar drag-region" data-desktop-titlebar="">
			<div className="contents" inert={disabledContent}>
				<div
					className="flex h-full min-w-max shrink-0 items-center gap-1 pr-2"
					style={{ paddingLeft: layout.leftInset || 6, width: sidebar ? "var(--boot-sidebar-w)" : undefined }}
				>
					{layout.identity === "app-menu" ? (
						<>
							<BrandMark size={18} title="OMPdesk" />
							<IconButton
								aria-haspopup="menu"
								className="no-drag"
								disabled={!native}
								icon={<MoreHorizontal />}
								label={t("titlebar.appMenu")}
								onClick={event => {
									const rect = event.currentTarget.getBoundingClientRect();
									run(native?.showMenu(rect.left, rect.bottom), "titlebar.appMenu");
								}}
								size="sm"
								tooltipSide="bottom"
							/>
						</>
					) : (
						<span className="shrink-0 px-1 text-sc-sm font-semibold">OMPdesk</span>
					)}
					<IconButton
						className="no-drag"
						icon={<PanelLeft />}
						label={t("titlebar.toggleSidebar")}
						onClick={() => ui().toggleSidebar()}
						pressed={sidebar}
						shortcut={actionKbd("sidebar.toggle", keys)}
						size="sm"
						tooltipSide="bottom"
					/>
					<IconButton
						className="no-drag ml-auto"
						disabled={!back}
						icon={<ArrowLeft />}
						label={t("hotkeys.row.navBack")}
						onClick={() => void navigateHistory(-1)}
						shortcut={actionKbd("nav.back", keys)}
						size="sm"
						tooltipSide="bottom"
					/>
					<IconButton
						className="no-drag"
						disabled={!forward}
						icon={<ArrowRight />}
						label={t("hotkeys.row.navForward")}
						onClick={() => void navigateHistory(1)}
						shortcut={actionKbd("nav.forward", keys)}
						size="sm"
						tooltipSide="bottom"
					/>
				</div>
				<div className="desktop-title-middle">{children}</div>
				<span aria-hidden="true" data-titlebar-drag="" />
				{session && split && (
					<IconButton
						className="no-drag"
						icon={expanded ? <Minimize2 /> : <Maximize2 />}
						label={t(expanded ? "titlebar.restorePanes" : "titlebar.expandPane")}
						onClick={() => ui().togglePaneExpanded()}
						size="sm"
						tooltipSide="bottom"
					/>
				)}
				{session && !panel && (
					<IconButton
						className="no-drag"
						data-tour="panel"
						icon={<PanelRight />}
						label={t("titlebar.sidePanel")}
						onClick={() => ui().togglePanel()}
						shortcut={actionKbd("panel.toggle", keys)}
						size="sm"
						tooltipSide="bottom"
					/>
				)}
			</div>
			{layout.captionWidth > 0 && (
				<div className="no-drag" data-caption-buttons="" style={{ width: layout.captionWidth }}>
					<IconButton
						data-caption="minimize"
						disabled={!native}
						icon={<Minus />}
						label={t("titlebar.minimize")}
						onClick={() => run(native?.minimize(), "titlebar.minimize")}
						size="sm"
						tooltipSide="bottom"
					/>
					<IconButton
						data-caption="maximize"
						disabled={!native}
						icon={maximized ? <Copy /> : <Square />}
						label={t(maximized ? "titlebar.restore" : "titlebar.maximize")}
						onClick={() => run(native?.toggleMaximize(), maximized ? "titlebar.restore" : "titlebar.maximize")}
						size="sm"
						tooltipSide="bottom"
					/>
					<IconButton
						data-caption="close"
						disabled={!native}
						icon={<X />}
						label={t("titlebar.close")}
						onClick={() => run(native?.close(), "titlebar.close")}
						size="sm"
						tooltipSide="bottom"
					/>
				</div>
			)}
		</header>
	);
}
