import { describe, expect, it } from "vitest";
import { DESKTOP_AWAY_SECONDS, DesktopPresence, PRESENCE_FRESH_MS, readDesktopAway } from "./presence";

const monitor = (state: string, idle: number) => ({ getSystemIdleState: () => state, getSystemIdleTime: () => idle });

describe("readDesktopAway", () => {
	it("is away when locked or idle past the threshold, present otherwise", () => {
		expect(readDesktopAway(monitor("locked", 0))).toBe(true);
		expect(readDesktopAway(monitor("idle", 0))).toBe(true);
		expect(readDesktopAway(monitor("active", DESKTOP_AWAY_SECONDS))).toBe(true);
		expect(readDesktopAway(monitor("active", DESKTOP_AWAY_SECONDS - 1))).toBe(false);
	});

	it("says nothing it cannot tell: a throwing monitor or a nonsense idle time", () => {
		expect(readDesktopAway(monitor("unknown", -1))).toBeUndefined();
		expect(
			readDesktopAway({
				getSystemIdleState: () => {
					throw new Error("no idle API");
				},
				getSystemIdleTime: () => 0,
			}),
		).toBeUndefined();
	});
});

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
