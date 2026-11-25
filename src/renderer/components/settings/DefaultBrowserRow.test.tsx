/**
 * Settings › Agent behavior › Default browser: the list is what this computer has (ego-browser, each Chromium
 * browser found); Automatic names what it resolves to; a Chromium pick without the omp extension says so and offers
 * to install it; the row looks again when the window regains focus.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBrowserStatus } from "../../../shared/default-browser";
import { I18nProvider, translate } from "../../lib/i18n";
import { useToastStore } from "../../stores/toast";
import { DefaultBrowserRow } from "./DefaultBrowserRow";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

let stored: unknown;
let status: AgentBrowserStatus;
const prefs = {
	get: vi.fn(async (_key?: string): Promise<unknown> => stored),
	set: vi.fn(async (_key: string, value: unknown): Promise<void> => {
		stored = value;
	}),
	defaultBrowserStatus: vi.fn(async (): Promise<AgentBrowserStatus> => status),
	installBrowserRelay: vi.fn(async (_browser: string) => ({ dir: "/home/me/.omp/browser-relay/extension" })),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { prefs } });

const roots: Root[] = [];

async function mount(): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<DefaultBrowserRow />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	roots.push(root);
}

function field(): HTMLSelectElement {
	const select = document.body.querySelector("#setting-gui-defaultBrowser select") as HTMLSelectElement | null;
	if (!select) throw new Error("default browser select missing");
	return select;
}

function reactProps(element: Element): { onChange?: (event: object) => void; onClick?: () => void } {
	const record = element as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	return key ? (record[key] as { onChange?: (event: object) => void; onClick?: () => void }) : {};
}

async function choose(value: string): Promise<void> {
	const { onChange } = reactProps(field());
	if (!onChange) throw new Error("select onChange not found");
	await act(async () => onChange({ target: { value }, currentTarget: { value } }));
}

const options = () => Array.from(field().querySelectorAll("option")).map(option => option.value);
const labels = () => Array.from(field().querySelectorAll("option")).map(option => option.textContent);
const text = () => document.body.textContent ?? "";
const installButton = () => document.body.querySelector("[data-default-browser-unverified] button");

const chrome = { id: "chrome" as const, name: "Google Chrome" };
const brave = { id: "brave" as const, name: "Brave" };
const edge = { id: "edge" as const, name: "Microsoft Edge" };

beforeEach(() => {
	stored = undefined;
	status = { auto: { kind: "builtin" }, egoInstalled: false, browsers: [], nativeHostBrowsers: ["chrome", "brave"] };
});

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useToastStore.setState({ toasts: [] });
	vi.clearAllMocks();
});

describe("DefaultBrowserRow", () => {
	it("offers automatic, ego-browser, each browser found and built-in", async () => {
		status = { ...status, auto: { kind: "ego" }, egoInstalled: true, browsers: [chrome, brave] };
		await mount();
		expect(options()).toEqual(["auto", "ego", "chromium:chrome", "chromium:brave", "builtin"]);
		expect(field().value).toBe("auto");
		expect(labels()).toContain("Google Chrome");
		expect(labels()).toContain("Brave");
	});

	it.each([
		[{ kind: "ego" }, "ego-browser"],
		[{ kind: "builtin" }, translate("settings.gui.defaultBrowser.builtin")],
	] satisfies [AgentBrowserStatus["auto"], string][])(
		"labels Automatic with the core's %j pick",
		async (auto, browser) => {
			status = { ...status, auto, egoInstalled: true, browsers: [chrome] };
			await mount();
			expect(labels()[0]).toBe(translate("settings.gui.defaultBrowser.autoResolved", { browser }));
		},
	);

	it("marks ego-browser not installed when it is missing, and says so for a stored ego pick", async () => {
		stored = "ego";
		await mount();
		expect(labels()[1]).toBe(translate("settings.gui.defaultBrowser.notInstalled", { name: "ego-browser" }));
		expect(text()).toContain(translate("settings.gui.defaultBrowserMissing"));
	});

	it("saves a Chromium pick, and refuses a value outside the list", async () => {
		status.browsers = [chrome];
		await mount();
		await choose("chromium:chrome");
		expect(prefs.set).toHaveBeenCalledWith("defaultBrowser", "chromium:chrome");
		expect(field().value).toBe("chromium:chrome");
		await choose("chromium:safari");
		expect(prefs.set).toHaveBeenCalledTimes(1);
	});

	it("keeps a stored pick whose browser is gone, saying it is not installed and cannot be used", async () => {
		stored = "chromium:brave";
		status.browsers = [chrome];
		await mount();
		expect(field().value).toBe("chromium:brave");
		expect(labels()).toContain(translate("settings.gui.defaultBrowser.notInstalled", { name: "Brave" }));
		expect(text()).toContain(translate("settings.gui.defaultBrowserRelayUnverified", { name: "Brave" }));
		expect(installButton()).toBeNull();
	});

	it("says a picked browser cannot be verified, keeps the pick, and offers its extension install", async () => {
		stored = "chromium:chrome";
		status.browsers = [chrome];
		await mount();
		expect(field().value).toBe("chromium:chrome");
		expect(text()).toContain(translate("settings.gui.defaultBrowserRelayUnverified", { name: "Google Chrome" }));
		expect(prefs.set).not.toHaveBeenCalled();
		const button = installButton();
		expect(button?.textContent).toBe(translate("settings.gui.defaultBrowserInstall"));
		await act(async () => reactProps(button as Element).onClick?.());
		expect(prefs.installBrowserRelay).toHaveBeenCalledWith("chrome");
		const toast = useToastStore.getState().toasts[0];
		expect(toast?.message).toBe(translate("settings.gui.defaultBrowserSteps"));
		expect(toast?.title).toBe(translate("settings.gui.defaultBrowserStepsTitle", { name: "Google Chrome" }));
	});

	it("offers no install for a browser stock registers no native host for", async () => {
		stored = "chromium:edge";
		status.browsers = [edge];
		await mount();
		expect(text()).toContain(translate("settings.gui.defaultBrowserRelayUnverified", { name: "Microsoft Edge" }));
		expect(installButton()).toBeNull();
	});

	it("toasts when the install fails", async () => {
		stored = "chromium:chrome";
		status.browsers = [chrome];
		prefs.installBrowserRelay.mockRejectedValueOnce(new Error("omp missing"));
		await mount();
		await act(async () => reactProps(installButton() as Element).onClick?.());
		expect(useToastStore.getState().toasts.map(toast => toast.title)).toContain(
			translate("settings.gui.defaultBrowserInstallFailed"),
		);
	});

	it("shows no note for automatic and built-in", async () => {
		status.browsers = [chrome];
		await mount();
		await choose("builtin");
		expect(installButton()).toBeNull();
		await choose("auto");
		expect(installButton()).toBeNull();
		expect(text()).not.toContain(translate("settings.gui.defaultBrowserRelayUnverified", { name: "Google Chrome" }));
	});

	it("looks again when the window regains focus, so a browser installed meanwhile is listed", async () => {
		await mount();
		expect(options()).not.toContain("chromium:chrome");
		const probes = prefs.defaultBrowserStatus.mock.calls.length;

		status = { ...status, browsers: [chrome] };
		await act(async () => {
			window.dispatchEvent(new Event("focus"));
		});
		await act(async () => {
			await Promise.resolve();
		});
		expect(prefs.defaultBrowserStatus.mock.calls.length).toBe(probes + 1);
		expect(options()).toContain("chromium:chrome");
	});
});
