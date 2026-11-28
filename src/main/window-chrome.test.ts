import { describe, expect, it } from "vitest";
import { nativeThemeSource } from "./window-chrome";

describe("nativeThemeSource", () => {
	it("follows the saved scheme, not the OS", () => {
		expect(nativeThemeSource("dark", undefined)).toBe("dark");
		expect(nativeThemeSource("light", "dark")).toBe("light");
		expect(nativeThemeSource("system", "light")).toBe("system");
	});

	it("takes a named theme's scheme from the theme itself, and from the legacy pref beside it", () => {
		expect(nativeThemeSource("github-dark", "dark")).toBe("dark");
		expect(nativeThemeSource("gruvbox-light", "light")).toBe("light");
		expect(nativeThemeSource("hc-light", undefined)).toBe("light");
		expect(nativeThemeSource("solarized-dark", undefined)).toBe("dark");
		expect(nativeThemeSource(undefined, "dark")).toBe("dark");
	});

	it("reads a retired theme id as its successor's scheme", () => {
		expect(nativeThemeSource("paper", undefined)).toBe("light");
		expect(nativeThemeSource("gruvbox", undefined)).toBe("dark");
		expect(nativeThemeSource("matcha", "dark")).toBe("light");
		expect(nativeThemeSource("sepia", "dark")).toBe("light");
		expect(nativeThemeSource("nord", undefined)).toBe("dark");
		expect(nativeThemeSource("tokyo-night", "light")).toBe("dark");
	});

	it("follows the OS when nothing usable is saved", () => {
		expect(nativeThemeSource(undefined, undefined)).toBe("system");
		expect(nativeThemeSource(3, "Graphite")).toBe("system");
		expect(nativeThemeSource("Porcelain", undefined)).toBe("system");
	});
});
