import { describe, expect, it, vi } from "vitest";
import type { ImageContent, RpcGetQueueResult } from "../../shared/rpc-types";
import { handlers } from "./queue";
import type { LocalCommandContext } from "./types";

function receiver() {
	const image: ImageContent = { type: "image", mimeType: "image/png", data: "AAAA" };
	let snapshot: RpcGetQueueResult = {
		instance: "original-process",
		entries: [
			{ id: "first", text: "same text", state: "ready" },
			{ id: "second", text: "same text", images: [image], state: "ready" },
			{ id: "picture", text: "", images: [image], state: "approval_safety" },
		],
	};
	const stock = vi.fn(async () => {
		throw new Error("Stock text matching must not be used");
	});
	const ctx: LocalCommandContext = {
		cwd: "/repo",
		omp: { bin: "omp", version: "18.20.2", run: vi.fn() },
		send: stock,
		bridge: {
			connected: true,
			async request<T>(method: string, params?: unknown): Promise<T> {
				if (method === "composer.get_queue") return snapshot as T;
				if (method !== "composer.queue_remove") throw new Error("unsupported");
				if (
					typeof params !== "object" ||
					params === null ||
					!("instance" in params) ||
					!("id" in params) ||
					!("intent" in params) ||
					(params.intent !== "draft" && params.intent !== "discard")
				)
					throw new Error("Missing original handle and intent");
				if (params.instance !== snapshot.instance) throw new Error("stale instance");
				const entry = snapshot.entries.find(entry => entry.id === params.id);
				if (!entry || entry.state === "in_flight") return { removed: false } as T;
				snapshot = { ...snapshot, entries: snapshot.entries.filter(item => item !== entry) };
				return {
					removed: true,
					recoveryId: `recovery-${entry.id}`,
					intent: params.intent,
					entry: {
						id: entry.id,
						text: entry.text,
						images: entry.images,
						envelope: {
							role: "user",
							content: [{ type: "text", text: entry.text }, ...(entry.images ?? [])],
							timestamp: 1,
						},
					},
				} as T;
			},
		},
	};
	const get = () => handlers.get_queue({ type: "get_queue" }, ctx) as Promise<RpcGetQueueResult>;
	const remove = (instance: string, queueId: string) =>
		handlers.queue_remove({ type: "queue_remove", instance, queueId, intent: "draft" }, ctx);
	return {
		get,
		remove,
		stock,
		replace: (next: RpcGetQueueResult) => {
			snapshot = next;
		},
	};
}

describe("canonical pending instructions", () => {
	it("withdraws the selected original among equal texts without losing the other message or attachments", async () => {
		const q = receiver();
		const before = await q.get();
		await expect(q.remove(before.instance, "second")).resolves.toEqual({
			removed: true,
			recoveryId: "recovery-second",
			intent: "draft",
			entry: expect.objectContaining({ id: "second", text: "same text", images: before.entries[1].images }),
		});
		expect(await q.get()).toEqual({ instance: before.instance, entries: [before.entries[0], before.entries[2]] });
		expect(q.stock).not.toHaveBeenCalled();
	});

	it("returns the original image-only payload instead of reconstructing it from a chip", async () => {
		const q = receiver();
		const before = await q.get();
		await expect(q.remove(before.instance, "picture")).resolves.toMatchObject({
			removed: true,
			recoveryId: "recovery-picture",
			intent: "draft",
			entry: { id: "picture", text: "", images: before.entries[2].images },
		});
		expect((await q.get()).entries.map(entry => entry.id)).toEqual(["first", "second"]);
		expect(q.stock).not.toHaveBeenCalled();
	});

	it("refuses a stale process handle without withdrawing the replacement process's message", async () => {
		const q = receiver();
		const before = await q.get();
		q.replace({ instance: "replacement-process", entries: before.entries });
		await expect(q.remove(before.instance, "second")).rejects.toThrow("stale instance");
		expect((await q.get()).entries).toEqual(before.entries);
		expect(q.stock).not.toHaveBeenCalled();
	});
});
