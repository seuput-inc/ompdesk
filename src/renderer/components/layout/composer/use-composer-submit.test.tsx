import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcCommand, RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { useComposerStore } from "../../../stores/composer";
import { useMessagesStore } from "../../../stores/messages";
import { useOutboxStore } from "../../../stores/outbox";
import { useSessionStore } from "../../../stores/session";
import { setFocusedSessionRuntime } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { useToastStore } from "../../../stores/toast";
import { useComposerSubmit } from "./use-composer-submit";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const saved = new Map<string, string>();
let failWrites = false;
vi.stubGlobal("localStorage", {
	getItem: (key: string) => saved.get(key) ?? null,
	setItem: (key: string, value: string) => {
		if (failWrites) throw new Error("storage unavailable");
		saved.set(key, value);
	},
	removeItem: (key: string) => {
		if (failWrites) throw new Error("storage unavailable");
		saved.delete(key);
	},
});

const response = Promise.withResolvers<RpcResponse>();
let pending: PromiseWithResolvers<RpcResponse> = response;
const command = vi.fn(async (request: RpcCommand): Promise<RpcResponse> => {
	if (request.type === "prompt") return pending.promise;
	return { type: "response", command: request.type, success: true, data: {} };
});
let send: (overrideText?: string) => void;
let root: Root;

function Probe() {
	const text = useComposerStore(state => state.draft);
	const images = useComposerStore(state => state.images);
	const sending = useComposerStore(state => state.sending);
	const setText = useComposerStore(state => state.setDraft);
	const setImages = useComposerStore(state => state.setImages);
	const setSending = useComposerStore(state => state.setSending);
	send = useComposerSubmit({
		text,
		images,
		sending,
		status: "ready",
		isStreaming: true,
		commands: [],
		emojiAutocomplete: false,
		routeReady: true,
		setText,
		setImages,
		setMenu: () => {},
		setSending,
	});
	return null;
}

async function mount() {
	(window as unknown as Record<string, unknown>).omp = {
		rpc: {
			command,
			compact: vi.fn(),
			historyRecord: vi.fn(async () => ({
				type: "response",
				command: "history_record",
				success: true,
				data: { skipped: true },
			})),
		},
		prefs: { get: vi.fn(async () => false) },
	};
	useSessionStore.setState({ status: "ready", sessionId: "session-1", cwd: "/project", isStreaming: true });
	useTabsStore.setState({
		tabs: [
			{ id: "tab-1", sessionId: "session-1", cwd: "/project", status: "ready", kind: "agent", unreadDone: false },
		],
		activeTabId: "tab-1",
	});
	root = createRoot(document.createElement("div") as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<Probe />
			</I18nProvider>,
		);
	});
}

function holdManual() {
	const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
	const envelope = { role: "user" as const, content: "original", requestId: "request-1" };
	expect(
		useOutboxStore.getState().hold({
			id: "manual-1",
			session: "|s:session-1",
			at: 1,
			state: "held",
			send: {
				kind: "manual",
				source: { recoveryId: "recovery-1", instance: "bridge-1", id: "original-id", intent: "draft", envelope },
				text: "original",
				images: [image],
				previous: { draft: "", images: [] },
				editing: false,
				acknowledged: true,
				recovery: { kind: "draft" },
			},
		}),
	).toBe(true);
	useComposerStore.getState().setDraft("prior draft");
	useComposerStore.getState().setImages([{ content: image, preview: "prior-preview" }]);
	expect(useComposerStore.getState().beginRecoveredEdit("manual-1")).toBe(true);
	useComposerStore.getState().setDraft("edited instruction");
	return image;
}

beforeEach(() => {
	saved.clear();
	failWrites = false;
	pending = Promise.withResolvers<RpcResponse>();
	command.mockClear();
	setFocusedSessionRuntime(null);
	useOutboxStore.getState().reset();
	useComposerStore.getState().reset();
});

afterEach(async () => {
	await act(async () => root.unmount());
	useComposerStore.getState().reset();
	useOutboxStore.getState().reset();
	useMessagesStore.getState().reset();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	useToastStore.setState({ toasts: [], heldSince: null });
	failWrites = false;
});

describe("recovered instruction submission", () => {
	it("uses a new delivery ID and restores the previous draft without overwriting newer input", async () => {
		const image = holdManual();
		await mount();
		await act(async () => send());
		await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
		const request = command.mock.calls[0]?.[0];
		expect(request).toMatchObject({ type: "prompt", message: "edited instruction", images: [image] });
		if (!request || request.type !== "prompt") throw new Error("prompt missing");
		expect(request.deliveryId).toBeTruthy();
		expect(request.deliveryId).not.toBe("original-id");
		await act(async () => useComposerStore.getState().setDraft("new typing"));
		await act(async () => {
			pending.resolve({ type: "response", command: "prompt", success: true });
			await pending.promise;
		});
		await vi.waitFor(() => expect(useOutboxStore.getState().items).toEqual([]));
		expect(useComposerStore.getState().draft).toBe("prior draft\n\nnew typing");
		expect(useComposerStore.getState().images).toEqual([{ content: image, preview: "prior-preview" }]);
	});

	it("sends nothing and keeps the draft when the attempt marker cannot be saved", async () => {
		holdManual();
		await mount();
		failWrites = true;
		await act(async () => send());
		expect(command).not.toHaveBeenCalled();
		expect(useComposerStore.getState().draft).toBe("edited instruction");
		expect(useComposerStore.getState().editingRecovered?.frozen).toBe(false);
		expect(useOutboxStore.getState().items[0]?.send).toMatchObject({ recovery: { kind: "draft" } });
	});

	it("keeps the attempt marker after an accepted send whose storage update fails, and never sends a second time", async () => {
		holdManual();
		await mount();
		await act(async () => send());
		await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
		failWrites = true;
		await act(async () => {
			pending.resolve({ type: "response", command: "prompt", success: true });
			await pending.promise;
		});
		await vi.waitFor(() => expect(useComposerStore.getState().editingRecovered).toBeNull());
		failWrites = false;
		useOutboxStore.getState().reload();
		expect(useOutboxStore.getState().items[0]?.send).toMatchObject({
			kind: "manual",
			recovery: { kind: "attempt", deliveryId: expect.any(String) },
		});
		await act(async () => {
			useComposerStore.getState().reset();
			expect(useComposerStore.getState().beginRecoveredEdit("manual-1")).toBe(false);
		});
		await act(async () => send());
		expect(command).toHaveBeenCalledTimes(1);
	});
});
