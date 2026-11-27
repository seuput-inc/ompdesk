import type { UsageLimit } from "../../shared/rpc-types";

/** The canonical window id, else the middle part of a stock limit id (`anthropic:5h` → `5h`). */
function windowKey(limit: UsageLimit): string {
	return limit.windowId ?? limit.id.split(":")[1] ?? "";
}

/** A window's length in hours from its canonical id, or Infinity for one stock made up. */
function windowHours(limit: UsageLimit): number {
	const id = windowKey(limit);
	const span = /^(\d+)([hd])$/.exec(id);
	if (span) return Number(span[1]) * (span[2] === "h" ? 1 : 24);
	if (id === "daily") return 24;
	if (id === "weekly" || id === "1w") return 168;
	if (id === "monthly") return 720;
	return Number.POSITIVE_INFINITY;
}

/** What follows the window in a model-scoped limit's id (`anthropic:7d:fable` → `fable`); empty for a whole-account window. */
function scopeId(limit: UsageLimit): string {
	return limit.id.split(":").slice(2).join(":");
}

/**
 * "5H", "7D", "Fable": a whole-account window's own short name (from its id, else the first word of its label), a
 * model-scoped one's model (its window is the whole-account gauge beside it).
 */
function windowHeading(limit: UsageLimit): string {
	// Stock names the model in the label's parenthetical ("Claude 7 Day (Fable)"); OMPdesk keeps no tier wording.
	const scope = scopeId(limit);
	if (scope) return /\(([^()]+)\)\s*$/.exec(limit.label)?.[1] ?? scope;
	const id = windowKey(limit);
	const span = /^(\d+)([hd])$/.exec(id);
	if (span) return `${span[1]}${span[2]?.toUpperCase()}`;
	if (id === "daily") return "1D";
	if (id === "weekly" || id === "1w") return "7D";
	if (id === "monthly") return "30D";
	return (limit.windowLabel ?? limit.label).split(/[\s(]/)[0]?.slice(0, 4).toUpperCase() ?? "";
}

/** Two different quotas can reset together. Name them by the differing part of their stock IDs. */
export function shortWindowLabel(limit: UsageLimit, peers: readonly UsageLimit[] = []): string {
	const heading = windowHeading(limit);
	const collides = (peer: UsageLimit) => !sameGauge(limit, peer) && windowHeading(peer) === heading;
	if (!peers.some(collides)) return heading;
	const others = peers.filter(collides);
	const key = gaugeColumn(limit);
	const tokens = others.map(peer => gaugeColumn(peer).split(":"));
	const name =
		key.split(":").find(part => tokens.every(other => !other.includes(part))) ??
		(others.every(peer => peer.windowId !== limit.windowId) ? windowKey(limit) : `${key} ${windowKey(limit)}`);
	return name.charAt(0).toUpperCase() + name.slice(1);
}

export interface UsageGaugeEntry {
	limit: UsageLimit;
	/** The share used, 0 and up. */
	fraction: number;
}

/**
 * The share of a window used, 0 and up, or null when the report measures none. A window whose reset time has passed
 * reads 0 until the next report: its quota was given back, and the old share would show a spent account as spent.
 */
export function usedShare(limit: UsageLimit, now = Date.now()): number | null {
	const fraction = limit.usedFraction ?? (limit.used !== undefined && limit.limit ? limit.used / limit.limit : null);
	if (fraction === null) return null;
	return limit.resetsAt !== undefined && limit.resetsAt <= now ? 0 : fraction;
}

function measured(limits: readonly UsageLimit[]): UsageGaugeEntry[] {
	const now = Date.now();
	const seen = new Set<string>();
	const entries: UsageGaugeEntry[] = [];
	for (const limit of limits) {
		const fraction = usedShare(limit, now);
		if (fraction === null) continue;
		const key = gaugeKey(limit);
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({ limit, fraction });
	}
	return entries;
}

/** The provider-local stock limit ID, independent of the period at which it resets. */
export function gaugeColumn(limit: UsageLimit): string {
	return limit.id.slice(limit.id.indexOf(":") + 1);
}

/** Some adapters reuse a limit ID for different periods, or a period for different quotas. */
export function gaugeKey(limit: UsageLimit): string {
	return JSON.stringify([limit.id, limit.windowId]);
}

export function sameGauge(a: UsageLimit, b: UsageLimit): boolean {
	return a.id === b.id && a.windowId === b.windowId;
}

/**
 * Every measured window of an account, for a surface with room for all of them (the Settings accounts row):
 * whole-account windows shortest first, then the model-scoped ones (Fable's weekly cap), shortest first.
 */
export function accountGauges(limits: readonly UsageLimit[]): UsageGaugeEntry[] {
	const scoped = (limit: UsageLimit) => (scopeId(limit) ? 1 : 0);
	return measured(limits).sort(
		(a, b) =>
			scoped(a.limit) - scoped(b.limit) ||
			windowHours(a.limit) - windowHours(b.limit) ||
			gaugeColumn(a.limit).localeCompare(gaugeColumn(b.limit)),
	);
}

/**
 * The columns the accounts of one provider share, in {@link accountGauges}' order: an account without one of them
 * (Claude reports no 5 hour window for some) leaves that column empty, so the same window lines up down the list.
 */
export function gaugeColumns(accounts: readonly (readonly UsageLimit[])[]): UsageLimit[] {
	return accountGauges(accounts.flat()).map(({ limit }) => limit);
}

/**
 * The windows a compact row gauges: the two tightest of the account's whole-account limits (a per-model tier such as
 * `7d:opus` only when nothing else is measured), shortest window first. The gauge fills with the share used,
 * as the Settings accounts row does.
 *
 * On a session's surface (`session`: the work board) one model-scoped window follows them, where Settings puts its
 * column ("5H · 7D · Fable"): the one of the model the session runs on, the window that decides whether its next turn
 * runs (Fable's weekly cap on `claude-fable-5-2`), else the tightest the account reports.
 */
export function accountWindows(limits: readonly UsageLimit[], session?: { model: string | null }): UsageGaugeEntry[] {
	const all = measured(limits);
	const plain = all.filter(entry => !scopeId(entry.limit));
	const shown = (plain.length > 0 ? plain : all)
		.sort((a, b) => b.fraction - a.fraction)
		.slice(0, 2)
		.sort((a, b) => windowHours(a.limit) - windowHours(b.limit));
	if (!session) return shown;
	const words = session.model?.toLowerCase().split(/[^a-z0-9]+/) ?? [];
	const scoped = all.filter(entry => scopeId(entry.limit));
	const next =
		scoped.find(entry => words.includes(scopeId(entry.limit))) ??
		scoped.filter(entry => !shown.includes(entry)).sort((a, b) => b.fraction - a.fraction)[0];
	return next && !shown.includes(next) ? [...shown, next] : shown;
}
