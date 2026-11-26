/**
 * A bot's items as its Items tab and item page read them (Orca's `shared/bots/bot-item-groups.ts`,
 * `bot-item-snooze.ts`, `bot-item-walk.ts`, `bot-item-ask.ts`, MIT, re-implemented over the core's item records,
 * `src/shared/bots.ts` `Item`). Pure: no store, no clock of its own.
 *
 * - Groups: Needs you, In progress, Waiting, Planned, Snoozed, Stale, Closed. Snoozed is any open item whose wake
 *   time has not come; Stale is the core's read (`Item.stale`). Rows changed by anyone but the owner since the tab was
 *   last opened come first (the unseen mark), then the latest activity; Snoozed soonest back first.
 * - The walk is the list's order, group by group: the item page's previous and next.
 * - Snooze presets resolve in this device's own time zone: Later today (6 PM, or three hours out after 5 PM),
 *   Tomorrow and Monday at 9 AM, and the picker's In a week.
 * - Several questions asked at once are answered in one comment, a line `Question → answer` each.
 */
import type { Item, ItemDecision, ItemEvent, ItemQuestion, ItemStatus } from "../../../../shared/bots";

export const ITEM_GROUPS = ["needs_you", "working", "waiting", "planned", "snoozed", "stale", "closed"] as const;
export type ItemGroupId = (typeof ITEM_GROUPS)[number];
export type ItemGroups = Record<ItemGroupId, Item[]>;
/** Groups that start folded; the rest start open. */
export const GROUP_FOLDED: Record<ItemGroupId, boolean> = {
	needs_you: false,
	working: false,
	waiting: false,
	planned: true,
	snoozed: true,
	stale: true,
	closed: true,
};
/** Rows a group shows before "Show N more". */
export const GROUP_ROWS = 5;

/** What the status menus offer, in order. */
export const PICKER_STATUSES: readonly ItemStatus[] = [
	"planned",
	"working",
	"waiting",
	"needs_you",
	"done",
	"canceled",
];

export function isClosed(status: ItemStatus): boolean {
	return status === "done" || status === "canceled";
}

/** Snoozed is derived, never a status: an open item whose wake time has not come. */
export function isSnoozed(item: Pick<Item, "status" | "snoozedUntil">, now: number): boolean {
	return !isClosed(item.status) && item.snoozedUntil !== undefined && Date.parse(item.snoozedUntil) > now;
}

/** What a row's age and order count from: its last change, or when it came back from a snooze if later. */
export function activityAt(item: Pick<Item, "updatedAt" | "snoozedUntil">, now: number): number {
	const changed = Date.parse(item.updatedAt) || 0;
	const woke = item.snoozedUntil ? Date.parse(item.snoozedUntil) : Number.NaN;
	return woke <= now ? Math.max(changed, woke) : changed;
}

export function itemGroupOf(item: Item, now: number): ItemGroupId {
	if (item.status === "done" || item.status === "canceled") return "closed";
	if (isSnoozed(item, now)) return "snoozed";
	return item.stale ? "stale" : item.status;
}

/** The newest event anyone but the owner made: what the unseen mark compares. */
export function othersLast(item: Pick<Item, "events">): number {
	let newest = 0;
	for (const event of item.events) if (event.actor !== "owner" && event.id > newest) newest = event.id;
	return newest;
}

/** Changed by anyone but the owner since the owner last opened its bot's Items tab. */
export function isUnseen(item: Pick<Item, "events">, seen: number): boolean {
	return othersLast(item) > seen;
}

/** Several bots' items in one set of groups, each marked by its own bot's seen mark (`seenOf`). */
export function groupItems(items: readonly Item[], seenOf: (item: Item) => number, now: number): ItemGroups {
	const groups: ItemGroups = {
		needs_you: [],
		working: [],
		waiting: [],
		planned: [],
		snoozed: [],
		stale: [],
		closed: [],
	};
	for (const item of items) groups[itemGroupOf(item, now)].push(item);
	const unseen = (item: Item) => Number(isUnseen(item, seenOf(item)));
	for (const id of ITEM_GROUPS)
		groups[id].sort(
			id === "snoozed"
				? (a, b) => Date.parse(a.snoozedUntil ?? "") - Date.parse(b.snoozedUntil ?? "") || b.number - a.number
				: (a, b) => unseen(b) - unseen(a) || activityAt(b, now) - activityAt(a, now) || b.number - a.number,
		);
	return groups;
}

/** The Items tab's filter: only what needs the owner, and (a group's list) which bots; null = all. */
export interface ItemFilter {
	needsYou: boolean;
	bots: readonly string[] | null;
}
export const NO_FILTER: ItemFilter = { needsYou: false, bots: null };

export function filterOn(filter: ItemFilter): boolean {
	return filter.needsYou || filter.bots !== null;
}

export function filterItems(items: readonly Item[], filter: ItemFilter): Item[] {
	return items.filter(
		item =>
			(filter.bots === null || filter.bots.includes(item.bot)) && (!filter.needsYou || item.status === "needs_you"),
	);
}

/** The ids in the list's order: what previous and next step through. */
export function walkOrder(groups: ItemGroups): string[] {
	return ITEM_GROUPS.flatMap(id => groups[id].map(item => item.id));
}

/** The item `direction` steps from `id` in `order`, or null at either end (or when `id` is not in it). */
export function stepFrom(order: readonly string[], id: string, direction: 1 | -1): string | null {
	const at = order.indexOf(id);
	if (at < 0) return null;
	return order[at + direction] ?? null;
}

// ---- Snooze ------------------------------------------------------------------------------------------------------

export type SnoozePresetId = "later" | "tomorrow" | "monday" | "week";
export interface SnoozePreset {
	id: SnoozePresetId;
	at: number;
	/** Later today in the evening reads "In 3 hours". */
	inHours?: number;
}

/** The latest a snooze may reach, so a slip of the hand cannot hide an item for years. */
export const SNOOZE_MAX_MS = 366 * 24 * 60 * 60_000;
export const SNOOZE_SLOT_MINUTES = 15;
const MORNING = 9;
const EVENING = 18;
const LATER_CUTOFF = 17;
const LATER_HOURS = 3;

function atHour(day: Date, hour: number): number {
	const time = new Date(day);
	time.setHours(hour, 0, 0, 0);
	return time.getTime();
}

/** Later today, Tomorrow 9 AM and Monday 9 AM (next Monday on a Monday); `picker` adds In a week. */
export function snoozePresets(now: number, picker = false): SnoozePreset[] {
	const today = new Date(now);
	const later: SnoozePreset =
		today.getHours() < LATER_CUTOFF
			? { id: "later", at: atHour(today, EVENING) }
			: {
					id: "later",
					at: atHour(today, today.getHours() + LATER_HOURS + (today.getMinutes() > 0 ? 1 : 0)),
					inHours: LATER_HOURS,
				};
	const tomorrow = new Date(today);
	tomorrow.setDate(today.getDate() + 1);
	const monday = new Date(today);
	monday.setDate(today.getDate() + ((8 - today.getDay()) % 7 || 7));
	const presets: SnoozePreset[] = [
		later,
		{ id: "tomorrow", at: atHour(tomorrow, MORNING) },
		{ id: "monday", at: atHour(monday, MORNING) },
	];
	if (!picker) return presets;
	const week = new Date(today);
	week.setDate(today.getDate() + 7);
	const inAWeek = atHour(week, MORNING);
	// On a Monday both land on next Monday: only In a week stays.
	return [...presets.filter(preset => preset.at !== inAWeek), { id: "week", at: inAWeek }];
}

/** `minutes` past local midnight of `day`. */
export function snoozeAt(day: Date, minutes: number): number {
	return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes).getTime();
}

/** The quarter hours of `day` still ahead of `now` and within the cap; a DST gap's hour has none. */
export function snoozeSlots(day: Date, now: number): number[] {
	const slots: number[] = [];
	for (let minutes = 0; minutes < 24 * 60; minutes += SNOOZE_SLOT_MINUTES) {
		const until = snoozeAt(day, minutes);
		const wall = new Date(until);
		if (until > now && until <= now + SNOOZE_MAX_MS && wall.getHours() * 60 + wall.getMinutes() === minutes)
			slots.push(minutes);
	}
	return slots;
}

/** How a wake time reads: the time today, the weekday within the week, else the date. */
export function snoozeTimeFormat(until: number, now: number): Intl.DateTimeFormatOptions {
	const time = { hour: "numeric", minute: "2-digit" } as const;
	if (new Date(until).toDateString() === new Date(now).toDateString()) return time;
	return until - now < 6 * 24 * 60 * 60_000
		? { weekday: "short", ...time }
		: { month: "short", day: "numeric", ...time };
}

// ---- Questions ---------------------------------------------------------------------------------------------------

/** A question's first line with words, its Markdown marks dropped, for a one-line row. */
export function questionLine(text: string): string {
	for (const line of text.split("\n")) {
		const plain = line
			.trim()
			.replace(/^(#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/(\*\*|__)(.+?)\1/g, "$2")
			.replace(/`([^`]*)`/g, "$1")
			.trim();
		if (plain) return plain;
	}
	return "";
}

/** The question's lines to answer: its several questions, or the one it is. */
export function decisionsOf(question: ItemQuestion): ItemDecision[] {
	if (question.decisions?.length) return question.decisions;
	return [{ question: question.text, options: question.options, recommended: question.recommended }];
}

/**
 * The one comment several answers are sent as: with several questions a line `Question → answer` per answered one, in
 * the ask's order; with one, the answer alone. Null when nothing is answered.
 */
export function answersText(question: ItemQuestion, answers: readonly (string | null)[]): string | null {
	const decisions = decisionsOf(question);
	const several = decisions.length > 1;
	const lines = decisions.flatMap((decision, index) => {
		const words = answers[index]?.trim();
		if (!words) return [];
		return [several ? `${questionLine(decision.question)} → ${words}` : words];
	});
	return lines.length > 0 ? lines.join("\n") : null;
}

// ---- Activity ----------------------------------------------------------------------------------------------------

/** Events that read as a card (words someone wrote); every other kind is one muted line between them. */
export function isCommentEvent(event: ItemEvent): boolean {
	return event.kind === "commented" || event.kind === "asked" || event.kind === "answered";
}

/** A status event that moved a closed item back to an open one. */
export function isReopen(event: ItemEvent): boolean {
	return (
		event.kind === "status" &&
		(event.from === "done" || event.from === "canceled") &&
		event.text !== "done" &&
		event.text !== "canceled"
	);
}
