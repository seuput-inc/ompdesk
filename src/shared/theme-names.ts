/**
 * Theme ids, the sets they pair into, their schemes and the migration from retired ids. Dependency-free
 * so the main process (`nativeTheme.themeSource`), the renderer's registry
 * (lib/themes.ts) and the tests read one list.
 *
 * Stored preferences (`themeName` on the desktop and in a paired device's
 * uiPrefs, `systemLightTheme` / `systemDarkTheme`) hold these ids. An id the
 * app no longer ships is migrated by {@link migrateThemeName} to the nearest
 * theme of the same scheme, never to nothing.
 */

export type ThemeScheme = "light" | "dark";

/**
 * The five sets the app ships, in picker order: the OMPdesk default, then four published pairs. A set is one light
 * and one dark theme. A person chooses a set and whether it follows the OS between its halves or stays on one:
 * the set is stored as the System pair (`systemLightTheme` / `systemDarkTheme`), and `themeName` is `system` or
 * the pinned half.
 */
export const THEME_SETS = [
	{ id: "ompdesk", light: "light", dark: "dark" },
	{ id: "github", light: "github-light", dark: "github-dark" },
	{ id: "solarized", light: "solarized-light", dark: "solarized-dark" },
	{ id: "gruvbox", light: "gruvbox-light", dark: "gruvbox-dark" },
	{ id: "hc", light: "hc-light", dark: "hc-dark" },
] as const;

export type ThemeSet = (typeof THEME_SETS)[number];
export type ThemeSetId = ThemeSet["id"];
export type LightThemeName = ThemeSet["light"];
export type DarkThemeName = ThemeSet["dark"];
export type ThemeName = LightThemeName | DarkThemeName;

export const LIGHT_THEME_NAMES: readonly LightThemeName[] = THEME_SETS.map(set => set.light);

export const DARK_THEME_NAMES: readonly DarkThemeName[] = THEME_SETS.map(set => set.dark);

export const THEME_NAMES: readonly ThemeName[] = [...LIGHT_THEME_NAMES, ...DARK_THEME_NAMES];

export type ThemeSelection = ThemeName | "system";

/** What System pairs: the theme shown while the OS is light, and the one while it is dark. */
export interface SystemThemePair {
	light: LightThemeName;
	dark: DarkThemeName;
}

export const DEFAULT_SYSTEM_THEMES: SystemThemePair = { light: "light", dark: "dark" };

export function isThemeName(value: unknown): value is ThemeName {
	return typeof value === "string" && (THEME_NAMES as readonly string[]).includes(value);
}

export function isLightThemeName(value: unknown): value is LightThemeName {
	return typeof value === "string" && (LIGHT_THEME_NAMES as readonly string[]).includes(value);
}

export function isDarkThemeName(value: unknown): value is DarkThemeName {
	return typeof value === "string" && (DARK_THEME_NAMES as readonly string[]).includes(value);
}

export function schemeOfTheme(name: ThemeName): ThemeScheme {
	return isLightThemeName(name) ? "light" : "dark";
}

/** The set a theme is a half of. */
export function themeSetOf(name: ThemeName): ThemeSet {
	return THEME_SETS.find(set => set.light === name || set.dark === name)!;
}

/**
 * Ids the app no longer ships, each with the nearest theme of the same scheme (CIE Lab distance of the page
 * background and the accent): the nine retired with the curated set, and Sepia and Tokyo Night, retired when the
 * themes became five sets. `nord` named two palettes over time (Deep Sea, then the published Nord); both are
 * nearest Solarized Dark. Graphite and Porcelain kept their ids: they are OMPdesk Dark and OMPdesk Light.
 * themes.migration.test.ts checks every entry exists, keeps the scheme and stays near the best match.
 */
export const LEGACY_THEME_NAMES: Readonly<Record<string, ThemeName>> = {
	titanium: "solarized-dark", // Slate: silver-blue charcoal
	nord: "solarized-dark", // Deep Sea (petrol blue), then Nord (arctic blue-gray)
	latte: "gruvbox-dark", // Espresso: roasted brown with caramel
	gruvbox: "gruvbox-dark", // Ember: warm charcoal with copper
	"tokyo-night": "github-dark", // Tokyo Night: midnight blue, blue accent
	paper: "gruvbox-light", // Ivory: warm pages, copper accent
	solarized: "gruvbox-light", // Sand: pale sand, ochre accent
	sepia: "gruvbox-light", // Sepia: warm paper, rust accent
	dawn: "solarized-light", // Rose Quartz: warm off-white, dusty accent
	frost: "solarized-light", // Glacier: pale page, steel-blue accent
	matcha: "solarized-light", // Sage: pale page, muted green accent
};

/**
 * A stored theme value read as a selection: a current id or "system" as is, a retired id mapped to its
 * successor, anything else null. The legacy `theme` pref (`dark` / `light` / `system`) reads the same way.
 */
export function migrateThemeName(value: unknown): ThemeSelection | null {
	if (value === "system") return "system";
	if (isThemeName(value)) return value;
	if (typeof value === "string" && Object.hasOwn(LEGACY_THEME_NAMES, value)) return LEGACY_THEME_NAMES[value] ?? null;
	return null;
}

/** The theme a stored System pair entry names for `scheme`: it must exist and match the scheme, else the OMPdesk default. */
export function systemThemeFor(scheme: "light", value: unknown): LightThemeName;
export function systemThemeFor(scheme: "dark", value: unknown): DarkThemeName;
export function systemThemeFor(scheme: ThemeScheme, value: unknown): ThemeName {
	const name = migrateThemeName(value);
	if (name !== null && name !== "system" && schemeOfTheme(name) === scheme) return name;
	return DEFAULT_SYSTEM_THEMES[scheme];
}
