/**
 * The theme picker's list is a listbox its search field drives: no theme is a tab stop of its own. It lists each
 * of the five sets (which follows the OS), then that set's light and dark theme (which stay); pressing a row
 * applies and saves it.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_SETS } from "../../../shared/theme-names";
import { I18nProvider, translate } from "../../lib/i18n";
import { applyThemeByName, loadSystemThemePair } from "../../lib/themes";
import { useUiStore } from "../../stores/ui";
import { ThemePickerDialog } from "./ThemePickerDialog";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
	localStorage: { getItem: () => null, setItem: () => {} },
});
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

const prefs: Record<string, unknown> = {};
Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		prefs: {
			get: async (key: string): Promise<unknown> => prefs[key],
			set: vi.fn(async (key: string, value: unknown) => {
				prefs[key] = value;
				return true;
			}),
		},
	},
	// A light OS.
	matchMedia: (query: string) => ({
		matches: !query.includes("dark"),
		addEventListener: () => {},
		removeEventListener: () => {},
	}),
});

let root: Root | null = null;

async function open(): Promise<void> {
	useUiStore.setState({ themePickerOpen: true });
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<ThemePickerDialog />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
}

const options = () => Array.from(document.body.querySelectorAll('[role="option"]'));
const entry = (id: string) => document.body.querySelector(`[data-theme-entry="${id}"]`) as HTMLElement;

beforeEach(() => {
	for (const key of Object.keys(prefs)) delete prefs[key];
	loadSystemThemePair(undefined);
	applyThemeByName("system", { persist: false });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useUiStore.setState({ themePickerOpen: false, theme: "system" });
	vi.useRealTimers();
});

describe("ThemePickerDialog", () => {
	it("lists each set, then its light and its dark theme, as options of a listbox the search field points into", async () => {
		await open();
		const listbox = document.body.querySelector('[role="listbox"]');
		expect(listbox).not.toBeNull();
		expect(options().map(option => option.getAttribute("data-theme-entry"))).toEqual(
			THEME_SETS.flatMap(set => [set.id, set.light, set.dark]),
		);
		expect(options().every(option => option.getAttribute("tabindex") === "-1")).toBe(true);
		const field = document.body.querySelector(`input[aria-label="${translate("themePicker.search")}"]`);
		expect(field?.getAttribute("aria-controls")).toBe(listbox?.id);
		expect(field?.getAttribute("aria-activedescendant")).toBe(options()[0]?.id);
		// A set's row shows both halves, a theme's row its own.
		expect(entry("gruvbox").querySelectorAll("[data-theme-preview]")).toHaveLength(2);
		expect(entry("gruvbox-dark").querySelectorAll("[data-theme-preview]")).toHaveLength(1);
	});

	it.each(
		THEME_SETS.flatMap(set => [
			{ row: set.id, themeName: "system", shows: set.light, set },
			{ row: set.light, themeName: set.light, shows: set.light, set },
			{ row: set.dark, themeName: set.dark, shows: set.dark, set },
		]),
	)("pressing $row shows $shows and stores $themeName with the set's pair", async ({ row, themeName, shows, set }) => {
		await open();
		await act(async () => entry(row).click());
		expect(document.documentElement.getAttribute("data-theme-name")).toBe(shows);
		expect(prefs).toMatchObject({ themeName, systemLightTheme: set.light, systemDarkTheme: set.dark });
		expect(useUiStore.getState().theme).toBe(
			themeName === "system" ? "system" : themeName === set.light ? "light" : "dark",
		);
		expect(useUiStore.getState().themePickerOpen).toBe(false);
	});

	it("marks the stored choice as the current row", async () => {
		Object.assign(prefs, { themeName: "solarized-dark" });
		await open();
		const current = options().filter(option => option.textContent?.includes(translate("tabSwitcher.current")));
		expect(current.map(option => option.getAttribute("data-theme-entry"))).toEqual(["solarized-dark"]);
	});
});
