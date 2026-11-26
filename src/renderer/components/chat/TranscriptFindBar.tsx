/**
 * The Find bar itself (TranscriptFind.tsx loads it on the first ⌘F, so a phone's first screen never carries it): the
 * field, "n/m", previous, next and close; the count and steps over the loaded rows' text (`transcript-find.ts`), the
 * mounted rows' matches marked with CSS highlights (`::highlight(omp-find)`, `omp-find-active`).
 */
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { FindBar } from "../common";
import type { TranscriptFindProps } from "./TranscriptFind";
import { type FindHit, findHits, findScrollDelta, rowRanges, startingHit } from "./transcript-find";

/** The page's highlight registry; absent where the CSS Custom Highlight API is (an older WebKit): nothing is painted. */
function highlightRegistry(): HighlightRegistry | null {
	return typeof Highlight === "undefined" || typeof CSS === "undefined" || !("highlights" in CSS)
		? null
		: CSS.highlights;
}

function mark(name: string, ranges: readonly Range[]): void {
	const registry = highlightRegistry();
	if (!registry) return;
	if (ranges.length === 0) registry.delete(name);
	else registry.set(name, new Highlight(...ranges));
}

function clearMarks(): void {
	mark("omp-find", []);
	mark("omp-find-active", []);
}

export default function TranscriptFindBar({
	rows,
	scrollerRef,
	firstRowInView,
	showRow,
	scrollBy,
	mountedKey,
	focusField,
	onClose,
}: TranscriptFindProps & { focusField: RefObject<(() => void) | null>; onClose: () => void }) {
	const t = useT();
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(-1);
	const inputRef = useRef<HTMLInputElement>(null);
	const barRef = useRef<HTMLDivElement>(null);
	const hits = useMemo(() => findHits(rows, query), [rows, query]);
	const hitsRef = useRef<readonly FindHit[]>(hits);
	hitsRef.current = hits;
	/** A step asked for its match to be brought mid-view once its row is mounted. */
	const placeRef = useRef(false);

	useEffect(() => {
		const focus = () => {
			inputRef.current?.focus();
			inputRef.current?.select();
		};
		focus();
		focusField.current = focus;
		return () => {
			focusField.current = null;
			clearMarks();
		};
	}, [focusField]);

	const go = useCallback(
		(index: number) => {
			const hit = hitsRef.current[index];
			setActive(index);
			if (!hit) return;
			placeRef.current = true;
			showRow(hit.row);
		},
		[showRow],
	);

	// A new query starts from the reader's place; the same query keeps its match while rows come and go.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only a new query restarts the search
	useEffect(() => {
		go(startingHit(hitsRef.current, firstRowInView()));
	}, [query]);
	useEffect(() => {
		if (active >= hits.length) setActive(hits.length - 1);
	}, [active, hits.length]);

	const step = (direction: 1 | -1) => {
		const count = hitsRef.current.length;
		if (count === 0) return;
		go(active < 0 ? (direction > 0 ? 0 : count - 1) : (active + direction + count) % count);
	};

	// Mark the mounted rows' matches after every commit that moved rows; bring a stepped-to match mid-view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: mountedKey stands for the mounted rows
	useLayoutEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller || !query.trim()) {
			clearMarks();
			return;
		}
		const all: Range[] = [];
		let activeRange: Range | null = null;
		const hit = hits[active];
		for (const element of scroller.querySelectorAll<HTMLElement>("[data-index]")) {
			const ranges = rowRanges(element, query);
			all.push(...ranges);
			if (hit && Number(element.dataset.index) === hit.row && ranges.length > 0)
				activeRange = ranges[Math.min(hit.nth, ranges.length - 1)] ?? null;
		}
		mark("omp-find", all);
		mark("omp-find-active", activeRange ? [activeRange] : []);
		if (placeRef.current && activeRange) {
			placeRef.current = false;
			const delta = findScrollDelta(
				activeRange.getBoundingClientRect(),
				scroller.getBoundingClientRect(),
				barRef.current?.getBoundingClientRect() ?? null,
			);
			if (Math.abs(delta) > 1) scrollBy(delta);
		}
	}, [active, hits, mountedKey, query, scrollBy, scrollerRef]);

	const status = !query.trim() ? "" : hits.length === 0 ? t("chat.find.none") : `${active + 1}/${hits.length}`;
	return (
		<FindBar
			canStep={hits.length > 0}
			className="omp-floating absolute top-2 right-4 z-20 flex w-80 max-w-[calc(100%-2rem)] items-center gap-1 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) p-1 shadow-(--sc-shadow-md)"
			closeLabel={t("chat.find.close")}
			data-transcript-find
			inputRef={inputRef}
			label={t("chat.find.label")}
			nextLabel={t("chat.find.next")}
			onClose={onClose}
			onQuery={setQuery}
			onStep={step}
			previousLabel={t("chat.find.previous")}
			query={query}
			ref={barRef}
			status={status}
		/>
	);
}
