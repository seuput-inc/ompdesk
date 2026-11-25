import { describe, expect, it } from "vitest";
import {
	type AgentBrowserStatus,
	chromiumBrowserOf,
	type DefaultBrowserPref,
	parseDefaultBrowser,
	resolveAgentBrowser,
} from "./default-browser";

const chrome = { id: "chrome" as const, name: "Google Chrome" };
const brave = { id: "brave" as const, name: "Brave" };
const status = (egoInstalled: boolean, ...browsers: AgentBrowserStatus["browsers"]): AgentBrowserStatus => ({
	auto: egoInstalled ? { kind: "ego" } : { kind: "builtin" },
	egoInstalled,
	browsers,
	nativeHostBrowsers: ["chrome", "brave", "chromium"],
});

describe("default browser pref", () => {
	it("reads a missing or invalid pref as auto", () => {
		for (const value of [undefined, null, "", "chrome", "chromium:safari", "chromium:", 1, {}]) {
			expect(parseDefaultBrowser(value)).toBe("auto");
		}
		for (const value of ["auto", "ego", "builtin", "chromium:chrome", "chromium:arc"] as const) {
			expect(parseDefaultBrowser(value)).toBe(value);
		}
	});

	it("names the Chromium browser of a pick", () => {
		expect(chromiumBrowserOf("chromium:edge")).toBe("edge");
		expect(chromiumBrowserOf("auto")).toBeUndefined();
	});
});

describe("resolveAgentBrowser", () => {
	it.each<[string, DefaultBrowserPref, AgentBrowserStatus | undefined, unknown]>([
		["auto follows the core's answer", "auto", status(true, chrome), { kind: "ego" }],
		["auto before the first read is built-in", "auto", undefined, { kind: "builtin" }],
		["ego when installed", "ego", status(true), { kind: "ego" }],
		[
			"ego without ego-browser is built-in, never a missing binary",
			"ego",
			status(false, chrome),
			{ kind: "builtin" },
		],
		[
			"a named browser is never driven, installed or not, since its profile cannot be verified",
			"chromium:brave",
			status(false, chrome, brave),
			{ kind: "unavailable", name: "Brave" },
		],
		[
			"a named browser that is gone stays unavailable",
			"chromium:chrome",
			status(false),
			{ kind: "unavailable", name: "Google Chrome" },
		],
		[
			"a named browser before the first read stays unavailable",
			"chromium:chrome",
			undefined,
			{ kind: "unavailable", name: "Google Chrome" },
		],
		["built-in stays built-in whatever is installed", "builtin", status(true, chrome), { kind: "builtin" }],
	])("%s", (_name, pref, machine, expected) => {
		expect(resolveAgentBrowser(pref, machine)).toEqual(expected);
	});
});
