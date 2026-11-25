/**
 * Find in the conversation (⌘F; Orca's `viewport/find`, MIT, re-implemented). The transcript is virtualized, so the
 * count and the steps come from the rows' own text, not the DOM: every loaded prompt and reply is searched, mounted
 * or not, and a step scrolls its row into view before the mounted text is marked. Only what a person wrote and the
 * replies' text count (Orca's rule: message text, never timestamps, buttons or folded tool output).
 */
import type { AgentMessage } from "../../../shared/rpc-types";
import { promptDisplayText } from "../../lib/prompt-text";
import type { Row } from "./chat-stream-utils";

/** One occurrence: its row, and which occurrence of the query it is inside that row's text. */
export interface FindHit {
	row: number;
	nth: number;
}

/** At most this many matches are counted: past it a one-letter query would only cost time. */
export const FIND_MAX_HITS = 5000;

/** The text of a row a reader can find: a prompt's or a reply's text blocks, in order. */
export function rowFindText(row: Row): string {
	if (row.kind !== "message") return "";
	return messageFindText(row.message);
}

function messageFindText(message: AgentMessage): string {
	if (message.role !== "user" && message.role !== "assistant") return "";
	const content =
		typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const block of content)
		if (block.type === "text") texts.push(message.role === "user" ? promptDisplayText(block.text) : block.text);
	return texts.join("\n");
}

/** Case-insensitive, non-overlapping occurrences of `query` in `text`. */
export function countOccurrences(text: string, query: string): number {
	if (!query) return 0;
	const haystack = text.toLocaleLowerCase();
	const needle = query.toLocaleLowerCase();
	let count = 0;
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
	return count;
}

/** Every occurrence of `query` in the rows, top to bottom, at most {@link FIND_MAX_HITS}. */
export function findHits(rows: readonly Row[], query: string): FindHit[] {
	const hits: FindHit[] = [];
	if (!query.trim()) return hits;
	for (const [row, entry] of rows.entries()) {
		const count = countOccurrences(rowFindText(entry), query);
		for (let nth = 0; nth < count && hits.length < FIND_MAX_HITS; nth++) hits.push({ row, nth });
		if (hits.length >= FIND_MAX_HITS) break;
	}
	return hits;
}

/** The hit to start on: the first at or below the row the reader is on, else the last one above it. */
export function startingHit(hits: readonly FindHit[], firstRowInView: number): number {
	if (hits.length === 0) return -1;
	const below = hits.findIndex(hit => hit.row >= firstRowInView);
	return below === -1 ? hits.length - 1 : below;
}

/** The parts of a mounted row whose text the find marks: a prompt's text and a reply's own Markdown. */
const FIND_TEXT_SELECTOR = ".omp-user-text, .omp-transcript-content > .markdown-body";

/** A match across a run of text nodes: where it starts and ends, as [node index, offset in that node]. */
export interface TextSpan {
	start: [number, number];
	end: [number, number];
}

/** Every case-insensitive occurrence of `query` in the text the nodes make together, located in the nodes. */
export function matchSpans(texts: readonly string[], query: string): TextSpan[] {
	if (!query) return [];
	const starts: number[] = [];
	let text = "";
	for (const part of texts) {
		starts.push(text.length);
		text += part;
	}
	const locate = (at: number): [number, number] => {
		let index = texts.length - 1;
		while (index > 0 && (starts[index] ?? 0) > at) index--;
		return [index, at - (starts[index] ?? 0)];
	};
	const needle = query.toLocaleLowerCase();
	const haystack = text.toLocaleLowerCase();
	const spans: TextSpan[] = [];
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length))
		spans.push({ start: locate(at), end: locate(at + needle.length) });
	return spans;
}

/** DOM ranges of every occurrence of `query` inside the text a mounted row shows, in document order. */
export function rowRanges(rowElement: Element, query: string): Range[] {
	const ranges: Range[] = [];
	const document = rowElement.ownerDocument;
	for (const part of rowElement.querySelectorAll(FIND_TEXT_SELECTOR)) {
		// One text per part, so a match across inline elements (bold, code, a link) is found as the reader sees it.
		const nodes: Text[] = [];
		// NodeFilter.SHOW_TEXT, written out: a DOM without the NodeFilter global walks the same.
		const walker = document.createTreeWalker(part, 0x4);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!(node instanceof Text) || node.parentElement?.closest(".sr-only, [hidden], [aria-hidden='true'], button"))
				continue;
			nodes.push(node);
		}
		for (const { start, end } of matchSpans(
			nodes.map(node => node.data),
			query,
		)) {
			const from = nodes[start[0]];
			const to = nodes[end[0]];
			if (!from || !to) continue;
			const range = document.createRange();
			range.setStart(from, start[1]);
			range.setEnd(to, end[1]);
			ranges.push(range);
		}
	}
	return ranges;
}

/**
 * How far to scroll so `match` sits mid-view, below the bar when the bar covers it. Adapted from Orca's
 * `nativeChatFindScrollDelta` (Copyright (c) 2026 Lovecast Inc., MIT; attributed in THIRD_PARTY_NOTICES.txt).
 */
export function findScrollDelta(
	match: Pick<DOMRect, "top" | "bottom" | "left" | "right">,
	view: Pick<DOMRect, "top" | "bottom">,
	bar: Pick<DOMRect, "bottom" | "left" | "right"> | null,
): number {
	const underBar = bar !== null && match.left < bar.right && match.right > bar.left;
	const top = underBar ? Math.max(view.top, bar.bottom) : view.top;
	return (match.top + match.bottom) / 2 - (top + view.bottom) / 2;
}
