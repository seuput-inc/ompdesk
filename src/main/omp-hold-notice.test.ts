import { describe, expect, it } from "vitest";
import { HOLD_RETELL_MS, holdNotice, parseHoldTold } from "./omp-hold-notice";

const SINCE = "2026-11-20T00:00:00.000Z";
const at = (ms: number) => Date.parse(SINCE) + ms;
const failed = { version: "19.1.0", reason: "failed", since: SINCE } as const;

describe("holdNotice", () => {
	it("tells a hold once when first seen, once more after a day with the days, then never again", () => {
		const first = holdNotice(failed, null, at(60_000));
		expect(first.notice).toEqual({ version: "19.1.0", days: 0 });
		// Every later check within the day (each 4 h, and a relaunch reading what was told) says nothing.
		expect(holdNotice(failed, first.told, at(HOLD_RETELL_MS - 1)).notice).toBeNull();
		const second = holdNotice(failed, first.told, at(HOLD_RETELL_MS + 3_600_000));
		expect(second.notice).toEqual({ version: "19.1.0", days: 1 });
		expect(holdNotice(failed, second.told, at(5 * HOLD_RETELL_MS)).notice).toBeNull();
	});

	it("tells a hold first seen days late once, with its days, and sends no second notice", () => {
		const late = holdNotice(failed, null, at(3 * HOLD_RETELL_MS + 1));
		expect(late.notice).toEqual({ version: "19.1.0", days: 3 });
		expect(holdNotice(failed, late.told, at(4 * HOLD_RETELL_MS)).notice).toBeNull();
	});

	it("tells a newer held version afresh", () => {
		const told = holdNotice(failed, null, at(0)).told;
		const next = holdNotice({ ...failed, version: "19.1.1" }, told, at(1000));
		expect(next.notice?.version).toBe("19.1.1");
	});

	it("says nothing about a version that only waits for the checks, or about no hold, and keeps what was told", () => {
		const told = { version: "19.1.0", retold: false };
		for (const held of [null, undefined, { version: "19.2.0", reason: "verifying" } as const]) {
			expect(holdNotice(held, told, at(0))).toEqual({ notice: null, told });
		}
	});

	it("reads back only a stored record of its own shape", () => {
		expect(parseHoldTold({ version: "19.1.0", retold: true })).toEqual({ version: "19.1.0", retold: true });
		expect(parseHoldTold({ version: 19, retold: true })).toBeNull();
		expect(parseHoldTold("19.1.0")).toBeNull();
	});
});
