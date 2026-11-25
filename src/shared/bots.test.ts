import { describe, expect, it } from "vitest";
import { isQuietResult } from "./bots";

describe("a quiet result", () => {
	it("is an answer whose last line is NO_REPLY, Markdown dressing aside", () => {
		for (const answer of ["NO_REPLY", "Checked the feed.\n\nNO_REPLY\n", "**NO_REPLY**", "`NO_REPLY`.", "- NO_REPLY"])
			expect(isQuietResult(answer), answer).toBe(true);
	});

	it("is never an answer that says something after it or only mentions it", () => {
		for (const answer of ["", "NO_REPLY\nBut the build broke.", "I would answer NO_REPLY here", "NO_REPLY_X"])
			expect(isQuietResult(answer), answer).toBe(false);
	});
});
