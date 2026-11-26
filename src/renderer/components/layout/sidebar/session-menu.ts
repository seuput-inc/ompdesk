/**
 * The one session-row menu, for this computer's list (Sidebar.tsx) and a paired host's (SidebarDevices.tsx): the
 * list gathers the row's facts and the actions it supports, and this decides what the menu holds and in what order.
 * An action the list does not support is absent, never a disabled item (a host has no "Show in folder"); an item the
 * list supports but this row cannot take right now is disabled with its reason (Move to project… while a tab holds
 * the session).
 *
 * Groups, each set apart: open and view (split, new window, the open tab's split, mark as unread and close) · ports
 * (each port the tab's processes listen on: open it in the Preview, stop its process; Orca's worktree card ports,
 * `WorktreeCardPorts.tsx:127-238`) · edit (rename, pin, mute notifications, move up and down, move to project,
 * archive, hide from agents) · show in folder · diagnostics (one item; Option/Alt while choosing it saves the
 * anonymized bundle) · delete, last. Clicking a row already opens it, so the menu has no "Open" or "Open in new tab".
 */
import {
	Archive,
	ArchiveRestore,
	ArrowDown,
	ArrowUp,
	Bell,
	BellOff,
	Bot,
	CircleStop,
	Columns2,
	Copy,
	ExternalLink,
	Eye,
	EyeOff,
	FileArchive,
	FolderInput,
	FolderSearch,
	Globe,
	Link2,
	type LucideIcon,
	MailCheck,
	Network,
	PanelRightClose,
	Pencil,
	Pin,
	PinOff,
	Rows2,
	Smile,
	Trash2,
	Unlink,
	X,
} from "lucide-react";
import type { SessionPortProcess } from "../../../../shared/rpc-types";
import { type KeymapPlatform, PLATFORM } from "../../../lib/keymap";
import type { ContextMenuItem, MenuSelectModifiers } from "../../common";

/** The most ports a row's menu lists: a session with more names them in the row's tooltip. */
const MENU_PORTS = 6;
/** What is true of the row; every list answers these the same way. */
export interface SessionMenuFacts {
	/** The session has a file on its computer (not a tab's row before its first write): its edits and delete apply. */
	stored: boolean;
	/** A tab of this window holds the session. */
	hasTab: boolean;
	/** That tab's turn runs, or the session waits on the person: no close and no delete. */
	busy: boolean;
	/** That tab is the focused one. */
	tabFocused: boolean;
	/** That tab is a pane of the split on screen. */
	tabInSplit: boolean;
	/** A split is on screen. */
	splitShown: boolean;
	/** That tab carries the done mark (`unreadDone`). */
	unread: boolean;
	/** Closing the tab leaves another one in the window. */
	canCloseTab: boolean;
	/** A chat: it lives in no project, so it cannot move to one. */
	chat: boolean;
	pinned: boolean;
	/** Its notifications are muted (this computer's sessions only). */
	muted: boolean;
	archived: boolean;
	agentHidden: boolean;
	canMoveUp: boolean;
	canMoveDown: boolean;
	/** What the open tab's processes listen on (`stores/session-ports.ts`); [] without a tab or an answer. */
	ports?: readonly SessionPortProcess[];
}

/** What the list can do with a session; an absent action leaves its item out. */
export interface SessionMenuActions {
	/** A stored session no tab holds, opened in a new tab beside the focused one and split in. */
	openSplit?: () => void;
	openWindow?: () => void;
	/** The open tab, split in beside the focused one. */
	splitTab?: (placement: "right" | "bottom") => void;
	unsplit?: () => void;
	/** Gives the open tab the done mark again, as if it finished unseen. */
	markUnread?: () => void;
	closeTab?: () => void;
	rename?: () => void;
	/** Opens the dialog of the links attached to it, kept on the computer that runs it (a paired host's too). */
	links?: () => void;
	/** Pins it, or lets it go when pinned. */
	togglePin?: () => void;
	/** Mutes its notifications (banners and phone pushes), or lets them through again. */
	toggleMute?: () => void;
	moveUp?: () => void;
	moveDown?: () => void;
	/** Opens the list of projects it can go to. */
	moveToProject?: () => void;
	/** Opens Hand to a bot: a bot's home chat becomes its opener and is told what to do with it (bots only). */
	handToBot?: () => void;
	/** Archives it, or restores it when archived. */
	toggleArchive?: () => void;
	toggleAgentHidden?: () => void;
	/** Copies its title as the row shows it. */
	copyTitle?: () => void;
	/** Picks the session it nests under, by hand (Orca's parent picker). */
	setParent?: () => void;
	/** Lifts it out of the family it nests in, to a row of its own list. */
	removeParent?: () => void;
	/** Picks the emoji drawn before its title. */
	setEmoji?: () => void;
	reveal?: () => void;
	/** Saves the open tab's diagnostic bundle; `anonymized` when Option/Alt was held. */
	saveBundle?: (anonymized: boolean) => void;
	remove?: () => void;
	/** Opens a port of the open tab's processes in the Preview. */
	openPort?: (port: number) => void;
	/** Ends the process listening on a port. */
	stopPort?: (process: SessionPortProcess, port: number) => void;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface SessionMenuInput {
	facts: SessionMenuFacts;
	actions: SessionMenuActions;
	t: Translate;
	/** Say on the diagnostics item that Option/Alt anonymizes it: false on a touch screen, which has no such key. */
	altHint: boolean;
	/** The platform whose Alt key the hint names. */
	platform?: KeymapPlatform;
}

/** The item's hint: "⌥ anonymized" on macOS, "Alt anonymized" on Windows. */
function anonymizeHint(t: Translate, platform: KeymapPlatform): string {
	return t("diagnosticBundle.anonymizeHint", { key: platform === "mac" ? "⌥" : "Alt" });
}

export function sessionMenuItems({
	facts,
	actions,
	t,
	altHint,
	platform = PLATFORM,
}: SessionMenuInput): ContextMenuItem[] {
	const view: ContextMenuItem[] = [];
	// A session an open tab holds splits through the tab's own items below instead.
	if (actions.openSplit && facts.stored && !facts.hasTab)
		view.push({
			id: "session-open-split",
			label: t("sidebar.menu.openSplit"),
			icon: Columns2,
			onSelect: actions.openSplit,
		});
	if (actions.openWindow && facts.stored)
		view.push({
			id: "session-open-window",
			label: t("sidebar.openInNewWindow"),
			icon: ExternalLink,
			onSelect: actions.openWindow,
		});
	const { splitTab, unsplit, closeTab } = actions;
	if (facts.hasTab) {
		if (splitTab && !facts.tabFocused && !facts.tabInSplit)
			for (const placement of ["right", "bottom"] as const)
				view.push({
					id: `session-split-${placement}`,
					label: t(placement === "right" ? "tabs.menu.splitRight" : "tabs.menu.splitBottom"),
					icon: placement === "right" ? Columns2 : Rows2,
					onSelect: () => splitTab(placement),
				});
		if (unsplit && facts.splitShown)
			view.push({
				id: "session-unsplit",
				label: t("tabs.menu.removeSplit"),
				icon: PanelRightClose,
				onSelect: unsplit,
			});
		// A tab on screen is read the moment it is marked, so only one out of view takes the mark.
		if (actions.markUnread && !facts.tabFocused && !facts.tabInSplit && !facts.unread)
			view.push({
				id: "session-mark-unread",
				label: t("sidebar.menu.markUnread"),
				icon: MailCheck,
				onSelect: actions.markUnread,
			});
		if (closeTab && facts.canCloseTab)
			view.push({
				id: "session-close-tab",
				label: t("sidebar.menu.closeSession"),
				icon: X,
				disabled: facts.busy,
				disabledReason: t("sidebar.menu.taskRunning"),
				onSelect: closeTab,
			});
	}

	// The ports of the tab's processes: at most `MENU_PORTS` of them, each with its own process to stop.
	const ports: ContextMenuItem[] = [];
	if (facts.hasTab && (actions.openPort || actions.stopPort)) {
		const listed = (facts.ports ?? [])
			.flatMap(process => process.ports.map(port => ({ process, port })))
			.sort((a, b) => a.port - b.port)
			.slice(0, MENU_PORTS);
		for (const { process, port } of listed) {
			const { openPort, stopPort } = actions;
			if (openPort)
				ports.push({
					id: `session-port-open-${port}`,
					label: t("sidebar.ports.open", { port }),
					icon: Globe,
					onSelect: () => openPort(port),
				});
			if (stopPort)
				ports.push({
					id: `session-port-stop-${port}`,
					label: t("sidebar.ports.stop", { name: process.name, port }),
					icon: CircleStop,
					disabled: process.startedMs === undefined,
					disabledReason: t("sidebar.ports.stopUnknown"),
					onSelect: () => stopPort(process, port),
				});
		}
	}

	const edit: ContextMenuItem[] = [];
	if (facts.stored) {
		if (actions.rename)
			edit.push({ id: "session-rename", label: t("sidebar.rename"), icon: Pencil, onSelect: actions.rename });
		if (actions.links)
			edit.push({ id: "session-links", label: t("sidebar.menu.links"), icon: Link2, onSelect: actions.links });
		if (actions.togglePin)
			edit.push({
				id: "session-pin",
				label: facts.pinned ? t("sidebar.menu.unpin") : t("sidebar.menu.pin"),
				icon: facts.pinned ? PinOff : Pin,
				onSelect: actions.togglePin,
			});
		if (actions.toggleMute)
			edit.push({
				id: "session-mute",
				label: facts.muted ? t("sidebar.menu.unmute") : t("sidebar.menu.mute"),
				icon: facts.muted ? Bell : BellOff,
				onSelect: actions.toggleMute,
			});
		if (actions.moveUp)
			edit.push({
				id: "session-move-up",
				label: t("sidebar.menu.moveUp"),
				icon: ArrowUp,
				disabled: !facts.canMoveUp,
				onSelect: actions.moveUp,
			});
		if (actions.moveDown)
			edit.push({
				id: "session-move-down",
				label: t("sidebar.menu.moveDown"),
				icon: ArrowDown,
				disabled: !facts.canMoveDown,
				onSelect: actions.moveDown,
			});
		if (actions.moveToProject && !facts.chat)
			edit.push({
				id: "session-move",
				label: t("sidebar.menu.moveToProject"),
				icon: FolderInput,
				disabled: facts.hasTab,
				disabledReason: t("sidebar.moveOpenTab"),
				onSelect: actions.moveToProject,
			});
		if (actions.handToBot)
			edit.push({
				id: "session-hand-to-bot",
				label: t("bots.hand.menu"),
				icon: Bot,
				disabled: !facts.hasTab,
				disabledReason: t("bots.hand.openFirst"),
				onSelect: actions.handToBot,
			});
		if (actions.toggleArchive)
			edit.push(
				facts.archived && !facts.hasTab
					? {
							id: "session-restore",
							label: t("sidebar.menu.restore"),
							icon: ArchiveRestore,
							onSelect: actions.toggleArchive,
						}
					: {
							id: "session-archive",
							label: t("sidebar.menu.archive"),
							icon: Archive,
							disabled: facts.hasTab,
							disabledReason: t("sidebar.archiveOpenTab"),
							onSelect: actions.toggleArchive,
						},
			);
		if (actions.setEmoji)
			edit.push({ id: "session-emoji", label: t("sidebar.menu.emoji"), icon: Smile, onSelect: actions.setEmoji });
		if (actions.setParent && !facts.chat)
			edit.push({
				id: "session-parent",
				label: t("sidebar.menu.setParent"),
				icon: Network,
				onSelect: actions.setParent,
			});
		if (actions.removeParent)
			edit.push({
				id: "session-remove-parent",
				label: t("sidebar.menu.removeParent"),
				icon: Unlink,
				onSelect: actions.removeParent,
			});
	}
	if (actions.toggleAgentHidden)
		edit.push({
			id: "session-agent-hidden",
			label: facts.agentHidden ? t("sidebar.menu.showToAgents") : t("sidebar.menu.hideFromAgents"),
			icon: facts.agentHidden ? Eye : EyeOff,
			onSelect: actions.toggleAgentHidden,
		});

	const other: ContextMenuItem[] = [];
	if (facts.stored && actions.copyTitle)
		other.push({
			id: "session-copy-title",
			label: t("sidebar.menu.copyTitle"),
			icon: Copy,
			onSelect: actions.copyTitle,
		});
	if (facts.stored && actions.reveal)
		other.push({
			id: "session-reveal",
			label: t("sidebar.menu.reveal"),
			icon: FolderSearch,
			onSelect: actions.reveal,
		});

	// Stock's `/dump` runs in the tab's own omp: a session no tab holds has nothing to dump, so it has no item.
	const { saveBundle } = actions;
	const diagnostics: ContextMenuItem[] =
		saveBundle && facts.hasTab
			? [
					{
						id: "session-dump-bundle",
						label: t("diagnosticBundle.save"),
						icon: FileArchive,
						...(altHint ? { hint: anonymizeHint(t, platform) } : {}),
						onSelect: (modifiers?: MenuSelectModifiers) => saveBundle(modifiers?.altKey === true),
					},
				]
			: [];

	const remove: ContextMenuItem[] =
		facts.stored && actions.remove
			? [
					{
						id: "session-delete",
						label: t("common.delete"),
						icon: Trash2,
						danger: true,
						disabled: facts.busy,
						disabledReason: t("sidebar.menu.taskRunning"),
						onSelect: actions.remove,
					},
				]
			: [];

	return [view, ports, edit, other, diagnostics, remove]
		.filter(group => group.length > 0)
		.flatMap(group => group.map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item)));
}

/** What a menu over several picked rows can do with them all; an absent action leaves its item out. */
export interface PickedMenuInput {
	count: number;
	/** The picked rows no tab holds: only those archive (a held session cannot, as on its own menu). */
	archivable: number;
	/** Every picked row is archived: the item restores them. */
	archived: boolean;
	actions: { toggleArchive?: () => void; remove?: () => void };
	t: Translate;
}

/**
 * The menu of a picked row while several are picked (Orca's batch menu, workspace-batch-action-labels.ts:21):
 * Archive or Restore them, then Delete them, last and in the danger colour.
 */
export function pickedMenuItems({ count, archivable, archived, actions, t }: PickedMenuInput): ContextMenuItem[] {
	const items: ContextMenuItem[] = [];
	if (actions.toggleArchive)
		items.push(
			archived
				? {
						id: "picked-restore",
						label: t("sidebar.menu.restoreCount", { count }),
						icon: ArchiveRestore,
						onSelect: actions.toggleArchive,
					}
				: {
						id: "picked-archive",
						label: t("sidebar.menu.archiveCount", { count: archivable }),
						icon: Archive,
						disabled: archivable === 0,
						disabledReason: t("sidebar.archiveOpenTab"),
						onSelect: actions.toggleArchive,
					},
		);
	if (actions.remove)
		items.push({
			id: "picked-delete",
			separatorBefore: true,
			label: t("sidebar.menu.deleteCount", { count }),
			icon: Trash2,
			danger: true,
			onSelect: actions.remove,
		});
	return items;
}

/** One action a phone swipe uncovers (`SwipeActions`' shape). */
export interface SwipeItem {
	id: string;
	label: string;
	icon: LucideIcon;
	tone?: "accent";
	onSelect: () => void;
}

/**
 * What a phone swipe uncovers on a row, taken from the row's own menu (Orca MobileAgentListRows.tsx:209): Mark as
 * unread behind a swipe right, Archive or Restore behind a swipe left, each only when the row's menu offers it enabled.
 */
export function sessionSwipeItems(items: readonly ContextMenuItem[]): { leading?: SwipeItem; trailing: SwipeItem[] } {
	const take = (...ids: string[]): SwipeItem | undefined => {
		const item = items.find(entry => ids.includes(entry.id) && !entry.disabled);
		if (!item?.icon) return undefined;
		const { onSelect } = item;
		return { id: item.id, label: item.label, icon: item.icon, onSelect: () => onSelect() };
	};
	const leading = take("session-mark-unread");
	const archive = take("session-archive", "session-restore");
	return { ...(leading ? { leading: { ...leading, tone: "accent" } } : {}), trailing: archive ? [archive] : [] };
}
