import { describe, expect, it } from "vitest";
import type { ReviewNote } from "../stores/review-notes";
import { translate } from "./i18n";
import { formatFileNote, quoteExcerpt, reviewNotesMessage } from "./review-notes";

const note = (anchor: ReviewNote["anchor"], body: string, createdAt = 1): ReviewNote => ({
	id: `${createdAt}`,
	owner: "|s:1",
	anchor,
	body,
	createdAt,
});

describe("review notes message", () => {
	it("keeps a comment inside its quotes whatever it holds (Orca's quote-safe block)", () => {
		expect(
			formatFileNote({ kind: "diff", path: "src/a.ts", lines: { start: 3, end: 3 } }, 'say "hi"\nthen \\ go'),
		).toBe(["File: src/a.ts", "Line: 3", 'User comment: "say \\"hi\\"\\nthen \\\\ go"'].join("\n"));
		expect(formatFileNote({ kind: "diff", path: "src/a.ts", lines: null }, "x")).toContain("Scope: file");
	});

	it("sends a Files passage with its excerpt, and its lines only when the view numbered them", () => {
		const text = formatFileNote(
			{ kind: "text", path: "docs/a.md", markdown: true, lines: null, excerpt: "first\nsecond" },
			"clearer",
		);
		expect(text).toBe(
			["File: docs/a.md", "Source: markdown", "Excerpt:\n> first\n> second", 'User comment: "clearer"'].join("\n"),
		);
	});

	it("cuts a long excerpt to its first and last four lines", () => {
		const quoted = quoteExcerpt(Array.from({ length: 12 }, (_, index) => `l${index + 1}`).join("\n"));
		expect(quoted.split("\n")).toEqual(["> l1", "> l2", "> l3", "> l4", "> ...", "> l9", "> l10", "> l11", "> l12"]);
	});

	it("orders files by path and line, then each Preview page under its header with its screenshots", () => {
		const message = reviewNotesMessage(translate, [
			note({ kind: "diff", path: "b.ts", lines: { start: 1, end: 2 } }, "two", 1),
			note({ kind: "diff", path: "a.ts", lines: { start: 9, end: 9 } }, "nine", 2),
			note(
				{
					kind: "preview",
					page: "p1\nhttp://x/",
					title: "X",
					url: "http://x/",
					n: 1,
					pick: "region",
					elements: [],
					image: "AAAA",
				},
				"tighter",
				3,
			),
		]);
		expect(message.text.indexOf("File: a.ts")).toBeLessThan(message.text.indexOf("File: b.ts"));
		expect(message.text).toContain("Lines: 1-2");
		expect(message.text).toContain('Feedback on the page "X" (http://x/):');
		expect(message.images).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
	});
});
