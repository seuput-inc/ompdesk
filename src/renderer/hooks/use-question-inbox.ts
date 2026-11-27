import { useEffect, useMemo } from "react";
import { unsavedSessionKey } from "../../shared/session-summary";
import { useSchedulesOf } from "../components/bots/bot-automations";
import { useT } from "../lib/i18n";
import { useMinuteTick } from "../lib/now-tick";
import { type QuestionRow, questionRows } from "../lib/question-inbox";
import { ensureBots, useBotsStore } from "../stores/bots";
import { useExtensionUiStore } from "../stores/extension-ui";
import { summariesOf, useHostedSessionsStore } from "../stores/hosted-sessions";
import { usePairedHosts } from "../stores/remote";
import { useRuntimeTabId } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";

export function useQuestionInbox(): QuestionRow[] {
	const t = useT();
	const runtimeTabId = useRuntimeTabId();
	const tabId = useTabsStore(s => runtimeTabId ?? s.activeTabId);
	const tab = useTabsStore(s => s.tabs.find(entry => entry.id === tabId));
	const pendingRequests = useExtensionUiStore(s => s.pendingRequests);
	const loginRequestIds = useExtensionUiStore(s => s.loginRequestIds);
	const arrivedAt = useExtensionUiStore(s => s.arrivedAt);
	const state = useBotsStore(s => s.state);
	useEffect(ensureBots, []);
	const schedules = useSchedulesOf(
		undefined,
		state.bots.some(bot => !bot.device),
	);
	const summaries = useHostedSessionsStore(s => s.summaries);
	const hosts = usePairedHosts();
	const computers = useMemo(
		() => [
			{ summaries: summariesOf({ summaries }, undefined) },
			...hosts
				.filter(host => host.state === "online")
				.map(host => ({
					device: host.deviceId,
					name: host.name,
					summaries: summariesOf({ summaries }, host.deviceId),
				})),
		],
		[hosts, summaries],
	);
	const minute = useMinuteTick(
		state.items.some(item => item.snoozedUntil !== undefined && Date.parse(item.snoozedUntil) > Date.now()),
	);
	return useMemo(
		() =>
			questionRows(
				state,
				computers,
				schedules,
				Math.max(minute, Date.now()),
				t,
				tabId ? { tabId, tab, pendingRequests, loginRequestIds, arrivedAt } : undefined,
			),
		[state, computers, schedules, minute, t, tabId, tab, pendingRequests, loginRequestIds, arrivedAt],
	);
}

/** The needs listed in this session, distinct from the board's existing waiting-child rows. */
export function useSessionQuestions(tabId: string | null): QuestionRow[] {
	const rows = useQuestionInbox();
	const tab = useTabsStore(state => state.tabs.find(entry => entry.id === tabId));
	return useMemo(
		() =>
			rows.filter(row => {
				if ("session" in row && row.localTabId) return row.localTabId === tabId;
				if (!tab || row.device !== tab.device) return false;
				const path = tab.sessionPath ?? unsavedSessionKey(tab.id);
				if (row.source === "item") return row.item.session === path;
				if (row.source === "access") return row.bot.home === path;
				return row.session.sessionPath === path;
			}),
		[rows, tab, tabId],
	);
}
