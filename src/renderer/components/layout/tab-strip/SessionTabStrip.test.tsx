import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../../lib/i18n";
import { type SessionTab, useTabsStore } from "../../../stores/tabs";
import { SessionTabStrip } from "./SessionTabStrip";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

const sessions = {
	list: vi.fn(async () => []),
	listShared: async () => ({ version: "test.1", sessions: [] }),
};
Reflect.set(window, "omp", { sessions, events: { onSessionsChanged: vi.fn(() => () => {}) } });

let root: Root;
let container: HTMLElement;

const tab = (id: string, over: Partial<SessionTab> = {}): SessionTab => ({
	id,
	cwd: "/work",
	status: "ready",
	kind: "agent",
	unreadDone: false,
	title: `Session ${id}`,
	...over,
});

async function mount(onRenameActive = vi.fn()): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as globalThis.Element);
	await act(async () =>
		root.render(
			<I18nProvider>
				<SessionTabStrip
					activeContent={<span data-title-name="">Session b</span>}
					activeTitle="Session b"
					onRenameActive={onRenameActive}
				/>
			</I18nProvider>,
		),
	);
}

const tabs = () => [...container.querySelectorAll('[role="tab"]')];
const props = (element: unknown) => {
	const record = element as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$")) ?? "";
	return record[key] as Record<string, (event?: unknown) => void>;
};

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useTabsStore.getState().reset();
	vi.restoreAllMocks();
});

describe("the title bar's session tabs", () => {
	it("lists the window's tabs but an opened child off screen, renames the chosen one and switches to another", async () => {
		const switchTab = vi.fn(async () => {});
		useTabsStore.setState({
			tabs: [tab("a"), tab("b"), tab("c", { openedBy: "b" }), tab("d", { unreadDone: true, status: "running" })],
			activeTabId: "b",
			switchTab,
		});
		const rename = vi.fn();
		await mount(rename);
		expect(tabs().map(element => element.getAttribute("data-tab-id"))).toEqual(["a", "b", "d"]);
		const chosen = tabs()[1];
		expect(chosen?.hasAttribute("data-titlebar-session-name")).toBe(true);
		// The chosen tab draws the title bar's name parts; another tab its plain name.
		expect(chosen?.querySelector("[data-title-name]")?.textContent).toBe("Session b");
		expect(tabs()[0]?.querySelector("[data-title-name]")).toBeNull();
		expect(chosen?.getAttribute("aria-selected")).toBe("true");
		// A running tab leads with the working arc, an idle one with nothing.
		expect(tabs()[2]?.querySelector('[data-status-lane="working"]')).not.toBeNull();
		expect(tabs()[0]?.querySelector('[data-status-lane="none"]')).not.toBeNull();
		await act(async () => props(chosen).onClick?.());
		expect(rename).toHaveBeenCalledOnce();
		await act(async () => props(tabs()[0]).onClick?.());
		expect(switchTab).toHaveBeenCalledWith("a");
	});

	it("closes the tabs to the right of one from its menu, keeping a running one", async () => {
		const closeTab = vi.fn(async () => {});
		useTabsStore.setState({
			tabs: [tab("a"), tab("b"), tab("c"), tab("d", { status: "running" })],
			activeTabId: "b",
			closeTab,
			switchTab: vi.fn(async () => {}),
		});
		await mount();
		await act(async () => props(tabs()[1]).onContextMenu?.({ preventDefault: () => {}, clientX: 5, clientY: 5 }));
		const item = [...document.body.querySelectorAll('[role="menuitem"]')].find(
			button => button.textContent === translate("tabStrip.closeRight"),
		);
		await act(async () => props(item).onClick?.({ altKey: false }));
		expect(closeTab).toHaveBeenCalledTimes(1);
		expect(closeTab).toHaveBeenCalledWith("c");
	});
});
