import { z } from "zod";
import { LOOK_EVERY } from "./bot-limits";
import { BOT_QUIET_KINDS, type BotsState, ITEM_STATUSES, type Item, type RemoteBots } from "./bots";
import { activityAt, othersLast } from "./item-activity";
import { APPROVAL_MODES } from "./tool-approval";

const text = z.string();
const optionalText = text.optional();
const texts = z.array(text);
const nat = z.int().nonnegative();
const positive = z.int().positive();
const number = positive.max(0xffff_ffff);
const key = text
	.min(1)
	.max(256)
	.refine(s => s === s.trim() && !/\p{Cc}/u.test(s));
export const ItemsV2DeviceSchema = key.nullable();
const requestId = key.refine(s => s.length <= 200);
const batch = { action: z.literal("itemBatch"), ids: z.array(key).min(1), requestId };
export const ItemChangeRequestSchema = z.union([
	z.strictObject({ action: z.literal("itemsOpened"), id: key }),
	z.strictObject({ ...batch, status: z.enum(ITEM_STATUSES), wait: optionalText, note: optionalText }),
	z.strictObject({ ...batch, snoozeUntil: text.nullable() }),
	z
		.strictObject({
			action: z.literal("item"),
			id: key.optional(),
			ids: z.array(key).min(1).optional(),
			requestId: requestId.optional(),
			status: z.enum(ITEM_STATUSES).optional(),
			wait: optionalText,
			note: optionalText,
			comment: optionalText,
			snoozeUntil: text.nullable().optional(),
			answer: z
				.strictObject({ text: optionalText, choice: nat.optional(), question: positive.optional() })
				.optional(),
		})
		.refine(r => (r.id === undefined) !== (r.ids === undefined)),
]);
export const ItemChangeResultSchema = z.strictObject({
	refused: z.literal("question_changed").optional(),
	itemBatchResult: z
		.strictObject({
			ids: texts,
			changed: z.array(z.strictObject({ id: key, version: nat })),
			refused: text.nullable(),
		})
		.optional(),
});
export const ITEMS_LINKED_MAX = 128;
const sessionKey = text
	.min(1)
	.max(32768)
	.refine(s => s === s.trim() && !/\p{Cc}/u.test(s));
const protocol = z.literal(2);
const cursor = z.strictObject({ at: z.int(), number });
export const ItemsV2RequestSchema = z.discriminatedUnion("action", [
	z.strictObject({ protocol, action: z.literal("itemsFeed"), since: key.optional() }),
	z.strictObject({
		protocol,
		action: z.literal("itemsLinked"),
		bot: key,
		sessions: z.array(sessionKey).min(1).max(ITEMS_LINKED_MAX),
	}),
	z.strictObject({
		protocol,
		action: z.literal("itemsPage"),
		id: key,
		before: cursor.optional(),
		unreadSince: nat.optional(),
	}),
	z
		.strictObject({
			protocol,
			action: z.literal("itemDetail"),
			bot: key,
			id: z.union([key, number]),
			beforeEvent: positive.optional(),
			afterEvent: nat.optional(),
		})
		.refine(r => r.beforeEvent === undefined || r.afterEvent === undefined),
	z.strictObject({
		protocol,
		action: z.literal("itemReceipt"),
		bot: key,
		id: key,
		requestId,
		question: positive.optional(),
	}),
]);
export type ItemsV2Request = z.infer<typeof ItemsV2RequestSchema>;
const meta = { protocol, legacy: z.literal(true).optional() };
const question = z.object({
	text,
	options: texts,
	id: positive.optional(),
	recommended: nat.optional(),
	decisions: z
		.array(z.object({ question: text, options: texts, recommended: nat.optional(), multi: z.boolean().optional() }))
		.optional(),
});
const fields = {
	id: key,
	bot: key,
	number,
	session: text,
	title: text,
	status: z.enum(ITEM_STATUSES),
	version: nat,
	createdAt: text,
	updatedAt: text,
	question: question.optional(),
	wait: z.object({ text, until: optionalText, at: optionalText }).optional(),
	closedAt: optionalText,
	closed: z.number().optional(),
	snoozedUntil: optionalText,
	stale: z.boolean().optional(),
	limitUntil: optionalText,
};
const link = z.object({
	kind: z.enum(["session", "pr", "url", "file", "schedule"]),
	ref: text,
	title: optionalText,
	state: z.enum(["working", "waiting", "done", "failed", "stopped", "gone"]).optional(),
});
const details = z.object({
	...fields,
	touched: z.number().optional(),
	description: optionalText,
	doneMeans: optionalText,
	closeNote: optionalText,
	links: z.array(link),
});
const event = z.object({
	id: positive,
	at: text,
	actor: z.enum(["bot", "owner"]),
	kind: z.enum([
		"made",
		"edited",
		"status",
		"commented",
		"asked",
		"answered",
		"withdrawn",
		"self_decided",
		"linked",
		"snoozed",
		"unsnoozed",
		"worker",
	]),
	text: optionalText,
	from: optionalText,
	note: optionalText,
	field: z.enum(["title", "description", "doneMeans"]).optional(),
	before: optionalText,
	after: optionalText,
	request: optionalText,
	question: positive.optional(),
	early: z.boolean().optional(),
	link: optionalText,
	state: optionalText,
});
const summary = z.strictObject({
	...fields,
	touched: z.number(),
	askedAt: z.int().nullable(),
	sessionLinks: texts,
	live: z.literal(true).optional(),
	lastEvent: nat,
	othersLast: nat,
});
export type ItemSummary = z.infer<typeof summary>;
export type ListedItem = (ItemSummary | Item) & { device?: string };
export type ListedBotsState = Omit<BotsState, "items" | "remote"> & {
	items: ListedItem[];
	remote?: (Omit<RemoteBots, "items"> & { items: ListedItem[] })[];
};
const isClosed = (row: { status: string }) => row.status === "done" || row.status === "canceled";
const open = summary.refine(r => !isClosed(r));
const counts = z.record(key, z.strictObject({ openCount: nat, closedTotal: nat, archiveRevision: nat }));
const worker = z.object({
	session: text,
	device: optionalText,
	origin: z.enum(["opened", "handed"]).optional(),
	openedBySession: optionalText,
	title: text,
	cwd: text,
	branch: text.nullable(),
	since: text,
	state: z.enum(["working", "idle", "closed"]),
	tabId: optionalText,
});
const bot = z.object({
	id: key,
	name: text,
	folder: text,
	home: text.nullable(),
	chatHome: optionalText,
	legacyPeerRequest: optionalText,
	sessions: texts,
	paused: z.boolean(),
	model: text.nullable(),
	autoApprove: z.boolean(),
	reach: texts,
	staleDays: z.number().nullable(),
	lookAround: text.nullable(),
	tidy: text.nullable(),
	quiet: z.array(z.enum(BOT_QUIET_KINDS)),
	createdAt: text,
	itemReceipts: z.literal(true).optional(),
	chatApproval: z.enum(APPROVAL_MODES).nullable().optional(),
	allPaired: z.boolean().optional(),
	lookSetting: z
		.object({ on: z.boolean(), every: z.enum(LOOK_EVERY), weekdaysOnly: z.boolean(), focus: text })
		.optional(),
	workers: z.array(worker).optional(),
	workerLinks: z.array(z.object({ session: text, openedBySession: text })).optional(),
	skillProjects: texts.optional(),
	launch: texts.optional(),
	specialty: optionalText,
	itemsSeen: nat.optional(),
	firstRun: z.boolean().optional(),
	peerPending: z.enum(["home", "kickoff", "limit"]).optional(),
	kickoffs: texts.optional(),
	kickoffSilent: z.boolean().optional(),
});
const room = z.object({
	id: key,
	name: text,
	members: texts,
	replyMode: z.union([z.enum(["all", "mentions"]), z.templateLiteral(["bot:", text])]),
	createdAt: text,
	lastSeq: nat,
	seen: z.record(text, nat),
	messages: z.array(
		z.object({
			id: text,
			seq: nat,
			at: text,
			author: text,
			name: text,
			text,
			turns: z.array(
				z.object({
					bot: text,
					name: text,
					state: z.enum(["asked", "replied", "stopped", "failed"]),
					at: text,
					error: optionalText,
				}),
			),
			hops: nat,
		}),
	),
});
const looks = z.object({
	bot: key,
	seenAt: z.number(),
	lastLookedAt: z.number().nullable(),
	items: z.array(z.object({ id: text, title: text, why: text, ask: text, link: optionalText, createdAt: z.number() })),
});
const seed = z.strictObject({
	...meta,
	kind: z.literal("seed"),
	version: key,
	open: z.array(open),
	counts,
	bots: z.array(bot),
	remote: z.array(z.object({ device: key, name: text, online: z.boolean() })).optional(),
	rooms: z.array(room).optional(),
	looks: z.array(looks).optional(),
});
const delta = z.strictObject({
	...meta,
	kind: z.literal("delta"),
	base: key,
	version: key,
	set: z.array(open),
	remove: z.array(key),
	counts,
});
const reply = {
	itemsFeed: z.discriminatedUnion("kind", [seed, delta]),
	itemsLinked: z.strictObject({
		...meta,
		links: z.array(z.strictObject({ session: sessionKey, number, title: text })),
	}),
	itemsPage: z.strictObject({
		...meta,
		closed: z.array(summary.refine(isClosed)).max(50),
		closedTotal: nat,
		next: cursor.nullable(),
		unreadTotal: nat.optional(),
	}),
	itemDetail: z.strictObject({
		...meta,
		item: details,
		events: z.array(event).max(50),
		asks: z.array(event.refine(e => e.kind === "asked")).max(50),
		beforeEvent: positive.nullable(),
		afterEvent: positive.nullable(),
	}),
	itemReceipt: z.strictObject({
		...meta,
		outcome: z.enum(["answered", "commented", "changed", "question_changed", "unknown"]),
	}),
};
type Replies = { [K in keyof typeof reply]: z.infer<(typeof reply)[K]> };
export type ItemsV2Reply<R extends ItemsV2Request = ItemsV2Request> = Replies[R["action"]];

export function parseItemsV2Reply<R extends ItemsV2Request>(request: R, raw: unknown): ItemsV2Reply<R> {
	const result = reply[request.action].parse(raw);
	if (
		"links" in result &&
		(request.action !== "itemsLinked" || result.links.some(l => !request.sessions.includes(l.session)))
	)
		throw new Error("Linked item scope mismatch");
	if ("kind" in result && result.kind === "delta" && (request.action !== "itemsFeed" || result.base !== request.since))
		throw new Error("Item feed base mismatch");
	if ("closed" in result && (request.action !== "itemsPage" || result.closed.some(r => r.bot !== request.id)))
		throw new Error("Item page scope mismatch");
	if (
		"item" in result &&
		(request.action !== "itemDetail" ||
			result.item.bot !== request.bot ||
			(typeof request.id === "string" ? result.item.id : result.item.number) !== request.id)
	)
		throw new Error("Item detail scope mismatch");
	return result as ItemsV2Reply<R>;
}

const legacyItem = details.extend({ events: z.array(event) });
const legacyShare = z.object({
	version: key,
	state: z.object({
		bots: z.array(
			bot.omit({ workers: true, launch: true, skillProjects: true, legacyPeerRequest: true, chatHome: true }),
		),
		items: z.array(legacyItem),
	}),
});
type LegacyItem = z.infer<typeof legacyItem>;
function summarize({
	links,
	events,
	description: _description,
	doneMeans: _doneMeans,
	closeNote: _closeNote,
	...row
}: LegacyItem): ItemSummary {
	const asked =
		row.question &&
		events.findLast(e => e.kind === "asked" && (row.question?.id === undefined || row.question.id === e.id));
	let lastEvent = 0;
	for (const e of events) lastEvent = Math.max(lastEvent, e.id);
	const at = asked ? Date.parse(asked.at) : NaN;
	return {
		...row,
		touched: row.touched ?? (Date.parse(row.updatedAt) || 0),
		askedAt: Number.isFinite(at) ? at : null,
		sessionLinks: links.filter(l => l.kind === "session").map(l => l.ref),
		...(links.some(l => l.kind === "session" && (l.state === "working" || l.state === "waiting"))
			? { live: true as const }
			: {}),
		lastEvent,
		othersLast: othersLast(events),
	};
}

/** A previous host exposes only its retained rows. Absence there is not proof that a write failed. */
export function projectLegacyItemsV2<R extends ItemsV2Request>(r: R, raw: unknown, now = Date.now()): ItemsV2Reply<R> {
	const {
		version: source,
		state: { bots, items },
	} = legacyShare.parse(raw);
	const flags = { protocol: 2, legacy: true } as const;
	let value: Replies[keyof Replies];
	if (r.action === "itemsFeed") {
		const version = `v1:${source}`;
		if (r.since === version)
			value = { ...flags, kind: "delta", base: version, version, set: [], remove: [], counts: {} };
		else {
			const revision = Number(source.split(".").at(-1));
			const counts: z.infer<typeof seed>["counts"] = Object.create(null);
			const open: ItemSummary[] = [];
			for (const bot of bots)
				counts[bot.id] = {
					openCount: 0,
					closedTotal: 0,
					archiveRevision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
				};
			for (const row of items) {
				const count = counts[row.bot];
				if (!count) throw new Error("Item belongs to an unknown bot");
				if (isClosed(row)) count.closedTotal++;
				else {
					count.openCount++;
					open.push(summarize(row));
				}
			}
			value = { ...flags, kind: "seed", version, open, counts, bots };
		}
	} else if (r.action === "itemsLinked") {
		if (!bots.some(b => b.id === r.bot)) throw new Error("Bot not found");
		const sessions = new Set(r.sessions);
		value = {
			...flags,
			links: items
				.filter(i => i.bot === r.bot)
				.flatMap(i =>
					i.links
						.filter(l => l.kind === "session" && sessions.has(l.ref))
						.map(l => ({ session: l.ref, number: i.number, title: i.title })),
				),
		};
	} else if (r.action === "itemsPage") {
		if (!bots.some(b => b.id === r.id)) throw new Error("Bot not found");
		const filtered = items.filter(i => i.bot === r.id && isClosed(i)).map(summarize);
		const seen = r.unreadSince,
			end = r.before;
		const ordered = filtered
			.filter(i => seen === undefined || i.othersLast > seen)
			.map(item => ({ item, at: activityAt(item, now) }))
			.sort((a, b) => b.at - a.at || b.item.number - a.item.number);
		const page = ordered
			.filter(p => !end || p.at < end.at || (p.at === end.at && p.item.number < end.number))
			.slice(0, 51);
		value = {
			...flags,
			closed: page.slice(0, 50).map(p => p.item),
			closedTotal: filtered.length,
			next: page.length > 50 ? { at: page[49].at, number: page[49].item.number } : null,
			...(seen === undefined ? {} : { unreadTotal: ordered.length }),
		};
	} else {
		const row = items.find(i => i.bot === r.bot && (typeof r.id === "string" ? i.id : i.number) === r.id);
		if (!row) throw new Error("Item not found for this bot");
		if (r.action === "itemReceipt") {
			const saved = row.events.find(
				e =>
					e.actor === "owner" &&
					e.request === r.requestId &&
					(r.question === undefined || e.question === r.question) &&
					(e.kind === "answered" || e.kind === "commented"),
			);
			value = {
				...flags,
				outcome: saved?.kind === "answered" ? "answered" : saved?.kind === "commented" ? "commented" : "unknown",
			};
		} else {
			const { events: all, ...item } = row;
			const id = r.beforeEvent ?? r.afterEvent;
			const pos = id === undefined ? all.length : id === 0 ? -1 : all.findIndex(e => e.id === id);
			if (id !== undefined && id !== 0 && pos < 0) throw new Error("Invalid item event cursor");
			const from = r.afterEvent === undefined ? Math.max(0, pos - 50) : pos + 1;
			const end = r.afterEvent === undefined ? pos : Math.min(all.length, from + 50);
			const events = all.slice(from, end),
				visible = new Set(events.map(e => e.id)),
				references = new Set(events.map(e => e.question));
			value = {
				...flags,
				item,
				events,
				asks: all.filter(e => e.kind === "asked" && !visible.has(e.id) && references.has(e.id)),
				beforeEvent: from > 0 ? (events[0]?.id ?? null) : null,
				afterEvent: end < all.length ? (events.at(-1)?.id ?? null) : null,
			};
		}
	}
	return value as ItemsV2Reply<R>;
}
