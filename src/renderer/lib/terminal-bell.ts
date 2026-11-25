/**
 * A terminal's bell (xterm `onBell`, BEL from the shell) while nobody sees the terminal gives its tab the done mark,
 * the ✓ an unseen finish leaves: no OS notification, no sound. The terminal panel draws only the focused tab's
 * terminals, so "off screen" is the page being hidden (a minimized window, a phone page in the background), or the
 * tab no longer shown when the bell's output is parsed. A muted project's terminal (this computer's projects,
 * `isMutedFolder`) never marks.
 */
import { isMutedFolder } from "../../shared/sidebar-prefs";
import { useSidebarPrefs } from "../stores/sidebar-prefs";
import { useSidebarProjects } from "../stores/sidebar-projects";
import { useTabsStore, visibleTabIds } from "../stores/tabs";
import { LOCAL_DEVICE } from "./sidebar-memory";

export function bellMarks({ shown, pageHidden, muted }: { shown: boolean; pageHidden: boolean; muted: boolean }) {
	return !muted && (pageHidden || !shown);
}

export function markTabOnBell(tabId: string): void {
	const tabs = useTabsStore.getState();
	const tab = tabs.tabs.find(entry => entry.id === tabId);
	if (!tab) return;
	const muted =
		tab.device === undefined &&
		isMutedFolder(
			useSidebarPrefs.getState().mutedGroups,
			useSidebarProjects.getState().lists[LOCAL_DEVICE]?.worktrees ?? {},
			tab.cwd,
		);
	const marks = bellMarks({
		shown: visibleTabIds(tabs).includes(tabId),
		pageHidden: document.visibilityState === "hidden",
		muted,
	});
	if (!marks) return;
	tabs.markUnread(tabId);
	// The tab is on screen once the page is back: seeing it there reads the mark, as switching to it would.
	if (visibleTabIds(tabs).includes(tabId)) {
		const read = () => {
			if (document.visibilityState === "hidden") return;
			document.removeEventListener("visibilitychange", read);
			const now = useTabsStore.getState();
			if (visibleTabIds(now).includes(tabId))
				useTabsStore.setState({
					tabs: now.tabs.map(entry => (entry.id === tabId ? { ...entry, unreadDone: false } : entry)),
				});
		};
		document.addEventListener("visibilitychange", read);
	}
}
