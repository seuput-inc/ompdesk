import { describe, expect, it } from "vitest";
import { HOLD_RETELL_MS, heldSince, holdNotice, parseHoldTold, VERIFYING_TELL_AFTER_MS } from "./omp-hold-notice";

const HOUR = 60 * 60 * 1000;
const SINCE = "2026-11-20T00:00:00.000Z";
const at = (ms: number) => Date.parse(SINCE) + ms;
const failed = { version: "19.1.0", reason: "failed", since: SINCE } as const;
const verifying = { version: "19.2.0", reason: "verifying", since: SINCE } as const;

describe("holdNotice: a release runners failed", () => {
	it("tells a hold once when first seen, once more after a day with the days, then never again", () => {
		const first = holdNotice(failed, null, at(60_000));
		expect(first.notice).toMatchObject({ version: "19.1.0", reason: "failed", days: 0 });
		// Every later check within the day (each 4 h, and a relaunch reading what was told) says nothing.
		expect(holdNotice(failed, first.told, at(HOLD_RETELL_MS - 1)).notice).toBeNull();
		const second = holdNotice(failed, first.told, at(HOLD_RETELL_MS + HOUR));
		expect(second.notice).toMatchObject({ version: "19.1.0", days: 1 });
		expect(holdNotice(failed, second.told, at(5 * HOLD_RETELL_MS)).notice).toBeNull();
	});

	it("tells a hold first seen days late once, with its days, and sends no second notice", () => {
		const late = holdNotice(failed, null, at(3 * HOLD_RETELL_MS + 1));
		expect(late.notice).toMatchObject({ version: "19.1.0", days: 3 });
		expect(holdNotice(failed, late.told, at(4 * HOLD_RETELL_MS)).notice).toBeNull();
	});

	it("tells a newer held version afresh", () => {
		const told = holdNotice(failed, null, at(0)).told;
		const next = holdNotice({ ...failed, version: "19.1.1" }, told, at(1000));
		expect(next.notice?.version).toBe("19.1.1");
	});
});

describe("holdNotice: a release still waiting for runners (the hourly run reached no verdict)", () => {
	it("says nothing for 6 hours, then tells once with the hours, not again within 24 h, and again after them", () => {
		expect(holdNotice(verifying, null, at(VERIFYING_TELL_AFTER_MS - 1))).toEqual({ notice: null, told: null });
		const first = holdNotice(verifying, null, at(VERIFYING_TELL_AFTER_MS));
		expect(first.notice).toEqual({ version: "19.2.0", reason: "verifying", hours: 6, days: 0 });
		// Every later check within the day (each 4 h, and a relaunch reading what was told) says nothing.
		for (const later of [HOUR, 4 * HOUR, HOLD_RETELL_MS - 1]) {
			expect(holdNotice(verifying, first.told, at(VERIFYING_TELL_AFTER_MS + later)).notice).toBeNull();
		}
		const again = holdNotice(verifying, first.told, at(VERIFYING_TELL_AFTER_MS + HOLD_RETELL_MS));
		expect(again.notice).toEqual({ version: "19.2.0", reason: "verifying", hours: 30, days: 1 });
		expect(holdNotice(verifying, again.told, at(VERIFYING_TELL_AFTER_MS + 2 * HOLD_RETELL_MS)).notice).toMatchObject({
			days: 2,
		});
	});

	it("stops once the version is verified or installed: no hold is said, whatever was told", () => {
		const told = holdNotice(verifying, null, at(VERIFYING_TELL_AFTER_MS)).told;
		for (const held of [null, undefined]) {
			expect(holdNotice(held, told, at(5 * HOLD_RETELL_MS))).toEqual({ notice: null, told });
		}
	});

	it("a newer release starts its own clock, and the same release failing is told at once", () => {
		const told = holdNotice(verifying, null, at(VERIFYING_TELL_AFTER_MS)).told;
		const newer = {
			version: "19.2.1",
			reason: "verifying",
			since: new Date(at(VERIFYING_TELL_AFTER_MS)).toISOString(),
		} as const;
		expect(holdNotice(newer, told, at(VERIFYING_TELL_AFTER_MS + HOUR)).notice).toBeNull();
		expect(
			holdNotice({ ...failed, version: "19.2.0" }, told, at(VERIFYING_TELL_AFTER_MS + HOUR)).notice,
		).toMatchObject({
			reason: "failed",
		});
	});

	it("never tells a hold without a first-seen time, or the default passes' major hold", () => {
		const { since: _since, ...unknown } = verifying;
		expect(holdNotice(unknown, null, at(10 * HOLD_RETELL_MS)).notice).toBeNull();
		expect(holdNotice({ version: "19.0.0", reason: "untested-major" }, null, at(0)).notice).toBeNull();
	});
});

describe("stored records", () => {
	it("reads back only a told record of its own shape", () => {
		const told = { version: "19.1.0", reason: "failed", at: 5, count: 1 };
		expect(parseHoldTold(told)).toEqual(told);
		expect(parseHoldTold({ version: "19.1.0", retold: true })).toBeNull();
		expect(parseHoldTold({ ...told, reason: "untested-major" })).toBeNull();
		expect(parseHoldTold("19.1.0")).toBeNull();
	});

	it("keeps the first time a version was seen held, and starts over for another version", () => {
		const first = heldSince(undefined, "19.2.0", at(0));
		expect(first).toEqual({ since: SINCE, store: { version: "19.2.0", at: SINCE } });
		expect(heldSince(first.store, "19.2.0", at(9 * HOUR))).toEqual({ since: SINCE, store: null });
		const later = new Date(at(9 * HOUR)).toISOString();
		expect(heldSince(first.store, "19.2.1", at(9 * HOUR))).toEqual({
			since: later,
			store: { version: "19.2.1", at: later },
		});
		expect(heldSince({ version: "19.2.0", at: "not a time" }, "19.2.0", at(0)).store).not.toBeNull();
	});
});
