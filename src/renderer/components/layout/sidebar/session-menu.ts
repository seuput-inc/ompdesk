/**
 * The one session-row menu, for this computer's list (Sidebar.tsx) and a paired host's (SidebarDevices.tsx): the
 * list gathers the row's facts and the actions it supports, and this decides what the menu holds and in what order.
 * An action the list does not support is absent, never a disabled item (a host has no "Show in folder"); an item the
 * list supports but this row cannot take right now is disabled with its reason (Move to project… while a tab holds
 * the session).
 *
 * Groups, each set apart: open and view (split, new window, the open tab's split, mark as unread and close) · edit
 * (rename, pin, mute notifications, move up and down, move to project, archive, hide from agents) · show in folder ·
 * diagnostics (one item; Option/Alt while choosing it saves the anonymized bundle) · delete, last. Clicking a row
 * already opens it, so the menu has no "Open" or "Open in new tab".
 */
import {
	Archive,
	ArchiveRestore,
	ArrowDown,
	ArrowUp,
	Bell,
	BellOff,
	Bot,
	Columns2,
	Copy,
	ExternalLink,
	Eye,
	EyeOff,
	FileArchive,
	FolderInput,
	FolderSearch,
	Link2,
	MailCheck,
	PanelRightClose,
	Pencil,
	Pin,
	PinOff,
	Rows2,
	Trash2,
	X,
} from "lucide-react";
import { type KeymapPlatform, PLATFORM } from "../../../lib/keymap";
import type { ContextMenuItem, MenuSelectModifiers } from "../../common";

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
	reveal?: () => void;
	/** Saves the open tab's diagnostic bundle; `anonymized` when Option/Alt was held. */
	saveBundle?: (anonymized: boolean) => void;
	remove?: () => void;
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

	return [view, edit, other, diagnostics, remove]
		.filter(group => group.length > 0)
		.flatMap(group => group.map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item)));
}
