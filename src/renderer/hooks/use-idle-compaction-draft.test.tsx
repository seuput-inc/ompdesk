import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComposerStore } from "../stores/composer";
import { addRuntimeStore, deleteSessionRuntime, registerSessionRuntime } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";
import { useIdleCompactionDraft } from "./use-idle-compaction-draft";

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

let container: HTMLElement;
let root: Root;
type Answer = { success: boolean; data: { armed: boolean } };
const answerAtOnce = async (_command: unknown): Promise<Answer> => ({ success: true, data: { armed: false } });
let answer = answerAtOnce;
const command = vi.fn((sent: unknown) => answer(sent));
let composer = createComposerStore();

function Effects() {
	useIdleCompactionDraft();
	return null;
}

function tab(status: string, sessionId = "s-1") {
	return [{ id: "tab-1", sessionId, status }] as never;
}

function sent(): unknown[] {
	return command.mock.calls.map(call => call[0]);
}

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root.render(<Effects />));
}

beforeEach(() => {
	command.mockClear();
	answer = answerAtOnce;
	composer = createComposerStore();
	const runtime = registerSessionRuntime({ tabId: "tab-1", command: command as never, stores: new Map() });
	addRuntimeStore(runtime, "composer", composer);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	deleteSessionRuntime("tab-1");
	useTabsStore.setState({ tabs: [], activeTabId: null });
});

describe("useIdleCompactionDraft", () => {
	it("reports the draft once the tab is ready and then only empty ⇄ non-empty changes", async () => {
		useTabsStore.setState({ tabs: tab("starting"), activeTabId: "tab-1" });
		await mount();
		expect(sent()).toEqual([]);
		await act(async () => useTabsStore.setState({ tabs: tab("ready") }));
		expect(sent()).toEqual([
			{ type: "set_idle_compaction_draft", empty: true },
			{ type: "set_next_prompt_draft", empty: true },
		]);
		await act(async () => composer.getState().setDraft("h"));
		await act(async () => composer.getState().setDraft("hello"));
		// Whitespace counts as empty, like stock's `getText().trim()`.
		await act(async () => composer.getState().setDraft("   "));
		expect(sent()).toEqual([
			{ type: "set_idle_compaction_draft", empty: true },
			{ type: "set_next_prompt_draft", empty: true },
			{ type: "set_idle_compaction_draft", empty: false },
			{ type: "set_next_prompt_draft", empty: false },
			{ type: "set_idle_compaction_draft", empty: true },
			{ type: "set_next_prompt_draft", empty: true },
		]);
	});

	it("reports again after an omp restart and stops once the tab closes", async () => {
		useTabsStore.setState({ tabs: tab("ready"), activeTabId: "tab-1" });
		await mount();
		await act(async () => composer.getState().setDraft("draft"));
		expect(sent()).toHaveLength(4);
		await act(async () => useTabsStore.setState({ tabs: tab("starting") }));
		await act(async () => useTabsStore.setState({ tabs: tab("ready") }));
		expect(sent().slice(-2)).toEqual([
			{ type: "set_idle_compaction_draft", empty: false },
			{ type: "set_next_prompt_draft", empty: false },
		]);
		await act(async () => useTabsStore.setState({ tabs: [] }));
		await act(async () => composer.getState().setDraft(""));
		expect(sent()).toHaveLength(6);
	});

	it("sends a change only after omp took the previous one, so a late answer never leaves a stale draft state", async () => {
		const pending: Array<() => void> = [];
		const applied: unknown[] = [];
		useTabsStore.setState({ tabs: tab("ready"), activeTabId: "tab-1" });
		await mount();
		answer = sent =>
			new Promise(resolve =>
				pending.push(() => {
					applied.push(sent);
					resolve({ success: true, data: { armed: false } });
				}),
			);
		await act(async () => composer.getState().setDraft("run the tests"));
		await act(async () => composer.getState().setDraft(""));
		// omp takes the newest command first, as two calls in flight may arrive.
		while (pending.length > 0) await act(async () => pending.pop()?.());
		const suggestionStates = applied.filter(
			c => typeof c === "object" && c !== null && "type" in c && c.type === "set_next_prompt_draft",
		);
		expect(suggestionStates.at(-1)).toEqual({ type: "set_next_prompt_draft", empty: true });
	});
});
