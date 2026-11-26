/**
 * A spotlight over one real control: dims the window around it (a hole whose own box-shadow is the scrim), follows
 * it every frame while it moves, and puts a card beside it. The hole lets the click reach the control; a click
 * anywhere else or Escape ends it (`onEnd`). A control that is not on screen (a collapsed sidebar, chat mode) gets a
 * centered card instead. Transitions stop under prefers-reduced-motion (global rule). The getting-started steps
 * (StarterTour) and the first-visit tours of a surface (SurfaceTour) both draw through it.
 */

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Room around the control inside the hole, and between the hole and the card. */
const PAD = 6;
const GAP = 12;
const CARD_WIDTH = 300;
const EDGE = 8;

interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** The first of `targets` on screen, padded; null when none is. */
export function measureTarget(targets: readonly string[]): Box | null {
	for (const selector of targets) {
		const node = document.querySelector(selector);
		if (!node) continue;
		const rect = node.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			return {
				left: rect.left - PAD,
				top: rect.top - PAD,
				width: rect.width + PAD * 2,
				height: rect.height + PAD * 2,
			};
		}
	}
	return null;
}

/**
 * The card goes right of a control in the left third (the sidebar), else
 * below it, else above it (anchored by its bottom, so its height never needs
 * measuring), always inside the window.
 */
function cardPlacement(hole: Box): { left: number; top?: number; bottom?: number } {
	const width = window.innerWidth;
	const height = window.innerHeight;
	const clampLeft = (left: number) => Math.min(Math.max(left, EDGE), width - CARD_WIDTH - EDGE);
	const right = hole.left + hole.width;
	if (hole.left < width / 3 && right + GAP + CARD_WIDTH <= width - EDGE) {
		return { left: right + GAP, top: Math.min(Math.max(hole.top, EDGE), height - 200) };
	}
	const below = hole.top + hole.height + GAP;
	if (below + 200 <= height) return { left: clampLeft(hole.left), top: below };
	return { left: clampLeft(hole.left), bottom: height - hole.top + GAP };
}

export function Spotlight({
	id,
	targets,
	title,
	body,
	footer,
	onEnd,
	cardAttrs,
}: {
	/** Names the card's title and body for assistive tech; unique per step. */
	id: string;
	targets: readonly string[];
	title: string;
	body: string;
	/** The card's buttons, end-aligned. */
	footer: ReactNode;
	onEnd: () => void;
	cardAttrs?: Record<`data-${string}`, string>;
}) {
	const [hole, setHole] = useState<Box | null>(null);
	const holeRef = useRef<Box | null>(null);
	const targetsKey = targets.join("\n");

	// Follow the control every frame: sidebars resize, panels slide, lists scroll.
	// biome-ignore lint/correctness/useExhaustiveDependencies: targetsKey is the targets' identity.
	useLayoutEffect(() => {
		const update = () => {
			const next = measureTarget(targets);
			const prev = holeRef.current;
			if (
				prev === next ||
				(prev !== null &&
					next !== null &&
					prev.left === next.left &&
					prev.top === next.top &&
					prev.width === next.width &&
					prev.height === next.height)
			)
				return;
			holeRef.current = next;
			setHole(next);
		};
		update();
		let frame = requestAnimationFrame(function track() {
			update();
			frame = requestAnimationFrame(track);
		});
		return () => {
			cancelAnimationFrame(frame);
			holeRef.current = null;
			setHole(null);
		};
	}, [targetsKey]);

	useEffect(() => {
		const previous = document.activeElement;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			onEnd();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, [onEnd]);

	const titleId = `spotlight-${id}-title`;
	const bodyId = `spotlight-${id}-body`;
	const placement = hole ? cardPlacement(hole) : null;
	// The shield takes every click but the hole's, which reaches the real control.
	const clip = hole
		? `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${hole.left}px ${hole.top}px, ${hole.left + hole.width}px ${hole.top}px, ${hole.left + hole.width}px ${hole.top + hole.height}px, ${hole.left}px ${hole.top + hole.height}px, ${hole.left}px ${hole.top}px)`
		: undefined;

	return createPortal(
		<div className="omp-starter-tour" data-starter-tour-root data-target-found={String(hole !== null)}>
			<div
				aria-hidden
				className="omp-starter-tour-shield"
				data-dimmed={String(hole === null)}
				data-tour-shield
				onClick={onEnd}
				style={clip ? { clipPath: clip } : undefined}
			/>
			{hole && (
				<div
					aria-hidden
					className="omp-starter-tour-hole"
					data-tour-hole={`${hole.left},${hole.top},${hole.width},${hole.height}`}
					style={{
						left: `${hole.left}px`,
						top: `${hole.top}px`,
						width: `${hole.width}px`,
						height: `${hole.height}px`,
					}}
				/>
			)}
			{/* controls-ok: a non-modal tour card beside a spotlight hole that lets clicks through to the app; Modal and Sheet trap focus and block the page */}
			<div
				aria-describedby={bodyId}
				aria-labelledby={titleId}
				className="omp-starter-tour-card"
				data-placement={placement ? "anchored" : "center"}
				data-starter-tour
				role="dialog"
				{...cardAttrs}
				style={
					placement
						? {
								left: `${placement.left}px`,
								...(placement.top === undefined ? {} : { top: `${placement.top}px` }),
								...(placement.bottom === undefined ? {} : { bottom: `${placement.bottom}px` }),
							}
						: undefined
				}
			>
				<h2 className="text-sc-md font-semibold text-(--sc-text)" id={titleId}>
					{title}
				</h2>
				<p className="mt-1 text-sc-sm break-keep text-(--sc-text-secondary)" id={bodyId}>
					{body}
				</p>
				<div className="mt-3 flex items-center justify-end gap-2">{footer}</div>
			</div>
		</div>,
		document.body,
	);
}
