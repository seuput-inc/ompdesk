/**
 * A child's question in its opener's ask dock (after Orca's worker approvals, stablyai/orca
 * `components/worker-approvals/*`, MIT; re-implemented): while a session another session's agent opened waits on the
 * person and its tab is not on screen, its card shows above the opener's composer, marked with the child's name, and
 * the answer goes to the child's own request (its tab's `respondExtensionUi`, as if answered there). The opener's own
 * card comes first: a child's waits until it is answered. One child's card at a time, the first in tab order. Mounted
 * once per pane (`App.tsx`), inside the opener's runtime.
 */
import { useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { TabRuntimeProvider } from "../../lib/tab-runtime-provider";
import type { ExtensionUiStore } from "../../stores/extension-ui";
import { useExtensionUiStore } from "../../stores/extension-ui";
import { onSessionRuntimesChange, sessionRuntimeStore } from "../../stores/session-runtime-context";
import { useTabsStore, visibleTabIds } from "../../stores/tabs";
import { ForeignPrompt } from "./ask-dock";
import { ChildAskCard, isDialogRequest } from "./ExtensionDialog";

function asksFor(tabId: string): boolean {
	const store = sessionRuntimeStore<ExtensionUiStore>(tabId, "extensionUi")?.getState();
	return (
		store?.pendingRequests.some(req => isDialogRequest(req) && !Object.hasOwn(store.loginRequestIds, req.id)) ?? false
	);
}

/** The first of `tabIds` whose runtime holds an open card, followed as their stores change. */
function useFirstAsking(tabIds: readonly string[]): string | null {
	const key = tabIds.join("\u0000");
	const [asking, setAsking] = useState<string | null>(null);
	useEffect(() => {
		const ids = key ? key.split("\u0000") : [];
		let stops: (() => void)[] = [];
		const read = () => setAsking(ids.find(asksFor) ?? null);
		const attach = () => {
			for (const stop of stops) stop();
			stops = ids.flatMap(id => {
				const store = sessionRuntimeStore<ExtensionUiStore>(id, "extensionUi");
				return store ? [store.subscribe(read)] : [];
			});
			read();
		};
		attach();
		const offRegistry = onSessionRuntimesChange(attach);
		return () => {
			offRegistry();
			for (const stop of stops) stop();
		};
	}, [key]);
	return asking;
}

export function ChildAsks({ openerTabId }: { openerTabId: string }) {
	const t = useT();
	const ownCard = useExtensionUiStore(state => state.pendingRequests.some(isDialogRequest));
	const children = useTabsStore(state => {
		const shown = visibleTabIds(state);
		return state.tabs
			.filter(tab => tab.openedBy === openerTabId && !shown.includes(tab.id))
			.map(tab => tab.id)
			.join("\n");
	});
	const childIds = useMemo(() => (children ? children.split("\n") : []), [children]);
	const asking = useFirstAsking(childIds);
	const title = useTabsStore(state => {
		const tab = state.tabs.find(entry => entry.id === asking);
		return tab?.title || tab?.task || t("sidebar.untitled");
	});
	const foreign = useMemo(() => ({ dockTabId: openerTabId, from: title }), [openerTabId, title]);
	if (!asking || ownCard) return null;
	return (
		<ForeignPrompt.Provider value={foreign}>
			<TabRuntimeProvider tabId={asking}>
				<ChildAskCard />
			</TabRuntimeProvider>
		</ForeignPrompt.Provider>
	);
}
