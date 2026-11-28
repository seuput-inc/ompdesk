import { describe, expect, it } from "vitest";
import { ItemChangeRequestSchema, ItemsV2RequestSchema, parseItemsV2Reply, projectLegacyItemsV2 } from "./items-v2";

const at = "2026-01-02T00:00:00Z";
const bot = {
	id: "one",
	name: "One",
	folder: "bot",
	home: null,
	sessions: [],
	paused: false,
	model: null,
	autoApprove: false,
	reach: [],
	staleDays: 7,
	lookAround: null,
	tidy: null,
	quiet: [],
	createdAt: at,
};
const old = (items: unknown[]) => ({ version: "old.8", state: { bots: [bot], items } });
const item = (n: number) => ({
	id: `i${n}`,
	bot: bot.id,
	number: n,
	session: "chat",
	title: `Item ${n}`,
	status: "done",
	version: 3,
	createdAt: at,
	updatedAt: at,
	links: [],
	events: [],
});
const feed = { protocol: 2, action: "itemsFeed" } as const;
const page = { protocol: 2, action: "itemsPage", id: bot.id } as const;
const detail = { protocol: 2, action: "itemDetail", id: "i1", bot: bot.id } as const;
const receipt = { protocol: 2, action: "itemReceipt", id: "i1", bot: bot.id, requestId: "retry" } as const;

describe("previous host item projection", () => {
	it("keeps unseen and ask times from the returned tail but not its bodies in a seed", () => {
		const ask = { id: 77, kind: "asked", actor: "bot", text: "Should I proceed?", at };
		const raw = old([
			{
				...item(1),
				status: "needs_you",
				description: "detail only",
				question: { id: 77, text: ask.text, options: [] },
				links: [{ kind: "session", ref: "chat2" }],
				events: [ask, { id: 80, kind: "commented", actor: "owner", at, text: "comments stay in detail" }],
			},
		]);
		const seed = projectLegacyItemsV2(feed, raw);
		expect(seed.kind).toBe("seed");
		if (seed.kind !== "seed") throw new Error("expected seed");
		expect(seed.open[0]).toMatchObject({
			othersLast: 77,
			lastEvent: 80,
			askedAt: Date.parse(at),
			sessionLinks: ["chat2"],
		});
		expect(seed.open[0]).not.toHaveProperty("description");
		expect(seed.open[0]).not.toHaveProperty("events");
		expect(parseItemsV2Reply(feed, seed)).toEqual(seed);
		expect(projectLegacyItemsV2({ ...feed, since: seed.version }, raw)).toEqual({
			protocol: 2,
			legacy: true,
			kind: "delta",
			base: seed.version,
			version: seed.version,
			counts: {},
			set: [],
			remove: [],
		});
	});
	it("keeps tied archive pages exclusive and finds the only unread row on the last page", () => {
		const rows = Array.from({ length: 101 }, (_, i) => item(i + 1));
		const raw = old([{ ...rows[0], events: [{ id: 19, kind: "made", actor: "bot", at }] }, ...rows.slice(1)]);
		const first = projectLegacyItemsV2(page, raw);
		expect(first.closed.map(i => i.number)).toEqual(
			rows
				.slice(51)
				.reverse()
				.map(i => i.number),
		);
		expect(first.next).toEqual({ at: Date.parse(at), number: 52 });
		const second = projectLegacyItemsV2({ ...page, before: first.next! }, raw);
		expect(second.next?.number).toBe(2);
		const last = projectLegacyItemsV2({ ...page, before: second.next! }, raw);
		expect(last.closed.map(i => i.number)).toEqual([1]);
		expect(last.next).toBeNull();
		const unread = projectLegacyItemsV2({ ...page, unreadSince: 18 }, raw);
		expect(unread).toMatchObject({ closedTotal: 101, unreadTotal: 1, next: null, closed: [{ number: 1 }] });
	});
	it("uses append position, not event id, and confirms only the exact owner request", () => {
		const raw = old([
			{
				...item(1),
				events: [
					{ id: 70, at, actor: "bot", kind: "asked" },
					{ id: 10, at, actor: "owner", kind: "answered", question: 70, request: "retry" },
					{ id: 30, at, actor: "bot", kind: "commented", request: "not-owner" },
				],
			},
		]);
		const reply = projectLegacyItemsV2({ ...detail, afterEvent: 70 }, raw);
		expect(reply.events.map(e => e.id)).toEqual([10, 30]);
		expect(reply.asks.map(e => e.id)).toEqual([70]);
		expect(projectLegacyItemsV2({ ...receipt, question: 70 }, raw).outcome).toBe("answered");
		expect(projectLegacyItemsV2({ ...receipt, question: 30 }, raw).outcome).toBe("unknown");
		expect(projectLegacyItemsV2({ ...receipt, requestId: "not-owner" }, raw).outcome).toBe("unknown");
		expect(() => projectLegacyItemsV2({ ...detail, beforeEvent: 900 }, raw)).toThrow();
		expect(() => projectLegacyItemsV2({ ...detail, bot: "elsewhere" }, raw)).toThrow();
	});
	it("keeps archived session links in order without sending unrelated links or history", () => {
		const linked = { protocol: 2, action: "itemsLinked", bot: bot.id, sessions: ["session"] } as const;
		const request = { ...linked, sessions: [...linked.sessions] };
		const raw = old([
			{
				...item(2),
				links: [
					{ kind: "url", ref: "session" },
					{ kind: "session", ref: "session" },
				],
			},
			item(3),
		]);
		const result = projectLegacyItemsV2(request, raw);
		expect(result.links).toEqual([{ session: "session", number: 2, title: "Item 2" }]);
		expect(() => parseItemsV2Reply({ ...request, sessions: ["different"] }, result)).toThrow();
	});
	it("refuses a nested host or mixed batch operation on the compact write channel", () => {
		const change = { action: "itemBatch", requestId: "retry", ids: ["i1"], status: "working" };
		expect(ItemChangeRequestSchema.parse(change)).toEqual(change);
		expect(ItemChangeRequestSchema.safeParse({ ...change, device: "elsewhere" }).success).toBe(false);
		expect(ItemChangeRequestSchema.safeParse({ ...change, snoozeUntil: null }).success).toBe(false);
	});
	it("rejects writes, route injection, mixed cursors and replies for another base or item", () => {
		for (const raw of [
			{ ...feed, action: "delete" },
			{ ...feed, device: "other" },
			{ ...detail, beforeEvent: 2, afterEvent: 0 },
		])
			expect(ItemsV2RequestSchema.safeParse(raw).success).toBe(false);
		expect(() =>
			parseItemsV2Reply(
				{ ...feed, since: "new.3" },
				{ protocol: 2, kind: "delta", base: "old.3", version: "old.4", set: [], remove: [], counts: {} },
			),
		).toThrow();
		const reply = projectLegacyItemsV2(detail, old([item(1)]));
		expect(() => parseItemsV2Reply({ ...detail, id: 2 }, reply)).toThrow();
	});
});
