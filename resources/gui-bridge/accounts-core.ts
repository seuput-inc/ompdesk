/** GUI reconciliation around stock reportMatchesActiveAccount. */
export interface StoredAccount {
	credentialId: number;
	email?: string;
	accountId?: string;
	projectId?: string;
	orgId?: string;
	orgName?: string;
	active: boolean;
	/** Last use recorded on this session's pin; only on the `active` account. */
	lastUsedAtMs?: number;
}

/**
 * The stored account a report belongs to, or none when that is not certain. `reportAccountId` is the report's own
 * account id (`metadata.accountId`): stock matches by email first, so two logins of one email (a ChatGPT Pro seat and
 * the same person's Team seat) both match each other's report, and only the account id tells them apart.
 */
export function matchReportAccount<T>(
	report: T,
	accounts: readonly StoredAccount[],
	providerReportCount: number,
	matches: (report: T, account: StoredAccount) => boolean,
	reportAccountId?: string,
): StoredAccount | undefined {
	const candidates = accounts.filter(account => matches(report, account));
	// Stock reportMatchesActiveAccount answers per identity; GUI attribution must be unique.
	if (candidates.length === 1) return candidates[0];
	if (candidates.length > 1 && reportAccountId) {
		const same = candidates.filter(account => account.accountId === reportAccountId);
		return same.length === 1 ? same[0] : undefined;
	}
	// Stock has no report-to-credential reconciliation: one account / one report is unambiguous.
	if (candidates.length === 0 && accounts.length === 1 && providerReportCount === 1) return accounts[0];
	return undefined;
}
