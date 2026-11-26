/**
 * The close-a-tab rules, shared by ⌘W, File → Close Tab and the sidebar menu.
 *
 * A tab whose run is live dies with its close, so the first ⌘W only arms it
 * (a toast says to press again); a worktree-bound tab detours to the cleanup
 * prompt (plan/20) instead of orphaning the checkout — except one omp's
 * `worktree.onStart` made, whose close applies `worktree.onExit` in main
 * (src/main/worktree-lifecycle.ts, which asks when stock asks); and at the
 * single-tab floor there is no tab left to close, so ⌘W closes the window.
 * A tab whose session holds unsent review notes (`stores/review-notes.ts`) is armed the same way first, so a close
 * never drops them unasked (Orca's `pinned-tab-close-guard.ts` `unsentNotes`); a session's notes come back with it, a
 * tab that never had a session loses them, and its close clears them.
 */

import { notesOf, notesOwner, useReviewNotesStore } from "../stores/review-notes";
import { useSessionStore } from "../stores/session";
import { type SessionTab, useTabsStore } from "../stores/tabs";
import { toast } from "../stores/toast";
import { useUiStore } from "../stores/ui";
import { translate } from "./i18n";
import { tabSignalPresentation } from "./tab-signal";

/** The ids of the review notes `tab`'s session has not sent. */
function unsentNotes(tab: SessionTab): string[] {
	return notesOf(useReviewNotesStore.getState().notes, notesOwner(tab)).map(note => note.id);
}

/** Foreground knowledge the pool's status pushes lag behind: the active tab's
 *  own stream, which only the renderer sees the instant it starts. */
export interface LiveTabRuntime {
	activeTabId: string | null;
	streaming: boolean;
	compacting: boolean;
}

/** True when closing this tab destroys work, so the close needs a confirmation. */
export function tabNeedsCloseConfirm(tab: SessionTab, live: LiveTabRuntime): boolean {
	const activeRuntime = tab.id === live.activeTabId && (live.streaming || live.compacting);
	return tabSignalPresentation(tab, activeRuntime).running || tab.status === "starting";
}

/** What a close request ended up doing. `"window"` = the last tab, so ⌘W closed
 *  its window instead. */
export type TabCloseOutcome = "closed" | "worktree-prompt" | "armed" | "window" | "nothing";

/** Execute a close the user already committed to (chip ✓, or ⌘W on an armed tab). */
export function performTabClose(tab: SessionTab): TabCloseOutcome {
	const ui = useUiStore.getState();
	ui.cancelCloseTab();
	if (tab.worktree && !tab.worktree.lifecycle) {
		ui.openWorktreeClosePrompt(tab.id);
		return "worktree-prompt";
	}
	const drop = tab.sessionId ? [] : unsentNotes(tab);
	void useTabsStore
		.getState()
		.closeTab(tab.id)
		.then(() => {
			if (drop.length > 0 && !useTabsStore.getState().tabs.some(entry => entry.id === tab.id))
				useReviewNotesStore.getState().remove(drop);
		});
	return "closed";
}

/** ⌘W / File → Close Tab: close the active tab under the shared rules. */
export function closeActiveTab(): TabCloseOutcome {
	const { tabs, activeTabId } = useTabsStore.getState();
	const session = useSessionStore.getState();
	const target = tabs.find(tab => tab.id === activeTabId);
	if (!target) return "nothing";
	if (tabs.length <= 1) {
		window.close();
		return "window";
	}
	const live: LiveTabRuntime = {
		activeTabId,
		streaming: session.isStreaming,
		compacting: session.isCompacting,
	};
	const ui = useUiStore.getState();
	if (tabNeedsCloseConfirm(target, live) && ui.armedCloseTab?.tabId !== target.id) {
		ui.armCloseTab(target.id);
		toast({ variant: "warning", message: translate("tabs.confirmClose") });
		return "armed";
	}
	const notes = unsentNotes(target).length;
	if (notes > 0 && ui.armedCloseTab?.tabId !== target.id) {
		ui.armCloseTab(target.id);
		toast({
			variant: "warning",
			message: translate(target.sessionId ? "reviewNotes.closeKeeps" : "reviewNotes.closeDrops", { count: notes }),
		});
		return "armed";
	}
	return performTabClose(target);
}

/**
 * "Close other tabs": focus `keepId`, then close every other tab that can go
 * without asking. A live run or a worktree checkout needs its own decision, so
 * those tabs stay open; returns how many stayed.
 */
export async function closeOtherTabs(keepId: string): Promise<number> {
	const store = useTabsStore.getState();
	if (!store.tabs.some(tab => tab.id === keepId)) return 0;
	const session = useSessionStore.getState();
	const live: LiveTabRuntime = {
		activeTabId: store.activeTabId,
		streaming: session.isStreaming,
		compacting: session.isCompacting,
	};
	const others = store.tabs.filter(tab => tab.id !== keepId);
	const closable = others.filter(
		tab =>
			!tabNeedsCloseConfirm(tab, live) &&
			!(tab.worktree && !tab.worktree.lifecycle) &&
			unsentNotes(tab).length === 0,
	);
	if (store.activeTabId !== keepId) await store.switchTab(keepId);
	for (const tab of closable) await useTabsStore.getState().closeTab(tab.id);
	return others.length - closable.length;
}
