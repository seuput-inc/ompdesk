import { isUnsavedSession, unsavedSessionKey } from "../../shared/session-summary";
import { openBotPage } from "../components/bots/bot-page";
import { type ExtensionUiStore, useExtensionUiStore } from "../stores/extension-ui";
import { focusedSessionRuntime, sessionRuntimeStore } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";
import { toast } from "../stores/toast";
import { useUiStore } from "../stores/ui";
import { translate } from "./i18n";
import type { QuestionRow } from "./question-inbox";

/** The builder orders projects, askers, then oldest known ask. This projection preserves that order. */
export function groupQuestions(rows: readonly QuestionRow[]) {
	const projects = new Map<
		string,
		{ project: string; askers: Map<string, { key: string; asker: string; rows: QuestionRow[] }> }
	>();
	for (const row of rows) {
		const session = "session" in row ? row.session : undefined;
		const folder = session?.cwd ?? row.bot?.folder ?? "";
		const projectKey = JSON.stringify([row.device, folder]);
		let project = projects.get(projectKey);
		if (!project) {
			project = { project: row.project, askers: new Map() };
			projects.set(projectKey, project);
		}
		const botId = row.bot?.id ?? (row.source === "item" ? row.item.bot : undefined);
		const key = JSON.stringify([row.device, botId ? "bot" : "session", botId ?? session?.sessionPath]);
		let group = project.askers.get(key);
		if (!group) {
			group = { key, asker: row.asker, rows: [] };
			project.askers.set(key, group);
		}
		group.rows.push(row);
	}
	return Array.from(projects, ([key, { project, askers }]) => ({ key, project, askers: [...askers.values()] }));
}

export async function openInboxRow(row: QuestionRow): Promise<void> {
	if (row.source === "item" || row.source === "access") {
		if (row.source === "access") openBotPage(row.bot.id, "activity");
		else {
			// Keep the item page and its draft/answer code out of the first-screen badge.
			const { showBotItem } = await import("../components/bots/items/item-place");
			showBotItem({ id: row.item.bot, device: row.device }, row.item.id);
		}
		return;
	}
	const { session, device } = row;
	const tabs = useTabsStore.getState();
	if (row.localTabId && row.requestId) {
		const store =
			sessionRuntimeStore<ExtensionUiStore>(row.localTabId, "extensionUi") ??
			(row.localTabId === tabs.activeTabId && !focusedSessionRuntime() ? useExtensionUiStore : null);
		store?.setState({ selectedRequestId: row.requestId });
		useUiStore.getState().closeDestination();
		await tabs.switchTab(row.localTabId);
		return;
	}
	const tab = tabs.tabs.find(
		entry => entry.device === device && (entry.sessionPath ?? unsavedSessionKey(entry.id)) === session.sessionPath,
	);
	if (!tab && isUnsavedSession(session)) {
		toast({ variant: "warning", message: translate("inbox.unsaved") });
		return;
	}
	useUiStore.getState().closeDestination();
	const tabId =
		tab?.id ??
		(await tabs.openTab({ sessionPath: session.sessionPath, cwd: session.cwd, kind: session.kind, device }));
	if (tab) await tabs.switchTab(tab.id);
	if (row.requestId && tabId)
		sessionRuntimeStore<ExtensionUiStore>(tabId, "extensionUi")?.setState({ selectedRequestId: row.requestId });
}
