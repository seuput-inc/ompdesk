/**
 * Help › What OMPdesk can do: every capability with its action; one already in use says so; Open goes to the place
 * and closes the sheet; Show me runs the getting-started spotlight of its step.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { useStarterGuideStore } from "../../stores/starter-guide";
import { useUiStore } from "../../stores/ui";
import { CAPABILITIES, CapabilitiesSheet } from "./CapabilitiesSheet";

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
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) } },
});

let root: Root | undefined;

async function mount(): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<CapabilitiesSheet />
			</I18nProvider>,
		);
	});
}

const row = (id: string) => document.querySelector(`[data-capability="${id}"]`) as HTMLElement | null;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	useStarterGuideStore.getState().reset();
	useUiStore.setState({ capabilitiesOpen: false, destination: "session", themePickerOpen: false });
});

describe("CapabilitiesSheet", () => {
	it("lists every capability, says which are in use, and Open goes there and closes the sheet", async () => {
		useStarterGuideStore.setState({ done: ["look"] });
		useUiStore.setState({ capabilitiesOpen: true });
		await mount();
		expect(document.querySelectorAll("[data-capability]")).toHaveLength(CAPABILITIES.length);
		expect(row("look")?.textContent).toContain(translate("capabilities.inUse"));
		expect(row("board")?.textContent).not.toContain(translate("capabilities.inUse"));
		const open = [...(row("board")?.querySelectorAll("button") ?? [])].find(
			node => node.textContent?.trim() === translate("capabilities.open"),
		);
		await act(async () => open?.click());
		expect(useUiStore.getState().destination).toBe("board");
		expect(useUiStore.getState().capabilitiesOpen).toBe(false);
	});

	it("Show me runs the step's spotlight", async () => {
		useUiStore.setState({ capabilitiesOpen: true });
		await mount();
		const show = [...(row("parallel")?.querySelectorAll("button") ?? [])].find(
			node => node.textContent?.trim() === translate("capabilities.showMe"),
		);
		await act(async () => show?.click());
		expect(useStarterGuideStore.getState().tour).toBe("split");
	});
});
