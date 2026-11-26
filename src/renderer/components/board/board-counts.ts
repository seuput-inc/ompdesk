/**
 * The sidebar's All sessions entry figures (after Orca's dashboard entry, stablyai/orca
 * `components/dashboard/sidebar/AgentDashboardSidebarEntry.tsx`, MIT): sessions waiting on the person and sessions at
 * work, on this computer and every online paired computer, by the board's lane rule (`board-cards.ts`). From the
 * summaries alone: no session list is read for them, so the sidebar's first screen pays nothing for it.
 */
import { useMemo } from "react";
import type { VersionedSummaries } from "../../../shared/session-summary";
import { sessionRun } from "../../lib/session-run";
import { LOCAL_SUMMARIES, useHostedSessionsStore } from "../../stores/hosted-sessions";
import { usePairedHosts } from "../../stores/remote";
import { type SessionTab, useTabsStore } from "../../stores/tabs";
import { workingAgentCount } from "../layout/live-work";

export interface BoardCounts {
	needs: number;
	working: number;
}

/** `computers`: the summaries' keys to count (this computer's and the online paired computers'). */
export function boardCountsOf(
	summaries: Readonly<Record<string, VersionedSummaries>>,
	tabs: readonly Pick<SessionTab, "sessionPath" | "device" | "unreadDone">[],
	computers: ReadonlySet<string>,
): BoardCounts {
	let needs = 0;
	let working = 0;
	for (const [device, held] of Object.entries(summaries)) {
		if (!computers.has(device)) continue;
		for (const summary of held.sessions) {
			const tab = tabs.find(
				tab => tab.sessionPath === summary.sessionPath && (tab.device ?? LOCAL_SUMMARIES) === device,
			);
			const run = sessionRun(summary, tab?.unreadDone === true);
			if (run.waiting) needs++;
			else if (run.running || workingAgentCount(summary.agents) > 0) working++;
		}
	}
	return { needs, working };
}

export function useBoardCounts(): BoardCounts {
	const summaries = useHostedSessionsStore(state => state.summaries);
	const tabs = useTabsStore(state => state.tabs);
	const hosts = usePairedHosts();
	return useMemo(
		() =>
			boardCountsOf(
				summaries,
				tabs,
				new Set([LOCAL_SUMMARIES, ...hosts.filter(host => host.state === "online").map(host => host.deviceId)]),
			),
		[summaries, tabs, hosts],
	);
}
