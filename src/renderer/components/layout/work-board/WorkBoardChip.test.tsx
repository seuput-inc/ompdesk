import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHONE_QUERY } from "../../../hooks/shell-queries";
import { I18nProvider } from "../../../lib/i18n";
import { EMPTY_TURN_METER } from "../../../lib/turn-meter";
import { useAutopilotStore } from "../../../stores/autopilot";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useMessagesStore } from "../../../stores/messages";
import { useModelWaitTogetherStore } from "../../../stores/model-wait-together";
import { useSessionStore } from "../../../stores/session";
import { setFocusedSessionRuntime } from "../../../stores/session-runtime-context";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { useTodoStore } from "../../../stores/todo";
import { useToolsStore } from "../../../stores/tools";

// The back gesture itself is lib/back-layer's (its own test); here only what a layer's close does to the strip.
const backLayer = vi.hoisted(() => ({ close: null as (() => void) | null }));
vi.mock("../../../hooks/use-back-layer", () => ({
	useBackLayer: (open: boolean, onClose: () => void) => {
		backLayer.close = open ? onClose : null;
	},
}));

const { document, window, Element, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Element,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const getJobs = vi.fn(async () => ({ type: "response", command: "get_jobs", success: true, data: { rows: [] } }));
Reflect.set(window, "omp", { rpc: { getJobs }, prefs: { get: vi.fn(async () => undefined), set: vi.fn() } });

const { createRoot } = await import("react-dom/client");
const { WorkBoardChip } = await import("./WorkBoardChip");
const { TodoReceived, useTodoFreshness } = await import("../../chat/dock/TodoFreshness");

let container: HTMLElement;
let root: Root;

async function mount(children: ReactNode = null): Promise<void> {
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t1",
		bundles: new Map(),
	});
	await act(async () => {
		root.render(
			<I18nProvider>
				<WorkBoardChip>{children}</WorkBoardChip>
			</I18nProvider>,
		);
	});
}

beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useTodoStore.getState().reset();
	useSubagentsStore.getState().reset();
	useExtensionUiStore.setState({ pendingRequests: [] });
	useToolsStore.getState().reset();
});

describe("WorkBoardChip, the phone's work strip", () => {
	it("shows nothing when there is nothing to say", async () => {
		await mount();
		expect(container.querySelector("[data-work-chip]")).toBeNull();
	});

	it("pins a phone question while other lines advance; touch pauses them and reduced motion keeps the overflow count", async () => {
		document.documentElement.dataset.platform = "web";
		const reduced = document.createElement("span");
		let reduce = false;
		vi.stubGlobal("matchMedia", (query: string) =>
			query === "(prefers-reduced-motion: reduce)"
				? Object.assign(reduced, { matches: reduce })
				: Object.assign(document.createElement("span"), { matches: query === PHONE_QUERY }),
		);
		vi.useFakeTimers();
		try {
			useTodoStore.getState().setPhases([
				{
					name: "Build",
					tasks: [
						{ content: "Build the dock", status: "in_progress" },
						{ content: "Verify", status: "pending" },
					],
				},
			]);
			useExtensionUiStore
				.getState()
				.pushRequest({ type: "extension_ui_request", id: "q", method: "confirm", title: "Proceed?", message: "" });
			useSubagentsStore.getState().setSnapshots(
				["Alpha", "Beta"].map((id, index) => ({
					id,
					index,
					agent: id,
					status: "running",
					lastUpdate: Date.now(),
				})),
			);
			await mount();
			const chip = container.querySelector<HTMLButtonElement>("[data-work-chip]")!;
			const lines = () => [...chip.querySelectorAll("[data-work-line]")].map(line => line.textContent);
			const initial = lines();
			expect(initial).toHaveLength(3);
			expect(initial[0]).toContain("Proceed?");
			expect(initial[1]).toContain("Build the dock");
			await act(async () =>
				chip.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true }), { pointerType: "touch" })),
			);
			await act(async () => vi.advanceTimersByTime(5_001));
			expect(lines()).toEqual(initial);
			await act(async () => chip.dispatchEvent(new Event("pointerup", { bubbles: true })));
			await act(async () => vi.advanceTimersByTime(5_001));
			expect(lines()[0]).toEqual(initial[0]);
			expect(lines().slice(1)).not.toEqual(initial.slice(1));
			await act(async () => {
				reduce = true;
				reduced.dispatchEvent(new globalThis.Event("change"));
			});
			expect(lines()[2]).toContain("+2");
			expect(container.querySelectorAll("[data-work-strip] ul li")).toHaveLength(5);
		} finally {
			delete document.documentElement.dataset.platform;
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it("marks its pane while it shows, for the dock rows that give way (perf: no :has() on the pane)", async () => {
		container.className = "omp-session-pane";
		await mount();
		expect(container.hasAttribute("data-work-board-strip")).toBe(false);
		await act(async () => useTodoStore.setState({ turnActive: true }));
		expect(container.querySelector("[data-work-chip]")).not.toBeNull();
		expect(container.hasAttribute("data-work-board-strip")).toBe(true);
		await act(async () => useTodoStore.setState({ turnActive: false }));
		expect(container.querySelector("[data-work-chip]")).toBeNull();
		expect(container.hasAttribute("data-work-board-strip")).toBe(false);
	});

	it("says a request the model has not answered for a while instead of Working…", async () => {
		await mount();
		const label = () => container.querySelector("[data-work-chip] [role=status]")?.textContent ?? "";
		try {
			await act(async () => useTodoStore.setState({ turnActive: true }));
			expect(label()).toContain("Working…");
			await act(async () =>
				useMessagesStore.setState({ turnMeter: { ...EMPTY_TURN_METER, modelWaitSince: Date.now() - 75_000 } }),
			);
			expect(label()).toContain("Waiting for the model's response · 1m");
			expect(label()).not.toContain("Working…");
		} finally {
			await act(async () => useMessagesStore.setState({ turnMeter: EMPTY_TURN_METER }));
		}
	});

	it("says the wait is shared when other sessions wait on the same provider, and only for tabs main counted", async () => {
		await mount();
		const label = () => container.querySelector("[data-work-chip] [role=status]")?.textContent ?? "";
		try {
			setFocusedSessionRuntime("t1");
			await act(async () => useTodoStore.setState({ turnActive: true }));
			await act(async () =>
				useMessagesStore.setState({ turnMeter: { ...EMPTY_TURN_METER, modelWaitSince: Date.now() - 4 * 60_000 } }),
			);
			expect(label()).toContain("Waiting for the model's response · 4m");
			expect(label()).not.toContain("together");
			await act(async () => useModelWaitTogetherStore.setState({ tabs: { other: 5 } }));
			expect(label()).not.toContain("together");
			await act(async () => useModelWaitTogetherStore.setState({ tabs: { t1: 3 } }));
			expect(label()).toContain("Waiting for the model's response · 4m · 3 sessions waiting together");
		} finally {
			setFocusedSessionRuntime(null);
			await act(async () => {
				useModelWaitTogetherStore.setState({ tabs: {} });
				useMessagesStore.setState({ turnMeter: EMPTY_TURN_METER });
			});
		}
	});

	it("names a live Autopilot run and its cycle, never just its Goal, even with the run's plan open", async () => {
		useSessionStore.setState({ goal: { objective: "Autopilot: keep developing" }, goalState: { status: "active" } });
		useTodoStore.getState().setPhases([{ name: "Cycle", tasks: [{ content: "Reproduce", status: "in_progress" }] }]);
		useAutopilotStore.getState().apply({
			active: true,
			state: "running",
			cycle: 3,
			now: { n: 3, area: "bugs", startedAt: 1 },
			branch: "autopilot/2026-10-20",
		});
		try {
			await mount();
			const label = container.querySelector("[data-work-chip] [role=status]")?.textContent ?? "";
			expect(label).toContain("Autopilot");
			expect(label).toContain("Cycle 3");
		} finally {
			await act(async () => {
				useAutopilotStore.getState().reset();
				useSessionStore.getState().reset();
			});
		}
	});

	it("says the plan's progress with the current task, and counts running subagents", async () => {
		useTodoStore.getState().setPhases([
			{
				name: "Fix",
				tasks: [
					{ content: "Reproduce", status: "completed" },
					{ content: "Wait for the row", status: "in_progress" },
					{ content: "Run the suite", status: "pending" },
				],
			},
		]);
		useSubagentsStore.getState().setSnapshots([
			{ id: "a1", index: 1, agent: "scout", status: "running", lastUpdate: Date.now() },
			{ id: "a2", index: 2, agent: "worker", status: "running", lastUpdate: Date.now() },
		]);
		await mount();
		const strip = container.querySelector("[data-work-chip]");
		expect(strip?.textContent).toContain("1/3");
		expect(strip?.textContent).toContain("Wait for the row");
		expect(strip?.querySelector('[data-count="agents"]')?.textContent).toBe("2");
		expect(strip?.querySelector('[data-count="jobs"]')).toBeNull();
		// The live region still carries the spoken label.
		expect(strip?.querySelector('[role="status"] .sr-only')?.textContent).toBe("1 of 3 done");
	});

	it("keeps the current task after work alone and still reports incoming instructions", async () => {
		useTodoStore.getState().setPhases([
			{
				name: "Fix",
				tasks: [
					{ content: "Reproduce", status: "completed" },
					{ content: "Wait for the row", status: "in_progress" },
				],
			},
		]);
		useTodoStore.getState().setDrift({
			changedAt: Date.now() - 58 * 60_000 - 5000,
			stale: "drift",
			received: [],
			receivedCount: 0,
		});
		await mount();
		const strip = container.querySelector("[data-work-chip]");
		expect(strip?.querySelector(".omp-work-chip-plan")?.textContent).toBe("1/2Wait for the row");
		expect(strip?.querySelector('[role="status"] .sr-only')?.textContent).toBe("1 of 2 done");

		// A list that follows the work keeps its current task and only says when it last changed.
		await act(async () =>
			useTodoStore
				.getState()
				.setDrift({ changedAt: Date.now() - 3 * 60_000 - 5000, stale: null, received: [], receivedCount: 0 }),
		);
		expect(strip?.querySelector(".omp-work-chip-plan")?.textContent).toBe("1/2Wait for the row3m ago");
		expect(strip?.querySelector('[role="status"] .sr-only')?.textContent).toBe("1 of 2 done");

		// Instructions since the list changed lead with their count in place of the current task, as news.
		const changedAt = Date.now() - 12 * 60_000 - 5000;
		await act(async () =>
			useTodoStore.getState().setDrift({
				changedAt,
				stale: "drift",
				received: [
					{ at: changedAt + 60_000, text: "Also fix the README typo on line 3" },
					{ at: changedAt + 120_000, text: "Then rename parse() to parseConfig() everywhere" },
				],
				receivedCount: 2,
			}),
		);
		expect(strip?.querySelector(".omp-work-chip-plan")?.textContent).toBe("1/2Since list change: 2·12m ago");
		expect(strip?.querySelector('.omp-work-chip-plan [data-status-dot="neutral"]')).not.toBeNull();
		expect(strip?.querySelector('[role="status"] .sr-only')?.textContent).toBe("1 of 2 done · Since list change: 2");
	});

	it("says the figure Needs you counts, ahead of the plan's progress", async () => {
		useTodoStore.getState().setPhases([{ name: "Fix", tasks: [{ content: "Reproduce", status: "in_progress" }] }]);
		for (const id of ["c1", "c2"])
			useExtensionUiStore
				.getState()
				.pushRequest({ type: "extension_ui_request", id, method: "confirm", title: "Go?", message: "" });
		await mount();
		const strip = container.querySelector("[data-work-chip]");
		expect(strip?.querySelector('[role="status"]')?.textContent).toBe("2 need you");
		expect(strip?.getAttribute("data-state")).toBe("waiting");
		await act(async () => useExtensionUiStore.setState({ pendingRequests: [] }));
		expect(strip?.querySelector('[role="status"] .sr-only')?.textContent).toBe("0 of 1 done");
	});

	it("works only while a subagent is at work: a parked one is live but leaves the strip's pulse idle", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([{ id: "a1", index: 1, agent: "scout", status: "parked", lastUpdate: Date.now() }]);
		await mount();
		const strip = container.querySelector("[data-work-chip]");
		expect(strip?.getAttribute("data-state")).toBe("idle");
		await act(async () =>
			useSubagentsStore
				.getState()
				.setSnapshots([{ id: "a1", index: 1, agent: "scout", status: "running", lastUpdate: Date.now() }]),
		);
		expect(strip?.getAttribute("data-state")).toBe("working");
	});

	describe("expanding in place", () => {
		const rowTaps = vi.fn();
		async function mountPlan(): Promise<void> {
			useTodoStore.getState().setPhases([{ name: "Fix", tasks: [{ content: "Reproduce", status: "in_progress" }] }]);
			await mount(
				<ul>
					<li>
						<button className="omp-work-board-row" onClick={rowTaps} type="button">
							row
						</button>
					</li>
				</ul>,
			);
		}
		const strip = () => container.querySelector<HTMLElement>("[data-work-chip]");
		// A closing panel stays mounted for its 160 ms height transition, flagged `data-leaving` and inert.
		const panel = () => {
			const found = container.querySelector("[data-work-strip-panel]");
			return found?.hasAttribute("data-leaving") ? null : found;
		};
		const click = async (element: Element | null | undefined) => {
			await act(async () => {
				(element as HTMLElement | null | undefined)?.click();
			});
		};

		it("starts collapsed, expands on a tap and collapses on the next, with no scrim or sheet", async () => {
			await mountPlan();
			expect(panel()).toBeNull();
			expect(strip()?.getAttribute("aria-expanded")).toBe("false");
			await click(strip());
			expect(strip()?.getAttribute("aria-expanded")).toBe("true");
			expect(panel()).not.toBeNull();
			// Inline under the strip: the panel is inside the strip's own wrapper, and nothing dims the screen.
			expect(container.querySelector("[data-work-strip]")?.contains(panel())).toBe(true);
			expect(document.querySelector("[data-sheet-placement], [data-sheet-overlay], [data-scrim]")).toBeNull();
			expect(document.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				await click(strip());
				expect(strip()?.getAttribute("aria-expanded")).toBe("false");
				// It leaves the DOM once its exit transition is over.
				await act(async () => {
					await vi.advanceTimersByTimeAsync(220);
				});
			} finally {
				vi.useRealTimers();
			}
			expect(container.querySelector("[data-work-strip-panel]")).toBeNull();
		});

		it("collapses on a row tap after the row acted, but not on a fold toggle", async () => {
			rowTaps.mockClear();
			await mountPlan();
			await click(strip());
			await click(container.querySelector("button.omp-work-board-row"));
			expect(rowTaps).toHaveBeenCalledOnce();
			expect(panel()).toBeNull();
		});

		it("stays open for a row that expands in place (the memory row), so its titles can show", async () => {
			const expands = vi.fn();
			useTodoStore.getState().setPhases([{ name: "Fix", tasks: [{ content: "Reproduce", status: "in_progress" }] }]);
			await mount(
				<button className="omp-work-board-row" data-board-expands="" onClick={expands} type="button">
					memory
				</button>,
			);
			await click(strip());
			await click(container.querySelector("button[data-board-expands]"));
			expect(expands).toHaveBeenCalledOnce();
			expect(panel()).not.toBeNull();
			expect(strip()?.getAttribute("aria-expanded")).toBe("true");
		});

		it("stays open for a tap on a received instruction, which shows that line whole", async () => {
			// The strip panel's plan zone lists them (WorkBoard's TodoReceived); the board itself is not mounted here.
			function Received() {
				return <TodoReceived freshness={useTodoFreshness()} list />;
			}
			const changedAt = Date.now() - 12 * 60_000 - 5000;
			useTodoStore.getState().setPhases([{ name: "Fix", tasks: [{ content: "Reproduce", status: "in_progress" }] }]);
			useTodoStore.getState().setDrift({
				changedAt,
				stale: null,
				received: [{ at: changedAt + 60_000, text: "Then rename parse() to parseConfig() everywhere" }],
				receivedCount: 1,
			});
			await mount(<Received />);
			await click(strip());
			await click(container.querySelector("[data-todo-received-line]"));
			expect(panel()).not.toBeNull();
			expect(container.querySelector("[data-todo-received-line]")?.getAttribute("aria-expanded")).toBe("true");
		});

		it("collapses on a tap outside, and on the back gesture's layer", async () => {
			await mountPlan();
			await click(strip());
			await act(async () => {
				document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
			});
			expect(panel()).toBeNull();
			await click(strip());
			expect(panel()).not.toBeNull();
			expect(backLayer.close).not.toBeNull();
			await act(async () => {
				backLayer.close?.();
			});
			expect(panel()).toBeNull();
		});
	});

	it("points its chevron the way the panel will open: upward from a strip low in its pane", async () => {
		const rects: Record<string, { top: number; bottom: number }> = {
			"omp-session-pane": { top: 48, bottom: 800 },
			"omp-work-strip": { top: 560, bottom: 600 },
			"omp-composer-box": { top: 690, bottom: 790 },
		};
		const original = Element.prototype.getBoundingClientRect;
		Element.prototype.getBoundingClientRect = function (this: Element) {
			const rect = Object.entries(rects).find(([name]) => this.classList?.contains(name))?.[1] ?? {
				top: 0,
				bottom: 0,
			};
			return { ...rect, left: 0, right: 0, width: 0, height: rect.bottom - rect.top, x: 0, y: rect.top } as DOMRect;
		};
		try {
			container.className = "omp-session-pane";
			const opens = () => container.querySelector("[data-work-chip]")?.getAttribute("data-opens");
			// Mounted with nothing to say, the strip renders nothing; the room is measured once it shows.
			await mount();
			expect(container.querySelector("[data-work-chip]")).toBeNull();
			await act(async () => useTodoStore.setState({ turnActive: true }));
			expect(opens()).toBe("up");
			// Gone and back, it is measured again where it shows now.
			await act(async () => useTodoStore.setState({ turnActive: false }));
			expect(container.querySelector("[data-work-chip]")).toBeNull();
			rects["omp-work-strip"] = { top: 60, bottom: 100 };
			await act(async () => useTodoStore.setState({ turnActive: true }));
			expect(opens()).toBeNull();
		} finally {
			Element.prototype.getBoundingClientRect = original;
			container.className = "";
		}
	});
});
