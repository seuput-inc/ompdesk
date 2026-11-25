/**
 * The browser agents use (Settings › Agent behavior › Default browser, prefs `defaultBrowser`). Automatic picks
 * ego-browser, then omp's built-in browser. A named Chromium browser is never driven: stock's native-host relay
 * cannot tell which of its profiles answers, so agents get no browser and the row says so. Main resolves the pref
 * against the machine and passes the result to omp as `OMP_GUI_BROWSER` at spawn and through the bridge's
 * `default_browser_set` on change; the gui-bridge (resources/gui-bridge/modes/default-browser.ts) turns it into a
 * prompt section and, for an unverified browser, a per-session `browser.enabled` override.
 */
import { type AgentBrowser, DEFAULT_BROWSER_ENV } from "../../resources/gui-bridge/modes/default-browser-contracts";

export type { AgentBrowser };
export { DEFAULT_BROWSER_ENV };

/** prefs key (electron-store `prefs`). */
export const DEFAULT_BROWSER_PREF = "defaultBrowser";

/** The Chromium browsers Settings can offer, in the order `auto` tries them. */
export const CHROMIUM_BROWSER_IDS = ["chrome", "edge", "brave", "arc", "chromium"] as const;

export type ChromiumBrowserId = (typeof CHROMIUM_BROWSER_IDS)[number];

export const CHROMIUM_BROWSER_NAMES: Record<ChromiumBrowserId, string> = {
	chrome: "Google Chrome",
	edge: "Microsoft Edge",
	brave: "Brave",
	arc: "Arc",
	chromium: "Chromium",
};

export type DefaultBrowserPref = "auto" | "ego" | "builtin" | `chromium:${ChromiumBrowserId}`;

/** One Chromium browser found on this computer. */
export interface InstalledBrowser {
	id: ChromiumBrowserId;
	name: string;
}

/** What this computer has: the answer of `DEFAULT_BROWSER_STATUS`, in `auto` order. */
export interface AgentBrowserStatus {
	auto: Exclude<AgentBrowser, { kind: "unavailable" }>;
	egoInstalled: boolean;
	browsers: InstalledBrowser[];
	/** The browsers stock's native host registers on this platform: the ones the row can install the extension for. */
	nativeHostBrowsers: readonly ChromiumBrowserId[];
}

const CHROMIUM_PREFS: readonly string[] = CHROMIUM_BROWSER_IDS.map(id => `chromium:${id}`);

export function isDefaultBrowserPref(value: unknown): value is DefaultBrowserPref {
	return (
		value === "auto" ||
		value === "ego" ||
		value === "builtin" ||
		(typeof value === "string" && CHROMIUM_PREFS.includes(value))
	);
}

/** A stored pref; missing or unknown (hand-edited, a later version's choice) reads as `auto`. */
export function parseDefaultBrowser(value: unknown): DefaultBrowserPref {
	return isDefaultBrowserPref(value) ? value : "auto";
}

/** The Chromium browser a `chromium:<id>` pref names. */
export function chromiumBrowserOf(pref: DefaultBrowserPref): ChromiumBrowserId | undefined {
	return CHROMIUM_BROWSER_IDS.find(id => pref === `chromium:${id}`);
}

/**
 * Automatic may fall back. An explicit Chromium choice may not: its profile cannot be verified, so disable the
 * browser rather than inheriting stock's configuration, which could itself discover another signed-in browser.
 */
export function resolveAgentBrowser(pref: DefaultBrowserPref, status: AgentBrowserStatus | undefined): AgentBrowser {
	const id = chromiumBrowserOf(pref);
	if (id) return { kind: "unavailable", name: CHROMIUM_BROWSER_NAMES[id] };
	if (pref === "auto" && status) return status.auto;
	return pref === "ego" && status?.egoInstalled ? { kind: "ego" } : { kind: "builtin" };
}
