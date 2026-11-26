/**
 * The provider account an open tab's session runs on, for its sidebar row's tooltip (Orca's session account,
 * right-sidebar/ai-vault/accounts/AiVaultSessionAccount.tsx). Read on demand when the pointer reaches the row: the
 * tab's own `get_usage` marks the account its session is pinned to (`UsageReport.active`). At most one read per tab
 * per {@link USAGE_POLL_MS}, through stock's cached reports, so hovering the list never probes a provider more often
 * than the usage poll does (lib/usage-reports.ts says why that matters). A stored session has no account until it runs.
 */
import { create } from "zustand";
import { readUsageReports, USAGE_POLL_MS } from "./usage-reports";

interface TabAccountsState {
	/** The accounts the tab's session is pinned to, by tab id; absent until read. */
	accounts: Record<string, readonly string[]>;
}

export const useTabAccounts = create<TabAccountsState>()(() => ({ accounts: {} }));

const readAt = new Map<string, number>();

/** The labels of the accounts a `get_usage` answer marks as this session's, each once. */
export function activeAccounts(reports: readonly { account?: string; active?: boolean }[]): string[] {
	return [...new Set(reports.flatMap(report => (report.active && report.account ? [report.account] : [])))];
}

/** Read the tab's account unless it was read within the usage poll's interval (or is being read). */
export function askTabAccount(tabId: string, now = Date.now()): void {
	const last = readAt.get(tabId);
	if (last !== undefined && now - last < USAGE_POLL_MS) return;
	readAt.set(tabId, now);
	window.omp.rpc.commandForTab(tabId, { type: "get_usage" }).then(
		response => {
			const read = readUsageReports(response);
			if (!read.ok) return;
			useTabAccounts.setState(state => ({
				accounts: { ...state.accounts, [tabId]: activeAccounts(read.reports) },
			}));
		},
		// The tooltip just goes without the account; the next hover after the interval tries again.
		() => {},
	);
}

/** Forget every read (tests). */
export function resetTabAccounts(): void {
	readAt.clear();
	useTabAccounts.setState({ accounts: {} });
}
