/**
 * The composer's queue pill shows one list of pending instructions and a polite live region.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcManualRecoveryDisposition, RpcQueuedMessage } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { useComposerStore } from "../../../stores/composer";
import { useQueueStore } from "../../../stores/queue";
import { useSessionStore } from "../../../stores/session";
import { routeCommands } from "../../../test-support/route-commands";
import { ComposerQueueLive, ComposerQueuePill } from "./ComposerQueue";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
// The popover places itself from its anchor and its own box.
const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
Object.defineProperty(proto, "getBoundingClientRect", {
	configurable: true,
	value: () => ({ width: 100, height: 28, left: 300, top: 700, right: 400, bottom: 728 }),
});
Object.defineProperty(proto, "offsetWidth", { configurable: true, get: () => 448 });
Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 300 });
Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });

interface TestElement {
	textContent: string | null;
	getAttribute(name: string): string | null;
	remove(): void;
	dispatchEvent(event: object): boolean;
	querySelector(selector: string): TestElement | null;
	querySelectorAll(selector: string): ArrayLike<TestElement>;
}

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

let container: TestElement;
let root: Root;
let queueRemove: Mock;
let getQueue: Mock;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function click(element: TestElement): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
	await flush();
}

function byLabel(label: string): TestElement {
	const element = document.querySelector(`button[aria-label="${label}"]`) as unknown as TestElement | null;
	if (!element) throw new Error(`missing button ${label}`);
	return element;
}

function pill(): TestElement | null {
	return document.querySelector("[data-queue-pill]") as unknown as TestElement | null;
}

async function openPopover(): Promise<void> {
	const trigger = pill();
	if (!trigger) throw new Error("pill missing");
	await click(trigger);
}

function queued(id: string, text: string, extra: Partial<RpcQueuedMessage> = {}): RpcQueuedMessage {
	return { id, text, state: "ready", ...extra };
}

/** The composer's focus hand-back, called once a control is gone with its row. */
let settled: Mock<() => void>;

async function mount(entries: RpcQueuedMessage[]): Promise<void> {
	settled = vi.fn();
	queueRemove = vi.fn(async () => ok({ removed: true, recoveryId: "recovery-1", intent: "discard" }));
	getQueue = vi.fn(async () => {
		const current = useQueueStore.getState();
		return ok({ instance: current.instance, entries: current.entries });
	});
	const ackManualRecovery = vi.fn(async (recoveryId: string, disposition: RpcManualRecoveryDisposition) =>
		ok({ acknowledged: true, recoveryId, disposition }),
	);
	(window as unknown as Record<string, unknown>).omp = {
		rpc: routeCommands({ getQueue, queueRemove, ackManualRecovery }),
	};
	useSessionStore.setState({ status: "ready" });
	useQueueStore.getState().setFromFrame({ instance: "bridge-1", entries });
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ComposerQueuePill onSettled={settled} />
				<ComposerQueueLive />
			</I18nProvider>,
		);
	});
	await flush();
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	document.body.innerHTML = "";
	useQueueStore.getState().setFromFrame({ instance: "reset", entries: [] });
	useComposerStore.getState().reset();
	useSessionStore.getState().reset();
	vi.restoreAllMocks();
});

describe("ComposerQueuePill", () => {
	it("renders no pill while the queue is empty", async () => {
		await mount([]);
		expect(pill()).toBeNull();
	});

	it("shows the tab's queue as its hydrate and frames left it, reading nothing itself on mount", async () => {
		await mount([queued("s1", "first")]);
		expect(getQueue).not.toHaveBeenCalled();
		expect(pill()?.textContent).toContain("1 queued");
		await act(async () =>
			useQueueStore
				.getState()
				.setFromFrame({ instance: "bridge-1", entries: [queued("f1", "one"), queued("f2", "two")] }),
		);
		expect(pill()?.textContent).toContain("2 queued");
		expect(getQueue).not.toHaveBeenCalled();
	});

	it("counts the queued messages in one pill and adds nothing to the composer until it opens", async () => {
		await mount([queued("s1", "first"), queued("f1", "second"), queued("f2", "third")]);
		expect(pill()?.textContent).toContain("3 queued");
		expect(pill()?.getAttribute("aria-label")).toBe("Show 3 queued messages");
		expect(pill()?.getAttribute("aria-expanded")).toBe("false");
		expect(document.querySelector("[data-queue-popover]")).toBeNull();
		expect(document.querySelector(".omp-composer-queue")).toBeNull();
	});

	it("shows a single instruction list without lane controls or delivery policies", async () => {
		await mount([queued("s1", "first"), queued("f1", "second"), queued("f2", "third")]);
		await openPopover();
		expect(pill()?.getAttribute("aria-expanded")).toBe("true");
		const rows = Array.from(document.querySelectorAll("[data-queue-row]")) as unknown as TestElement[];
		expect(rows.map(row => row.textContent)).toEqual(["first", "second", "third"]);
		expect(document.querySelectorAll("[data-lane-head]")).toHaveLength(0);
		expect(document.querySelector("[data-queue-policy]")).toBeNull();
		expect(document.querySelector("[data-queue-primary]")).toBeNull();
		expect(document.body.textContent).not.toContain("After this turn");
		expect(document.body.textContent).not.toContain("Steer now");
	});

	it("shows the whole message when its text is clicked", async () => {
		await mount([queued("f1", "line one\nline two")]);
		await openPopover();
		const text = document.querySelector("[data-queue-row-text]") as unknown as TestElement;
		expect(text.getAttribute("aria-expanded")).toBe("false");
		await click(text);
		expect(text.getAttribute("aria-expanded")).toBe("true");
		await click(text);
		expect(text.getAttribute("aria-expanded")).toBe("false");
	});

	it("shows pictures from the actual entry and removes a ready instruction by its instance and id", async () => {
		const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
		await mount([queued("picture-id", "", { images: [image, image] })]);
		await openPopover();
		const row = document.querySelector("[data-queue-row]") as unknown as TestElement;
		expect(row.textContent).toContain("Image only · 2");
		expect(row.querySelectorAll("[data-queue-images] img")).toHaveLength(2);
		expect(row.querySelector("[data-queue-images]")?.textContent).toContain("2 images");
		await click(byLabel("Remove: Image only · 2"));
		expect(queueRemove).toHaveBeenCalledWith("bridge-1", "picture-id", "discard");
		expect(useQueueStore.getState().entries).toEqual([]);
		expect(settled).toHaveBeenCalledTimes(1);
	});

	it("names in-flight and approval-held instructions without offering removal", async () => {
		await mount([queued("one", "one", { state: "in_flight" }), queued("two", "two", { state: "approval_safety" })]);
		await openPopover();
		expect(document.body.textContent).toContain("Delivering");
		expect(document.body.textContent).toContain("Waiting for approval");
		expect(document.querySelector('button[aria-label^="Remove:"]')).toBeNull();
		expect(queueRemove).not.toHaveBeenCalled();
	});
});

describe("ComposerQueueLive", () => {
	/** The queue hydrates right after mount: the region stays quiet for the first moments. */
	const QUIET = 850;
	async function quiet(): Promise<void> {
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, QUIET);
			await promise;
		});
	}
	const live = () => document.querySelector("[data-composer-live]") as unknown as TestElement;

	it("is one polite status region, empty until something happens", async () => {
		await mount([queued("s1", "one")]);
		expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
		expect(live().getAttribute("aria-live")).toBe("polite");
		expect(live().textContent).toBe("");
	});

	it("says Queued (n) when a message joins", async () => {
		await mount([queued("s1", "one")]);
		await quiet();
		await act(async () =>
			useQueueStore
				.getState()
				.setFromFrame({ instance: "bridge-1", entries: [queued("s1", "one"), queued("f1", "two")] }),
		);
		expect(live().textContent).toBe("Queued (2)");
	});

	it("says a Stop brought the queue back", async () => {
		await mount([queued("s1", "one")]);
		await quiet();
		await act(async () => {
			useComposerStore.getState().holdRestored([{ id: "s1", text: "one", images: [] }]);
		});
		expect(live().textContent).toBe("Stopped. 1 queued messages are back, nothing will send until you resume");
	});
});
