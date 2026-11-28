import { type ItemsV2Reply, type ItemsV2Request, parseItemsV2Reply } from "../../shared/items-v2";
import { snapshotNs, snapshots } from "../lib/snapshot-cache";
import { itemCounts, itemEpoch, listedItem, listedItemByNumber, useBotsStore } from "./bots";

type Query = Exclude<ItemsV2Request, { action: "itemsFeed" }>;
const pending = new Map<string, Promise<ItemsV2Reply<Query>>>();

function cacheKey(device: string | null, request: Query) {
	const parts: unknown[] = ["items.v2", itemEpoch(device), request.action];
	switch (request.action) {
		case "itemsPage":
			parts.push(
				request.id,
				itemCounts(device ?? undefined, request.id)?.archiveRevision,
				request.unreadSince,
				request.before?.at,
				request.before?.number,
			);
			break;
		case "itemDetail":
			parts.push(request.bot, request.id, request.beforeEvent, request.afterEvent);
			break;
		case "itemsLinked":
			parts.push(request.bot, request.sessions);
			break;
		case "itemReceipt":
			throw new Error("A receipt must be read from its host");
	}
	return JSON.stringify(parts);
}

/** Last real page for first paint/offline. Absence means not read, not an empty result. */
export function cachedItemQuery<R extends Query>(device: string | null, request: R): ItemsV2Reply<R> | undefined {
	if (request.action === "itemReceipt") return undefined;
	const saved = snapshots().read<unknown>("panel", snapshotNs(device), cacheKey(device, request))?.value;
	if (saved === undefined) return;
	try {
		return parseItemsV2Reply(request, saved);
	} catch {
		return;
	}
}

function revision(device: string | null, request: Query) {
	const s = useBotsStore.getState();
	const host = device ?? undefined;
	switch (request.action) {
		case "itemsLinked":
			return s.linkRevision(host, request.bot);
		case "itemsPage":
			return itemCounts(host, request.id)?.archiveRevision;
		case "itemDetail": {
			const row =
				typeof request.id === "number"
					? listedItemByNumber(s.state, host, request.bot, request.id)
					: listedItem(s.state, host, request.id);
			return row ? `open:${row.version}` : `archive:${itemCounts(host, request.bot)?.archiveRevision}`;
		}
	}
}

/** Fresh pages always come from the host, including a negotiated previous host. Never persist a superseded read. */
export async function queryItems<R extends Query>(device: string | null, request: R): Promise<ItemsV2Reply<R>> {
	if (request.action === "itemReceipt") return window.omp.bots.itemsV2(device, request);
	const key = cacheKey(device, request);
	const base = revision(device, request);
	const flight = JSON.stringify([device, key, base]);
	const shared = pending.get(flight);
	if (shared) return shared as Promise<ItemsV2Reply<R>>;
	const read = window.omp.bots.itemsV2(device, request).then(reply => {
		if (key !== cacheKey(device, request) || base !== revision(device, request))
			throw new Error("Item page changed during read");
		if ("item" in reply) {
			const row = listedItem(useBotsStore.getState().state, device ?? undefined, reply.item.id);
			if (row && reply.item.version < row.version) throw new Error("Item detail is older than its summary");
		}
		snapshots().write("panel", snapshotNs(device), key, reply);
		return reply;
	});
	pending.set(flight, read);
	try {
		return await read;
	} finally {
		pending.delete(flight);
	}
}
