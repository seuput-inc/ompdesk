/**
 * A surface's first-visit tour: it starts once its surface is on screen and one of its controls is, walks the steps
 * whose controls are there (skipping the rest), counts them, and is seen however it ends, so it never starts again.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { useStarterGuideStore } from "../../stores/starter-guide";
import { SurfaceTour } from "./SurfaceTour";
import { useFirstVisitTour } from "./surface-tours";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML(
	"<html><body><div id='app'></div></body></html>",
);
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const stored: Record<string, unknown> = {};
Object.assign(window as unknown as Record<string, unknown>, {
	innerWidth: 1200,
	innerHeight: 800,
	omp: {
		prefs: {
			get: vi.fn(async (key: string) => stored[key]),
			set: vi.fn(async (key: string, value: unknown) => {
				stored[key] = value;
			}),
		},
	},
});
Object.assign(globalThis as Record<string, unknown>, {
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});

let root: Root | undefined;

function addTarget(html: string): void {
	const host = document.createElement("div");
	host.innerHTML = html;
	const target = host.firstElementChild as HTMLElement;
	Object.defineProperty(target, "getBoundingClientRect", {
		value: () => ({ left: 300, top: 200, width: 400, height: 300, right: 700, bottom: 500, x: 300, y: 200 }),
	});
	document.body.appendChild(target);
}

/** The board page as far as its tour sees it: the hook, beside the tour's card. */
function Board() {
	useFirstVisitTour("board");
	return null;
}

async function mount(): Promise<void> {
	root = createRoot(document.getElementById("app") as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<Board />
				<SurfaceTour />
			</I18nProvider>,
		);
	});
}

const card = () => document.querySelector("[data-surface-tour]") as HTMLElement | null;
const button = (label: string) =>
	[...document.querySelectorAll("button")].find(node => node.textContent?.trim() === label) as HTMLElement | undefined;

beforeEach(() => {
	vi.useFakeTimers();
	for (const key of Object.keys(stored)) delete stored[key];
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	vi.useRealTimers();
	document.body.innerHTML = "<div id='app'></div>";
	useStarterGuideStore.getState().reset();
});

describe("SurfaceTour", () => {
	it("starts on the first visit, skips a step whose control is missing and is seen at its end", async () => {
		addTarget("<div data-board-lanes></div>");
		addTarget("<button data-board-window>Window</button>");
		await mount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(card()?.getAttribute("data-surface-tour-step")).toBe("lanes");
		expect(card()?.textContent).toContain(translate("tour.progress", { n: 1, total: 2 }));
		await act(async () => button(translate("tour.next"))?.click());
		// The chips step had no control on screen: the window step comes next, and it is the last.
		expect(card()?.getAttribute("data-surface-tour-step")).toBe("window");
		await act(async () => button(translate("tour.done"))?.click());
		expect(card()).toBeNull();
		expect(useStarterGuideStore.getState().toursSeen).toContain("board");
		expect(stored.starterGuide).toMatchObject({ toursSeen: ["board"] });
	});

	it("never starts again once seen, and not without any of its controls", async () => {
		stored.starterGuide = { done: [], dismissed: false, toursSeen: ["board"], tipsSeen: [] };
		addTarget("<div data-board-lanes></div>");
		await mount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(card()).toBeNull();
		await act(async () => root?.unmount());
		document.body.innerHTML = "<div id='app'></div>";
		useStarterGuideStore.getState().reset();
		stored.starterGuide = undefined;
		await mount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(useStarterGuideStore.getState().surfaceTour).toBeNull();
	});

	it("is seen when skipped with Escape", async () => {
		addTarget("<div data-board-lanes></div>");
		addTarget("<div data-board-chips></div>");
		await mount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		await act(async () => {
			const keydown = new Event("keydown", { bubbles: true });
			Object.assign(keydown, { key: "Escape" });
			card()?.dispatchEvent(keydown);
		});
		expect(card()).toBeNull();
		expect(useStarterGuideStore.getState().toursSeen).toEqual(["board"]);
	});

	it("ends, seen, when its surface leaves while it runs", async () => {
		addTarget("<div data-board-lanes></div>");
		await mount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(card()).not.toBeNull();
		await act(async () => {
			root?.render(
				<I18nProvider>
					<SurfaceTour />
				</I18nProvider>,
			);
		});
		expect(card()).toBeNull();
		expect(useStarterGuideStore.getState().toursSeen).toEqual(["board"]);
	});

	it("leaves the keyboard to the app: nothing in the card takes focus and no dialog holds the shortcuts", async () => {
		addTarget("<div data-board-lanes></div>");
		const focus = vi.spyOn(HTMLElement.prototype, "focus");
		await mount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(card()).not.toBeNull();
		expect(focus.mock.contexts.filter(node => card()?.contains(node as Node))).toEqual([]);
		focus.mockRestore();
		// App's shortcut guard and dialog-layer read any [role=dialog] as a modal that owns the keyboard.
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});
});
