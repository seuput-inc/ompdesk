/**
 * The menu of where handed text goes (Orca's `ReviewNotesSendMenuContent` targets): this session, each other open
 * session of the window, or a new session in this one's folder. Kept apart from `lib/composer-handoff.ts`, which the
 * composer loads on the phone's first screen.
 */
import { MessageSquarePlus, MessageSquareText, SquarePen } from "lucide-react";
import { useMemo } from "react";
import type { ComposerTarget } from "../../../lib/composer-handoff";
import { tabChipLabel, useTabsStore } from "../../../stores/tabs";
import type { ContextMenuItem } from "../../common";

export interface OpenSessionTarget {
	tabId: string;
	label: string;
}

/** The window's open sessions other than `currentTabId`, by their tab names, in the window's tab order. */
export function useOtherSessionTargets(currentTabId: string | null): OpenSessionTarget[] {
	const tabs = useTabsStore(state => state.tabs);
	return useMemo(
		() =>
			tabs
				.filter(tab => tab.id !== currentTabId && !tab.ghost)
				.map(tab => ({ tabId: tab.id, label: tabChipLabel(tab, tabs) })),
		[tabs, currentTabId],
	);
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The menu items: this session, each other open one, a new session in this one's folder. */
export function composerTargetItems(
	t: Translate,
	currentTabId: string | null,
	others: readonly OpenSessionTarget[],
	pick: (target: ComposerTarget) => void,
): ContextMenuItem[] {
	const items: ContextMenuItem[] = [];
	if (currentTabId)
		items.push({
			id: "this",
			label: t("composerTarget.this"),
			icon: SquarePen,
			onSelect: () => pick({ tabId: currentTabId }),
		});
	others.forEach((other, index) => {
		items.push({
			id: `tab:${other.tabId}`,
			label: other.label,
			icon: MessageSquareText,
			separatorBefore: index === 0 && items.length > 0,
			onSelect: () => pick({ tabId: other.tabId }),
		});
	});
	if (currentTabId)
		items.push({
			id: "new",
			label: t("composerTarget.newSession"),
			icon: MessageSquarePlus,
			separatorBefore: true,
			onSelect: () => pick({ newSessionFrom: currentTabId }),
		});
	return items;
}
