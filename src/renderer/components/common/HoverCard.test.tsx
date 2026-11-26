/**
 * HoverCard with a mouse and a keyboard: it opens after the hover delay or at once on keyboard focus, mounts its
 * content only while open, describes the link only while shown, and goes with leaving, a press, Escape or blur.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOVER_CARD_DELAY_MS, HoverCard } from "./HoverCard";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let keyboardFocus = true;
let mounted = 0;

function Content() {
	mounted++;
	return <span>octo/app #42</span>;
}

beforeEach(() => {
	vi.useFakeTimers();
	keyboardFocus = true;
	mounted = 0;
	const matches = HTMLElement.prototype.matches;
	vi.spyOn(HTMLElement.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
		return selector === ":focus-visible" ? keyboardFocus : matches.call(this, selector);
	});
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function mount() {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host as unknown as Element);
	await act(async () =>
		root?.render(
			<HoverCard content={<Content />}>
				<a href="https://github.com/octo/app/pull/42">the pull request</a>
			</HoverCard>,
		),
	);
	return host.querySelector("a") as unknown as HTMLElement;
}

const card = () => document.querySelector("[data-hover-card]");

async function fire(target: EventTarget, type: string, init: Record<string, unknown> = {}) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(event, init);
	await act(async () => target.dispatchEvent(event));
}

describe("HoverCard", () => {
	it("opens after the hover delay with its content mounted only then, and goes when the pointer leaves", async () => {
		const link = await mount();
		expect(mounted).toBe(0);
		await fire(link, "pointerover", { pointerType: "mouse", buttons: 0 });
		await act(async () => vi.advanceTimersByTime(HOVER_CARD_DELAY_MS - 50));
		expect(card()).toBeNull();
		await act(async () => vi.advanceTimersByTime(50));
		expect(card()?.textContent).toBe("octo/app #42");
		expect(mounted).toBeGreaterThan(0);
		expect(link.getAttribute("aria-describedby")).toBe(card()?.id);
		await fire(link, "pointerout", { pointerType: "mouse" });
		expect(card()).toBeNull();
		expect(link.getAttribute("aria-describedby")).toBeNull();
	});

	it("never opens for a drag that enters the link", async () => {
		const link = await mount();
		await fire(link, "pointerover", { pointerType: "mouse", buttons: 1 });
		await act(async () => vi.advanceTimersByTime(HOVER_CARD_DELAY_MS * 2));
		expect(card()).toBeNull();
	});

	it("opens at once on keyboard focus, not on a click's focus, and goes with Escape, a press or blur", async () => {
		const link = await mount();
		keyboardFocus = false;
		await fire(link, "focusin");
		expect(card()).toBeNull();
		keyboardFocus = true;
		await fire(link, "focusin");
		expect(card()).not.toBeNull();
		await fire(document, "keydown", { key: "Escape" });
		expect(card()).toBeNull();
		await fire(link, "focusin");
		await fire(link, "pointerdown", { pointerType: "mouse" });
		expect(card()).toBeNull();
		await fire(link, "focusin");
		await fire(link, "focusout");
		expect(card()).toBeNull();
	});
});
