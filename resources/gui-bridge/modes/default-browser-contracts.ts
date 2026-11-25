/**
 * What the Default browser setting resolves to for a session (rules: src/shared/default-browser.ts; section and
 * browser block: ./default-browser-core.ts). Dependency-free: main and the bridge both import it.
 */

/** Env main sets at every spawn; see {@link agentBrowserEnv}. */
export const DEFAULT_BROWSER_ENV = "OMP_GUI_BROWSER";

/**
 * `ego`: ego-browser's CLI. `builtin`: omp's own browser, stock. `unavailable`: the person picked their own `name`
 * browser, whose profile stock's native-host relay cannot verify, so agents get no browser at all.
 */
export type AgentBrowser = { kind: "ego" } | { kind: "builtin" } | { kind: "unavailable"; name: string };

/** The env value: `ego`, `builtin` or `unavailable:<name>`. */
export function agentBrowserEnv(browser: AgentBrowser): string {
	return browser.kind === "unavailable" ? `unavailable:${browser.name}` : browser.kind;
}

/** A browser name that is safe to name in a prompt and to carry in an env value: short, one line, no `@`. */
function isBrowserName(name: unknown): name is string {
	return typeof name === "string" && name.trim().length > 0 && name.length <= 64 && !/[\p{Cc}@]/u.test(name);
}

/** The env value read back; missing or malformed reads as the built-in browser. */
export function parseAgentBrowserEnv(value: string | undefined): AgentBrowser {
	if (value === "ego") return { kind: "ego" };
	if (value?.startsWith("unavailable:")) {
		const name = value.slice("unavailable:".length);
		if (isBrowserName(name)) return { kind: "unavailable", name };
	}
	return { kind: "builtin" };
}

/** A `default_browser_set` value; undefined when it is not a browser. */
export function parseAgentBrowser(value: unknown): AgentBrowser | undefined {
	if (typeof value !== "object" || value === null || !("kind" in value)) return undefined;
	if (value.kind === "ego" || value.kind === "builtin") return { kind: value.kind };
	if (value.kind === "unavailable" && "name" in value && isBrowserName(value.name)) {
		return { kind: "unavailable", name: value.name };
	}
	return undefined;
}
