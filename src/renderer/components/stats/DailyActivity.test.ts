/**
 * The six-week grid from stock's local-day buckets: days with no point are empty, the busiest day is level 4, the
 * streak counts consecutive days with requests, and a finer series adds up per day.
 */

import { describe, expect, it } from "vitest";
import type { TimePoint } from "../../../shared/stats-types";
import { dailyGrid, GRID_DAYS } from "./DailyActivity";

const today = new Date(2026, 10, 26, 15, 0);

function point(daysAgo: number, tokens: number, hour = 0): TimePoint {
	return {
		timestamp: new Date(2026, 10, 26 - daysAgo, hour).getTime(),
		requests: tokens > 0 ? 1 : 0,
		errors: 0,
		tokens,
		cost: 0,
	};
}

describe("dailyGrid", () => {
	it("lays the last 42 local days out, levels by the busiest day, and counts the longest streak", () => {
		const grid = dailyGrid([point(0, 100), point(1, 400), point(2, 50), point(10, 200), point(50, 9_999)], today);
		expect(grid.cells).toHaveLength(GRID_DAYS);
		expect(grid.cells[0].day).toBe("2026-10-16");
		expect(grid.cells.at(-1)?.day).toBe("2026-11-26");
		expect(grid.cells.at(-2)).toMatchObject({ tokens: 400, level: 4 });
		expect(grid.cells.at(-3)).toMatchObject({ tokens: 50, level: 1 });
		expect(grid.cells.at(-5)).toMatchObject({ tokens: 0, level: 0 });
		expect(grid.activeDays).toBe(4);
		expect(grid.longestStreak).toBe(3);
		expect(grid.best?.day).toBe("2026-11-25");
		expect(grid.totalTokens).toBe(750);
		expect(grid.firstWeekday).toBe(new Date(2026, 9, 16).getDay());
	});

	it("adds up hourly points of one day", () => {
		const grid = dailyGrid([point(0, 10, 1), point(0, 15, 9)], today);
		expect(grid.cells.at(-1)).toMatchObject({ tokens: 25, requests: 2 });
	});
});
