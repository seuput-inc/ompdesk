import { expect, it } from "vitest";
import type { Bot, Item } from "../../../../shared/bots";
import { type ItemsV2Request, projectLegacyItemsV2 } from "../../../../shared/items-v2";
import { extendArchive } from "./item-archive";
import { groupItems } from "./item-model";

const date = "2026-11-28T00:00:00Z";
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
};
const items: Item[] = Array.from({ length: 101 }, (_, i) => ({
	id: `i${i + 1}`,
	number: i + 1,
	bot: bot.id,
	session: "/home",
	title: `Closed ${i + 1}`,
	status: "done",
	createdAt: date,
	updatedAt: date,
	closedAt: date,
	links: [],
	version: 2,
	events: [{ id: 101 + i, actor: i === 50 ? "bot" : "owner", kind: "commented", at: date }],
}));
const share = { version: "synthetic.3", state: { bots: [bot], items } };

it("shows the only unread row even on the next tied page, then walks every other row exactly once", async () => {
	const read = async (request: Extract<ItemsV2Request, { action: "itemsPage" }>) =>
		projectLegacyItemsV2(request, share);
	const folded = await extendArchive({ rows: [] }, "desk", bot.id, 100, 0, read);
	expect(folded.unreadTotal).toBe(1);
	expect(folded.rows.map(row => row.number)).toEqual([51]);
	const opened = await extendArchive(folded, "desk", bot.id, 100, 5, read);
	expect(
		groupItems(opened.rows, () => 100, 0)
			.closed.slice(0, 5)
			.map(row => row.number),
	).toEqual([51, 101, 100, 99, 98]);
	const expanded = await extendArchive(opened, "desk", bot.id, 100, 101, read);
	expect(expanded.rows).toHaveLength(101);
	expect(expanded.rows.every(row => row.device === "desk" && !("events" in row))).toBe(true);
	expect(groupItems(expanded.rows, () => 100, 0).closed.map(row => row.number)).toEqual([
		51,
		...items
			.toReversed()
			.map(row => row.number)
			.filter(n => n !== 51),
	]);
});

it("keeps the readable page and surfaces the missing one offline", async () => {
	const page = await extendArchive({ rows: [] }, "desk", bot.id, 100, 55, async request => {
		if (request.before || request.unreadSince !== undefined) throw new Error("Page not cached");
		return projectLegacyItemsV2(request, share);
	});
	expect(page.error).toBe("Page not cached");
	expect(page.rows).toHaveLength(50);
	expect(page.unreadTotal).toBeUndefined();
});
