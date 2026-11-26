/**
 * "Remove OMPdesk from this computer": the confirmation names memory's terminal link only when it is on, the page
 * hands the whole removal to main, and a run the running-work guard kept (null) closes the dialog with nothing removed.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { RemoveFromComputerRow } from "./RemoveFromComputerRow";

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
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const calls: string[] = [];
let terminal = false;
let guardKeeps = false;
let root: Root | null = null;

function click(label: string): Promise<void> {
	const target = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === label);
	if (!target) throw new Error(`no button ${label}`);
	return act(async () => {
		target.dispatchEvent(new Event("click", { bubbles: true }));
	});
}

beforeEach(async () => {
	calls.length = 0;
	Object.assign(window as unknown as Record<string, unknown>, {
		omp: {
			aiMemory: {
				getState: () => Promise.resolve({ wiring: { app: true, terminal } }),
			},
			app: {
				removeFromComputer: () => {
					calls.push("remove");
					return Promise.resolve(
						guardKeeps ? null : { removed: ["/x/bin/ompdesk"], terminal: "removed", app: "finder" },
					);
				},
			},
		},
	});
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<RemoveFromComputerRow />
			</I18nProvider>,
		);
	});
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	terminal = false;
	guardKeeps = false;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
});

describe("RemoveFromComputerRow", () => {
	it("names the terminal link when it is on and hands the removal to main", async () => {
		terminal = true;
		await click(translate("settings.remove.action"));
		expect(document.body.textContent).toContain(translate("settings.remove.goesTerminal"));
		await click(translate("settings.remove.confirm"));
		expect(calls).toEqual(["remove"]);
		// The app is quitting: the dialog stays until it does.
		expect(document.body.textContent).toContain(translate("settings.remove.title"));
	});

	it("leaves the terminal unnamed when it was never linked, and is done when the guard keeps the app", async () => {
		guardKeeps = true;
		await click(translate("settings.remove.action"));
		expect(document.body.textContent).not.toContain(translate("settings.remove.goesTerminal"));
		await click(translate("settings.remove.confirm"));
		expect(calls).toEqual(["remove"]);
		// Nothing failed: a kept app is no error.
		expect(document.body.textContent).not.toContain(translate("settings.remove.failed"));
	});
});
