/**
 * Settings › Appearance › Theme: exactly five sets, each card previewing its light and dark half; a set follows
 * the OS between its halves unless the person keeps it light or dark; every press applies and saves at once, and
 * what older versions stored (one theme id, or System with a pair) reads as a set and a mode.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_SETS } from "../../../shared/theme-names";
import { I18nProvider, translate } from "../../lib/i18n";
import { applyThemeByName, loadSystemThemePair, THEMES } from "../../lib/themes";
import { useUiStore } from "../../stores/ui";
import { ThemePicker } from "./ThemePicker";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

const prefs: Record<string, unknown> = {};
const set = vi.fn(async (key: string, value: unknown) => {
	prefs[key] = value;
	return true;
});
const prefsApi = { get: async (key: string): Promise<unknown> => prefs[key], set };
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { prefs: prefsApi },
	matchMedia: (query: string) => ({
		matches: query.includes("dark") ? osDark : !osDark,
		addEventListener: () => {},
		removeEventListener: () => {},
	}),
});
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => {} } });
let osDark = false;

let root: Root | null = null;

async function settle(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}

async function mount(): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<ThemePicker />
			</I18nProvider>,
		);
	});
	await settle();
}

const values = (attr: string) =>
	Array.from(document.body.querySelectorAll(`[${attr}]`)).map(button => button.getAttribute(attr));
const card = (id: string) => document.body.querySelector(`[data-theme-set="${id}"]`) as HTMLButtonElement;
const segment = (mode: string) => document.body.querySelector(`[data-theme-mode="${mode}"]`) as HTMLButtonElement;
const held = (attr: string) =>
	Array.from(document.body.querySelectorAll(`[${attr}][aria-checked="true"]`)).map(button =>
		button.getAttribute(attr),
	);
const root_ = () => document.documentElement;
const shown = () => ({ name: root_().getAttribute("data-theme-name"), scheme: root_().getAttribute("data-theme") });

async function press(button: HTMLButtonElement): Promise<void> {
	await act(async () => {
		button.click();
	});
	await settle();
}

/** The OS changes scheme: the watcher in App re-applies System (lib/theme.ts `watchSystemTheme`). */
function flipOs(dark: boolean): void {
	osDark = dark;
	if (useUiStore.getState().theme === "system") applyThemeByName("system", { persist: false });
}

beforeEach(() => {
	for (const key of Object.keys(prefs)) delete prefs[key];
	set.mockClear();
	osDark = false;
	loadSystemThemePair(undefined);
	applyThemeByName("system", { persist: false });
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useUiStore.getState().setTheme("system");
});

describe("ThemePicker", () => {
	it("offers exactly five sets and three modes, the OMPdesk set following the OS by default", async () => {
		await mount();
		expect(values("data-theme-set")).toEqual(["ompdesk", "github", "solarized", "gruvbox", "hc"]);
		expect(values("data-theme-mode")).toEqual(["system", "light", "dark"]);
		expect(held("data-theme-set")).toEqual(["ompdesk"]);
		expect(held("data-theme-mode")).toEqual(["system"]);
		// The pair selects and the per-theme cards are gone: a set is the only way to a theme.
		expect(document.body.querySelector("select")).toBeNull();
		expect(document.body.querySelectorAll("[role=radio]")).toHaveLength(8);
	});

	it("names each card after its set and previews its light half, then its dark half", async () => {
		await mount();
		for (const { id, light, dark } of THEME_SETS) {
			expect(card(id).textContent, id).toContain(translate(`themePicker.set.${id}.label`));
			const previews = Array.from(card(id).querySelectorAll("[data-theme-preview]")) as HTMLElement[];
			expect(previews.map(node => node.getAttribute("data-theme-preview"))).toEqual([
				THEMES[light].label,
				THEMES[dark].label,
			]);
			for (const [index, name] of [light, dark].entries()) {
				expect(previews[index]?.getAttribute("style") ?? "", name).toContain(
					THEMES[name].tokens["--omp-bg-primary"],
				);
				expect(previews[index]?.innerHTML ?? "", name).toContain(THEMES[name].tokens["--omp-syntax-keyword"]);
			}
		}
	});

	// OMPdesk is held at mount, so it is pressed last: pressing the held card changes nothing.
	it.each([...THEME_SETS.slice(1), THEME_SETS[0]])(
		"pressing the $id set shows its light half under a light OS and its dark half under a dark one",
		async ({ id, light, dark }) => {
			await mount();
			if (id === "ompdesk") await press(card("hc"));
			await press(card(id));
			expect(shown()).toEqual({ name: light, scheme: "light" });
			expect(root_().style.getPropertyValue("--omp-bg-primary")).toBe(THEMES[light].tokens["--omp-bg-primary"]);
			expect(root_().style.getPropertyValue("--omp-ansi-red")).toBe(THEMES[light].ansi[1]);
			expect(prefs).toMatchObject({
				themeName: "system",
				theme: "system",
				systemLightTheme: light,
				systemDarkTheme: dark,
			});
			expect(useUiStore.getState().theme).toBe("system");
			expect(held("data-theme-set")).toEqual([id]);
			expect(held("data-theme-mode")).toEqual(["system"]);
			flipOs(true);
			expect(shown()).toEqual({ name: dark, scheme: "dark" });
			expect(root_().style.getPropertyValue("--omp-accent")).toBe(THEMES[dark].tokens["--omp-accent"]);
		},
	);

	it.each(
		THEME_SETS.flatMap(entry => [
			{ ...entry, mode: "light" as const },
			{ ...entry, mode: "dark" as const },
		]),
	)(
		"pressing $mode keeps the $id set on that half whatever the OS says, and Follow system gives it back",
		async ({ id, mode, ...halves }) => {
			// The OS says the opposite of the half pressed.
			osDark = mode === "light";
			applyThemeByName("system", { persist: false });
			await mount();
			if (id !== "ompdesk") await press(card(id));
			await press(segment(mode));
			expect(shown()).toEqual({ name: halves[mode], scheme: mode });
			expect(prefs).toMatchObject({
				themeName: halves[mode],
				theme: mode,
				systemLightTheme: halves.light,
				systemDarkTheme: halves.dark,
			});
			expect(useUiStore.getState().theme).toBe(mode);
			expect(held("data-theme-set")).toEqual([id]);
			expect(held("data-theme-mode")).toEqual([mode]);
			flipOs(!osDark);
			expect(shown().name).toBe(halves[mode]);

			await press(segment("system"));
			const other = mode === "light" ? "dark" : "light";
			expect(prefs.themeName).toBe("system");
			expect(shown()).toEqual({ name: halves[osDark ? "dark" : "light"], scheme: osDark ? "dark" : "light" });
			flipOs(!osDark);
			expect(shown()).toEqual({ name: halves[other], scheme: other });
		},
	);

	it("keeps the half a person stays on when another set is pressed", async () => {
		await mount();
		await press(segment("dark"));
		expect(shown().name).toBe("dark");
		await press(card("gruvbox"));
		expect(shown()).toEqual({ name: "gruvbox-dark", scheme: "dark" });
		expect(prefs.themeName).toBe("gruvbox-dark");
		expect(held("data-theme-mode")).toEqual(["dark"]);
	});

	it.each([
		{ stored: { themeName: "github-dark" }, reads: ["github", "dark"], why: "one theme id" },
		{
			stored: { themeName: "system", systemLightTheme: "gruvbox-light", systemDarkTheme: "gruvbox-dark" },
			reads: ["gruvbox", "system"],
			why: "System with a pair",
		},
		{ stored: { themeName: "sepia" }, reads: ["gruvbox", "light"], why: "a retired light theme" },
		{ stored: { themeName: "nord" }, reads: ["solarized", "dark"], why: "a retired dark theme" },
		{
			stored: { themeName: "system", systemLightTheme: "sepia", systemDarkTheme: "tokyo-night" },
			reads: ["gruvbox", "system"],
			why: "System with a retired pair, the light half on screen",
		},
		{ stored: { theme: "light" }, reads: ["ompdesk", "light"], why: "the legacy scheme pref" },
	])("reads $why as a set and a mode", async ({ stored, reads }) => {
		Object.assign(prefs, stored);
		loadSystemThemePair(prefs);
		await mount();
		expect([held("data-theme-set"), held("data-theme-mode")]).toEqual([[reads[0]], [reads[1]]]);
	});

	it("keeps a choice made while its stored-theme read is still in flight", async () => {
		// Each read answers with the prefs as they were when it was sent; the second one (the legacy `theme`
		// pref, read because `themeName` is unset) is sent before the press and answered after it.
		const stored = prefsApi.get;
		const pending = Promise.withResolvers<void>();
		prefsApi.get = key => {
			const sent = prefs[key];
			return key === "theme" ? pending.promise.then(() => sent) : Promise.resolve(sent);
		};
		try {
			await mount();
			await press(card("solarized"));
			await press(segment("light"));
			await act(async () => pending.resolve());
			await settle();
			await settle();
			expect(shown().name).toBe("solarized-light");
			expect(held("data-theme-set")).toEqual(["solarized"]);
			expect(held("data-theme-mode")).toEqual(["light"]);
		} finally {
			prefsApi.get = stored;
		}
	});

	it("moves with the arrow keys across the sets and applies each stop", async () => {
		await mount();
		const arrow = async (key: string) => {
			const event = new Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { key });
			const at = document.body.querySelector('[data-theme-set][aria-checked="true"]');
			await act(async () => {
				at?.dispatchEvent(event);
			});
			await settle();
		};
		await arrow("ArrowRight");
		expect(shown().name).toBe("github-light");
		await arrow("ArrowLeft");
		await arrow("ArrowLeft");
		expect(shown().name).toBe("hc-light");
	});
});
