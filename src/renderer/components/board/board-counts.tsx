/**
 * The sidebar's All sessions entry figures (after Orca's dashboard entry, stablyai/orca
 * `components/dashboard/sidebar/AgentDashboardSidebarEntry.tsx`, MIT): sessions waiting on the person and sessions at
 * work, on this computer and every online paired computer, by the board's lane rule (`board-cards.ts`). From the
 * summaries alone: no session list is read for them, so the sidebar's first screen pays nothing for it.
 */
import { useMemo } from "react";
import type { VersionedSummaries } from "../../../shared/session-summary";
import { useT } from "../../lib/i18n";
import { sessionRun } from "../../lib/session-run";
import { LOCAL_SUMMARIES, useHostedSessionsStore } from "../../stores/hosted-sessions";
import { usePairedHosts } from "../../stores/remote";
import { type SessionTab, useTabsStore } from "../../stores/tabs";
import { Badge } from "../common";
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

/** The board entry's figures: sessions that need the person (attention) and sessions at work; nothing when none. */
export function BoardNavCounts() {
	const t = useT();
	const { needs, working } = useBoardCounts();
	if (needs === 0 && working === 0) return null;
	return (
		<span
			className="flex shrink-0 items-center gap-1"
			data-board-nav-counts
			title={t("board.nav.counts", { needs, working })}
		>
			<span className="sr-only">{t("board.nav.counts", { needs, working })}</span>
			{needs > 0 && (
				<Badge aria-hidden variant="attention">
					{needs}
				</Badge>
			)}
			{working > 0 && (
				<Badge aria-hidden variant="muted">
					{working}
				</Badge>
			)}
		</span>
	);
}
