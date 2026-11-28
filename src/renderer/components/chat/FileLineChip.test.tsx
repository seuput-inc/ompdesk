/**
 * Wave A3 tests: `FileLineChip` path/line parsing and click-to-open-at-line behavior.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { parseFileLineRef } from "./FileLineChip";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { FileLineChip } = await import("./FileLineChip");

let root: Root | null = null;
let container: Element | null = null;

async function mount(element: ReactElement): Promise<Element> {
	const host = document.createElement("div") as unknown as Element;
	document.body.appendChild(host as never);
	container = host;
	root = createRoot(host);
	await act(async () => {
		root?.render(<I18nProvider>{element}</I18nProvider>);
	});
	return host;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	vi.restoreAllMocks();
});

describe("parseFileLineRef", () => {
	it("extracts path, line, and optional end line from colon and hash suffixes", () => {
		expect(parseFileLineRef("src/renderer/components/chat/CodeBlock.tsx:109")).toEqual({
			path: "src/renderer/components/chat/CodeBlock.tsx",
			line: 109,
		});
		expect(parseFileLineRef("src/a.ts:12-24")).toEqual({ path: "src/a.ts", line: 12, endLine: 24 });
		expect(parseFileLineRef("src/a.ts:12:4")).toEqual({ path: "src/a.ts", line: 12 });
		expect(parseFileLineRef("src/a.ts#L33-L40")).toEqual({ path: "src/a.ts", line: 33, endLine: 40 });
		expect(parseFileLineRef("C:\\repo\\file.ts")).toEqual({ path: "C:\\repo\\file.ts" });
	});
});

describe("FileLineChip", () => {
	it("renders basename and :line badge and opens the file preview at that line on click", async () => {
		const openSpy = vi.spyOn(useUiStore.getState(), "openFilePreview").mockImplementation(() => {});
		const host = await mount(<FileLineChip path="src/renderer/components/tools/ToolCard.tsx:251" />);
		const chip = host.querySelector("[data-file-line-chip]") as HTMLElement | null;
		expect(chip).not.toBeNull();
		expect(chip?.getAttribute("data-file-line-chip")).toBe("src/renderer/components/tools/ToolCard.tsx");
		expect(chip?.getAttribute("data-file-line")).toBe("251");
		expect(host.querySelector(".omp-file-line-chip-name")?.textContent).toBe("ToolCard.tsx");
		expect(host.querySelector(".omp-file-line-chip-line")?.textContent).toBe(":251");

		await act(async () => {
			chip?.click();
		});
		expect(openSpy).toHaveBeenCalledWith("src/renderer/components/tools/ToolCard.tsx", { line: 251 });
	});
});
