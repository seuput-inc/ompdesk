/**
 * The sidebar usage block's grouping of usage reports. Kept beside `SidebarUsage` and out of `lib/usage-reports.ts`,
 * which the first screen loads: this is only the sidebar's, so it goes with the session list's chunk and costs the
 * phone's first screen nothing (scripts/check-main-bundle.ts).
 */
import type { UsageReport } from "../../../../shared/rpc-types";
import { usedShare } from "../../../lib/usage-windows";
import { providerBrand } from "../../settings/providers/provider-marks";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** One account of a provider in a list of every account. */
export interface UsageAccount {
	report: UsageReport;
	/** This tab's session is pinned to this account (`report.active`). */
	inUse: boolean;
}

/** One provider's accounts, each with its windows. */
export interface UsageAccountGroup {
	provider: string;
	accounts: UsageAccount[];
	/** This tab's model belongs to the provider, or one of its accounts is the session's. */
	inUse: boolean;
}

/** Stock can include the same balance in both its limits and its account credits. */
export function usageWindowLimits({ credits, limits }: UsageReport) {
	return credits ? limits.filter(limit => limit.id !== credits.limitId) : limits;
}

/**
 * Accounts with measured windows or credits, grouped by provider. The percentage summary only includes accounts
 * with windows. The provider this tab uses comes first, the others by company; accounts stay ordered by address.
 */
export function usageAccountGroups(
	reports: readonly UsageReport[],
	provider: string | null | undefined,
	includeCreditOnly = true,
): UsageAccountGroup[] {
	const byProvider = new Map<string, UsageReport[]>();
	for (const report of reports) {
		if (
			!(includeCreditOnly && report.credits) &&
			!usageWindowLimits(report).some(limit => usedShare(limit) !== null)
		) {
			continue;
		}
		byProvider.set(report.provider, [...(byProvider.get(report.provider) ?? []), report]);
	}
	return [...byProvider.entries()]
		.map(([id, own]) => {
			const accounts = [...own]
				.sort(
					(a, b) =>
						collator.compare(a.account ?? "", b.account ?? "") || (a.credentialId ?? 0) - (b.credentialId ?? 0),
				)
				.map(report => ({ report, inUse: report.active === true }));
			return {
				provider: id,
				accounts,
				inUse: id === provider || accounts.some(account => account.inUse),
				company: providerBrand({ id, name: id }).company,
			};
		})
		.sort(
			(a, b) =>
				Number(b.inUse) - Number(a.inUse) ||
				collator.compare(a.company, b.company) ||
				collator.compare(a.provider, b.provider),
		)
		.map(({ provider: id, accounts, inUse }) => ({ provider: id, accounts, inUse }));
}
