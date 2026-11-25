/**
 * Default browser (Settings › Agent behavior › Default browser; rules in src/shared/default-browser.ts): main
 * resolves the setting against what is installed and passes the result (`./default-browser-contracts.ts`) as
 * `OMP_GUI_BROWSER` at spawn and through `default_browser_set` on change.
 *   ego          one static section pointing agents at ego-browser's CLI instead of omp's built-in `browser` tool.
 *   builtin      nothing: stock omp.
 *   unavailable  the picked browser's profile cannot be verified: `browser.enabled` held off as a runtime override
 *                (config untouched), plus one static section saying so.
 * No omp imports, so the GUI's vitest runs it.
 */
import { type PromptSectionHost, registerPromptSection } from "../prompt-sections";
import {
	type AgentBrowser,
	DEFAULT_BROWSER_ENV,
	parseAgentBrowser,
	parseAgentBrowserEnv,
} from "./default-browser-contracts";

const EGO_SECTION = `<browser>
ego-browser (ego lite) is this computer's browser for agents. For any task that needs a web browser (opening sites, signing in, forms, clicks, screenshots, page data, web app checks), run \`ego-browser skill\` once and follow its guide; drive pages with \`ego-browser nodejs\`. Do not use the built-in \`browser\` tool or Eval's \`browser\` object unless ego-browser fails or the user asks for it; say so when you fall back. A project's own test runners (Playwright and the like) stay as they are.
</browser>`;

/** The prompt section for `browser`; undefined for the built-in browser (stock omp's own prompt). */
export function browserSection(browser: AgentBrowser): string | undefined {
	if (browser.kind === "ego") return EGO_SECTION;
	if (browser.kind === "unavailable") {
		return `<browser>omp cannot verify a relay for the selected ${browser.name} profile. Do not use another browser or discover a relay. Tell the user to choose another default browser in Settings, or start a chat in the omp side panel of a supported browser.</browser>`;
	}
	return undefined;
}

let current: AgentBrowser = parseAgentBrowserEnv(process.env[DEFAULT_BROWSER_ENV]);

/** The browser agents are pointed at right now. */
export function currentDefaultBrowser(): AgentBrowser {
	return current;
}

/** `{browser: AgentBrowser}`; anything else is refused rather than silently switching the section off. */
export function setDefaultBrowser(params: unknown): { browser: AgentBrowser } {
	const value = typeof params === "object" && params !== null && "browser" in params ? params.browser : undefined;
	const browser = parseAgentBrowser(value);
	if (!browser) {
		throw new Error('default_browser_set needs {browser: {kind: "ego" | "builtin" | "unavailable", name?}}');
	}
	current = browser;
	return { browser };
}

/** The session setting an unavailable choice holds off: `browser.enabled`, one scope at a time. */
export interface BrowserSetting {
	block(scope: object): void;
	unblock(scope: object): void;
}

/** Scopes whose browser the unavailable choice holds off. */
const blocked = new WeakSet<object>();
/** Scopes where Preview's agent browsing holds the browser: its relay wins while it runs. */
const previewing = new Set<object>();

/** Make `scope`'s browser override match the current choice. */
export function applyDefaultBrowser(scope: object, setting: BrowserSetting): void {
	if (previewing.has(scope)) return;
	const block = current.kind === "unavailable";
	if (block === blocked.has(scope)) return;
	if (block) {
		setting.block(scope);
		blocked.add(scope);
	} else {
		setting.unblock(scope);
		blocked.delete(scope);
	}
}

/** Preview's relay took `scope`'s browser. */
export function previewRelayStarted(scope: object, setting: BrowserSetting): void {
	if (blocked.delete(scope)) setting.unblock(scope);
	previewing.add(scope);
}

/** Preview's relay stopped and cleared its overrides: the default browser's choice comes back. */
export function previewRelayStopped(scope: object, setting: BrowserSetting): void {
	previewing.delete(scope);
	applyDefaultBrowser(scope, setting);
}

export type DefaultBrowserHost = PromptSectionHost;

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: DefaultBrowserHost): void {
	registerPromptSection(pi, "default-browser", () => (previewing.size ? undefined : browserSection(current)));
}
