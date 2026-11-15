/**
 * The composer's run-state wiring: Esc hints, Stop busy while a stop is in flight, and placeholder priority.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcCommand, RpcResponse } from "../../../../shared/rpc-types";
import type * as ShellMode from "../../../hooks/use-shell-mode";
import { resetHardwareKeyboardForTests } from "../../../lib/hardware-keyboard";
import { I18nProvider } from "../../../lib/i18n";
import { useComposerStore } from "../../../stores/composer";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useInputHistoryStore } from "../../../stores/input-history";
import { useMessagesStore } from "../../../stores/messages";
import { useModelStore } from "../../../stores/model";
import { useNextPromptStore } from "../../../stores/next-prompt";
import { useQueueStore } from "../../../stores/queue";
import { useSessionStore } from "../../../stores/session";
import { useTabsStore } from "../../../stores/tabs";
import { useToastStore } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { InputArea } from "./InputArea";

/** The input the shell reports: touch (a phone or tablet) or none (the desktop). */
const input = vi.hoisted(() => ({ current: null as "touch" | null }));
vi.mock("../../../hooks/use-shell-mode", async importOriginal => ({
	...(await importOriginal<typeof ShellMode>()),
	useShellInput: () => input.current,
}));

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
elementPrototype.focus = () => {};
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};
if (typeof elementPrototype.setSelectionRange !== "function")
	elementPrototype.setSelectionRange = function (this: Record<string, unknown>, start: number, end: number) {
		this.selectionStart = start;
		this.selectionEnd = end;
	};
elementPrototype.getBoundingClientRect = () => ({
	bottom: 0,
	height: 0,
	left: 0,
	right: 0,
	top: 0,
	width: 0,
	x: 0,
	y: 0,
	toJSON: () => ({}),
});
Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });

interface TestElement {
	textContent: string | null;
	remove(): void;
	getAttribute(name: string): string | null;
	hasAttribute(name: string): boolean;
	querySelector(selector: string): TestElement | null;
}

type Handler = (event: Record<string, unknown>) => void;

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

let container: TestElement;
let root: Root;

function propsOf(element: unknown): Record<string, Handler | undefined> {
	const record = element as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("element has no React props");
	return record[key] as Record<string, Handler | undefined>;
}

function findTextarea(): TestElement {
	const textarea = document.querySelector("textarea") as unknown as TestElement | null;
	if (!textarea) throw new Error("composer textarea not found");
	return textarea;
}

async function typeInto(value: string): Promise<void> {
	const element = findTextarea();
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
	if (descriptor?.set) descriptor.set.call(element, value);
	else (element as unknown as { value: string }).value = value;
	await act(async () => propsOf(element).onChange?.({ target: element, currentTarget: element }));
}

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

function button(label: string): TestElement | null {
	return document.querySelector(`button[aria-label="${label}"]`) as unknown as TestElement | null;
}

const placeholder = () => findTextarea().getAttribute("placeholder");

async function mount(opts: { streaming?: boolean } = {}) {
	const prompt = vi.fn(async () => ok());
	const rpcCommand = vi.fn(async (command: RpcCommand): Promise<RpcResponse> => {
		if (command.type === "get_queue") return ok({ instance: "test", entries: [] });
		return ok();
	});
	(window as unknown as Record<string, unknown>).omp = {
		fs: { list: vi.fn(async () => ({ entries: [] })) },
		events: { onTabCommandsUpdate: vi.fn(() => () => {}), onConfigUpdate: vi.fn(() => () => {}) },
		prefs: { set: vi.fn(async () => ({})), get: vi.fn(async () => []) },
		rpc: {
			historyRecent: vi.fn(async () => ok([])),
			historySearch: vi.fn(async () => ok([])),
			getAvailableCommands: vi.fn(async () => ok({ commands: [] })),
			command: rpcCommand,
			prompt,
		},
	};
	useSessionStore.setState({
		status: "ready",
		isStreaming: opts.streaming ?? false,
		queuedMessageCount: 0,
		cwd: "/tmp",
		sessionId: "s1",
		sessionFile: null,
		sessionName: null,
	});
	useQueueStore.getState().setFromFrame({ instance: "test", entries: [] });
	useTabsStore.setState({
		tabs: [{ kind: "agent", id: "t0", cwd: "/tmp", status: "ready", unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<InputArea />
			</I18nProvider>,
		);
	});
	await flush();
}

beforeEach(() => {
	input.current = null;
	resetHardwareKeyboardForTests();
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
	useModelStore.getState().reset();
	useComposerStore.getState().reset();
	useQueueStore.getState().setFromFrame({ instance: "test", entries: [] });
	useExtensionUiStore.setState({ pendingRequests: [], loginRequestIds: {} });
	useInputHistoryStore.setState({ entries: [], navIndex: -1, navDraft: "", navContext: undefined });
	useNextPromptStore.getState().reset();
	useTabsStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	useUiStore.setState({ displayPreferences: {} });
	vi.restoreAllMocks();
});

describe("Esc and Stop in the composer", () => {
	it("shows Press Esc again to stop while the first Esc of a stop waits, and drops it with an edit", async () => {
		await mount({ streaming: true });
		await typeInto("my draft");
		expect(document.querySelector("[data-stop-hint]")).toBeNull();
		await act(async () => useComposerStore.getState().armStop());
		expect(document.querySelector("[data-stop-hint]")?.textContent).toBe(
			"Press Esc again to stop the turn. Your draft stays.",
		);
		await typeInto("my draft!");
		expect(document.querySelector("[data-stop-hint]")).toBeNull();
	});

	it("says Deciding how to run this… while the automatic mode choice runs", async () => {
		await mount();
		await act(async () => useComposerStore.getState().setDecidingMode(true));
		expect(document.querySelector("[data-deciding-hint]")?.textContent).toBe("Deciding how to run this…");
		await act(async () => useComposerStore.getState().setDecidingMode(false));
		expect(document.querySelector("[data-deciding-hint]")).toBeNull();
	});

	it("keeps Stop busy and inert until the turn ends", async () => {
		await mount({ streaming: true });
		const stop = button("Stop");
		expect(stop?.hasAttribute("disabled")).toBe(false);
		await act(async () => useComposerStore.getState().setStopping(true));
		const busy = button("Stop");
		expect(busy?.hasAttribute("disabled")).toBe(true);
		expect(busy?.getAttribute("aria-busy")).toBe("true");
		await act(async () => useComposerStore.getState().setStopping(false));
		expect(button("Stop")?.hasAttribute("disabled")).toBe(false);
	});
});

describe("the field's placeholder, by priority", () => {
	it("goes idle, then steer while a turn runs", async () => {
		await mount({ streaming: true });
		expect(placeholder()).toBe("Add an instruction…");
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		expect(placeholder()).not.toBe("Add an instruction…");
	});

	it("puts a pending question above the current instruction placeholder", async () => {
		await mount({ streaming: true });
		await act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "q1",
				method: "input",
				title: "Which file?",
			}),
		);
		expect(placeholder()).toBe("Answer above, or add an instruction…");
	});
});
