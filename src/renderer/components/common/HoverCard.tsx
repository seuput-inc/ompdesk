/**
 * HoverCard — a short peek at what a link points to (a pull request, a web page), beside the link.
 *
 * Rules: it opens after `HOVER_CARD_DELAY_MS` of hover, or at once when the link gets keyboard focus; leaving, blur,
 * a press, Escape or a scroll close it, and focus never moves (WCAG 1.4.13). It takes no pointer and holds no
 * controls: what it says is a peek, and the link itself is the action. A finger has no hover, so it never opens on a
 * touch screen. `content` mounts only while the card is open, so whatever it reads starts then. It wears the popover's
 * panel (`PopoverSurface`) and names itself as the trigger's description while shown. For a label of a control use
 * `Tooltip`; for controls by their trigger, `Popover`.
 */

import {
	type CSSProperties,
	cloneElement,
	type FocusEvent,
	type HTMLAttributes,
	type PointerEvent,
	type ReactElement,
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useShellInput } from "../../hooks/use-shell-mode";
import { PopoverSurface } from "./Popover";

export const HOVER_CARD_DELAY_MS = 400;
const GAP = 6;
const MARGIN = 8;

export interface HoverCardProps {
	content: ReactNode;
	/** A single element that takes pointer and focus handlers (a link, usually). */
	children: ReactElement<HTMLAttributes<HTMLElement>>;
}

export function HoverCard({ content, children }: HoverCardProps) {
	const id = useId();
	const [anchor, setAnchor] = useState<HTMLElement | null>(null);
	const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
	const cardRef = useRef<HTMLDivElement>(null);
	const timerRef = useRef<number | undefined>(undefined);
	const touch = useShellInput() === "touch";

	const hide = () => {
		clearTimeout(timerRef.current);
		setAnchor(null);
		setPosition(null);
	};

	useEffect(() => () => clearTimeout(timerRef.current), []);

	// Escape and scrolling close it without moving focus.
	useEffect(() => {
		if (!anchor) return;
		const dismiss = () => {
			setAnchor(null);
			setPosition(null);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") dismiss();
		};
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("scroll", dismiss, true);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			window.removeEventListener("scroll", dismiss, true);
		};
	}, [anchor]);

	// Under the link, above it when the window has no room below; placed again as its content arrives.
	useLayoutEffect(() => {
		const card = cardRef.current;
		if (!anchor || !card) return;
		const place = () => {
			const link = anchor.getBoundingClientRect();
			const { offsetWidth: width = 0, offsetHeight: height = 0 } = card;
			let top = link.bottom + GAP;
			if (top + height > window.innerHeight - MARGIN) top = link.top - height - GAP;
			setPosition({
				left: Math.min(Math.max(MARGIN, link.left), window.innerWidth - width - MARGIN),
				top: Math.max(MARGIN, top),
			});
		};
		place();
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
		observer?.observe(card);
		return () => observer?.disconnect();
	}, [anchor]);

	const props = children.props;
	const trigger = cloneElement(children, {
		"aria-describedby": anchor ? id : props["aria-describedby"],
		onPointerEnter: (event: PointerEvent<HTMLElement>) => {
			props.onPointerEnter?.(event);
			// A press held while entering is a drag (a selection), not a look.
			if (touch || event.pointerType === "touch" || event.buttons) return;
			const target = event.currentTarget;
			clearTimeout(timerRef.current);
			timerRef.current = window.setTimeout(() => setAnchor(target), HOVER_CARD_DELAY_MS);
		},
		onPointerLeave: (event: PointerEvent<HTMLElement>) => {
			props.onPointerLeave?.(event);
			hide();
		},
		onPointerDown: (event: PointerEvent<HTMLElement>) => {
			props.onPointerDown?.(event);
			hide();
		},
		onFocus: (event: FocusEvent<HTMLElement>) => {
			props.onFocus?.(event);
			if (!touch && event.currentTarget.matches(":focus-visible")) setAnchor(event.currentTarget);
		},
		onBlur: (event: FocusEvent<HTMLElement>) => {
			props.onBlur?.(event);
			hide();
		},
	});

	return (
		<>
			{trigger}
			{anchor &&
				createPortal(
					<div
						className="omp-pop-in pointer-events-none fixed z-(--sc-z-tooltip)"
						data-hover-card=""
						id={id}
						ref={cardRef}
						role="tooltip"
						style={
							{
								left: position?.left ?? 0,
								top: position?.top ?? 0,
								visibility: position ? undefined : "hidden",
								"--omp-pop-origin": "top left",
							} as CSSProperties
						}
					>
						<PopoverSurface className="w-[min(22.5rem,calc(100vw-1rem))] text-sc-sm">{content}</PopoverSurface>
					</div>,
					document.body,
				)}
		</>
	);
}
