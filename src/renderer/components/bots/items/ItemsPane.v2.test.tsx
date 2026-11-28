import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot, Item, ItemEvent } from "../../../../shared/bots";
import { type ItemsV2Request, projectLegacyItemsV2 } from "../../../../shared/items-v2";
import { I18nProvider } from "../../../lib/i18n";
import { ensureBots, resetBotsForTest, useBotsStore } from "../../../stores/bots";
import * as itemQueries from "../../../stores/item-query";
import { botPageKey } from "../bot-page";
import { ItemsPane } from "./ItemsPane";
import { itemPlace } from "./item-place";
import { itemUiKey, openItem, setDraft, useItemsUi } from "./item-store";

const at = "2026-11-28T00:00:00Z";
const bot: Bot = {
	id: "b",
	name: "Courier",
	folder: "/bot",
	home: "/s",
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
const remote = { ...bot, device: "desk" };
const owner = botPageKey(remote.id, remote.device);
let root: Root;
let item: Item;
const itemsV2 = vi.fn((device: string | null, request: ItemsV2Request) => {
	if (device !== "desk") throw new Error("Wrong device");
	return Promise.resolve(projectLegacyItemsV2(request, { version: "test.2", state: { bots: [bot], items: [item] } }));
});
function publish() {
	const seed = projectLegacyItemsV2(
		{ protocol: 2, action: "itemsFeed" },
		{ version: "test.2", state: { bots: [bot], items: [item] } },
	);
	if (seed.kind !== "seed") throw new Error("Expected a seed");
	const rows = seed.open.map(summary => ({ ...summary, device: "desk" }));
	useBotsStore.setState({
		live: false,
		state: {
			bots: [bot, remote],
			items: [{ ...item, title: "Other host" }, ...rows],
			remote: [{ device: "desk", online: true, name: "Desk", bots: [bot], items: rows }],
		},
	});
}
function mount() {
	return act(async () =>
		root.render(
			<I18nProvider>
				<ItemsPane bots={[remote]} owner={owner} group={false} />
			</I18nProvider>,
		),
	);
}
function click(selector: string) {
	const button = document.querySelector<HTMLElement>(selector);
	if (!button) throw new Error(`Missing ${selector}`);
	return act(async () => button.click());
}
beforeEach(() => {
	const { window, document, HTMLElement, Event, Node } = parseHTML("<html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document,
		HTMLElement,
		Event,
		Node,
		IS_REACT_ACT_ENVIRONMENT: true,
	}))
		vi.stubGlobal(key, value);
	Reflect.set(window, "omp", { bots: { itemsV2 } });
	root = createRoot(globalThis.document.body);
	const events: ItemEvent[] = Array.from({ length: 52 }, (_, i) => ({ id: i + 1, actor: "bot", kind: "made", at }));
	events[0] = { id: 1, actor: "bot", kind: "asked", text: "Original question", at };
	events[51] = { id: 52, actor: "owner", kind: "answered", text: "Answer", question: 1, at };
	item = {
		id: "i",
		bot: "b",
		number: 7,
		session: "/s",
		title: "Remote item",
		status: "working",
		createdAt: at,
		updatedAt: at,
		links: [],
		events,
		version: 1,
	};
	itemsV2.mockClear();
	openItem(owner, null);
	publish();
});
afterEach(async () => {
	await act(async () => root.unmount());
	resetBotsForTest();
	useItemsUi.setState({ open: {}, order: {}, drafts: {} });
	vi.unstubAllGlobals();
});

it("requests no history for the list, and only newer events while the inspector is open", async () => {
	await mount();
	expect(itemsV2).not.toHaveBeenCalled();
	await click('[data-bot-item-open="i"]');
	expect(itemsV2.mock.calls.map(([device, request]) => [device, request])).toEqual([
		["desk", { protocol: 2, action: "itemDetail", bot: "b", id: "i" }],
	]);
	expect(document.querySelector('[data-bot-item-comment="52"]')?.textContent).toContain("Original question");
	expect(document.querySelector('[data-bot-item-comment="1"]')).toBeNull();
	const box = document.querySelector("[data-bot-item-comment-box] textarea");
	await act(async () => {
		setDraft(itemUiKey({ ...item, device: "desk" }), "Still writing");
		item.events.push({ id: 53, actor: "bot", kind: "commented", text: "New event", at });
		item.version++;
		publish();
	});
	expect(itemsV2).toHaveBeenCalledTimes(2);
	expect(itemsV2).toHaveBeenLastCalledWith("desk", {
		protocol: 2,
		action: "itemDetail",
		bot: "b",
		id: "i",
		afterEvent: 52,
	});
	expect(document.querySelector('[data-bot-item-comment="53"]')?.textContent).toContain("New event");
	expect(document.querySelector("[data-bot-item-comment-box] textarea")).toBe(box);
	expect((box as HTMLTextAreaElement).value).toBe("Still writing");
	await click("[data-bot-item-activity] button");
	expect(itemsV2).toHaveBeenLastCalledWith("desk", {
		protocol: 2,
		action: "itemDetail",
		bot: "b",
		id: "i",
		beforeEvent: 3,
	});
	expect(
		[...document.querySelectorAll("[data-bot-item-comment]")].map(node => node.getAttribute("data-bot-item-comment")),
	).toEqual(["1", "52", "53"]);
	await click("[data-bot-item-back]");
	itemsV2.mockClear();
	await act(async () => {
		item.version++;
		publish();
	});
	expect(itemsV2).not.toHaveBeenCalled();
});

it("reports a stalled peer cursor without duplicating the last visible page", async () => {
	await mount();
	await click('[data-bot-item-open="i"]');
	item.version++;
	const page = projectLegacyItemsV2(
		{ protocol: 2, action: "itemDetail", bot: bot.id, id: item.id },
		{ version: "test.2", state: { bots: [bot], items: [item] } },
	);
	itemsV2.mockResolvedValueOnce({ ...page, afterEvent: 52, events: [item.events[51]] });
	await act(async () => publish());
	expect(itemsV2).toHaveBeenCalledTimes(2);
	expect(document.querySelector('[role="alert"]')?.textContent).toContain("Invalid item event cursor");
	expect(document.querySelectorAll('[data-bot-item-comment="52"]')).toHaveLength(1);
});

it("keeps the last good cached page when an offline cursor cycles", async () => {
	const head = projectLegacyItemsV2(
		{ protocol: 2, action: "itemDetail", bot: bot.id, id: item.id },
		{ version: "test.2", state: { bots: [bot], items: [item] } },
	);
	const tail = {
		...head,
		events: [{ id: 53, actor: "bot", kind: "commented", text: "Cached tail", at } satisfies ItemEvent],
	};
	const read = vi
		.spyOn(itemQueries, "cachedItemQuery")
		.mockReturnValueOnce(head)
		.mockReturnValueOnce(tail)
		.mockReturnValueOnce({ ...head, events: [item.events[51]] })
		.mockReturnValue(undefined);
	try {
		useBotsStore.setState(({ state }) => ({
			state: { ...state, remote: state.remote?.map(host => ({ ...host, online: false })) },
		}));
		openItem(owner, itemPlace(remote.id, remote.device, item.id));
		await mount();
		expect(read).toHaveBeenCalledTimes(3);
		expect(itemsV2).not.toHaveBeenCalled();
		expect(document.querySelectorAll('[data-bot-item-comment="52"]')).toHaveLength(1);
		expect(document.querySelector('[data-bot-item-comment="53"]')?.textContent).toContain("Cached tail");
	} finally {
		read.mockRestore();
	}
});

it("opens a closed number directly on its chat's host without an open list row", async () => {
	item.status = "done";
	publish();
	openItem(owner, itemPlace(remote.id, remote.device, 7));
	await mount();
	expect(itemsV2).toHaveBeenCalledWith("desk", { protocol: 2, action: "itemDetail", bot: "b", id: 7 });
	expect(document.querySelector('[data-bot-item-page="i"] h2')?.textContent).toBe("#7 Remote item");
});

it("rebuilds the expanded archive after a reopen without losing its unread-first order or its shown range", async () => {
	const local = { ...bot, itemsSeen: 1000 };
	const closed: Item[] = Array.from({ length: 51 }, (_, i) => ({
		...item,
		id: `closed-${i + 1}`,
		number: i + 1,
		status: "done",
		closedAt: at,
		events: [{ id: 2000 + i, kind: "commented", at, actor: i === 0 ? "bot" : "owner" }],
	}));
	let revision = 1;
	let wake = () => {};
	const read = vi.fn(async (_device: string | null, request: ItemsV2Request) =>
		projectLegacyItemsV2(request, { version: `test.${revision}`, state: { bots: [local], items: closed } }),
	);
	Reflect.set(window, "omp", {
		bots: {
			itemsV2: read,
			itemChange: async () => ({}),
			onItemsV2Changed: (push: (notice: { device: null; reseed: boolean }) => void) => {
				wake = () => push({ device: null, reseed: true });
				return () => {};
			},
		},
	});
	await act(async () => ensureBots());
	await act(async () =>
		root.render(
			<I18nProvider>
				<ItemsPane bots={[local]} owner={local.id} group={false} />
			</I18nProvider>,
		),
	);
	const section = '[data-bot-items-group="closed"]';
	const numbers = () =>
		[...document.querySelectorAll(`${section} [data-bot-item]`)].map(row =>
			Number(row.getAttribute("data-bot-item")),
		);
	expect(document.querySelector(`${section} [aria-expanded]`)?.textContent).toContain("51");
	await click(`${section} [aria-expanded]`);
	expect(numbers()).toEqual([1, 51, 50, 49, 48]);
	await click(`${section} [role=list] > button:last-child`);
	expect(numbers()).toHaveLength(51);
	closed[0] = { ...closed[0], version: 2, closedAt: undefined, status: "working" };
	revision++;
	await act(async () => wake());
	expect(numbers()).toEqual(Array.from({ length: 50 }, (_, i) => 51 - i));
	expect(document.querySelector('[data-bot-items-group="working"] [data-bot-item="1"]')).not.toBeNull();
	expect(read.mock.calls.some(([, request]) => request.action === "itemDetail")).toBe(false);
});
