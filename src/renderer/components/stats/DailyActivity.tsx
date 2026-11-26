/**
 * Insights › Stats › Overview's last six weeks: the key numbers (active days, longest streak, busiest day), a day grid
 * of token activity, and a share card (a PNG drawn here, copied or saved). It reads stock's day buckets
 * (`/api/stats/overview?range=90d`: one point per local calendar day of the stats server, `rollup.ts` `seriesBucket`)
 * whatever range the page shows, so the grid always covers the same six weeks.
 *
 * Orca: renderer/src/components/stats/usage-overview-sections.tsx:171 (`DailyIntensityGrid`, 42 days, five levels),
 * StatsPane.tsx:183 (headline counters), ShareUsageButton.tsx:21 and ShareUsageCard.tsx (the card, copied as a PNG).
 * Orca's counters (agents spawned, time agents worked, PRs created) come from its own event log; stock's stats
 * database has no such record, so the counters here are the ones its day buckets prove. Orca draws its card from the
 * DOM with html-to-image; this one is drawn on a canvas, which needs no dependency.
 */

import { Share2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BRAND_MARK } from "../../../shared/brand-mark";
import { PRODUCT_REPO_URL } from "../../../shared/product-repo";
import type { OverviewData, TimePoint } from "../../../shared/stats-types";
import { useStats } from "../../hooks/use-stats";
import { compact } from "../../lib/chart";
import { cx, uiLocale } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { copyImageBlob, saveImage } from "../../lib/image-actions";
import { toast, toastError } from "../../stores/toast";
import { Button, Card, Modal, SectionLabel } from "../common";
import { MetricCard, MetricGrid } from "./shared";

export const GRID_DAYS = 42;

export interface DayCell {
	/** Local calendar day, `YYYY-MM-DD`. */
	day: string;
	tokens: number;
	requests: number;
	/** 0 none, 1-4 a quarter of the busiest day each. */
	level: 0 | 1 | 2 | 3 | 4;
}

export interface DailyGrid {
	cells: DayCell[];
	activeDays: number;
	longestStreak: number;
	totalTokens: number;
	best: DayCell | null;
	/** Weekday of the first cell (0 Sunday), so the grid's columns are calendar weeks. */
	firstWeekday: number;
}

function dayKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * The last `GRID_DAYS` local days up to `today`, from stock's day buckets (each stamped at its local midnight); finer
 * buckets on the same day add up.
 */
export function dailyGrid(series: readonly TimePoint[], today: Date): DailyGrid {
	const byDay = new Map<string, { tokens: number; requests: number }>();
	for (const point of series) {
		const key = dayKey(new Date(point.timestamp));
		const sum = byDay.get(key) ?? { tokens: 0, requests: 0 };
		byDay.set(key, { tokens: sum.tokens + point.tokens, requests: sum.requests + point.requests });
	}
	const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (GRID_DAYS - 1));
	const raw = Array.from({ length: GRID_DAYS }, (_, index) => {
		const day = dayKey(new Date(first.getFullYear(), first.getMonth(), first.getDate() + index));
		return { day, tokens: 0, requests: 0, ...byDay.get(day) };
	});
	const max = Math.max(0, ...raw.map(cell => cell.tokens));
	let streak = 0;
	let longestStreak = 0;
	let best: DayCell | null = null;
	const cells = raw.map(cell => {
		const level = (
			cell.tokens > 0 ? Math.min(4, Math.max(1, Math.ceil((cell.tokens / max) * 4))) : 0
		) as DayCell["level"];
		const full = { ...cell, level };
		streak = cell.requests > 0 ? streak + 1 : 0;
		longestStreak = Math.max(longestStreak, streak);
		if (cell.tokens > 0 && (best === null || cell.tokens > best.tokens)) best = full;
		return full;
	});
	return {
		cells,
		activeDays: cells.filter(cell => cell.requests > 0).length,
		longestStreak,
		totalTokens: cells.reduce((sum, cell) => sum + cell.tokens, 0),
		best,
		firstWeekday: first.getDay(),
	};
}

/** The accent at each level's strength; level 0 is the faint empty square. */
const LEVEL_MIX = [0, 30, 55, 78, 100] as const;

function levelColor(level: DayCell["level"]): string {
	return level === 0
		? "var(--sc-surface-3)"
		: `color-mix(in srgb, var(--sc-accent) ${LEVEL_MIX[level]}%, transparent)`;
}

function dayLabel(day: string): string {
	const [year, month, date] = day.split("-").map(Number);
	return new Intl.DateTimeFormat(uiLocale(), { month: "short", day: "numeric" }).format(
		new Date(year, month - 1, date),
	);
}

export function DailyActivitySection() {
	const t = useT();
	const params = useMemo(() => ({ range: "90d" }), []);
	const { data } = useStats<OverviewData>("/api/stats/overview", params);
	const grid = useMemo(() => (data ? dailyGrid(data.timeSeries, new Date()) : null), [data]);
	const [sharing, setSharing] = useState(false);
	if (!grid || grid.activeDays === 0) return null;
	const locale = uiLocale();

	return (
		<section data-stats-daily>
			<div className="mt-8 mb-3 flex items-center justify-between gap-3">
				<SectionLabel className="m-0" size="title">
					{t("stats.daily.title")}
				</SectionLabel>
				<Button icon={<Share2 />} onClick={() => setSharing(true)} size="sm" variant="secondary">
					{t("stats.daily.share")}
				</Button>
			</div>
			<MetricGrid>
				<MetricCard
					label={t("stats.daily.activeDays")}
					sub={t("stats.daily.ofDays", { count: GRID_DAYS })}
					value={grid.activeDays.toLocaleString(locale)}
				/>
				<MetricCard label={t("stats.daily.longestStreak")} value={grid.longestStreak.toLocaleString(locale)} />
				<MetricCard
					label={t("stats.daily.bestDay")}
					sub={grid.best ? t("stats.daily.tokens", { count: compact(grid.best.tokens) }) : undefined}
					value={grid.best ? dayLabel(grid.best.day) : "—"}
				/>
			</MetricGrid>
			<Card className="mt-3" padding="lg">
				<div
					aria-label={t("stats.daily.gridLabel")}
					className="grid grid-flow-col grid-rows-7 justify-start gap-1"
					role="img"
				>
					{Array.from({ length: grid.firstWeekday }, (_, index) => (
						// Days before the first one in its week: empty places that keep the rows on their weekdays.
						<span aria-hidden className="size-3.5" key={`pad-${index}`} />
					))}
					{grid.cells.map(cell => (
						<span
							className="size-3.5 rounded-[3px]"
							data-level={cell.level}
							key={cell.day}
							style={{ backgroundColor: levelColor(cell.level) }}
							title={t("stats.daily.cell", { day: dayLabel(cell.day), tokens: compact(cell.tokens) })}
						/>
					))}
				</div>
				<div aria-hidden className="mt-3 flex items-center gap-1.5 text-sc-xs text-(--sc-text-muted)">
					<span>{dayLabel(grid.cells[0].day)}</span>
					<span className="flex-1" />
					<span>{t("stats.daily.less")}</span>
					{([0, 1, 2, 3, 4] as const).map(level => (
						<span className="size-2.5 rounded-[2px]" key={level} style={{ backgroundColor: levelColor(level) }} />
					))}
					<span>{t("stats.daily.more")}</span>
					<span className="flex-1" />
					<span>{dayLabel(grid.cells[GRID_DAYS - 1].day)}</span>
				</div>
			</Card>
			{sharing && <ShareCardDialog grid={grid} onClose={() => setSharing(false)} />}
		</section>
	);
}

interface CardText {
	title: string;
	activeDays: string;
	activeLabel: string;
	streak: string;
	streakLabel: string;
	tokens: string;
	tokensLabel: string;
}

function cssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
	return style.getPropertyValue(name).trim() || fallback;
}

/** The card as a 1200×630 PNG at twice that density, in the window's theme. */
async function drawShareCard(grid: DailyGrid, text: CardText): Promise<Blob> {
	const style = getComputedStyle(document.documentElement);
	const bg = cssVar(style, "--sc-bg", "#ffffff");
	const ink = cssVar(style, "--sc-text", "#0a0a0a");
	const muted = cssVar(style, "--sc-text-muted", "#6b6b6b");
	const accent = cssVar(style, "--sc-accent", "#6e70ee");
	const empty = cssVar(style, "--sc-surface-3", "#e5e5e5");
	const font = cssVar(style, "--sc-font-sans", "system-ui, sans-serif");
	const scale = 2;
	const canvas = new OffscreenCanvas(1200 * scale, 630 * scale);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("no 2d canvas");
	ctx.scale(scale, scale);
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, 1200, 630);

	// The mark (its 512-unit box drawn 56 px tall) and the name.
	ctx.save();
	ctx.translate(92, 92);
	ctx.scale(56 / 512, 56 / 512);
	ctx.fillStyle = ink;
	ctx.fill(new Path2D(BRAND_MARK.full.ink));
	ctx.fillStyle = accent;
	ctx.fill(new Path2D(BRAND_MARK.full.accent));
	ctx.restore();
	ctx.fillStyle = ink;
	ctx.textBaseline = "middle";
	ctx.font = `600 34px ${font}`;
	ctx.fillText("OMPdesk", 136, 92);
	ctx.fillStyle = muted;
	ctx.font = `400 26px ${font}`;
	ctx.fillText(text.title, 64, 170);

	const figures: [string, string][] = [
		[text.activeDays, text.activeLabel],
		[text.streak, text.streakLabel],
		[text.tokens, text.tokensLabel],
	];
	figures.forEach(([value, label], index) => {
		const x = 64 + index * 190;
		ctx.fillStyle = ink;
		ctx.font = `700 56px ${font}`;
		ctx.fillText(value, x, 260);
		ctx.fillStyle = muted;
		ctx.font = `400 20px ${font}`;
		ctx.fillText(label, x, 312);
	});

	// The day grid: weeks as columns, Sunday on top.
	const cell = 30;
	const gap = 6;
	const left = 64;
	const top = 380;
	grid.cells.forEach((day, index) => {
		const place = index + grid.firstWeekday;
		const x = left + Math.floor(place / 7) * (cell + gap);
		const y = top + (place % 7) * (cell + gap);
		ctx.globalAlpha = day.level === 0 ? 1 : LEVEL_MIX[day.level] / 100;
		ctx.fillStyle = day.level === 0 ? empty : accent;
		ctx.beginPath();
		ctx.roundRect(x, y, cell, cell, 6);
		ctx.fill();
	});
	ctx.globalAlpha = 1;
	ctx.fillStyle = muted;
	ctx.font = `400 20px ${font}`;
	ctx.textAlign = "right";
	ctx.fillText(PRODUCT_REPO_URL.replace(/^https:\/\//, ""), 1136, 590);
	return canvas.convertToBlob({ type: "image/png" });
}

function ShareCardDialog({ grid, onClose }: { grid: DailyGrid; onClose: () => void }) {
	const t = useT();
	const [card, setCard] = useState<{ blob: Blob; url: string } | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let url: string | null = null;
		let live = true;
		const locale = uiLocale();
		drawShareCard(grid, {
			title: t("stats.daily.cardTitle", { count: GRID_DAYS }),
			activeDays: grid.activeDays.toLocaleString(locale),
			activeLabel: t("stats.daily.activeDays"),
			streak: grid.longestStreak.toLocaleString(locale),
			streakLabel: t("stats.daily.longestStreak"),
			tokens: compact(grid.totalTokens),
			tokensLabel: t("stats.daily.cardTokens"),
		})
			.then(blob => {
				if (!live) return;
				url = URL.createObjectURL(blob);
				setCard({ blob, url });
			})
			.catch(() => {
				if (live) setFailed(true);
			});
		return () => {
			live = false;
			if (url) URL.revokeObjectURL(url);
		};
	}, [grid, t]);

	return (
		<Modal
			footer={
				<>
					<Button
						disabled={!card}
						onClick={() => {
							if (!card) return;
							saveImage(card.url, "ompdesk-activity.png").then(
								result => {
									if (result.error) toastError({ title: t("stats.daily.saveFailed"), error: result.error });
								},
								(error: unknown) => toastError({ title: t("stats.daily.saveFailed"), error }),
							);
						}}
						variant="secondary"
					>
						{t("stats.daily.save")}
					</Button>
					<Button
						data-dialog-autofocus
						disabled={!card}
						onClick={() => {
							if (!card) return;
							copyImageBlob(card.blob).then(
								() => toast({ variant: "success", message: t("stats.daily.copied") }),
								(error: unknown) => toastError({ title: t("stats.daily.copyFailed"), error }),
							);
						}}
						variant="primary"
					>
						{t("stats.daily.copy")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="lg"
			title={t("stats.daily.shareTitle")}
		>
			<div
				className={cx(
					"aspect-[1200/630] w-full overflow-hidden rounded-(--sc-radius-md)",
					!card && "bg-(--sc-surface-2)",
				)}
			>
				{card && <img alt={t("stats.daily.cardAlt")} className="size-full" data-share-card src={card.url} />}
			</div>
			{failed && <p className="mt-2 text-sc-sm text-(--sc-danger)">{t("stats.daily.drawFailed")}</p>}
		</Modal>
	);
}
