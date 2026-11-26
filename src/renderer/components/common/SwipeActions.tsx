/**
 * A row a touch swipe slides sideways to uncover its actions (Orca mobile/src/components/list/SwipeRowActions.tsx):
 * `trailing` behind a swipe to the left, `leading` behind one to the right. A swipe past half an action settles open,
 * tapping an uncovered action runs it and closes the row, and a tap on an open row closes it instead of pressing it.
 * Touch only: a mouse, a pen and the keyboard reach the same actions in the row's menu, so the actions are inert
 * while the row rests. A vertical drag scrolls the list (`touch-action: pan-y`).
 */
import type { LucideIcon } from "lucide-react";
import { type MouseEvent, type PointerEvent, type ReactNode, useRef, useState } from "react";
import { cx } from "../../lib/format";

/** The width one action uncovers. */
const ACTION_WIDTH = 76;
/** How far a touch travels before it counts as a swipe or a scroll. */
const SLOP_PX = 10;

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
	const drag = useRef<{ x: number; y: number; start: number; horizontal: boolean | null } | null>(null);
	// A swipe's release may still click the row: that click belongs to the swipe.
	const swiped = useRef(false);
	if (!leading && trailing.length === 0) return <>{children}</>;
	const maxRight = leading ? ACTION_WIDTH : 0;
	const maxLeft = -ACTION_WIDTH * trailing.length;
	const open = offset !== 0;

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		swiped.current = false;
		if (event.pointerType !== "touch") return;
		drag.current = { x: event.clientX, y: event.clientY, start: offset, horizontal: null };
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const current = drag.current;
		if (!current) return;
		const dx = event.clientX - current.x;
		const dy = event.clientY - current.y;
		if (current.horizontal === null) {
			if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return;
			current.horizontal = Math.abs(dx) > Math.abs(dy);
			if (!current.horizontal) {
				drag.current = null;
				return;
			}
			event.currentTarget.setPointerCapture?.(event.pointerId);
			setDragging(true);
		}
		swiped.current = true;
		setOffset(Math.min(maxRight, Math.max(maxLeft, current.start + dx)));
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
				onClickCapture={onClickCapture}
				onPointerCancel={onPointerEnd}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerEnd}
				style={{ transform: offset === 0 ? undefined : `translateX(${offset}px)` }}
			>
				{children}
			</div>
		</div>
	);
}
