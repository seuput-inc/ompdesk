import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quietBots } from "../../dev-harness/fixture-quiet-bot";
import { I18nProvider } from "../../lib/i18n";
import { useBotsStore } from "../../stores/bots";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";
import { type SessionTab, useTabsStore } from "../../stores/tabs";
import { useTodoStore } from "../../stores/todo";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { useDockFacts } from "./dock/use-dock-facts";

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
Object.assign(window as unknown as Record<string, unknown>, {
	innerWidth: 1280,
	innerHeight: 900,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	omp: { rpc: { setTodos: vi.fn(async () => ({ type: "response", command: "set_todos", success: true })) } },
});

const { createRoot } = await import("react-dom/client");
const { WorkspaceDock } = await import("./dock/WorkspaceDock");
const { LiveStepPeek } = await import("./LiveStepPeek");
await import("./dock/TodoSortableList");

const command: ToolEntry = {
	toolName: "bash",
	args: { command: "bun test" },
	streamingArgs: "",
	result: undefined,
	isError: false,
	endTime: null,
	status: "running",
	startTime: 1,
};

let container: HTMLElement;
let root: Root;

async function render(state: "running" | "complete"): Promise<void> {
	await act(async () => {
		root.render(
			<I18nProvider>
				<LiveStepPeek thinkingLive={false} toolCallIds={["bash"]} state={state} liveTail={state === "running"} />
				<WorkspaceDock />
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useTodoStore.getState().reset();
	useToolsStore.getState().reset();
	useSessionStore.setState({ goal: null, goalState: null });
	useUiStore.setState({ dockCollapsed: {}, dockFocus: null });
});

describe("todo progress and the goal", () => {
	it("live in the dock alone: the running work card draws neither, before and after the run", async () => {
		useToolsStore.setState(toolEntriesState([["bash", command]]));
		useTodoStore.getState().setPhases([
			{
				name: "Work",
				tasks: [
					{ content: "Write the fix", status: "completed" },
					{ content: "Run the tests", status: "in_progress" },
					{ content: "Ship it", status: "pending" },
				],
			},
		]);
		useSessionStore.setState({ goal: { objective: "Ship the release" }, goalState: { status: "active" } });
		container = document.createElement("div") as unknown as HTMLElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);

		for (const state of ["running", "complete"] as const) {
			await render(state);
			const work = container.querySelector(".omp-live-step");
			expect(work?.querySelector(".omp-work-todo, .omp-work-context")).toBeNull();
			expect(work?.textContent).not.toContain("Ship the release");
			expect(container.querySelector('section[aria-label="Todos"]')).not.toBeNull();
			expect(container.querySelector("[data-goal-dock]")?.textContent).toContain("Ship the release");
			expect(container.textContent?.split("Ship the release")).toHaveLength(2);
		}
	});
});

describe("the dock's island", () => {
	it("shows a subagent's row between turns and hides it while a turn runs, when the live card shows the lanes", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([{ id: "a1", index: 0, agent: "task", status: "running", lastUpdate: 0 }]);
		container = document.createElement("div") as unknown as HTMLElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		for (const [streaming, shown] of [
			[true, false],
			[false, true],
		] as const) {
			useSessionStore.setState({ isStreaming: streaming });
			await render(streaming ? "running" : "complete");
			expect(container.querySelector("[data-workspace-island]") !== null, `streaming=${streaming}`).toBe(shown);
		}
		useSubagentsStore.getState().reset();
		useSessionStore.setState({ isStreaming: false });
	});
});

function Facts() {
	return <output>{JSON.stringify(useDockFacts().links)}</output>;
}

it("looks up only running sessions on their bot's host and keeps their last links offline", async () => {
	const device = "desk";
	const home = "/bot/home";
	const bots = quietBots(home, true).map(bot => ({ ...bot, device }));
	const host = { name: "Desk", device, online: true, bots, items: [] };
	const state = { bots, items: [], remote: [host] };
	const tab: SessionTab = {
		id: "parent",
		device,
		cwd: "/bot",
		sessionPath: home,
		status: "ready",
		kind: "agent",
		unreadDone: false,
	};
	const children = Array.from(
		{ length: 65 },
		(_, i): SessionTab => ({
			...tab,
			id: `tab-${i}`,
			sessionPath: `/child/${i}`,
			openedBy: tab.id,
			status: "running",
		}),
	);
	const links = ["tab-64", "/child/64", "tab-64"].map((session, i) => ({
		session,
		number: 3 - i,
		title: `Item ${i}`,
	}));
	const read = vi.fn(async (_device: string, request: { sessions: string[] }) => ({
		protocol: 2,
		links: links.filter(l => request.sessions.includes(l.session)),
	}));
	const oldBots = useBotsStore.getState();
	const oldTabs = useTabsStore.getState();
	const oldBridge = globalThis.window.omp;
	Object.assign(window, { omp: { ...oldBridge, bots: { itemsV2: read } } });
	container = document.createElement("div") as unknown as HTMLElement;
	root = createRoot(container);
	try {
		useBotsStore.setState({ state });
		useTabsStore.setState({ tabs: [tab], activeTabId: tab.id });
		await act(async () =>
			root.render(
				<I18nProvider>
					<Facts />
				</I18nProvider>,
			),
		);
		expect(read).not.toHaveBeenCalled();
		await act(async () =>
			useTabsStore.setState({
				tabs: [tab, ...children, { ...children[0]!, device: "other", id: "foreign", sessionPath: "/foreign" }],
			}),
		);
		expect(read.mock.calls.map(([source, req]) => [source, req.sessions.length])).toEqual([
			[device, 128],
			[device, 2],
		]);
		expect(read.mock.calls[1]?.[1]).toEqual({
			protocol: 2,
			action: "itemsLinked",
			bot: bots[0]!.id,
			sessions: ["/child/64", "tab-64"],
		});
		const shown = JSON.stringify(links.map(l => ({ ...l, session: "/child/64" })));
		expect(container.textContent).toBe(shown);

		await act(async () => useBotsStore.setState({ itemRevision: () => 1 }));
		expect(read).toHaveBeenCalledTimes(2);
		read.mockRejectedValue(new Error("disconnect"));
		await act(async () => useBotsStore.setState({ linkRevision: () => 2 }));
		expect(read).toHaveBeenCalledTimes(4);
		expect(container.textContent).toBe(shown);
		await act(async () => useBotsStore.setState({ state: { ...state, remote: [{ ...host, online: false }] } }));
		await act(async () => useTabsStore.setState({ tabs: [tab, children[64]!] }));
		expect(read).toHaveBeenCalledTimes(4);
		expect(container.textContent).toBe(shown);
	} finally {
		await act(async () => {
			root.render(null);
		});
		Object.assign(window, { omp: oldBridge });
		useBotsStore.setState(oldBots);
		useTabsStore.setState(oldTabs);
	}
});
