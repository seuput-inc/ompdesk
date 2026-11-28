import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot, BotsRequest, BotsState, Item, ItemChangeRequest, ItemChangeResult } from "../../../../shared/bots";

const date = "2026-11-28T00:00:00.000Z";
const bot: Bot = {
	id: "b",
	name: "Courier",
	folder: "/b",
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
	createdAt: date,
	itemReceipts: true,
};
const item: Item = {
	id: "i",
	bot: "b",
	number: 1,
	title: "Ship it",
	session: "/chat",
	status: "working",
	links: [],
	events: [],
	createdAt: date,
	updatedAt: date,
	version: 1,
};
const state: BotsState = { bots: [bot], items: [item] };
const command = vi.fn<(request: BotsRequest) => Promise<ItemChangeResult>>();
const stored = new Map<string, string>();
const storage = {
	get length() {
		return stored.size;
	},
	key: (n: number) => [...stored.keys()][n] ?? null,
	getItem: (key: string) => stored.get(key) ?? null,
	setItem: (key: string, value: string) => stored.set(key, value),
	removeItem: (key: string) => stored.delete(key),
};

// A new renderer gets fresh module state but the same origin storage.
async function openPage(current: BotsState) {
	vi.resetModules();
	const { useBotsStore } = await import("../../../stores/bots");
	const { useToastStore } = await import("../../../stores/toast");
	useBotsStore.setState({ state: current });
	vi.stubGlobal("window", {
		omp: {
			bots: {
				itemChange: (device: string | null, request: ItemChangeRequest) => command({ ...request, device }),
				itemsV2: async () => ({ protocol: 2, outcome: "unknown" }),
			},
		},
	});
	return { ...(await import("./item-store")), notices: () => useToastStore.getState().toasts };
}

beforeEach(() => {
	stored.clear();
	command
		.mockReset()
		.mockImplementation(async request =>
			request.action === "itemBatch" ? { itemBatchResult: { ids: request.ids, changed: [], refused: null } } : {},
		);
	vi.stubGlobal("localStorage", storage);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

it("retries the original wake time on the original host after losing a reply and restarting", async () => {
	const remote = { ...item, device: "desk" };
	const host = { device: "desk", name: "Desk", online: true, bots: [bot], items: [item] };
	const first = await openPage({ bots: [{ ...bot, device: "desk" }], items: [remote], remote: [host] });
	command.mockRejectedValueOnce(new Error("Reply lost"));
	await first.snoozeItems([remote], Date.parse(date), "snooze-1");
	const request = { action: "itemBatch", ids: ["i"], device: "desk", requestId: "snooze-1", snoozeUntil: date };
	expect(command).toHaveBeenCalledWith(request);

	// The same item id now also exists here; the receipt must not be re-routed by that id.
	const restarted = await openPage({ ...state, remote: [host] });
	restarted.offerItemBatchRetries();
	expect(command).toHaveBeenCalledTimes(1);
	const retry = restarted.notices().at(-1)?.action;
	expect(retry).toBeDefined();
	await retry?.run();
	expect(command.mock.calls).toEqual([[request], [request]]);
	await retry?.run();
	expect(command).toHaveBeenCalledTimes(2);
	const again = await openPage(state);
	again.offerItemBatchRetries();
	expect(again.notices()).toHaveLength(0);
});

it("keeps a move's id on explicit retry even after a downgrade, and finishes on refusal", async () => {
	const first = await openPage(state);
	command.mockRejectedValueOnce(new Error("Reply lost"));
	await first.moveItems([item], "waiting", "move-1", { wait: "Reviewer" });
	const oldState = { ...state, bots: [{ ...bot, itemReceipts: undefined }] };
	const restarted = await openPage(oldState);
	command.mockResolvedValueOnce({
		itemBatchResult: { ids: ["i"], changed: [], refused: "question_changed" },
	});
	restarted.offerItemBatchRetries();
	await restarted.notices().at(-1)?.action?.run();
	const request = {
		action: "itemBatch",
		ids: ["i"],
		device: null,
		status: "waiting",
		requestId: "move-1",
		wait: "Reviewer",
	};
	expect(command.mock.calls).toEqual([[request], [request]]);
	expect(restarted.notices().at(-1)).toMatchObject({ variant: "warning" });
	expect(restarted.notices().at(-1)?.action).toBeUndefined();
	const again = await openPage(oldState);
	again.offerItemBatchRetries();
	expect(again.notices()).toHaveLength(0);
});

it("refuses to reuse a pending id on a different host, and a stale Retry after Discard sends nothing", async () => {
	const page = await openPage(state);
	command.mockRejectedValueOnce(new Error("Reply lost"));
	await page.moveItems([item], "done", "operation");
	await page.moveItems([{ ...item, device: "other" }], "done", "operation");
	expect(command).toHaveBeenCalledTimes(1);
	const pending = page.notices().find(notice => notice.action);
	expect(pending?.secondAction).toBeDefined();
	pending?.secondAction?.run();
	await pending?.action?.run();
	expect(command).toHaveBeenCalledTimes(1);
});

it("sends one legacy command to a host with no receipt support and does not offer replay", async () => {
	const oldState = { ...state, bots: [{ ...bot, itemReceipts: undefined }] };
	const page = await openPage(oldState);
	command.mockRejectedValueOnce(new Error("Reply lost"));
	await page.snoozeItems([item], null, "wake-1");
	expect(command.mock.calls).toEqual([
		[{ action: "item", ids: ["i"], device: null, requestId: "wake-1", snoozeUntil: null }],
	]);
	expect(page.notices().at(-1)?.action).toBeUndefined();
	const again = await openPage(oldState);
	again.offerItemBatchRetries();
	expect(again.notices()).toHaveLength(0);
});

it("does not send a receipt-backed move when the request cannot be kept for recovery", async () => {
	const page = await openPage(state);
	vi.stubGlobal("localStorage", {
		...storage,
		setItem: () => {
			throw new Error("Storage full");
		},
	});
	await page.moveItems([item], "done", "move-1");
	expect(command).not.toHaveBeenCalled();
	expect(page.notices().at(-1)).toMatchObject({ variant: "error", detail: "Storage full" });
});

it("offers separate retries for two selections with the same status and network error", async () => {
	const page = await openPage(state);
	const first = [item, { ...item, id: "i2" }];
	const second = [item, { ...item, id: "i3" }];
	command.mockRejectedValueOnce(new Error("Reply lost")).mockRejectedValueOnce(new Error("Reply lost"));
	await page.moveItems(first, "done", "first");
	await page.moveItems(second, "done", "second");
	const notices = page.notices();
	expect(notices).toHaveLength(2);
	await notices[1].action?.run();
	expect(command.mock.lastCall).toEqual([
		{ action: "itemBatch", ids: ["i", "i3"], device: null, status: "done", requestId: "second" },
	]);
});

it("treats a new identical gesture after intervening edits as new without replacing the unanswered request", async () => {
	const page = await openPage(state);
	command.mockRejectedValueOnce(new Error("Reply lost"));
	await page.moveItems([item], "waiting", "original", { wait: "Reviewer" });
	await page.moveItems([item], "working", "reopened");
	await page.moveItems([item], "waiting", "new-gesture", { wait: "Reviewer" });
	const restarted = await openPage(state);
	restarted.offerItemBatchRetries();
	await restarted.notices().at(-1)?.action?.run();
	expect(command.mock.calls.map(([request]) => "requestId" in request && request.requestId)).toEqual([
		"original",
		"reopened",
		"new-gesture",
		"original",
	]);
});

it("keeps a move pending until the host confirms the original ids, even when its latest snapshot already looks done", async () => {
	const page = await openPage(state);
	const latest = { ...state, items: [{ ...item, status: "done" as const }] };
	command.mockResolvedValueOnce({}).mockResolvedValueOnce({
		itemBatchResult: { ids: ["another"], changed: [], refused: null },
	});
	await page.moveItems([item], "done", "confirm-this");
	await page.notices().at(-1)?.action?.run();
	const restarted = await openPage(latest);
	restarted.offerItemBatchRetries();
	await restarted.notices().at(-1)?.action?.run();
	const original = { action: "itemBatch", device: null, ids: ["i"], status: "done", requestId: "confirm-this" };
	expect(command.mock.calls).toEqual([[original], [original], [original]]);
	const again = await openPage(latest);
	again.offerItemBatchRetries();
	expect(again.notices()).toHaveLength(0);
});

it("shows and retries a lost comment on the originating item only when host ids collide", async () => {
	const remote = { ...item, device: "desk" };
	const page = await openPage({
		...state,
		items: [item, remote],
		remote: [{ device: "desk", name: "Desk", online: true, bots: [bot], items: [item] }],
	});
	command.mockRejectedValueOnce(new Error("Disconnected"));
	page.sendComment(remote, "Only on Desk");
	const key = page.itemUiKey(remote);
	await vi.waitFor(() => expect(page.useItemsUi.getState().pending[key]?.[0]?.failed).toBe(true));
	expect(page.useItemsUi.getState().pending[page.itemUiKey(item)]).toBeUndefined();
	const requestId = page.useItemsUi.getState().pending[key][0].requestId;
	page.retryComment(item, requestId);
	expect(command).toHaveBeenCalledTimes(1);
	page.retryComment(remote, requestId);
	await vi.waitFor(() => expect(page.useItemsUi.getState().pending[key]).toEqual([]));
	const request = { action: "item", device: "desk", id: "i", comment: "Only on Desk", requestId };
	expect(command.mock.calls).toEqual([[request], [request]]);
});
