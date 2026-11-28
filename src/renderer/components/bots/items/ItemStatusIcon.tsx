/**
 * An item's status as a glyph and a name (Orca's `BotItemStatusIcon.tsx`, `bot-item-status-name.ts`): shape and colour
 * both say it. In progress turns while a session the item links is at work; a Stale or Snoozed row draws its glyph
 * muted. A picker's Waiting ends in an ellipsis: it asks what the item waits on first.
 */
import { Circle, CircleAlert, CircleCheck, CircleDot, CircleSlash, Hourglass } from "lucide-react";
import type { ItemStatus } from "../../../../shared/bots";
import type { ListedItem } from "../../../../shared/items-v2";
import { cx } from "../../../lib/format";
import { WorkingArc } from "../../common";

const ICONS = {
	planned: Circle,
	working: CircleDot,
	waiting: Hourglass,
	needs_you: CircleAlert,
	done: CircleCheck,
	canceled: CircleSlash,
} as const;

const TONES: Record<ItemStatus, string> = {
	planned: "text-(--sc-text-muted)",
	working: "text-(--sc-info)",
	waiting: "text-(--sc-text-muted)",
	needs_you: "text-(--sc-attention)",
	done: "text-(--sc-success)",
	canceled: "text-(--sc-text-subtle)",
};

/** Whether a session the item links may still be at work: its In progress glyph turns. */
export function itemLive(item: ListedItem): boolean {
	if (!("events" in item)) return item.live === true;
	return item.links.some(link => link.kind === "session" && (link.state === "working" || link.state === "waiting"));
}

export function ItemStatusIcon({ status, live, muted }: { status: ItemStatus; live?: boolean; muted?: boolean }) {
	if (status === "working" && live) return <WorkingArc state="turn" />;
	const Icon = ICONS[status];
	return <Icon aria-hidden className={cx("size-3.5 shrink-0", muted ? "text-(--sc-text-subtle)" : TONES[status])} />;
}

/** A status's name; `picker`: Waiting ends in an ellipsis, as it asks what the item waits on first. */
export function statusName(status: ItemStatus, t: (key: string) => string, picker = false): string {
	return picker && status === "waiting" ? t("bots.items.status.waitingPick") : t(`bots.items.status.${status}`);
}
