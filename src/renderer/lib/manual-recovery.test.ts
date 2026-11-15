import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcManualRecovery, RpcManualRecoveryDisposition, RpcResponse } from "../../shared/rpc-types";
import { createComposerStore } from "../stores/composer";
import { useOutboxStore } from "../stores/outbox";
import { reconcileManualRecovery } from "./manual-recovery";

const stored = new Map<string, string>();
let failWrites = false;
vi.stubGlobal("localStorage", {
	getItem: (key: string) => stored.get(key) ?? null,
	setItem: (key: string, value: string) => {
		if (failWrites) throw new Error("quota");
		stored.set(key, value);
	},
	removeItem: (key: string) => stored.delete(key),
});

const ok = (data: unknown): RpcResponse => ({ type: "response", command: "test", success: true, data });
const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
const envelope = { role: "user" as const, content: "same", requestId: "request-1" };
const entry: RpcManualRecovery = {
	recoveryId: "recovery-1",
	instance: "bridge-1",
	id: "original-id",
	intent: "draft",
	state: "withdrawn",
	entry: { id: "original-id", text: "same", images: [image], envelope },
};

beforeEach(() => {
	stored.clear();
	failWrites = false;
	useOutboxStore.getState().reset();
});

describe("manual recovery", () => {
	it("persists the complete original and previous draft before acknowledging the same IDs", async () => {
		const composer = createComposerStore();
		composer.getState().setDraft("existing draft");
		composer.getState().setImages([{ content: image, preview: "preview" }]);
		const ack = vi.fn(async (recoveryId: string, disposition: RpcManualRecoveryDisposition) => {
			if (disposition.kind !== "draft") throw new Error("unexpected discard");
			const records = JSON.parse(stored.get("omp.outbox.v1") ?? "[]");
			expect(records).toEqual([
				expect.objectContaining({
					id: disposition.draftId,
					send: expect.objectContaining({
						source: { recoveryId, instance: "bridge-1", id: "original-id", intent: "draft", envelope },
						images: [image],
						previous: { draft: "existing draft", images: [image] },
						acknowledged: false,
					}),
				}),
			]);
			return ok({ acknowledged: true, recoveryId, disposition });
		});
		const rpc = { getManualRecovery: vi.fn(async () => ok({ entries: [entry] })), ackManualRecovery: ack };
		await reconcileManualRecovery(rpc, "|s:session-1", composer);
		const item = useOutboxStore.getState().items[0];
		expect(item?.send).toMatchObject({ kind: "manual", acknowledged: true, text: "same", images: [image] });
		expect(composer.getState().draft).toBe("existing draft");
		expect(ack).toHaveBeenCalledTimes(1);
		await reconcileManualRecovery(rpc, "|s:session-1", composer);
		expect(useOutboxStore.getState().items).toHaveLength(1);
		expect(ack).toHaveBeenCalledTimes(1);
	});

	it("keeps an unconfirmed withdrawal visible but neither acknowledges nor edits it", async () => {
		const composer = createComposerStore();
		const rpc = {
			getManualRecovery: vi.fn(async () => ok({ entries: [{ ...entry, state: "unconfirmed" }] })),
			ackManualRecovery: vi.fn(),
		};
		await reconcileManualRecovery(rpc, "|s:session-1", composer);
		const item = useOutboxStore.getState().items[0];
		expect(item?.send).toMatchObject({ kind: "manual", recovery: { kind: "withdrawal_uncertain", intent: "draft" } });
		expect(rpc.ackManualRecovery).not.toHaveBeenCalled();
		expect(composer.getState().beginRecoveredEdit(item?.id ?? "missing")).toBe(false);
	});

	it("retries only discard acknowledgement for a completed discard intent", async () => {
		const composer = createComposerStore();
		const discarded = { ...entry, recoveryId: "discard-1", intent: "discard" as const };
		const ackManualRecovery = vi.fn(async (recoveryId: string, disposition: RpcManualRecoveryDisposition) =>
			ok({ acknowledged: true, recoveryId, disposition }),
		);
		await reconcileManualRecovery(
			{
				getManualRecovery: vi.fn(async () => ok({ entries: [discarded] })),
				ackManualRecovery,
			},
			"|s:session-1",
			composer,
		);
		expect(ackManualRecovery).toHaveBeenCalledWith("discard-1", { kind: "discard" });
		expect(useOutboxStore.getState().items).toEqual([]);
		expect(composer.getState().draft).toBe("");
	});

	it("does not acknowledge an uncertain discard until the bridge confirms withdrawal", async () => {
		const composer = createComposerStore();
		const discarded = { ...entry, recoveryId: "discard-1", intent: "discard" as const };
		const getManualRecovery = vi.fn(async () => ok({ entries: [{ ...discarded, state: "unconfirmed" }] }));
		const ackManualRecovery = vi.fn(async (recoveryId: string, disposition: RpcManualRecoveryDisposition) =>
			ok({ acknowledged: true, recoveryId, disposition }),
		);
		await reconcileManualRecovery({ getManualRecovery, ackManualRecovery }, "|s:session-1", composer);
		expect(ackManualRecovery).not.toHaveBeenCalled();
		expect(useOutboxStore.getState().items[0]?.send).toMatchObject({
			recovery: { kind: "withdrawal_uncertain", intent: "discard" },
		});
		getManualRecovery.mockResolvedValueOnce(ok({ entries: [discarded] }));
		await reconcileManualRecovery({ getManualRecovery, ackManualRecovery }, "|s:session-1", composer);
		expect(ackManualRecovery).toHaveBeenCalledWith("discard-1", { kind: "discard" });
		expect(useOutboxStore.getState().items).toEqual([]);
	});

	it("does not acknowledge if local storage fails and retries the exact draft ID after an ACK failure", async () => {
		const composer = createComposerStore();
		const getManualRecovery = vi.fn(async () => ok({ entries: [entry] }));
		const ackManualRecovery = vi.fn(
			async (_id: string, _disposition: RpcManualRecoveryDisposition): Promise<RpcResponse> => {
				throw new Error("link down");
			},
		);
		failWrites = true;
		await reconcileManualRecovery({ getManualRecovery, ackManualRecovery }, "|s:session-1", composer);
		expect(ackManualRecovery).not.toHaveBeenCalled();
		failWrites = false;
		await reconcileManualRecovery({ getManualRecovery, ackManualRecovery }, "|s:session-1", composer);
		const draftId = useOutboxStore.getState().items[0]?.id;
		expect(ackManualRecovery).toHaveBeenCalledWith("recovery-1", { kind: "draft", draftId });
		getManualRecovery.mockResolvedValueOnce(ok({ entries: [] }));
		ackManualRecovery.mockImplementationOnce(async (recoveryId, disposition) =>
			ok({ acknowledged: true, recoveryId, disposition }),
		);
		await reconcileManualRecovery({ getManualRecovery, ackManualRecovery }, "|s:session-1", composer);
		expect(ackManualRecovery).toHaveBeenLastCalledWith("recovery-1", { kind: "draft", draftId });
		expect(useOutboxStore.getState().items[0]?.send).toMatchObject({ acknowledged: true });
	});
});
