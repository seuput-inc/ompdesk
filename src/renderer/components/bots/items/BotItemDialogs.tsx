/**
 * The item moves that ask something first (Orca's `BotItemStatusNoteDialog.tsx:1-113`, `BotItemSnoozeDialog.tsx:1-177`,
 * MIT, re-implemented on the kit's `Modal`):
 *
 * - Waiting asks what the items wait on (one line, `ITEM_WAIT_MAX`); Waiting again on one Waiting item starts from
 *   what it waits on now, so the move edits it.
 * - Snooze until: the presets (Later today, Tomorrow, Monday, In a week) with their times, then Custom time: a day and
 *   a quarter hour still ahead, at most a year out; a passed time on the chosen day rolls to the next open slot.
 */
import { CalendarDays } from "lucide-react";
import { useId, useState } from "react";
import { ITEM_WAIT_MAX, type Item } from "../../../../shared/bots";
import { uiLocale } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { Button, Input, ListRow, Modal, Select } from "../../common";
import { SNOOZE_MAX_MS, type SnoozePreset, snoozeAt, snoozePresets, snoozeSlots, snoozeTimeFormat } from "./item-model";

/** A wake time as rows and menus say it: "6:00 PM", "Thu 9:00 AM" or "Nov 30, 9:00 AM". */
export function formatSnooze(until: number, now: number): string {
	return new Intl.DateTimeFormat(uiLocale(), snoozeTimeFormat(until, now)).format(until);
}

export function presetName(preset: SnoozePreset, t: (key: string, params?: Record<string, number>) => string): string {
	if (preset.id === "later" && preset.inHours) return t("bots.items.snooze.inHours", { count: preset.inHours });
	return t(`bots.items.snooze.${preset.id}`);
}

export function WaitDialog({
	items,
	onDone,
	onClose,
}: {
	items: readonly Item[];
	onDone: (wait: string) => void;
	onClose: () => void;
}) {
	const t = useT();
	const formId = useId();
	const [only] = items;
	const [text, setText] = useState(items.length === 1 && only?.status === "waiting" ? (only.wait?.text ?? "") : "");
	const submit = () => {
		if (text.trim()) onDone(text.trim());
	};
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} type="button" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button disabled={!text.trim()} form={formId} type="submit" variant="primary">
						{t("bots.items.wait.confirm")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="sm"
			title={
				items.length === 1 && only
					? t("bots.items.wait.titleOne", { title: only.title })
					: t("bots.items.wait.titleMany", { count: items.length })
			}
		>
			<form
				data-bot-item-wait-dialog
				id={formId}
				onSubmit={event => {
					event.preventDefault();
					submit();
				}}
			>
				<Input
					aria-label={t("bots.items.wait.placeholder")}
					maxLength={ITEM_WAIT_MAX}
					onChange={event => setText(event.target.value)}
					placeholder={t("bots.items.wait.placeholder")}
					value={text}
				/>
			</form>
		</Modal>
	);
}

/** `YYYY-MM-DD` of `day` in this device's time zone. */
function dayValue(day: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

export function SnoozeDialog({ onSnooze, onClose }: { onSnooze: (until: number) => void; onClose: () => void }) {
	const t = useT();
	const formId = useId();
	const [now] = useState(Date.now);
	const [picking, setPicking] = useState(false);
	const [day, setDay] = useState(() => {
		const tomorrow = new Date(now);
		tomorrow.setDate(tomorrow.getDate() + 1);
		return dayValue(tomorrow);
	});
	const [minutes, setMinutes] = useState(9 * 60);
	const [year, month, date] = day.split("-").map(Number);
	const picked = new Date(year ?? 0, (month ?? 1) - 1, date ?? 1);
	const slots = snoozeSlots(picked, now);
	// A time that has passed on the chosen day rolls forward to the next open slot.
	const slot = slots.find(open => open >= minutes) ?? slots.at(-1) ?? null;
	const until = slot === null ? null : snoozeAt(picked, slot);
	const slotLabel = new Intl.DateTimeFormat(uiLocale(), { hour: "numeric", minute: "2-digit" });
	return (
		<Modal
			footer={
				picking ? (
					<>
						<Button onClick={() => setPicking(false)} type="button" variant="ghost">
							{t("bots.items.snooze.back")}
						</Button>
						<Button disabled={until === null} form={formId} type="submit" variant="primary">
							{t("bots.items.snooze.menu")}
						</Button>
					</>
				) : undefined
			}
			onClose={onClose}
			open
			size="sm"
			title={t("bots.items.snooze.pickTitle")}
		>
			{picking ? (
				<form
					className="flex flex-col gap-3"
					data-bot-item-snooze-custom
					id={formId}
					onSubmit={event => {
						event.preventDefault();
						if (until !== null) onSnooze(until);
					}}
				>
					<Input
						label={t("bots.items.snooze.day")}
						max={dayValue(new Date(now + SNOOZE_MAX_MS))}
						min={dayValue(new Date(now))}
						onChange={event => event.target.value && setDay(event.target.value)}
						type="date"
						value={day}
					/>
					<Select
						disabled={slots.length === 0}
						label={t("bots.items.snooze.time")}
						onChange={event => setMinutes(Number(event.target.value))}
						options={slots.map(option => ({
							value: String(option),
							label: slotLabel.format(snoozeAt(picked, option)),
						}))}
						value={slot === null ? "" : String(slot)}
					/>
					<p className="text-sc-xs text-(--sc-text-muted)">
						{until === null ? t("bots.items.snooze.noSlot") : formatSnooze(until, now)}
					</p>
				</form>
			) : (
				<div className="flex flex-col gap-0.5" data-bot-item-snooze-presets>
					{snoozePresets(now, true).map(preset => (
						<ListRow
							key={preset.id}
							meta={<span className="tabular-nums">{formatSnooze(preset.at, now)}</span>}
							onClick={() => onSnooze(preset.at)}
							size="sm"
							title={presetName(preset, t)}
						/>
					))}
					<ListRow
						leading={<CalendarDays aria-hidden className="size-4 text-(--sc-text-muted)" />}
						onClick={() => setPicking(true)}
						size="sm"
						title={t("bots.items.snooze.pickCustom")}
					/>
				</div>
			)}
		</Modal>
	);
}
