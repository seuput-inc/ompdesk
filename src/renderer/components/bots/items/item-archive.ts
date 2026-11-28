import { useEffect, useRef } from "react";
import type { ItemsV2Reply, ItemsV2Request, ListedItem } from "../../../../shared/items-v2";
import { cachedItemQuery, queryItems } from "../../../stores/item-query";

type Request = Extract<ItemsV2Request, { action: "itemsPage" }>;
type Page = ItemsV2Reply<Request>;
export interface ArchiveSlice {
	rows: ListedItem[];
	error?: string;
	unreadTotal?: number;
	unread?: Page["next"];
	byTime?: Page["next"];
}

/** Each bot needs its own top N before merging a group's rows. Fetch unread first, then fill from time order. */
export async function extendArchive(
	previous: ArchiveSlice,
	device: string | undefined,
	bot: string,
	seen: number,
	take: number,
	read: (request: Request) => Promise<Page>,
): Promise<ArchiveSlice> {
	const result: ArchiveSlice = { ...previous, error: undefined };
	const rows = new Map(previous.rows.map(row => [row.id, row]));
	for (const stream of ["unread", "byTime"] as const) {
		while (result[stream] !== null && (rows.size < take || (stream === "unread" && result[stream] === undefined))) {
			const before = result[stream];
			let page: Page;
			try {
				page = await read({
					protocol: 2,
					action: "itemsPage",
					id: bot,
					...(before && { before }),
					...(stream === "unread" && { unreadSince: seen }),
				});
				if (
					page.next &&
					(!page.closed.length ||
						(before &&
							(page.next.at > before.at || (page.next.at === before.at && page.next.number >= before.number))))
				)
					throw new Error("Invalid item archive cursor");
			} catch (error) {
				result.error = error instanceof Error ? error.message : String(error);
				break;
			}
			for (const row of page.closed) rows.set(row.id, device ? { ...row, device } : row);
			result[stream] = page.next;
			if (stream === "unread") result.unreadTotal = page.unreadTotal;
		}
	}
	result.rows = [...rows.values()];
	return result;
}

/** Remounted for a new seen mark or archive revision; an old cursor never indexes a new ordering. */
export function ArchiveReader({
	source,
	device,
	bot,
	seen,
	take,
	visible,
	online,
	publish,
}: {
	source: string;
	device?: string;
	bot: string;
	seen: number;
	take: number;
	visible: boolean;
	online: boolean;
	publish: (bot: string, device: string | undefined, source: string, page: ArchiveSlice) => void;
}) {
	const last = useRef<ArchiveSlice>({ rows: [] });
	useEffect(() => {
		if (!visible) return;
		let active = true;
		const read = async (request: Request) => {
			if (!active) throw new Error("Archive view closed");
			if (!online) {
				const cached = cachedItemQuery(device ?? null, request);
				if (cached) return cached;
			}
			return queryItems(device ?? null, request);
		};
		void extendArchive(last.current, device, bot, seen, take, read).then(page => {
			if (!active) return;
			last.current = page;
			publish(bot, device, source, page);
		});
		return () => {
			active = false;
		};
	}, [source, device, bot, seen, take, visible, online, publish]);
	return null;
}
