/**
 * SwipeActions: a touch swipe past half an action settles the row open, the uncovered action runs and closes it,
 * and the click a swipe's release makes never presses the row. A mouse drag uncovers nothing.
 */

import { parseHTML } from "linkedom";
import { Archive } from "lucide-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwipeActions } from "./SwipeActions";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

function props(element: Element | null): Record<string, (event: unknown) => void> {
	if (!element) throw new Error("element missing");
	const record = element as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	return (key ? record[key] : {}) as Record<string, (event: unknown) => void>;
}

/** The moves the phone's drawer panel heard: it closes on a swipe left over it (SidebarDrawer's native listener). */
let panelMoves = 0;

async function render(onArchive: () => void, onRow: () => void) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	panelMoves = 0;
	host.addEventListener("pointermove", () => {
		panelMoves += 1;
	});
	root = createRoot(host as unknown as Element);
	await act(async () =>
		root?.render(
			<SwipeActions trailing={[{ id: "archive", label: "Archive", icon: Archive, onSelect: onArchive }]}>
				<button data-row onClick={onRow} type="button">
					Row
				</button>
			</SwipeActions>,
		),
	);
}

const track = () => document.querySelector(".omp-swipe-track");
const isOpen = () => document.querySelector(".omp-swipe")?.hasAttribute("data-swipe-open") ?? false;

/** A touch down, one move `dx` sideways (a real DOM event, so every native listener on its way hears it), and up. */
async function swipe(pointerType: string, dx: number) {
	const point = (clientX: number) => ({ pointerType, pointerId: 1, clientX, clientY: 10, currentTarget: track() });
	await act(async () => props(track()).onPointerDown?.(point(200)));
	await act(async () => {
		track()?.dispatchEvent(Object.assign(new Event("pointermove", { bubbles: true }), point(200 + dx)));
	});
	await act(async () => props(track()).onPointerUp?.(point(200 + dx)));
}

async function clickTrack(): Promise<boolean> {
	let stopped = false;
	await act(async () =>
		props(track()).onClickCapture?.({
			preventDefault: () => {},
			stopPropagation: () => {
				stopped = true;
			},
		}),
	);
	return stopped;
}

describe("SwipeActions", () => {
	it("opens on a left swipe past half an action, swallows the release's click, and runs the action", async () => {
		const onArchive = vi.fn();
		const onRow = vi.fn();
		await render(onArchive, onRow);
		expect(document.querySelector(".omp-swipe-actions")?.hasAttribute("inert")).toBe(true);

		await swipe("touch", -60);
		expect(isOpen()).toBe(true);
		expect(document.querySelector(".omp-swipe-actions")?.hasAttribute("inert")).toBe(false);
		expect(await clickTrack()).toBe(true);
		expect(isOpen()).toBe(false);

		await swipe("touch", -60);
		await act(async () => props(document.querySelector('[data-swipe-action="archive"]')).onClick?.({}));
		expect(onArchive).toHaveBeenCalledTimes(1);
		expect(isOpen()).toBe(false);
	});

	it("springs back from a short swipe and lets a plain tap press the row", async () => {
		await render(vi.fn(), vi.fn());
		await swipe("touch", -20);
		expect(isOpen()).toBe(false);
		await act(async () => props(track()).onPointerDown?.({ pointerType: "touch", clientX: 0, clientY: 0 }));
		expect(await clickTrack()).toBe(false);
	});

	it("uncovers nothing under a mouse drag, which still reaches the listeners above", async () => {
		await render(vi.fn(), vi.fn());
		await swipe("mouse", -120);
		expect(isOpen()).toBe(false);
		expect(panelMoves).toBe(1);
	});

	it("keeps a swipe past the drawer's close distance from the drawer, even in one move", async () => {
		await render(vi.fn(), vi.fn());
		await swipe("touch", -80);
		expect(isOpen()).toBe(true);
		expect(panelMoves).toBe(0);
	});
});
