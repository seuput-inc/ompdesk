import { describe, expect, it } from "vitest";
import { TabAttention } from "./tab-attention";

function banner() {
	const shown = { closed: 0, close: () => shown.closed++ };
	return shown;
}

describe("TabAttention", () => {
	it("closes a tab's banners once the person looks at it, and no other tab's", () => {
		const attention = new TabAttention();
		const a1 = banner();
		const a2 = banner();
		const b = banner();
		attention.banner("a", a1);
		attention.banner("a", a2);
		attention.banner("b", b);
		attention.seen("a");
		expect([a1.closed, a2.closed, b.closed]).toEqual([1, 1, 0]);
		attention.seen("a");
		expect(a1.closed).toBe(1);
	});

	it("forgets a banner the person clicked or dismissed", () => {
		const attention = new TabAttention();
		const clicked = banner();
		const forget = attention.banner("a", clicked);
		forget();
		attention.seen("a");
		expect(clicked.closed).toBe(0);
	});

	it("names a tab seen after its last run ended, not one that ran again since", () => {
		let now = 0;
		const attention = new TabAttention(() => now);
		attention.settled("a");
		attention.settled("b");
		now = 1;
		attention.seen("a");
		attention.seen("b");
		now = 2;
		attention.settled("b");
		expect(attention.seenSinceRun()).toEqual(["a"]);
		attention.released("a");
		expect(attention.seenSinceRun()).toEqual([]);
	});
});
