import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostView } from "../../../../shared/ipc-types";
import type { UsageLimit, UsageReport } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { useModelStore } from "../../../stores/model";
import { useRemoteStore } from "../../../stores/remote";
import { useSessionStore } from "../../../stores/session";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { useTabsStore } from "../../../stores/tabs";
import { useUpdaterStore } from "../../../stores/updater";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

let reports: UsageReport[] = [];
Reflect.set(window, "omp", {
	rpc: {
		getUsage: vi.fn(async () => ({ type: "response", command: "get_usage", success: true, data: { reports } })),
	},
	prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
});

const { createRoot } = await import("react-dom/client");
const { StatusBarSegments } = await import("./StatusBarSegments");

let root: Root;
let container: HTMLElement;

function limit(id: string, usedFraction: number): UsageLimit {
	return { id, label: id, windowId: id.split(":")[1], usedFraction, resetsAt: Date.now() + 3_600_000 };
}

function report(provider: string, five: number, seven: number, active: boolean): UsageReport {
	return {
		provider,
		fetchedAt: Date.now(),
		account: `${provider}@example.com`,
		credentialId: provider.length,
		active,
		limits: [limit(`${provider}:5h`, five), limit(`${provider}:7d`, seven)],
	};
}

function host(deviceId: string, state: HostView["state"]): HostView {
	return { deviceId, name: deviceId, state } as HostView;
}

async function mount(): Promise<void> {
	useSessionStore.setState({ status: "ready" });
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t1",
	});
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () =>
		root.render(
			<I18nProvider>
				<StatusBarSegments />
			</I18nProvider>,
		),
	);
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useSidebarFolds.getState().reset();
	useSessionStore.getState().reset();
	useRemoteStore.getState().reset();
	useUpdaterStore.setState({ status: { state: "idle" } });
	vi.restoreAllMocks();
});

describe("the desktop status bar", () => {
	it("shows each provider's tightest window, the paired computers' link and an update, and hides an item from its menu", async () => {
		reports = [report("anthropic", 0.42, 0.1, true), report("openai-codex", 0.05, 0.9, false)];
		useModelStore.setState({ providers: [] });
		useRemoteStore.setState({
			state: { hosts: [host("pc-b", "online"), host("pc-c", "offline")] } as never,
		});
		useUpdaterStore.setState({ status: { state: "downloaded", version: "0.144.0", mode: "automatic" } as never });
		await mount();

		const usage = container.querySelector("[data-status-usage]");
		// Each provider by its brand, even before the catalog lists it.
		expect(usage?.textContent).toContain("Claude 42%");
		expect(usage?.textContent).toContain("ChatGPT 90%");
		expect(container.querySelector("[data-status-link]")?.getAttribute("data-status-link")).toBe("warning");
		expect(container.querySelector("[data-status-link]")?.textContent).toContain("1/2");
		expect(container.querySelector("[data-status-update]")?.textContent).toContain("0.144.0");

		const bar = container.firstElementChild as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(bar).find(name => name.startsWith("__reactProps$")) ?? "";
		const props = bar[propsKey] as { onContextMenu: (event: unknown) => void };
		await act(async () => props.onContextMenu({ preventDefault: () => {}, clientX: 10, clientY: 10 }));
		const items = [...document.body.querySelectorAll('[role="menuitemcheckbox"]')];
		expect(items.map(item => item.getAttribute("aria-checked"))).toEqual(["true", "true", "true"]);
		await act(async () => (items[1] as unknown as { click: () => void }).click());
		expect(useSidebarFolds.getState().statusHidden).toEqual({ link: true });
		expect(container.querySelector("[data-status-link]")).toBeNull();
	});

	it("opens the usage block over the bar, every account listed, and a second click closes it", async () => {
		reports = [report("anthropic", 0.42, 0.1, true), report("openai-codex", 0.05, 0.9, false)];
		useModelStore.setState({ providers: [] });
		await mount();
		const usage = container.querySelector("[data-status-usage]") as unknown as { click: () => void } | null;
		expect(document.body.querySelector("[data-usage-popover]")).toBeNull();
		await act(async () => usage?.click());
		const block = document.body.querySelector("[data-usage-popover]");
		expect(block?.querySelectorAll("[data-usage-account]")).toHaveLength(2);
		// The popover is the block's fold: no fold toggle of its own, the gear still opens accounts.
		expect(block?.querySelector("[data-sidebar-usage-toggle]")).toBeNull();
		expect(block?.querySelector("[data-sidebar-usage-open]")).not.toBeNull();
		await act(async () => usage?.click());
		expect((usage as unknown as Element).getAttribute("aria-expanded")).toBe("false");
	});
});
