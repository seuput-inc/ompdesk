import { describe, expect, it } from "vitest";
import type { Row } from "./chat-stream-utils";
import { countOccurrences, findHits, findScrollDelta, matchSpans, rowFindText, startingHit } from "./transcript-find";

const prompt = (text: string): Row => ({ kind: "message", message: { role: "user", content: text, timestamp: 1 } });
const reply = (text: string): Row => ({
	kind: "message",
	message: {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "thinking", thinking: "hidden apple" },
		],
		timestamp: 2,
	},
});

describe("transcript find", () => {
	it("counts every occurrence in prompts and replies, mounted or not, and nothing else", () => {
		const rows: Row[] = [
			prompt("An apple a day"),
			{ kind: "pending" },
			reply("Apple pie and APPLE juice"),
			prompt("pear"),
		];
		expect(findHits(rows, "apple")).toEqual([
			{ row: 0, nth: 0 },
			{ row: 2, nth: 0 },
			{ row: 2, nth: 1 },
		]);
		expect(findHits(rows, "  ")).toEqual([]);
		// A reply's thinking is folded away: never counted.
		expect(rowFindText(rows[2] as Row)).not.toContain("hidden");
		expect(countOccurrences("aaaa", "aa")).toBe(2);
	});

	it("starts at the first match at or below the reader's row, else the last above it", () => {
		const hits = [
			{ row: 1, nth: 0 },
			{ row: 5, nth: 0 },
			{ row: 9, nth: 0 },
		];
		expect(startingHit(hits, 4)).toBe(1);
		expect(startingHit(hits, 10)).toBe(2);
		expect(startingHit([], 0)).toBe(-1);
	});

	it("finds a match across the text nodes of inline elements, as the reader sees it", () => {
		// "Fix the <b>bu</b>ild now": three text nodes.
		expect(matchSpans(["Fix the ", "bu", "ild now"], "BUILD")).toEqual([{ start: [1, 0], end: [2, 3] }]);
		expect(matchSpans(["ab", "ab"], "ab")).toEqual([
			{ start: [0, 0], end: [1, 0] },
			{ start: [1, 0], end: [1, 2] },
		]);
	});

	it("brings a match mid-view, below the bar when the bar covers it", () => {
		const view = { top: 0, bottom: 400 };
		expect(findScrollDelta({ top: 590, bottom: 610, left: 10, right: 50 }, view, null)).toBe(400);
		const bar = { bottom: 40, left: 0, right: 100 };
		expect(findScrollDelta({ top: 210, bottom: 230, left: 10, right: 50 }, view, bar)).toBe(0);
	});
});
