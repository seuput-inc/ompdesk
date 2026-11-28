import type { Item } from "./bots";

/** The age and order a row shows after waking from a snooze. */
export function activityAt(item: Pick<Item, "updatedAt" | "snoozedUntil">, now: number): number {
	const changed = Date.parse(item.updatedAt) || 0;
	const woke = item.snoozedUntil ? Date.parse(item.snoozedUntil) : Number.NaN;
	return woke <= now ? Math.max(changed, woke) : changed;
}

/** Read markers compare only the visible tail, not all retained history. */
export function othersLast(events: Item["events"]): number {
	let newest = 0;
	for (const event of events) if (event.actor !== "owner" && event.id > newest) newest = event.id;
	return newest;
}
