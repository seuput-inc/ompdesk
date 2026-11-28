import { Menu, MoreHorizontal, PanelLeft, PanelRight } from "lucide-react";
import { useRef, useState } from "react";
import { useCurrentSessionTitle } from "../../hooks/use-current-session-title";
import { useOverlayPresence } from "../../hooks/use-overlay-presence";
import { useDrawerMode } from "../../hooks/use-shell-mode";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { actionKbd } from "../../lib/keymap";
import { combinedTitle } from "../../lib/session-title";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { useWebLinkLost } from "../../web/link-status";
import { Button, IconButton, MenuButton, SessionTitle, Tooltip } from "../common";
import { SessionIdentity, SessionRename, sessionCommands } from "./SessionControls";
import { StatusPill, useSessionStatus } from "./SessionStatus";
import { SessionUsage } from "./SessionUsage";

/** A destination page's bar (Settings, Agents) shows the phone page's lost link the way the title bar does. */
export function WebLinkStatus() {
	const t = useT();
	const lost = useWebLinkLost();
	const { mounted, closing } = useOverlayPresence(lost !== null, "fast");
	// While the pill fades out it still says the last thing it said.
	const said = useRef(lost);
	if (lost) said.current = lost;
	const state = lost ?? said.current;
	if (!mounted || !state) return null;
	const label = t(state === "connecting" ? "web.connection.connecting" : "web.connection.lost");
	return (
		<div
			aria-hidden={closing || undefined}
			aria-label={label}
			className={cx(
				"omp-titlebar-status no-drag flex shrink-0 items-center px-1.5",
				closing ? "omp-fade-out" : "omp-fade-in",
			)}
			data-tone="offline"
			inert={closing}
			role="status"
			title={label}
		>
			<StatusPill label={label} tone="offline" />
		</div>
	);
}

export function WebSessionBar() {
	const t = useT();
	const sessionId = useSessionStore(s => s.sessionId);
	const sidebarVisible = useUiStore(s => s.sidebarVisible);
	const drawer = useDrawerMode();
	const panelVisible = useUiStore(s => s.panelVisible);
	const keymapOverrides = useUiStore(s => s.keymapOverrides);
	const [editingName, setEditingName] = useState(false);
	const displayParts = useCurrentSessionTitle();
	const displayName = combinedTitle(displayParts);
	const state = useSessionStatus();
	const startRename = () => setEditingName(true);
	const ui = useUiStore.getState;
	return (
		<header className="omp-titlebar omp-topbar drag-region flex h-(--sc-topbar-h) min-w-0 shrink-0 items-center gap-1 px-3">
			{!sidebarVisible && (
				<IconButton
					className="no-drag"
					icon={drawer ? <Menu /> : <PanelLeft />}
					label={t(drawer ? "shell.openMenu" : "titlebar.toggleSidebar")}
					onClick={() => ui().toggleSidebar()}
					shortcut={actionKbd("sidebar.toggle", keymapOverrides)}
				/>
			)}
			<nav aria-label={t("titlebar.breadcrumb")} className="omp-titlebar-identity no-drag flex min-w-0 items-center">
				<SessionIdentity editing={editingName}>
					<h1 className="sr-only" data-titlebar-heading="">
						{displayName}
					</h1>
					{editingName ? (
						<SessionRename key={sessionId} onDone={() => setEditingName(false)} />
					) : (
						<Tooltip content={`${displayName} · ${t("titlebar.rename")}`} describe={false} side="bottom">
							<Button
								className="min-w-0 max-w-96 shrink! px-2 font-semibold text-(--sc-text)"
								data-titlebar-session-name=""
								aria-label={`${t("titlebar.rename")}: ${displayName}`}
								onClick={startRename}
								size="sm"
								variant="ghost"
							>
								<SessionTitle
									noTooltip
									parts={displayParts}
									swapScope={sessionId ?? ""}
									className="text-sc-md"
								/>
							</Button>
						</Tooltip>
					)}
				</SessionIdentity>
			</nav>

			<div
				aria-live="polite"
				className="omp-titlebar-status no-drag flex min-w-0 shrink-0 items-center px-1.5"
				data-tone={state.tone}
				data-remote-reconnecting={state.lostDevice}
				aria-label={state.label}
				role="status"
				title={state.title}
			>
				<StatusPill label={state.label} tone={state.tone} />
			</div>

			{/* `ml-auto`, not an empty flex-1 spacer: the spacer cost the bar one more gap, 14 px of a phone's title. */}
			<div className="no-drag ml-auto flex shrink-0 items-center gap-0.5">
				<SessionUsage statusPill={<StatusPill label={state.label} tone={state.tone} />} />
				<MenuButton
					align="end"
					icon={<MoreHorizontal />}
					items={sessionCommands(t, startRename)}
					label={t("titlebar.actions")}
				/>
				<IconButton
					data-tour="panel"
					icon={<PanelRight />}
					label={t("titlebar.sidePanel")}
					onClick={() => ui().togglePanel()}
					pressed={panelVisible}
					shortcut={actionKbd("panel.toggle", keymapOverrides)}
				/>
			</div>
		</header>
	);
}
