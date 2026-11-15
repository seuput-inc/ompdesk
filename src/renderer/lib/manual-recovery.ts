import type { StoreApi } from "zustand/vanilla";
import type { RpcManualRecovery, RpcResponse } from "../../shared/rpc-types";
import type { ComposerStore } from "../stores/composer";
import { useOutboxStore } from "../stores/outbox";
import { expandPasteMarkers } from "./paste-blobs";
import type { TabRpc } from "./tab-rpc";

function isRecovery(value: unknown): value is RpcManualRecovery {
	if (typeof value !== "object" || value === null) return false;
	if (!("recoveryId" in value) || typeof value.recoveryId !== "string") return false;
	if (!("instance" in value) || typeof value.instance !== "string") return false;
	if (!("id" in value) || typeof value.id !== "string") return false;
	if (!("intent" in value) || (value.intent !== "draft" && value.intent !== "discard")) return false;
	if (!("state" in value) || (value.state !== "withdrawn" && value.state !== "unconfirmed")) return false;
	if (!("entry" in value) || typeof value.entry !== "object" || value.entry === null) return false;
	const entry = value.entry;
	if (!("id" in entry) || entry.id !== value.id || !("text" in entry) || typeof entry.text !== "string") return false;
	if (!("envelope" in entry) || typeof entry.envelope !== "object" || entry.envelope === null) return false;
	if (!("images" in entry) || entry.images === undefined) return true;
	return (
		Array.isArray(entry.images) &&
		entry.images.every(
			(image: unknown) =>
				typeof image === "object" &&
				image !== null &&
				"type" in image &&
				image.type === "image" &&
				"data" in image &&
				typeof image.data === "string" &&
				"mimeType" in image &&
				typeof image.mimeType === "string",
		)
	);
}

/** Persist each bridge-owned recovery before acknowledging its exact recovery and draft IDs. */
export async function reconcileManualRecovery(
	rpc: Pick<TabRpc, "getManualRecovery" | "ackManualRecovery">,
	session: string,
	composer: StoreApi<ComposerStore>,
	isCurrent: () => boolean = () => true,
): Promise<void> {
	let response: RpcResponse;
	try {
		response = await rpc.getManualRecovery();
	} catch {
		return;
	}
	if (
		!response.success ||
		typeof response.data !== "object" ||
		response.data === null ||
		!("entries" in response.data)
	)
		return;
	const { entries } = response.data;
	if (!Array.isArray(entries) || !entries.every(isRecovery)) return;
	if (!isCurrent()) return;

	for (const recovery of entries) {
		const existing = useOutboxStore
			.getState()
			.items.find(item => item.send.kind === "manual" && item.send.source.recoveryId === recovery.recoveryId);
		if (existing?.send.kind === "manual") {
			if (
				recovery.state === "withdrawn" &&
				existing.send.recovery.kind === "withdrawal_uncertain" &&
				existing.send.source.intent === recovery.intent
			) {
				useOutboxStore.getState().updateManual(existing.id, {
					recovery: recovery.intent === "draft" ? { kind: "draft" } : { kind: "discard_pending" },
				});
			}
			continue;
		}
		const current = composer.getState();
		useOutboxStore.getState().hold({
			id: crypto.randomUUID(),
			session,
			at: Date.now(),
			state: "held",
			send: {
				kind: "manual",
				source: {
					recoveryId: recovery.recoveryId,
					instance: recovery.instance,
					id: recovery.id,
					intent: recovery.intent,
					envelope: recovery.entry.envelope,
				},
				text: recovery.entry.text,
				images: recovery.entry.images ?? [],
				previous: { draft: expandPasteMarkers(current.draft), images: current.images.map(image => image.content) },
				editing: false,
				acknowledged: false,
				recovery:
					recovery.state === "unconfirmed"
						? { kind: "withdrawal_uncertain", intent: recovery.intent }
						: recovery.intent === "draft"
							? { kind: "draft" }
							: { kind: "discard_pending" },
			},
		});
	}

	const pending = useOutboxStore
		.getState()
		.items.filter(
			item =>
				item.session === session &&
				item.send.kind === "manual" &&
				!item.send.acknowledged &&
				item.send.recovery.kind !== "withdrawal_uncertain",
		);
	for (const item of pending) {
		if (!isCurrent()) return;
		if (item.send.kind !== "manual" || !useOutboxStore.getState().hold(item)) continue;
		const recoveryId = item.send.source.recoveryId;
		try {
			const disposition =
				item.send.recovery.kind === "discard_pending"
					? { kind: "discard" as const }
					: { kind: "draft" as const, draftId: item.id };
			const ack = await rpc.ackManualRecovery(recoveryId, disposition);
			if (!ack.success || typeof ack.data !== "object" || ack.data === null) continue;
			if (!("acknowledged" in ack.data) || ack.data.acknowledged !== true) continue;
			if (!("recoveryId" in ack.data) || ack.data.recoveryId !== recoveryId) continue;
			if (!("disposition" in ack.data) || typeof ack.data.disposition !== "object" || ack.data.disposition === null)
				continue;
			if (!("kind" in ack.data.disposition) || ack.data.disposition.kind !== disposition.kind) continue;
			if (disposition.kind === "discard") {
				useOutboxStore.getState().drop(item.id);
			} else {
				if (!("draftId" in ack.data.disposition) || ack.data.disposition.draftId !== item.id) continue;
				useOutboxStore.getState().updateManual(item.id, { acknowledged: true });
			}
		} catch {
			// The saved draft remains blocked until a later acknowledgement succeeds.
		}
	}
}
