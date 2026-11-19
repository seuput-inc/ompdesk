/**
 * Stored theme names the app no longer ships keep working: every retired id reads as the nearest
 * theme of the same scheme, stored prefs (desktop and a device's uiPrefs) are rewritten once,
 * and nothing ever resolves to a missing theme.
 */

import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SYSTEM_THEMES, LEGACY_THEME_NAMES, migrateThemeName, systemThemeFor } from "../../shared/theme-names";
import { deltaE } from "./theme-color";
import { getPersistedThemeSelection, THEMES, type ThemeName } from "./themes";

const { document } = parseHTML("<html><body></body></html>");
(globalThis as unknown as Record<string, unknown>).document = document;

/**
 * Page background and accent of every theme an id once named: the eleven before the curated set (git:
 * src/renderer/lib/themes.ts at v0.33), then the three the five sets retired (theme-palettes.ts at v0.134.1).
 * `nord` named two palettes.
 */
const OLD_THEMES: { id: string; scheme: "light" | "dark"; bg: string; accent: string }[] = [
	{ id: "dark", scheme: "dark", bg: "#19191c", accent: "#8b8df8" },
	{ id: "titanium", scheme: "dark", bg: "#24282c", accent: "#accad6" },
	{ id: "nord", scheme: "dark", bg: "#14232b", accent: "#8bc4c5" },
	{ id: "latte", scheme: "dark", bg: "#25211e", accent: "#d6b18a" },
	{ id: "gruvbox", scheme: "dark", bg: "#241e20", accent: "#dea28d" },
	{ id: "light", scheme: "light", bg: "#ffffff", accent: "#5b5bd6" },
	{ id: "paper", scheme: "light", bg: "#fdfbf7", accent: "#94513e" },
	{ id: "solarized", scheme: "light", bg: "#faf8f3", accent: "#825d2a" },
	{ id: "dawn", scheme: "light", bg: "#fcf9f9", accent: "#8d5064" },
	{ id: "frost", scheme: "light", bg: "#f7fafb", accent: "#356987" },
	{ id: "matcha", scheme: "light", bg: "#f8faf7", accent: "#466d51" },
	{ id: "nord", scheme: "dark", bg: "#2e3440", accent: "#88c0d0" },
	{ id: "tokyo-night", scheme: "dark", bg: "#1a1b26", accent: "#7aa2f7" },
	{ id: "sepia", scheme: "light", bg: "#f4ecd8", accent: "#91471b" },
];

const names = Object.keys(THEMES) as ThemeName[];
const distance = (old: (typeof OLD_THEMES)[number], name: ThemeName): number =>
	(deltaE(old.bg, THEMES[name].tokens["--omp-bg-primary"]) + deltaE(old.accent, THEMES[name].tokens["--omp-accent"])) /
	2;

describe("migrateThemeName", () => {
	it("maps every retired id to a theme that exists, of the same scheme", () => {
		for (const id of Object.keys(LEGACY_THEME_NAMES)) {
			const target = migrateThemeName(id);
			expect(target, id).not.toBeNull();
			expect(target, id).not.toBe("system");
			expect(names, id).toContain(target);
			const schemes = OLD_THEMES.filter(old => old.id === id).map(old => old.scheme);
			expect(schemes.length, id).toBeGreaterThan(0);
			for (const scheme of schemes) expect(THEMES[target as ThemeName].scheme, `${id} → ${target}`).toBe(scheme);
		}
	});

	it("keeps every retired id's mapping within a few ΔE of the nearest theme of its scheme", () => {
		for (const old of OLD_THEMES) {
			const candidates = names.filter(name => THEMES[name].scheme === old.scheme);
			const best = Math.min(...candidates.map(name => distance(old, name)));
			const chosen = migrateThemeName(old.id) as ThemeName;
			expect(distance(old, chosen), `${old.id} (${old.bg}) → ${chosen}`).toBeLessThanOrEqual(best + 5);
		}
	});

	it("covers exactly the retired ids and leaves the surviving ids alone", () => {
		expect(Object.keys(LEGACY_THEME_NAMES).sort()).toEqual(
			[
				"dawn",
				"frost",
				"gruvbox",
				"latte",
				"matcha",
				"nord",
				"paper",
				"sepia",
				"solarized",
				"titanium",
				"tokyo-night",
			].sort(),
		);
		for (const id of ["system", ...names]) expect(migrateThemeName(id)).toBe(id);
	});

	it("moves the themes the five sets retired to the set nearest each", () => {
		expect(migrateThemeName("sepia")).toBe("gruvbox-light");
		expect(migrateThemeName("nord")).toBe("solarized-dark");
		expect(migrateThemeName("tokyo-night")).toBe("github-dark");
	});

	it("is null for anything that was never a theme, so a caller falls back instead of showing a blank theme", () => {
		for (const value of [undefined, null, 3, {}, "", "Graphite", "__proto__", "toString", "constructor"]) {
			expect(migrateThemeName(value), String(value)).toBeNull();
		}
	});
});

describe("systemThemeFor", () => {
	it("takes a stored System entry of the right scheme, migrated, and the OMPdesk default otherwise", () => {
		expect(systemThemeFor("dark", "solarized-dark")).toBe("solarized-dark");
		expect(systemThemeFor("dark", "tokyo-night")).toBe("github-dark");
		expect(systemThemeFor("dark", "nord")).toBe("solarized-dark");
		expect(systemThemeFor("light", "sepia")).toBe("gruvbox-light");
		expect(systemThemeFor("light", "frost")).toBe("solarized-light");
		expect(systemThemeFor("dark", "gruvbox")).toBe("gruvbox-dark");
		expect(systemThemeFor("dark", "sepia")).toBe(DEFAULT_SYSTEM_THEMES.dark);
		expect(systemThemeFor("light", "nord")).toBe(DEFAULT_SYSTEM_THEMES.light);
		expect(systemThemeFor("light", "system")).toBe(DEFAULT_SYSTEM_THEMES.light);
		expect(systemThemeFor("dark", undefined)).toBe(DEFAULT_SYSTEM_THEMES.dark);
	});
});

describe("getPersistedThemeSelection", () => {
	const set = vi.fn(async () => true);
	const prefs: Record<string, unknown> = {};

	beforeEach(() => {
		for (const key of Object.keys(prefs)) delete prefs[key];
		set.mockClear();
		vi.stubGlobal("window", {
			omp: {
				prefs: {
					get: async (key: string) => prefs[key],
					set,
				},
			},
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it("reads a retired themeName from a prefs record as its successor and stores the successor once", async () => {
		expect(await getPersistedThemeSelection({ themeName: "matcha", theme: "light" })).toBe("solarized-light");
		expect(set).toHaveBeenCalledWith("themeName", "solarized-light");
		set.mockClear();
		expect(await getPersistedThemeSelection({ themeName: "nord" })).toBe("solarized-dark");
		expect(set).toHaveBeenCalledWith("themeName", "solarized-dark");
		set.mockClear();
		expect(await getPersistedThemeSelection({ themeName: "solarized-dark" })).toBe("solarized-dark");
		expect(set).not.toHaveBeenCalled();
	});

	it("reads a retired themeName through the prefs IPC the same way", async () => {
		prefs.themeName = "latte";
		expect(await getPersistedThemeSelection()).toBe("gruvbox-dark");
		expect(set).toHaveBeenCalledWith("themeName", "gruvbox-dark");
		set.mockClear();
		prefs.themeName = "tokyo-night";
		expect(await getPersistedThemeSelection()).toBe("github-dark");
		expect(set).toHaveBeenCalledWith("themeName", "github-dark");
	});

	it("falls back to the legacy scheme pref, then to System, never to nothing", async () => {
		expect(await getPersistedThemeSelection({ theme: "dark" })).toBe("dark");
		expect(await getPersistedThemeSelection({ themeName: "Graphite", theme: "light" })).toBe("light");
		expect(await getPersistedThemeSelection({ themeName: 7 })).toBe("system");
		expect(await getPersistedThemeSelection({})).toBe("system");
		expect(await getPersistedThemeSelection()).toBe("system");
	});

	it("never persists a write for a value that was already current", async () => {
		prefs.themeName = "gruvbox-light";
		expect(await getPersistedThemeSelection()).toBe("gruvbox-light");
		expect(set).not.toHaveBeenCalled();
	});
});
