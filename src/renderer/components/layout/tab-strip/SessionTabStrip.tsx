/**
 * The window's open sessions as tabs along the title bar (Orca's tab bar, the owner's decision of 25 Nov 2026, which
 * replaces "there is no tab strip"): one tab per session tab this window holds (a session another session's agent
 * opened shows only while it is on screen: its row nests under its opener in the sidebar), in the window's tab order.
 * Each leads with the status lane's mark (`laneState`, the sidebar row's rank), is cut at 200 px with its whole name in
 * the tooltip, and closes by its ✕, a middle click or Delete under ⌘W's rules (`requestTabClose`: a running tab asks
 * first). The chosen tab is the session's name: a click on it renames it, as the title bar's name did. Its menu
 * renames, splits it beside the session on screen, and closes it, the others, or those to its right or left (a running
 * one stays). The + opens a new session tab, chat, worktree, terminal or preview. Only a desktop window has the strip
 * (Orca's is a desktop app): a phone or tablet page keeps its one title, its tabs being the sidebar's.
 */
import { GitBranch, Globe, MessageSquarePlus, Plus, SquareTerminal } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, type ReactNode, useMemo, useState } from "react";
import type { SessionInfo } from "../../../../shared/ipc-types";
import { useSessionList } from "../../../hooks/use-session-list";
import { useT } from "../../../lib/i18n";
import { laneState } from "../../../lib/session-lane";
import { type RunFacts, sessionRun } from "../../../lib/session-run";
import { closeOtherTabs, requestTabClose } from "../../../lib/tab-close";
import { type SessionTab, tabDisplayTitle, useTabsStore, visibleTabIds } from "../../../stores/tabs";
import { toast } from "../../../stores/toast";
import { type PanelTab, useUiStore } from "../../../stores/ui";
import { anchorFromEvent, ContextMenu, type ContextMenuAnchor, MenuButton, type TabItem, Tabs } from "../../common";
import { SessionStatusLane } from "../sidebar/SessionStatusLane";

/** A tab's lane mark, from the tab's own state (the same rank as its sidebar row's). */
function tabLane(tab: SessionTab) {
	const facts: RunFacts = {
		status: tab.status,
		ask: tab.awaitingInput,
		...(tab.settling ? { settling: true as const } : {}),
		...(tab.compacting ? { compacting: true as const } : {}),
		...(tab.awaitingConnection ? { awaitingConnection: true as const } : {}),
		...(tab.sessionHeld ? { sessionHeld: true as const } : {}),
		...(tab.queued ? { queued: true as const } : {}),
	};
	const run = sessionRun(facts, tab.unreadDone);
	return laneState({
		run,
		attention: run.ask,
		live: run.running ? (run.settling ? "background" : "turn") : null,
		stopped: tab.lastRun?.stopReason === "aborted",
		pullRequest: false,
		open: false,
	});
}

function showPanel(view: PanelTab): void {
	const ui = useUiStore.getState();
	if (ui.destination !== "session") ui.closeDestination();
	ui.setPanelTab(view);
	if (!ui.panelVisible) ui.togglePanel();
}

export function SessionTabStrip({
	activeTitle,
	activeContent,
	onRenameActive,
}: {
	/** The chosen tab's name (the title bar's, with its automatic title). */
	activeTitle: string;
	/** How the chosen tab draws that name: the typed name and the automatic title apart, as the sidebar row does. */
	activeContent?: ReactNode;
	onRenameActive: () => void;
}) {
	const t = useT();
	const tabs = useTabsStore(s => s.tabs);
	const activeTabId = useTabsStore(s => s.activeTabId);
	const split = useTabsStore(s => s.split);
	const { sessions } = useSessionList("global");
	const [menu, setMenu] = useState<{ tab: SessionTab; anchor: ContextMenuAnchor } | null>(null);
	const indexed = useMemo(() => {
		const index = new Map<string, SessionInfo>();
		for (const session of sessions) index.set(session.path, session);
		return index;
	}, [sessions]);
	const shown = visibleTabIds({ activeTabId, split });
	const strip = tabs.filter(tab => !tab.openedBy || shown.includes(tab.id));
	const untitled = t("sidebar.newSession");
	const closeSide = async (keep: string, side: "both" | "right" | "left") => {
		const kept = await closeOtherTabs(keep, side);
		if (kept > 0) toast({ variant: "info", message: t("tabs.closeOthersKept", { count: kept }) });
	};
	const items: TabItem[] = strip.map(tab => {
		const active = tab.id === activeTabId;
		const listed = tab.sessionPath ? indexed.get(tab.sessionPath) : undefined;
		const label = active ? activeTitle : tabDisplayTitle(tab, strip, listed, untitled);
		const openMenu = (event: MouseEvent<HTMLElement>) => {
			event.preventDefault();
			setMenu({ tab, anchor: anchorFromEvent(event) });
		};
		return {
			id: tab.id,
			label,
			content: active ? activeContent : undefined,
			tooltip: label,
			leading: <SessionStatusLane state={tabLane(tab)} />,
			className: tab.unreadDone && !active ? "omp-tab-strip-tab-unread" : undefined,
			attrs: {
				"data-session-tab": tab.sessionPath ?? `tab:${tab.id}`,
				...(active ? { "data-titlebar-session-name": "" } : {}),
			},
			onContextMenu: openMenu,
			onClose: () => requestTabClose(tab.id),
			closeLabel: t("tabStrip.close", { name: label }),
		};
	});
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
		const id = (event.target as HTMLElement).closest?.("[role=tab]")?.getAttribute("data-tab-id");
		const tab = strip.find(entry => entry.id === id);
		if (!tab) return;
		event.preventDefault();
		const rect = (event.target as HTMLElement).getBoundingClientRect();
		setMenu({ tab, anchor: { x: rect.left || 8, y: rect.bottom || 8 } });
	};
	const index = menu ? strip.findIndex(tab => tab.id === menu.tab.id) : -1;
	return (
		<div className="omp-tab-strip flex h-full min-w-0 flex-1 items-stretch" data-tab-strip onKeyDown={onKeyDown}>
			<Tabs
				activeId={activeTabId ?? ""}
				ariaLabel={t("tabStrip.label")}
				className="min-w-0"
				onChange={(id, via) => {
					if (id === activeTabId) {
						if (via === "click") onRenameActive();
						return;
					}
					void useTabsStore.getState().switchTab(id);
				}}
				tabs={items}
				variant="strip"
			/>
			<MenuButton
				className="no-drag mx-1 self-center"
				data-tab-strip-new
				icon={<Plus />}
				items={[
					{
						id: "new-tab",
						label: t("cmd.newTab"),
						icon: Plus,
						onSelect: () => void useTabsStore.getState().openTab(),
					},
					{
						id: "new-chat",
						label: t("cmd.newChatTab"),
						icon: MessageSquarePlus,
						onSelect: () => void useTabsStore.getState().openTab({ kind: "chat" }),
					},
					{
						id: "new-worktree",
						label: t("hotkeys.row.tabNewWorktree"),
						icon: GitBranch,
						onSelect: () => useUiStore.getState().openWorktreeDialog(),
					},
					{
						id: "terminal",
						label: t("panel.tabs.terminal"),
						icon: SquareTerminal,
						separatorBefore: true,
						onSelect: () => showPanel("terminal"),
					},
					{ id: "preview", label: t("panel.tabs.preview"), icon: Globe, onSelect: () => showPanel("preview") },
				]}
				label={t("tabStrip.new")}
				size="sm"
				variant="ghost"
			/>
			{menu && (
				<ContextMenu
					ariaLabel={t("tabStrip.menu")}
					items={[
						...(menu.tab.id === activeTabId
							? [{ id: "rename", label: t("titlebar.rename"), onSelect: onRenameActive }]
							: [
									{
										id: "split",
										label: t("tabs.menu.splitRight"),
										onSelect: () => void useTabsStore.getState().splitTab(menu.tab.id, "right"),
									},
								]),
						{
							id: "close",
							label: t("tabStrip.closeOne"),
							separatorBefore: true,
							onSelect: () => requestTabClose(menu.tab.id),
						},
						{
							id: "close-others",
							label: t("tabs.menu.closeOthers"),
							onSelect: () => void closeSide(menu.tab.id, "both"),
						},
						{
							id: "close-right",
							label: t("tabStrip.closeRight"),
							disabled: index >= strip.length - 1,
							onSelect: () => void closeSide(menu.tab.id, "right"),
						},
						{
							id: "close-left",
							label: t("tabStrip.closeLeft"),
							disabled: index <= 0,
							onSelect: () => void closeSide(menu.tab.id, "left"),
						},
					].map(item => ({
						...item,
						onSelect: () => {
							setMenu(null);
							item.onSelect();
						},
					}))}
					onClose={() => setMenu(null)}
					x={menu.anchor.x}
					y={menu.anchor.y}
				/>
			)}
		</div>
	);
}
