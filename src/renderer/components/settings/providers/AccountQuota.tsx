/**
 * What one subscription account's row says about its quota, shared by every list of accounts: Settings › Models &
 * accounts (ProviderAccounts.tsx) and the sidebar's usage block (layout/sidebar/SidebarUsage.tsx), both drawn as
 * `ConnectedRow`s under a `ProviderGroupItem`. An account is read through {@link AccountQuotaSource}, which a stored
 * account (`ProviderAccount`) and a usage report (`UsageReport`, mapped by the sidebar) both give, so the gauges, the
 * reset beneath each, the tooltip and the state marks are one implementation.
 */

import type { AccountCredits, AccountUsageState, UsageLimit } from "../../../../shared/rpc-types";
import { formatClock, formatCredits, formatSpan } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { accountGauges, usedShare } from "../../../lib/usage-windows";
import { Badge, NEAR_FRACTION, Tooltip, UsageGauges, usageTooltip } from "../../common";
import { bareEmail } from "../../layout/AccountLimit";

/** What a row needs of an account to say its quota and state. */
export interface AccountQuotaSource {
	limits: readonly UsageLimit[];
	/** Unused share of the tightest window, for an account that reports no window of its own. */
	remainingFraction?: number;
	/** When stock last read the quota, epoch ms. */
	fetchedAt?: number;
	/** This tab's session is pinned to the account. */
	inUse?: boolean;
	state?: AccountUsageState;
	/** While omp skips the account after it hit a limit: when it is tried again. */
	limitedUntil?: number;
}

/**
 * The windows the row gauges: the report's limits, else (an account that only reports what is left of its quota)
 * one window holding the share used.
 */
export function quotaLimits(account: Pick<AccountQuotaSource, "limits" | "remainingFraction">): UsageLimit[] {
	if (account.limits.some(limit => usedShare(limit) !== null)) return [...account.limits];
	if (account.remainingFraction === undefined) return [];
	return [{ id: "quota", label: "Quota", windowId: "quota", usedFraction: 1 - account.remainingFraction }];
}

/** The compact panel rounds the visible figure but names the amount and its unit in full. */
export function CreditsFigure({ credits, compact }: { credits: AccountCredits; compact?: "column" | "line" }) {
	const t = useT();
	const left =
		credits.kind === "unlimited"
			? t("providers.accounts.creditsUnlimited")
			: formatCredits(credits.remaining, credits.unit, compact && "compact");
	const exact =
		compact && credits.kind !== "unlimited" ? formatCredits(credits.remaining, credits.unit, "exact") : left;
	const what =
		credits.kind === "monthlyCap"
			? t("providers.accounts.creditsMonthlyCap", {
					left: exact,
					limit: formatCredits(credits.limit, credits.unit, compact && "exact"),
				})
			: credits.kind === "unlimited"
				? t("providers.accounts.creditsUnlimitedWhat")
				: t("providers.accounts.creditsBalance", { left: exact });
	return (
		<Tooltip content={what} describe={!compact}>
			<Badge
				aria-label={compact ? what : undefined}
				data-account-credits={credits.kind}
				role={compact ? "img" : undefined}
				size="xs"
				tabIndex={compact ? 0 : undefined}
				variant="muted"
			>
				{compact !== "column" && t("providers.accounts.credits")}
				<span className="text-(--sc-text-secondary) tabular-nums">{left}</span>
			</Badge>
		</Tooltip>
	);
}

/**
 * What a row names each account by: the bare address, and the label's parenthetical ("team", "pro") muted after it only
 * where another account of the provider shares that address, so two logins with one email are told apart.
 */
export function accountNames(labels: readonly string[]): { address: string; suffix?: string }[] {
	const addresses = labels.map(bareEmail);
	return labels.map((label, index) => {
		const address = addresses[index] ?? label;
		const shared = addresses.filter(other => other === address).length > 1;
		const suffix = shared ? /\(([^)]*)\)\s*$/.exec(label.trim())?.[1]?.trim() : undefined;
		return suffix ? { address, suffix } : { address };
	});
}

/**
 * The account's windows as shared gauges (share used, reset beneath each), each in its column of the provider's
 * set, on the track count the whole list shares; the tooltip lists every window and the read's age.
 */
export function QuotaCell({
	account,
	columns,
	tracks,
	compact = false,
	now,
}: {
	account: AccountQuotaSource;
	columns: readonly UsageLimit[];
	tracks: number;
	/** Slim bars with small type (`UsageGauges compact`): the sidebar's width. */
	compact?: boolean;
	now: number;
}) {
	const t = useT();
	const limits = quotaLimits(account);
	if (accountGauges(limits).length === 0) return null;
	const title = [
		usageTooltip({ provider: "", fetchedAt: account.fetchedAt ?? 0, limits }, "", t)
			.split("\n")
			.slice(1)
			.join("\n"),
		account.fetchedAt === undefined ? null : t("usage.updatedAgo", { time: formatSpan(now - account.fetchedAt) }),
	]
		.filter(Boolean)
		.join("\n");
	return (
		<div
			data-quota-updated={account.fetchedAt === undefined ? undefined : formatClock(account.fetchedAt)}
			title={title}
		>
			<UsageGauges
				columns={columns}
				compact={compact}
				limits={limits}
				resets
				sharedLabels={compact}
				tracks={tracks}
			/>
		</div>
	);
}

/** In use, and what no gauge of the row says: skipped after a limit, or low, with no window at or near its end. */
export function AccountBadges({ account }: { account: AccountQuotaSource }) {
	const t = useT();
	const gauges = accountGauges(quotaLimits(account));
	return (
		<>
			{account.inUse && <Badge variant="success">{t("providers.accounts.inUse")}</Badge>}
			{account.state === "depleted" && !gauges.some(gauge => gauge.fraction >= 1) && (
				<Badge variant="warning">
					{account.limitedUntil !== undefined
						? t("providers.accounts.limitedUntil", { time: formatClock(account.limitedUntil) })
						: t("providers.accounts.limited")}
				</Badge>
			)}
			{account.state === "reserve" && !gauges.some(gauge => gauge.fraction >= NEAR_FRACTION) && (
				<Badge variant="warning">{t("providers.accounts.low")}</Badge>
			)}
		</>
	);
}
