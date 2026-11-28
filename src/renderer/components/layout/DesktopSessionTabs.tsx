import { FolderOpen, Info, MoreHorizontal } from "lucide-react";
import { type RefObject, useRef, useState } from "react";
import { useCurrentSessionTitle } from "../../hooks/use-current-session-title";
import { useTabListRows } from "../../hooks/use-tab-list-rows";
import { useT } from "../../lib/i18n";
import { combinedTitle } from "../../lib/session-title";
import { closeSessionTab } from "../../lib/tab-close";
import { useSessionStore } from "../../stores/session";
import { tabChipParts, useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { ContextMenu, type ContextMenuAnchor, IconButton, Popover, SessionTitle, type TabItem, Tabs } from "../common";
import { SessionIdentity, SessionRename, sessionCommands } from "./SessionControls";
import { StatusIcon, useSessionStatus } from "./SessionStatus";

function ActiveSessionActions({ trigger }: { trigger: RefObject<HTMLButtonElement | null> }) {
	const t = useT();
	const streaming = useSessionStore(s => s.isStreaming);
	const [menu, setMenu] = useState<ContextMenuAnchor | null>(null);
	const [panel, setPanel] = useState<"rename" | "details" | null>(null);
	const closePanel = () => setPanel(null);
	const swallowClick = useRef(false);
	return (
		<>
			<IconButton
				aria-expanded={menu !== null}
				aria-haspopup="menu"
				className="shrink-0"
				data-session-tab-menu=""
				icon={<MoreHorizontal />}
				label={t("titlebar.actions")}
				onPointerDown={() => {
					swallowClick.current = menu !== null;
				}}
				onClick={event => {
					if (swallowClick.current) {
						swallowClick.current = false;
						return;
					}
					closePanel();
					const rect = event.currentTarget.getBoundingClientRect();
					setMenu({ x: rect.right, y: rect.bottom + 4 });
				}}
				ref={trigger}
				size="sm"
			/>
			{menu && (
				<ContextMenu
					{...menu}
					align="end"
					ariaLabel={t("titlebar.actions")}
					items={[
						...sessionCommands(t, () => setPanel("rename")),
						{
							id: "project",
							icon: FolderOpen,
							label: t("titlebar.switchProject"),
							disabled: streaming,
							disabledReason: t("titlebar.abortHint"),
							onSelect: () => useUiStore.getState().openProjectPicker(),
						},
						{ id: "details", icon: Info, label: t("titlebar.details"), onSelect: () => setPanel("details") },
					].map(item => ({
						...item,
						onSelect: () => {
							setMenu(null);
							item.onSelect();
						},
					}))}
					onClose={() => setMenu(null)}
				/>
			)}
			<Popover
				anchorRef={trigger}
				ariaLabel={t(panel === "rename" ? "titlebar.rename" : "titlebar.details")}
				className="w-80 [&_[data-auto-title-error]]:static"
				onClose={closePanel}
				open={panel !== null}
				placement="bottom-end"
			>
				{panel === "rename" && <SessionRename onDone={closePanel} />}
				{panel === "details" && (
					<div
						className="flex flex-col items-start gap-2 [&_[data-bot-banner]]:ml-0 [&_[data-bot-banner]]:inline-flex! [&_.truncate]:whitespace-normal [&_.truncate]:overflow-visible"
						data-session-tab-details=""
					>
						<span className="text-sc-md font-semibold">{t("titlebar.details")}</span>
						<SessionIdentity closeDetails={closePanel} />
					</div>
				)}
			</Popover>
		</>
	);
}

export function DesktopSessionTabs() {
	const t = useT();
	const tabs = useTabsStore(s => s.tabs);
	const activeId = useTabsStore(s => s.activeTabId);
	const sessionId = useSessionStore(s => s.sessionId);
	const listedRowOf = useTabListRows();
	const runtimeTitle = useCurrentSessionTitle();
	const state = useSessionStatus();
	const trigger = useRef<HTMLButtonElement>(null);
	const active = tabs.find(tab => tab.id === activeId);
	const closable = tabs.some(tab => !tab.ghost && tab.id !== activeId);
	if (!active) return null;
	const focusedTitle =
		active.ghost || (!sessionId && active.title) ? tabChipParts(active, tabs, listedRowOf(active)) : runtimeTitle;
	return (
		<div
			className="no-drag flex min-w-0 max-w-full items-center gap-1"
			data-desktop-session-tabs=""
			onKeyDown={event => {
				if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
				if (!(event.target as HTMLElement).closest('[role="tab"][aria-selected="true"]')) return;
				event.preventDefault();
				trigger.current?.click();
			}}
		>
			<h1 className="sr-only" data-titlebar-heading="">
				{combinedTitle(focusedTitle)}
			</h1>
			<Tabs
				activeId={active.id}
				ariaLabel={t("sessionPicker.group.open")}
				className="min-w-0"
				compact
				onChange={id => void useTabsStore.getState().switchTab(id)}
				tabs={tabs.map((tab): TabItem => {
					const selected = tab.id === active.id;
					const parts = selected ? focusedTitle : tabChipParts(tab, tabs, listedRowOf(tab));
					const name = combinedTitle(parts);
					const item: TabItem = {
						id: tab.id,
						className: "max-w-56",
						disabled: tab.ghost,
						label: name,
						labelContent: (
							<span className="flex min-w-0" data-titlebar-session-name={selected ? "" : undefined}>
								<SessionTitle parts={parts} noTooltip />
							</span>
						),
						tooltip: selected ? `${name} · ${state.title}` : name,
						leading: selected ? <StatusIcon tone={state.tone} /> : undefined,
						trailing: selected ? (
							<span
								aria-label={state.label}
								className="omp-titlebar-status sr-only"
								data-remote-reconnecting={state.lostDevice}
								data-tone={state.tone}
								role="status"
								title={state.title}
							>
								{state.label}
							</span>
						) : undefined,
						keyshortcuts: selected && !tab.ghost ? "Shift+F10" : undefined,
						onContextMenu:
							selected && !tab.ghost
								? event => {
										event.preventDefault();
										trigger.current?.click();
									}
								: undefined,
					};
					return closable && !tab.ghost
						? {
								...item,
								closeLabel: t("tabOverview.close", { title: name }),
								onClose: () => closeSessionTab(tab.id),
							}
						: item;
				})}
				variant="pills"
			/>
			{!active.ghost && <ActiveSessionActions key={`${active.id}:${sessionId ?? ""}`} trigger={trigger} />}
		</div>
	);
}
