/**
 * SelectionActions — a few actions beside text the person selected inside a surface (Orca's
 * `selection-quotes/SelectionAddToChatPopover.tsx`, MIT): "Add to chat" in a transcript or a file, "Add note" in a
 * document.
 *
 * Rules (Orca's): offered only once the selection settles (a mouse release, a key release); after a double click it
 * waits `DOUBLE_CLICK_SETTLE_MS` so a third click that selects the paragraph is not taken by a button that appeared under
 * the pointer. It never takes focus, and a press on it keeps the selection (mousedown is held), so the text stays
 * selected until an action takes it. It follows the text as its scroller scrolls, hides while the text is out of
 * `root`'s box, and closes on a press elsewhere, a changed selection, a resize or the window losing focus. A
 * selection that `accept` refuses (empty, outside the parts that may be quoted) offers nothing.
 */
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { Button } from "./Button";

/** Shown at once, a double click's button would sit under the pointer and take the third click. */
export const DOUBLE_CLICK_SETTLE_MS = 500;

export interface SelectionAction {
	id: string;
	label: string;
	icon: ReactNode;
	/** `text`: the selected text; `button`: where the action was pressed, for a menu that opens from it. */
	run: (text: string, button: DOMRect, range: Range) => void;
}

/** The selection's text and range when it sits wholly inside `root`, else null. */
export function selectionWithin(root: HTMLElement): { text: string; range: Range } | null {
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
	const range = selection.getRangeAt(0);
	if (!root.contains(range.commonAncestorContainer)) return null;
	const text = selection.toString().trim();
	return text ? { text, range } : null;
}

export function SelectionActions({
	rootRef,
	actions,
	enabled = true,
	accept = selectionWithin,
}: {
	rootRef: RefObject<HTMLElement | null>;
	actions: readonly SelectionAction[];
	enabled?: boolean;
	/** Reads the selection the actions are for; null offers nothing. */
	accept?: (root: HTMLElement) => { text: string; range: Range } | null;
}) {
	const t = useT();
	const [offer, setOffer] = useState<{ text: string; range: Range } | null>(null);
	const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
	const barRef = useRef<HTMLDivElement>(null);
	const acceptRef = useRef(accept);
	acceptRef.current = accept;

	useEffect(() => {
		const root = rootRef.current;
		if (!enabled || !root) return;
		let changed = false;
		let timer: number | undefined;
		let offered: string | null = null;
		const show = (next: { text: string; range: Range } | null) => {
			offered = next?.text ?? null;
			setOffer(next);
		};
		const close = () => {
			window.clearTimeout(timer);
			show(null);
		};
		const settle = (delay: number) => {
			// A press or key that left the selection as it was (a scrollbar, a modifier) selected nothing new.
			if (!changed) return;
			changed = false;
			window.clearTimeout(timer);
			timer = window.setTimeout(() => show(acceptRef.current(root)), delay);
		};
		const onPointerDown = (event: PointerEvent) => {
			if (event.target instanceof Node && barRef.current?.contains(event.target)) return;
			close();
			changed = false;
		};
		const onMouseUp = (event: MouseEvent) => {
			if (event.button === 0) settle(event.detail === 2 ? DOUBLE_CLICK_SETTLE_MS : 0);
		};
		const onKeyUp = () => settle(0);
		const onSelectionChange = () => {
			changed = true;
			if (offered !== null && acceptRef.current(root)?.text !== offered) show(null);
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("selectionchange", onSelectionChange);
		window.addEventListener("mouseup", onMouseUp);
		document.addEventListener("keyup", onKeyUp);
		window.addEventListener("blur", close);
		window.addEventListener("resize", close);
		return () => {
			close();
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("selectionchange", onSelectionChange);
			window.removeEventListener("mouseup", onMouseUp);
			document.removeEventListener("keyup", onKeyUp);
			window.removeEventListener("blur", close);
			window.removeEventListener("resize", close);
		};
	}, [enabled, rootRef]);

	// Where the bar sits: above the selection's last line, at its end; again on every scroll inside the page.
	useEffect(() => {
		const root = rootRef.current;
		if (!offer || !root) {
			setPlace(null);
			return;
		}
		const measure = () => {
			const rects = offer.range.getClientRects();
			const end = rects.length > 0 ? rects[rects.length - 1] : offer.range.getBoundingClientRect();
			const box = root.getBoundingClientRect();
			if (!end || end.bottom < box.top || end.top > box.bottom) {
				setPlace(null);
				return;
			}
			setPlace({ left: Math.max(8, Math.min(end.right, window.innerWidth - 8)), top: Math.max(8, end.top - 6) });
		};
		measure();
		document.addEventListener("scroll", measure, { capture: true, passive: true });
		return () => document.removeEventListener("scroll", measure, { capture: true });
	}, [offer, rootRef]);

	if (!offer || !place || actions.length === 0) return null;
	return createPortal(
		<div
			className="omp-floating omp-pop-in no-drag fixed z-(--sc-z-popover) flex -translate-x-1/2 -translate-y-full gap-0.5 rounded-(--sc-radius-md) border border-(--sc-border-subtle) p-0.5"
			data-selection-actions
			onMouseDown={event => event.preventDefault()}
			ref={barRef}
			aria-label={t("selectionActions.label")}
			role="toolbar"
			style={{ left: place.left, top: place.top }}
		>
			{actions.map(action => (
				<Button
					icon={action.icon}
					key={action.id}
					onClick={event => {
						const { text, range } = offer;
						const button = event.currentTarget.getBoundingClientRect();
						// Taken or not, the offer is spent.
						setOffer(null);
						action.run(text, button, range);
					}}
					size="sm"
					variant="ghost"
				>
					{action.label}
				</Button>
			))}
		</div>,
		document.body,
	);
}
