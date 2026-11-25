import { useEffect, useRef } from "react";
import type { StoreApi } from "zustand/vanilla";
import { createTabRpc } from "../lib/tab-rpc";
import type { ComposerStore } from "../stores/composer";
import { sessionRuntime, sessionRuntimeStore } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";

interface Watch {
	/** The session and composer store this watch reports for. */
	sessionId: string;
	store: StoreApi<ComposerStore>;
	unsubscribe: () => void;
}

/**
 * Tells each tab's bridge whether its composer draft is empty (idle compaction, the
 * idle recap and the built-in prompt suggestions all need it). Stock's idle scheduler
 * (opted in by resources/gui-bridge/idle-maintenance.ts) holds back while the input
 * holds text, as the terminal UI does with its editor;
 * the bridge cannot see the GUI draft, so this reports every empty ⇄ non-empty
 * change, and the current state again once a tab's session is ready (a new tab,
 * a restarted omp, a switched session). Mounted once, by App.
 */
export function useIdleCompactionDraft(): void {
	const tabs = useTabsStore(state => state.tabs);
	const watches = useRef(new Map<string, Watch>());

	useEffect(() => {
		const open = new Set<string>();
		for (const tab of tabs) {
			open.add(tab.id);
			const current = watches.current.get(tab.id);
			const runtime = sessionRuntime(tab.id);
			const store = sessionRuntimeStore<ComposerStore>(tab.id, "composer");
			const sessionId = tab.sessionId ?? "";
			if (tab.status !== "ready" || !runtime || !store) {
				// Its omp may be new once it is ready again: report afresh then.
				current?.unsubscribe();
				watches.current.delete(tab.id);
				continue;
			}
			if (current && current.sessionId === sessionId && current.store === store) continue;
			current?.unsubscribe();
			const rpc = createTabRpc(runtime.command);
			let reported: boolean | undefined;
			let inFlight = false;
			let live = true;
			// One report at a time: two calls in flight may reach omp in either order, and a
			// stale "non-empty" applied last held suggestions and idle compaction back.
			const report = () => {
				if (!live || inFlight) return;
				const empty = store.getState().draft.trim() === "";
				if (empty === reported) return;
				reported = empty;
				inFlight = true;
				void Promise.all([
					// An omp without the feature answers unsupported_omp; the health toast already says so.
					rpc.command({ type: "set_idle_compaction_draft", empty }).catch(() => {}),
					// The prompt suggestions' bridge aborts a pending suggestion once the draft turns non-empty.
					rpc.command({ type: "set_next_prompt_draft", empty }).catch(() => {}),
				]).then(() => {
					inFlight = false;
					report();
				});
			};
			report();
			const unsubscribe = store.subscribe(report);
			watches.current.set(tab.id, {
				sessionId,
				store,
				unsubscribe: () => {
					live = false;
					unsubscribe();
				},
			});
		}
		for (const [id, watch] of watches.current) {
			if (open.has(id)) continue;
			watch.unsubscribe();
			watches.current.delete(id);
		}
	}, [tabs]);

	useEffect(() => {
		const current = watches.current;
		return () => {
			for (const watch of current.values()) watch.unsubscribe();
			current.clear();
		};
	}, []);
}
