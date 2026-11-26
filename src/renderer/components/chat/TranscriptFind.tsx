/**
 * The conversation's Find bar (⌘F, `transcript.find`; Orca's `NativeChatFindBar.tsx` and `use-native-chat-find*.ts`,
 * MIT, re-implemented over OMPdesk's virtualized transcript): a field at the transcript's top right with "n/m",
 * previous, next and close. Matches are counted in the loaded rows' text (`transcript-find.ts`), so a match in a row
 * the virtualizer has not mounted still counts and a step scrolls to it; the text of mounted rows is marked with CSS
 * highlights, never by rewriting the DOM React owns. The bar (`TranscriptFindBar.tsx`) loads idle after start.
 *
 * Enter steps down, Shift+Enter up, Escape closes and gives focus back to where it was.
 */
import { type RefObject, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { lazyChunk, loadChunk } from "../../lib/chunk-load";
import type { Row } from "./chat-stream-utils";
import type TranscriptFindBarComponent from "./TranscriptFindBar";

const loadFindBar = () => import("./TranscriptFindBar");
const LazyFindBar = lazyChunk(loadFindBar);
/** The bar once its chunk loaded (AppShell's idle preload): drawn directly on ⌘F, never suspended. */
let loadedFindBar: typeof TranscriptFindBarComponent | undefined;

/** Loads the Find bar before the first ⌘F (AppShell). */
export function preloadTranscriptFind(): Promise<void> {
	return loadChunk(loadFindBar).then(
		module => {
			loadedFindBar = module.default;
		},
		() => {},
	);
}

/** Asks the transcript of `detail.tabId` to open its Find bar (or to focus it again). */
export const TRANSCRIPT_FIND_EVENT = "omp:transcript-find";

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
	const TranscriptFindBar = loadedFindBar ?? LazyFindBar;
	return open ? (
		<Suspense fallback={null}>
			<TranscriptFindBar {...props} focusField={focusField} onClose={close} />
		</Suspense>
	) : null;
}
