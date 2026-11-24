/**
 * Frameless window chrome: the renderer draws its own 48px top bar (sidebar header, title bar, side-panel header) and
 * the OS controls sit inside it. The shell makes each window that way, with the Mica backdrop on Windows 11
 * (`tauri-shell/src/app_window.rs`); what stays here is what main decides about it:
 *
 * - Windows: the caption buttons' colors follow the theme through {@link sanitizeChromeColors} pushes from the
 *   renderer.
 * - Every window: `nativeTheme.themeSource` follows the app's saved theme ({@link nativeThemeSource}), so what the OS
 *   draws (the Mica tint, the caption buttons' first colors) and pre-paint's OS fallback match the scheme the renderer
 *   applies, whatever the OS is set to.
 */

import type { WindowChromeColors } from "../shared/ipc-types";
import { migrateThemeName, schemeOfTheme } from "../shared/theme-names";

/** Height of the renderer's top bar (Tailwind h-12). */
export const TOP_BAR_HEIGHT = 48;

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

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;

/** Renderer input is untrusted: accept only plain hex / rgb() colors. */
export function sanitizeChromeColors(value: unknown): WindowChromeColors | null {
	if (typeof value !== "object" || value === null) return null;
	const { color, symbolColor } = value as Record<string, unknown>;
	if (typeof color !== "string" || typeof symbolColor !== "string") return null;
	const c = color.trim();
	const s = symbolColor.trim();
	return COLOR.test(c) && COLOR.test(s) ? { color: c, symbolColor: s } : null;
}
