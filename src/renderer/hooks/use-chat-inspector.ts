import { useLayoutEffect, useRef } from "react";
import { useBotsAvailable } from "../lib/bots-source";
import { botOfFolder, botOfSession, useBotsStore } from "../stores/bots";
import { useTabsStore } from "../stores/tabs";
import { type PanelView, useUiStore } from "../stores/ui";

export function useInspectorBot() {
	const enabled = useBotsAvailable();
	const pinned = useUiStore(s => (s.fileEditDirty ? s.fileEditTabId : null));
	const tab = useTabsStore(s => s.tabs.find(tab => tab.id === (pinned ?? s.activeTabId)));
	return useBotsStore(s =>
		enabled && tab
			? (botOfSession(s.state.bots, tab.sessionPath, tab.device) ?? botOfFolder(s.state.bots, tab.cwd, tab.device))
			: undefined,
	);
}

/** The shell stays mounted when the panel is closed. Keep its view and fold for each bot, apart from ordinary chats. */
export function useChatInspector(compact: boolean) {
	const bot = useInspectorBot();
	const key = bot ? `${bot.device ?? ""}\u0000${bot.id}` : "";
	const dirty = useUiStore(s => s.fileEditDirty);
	const previous = useRef("");
	const choices = useRef(new Map<string, { panelTab: PanelView; panelVisible: boolean }>());
	useLayoutEffect(() => {
		if (dirty || key === previous.current) return;
		const { panelTab, panelVisible } = useUiStore.getState();
		choices.current.set(previous.current, {
			panelTab: panelTab === "subagent" ? (previous.current ? "bot-home" : "files") : panelTab,
			panelVisible,
		});
		previous.current = key;
		useUiStore.setState(choices.current.get(key) ?? { panelTab: key ? "bot-home" : "files", panelVisible: !compact });
	}, [key, dirty, compact]);
}
