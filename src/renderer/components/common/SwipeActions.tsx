/**
 * A row a touch swipe slides sideways to uncover its actions (Orca mobile/src/components/list/SwipeRowActions.tsx):
 * `trailing` behind a swipe to the left, `leading` behind one to the right. A swipe past half an action settles open,
 * tapping an uncovered action runs it and closes the row, and a tap on an open row closes it instead of pressing it.
 * Touch only: a mouse, a pen and the keyboard reach the same actions in the row's menu, so the actions are inert
 * while the row rests. A vertical drag scrolls the list (`touch-action: pan-y`).
 */
import type { LucideIcon } from "lucide-react";
import { type MouseEvent, type PointerEvent, type ReactNode, useCallback, useRef, useState } from "react";
import { cx } from "../../lib/format";

/** The width one action uncovers. */
const ACTION_WIDTH = 76;
/** How far a touch travels before it counts as a swipe or a scroll. */
const SLOP_PX = 10;

interface Drag {
	x: number;
	y: number;
	start: number;
	/** Sideways (the row's), or up and down (the list's scroll); null until the touch left the slop. */
	horizontal: boolean | null;
}

/** Decide once, past the slop, whether a touch swipes the row or scrolls the list. */
function lock(drag: Drag, point: { clientX: number; clientY: number }): void {
	if (drag.horizontal !== null) return;
	const dx = point.clientX - drag.x;
	const dy = point.clientY - drag.y;
	if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return;
	drag.horizontal = Math.abs(dx) > Math.abs(dy);
}

export interface SwipeAction {
	id: string;
	label: string;
	icon: LucideIcon;
	tone?: "accent" | "neutral";
	onSelect: () => void;
}

export interface SwipeActionsProps {
	leading?: SwipeAction;
	trailing?: readonly SwipeAction[];
	children: ReactNode;
}

export function SwipeActions({ leading, trailing = [], children }: SwipeActionsProps) {
	const [offset, setOffset] = useState(0);
	const [dragging, setDragging] = useState(false);
	const drag = useRef<Drag | null>(null);
	// A swipe's release may still click the row: that click belongs to the swipe.
	const swiped = useRef(false);
	const maxRight = leading ? ACTION_WIDTH : 0;
	const maxLeft = -ACTION_WIDTH * trailing.length;
	// The move is handled natively on the track, not through React: once a touch locks sideways the row takes it and
	// stops it there, so no native listener above sees it. The phone's drawer (SidebarDrawer) closes on a swipe left over
	// its panel and would otherwise shut while Archive uncovers. React's own handlers run at the root, above the panel,
	// so a React handler could neither stop the panel's listener in time nor run at all once the move is stopped.
	const claimSwipe = useCallback(
		(track: HTMLDivElement | null) => {
			if (!track) return;
			const move = (event: globalThis.PointerEvent) => {
				const current = drag.current;
				if (!current) return;
				lock(current, event);
				if (current.horizontal === null) return;
				if (!current.horizontal) {
					drag.current = null;
					return;
				}
				event.stopPropagation();
				if (!swiped.current) {
					track.setPointerCapture?.(event.pointerId);
					setDragging(true);
				}
				swiped.current = true;
				setOffset(Math.min(maxRight, Math.max(maxLeft, current.start + event.clientX - current.x)));
			};
			track.addEventListener("pointermove", move);
			return () => track.removeEventListener("pointermove", move);
		},
		[maxRight, maxLeft],
	);
	if (!leading && trailing.length === 0) return <>{children}</>;
	const open = offset !== 0;

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		swiped.current = false;
		if (event.pointerType !== "touch") return;
		drag.current = { x: event.clientX, y: event.clientY, start: offset, horizontal: null };
	};
	const onPointerEnd = () => {
		if (!drag.current?.horizontal) {
			drag.current = null;
			return;
		}
		drag.current = null;
		setDragging(false);
		setOffset(at => (at > ACTION_WIDTH / 2 ? maxRight : at < -ACTION_WIDTH / 2 ? maxLeft : 0));
	};
	const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
		if (!swiped.current && !open) return;
		event.preventDefault();
		event.stopPropagation();
		swiped.current = false;
		setOffset(0);
	};
	const action = (item: SwipeAction) => {
		const Icon = item.icon;
		return (
			<button
				className="omp-swipe-action text-sc-xs font-semibold"
				data-swipe-action={item.id}
				data-tone={item.tone ?? "neutral"}
				key={item.id}
				onClick={() => {
					setOffset(0);
					item.onSelect();
				}}
				type="button"
			>
				<Icon aria-hidden className="size-4" />
				{item.label}
			</button>
		);
	};
	return (
		<div className="omp-swipe" data-swipe-open={open || undefined}>
			<div className="omp-swipe-actions" inert={!open}>
				{leading ? action(leading) : <span />}
				<span className="flex">{trailing.map(action)}</span>
			</div>
			<div
				className={cx("omp-swipe-track", dragging && "omp-swipe-dragging")}
				ref={claimSwipe}
				onClickCapture={onClickCapture}
				onPointerCancel={onPointerEnd}
				onPointerDown={onPointerDown}
				onPointerUp={onPointerEnd}
				style={{ transform: offset === 0 ? undefined : `translateX(${offset}px)` }}
			>
				{children}
			</div>
		</div>
	);
}
