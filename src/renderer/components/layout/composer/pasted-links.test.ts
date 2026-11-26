import { DOMParser } from "linkedom";
import { beforeAll, describe, expect, it } from "vitest";
import { linkedSelectionText, withPastedLinks } from "./pasted-links";

beforeAll(() => {
	(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;
});

describe("links in a paste", () => {
	it("links selected words with one pasted URL, and nothing else", () => {
		expect(linkedSelectionText("the docs", " https://example.com/a_(b) ")).toBe(
			"[the docs](https://example.com/a_%28b%29)",
		);
		expect(linkedSelectionText("the [docs]", "https://x.dev")).toBe("[the \\[docs\\]](https://x.dev)");
		expect(linkedSelectionText("", "https://x.dev")).toBeNull();
		expect(linkedSelectionText("two\nlines", "https://x.dev")).toBeNull();
		expect(linkedSelectionText("words", "not a url")).toBeNull();
		expect(linkedSelectionText("words", "javascript:alert(1)")).toBeNull();
		// A URL selected and replaced by another is a plain replacement.
		expect(linkedSelectionText("https://a.dev", "https://b.dev")).toBeNull();
	});

	it("keeps a rich copy's links as Markdown, whole words only, and leaves plain copies alone", () => {
		// A bare URL that names itself stays as written.
		const html =
			'<p>See <a href="https://x.dev/guide">the guide</a> at <a href="https://x.dev">https://x.dev</a>.</p>';
		expect(withPastedLinks("See the guide at https://x.dev.", html)).toBe(
			"See [the guide](https://x.dev/guide) at https://x.dev.",
		);
		expect(withPastedLinks("plain", null)).toBe("plain");
		expect(withPastedLinks("cat category", '<a href="https://c.at">cat</a>')).toBe("[cat](https://c.at) category");
		expect(withPastedLinks("categorical", '<a href="https://c.at">cat</a>')).toBe("categorical");
	});
});
