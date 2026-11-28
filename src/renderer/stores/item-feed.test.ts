import { afterEach, expect, it, vi } from "vitest";
import type { Bot, ItemsV2Change } from "../../shared/bots";
import type { ItemSummary, ItemsV2Reply, ItemsV2Request } from "../../shared/items-v2";

const at = "2026-11-28T00:00:00Z";
const bot: Bot = {
	id: "b",
	name: "Courier",
	folder: "/courier",
	home: null,
	sessions: [],
	paused: false,
	model: null,
	autoApprove: false,
	reach: [],
	staleDays: null,
	lookAround: null,
	tidy: null,
	quiet: [],
	createdAt: at,
};
const row = (number: number): ItemSummary => ({
	id: `row-${number}`,
	number,
	bot: bot.id,
	session: "/chat",
	title: `Summary ${number}`,
	status: "working",
	createdAt: at,
	updatedAt: at,
	version: 1,
	touched: 1,
	askedAt: null,
	sessionLinks: [],
	lastEvent: 1,
	othersLast: 1,
});
type Feed = ItemsV2Reply<Extract<ItemsV2Request, { action: "itemsFeed" }>>;
const seed = (open: ItemSummary[], version = "local.1"): Extract<Feed, { kind: "seed" }> => ({
	protocol: 2,
	kind: "seed",
	version,
	bots: [bot],
	open,
	counts: { b: { openCount: open.length, closedTotal: 0, archiveRevision: 1 } },
});

function fixture() {
	const stored = new Map<string, string>();
	const storage = {
		get length() {
			return stored.size;
		},
		key: (i: number) => [...stored.keys()][i] ?? null,
		getItem: vi.fn((key: string) => stored.get(key) ?? null),
		removeItem: (key: string) => stored.delete(key),
		setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
	};
	vi.stubGlobal("localStorage", storage);
	let changed: (value: ItemsV2Change) => void = () => {
		throw new Error("No feed subscriber");
	};
	const itemsV2 = vi.fn<(...args: [string | null, ItemsV2Request]) => Promise<unknown>>();
	const itemChange = vi.fn().mockResolvedValue({});
	const legacy = vi.fn(() => {
		throw new Error("v1 read or subscription");
	});
	vi.stubGlobal("window", {
		omp: {
			bots: {
				command: legacy,
				onState: legacy,
				itemChange,
				itemsV2,
				onItemsV2Changed: (listener: typeof changed) => {
					changed = listener;
					return () => {};
				},
			},
		},
	});
	return {
		storage,
		itemsV2,
		itemChange,
		legacy,
		change: (device: string | null, reseed = false) => changed({ device, reseed }),
	};
}
// A fresh module graph models opening a renderer against the same origin's stored pages.
afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

it("changes one scoped summary, without reading history, copying the list, or writing unrelated rows", async () => {
	const f = fixture();
	const all = Array.from({ length: 70 }, (_, i) => row(i + 1));
	f.itemsV2.mockResolvedValueOnce(seed(all));
	const { ensureBots, useBotsStore, listedItem, listedItemByNumber } = await import("./bots");
	ensureBots();
	await vi.waitFor(() => expect(useBotsStore.getState().live).toBe(true));
	const before = useBotsStore.getState().state;
	const other = listedItem(before, undefined, "row-70");
	f.storage.getItem.mockClear();
	f.storage.setItem.mockClear();
	f.itemsV2.mockResolvedValueOnce({
		protocol: 2,
		kind: "delta",
		base: "local.1",
		version: "local.2",
		set: [{ ...all[0], lastEvent: 2, version: 2 }],
		remove: [],
		counts: {},
	});
	f.change(null);
	await vi.waitFor(() =>
		expect(listedItemByNumber(useBotsStore.getState().state, undefined, "b", 1)?.version).toBe(2),
	);
	const after = useBotsStore.getState().state;
	expect(after.items).toBe(before.items);
	expect(listedItem(after, undefined, "row-70")).toBe(other);
	expect(after.items[0]).not.toHaveProperty("events");
	expect(f.itemsV2.mock.calls).toEqual([
		[null, { protocol: 2, action: "itemsFeed" }],
		[null, { protocol: 2, action: "itemsFeed", since: "local.1" }],
	]);
	expect(f.storage.getItem).not.toHaveBeenCalled();
	expect(f.storage.setItem.mock.calls.some(([, value]) => value.includes("Summary 1"))).toBe(true);
	expect(f.storage.setItem.mock.calls.some(([, value]) => value.includes("Summary 70"))).toBe(false);
	expect(f.legacy).not.toHaveBeenCalled();
	vi.resetModules();
	const restored = (await import("./bots")).useBotsStore.getState();
	expect(restored.live).toBe(false);
	expect(restored.state.items[0]).toMatchObject({ id: "row-1", version: 2 });
	expect(restored.state.items).toHaveLength(70);
});

it("does not install a seed invalidated while in flight, or extend a mismatched base", async () => {
	const f = fixture();
	const pending = Promise.withResolvers<Feed>();
	f.itemsV2.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(seed([row(2)], "new.1"));
	const { ensureBots, useBotsStore } = await import("./bots");
	const published: string[] = [];
	useBotsStore.subscribe(state => {
		if (state.state.items.length) published.push(state.state.items[0].id);
	});
	ensureBots();
	f.change(null, true);
	pending.resolve(seed([row(1)], "old.9"));
	await vi.waitFor(() => expect(useBotsStore.getState().live).toBe(true));
	expect(published).not.toContain("row-1");
	f.itemsV2
		.mockResolvedValueOnce({
			protocol: 2,
			kind: "delta",
			base: "other.1",
			version: "other.2",
			set: [row(3)],
			remove: [],
			counts: {},
		})
		.mockResolvedValueOnce(seed([row(4)], "new.3"));
	f.change(null);
	await vi.waitFor(() => expect(useBotsStore.getState().state.items[0].id).toBe("row-4"));
	expect(published).not.toContain("row-3");
	expect(f.itemsV2.mock.lastCall).toEqual([null, { protocol: 2, action: "itemsFeed" }]);
	f.itemsV2.mockResolvedValueOnce(seed([row(5)], "new.1"));
	await useBotsStore.getState().command({ action: "get" });
	expect(useBotsStore.getState().state.items[0].id).toBe("row-4");
});

it("negotiates each device, keeps its rows offline and never routes a colliding id to this computer", async () => {
	const f = fixture();
	let online = true;
	f.itemsV2.mockImplementation(async device =>
		device
			? seed([{ ...row(1), title: "On peer" }], "peer.1")
			: { ...seed([row(1)]), remote: [{ device: "peer", name: "Desk", online }] },
	);
	const { ensureBots, useBotsStore, listedItem } = await import("./bots");
	ensureBots();
	await vi.waitFor(() => expect(useBotsStore.getState().state.items).toHaveLength(2));
	const s = useBotsStore.getState();
	expect(listedItem(s.state, "peer", "row-1")?.title).toBe("On peer");
	expect(listedItem(s.state, undefined, "row-1")?.title).toBe("Summary 1");
	await s.command({ action: "item", id: "row-1", device: "peer", comment: "on peer" });
	expect(f.itemChange).toHaveBeenCalledWith("peer", { action: "item", id: "row-1", comment: "on peer" });
	online = false;
	f.change(null, true);
	await vi.waitFor(() => expect(useBotsStore.getState().state.remote?.[0].online).toBe(false));
	expect(listedItem(useBotsStore.getState().state, "peer", "row-1")?.title).toBe("On peer");
	await expect(s.command({ action: "item", id: "row-1", device: "peer", comment: "not here" })).rejects.toThrow();
	expect(f.itemChange).toHaveBeenCalledTimes(1);
	expect(f.legacy).not.toHaveBeenCalled();
});

it("pages a previous host, keeps the known page offline, and drops an in-flight page after archive replacement", async () => {
	const f = fixture();
	const closed = { ...row(3), status: "done", closedAt: at };
	const request = { protocol: 2, action: "itemsPage", id: "b" } as const;
	const page = { protocol: 2, legacy: true, closed: [closed], closedTotal: 1, next: null };
	const feed = {
		...seed([], "v1:desk.2"),
		legacy: true,
		counts: { b: { openCount: 0, closedTotal: 1, archiveRevision: 2 } },
	};
	f.itemsV2.mockResolvedValueOnce(feed);
	const { ensureBots, useBotsStore, itemCounts } = await import("./bots");
	const { queryItems, cachedItemQuery } = await import("./item-query");
	ensureBots();
	await vi.waitFor(() => expect(useBotsStore.getState().live).toBe(true));
	f.itemsV2.mockResolvedValueOnce(page);
	await expect(queryItems(null, request)).resolves.toEqual(page);
	f.itemsV2.mockRejectedValueOnce(new Error("Disconnected"));
	await expect(queryItems(null, request)).rejects.toThrow("Disconnected");
	expect(cachedItemQuery(null, request)).toEqual(page);
	expect(cachedItemQuery(null, { ...request, before: { at: 1, number: 3 } })).toBeUndefined();
	const delayed = Promise.withResolvers<unknown>();
	f.itemsV2.mockReturnValueOnce(delayed.promise);
	const old = queryItems(null, request);
	f.itemsV2.mockResolvedValueOnce({
		...feed,
		version: "v1:desk.3",
		counts: { b: { openCount: 1, closedTotal: 0, archiveRevision: 3 } },
	});
	f.change(null, true);
	await vi.waitFor(() => expect(itemCounts(undefined, "b")?.closedTotal).toBe(0));
	delayed.resolve(page);
	await expect(old).rejects.toThrow("changed during read");
	expect(cachedItemQuery(null, request)).toBeUndefined();
});

it("keeps the original create acknowledgement when the follow-up feed cannot be read", async () => {
	const f = fixture();
	const reply = { bots: [bot], items: [] };
	const command = vi.fn().mockResolvedValue(reply);
	vi.stubGlobal("window", { omp: { bots: { command, itemsV2: f.itemsV2 } } });
	f.itemsV2.mockRejectedValueOnce(new Error("Lost connection after create"));
	const { useBotsStore } = await import("./bots");
	await expect(useBotsStore.getState().command({ action: "create", name: bot.name })).resolves.toEqual(reply);
	expect(command).toHaveBeenCalledTimes(1);
});
