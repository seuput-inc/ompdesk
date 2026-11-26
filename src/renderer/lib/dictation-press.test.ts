import { describe, expect, it } from "vitest";
import { DictationPress, HOLD_MS } from "./dictation-press";

describe("a dictation press", () => {
	it("a tap starts a take that runs until the next press", () => {
		const press = new DictationPress();
		expect(press.down(0, false)).toBe("start");
		expect(press.up(HOLD_MS - 1)).toBeNull();
		expect(press.holding).toBe(false);
		expect(press.down(5_000, true)).toBe("stop");
		expect(press.up(5_100)).toBeNull();
	});

	it("a press held long enough records until its release, and holds off the silence stop meanwhile", () => {
		const press = new DictationPress();
		expect(press.down(0, false)).toBe("start");
		expect(press.holding).toBe(true);
		expect(press.up(HOLD_MS)).toBe("stop");
		expect(press.holding).toBe(false);
	});
});
