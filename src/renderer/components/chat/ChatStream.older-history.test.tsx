/**
 * A transcript asks its computer for the page above the loaded history when the reader's view comes near its top,
 * whichever way the view got there. A touch fling scrolls on after the finger lifted, so a phone reaches the top on
 * scroll events that arrive after `touchend` (H30: a paired phone's page loaded no older messages there).
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, RpcCommand, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
const browser = {
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	requestAnimationFrame: (frame: FrameRequestCallback) => {
		frames.set(++frameId, frame);
		return frameId;
	},
	cancelAnimationFrame: (id: number) => {
		frames.delete(id);
	},
	ResizeObserver: class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
};
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	...browser,
});
Object.assign(window, browser);
// linkedom lays nothing out: every box is a 400 × 600 view over 5000 px of rows, scrolled where a test puts it.
const scrollTops = new WeakMap<object, number>();
Object.defineProperties(HTMLElement.prototype, {
	offsetWidth: { configurable: true, get: () => 400 },
	offsetHeight: { configurable: true, get: () => 600 },
	clientWidth: { configurable: true, get: () => 400 },
	clientHeight: { configurable: true, get: () => 600 },
	scrollHeight: { configurable: true, get: () => 5000 },
	scrollTop: {
		configurable: true,
		get(this: HTMLElement) {
			return scrollTops.get(this) ?? 0;
		},
		set(this: HTMLElement, top: number) {
			scrollTops.set(this, top);
		},
	},
	getBoundingClientRect: {
		configurable: true,
		value: () => ({ x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 400, width: 400, height: 0 }),
	},
});

// Loaded after the DOM above is installed: react-dom and the transcript's modules read it as they load.
const { createRoot } = await import("react-dom/client");
const { ChatStream } = await import("./ChatStream");

const OLDER: AgentMessage = { role: "user", content: "older question", timestamp: 1, entryId: "older" };
const TAIL: AgentMessage[] = [
	{ role: "user", content: "newer question", timestamp: 2, entryId: "newer" },
	{ role: "assistant", content: [{ type: "text", text: "newer answer" }], timestamp: 3, entryId: "answer" },
];

const command = vi.fn(
	async (sent: RpcCommand): Promise<RpcResponse> => ({
		type: "response",
		command: sent.type,
		success: true,
		data: sent.type === "get_transcript_page" ? { messages: [OLDER], totalMessages: 3 } : null,
	}),
);
/** The pages of history the transcript asked its computer for. */
const pagesAsked = () => command.mock.calls.flatMap(([sent]) => (sent.type === "get_transcript_page" ? [sent] : []));

let root: Root | undefined;

/** A session's newest page on screen, following its tail, with a page of older history above it. */
async function mountTranscript(): Promise<HTMLElement> {
	Object.assign(window, { omp: { rpc: { command } } });
	useMessagesStore.setState({ messages: TAIL, prevCursor: "page-above" });
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<ChatStream />
			</I18nProvider>,
		),
	);
	const scroller = host.querySelector<HTMLElement>(".omp-transcript-scroll");
	if (!scroller) throw new Error("the transcript did not mount");
	scroller.scrollTop = 4400;
	return scroller;
}

async function fire(target: HTMLElement, type: string, init: Record<string, unknown> = {}): Promise<void> {
	await act(async () => {
		target.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), init));
	});
}

/** The view moves to `top`, as the browser reports it. */
async function scrollTo(scroller: HTMLElement, top: number): Promise<void> {
	scroller.scrollTop = top;
	await fire(scroller, "scroll");
}

/** The frames and tasks a received page waits for before it lands (`loadOlderTranscript`). */
async function paint(): Promise<void> {
	for (let round = 0; round < 6; round++)
		await act(async () => {
			const due = [...frames.values()];
			frames.clear();
			for (const frame of due) frame(0);
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	frames.clear();
	command.mockClear();
	useMessagesStore.getState().reset();
	useSessionStore.getState().reset();
});

describe("older history at the top of a transcript", () => {
	it("is asked for when a touch fling reaches the top after the finger lifted", async () => {
		const scroller = await mountTranscript();
		// Linkedom's stylesheet declarations preserve !important; its inline style proxy does not.
		const sheet = document.createElement("style");
		sheet.textContent = ".scroller { overflow-y: auto; }";
		const rule = sheet.sheet?.cssRules[0];
		if (!rule || !("style" in rule)) throw new Error("missing scroller declaration");
		Object.defineProperty(scroller, "style", { value: rule.style });
		// The thumb drags the view off the tail and lifts; the fling carries the view on.
		await fire(scroller, "touchmove");
		await scrollTo(scroller, 3000);
		await fire(scroller, "touchend");
		expect(pagesAsked()).toEqual([]);

		await scrollTo(scroller, 120);
		expect(pagesAsked()).toMatchObject([{ cursor: "page-above" }]);
		await paint();
		expect(scroller.style.getPropertyValue("overflow-y")).toBe("auto");
		expect(scroller.style.getPropertyPriority("overflow-y")).toBe("");
		expect(useMessagesStore.getState().messages.map(message => message.entryId)).toEqual([
			"older",
			"newer",
			"answer",
		]);
	});

	it("is asked for when a wheel brings the view to the top", async () => {
		const scroller = await mountTranscript();
		await fire(scroller, "wheel", { deltaY: -120 });
		await scrollTo(scroller, 120);
		expect(pagesAsked()).toMatchObject([{ cursor: "page-above" }]);
	});

	it("is not asked for by a transcript that still follows its tail", async () => {
		// A loaded page shorter than the view sits at the top without the reader having gone there.
		const scroller = await mountTranscript();
		await scrollTo(scroller, 0);
		expect(pagesAsked()).toEqual([]);
	});
});
