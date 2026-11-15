/** Pending snapshots retain bridge identity, ordering and attachments. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcQueuedMessage, RpcResponse } from "../../shared/rpc-types";
import { routeCommands } from "../test-support/route-commands";
import { useQueueStore } from "./queue";

const getQueue = vi.fn();
(globalThis as Record<string, unknown>).window = { omp: { rpc: routeCommands({ getQueue }) } };

function queued(id: string, text: string): RpcQueuedMessage {
	return { id, text, state: "ready" };
}

function ok(data: unknown): RpcResponse {
	return { type: "response", command: "get_queue", success: true, data };
}

afterEach(() => {
	getQueue.mockReset();
	useQueueStore.getState().setFromFrame({ instance: "reset", entries: [] });
});

describe("queue store", () => {
	it("retains exact IDs, order, images and states from the bridge, including identical text", () => {
		const firstImage = { type: "image" as const, data: "AA==", mimeType: "image/png" };
		const secondImage = { type: "image" as const, data: "BB==", mimeType: "image/png" };
		const entries: RpcQueuedMessage[] = [
			{ ...queued("first", "same"), images: [firstImage] },
			{ ...queued("second", "same"), images: [secondImage], state: "in_flight" },
			{ ...queued("image-only", ""), images: [firstImage, secondImage], state: "approval_safety" },
		];
		expect(useQueueStore.getState().setFromFrame({ instance: "bridge-1", entries })).toBe(true);
		expect(useQueueStore.getState()).toMatchObject({ instance: "bridge-1", entries });
		expect(getQueue).not.toHaveBeenCalled();

		const next = [entries[2], entries[0]];
		useQueueStore.getState().setFromFrame({ instance: "bridge-1", entries: next });
		expect(useQueueStore.getState().entries).toEqual(next);
	});

	it("keeps a slower old read from replacing a newer snapshot", async () => {
		const old = Promise.withResolvers<RpcResponse>();
		const newer = Promise.withResolvers<RpcResponse>();
		getQueue.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
		const oldRead = useQueueStore.getState().refresh();
		const newRead = useQueueStore.getState().refresh();
		newer.resolve(ok({ instance: "new", entries: [queued("new-id", "new")] }));
		await newRead;
		old.resolve(ok({ instance: "old", entries: [queued("old-id", "old")] }));
		await oldRead;
		expect(useQueueStore.getState()).toMatchObject({ instance: "new", entries: [queued("new-id", "new")] });
	});

	it("keeps a newer frame when an earlier read finishes", async () => {
		const old = Promise.withResolvers<RpcResponse>();
		getQueue.mockReturnValueOnce(old.promise);
		const read = useQueueStore.getState().refresh();
		useQueueStore.getState().setFromFrame({ instance: "new", entries: [queued("current", "current")] });
		old.resolve(ok({ instance: "old", entries: [queued("old", "old")] }));
		await read;
		expect(useQueueStore.getState().entries.map(entry => entry.id)).toEqual(["current"]);
	});

	it("invalidates an in-flight read when the session changes", async () => {
		const old = Promise.withResolvers<RpcResponse>();
		getQueue.mockReturnValueOnce(old.promise);
		const read = useQueueStore.getState().refresh();
		useQueueStore.getState().reset();
		old.resolve(ok({ instance: "old", entries: [queued("old", "old")] }));
		await read;
		expect(useQueueStore.getState()).toMatchObject({ instance: null, entries: [] });
	});

	it("does not replace pending entries with failed or old lane-shaped reads", async () => {
		const entries = [queued("kept", "keep")];
		useQueueStore.getState().setFromFrame({ instance: "bridge-1", entries });
		expect(useQueueStore.getState().setFromFrame({ steering: [], followUp: [] })).toBe(false);
		getQueue.mockResolvedValueOnce(ok({ steering: [], followUp: [] }));
		await useQueueStore.getState().refresh();
		getQueue.mockRejectedValueOnce(new Error("sidecar down"));
		await useQueueStore.getState().refresh();
		expect(useQueueStore.getState()).toMatchObject({ instance: "bridge-1", entries });
	});
});
