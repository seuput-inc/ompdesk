/** Queue removal uses the bridge's instance and opaque entry identity. */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcManualRecoveryDisposition, RpcQueuedMessage, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useComposerStore } from "../../stores/composer";
import { useOutboxStore } from "../../stores/outbox";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { routeCommands } from "../../test-support/route-commands";
import { type QueueActions, useQueueActions } from "./use-queue-actions";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
	getItem: (key: string) => storage.get(key) ?? null,
	setItem: (key: string, value: string) => storage.set(key, value),
	removeItem: (key: string) => storage.delete(key),
});

const ok = (data?: unknown): RpcResponse => ({ type: "response", command: "x", success: true, data });
let root: Root;
let actions: QueueActions;
let queueRemove: Mock;
let getManualRecovery: Mock;
let ackManualRecovery: Mock;

function Probe() {
	actions = useQueueActions();
	return null;
}

function queued(id: string, text: string): RpcQueuedMessage {
	return { id, text, state: "ready" };
}

async function mount(entries: RpcQueuedMessage[]): Promise<void> {
	queueRemove = vi.fn(async () => ok({ removed: true, recoveryId: "recovery-1", intent: "discard" }));
	const getQueue = vi.fn(async () => {
		const { instance, entries: current } = useQueueStore.getState();
		return ok({ instance, entries: current });
	});
	getManualRecovery = vi.fn(async () => ok({ entries: [] }));
	ackManualRecovery = vi.fn(async (recoveryId: string, disposition: RpcManualRecoveryDisposition) =>
		ok({ acknowledged: true, recoveryId, disposition }),
	);
	(window as unknown as Record<string, unknown>).omp = {
		rpc: routeCommands({ getQueue, getManualRecovery, queueRemove, ackManualRecovery }),
	};
	useSessionStore.setState({ status: "ready", sessionId: "session-1" });
	useTabsStore.setState({
		tabs: [{ id: "tab-1", sessionId: "session-1", cwd: "/p", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "tab-1",
	});
	useQueueStore.getState().setFromFrame({ instance: "bridge-1", entries });
	root = createRoot(document.createElement("div") as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<Probe />
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	await act(async () => root.unmount());
	useQueueStore.getState().setFromFrame({ instance: "reset", entries: [] });
	useSessionStore.getState().reset();
	useComposerStore.getState().reset();
	useOutboxStore.getState().reset();
	useTabsStore.getState().reset();
	storage.clear();
	vi.restoreAllMocks();
});

describe("useQueueActions", () => {
	it("waits for confirmation and removes only the selected ID with duplicate text", async () => {
		await mount([queued("first", "same"), queued("second", "same")]);
		const result = Promise.withResolvers<RpcResponse>();
		queueRemove.mockReturnValueOnce(result.promise);
		let removal = Promise.resolve(false);
		await act(async () => {
			removal = actions.remove("bridge-1", "second");
		});
		expect(useQueueStore.getState().entries.map(entry => entry.id)).toEqual(["first", "second"]);
		expect(queueRemove).toHaveBeenCalledWith("bridge-1", "second", "discard");
		await act(async () => {
			result.resolve(ok({ removed: true, recoveryId: "recovery-1", intent: "discard" }));
			expect(await removal).toBe(true);
		});
		expect(useQueueStore.getState().entries.map(entry => entry.id)).toEqual(["first"]);
	});

	it("brings the authoritative payload and images into the composer only after durable acknowledgement", async () => {
		await mount([queued("original-id", "same")]);
		const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
		const envelope = { role: "user" as const, content: "actual", requestId: "request-1" };
		const original = { id: "original-id", text: "actual", images: [image], envelope };
		queueRemove.mockResolvedValueOnce(
			ok({ removed: true, recoveryId: "recovery-1", intent: "draft", entry: original }),
		);
		getManualRecovery.mockResolvedValueOnce(
			ok({
				entries: [
					{
						recoveryId: "recovery-1",
						instance: "bridge-1",
						id: "original-id",
						intent: "draft",
						state: "withdrawn",
						entry: original,
					},
				],
			}),
		);
		useComposerStore.getState().setDraft("prior");
		await act(async () => expect(await actions.edit("bridge-1", "original-id")).toBe(true));
		expect(queueRemove).toHaveBeenCalledWith("bridge-1", "original-id", "draft");
		expect(useComposerStore.getState()).toMatchObject({ draft: "actual", images: [{ content: image }] });
		expect(useOutboxStore.getState().items[0]?.send).toMatchObject({
			kind: "manual",
			source: { id: "original-id", recoveryId: "recovery-1", envelope },
			acknowledged: true,
		});
	});

	it("keeps a refused or failed removal", async () => {
		await mount([queued("first", "keep")]);
		queueRemove.mockResolvedValueOnce(ok({ removed: false })).mockRejectedValueOnce(new Error("offline"));
		await act(async () => expect(await actions.remove("bridge-1", "first")).toBe(false));
		await act(async () => expect(await actions.remove("bridge-1", "first")).toBe(false));
		expect(useQueueStore.getState().entries).toEqual([queued("first", "keep")]);
	});

	it.each(["draft", "discard"] as const)(
		"shows an uncertain %s withdrawal without hiding the original or acknowledging it",
		async intent => {
			await mount([queued("original-id", "pending")]);
			const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
			const envelope = { role: "user" as const, content: "pending", requestId: "request-1" };
			const entry = { id: "original-id", text: "pending", images: [image], envelope };
			queueRemove.mockRejectedValueOnce(new Error("response lost"));
			getManualRecovery.mockResolvedValueOnce(
				ok({
					entries: [
						{
							recoveryId: "recovery-1",
							instance: "bridge-1",
							id: "original-id",
							intent,
							state: "unconfirmed",
							entry,
						},
					],
				}),
			);
			useComposerStore.getState().setDraft("prior");
			await act(async () => {
				const result =
					intent === "draft"
						? await actions.edit("bridge-1", "original-id")
						: await actions.remove("bridge-1", "original-id");
				expect(result).toBe(false);
			});
			expect(useQueueStore.getState().entries).toEqual([queued("original-id", "pending")]);
			expect(useComposerStore.getState().draft).toBe("prior");
			expect(useOutboxStore.getState().items[0]?.send).toMatchObject({
				kind: "manual",
				source: { recoveryId: "recovery-1", intent, envelope },
				images: [image],
				acknowledged: false,
				recovery: { kind: "withdrawal_uncertain", intent },
			});
			expect(ackManualRecovery).not.toHaveBeenCalled();
		},
	);

	it("never removes an in-flight, approval-held or stale-instance entry", async () => {
		await mount([
			{ ...queued("flight", "one"), state: "in_flight" },
			{ ...queued("safety", "two"), state: "approval_safety" },
			queued("ready", "three"),
		]);
		await act(async () => {
			expect(await actions.remove("bridge-1", "flight")).toBe(false);
			expect(await actions.remove("bridge-1", "safety")).toBe(false);
			expect(await actions.remove("old-instance", "ready")).toBe(false);
		});
		expect(queueRemove).not.toHaveBeenCalled();
	});

	it("does not remove a matching ID from a newer bridge instance when an old acknowledgement arrives", async () => {
		await mount([queued("same-id", "old")]);
		const result = Promise.withResolvers<RpcResponse>();
		queueRemove.mockReturnValueOnce(result.promise);
		let removal = Promise.resolve(false);
		await act(async () => {
			removal = actions.remove("bridge-1", "same-id");
		});
		useQueueStore.getState().setFromFrame({ instance: "bridge-2", entries: [queued("same-id", "new")] });
		await act(async () => {
			result.resolve(ok({ removed: true, recoveryId: "recovery-1", intent: "discard" }));
			await removal;
		});
		expect(useQueueStore.getState()).toMatchObject({ instance: "bridge-2", entries: [queued("same-id", "new")] });
	});
});
