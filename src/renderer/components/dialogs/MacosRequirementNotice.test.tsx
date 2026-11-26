/**
 * The macOS notice: shown once per required macOS when the updater withholds a release this Mac cannot run, its
 * guide button opens Apple's page, and closing it remembers that macOS so it never comes back for it.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../../shared/ipc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useUpdaterStore } from "../../stores/updater";
import { MACOS_REQUIREMENT_PREF, MACOS_UPDATE_GUIDE_URL, MacosRequirementNotice } from "./MacosRequirementNotice";

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

const prefs = new Map<string, unknown>();
const openExternal = vi.fn(() => Promise.resolve());
let root: Root | null = null;

const NEEDS_15: UpdateStatus = {
	state: "not-available",
	version: "0.140.0",
	unsupportedSystem: { version: "0.141.0", minimumMacOS: "15" },
};

async function mount(status: UpdateStatus): Promise<void> {
	useUpdaterStore.setState({ status });
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<MacosRequirementNotice />
			</I18nProvider>,
		);
	});
}

function button(label: string): InstanceType<typeof HTMLElement> {
	const found = [...document.querySelectorAll("button")].find(b => b.textContent?.includes(label));
	if (!found) throw new Error(`no button ${label}`);
	return found as unknown as InstanceType<typeof HTMLElement>;
}

beforeEach(() => {
	prefs.clear();
	Object.assign(window as unknown as Record<string, unknown>, {
		omp: {
			prefs: {
				get: (key: string) => Promise.resolve(prefs.get(key) ?? null),
				set: (key: string, value: unknown) => {
					prefs.set(key, value);
					return Promise.resolve();
				},
			},
			system: { openExternal },
		},
	});
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	openExternal.mockClear();
});

describe("MacosRequirementNotice", () => {
	it("names the macOS the withheld release needs and opens Apple's guide", async () => {
		await mount(NEEDS_15);
		expect(document.body.textContent).toContain(translate("macosRequirement.title", { macos: "15" }));
		expect(document.querySelector("[data-macos-requirement='15']")).not.toBeNull();
		await act(async () => {
			button(translate("macosRequirement.guide")).dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(openExternal).toHaveBeenCalledWith(MACOS_UPDATE_GUIDE_URL);
		expect(prefs.get(MACOS_REQUIREMENT_PREF)).toBe("15");
		expect(document.querySelector("[data-macos-requirement]")).toBeNull();
	});

	it("stays away once that macOS was seen, and shows nothing for a plain up-to-date check", async () => {
		prefs.set(MACOS_REQUIREMENT_PREF, "15");
		await mount(NEEDS_15);
		expect(document.querySelector("[data-macos-requirement]")).toBeNull();
		await act(async () => root?.unmount());
		await mount({ state: "not-available", version: "0.140.0" });
		expect(document.querySelector("[data-macos-requirement]")).toBeNull();
	});

	it("comes back when a later release needs a newer macOS than the one seen", async () => {
		prefs.set(MACOS_REQUIREMENT_PREF, "14");
		await mount(NEEDS_15);
		expect(document.querySelector("[data-macos-requirement='15']")).not.toBeNull();
		await act(async () => {
			button(translate("macosRequirement.dismiss")).dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(prefs.get(MACOS_REQUIREMENT_PREF)).toBe("15");
		expect(openExternal).not.toHaveBeenCalled();
	});
});
