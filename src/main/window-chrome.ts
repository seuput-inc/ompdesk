import { migrateThemeName, schemeOfTheme } from "../shared/theme-names";

/**
 * `nativeTheme.themeSource` for the saved theme: prefs `themeName` read as a theme (a retired id
 * through its successor, shared/theme-names.ts) gives that theme's scheme, "system" follows the OS;
 * when `themeName` is unset or unknown, the legacy `theme` (`dark` / `light` / `system`) decides.
 * Anything else follows the OS.
 */
export function nativeThemeSource(themeName: unknown, theme: unknown): "system" | "light" | "dark" {
	for (const value of [themeName, theme]) {
		const selection = migrateThemeName(value);
		if (selection === "system") return "system";
		if (selection !== null) return schemeOfTheme(selection);
	}
	return "system";
}
