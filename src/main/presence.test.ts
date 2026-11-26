import { describe, expect, it } from "vitest";
import { DesktopPresence, PRESENCE_FRESH_MS } from "./presence";

describe("DesktopPresence", () => {
	it("is present while a paired computer lately said its person is there, whatever this one reads", () => {
		let now = 0;
		const presence = new DesktopPresence(
			() => true,
			() => now,
		);
		expect(presence.away()).toBe(true);
		presence.report("pc-b", false);
		expect(presence.away()).toBe(false);
		now = PRESENCE_FRESH_MS + 1;
		expect(presence.away()).toBe(true);
	});

	it("drops a computer whose link ended, and an away report keeps this computer's own read", () => {
		const presence = new DesktopPresence(
			() => undefined,
			() => 0,
		);
		presence.report("pc-b", true);
		expect(presence.away()).toBeUndefined();
		presence.report("pc-b", false);
		presence.forget("pc-b");
		expect(presence.away()).toBeUndefined();
	});
});
