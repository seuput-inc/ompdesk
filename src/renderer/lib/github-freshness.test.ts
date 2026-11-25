import { describe, expect, it } from "vitest";
import { afterFailure, afterSuccess, pausedUntil, shouldReread } from "./github-freshness";

const NOW = Date.parse("2026-11-25T10:00:00.000Z");

describe("github freshness", () => {
	it("reads a view never read, or one read a minute ago, and not one read within the minute", () => {
		expect(shouldReread(undefined, NOW)).toBe(true);
		const fresh = afterSuccess(NOW);
		expect(shouldReread(fresh, NOW + 59_999)).toBe(false);
		expect(shouldReread(fresh, NOW + 60_000)).toBe(true);
	});

	it("holds failures back 60 s doubling, capped at 15 minutes", () => {
		let f = afterSuccess(NOW - 120_000);
		const holds: number[] = [];
		for (let i = 0; i < 7; i++) {
			f = afterFailure(f, NOW, { code: "github_failed", message: "boom" });
			holds.push(f.holdUntil - NOW);
		}
		expect(holds).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
		expect(shouldReread(f, NOW + 899_999)).toBe(false);
		expect(shouldReread(f, NOW + 900_000)).toBe(true);
		expect(afterSuccess(NOW).failures).toBe(0);
	});

	it("holds a gh_paused refusal until the time it names", () => {
		const message = "GitHub's background reads are spent; paused until 2026-11-25T10:31:00.000Z";
		expect(pausedUntil(message)).toBe(Date.parse("2026-11-25T10:31:00.000Z"));
		expect(pausedUntil("paused until 2026-11-25T10:31:00Z")).toBe(Date.parse("2026-11-25T10:31:00Z"));
		expect(pausedUntil("rate limited")).toBeNull();
		expect(afterFailure(undefined, NOW, { code: "gh_paused", message }).holdUntil).toBe(
			Date.parse("2026-11-25T10:31:00.000Z"),
		);
		// Without a time it backs off like any failure.
		expect(afterFailure(undefined, NOW, { code: "gh_paused", message: "paused" }).holdUntil).toBe(NOW + 60_000);
	});
});
