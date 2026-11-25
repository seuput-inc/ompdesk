/**
 * gui-bridge default browser (modes/default-browser-core.ts): ego-browser and an unverified pick each get one static
 * `<browser>` section, the built-in browser leaves the prompt stock, and `default_browser_set` switches it without
 * reinstalling. An unverified pick holds `browser.enabled` off as a session override; Preview's agent browsing wins
 * while it runs and the choice comes back when it stops.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentBrowser,
	agentBrowserEnv,
	parseAgentBrowserEnv,
} from "../../resources/gui-bridge/modes/default-browser-contracts";
import {
	applyDefaultBrowser,
	type BrowserSetting,
	browserSection,
	type DefaultBrowserHost,
	install,
	previewRelayStarted,
	previewRelayStopped,
	setDefaultBrowser,
} from "../../resources/gui-bridge/modes/default-browser-core";

type Handler = Parameters<DefaultBrowserHost["on"]>[1];
type Turn = ReturnType<Handler>;

const EGO: AgentBrowser = { kind: "ego" };
const UNAVAILABLE: AgentBrowser = { kind: "unavailable", name: "Brave" };
const BUILTIN: AgentBrowser = { kind: "builtin" };

function installedHook(kind: string): (event: { systemPrompt: string[] }) => Turn {
	const handlers: Handler[] = [];
	install({ on: (_event, handler) => handlers.push(handler) });
	expect(handlers).toHaveLength(1);
	return event => handlers[0]?.(event, { sessionManager: { getBranch: () => [] }, agent: { kind } });
}

/** The session settings as the bridge's override leaves them: the scopes whose `browser.enabled` is held off. */
function fakeSettings() {
	const disabled = new Set<object>();
	const writes: string[] = [];
	const setting: BrowserSetting = {
		block: scope => {
			disabled.add(scope);
			writes.push("block");
		},
		unblock: scope => {
			disabled.delete(scope);
			writes.push("unblock");
		},
	};
	return { disabled, setting, writes };
}

afterEach(() => {
	setDefaultBrowser({ browser: BUILTIN });
});

describe("gui-bridge default browser section", () => {
	it("names ego-browser's CLI for ego, in the main agent and a subagent", () => {
		setDefaultBrowser({ browser: EGO });
		for (const kind of ["main", "sub"]) {
			const result = installedHook(kind)({ systemPrompt: ["base"] });
			expect(result?.systemPrompt[0]).toBe("base");
			expect(result?.systemPrompt).toHaveLength(2);
			const section = result?.systemPrompt[1] ?? "";
			expect(section).toContain("<browser>");
			expect(section).toContain("`ego-browser skill`");
			expect(section).toContain("`ego-browser nodejs`");
		}
	});

	it("says an unverified pick cannot be used and points the user at Settings", () => {
		setDefaultBrowser({ browser: UNAVAILABLE });
		const section = installedHook("main")({ systemPrompt: ["base"] })?.systemPrompt[1] ?? "";
		expect(section).toContain("cannot verify a relay for the selected Brave");
		expect(section).toContain("Settings");
		expect(section).not.toContain("ego-browser");
	});

	it("adds nothing for the built-in browser", () => {
		expect(browserSection(BUILTIN)).toBeUndefined();
		expect(installedHook("main")({ systemPrompt: ["base"] })).toBeUndefined();
	});

	it("follows default_browser_set on the next prompt without reinstalling", () => {
		const hook = installedHook("main");
		expect(hook({ systemPrompt: ["base"] })).toBeUndefined();
		expect(setDefaultBrowser({ browser: EGO })).toEqual({ browser: EGO });
		expect(hook({ systemPrompt: ["base"] })?.systemPrompt[1]).toContain("ego-browser");
		setDefaultBrowser({ browser: UNAVAILABLE });
		expect(hook({ systemPrompt: ["base"] })?.systemPrompt[1]).toContain("Brave");
		setDefaultBrowser({ browser: BUILTIN });
		expect(hook({ systemPrompt: ["base"] })).toBeUndefined();
	});

	it("keeps one copy and the same bytes across turns", () => {
		setDefaultBrowser({ browser: EGO });
		const hook = installedHook("main");
		const first = hook({ systemPrompt: ["base"] })?.systemPrompt;
		expect(hook({ systemPrompt: first ?? [] })).toBeUndefined();
		expect(hook({ systemPrompt: ["base"] })?.systemPrompt).toEqual(first);
		expect(first?.filter(part => part.includes("<browser>"))).toHaveLength(1);
	});

	it("refuses a value that is not a browser, including the old per-port relay", () => {
		for (const bad of [
			{ browser: "ego" },
			{ browser: { kind: "chrome" } },
			{ browser: { kind: "unavailable", name: "a\nb" } },
			{ browser: { kind: "relay", name: "Chrome", url: "http://127.0.0.1:9231" } },
			null,
		]) {
			expect(() => setDefaultBrowser(bad)).toThrow("default_browser_set");
		}
	});
});

describe("gui-bridge default browser env", () => {
	it("round-trips every choice through the env value and reads anything else as built-in", () => {
		for (const browser of [EGO, BUILTIN, UNAVAILABLE]) {
			expect(parseAgentBrowserEnv(agentBrowserEnv(browser))).toEqual(browser);
		}
		expect(agentBrowserEnv(UNAVAILABLE)).toBe("unavailable:Brave");
		for (const bad of [
			undefined,
			"",
			"chrome",
			"unavailable:",
			`unavailable:${"x".repeat(65)}`,
			"relay:Google Chrome@http://127.0.0.1:9231",
		]) {
			expect(parseAgentBrowserEnv(bad)).toEqual(BUILTIN);
		}
	});
});

describe("gui-bridge default browser override", () => {
	it("holds browser.enabled off while the pick is unavailable and gives it back on switching away", () => {
		const { disabled, setting } = fakeSettings();
		const scope = {};
		setDefaultBrowser({ browser: UNAVAILABLE });
		applyDefaultBrowser(scope, setting);
		expect(disabled.has(scope)).toBe(true);
		setDefaultBrowser({ browser: EGO });
		applyDefaultBrowser(scope, setting);
		expect(disabled.has(scope)).toBe(false);
	});

	it("never touches the settings for ego or built-in", () => {
		const { writes, setting } = fakeSettings();
		for (const browser of [EGO, BUILTIN]) {
			setDefaultBrowser({ browser });
			applyDefaultBrowser({}, setting);
		}
		expect(writes).toEqual([]);
	});

	it("writes the override once however often the same choice is applied", () => {
		const { writes, setting } = fakeSettings();
		const scope = {};
		setDefaultBrowser({ browser: UNAVAILABLE });
		applyDefaultBrowser(scope, setting);
		applyDefaultBrowser(scope, setting);
		expect(writes).toEqual(["block"]);
	});

	it("lets Preview own the browser while it runs and holds the choice again when Preview stops", () => {
		const { disabled, setting } = fakeSettings();
		const scope = {};
		setDefaultBrowser({ browser: UNAVAILABLE });
		applyDefaultBrowser(scope, setting);
		previewRelayStarted(scope, setting);
		expect(disabled.has(scope)).toBe(false);
		// A switch while Preview runs leaves Preview's browser alone.
		applyDefaultBrowser(scope, setting);
		expect(disabled.has(scope)).toBe(false);
		previewRelayStopped(scope, setting);
		expect(disabled.has(scope)).toBe(true);
		setDefaultBrowser({ browser: BUILTIN });
		applyDefaultBrowser(scope, setting);
		expect(disabled.has(scope)).toBe(false);
	});
});
