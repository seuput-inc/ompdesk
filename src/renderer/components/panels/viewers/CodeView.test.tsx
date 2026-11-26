import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { CodeView } from "./CodeView";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
// linkedom has no focus model: record what `focus()` reached.
let focused: HTMLElement | null = null;
Object.defineProperty(HTMLElement.prototype, "focus", {
	configurable: true,
	value(this: HTMLElement) {
		focused = this;
	},
});

let root: Root | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.innerHTML = "";
	focused = null;
});

describe("CodeView show all lines", () => {
	it("hands focus to the first line it revealed when the button goes away", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		const code = Array.from({ length: 5003 }, (_, i) => `row ${i + 1}`).join("\n");
		await act(async () =>
			root?.render(
				<I18nProvider>
					<CodeView code={code} language="plaintext" wrap={false} />
				</I18nProvider>,
			),
		);
		const more = Array.from(document.querySelectorAll("button")).at(-1) as HTMLElement;
		await act(async () => more.click());
		expect(document.querySelectorAll("button")).toHaveLength(0);
		expect(focused?.textContent).toContain("row 5001");
		expect(focused?.getAttribute("tabindex")).toBe("-1");
	});
});

describe("CodeView blame", () => {
	const render = async (blame: Parameters<typeof CodeView>[0]["blame"]) => {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<I18nProvider>
					<CodeView blame={blame} code={"a\nb\nc\nd"} language="plaintext" wrap={false} />
				</I18nProvider>,
			),
		);
	};
	const commit = (sha: string, uncommitted = false) => ({
		sha: sha.repeat(40),
		shortSha: sha.repeat(7),
		author: "Ada",
		date: Date.now(),
		summary: `Commit ${sha}`,
		uncommitted,
	});

	it("names each run's commit once, on the run's first line", async () => {
		await render({ commits: [commit("1"), commit("0", true)], lines: [0, 0, 1, 0], truncated: false });
		const marks = Array.from(document.querySelectorAll("[data-blame-line]"));
		expect(marks.map(mark => mark.closest("[data-line]")?.getAttribute("data-line"))).toEqual(["1", "3", "4"]);
		expect(marks[0]?.textContent).toContain("1111111 Ada");
		expect(marks[0]?.getAttribute("title")).toBe("Commit 1");
		expect(marks[1]?.textContent).toBe("Not committed yet");
	});

	it("says once that a file has no blame, and shows its lines", async () => {
		await render("failed");
		expect(document.querySelectorAll("[data-blame-unavailable]")).toHaveLength(1);
		expect(document.querySelectorAll("[data-blame-line]")).toHaveLength(0);
		expect(document.querySelectorAll("[data-line]")).toHaveLength(4);
	});
});
