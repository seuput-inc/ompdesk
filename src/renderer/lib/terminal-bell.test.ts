import { describe, expect, it } from "vitest";
import { bellMarks } from "./terminal-bell";

describe("bellMarks", () => {
	it("marks a terminal nobody sees: the page hidden or its tab not shown", () => {
		expect(bellMarks({ shown: true, pageHidden: true, muted: false })).toBe(true);
		expect(bellMarks({ shown: false, pageHidden: false, muted: false })).toBe(true);
	});

	it("leaves a terminal on screen, and a muted project's, unmarked", () => {
		expect(bellMarks({ shown: true, pageHidden: false, muted: false })).toBe(false);
		expect(bellMarks({ shown: false, pageHidden: true, muted: true })).toBe(false);
	});
});
