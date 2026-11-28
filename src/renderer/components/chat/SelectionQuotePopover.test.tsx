/**
 * Wave A3 tests: Selection-to-quote formatting, UI-chrome filtering, and one-click quote
 * handoff directly into the active session composer.
 */
import { parseHTML } from "linkedom";
import { act, createRef } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import type { ComposerStore } from "../../stores/composer";
import { sessionRuntimeStore } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import {
	formatSelectionQuote,
	isNonQuotableSelectionNode,
	readQuotableTranscriptSelection,
} from "./SelectionQuotePopover";

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
const { default: SelectionQuotePopover } = await import("./SelectionQuotePopover");

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	sessionRuntimeStore<ComposerStore>("tab-1", "composer")?.getState().reset();
	useTabsStore.setState({ tabs: [], activeTabId: null });
	Reflect.deleteProperty(window, "getSelection");
	vi.restoreAllMocks();
});

describe("SelectionQuotePopover helpers", () => {
	it("formats single- and multi-line selections as Markdown blockquotes", () => {
		expect(formatSelectionQuote("Use sandbox='allow-scripts'")).toBe("> Use sandbox='allow-scripts'\n\n");
		expect(formatSelectionQuote("Line one\n\nLine two")).toBe("> Line one\n>\n> Line two\n\n");
		expect(formatSelectionQuote("   ")).toBe("");
	});

	it("rejects selections inside buttons, message actions, and figure/tool headers", () => {
		const rootEl = document.createElement("div") as unknown as HTMLElement;
		rootEl.innerHTML = [
			'<div class="markdown-body"><p id="prose">Quotable reply text</p></div>',
			'<div class="omp-message-actions"><time id="clock">12:00</time></div>',
			'<button class="omp-tool-header"><span id="tool">Edit file</span></button>',
		].join("");
		document.body.appendChild(rootEl as never);

		const proseText = rootEl.querySelector("#prose")?.firstChild ?? null;
		const clockText = rootEl.querySelector("#clock")?.firstChild ?? null;
		const toolText = rootEl.querySelector("#tool")?.firstChild ?? null;

		expect(isNonQuotableSelectionNode(proseText, rootEl)).toBe(false);
		expect(isNonQuotableSelectionNode(clockText, rootEl)).toBe(true);
		expect(isNonQuotableSelectionNode(toolText, rootEl)).toBe(true);

		const makeRange = (node: Node) =>
			({
				commonAncestorContainer: node,
				startContainer: node,
				endContainer: node,
				getClientRects: () => [{ left: 20, right: 120, top: 40, bottom: 60 }],
				getBoundingClientRect: () => ({ left: 20, right: 120, top: 40, bottom: 60 }),
			}) as unknown as Range;

		Reflect.set(window, "getSelection", () => ({
			isCollapsed: false,
			rangeCount: 1,
			getRangeAt: () => makeRange(clockText as Node),
			toString: () => "12:00",
			removeAllRanges: () => {},
		}));
		expect(readQuotableTranscriptSelection(rootEl)).toBeNull();

		Reflect.set(window, "getSelection", () => ({
			isCollapsed: false,
			rangeCount: 1,
			getRangeAt: () => makeRange(proseText as Node),
			toString: () => "Quotable reply text",
			removeAllRanges: () => {},
		}));
		expect(readQuotableTranscriptSelection(rootEl)?.text).toBe("Quotable reply text");
		rootEl.remove();
	});

	it("quotes selected prose directly into the active session composer in one click", async () => {
		vi.useFakeTimers();
		try {
			useTabsStore.setState({
				tabs: [{ id: "tab-1", label: "Main", cwd: "/repo", status: "ready", title: "Main" }],
				activeTabId: "tab-1",
			});

			const host = document.createElement("div") as unknown as HTMLElement;
			host.innerHTML = '<div class="markdown-body"><p id="p">Keep first-screen JS flat</p></div>';
			document.body.appendChild(host as never);
			container = host;
			Object.defineProperty(host, "getBoundingClientRect", {
				value: () => ({ left: 0, right: 800, top: 0, bottom: 600, width: 800, height: 600 }),
			});

			const proseText = host.querySelector("#p")?.firstChild as Node;
			const removeAllRanges = vi.fn();
			const fakeRange = {
				commonAncestorContainer: proseText,
				startContainer: proseText,
				endContainer: proseText,
				getClientRects: () => [{ left: 40, right: 200, top: 100, bottom: 120 }],
				getBoundingClientRect: () => ({ left: 40, right: 200, top: 100, bottom: 120 }),
			} as unknown as Range;
			Reflect.set(window, "getSelection", () => ({
				isCollapsed: false,
				rangeCount: 1,
				getRangeAt: () => fakeRange,
				toString: () => "Keep first-screen JS flat",
				removeAllRanges,
			}));

			const rootRef = createRef<HTMLElement | null>();
			rootRef.current = host;
			const mountPoint = document.createElement("div");
			document.body.appendChild(mountPoint);
			root = createRoot(mountPoint);
			await act(async () => {
				root?.render(
					<I18nProvider>
						<SelectionQuotePopover rootRef={rootRef} tabId="tab-1" />
					</I18nProvider>,
				);
			});

			await act(async () => {
				document.dispatchEvent(new Event("selectionchange"));
				window.dispatchEvent(Object.assign(new Event("mouseup"), { button: 0, detail: 1 }));
				await vi.advanceTimersByTimeAsync(20);
			});

			const popover = document.querySelector("[data-selection-actions]");
			expect(popover).not.toBeNull();
			const quoteBtn = Array.from(popover?.querySelectorAll("button") ?? []).find(btn =>
				btn.textContent?.includes("Add to chat"),
			) as HTMLElement | undefined;
			expect(quoteBtn).toBeDefined();

			await act(async () => {
				quoteBtn?.click();
				await vi.advanceTimersByTimeAsync(20);
			});

			expect(removeAllRanges).toHaveBeenCalledTimes(1);
			expect(sessionRuntimeStore<ComposerStore>("tab-1", "composer")?.getState().draft).toBe(
				"> Keep first-screen JS flat\n\n",
			);
			mountPoint.remove();
		} finally {
			vi.useRealTimers();
		}
	});
});
