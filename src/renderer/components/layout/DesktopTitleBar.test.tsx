import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { type ChromeViewer, chromeLayout } from "../../lib/chrome-layout";
import { I18nProvider, translate } from "../../lib/i18n";
import { installTabHistory } from "../../lib/tab-history";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { DesktopTitleBar } from "./DesktopTitleBar";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
const native = {
	minimize: vi.fn(async () => {}),
	toggleMaximize: vi.fn(async () => {}),
	close: vi.fn(async () => {}),
	showMenu: vi.fn(async () => {}),
};
Object.assign(window, { omp: { windowChrome: { native } } });
let root: Root | undefined;

async function show(viewer: ChromeViewer = "windows", maximized = false, fullscreen = false, disabledContent = false) {
	if (!root) {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host as unknown as globalThis.Element);
	}
	await act(async () =>
		root?.render(
			<I18nProvider>
				<DesktopTitleBar
					layout={chromeLayout(viewer, fullscreen)}
					maximized={maximized}
					disabledContent={disabledContent}
				>
					Session one
				</DesktopTitleBar>
			</I18nProvider>,
		),
	);
}

function button(key: string) {
	const element = document.querySelector<HTMLButtonElement>(`button[aria-label="${translate(key)}"]`);
	if (!element) throw new Error(`Missing button: ${key}`);
	return element;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	useUiStore.setState({ destination: "session", panelVisible: false, sidebarVisible: true, paneExpanded: false });
	useTabsStore.setState({ split: null });
	vi.clearAllMocks();
});

it("opens the Windows menu at its trigger and sends caption actions to the native window", async () => {
	await show();
	const menu = button("titlebar.appMenu");
	Object.assign(menu, { getBoundingClientRect: () => ({ left: 28, bottom: 32 }) });
	await act(async () => {
		menu.click();
		button("titlebar.minimize").click();
		button("titlebar.maximize").click();
	});
	expect(native.showMenu).toHaveBeenCalledWith(28, 32);
	expect(native.minimize).toHaveBeenCalledOnce();
	expect(native.toggleMaximize).toHaveBeenCalledOnce();
	await show("windows", true);
	await act(async () => {
		button("titlebar.restore").click();
		button("titlebar.close").click();
	});
	expect(native.toggleMaximize).toHaveBeenCalledTimes(2);
	expect(native.close).toHaveBeenCalledOnce();
	await show("windows", true, true);
	expect(document.querySelector("[data-caption-buttons]")).toBeNull();
	expect(button("titlebar.appMenu")).toBeTruthy();
	await show("mac");
	expect(document.body.textContent).toContain("OMPdesk");
	expect(document.querySelector("[aria-haspopup=menu], [data-caption]")).toBeNull();
});

it("keeps native caption actions available while setup disables app controls", async () => {
	await show("windows", false, false, true);
	expect(button("titlebar.toggleSidebar").closest("[inert]")).not.toBeNull();
	expect(document.querySelector("[inert]")?.textContent).toContain("Session one");
	expect(button("titlebar.minimize").closest("[inert]")).toBeNull();
	await act(async () => button("titlebar.minimize").click());
	expect(native.minimize).toHaveBeenCalledOnce();
});

it("navigates destination history and offers panel opening only for a session with a closed panel", async () => {
	const unsubscribe = installTabHistory();
	try {
		await show();
		expect(button("hotkeys.row.navBack").disabled).toBe(true);
		await act(async () => useUiStore.setState({ destination: "settings" }));
		expect(document.querySelector("[data-tour=panel]")).toBeNull();
		await act(async () => button("hotkeys.row.navBack").click());
		expect(useUiStore.getState().destination).toBe("session");
		await act(async () => button("titlebar.sidePanel").click());
		expect(useUiStore.getState().panelVisible).toBe(true);
		expect(document.querySelector("[data-tour=panel]")).toBeNull();
		await act(async () => button("hotkeys.row.navForward").click());
		expect(useUiStore.getState().destination).toBe("settings");
	} finally {
		unsubscribe();
	}
});

it("keeps a drag target after the sidebar closes and retains split geometry through expand and restore", async () => {
	const split = { axis: "rows" as const, ratio: 0.3, first: { tabId: "one" }, second: { tabId: "two" } };
	useTabsStore.setState({ split });
	useUiStore.setState({ sidebarVisible: true });
	await show();
	await act(async () => button("titlebar.toggleSidebar").click());
	expect(button("titlebar.toggleSidebar").getAttribute("aria-pressed")).toBe("false");
	expect(document.querySelector("[data-titlebar-drag]")).not.toBeNull();
	await act(async () => button("titlebar.expandPane").click());
	expect(useUiStore.getState().paneExpanded).toBe(true);
	await act(async () => button("titlebar.restorePanes").click());
	expect(useUiStore.getState().paneExpanded).toBe(false);
	expect(useTabsStore.getState().split).toBe(split);
	await act(async () => button("titlebar.expandPane").click());
	await act(async () => useTabsStore.setState({ split: null }));
	await act(async () => useTabsStore.setState({ split }));
	expect(button("titlebar.expandPane")).toBeTruthy();
});
