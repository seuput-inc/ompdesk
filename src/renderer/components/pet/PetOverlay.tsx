/**
 * The desktop pet (Settings › Appearance & input › Desktop pet, off by default): a small figure over the window that
 * shows what this computer's sessions are doing, by `petState` (waiting on the person > working > a turn that just
 * finished > idle) over this computer's session summaries and the summaries of this window's tabs on a paired computer.
 * Desktop windows only (this computer's window, a paired computer's view), never a phone page, never during first-run
 * setup. Decorative: `role="img"` named by its state; only the 64 px figure takes the pointer. It drags anywhere inside
 * the window (kept in prefs, clamped on resize), and its context menu hides it or swaps the sprite (a PNG, GIF or WebP
 * picture, or a strip of square frames). Motion lives in `styles/pet.css`; under reduced motion nothing moves (an
 * animated custom picture is drawn still).
 *
 * Ported from Orca (stablyai/orca 02cecc98, src/renderer/src/components/pet/):
 * - PetOverlay.tsx:283-399: the fixed overlay with pointer events on the figure alone, its resize clamp (324-328), the
 *   bob paused while dragging and under reduced motion (339-342), the plain picture fallback (386-393).
 * - usePetPointerInteraction.ts:39-91: one primary pointer, captured, offset kept from the press, released on up,
 *   cancel or lost capture.
 * - pet-agent-state.ts:37-66 and sprite-animation-css.ts:44-49: see pet-rules.ts.
 * - pet-overlay-visibility.ts:1-11: no flash before the stored choice is read (off until the pref says on).
 * Left out: Orca's bundled character art (a built-in figure drawn from theme tokens instead), its manifest bundles,
 * frame detection and per-state sprite rows, and its pet size setting.
 */
import "../../styles/pet.css";
import { type CSSProperties, type PointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useMediaQuery } from "../../hooks/use-media-query";
import { useT } from "../../lib/i18n";
import { sessionRun } from "../../lib/session-run";
import { summariesOf, tabSummary, useHostedSessionsStore } from "../../stores/hosted-sessions";
import { useTabsStore } from "../../stores/tabs";
import { webRuntime } from "../../web/runtime";
import { anchorFromEvent, ContextMenu, type ContextMenuAnchor } from "../common";
import { useFirstRunActive } from "../onboarding/FirstRunSlot";
import {
	followPetPrefs,
	importPetSprite,
	resetPetSprite,
	setPetEnabled,
	setPetPosition,
	usePetPrefs,
} from "./pet-prefs";
import {
	clampPetPosition,
	finishedTurn,
	PET_DEFAULT_POSITION,
	PET_DONE_MS,
	PET_SIZE,
	type PetPosition,
	type PetRun,
	type PetState,
	petState,
	spriteFrames,
} from "./pet-rules";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export function PetOverlay() {
	const enabled = usePetPrefs(state => state.enabled);
	const firstRun = useFirstRunActive();
	useEffect(() => followPetPrefs(), []);
	if (!enabled || firstRun || webRuntime() !== null) return null;
	return <Pet />;
}

/** A hidden file field and the call that opens it; a picked file becomes the sprite or a toast says why not. */
export function useSpritePicker(): { input: ReactNode; open: () => void } {
	const ref = useRef<HTMLInputElement>(null);
	return {
		open: () => ref.current?.click(),
		input: (
			<input
				accept="image/png,image/gif,image/webp"
				className="hidden"
				onChange={event => {
					const file = event.target.files?.[0];
					event.target.value = "";
					if (file) void importPetSprite(file);
				}}
				ref={ref}
				tabIndex={-1}
				type="file"
			/>
		),
	};
}

function usePetState(): PetState {
	const tabs = useTabsStore(state => state.tabs);
	const summaries = useHostedSessionsStore(state => state.summaries);
	const runs = useMemo(() => {
		const local = summariesOf({ summaries }, undefined).map(summary => ({ id: summary.sessionPath, summary }));
		const remote = tabs
			.filter(tab => tab.device)
			.map(tab => ({ id: `${tab.device}\n${tab.id}`, summary: tabSummary({ summaries }, tab) }));
		return [...local, ...remote].map(({ id, summary }): PetRun => {
			const run = sessionRun(summary);
			return { id, waiting: run.waiting, running: run.running };
		});
	}, [tabs, summaries]);
	const [justFinished, setJustFinished] = useState(false);
	const wasRunning = useRef<ReadonlySet<string>>(new Set());
	const doneTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(doneTimer.current), []);
	useEffect(() => {
		const finished = finishedTurn(wasRunning.current, runs);
		wasRunning.current = new Set(runs.filter(run => run.running).map(run => run.id));
		if (!finished) return;
		setJustFinished(true);
		clearTimeout(doneTimer.current);
		doneTimer.current = setTimeout(() => setJustFinished(false), PET_DONE_MS);
	}, [runs]);
	return petState(runs, justFinished);
}

function useViewport(): { width: number; height: number } {
	const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
	useEffect(() => {
		const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);
	return viewport;
}

interface DragStart {
	pointer: number;
	x: number;
	y: number;
	from: PetPosition;
}

function Pet() {
	const t = useT();
	const sprite = usePetPrefs(state => state.sprite);
	const saved = usePetPrefs(state => state.position);
	const state = usePetState();
	const viewport = useViewport();
	const [dragged, setDragged] = useState<PetPosition | null>(null);
	const draggedRef = useRef<PetPosition | null>(null);
	const start = useRef<DragStart | null>(null);
	const [menu, setMenu] = useState<ContextMenuAnchor>();
	const picker = useSpritePicker();
	const position = clampPetPosition(dragged ?? saved ?? PET_DEFAULT_POSITION, viewport);

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 || start.current) return;
		start.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, from: position };
		event.currentTarget.setPointerCapture(event.pointerId);
		event.preventDefault();
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const from = start.current;
		if (!from || event.pointerId !== from.pointer) return;
		const next = clampPetPosition(
			{ right: from.from.right - (event.clientX - from.x), bottom: from.from.bottom - (event.clientY - from.y) },
			viewport,
		);
		draggedRef.current = next;
		setDragged(next);
	};
	const endDrag = (event: PointerEvent<HTMLDivElement>) => {
		if (event.pointerId !== start.current?.pointer) return;
		start.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId))
			event.currentTarget.releasePointerCapture(event.pointerId);
		if (draggedRef.current) void setPetPosition(draggedRef.current);
		draggedRef.current = null;
		setDragged(null);
	};

	return (
		<>
			<div
				aria-label={t(`pet.state.${state}`)}
				className="omp-pet no-drag fixed z-40 size-16 cursor-grab touch-none select-none data-dragging:cursor-grabbing"
				data-dragging={dragged ? "" : undefined}
				data-pet-state={state}
				onContextMenu={event => setMenu(anchorFromEvent(event))}
				onLostPointerCapture={endDrag}
				onPointerCancel={endDrag}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={endDrag}
				role="img"
				style={{ right: position.right, bottom: position.bottom }}
			>
				<div className="omp-pet-figure size-full">
					{sprite ? <SpriteFigure url={sprite} /> : <BuiltInFigure state={state} />}
				</div>
				<StateMark state={state} />
			</div>
			{menu && (
				<ContextMenu
					ariaLabel={t("pet.menu")}
					items={[
						{ id: "sprite", label: t("pet.chooseSprite"), onSelect: picker.open },
						{
							id: "default",
							label: t("pet.useDefaultSprite"),
							disabled: !sprite,
							onSelect: () => void resetPetSprite(),
						},
						{
							id: "hide",
							label: t("pet.hide"),
							separatorBefore: true,
							onSelect: () => void setPetEnabled(false),
						},
					]}
					onClose={() => setMenu(undefined)}
					x={menu.x}
					y={menu.y}
				/>
			)}
			{picker.input}
		</>
	);
}

/** Waiting asks for the person; a finished turn shows a check. Words are the figure's aria-label. */
function StateMark({ state }: { state: PetState }) {
	if (state !== "waiting" && state !== "done") return null;
	const waiting = state === "waiting";
	return (
		<span
			aria-hidden
			className={
				waiting
					? "absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-(--sc-warning-soft) font-semibold text-(--sc-warning-on-soft) text-sc-xs"
					: "absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-(--sc-success-soft) font-semibold text-(--sc-success-on-soft) text-sc-xs"
			}
		>
			{waiting ? "!" : "✓"}
		</span>
	);
}

/** The built-in pet, drawn from theme tokens: one face per state. */
function BuiltInFigure({ state }: { state: PetState }) {
	const face = "fill-none stroke-(--sc-accent-fg) [stroke-linecap:round] [stroke-width:2.5]";
	return (
		<svg aria-hidden className="size-full" viewBox="0 0 64 64">
			<path className="fill-(--sc-accent)" d="M17 25 21 9l9 9zM47 25 43 9l-9 9z" />
			<path
				className="fill-(--sc-accent)"
				d="M10 42c0-14 10-24 22-24s22 10 22 24v8a8 8 0 0 1-8 8H18a8 8 0 0 1-8-8z"
			/>
			{state === "idle" && <path className={face} d="M21 38q3 2 6 0M37 38q3 2 6 0M29 47h6" />}
			{state === "working" && (
				<>
					<circle className="fill-(--sc-accent-fg)" cx="24" cy="38" r="3" />
					<circle className="fill-(--sc-accent-fg)" cx="40" cy="38" r="3" />
					<path className={face} d="M20 31l7 2M44 31l-7 2M29 47h6" />
				</>
			)}
			{state === "waiting" && (
				<>
					<circle className="fill-(--sc-accent-fg)" cx="24" cy="37" r="4" />
					<circle className="fill-(--sc-accent-fg)" cx="40" cy="37" r="4" />
					<circle className={face} cx="32" cy="48" r="2" />
				</>
			)}
			{state === "done" && <path className={face} d="M21 39q3-5 6 0M37 39q3-5 6 0M27 45q5 4 10 0" />}
		</svg>
	);
}

/** A custom sprite: a strip of square frames steps through them, any other picture shows whole; still under reduced motion. */
function SpriteFigure({ url }: { url: string }) {
	const reducedMotion = useMediaQuery(REDUCED_MOTION);
	const [frames, setFrames] = useState(1);
	if (reducedMotion) return <StillSprite url={url} />;
	return (
		<div className="size-full overflow-hidden">
			<img
				alt=""
				className={frames > 1 ? "omp-pet-strip block h-full max-w-none" : "size-full object-contain"}
				draggable={false}
				onLoad={event =>
					setFrames(spriteFrames(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight))
				}
				src={url}
				style={frames > 1 ? ({ width: `${frames * 100}%`, "--pet-frames": frames } as CSSProperties) : undefined}
			/>
		</div>
	);
}

/** The first frame drawn on a canvas, so an animated GIF or WebP holds still too. */
function StillSprite({ url }: { url: string }) {
	const ref = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const image = new Image();
		image.onload = () => {
			const context = ref.current?.getContext("2d");
			if (!context) return;
			const { naturalWidth: width, naturalHeight: height } = image;
			const frameWidth = spriteFrames(width, height) > 1 ? height : width;
			const scale = Math.min((PET_SIZE * 2) / frameWidth, (PET_SIZE * 2) / height);
			const [w, h] = [frameWidth * scale, height * scale];
			context.clearRect(0, 0, PET_SIZE * 2, PET_SIZE * 2);
			context.drawImage(image, 0, 0, frameWidth, height, (PET_SIZE * 2 - w) / 2, (PET_SIZE * 2 - h) / 2, w, h);
		};
		image.src = url;
		return () => {
			image.onload = null;
		};
	}, [url]);
	return <canvas className="size-full" height={PET_SIZE * 2} ref={ref} width={PET_SIZE * 2} />;
}
