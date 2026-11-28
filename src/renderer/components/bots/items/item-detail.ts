import { useEffect, useRef, useState } from "react";
import type { Item, ItemEvent } from "../../../../shared/bots";
import type { ItemsV2Reply, ItemsV2Request, ListedItem } from "../../../../shared/items-v2";
import { cachedItemQuery, queryItems } from "../../../stores/item-query";

type Request = Extract<ItemsV2Request, { action: "itemDetail" }>;
type Page = ItemsV2Reply<Request>;
export interface ItemHistory {
	item: Item;
	asks: ReadonlyMap<number, ItemEvent>;
	beforeEvent: number | null;
}

/** Cursors are positions in the journal, not a promise of numerically increasing imported IDs. */
export function mergeHistory(old: ItemHistory | undefined, page: Page, older: boolean, device?: string): ItemHistory {
	const events = !old
		? page.events
		: !page.events.length
			? old.item.events
			: older
				? [...page.events, ...old.item.events]
				: [...old.item.events, ...page.events];
	let asks = old?.asks;
	if (!asks || page.asks.length || page.events.some(e => e.kind === "asked")) {
		const updated = new Map(asks);
		for (const event of page.asks) updated.set(event.id, event);
		for (const event of page.events) if (event.kind === "asked") updated.set(event.id, event);
		asks = updated;
	}
	return {
		item: { ...(old && older ? old.item : page.item), events, device },
		asks,
		beforeEvent: old && !older ? old.beforeEvent : page.beforeEvent,
	};
}

export function useItemHistory(
	bot: string,
	id: string | number,
	device: string | undefined,
	signal: ListedItem | number | undefined,
	legacy: boolean,
	online: boolean,
) {
	const [detail, setDetail] = useState(() => {
		if (legacy) return undefined;
		const head: Request = { protocol: 2, action: "itemDetail", bot, id };
		const page = cachedItemQuery(device ?? null, head);
		if (!page) return undefined;
		let last = page;
		let pages: Page[] | undefined;
		let cursors: Set<number> | undefined;
		while (!online) {
			const afterEvent = last.events.at(-1)?.id ?? 0;
			const tail = cachedItemQuery(device ?? null, { ...head, afterEvent });
			if (!tail?.events.length) break;
			const end = tail.events[tail.events.length - 1].id;
			cursors ??= new Set([afterEvent]);
			if (cursors.has(end) || (tail.afterEvent !== null && tail.afterEvent !== end)) break;
			cursors.add(end);
			pages ??= [page];
			pages.push(tail);
			last = tail;
		}
		return mergeHistory(
			undefined,
			pages
				? {
						...last,
						events: pages.flatMap(p => p.events),
						asks: pages.flatMap(p => p.asks),
						beforeEvent: page.beforeEvent,
					}
				: page,
			false,
			device,
		);
	});
	const current = useRef(detail);
	const liveHead = useRef(false);
	const [error, setError] = useState("");
	const [attempt, retry] = useState(0);
	const [before, setBefore] = useState<number | null>(null);
	const failedBefore = useRef<number | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a feed invalidation or an explicit retry must request the new tail.
	useEffect(() => {
		if (legacy) return;
		let active = true;
		const read = async () => {
			const head: Request = { protocol: 2, action: "itemDetail", bot, id };
			let request: Request =
				liveHead.current && current.current
					? { ...head, afterEvent: current.current.item.events.at(-1)?.id ?? 0 }
					: head;
			if (!online && current.current) return;
			let cursors: Set<number> | undefined;
			for (;;) {
				const page = await queryItems(device ?? null, request);
				if (!active) return;
				const end = page.events.at(-1)?.id;
				if (
					(page.afterEvent !== null && page.afterEvent !== end) ||
					(end !== undefined && (end === request.afterEvent || cursors?.has(end)))
				) {
					throw new Error("Invalid item event cursor");
				}
				if (page.afterEvent !== null) {
					cursors ??= new Set(request.afterEvent === undefined ? [] : [request.afterEvent]);
					cursors.add(page.afterEvent);
				}
				current.current = mergeHistory(
					request.afterEvent === undefined ? undefined : current.current,
					page,
					false,
					device,
				);
				liveHead.current = true;
				setDetail(current.current);
				if (failedBefore.current === null) setError("");
				if (page.afterEvent === null) break;
				request = { ...head, afterEvent: page.afterEvent };
			}
		};
		void read().catch((cause: unknown) => {
			if (active) setError(cause instanceof Error ? cause.message : String(cause));
		});
		return () => {
			active = false;
		};
	}, [bot, id, device, legacy, online, signal, attempt]);
	useEffect(() => {
		if (before === null) return;
		let active = true;
		const request = { protocol: 2, action: "itemDetail", bot, id, beforeEvent: before } as const;
		const cached = !online && cachedItemQuery(device ?? null, request);
		void (cached ? Promise.resolve(cached) : queryItems(device ?? null, request))
			.then(
				page => {
					if (!active) return;
					current.current = mergeHistory(current.current, page, true, device);
					setDetail(current.current);
					failedBefore.current = null;
					setError("");
				},
				(cause: unknown) => {
					if (active) {
						failedBefore.current = before;
						setError(cause instanceof Error ? cause.message : String(cause));
					}
				},
			)
			.finally(() => {
				if (active) setBefore(null);
			});
		return () => {
			active = false;
		};
	}, [bot, id, device, online, before]);
	return {
		detail,
		error,
		retry: () => (failedBefore.current !== null ? setBefore(failedBefore.current) : retry(n => n + 1)),
		earlier: () => setBefore(current.current?.beforeEvent ?? null),
		paging: before !== null || (online && !liveHead.current),
	};
}
