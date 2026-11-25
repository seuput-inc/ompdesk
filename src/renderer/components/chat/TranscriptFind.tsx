/**
 * The conversation's Find bar (⌘F, `transcript.find`; Orca's `NativeChatFindBar.tsx` and `use-native-chat-find*.ts`,
 * MIT, re-implemented over OMPdesk's virtualized transcript): a field at the transcript's top right with "n/m",
 * previous, next and close. Matches are counted in the loaded rows' text (`transcript-find.ts`), so a match in a row
 * the virtualizer has not mounted still counts and a step scrolls to it; the text of mounted rows is marked with CSS
 * highlights (`::highlight(omp-find)`, `omp-find-active`), never by rewriting the DOM React owns.
 *
 * Enter steps down, Shift+Enter up, Escape closes and gives focus back to where it was.
 */
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { IconButton, Input } from "../common";
import type { Row } from "./chat-stream-utils";
import { type FindHit, findHits, findScrollDelta, rowRanges, startingHit } from "./transcript-find";

/** Asks the transcript of `detail.tabId` to open its Find bar (or to focus it again). */
export const TRANSCRIPT_FIND_EVENT = "omp:transcript-find";

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

function eventTabId(event: Event): string | null | undefined {
	if (!(event instanceof CustomEvent)) return undefined;
	const detail: unknown = event.detail;
	return detail &&
		typeof detail === "object" &&
		"tabId" in detail &&
		(typeof detail.tabId === "string" || detail.tabId === null)
		? detail.tabId
		: undefined;
}

export interface TranscriptFindProps {
	tabId: string | null;
	rows: readonly Row[];
	scrollerRef: RefObject<HTMLElement | null>;
	/** The first row on screen: a new search starts there. */
	firstRowInView: () => number;
	/** Brings a row into view (unpinning the transcript from its end). */
	showRow: (index: number) => void;
	/** Scrolls the transcript by `delta` px. */
	scrollBy: (delta: number) => void;
	/** Changes whenever the mounted rows change, so the marks follow. */
	mountedKey: string;
}

export function TranscriptFind(props: TranscriptFindProps) {
	const { tabId, scrollerRef } = props;
	const [open, setOpen] = useState(false);
	const returnFocus = useRef<HTMLElement | null>(null);
	const focusField = useRef<(() => void) | null>(null);
	useEffect(() => {
		const onOpen = (event: Event) => {
			if (eventTabId(event) !== tabId) return;
			if (focusField.current) {
				focusField.current();
				return;
			}
			returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			setOpen(true);
		};
		window.addEventListener(TRANSCRIPT_FIND_EVENT, onOpen);
		return () => window.removeEventListener(TRANSCRIPT_FIND_EVENT, onOpen);
	}, [tabId]);
	const close = useCallback(() => {
		setOpen(false);
		const back = returnFocus.current;
		returnFocus.current = null;
		if (back?.isConnected) back.focus({ preventScroll: true });
		else scrollerRef.current?.focus({ preventScroll: true });
	}, [scrollerRef]);
	return open ? <FindBar {...props} focusField={focusField} onClose={close} /> : null;
}

function FindBar({
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
		<div
			className="omp-floating absolute top-2 right-4 z-20 flex w-80 max-w-[calc(100%-2rem)] items-center gap-1 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) p-1 shadow-(--sc-shadow-md)"
			data-transcript-find
			ref={barRef}
			role="search"
		>
			<div className="min-w-0 flex-1">
				<Input
					aria-label={t("chat.find.label")}
					controlSize="sm"
					leadingIcon={<Search />}
					onChange={event => setQuery(event.target.value)}
					onKeyDown={event => {
						if (isImeKeyEvent(event)) return;
						if (event.key === "Enter") {
							event.preventDefault();
							step(event.shiftKey ? -1 : 1);
						} else if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
							onClose();
						}
					}}
					placeholder={t("chat.find.label")}
					ref={inputRef}
					trailing={
						<span
							aria-live="polite"
							className="text-sc-xs whitespace-nowrap text-(--sc-text-muted) tabular-nums"
							data-find-status
						>
							{status}
						</span>
					}
					value={query}
				/>
			</div>
			<IconButton
				disabled={hits.length === 0}
				icon={<ChevronUp />}
				label={t("chat.find.previous")}
				onClick={() => step(-1)}
				shortcut="⇧↵"
				size="sm"
				variant="ghost"
			/>
			<IconButton
				disabled={hits.length === 0}
				icon={<ChevronDown />}
				label={t("chat.find.next")}
				onClick={() => step(1)}
				shortcut="↵"
				size="sm"
				variant="ghost"
			/>
			<IconButton
				icon={<X />}
				label={t("chat.find.close")}
				onClick={onClose}
				shortcut="Esc"
				size="sm"
				variant="ghost"
			/>
		</div>
	);
}
