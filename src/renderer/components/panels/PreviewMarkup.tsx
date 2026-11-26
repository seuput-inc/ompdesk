/**
 * A pen over a region screenshot before it goes to the composer (Orca's screenshot markup,
 * `browser-pane/annotate/drawing/**`; only its pen, in its default red and width). The strokes are drawn into the
 * picture itself, so the agent reads them as part of the image.
 */
import { Eraser, Undo2 } from "lucide-react";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { Button, Modal } from "../common";

/** The pen's colour is part of the exported PNG, so it is no theme token (Orca's `DEFAULT_MARKUP_COLOR`). */
const PEN_COLOR = "#ef4444";

type Stroke = [number, number][];

/** Paints `image` and `strokes` (image pixels) on `canvas`, at the image's own size. */
export function paintMarkup(canvas: HTMLCanvasElement, image: HTMLImageElement, strokes: readonly Stroke[]): void {
	const context = canvas.getContext("2d");
	if (!context) return;
	context.drawImage(image, 0, 0);
	context.strokeStyle = PEN_COLOR;
	context.lineCap = "round";
	context.lineJoin = "round";
	// Orca's 4 px pen on a page; a screenshot taken at 2x keeps the same look.
	context.lineWidth = Math.max(4, Math.round(Math.max(image.naturalWidth, image.naturalHeight) / 250));
	for (const stroke of strokes) {
		const [first, ...rest] = stroke;
		if (!first) continue;
		context.beginPath();
		context.moveTo(...first);
		// A tap leaves a dot.
		if (rest.length === 0) context.lineTo(first[0] + 0.01, first[1]);
		for (const point of rest) context.lineTo(...point);
		context.stroke();
	}
}

/** Draw on `image` (PNG base64); Save hands back the drawn picture, PNG base64. */
export function PreviewMarkupDialog({
	image,
	n,
	onSave,
	onClose,
}: {
	image: string | null;
	n: number;
	onSave: (image: string) => void;
	onClose: () => void;
}) {
	const t = useT();
	const canvas = useRef<HTMLCanvasElement | null>(null);
	const [picture, setPicture] = useState<HTMLImageElement | null>(null);
	const [strokes, setStrokes] = useState<Stroke[]>([]);
	const drawing = useRef(false);
	useEffect(() => {
		setStrokes([]);
		setPicture(null);
		if (!image) return;
		const next = new Image();
		let live = true;
		next.onload = () => live && setPicture(next);
		next.src = `data:image/png;base64,${image}`;
		return () => {
			live = false;
		};
	}, [image]);
	useEffect(() => {
		const target = canvas.current;
		if (!target || !picture) return;
		if (target.width !== picture.naturalWidth) target.width = picture.naturalWidth;
		if (target.height !== picture.naturalHeight) target.height = picture.naturalHeight;
		paintMarkup(target, picture, strokes);
	}, [picture, strokes]);
	const at = (event: PointerEvent<HTMLCanvasElement>): [number, number] => {
		const box = event.currentTarget.getBoundingClientRect();
		const scale = event.currentTarget.width / (box.width || 1);
		return [(event.clientX - box.left) * scale, (event.clientY - box.top) * scale];
	};
	return (
		<Modal
			open={image !== null}
			onClose={onClose}
			title={t("panel.preview.feedback.drawTitle", { n })}
			size="lg"
			footer={
				<>
					<Button
						size="sm"
						variant="ghost"
						icon={<Undo2 />}
						disabled={strokes.length === 0}
						onClick={() => setStrokes(current => current.slice(0, -1))}
					>
						{t("panel.preview.feedback.drawUndo")}
					</Button>
					<Button
						size="sm"
						variant="ghost"
						icon={<Eraser />}
						disabled={strokes.length === 0}
						onClick={() => setStrokes([])}
					>
						{t("panel.preview.feedback.drawClear")}
					</Button>
					<span className="flex-1" />
					<Button size="sm" variant="secondary" onClick={onClose}>
						{t("common.cancel")}
					</Button>
					<Button
						size="sm"
						variant="primary"
						disabled={!picture}
						onClick={() => {
							const data = canvas.current?.toDataURL("image/png");
							if (data) onSave(data.slice(data.indexOf(",") + 1));
							onClose();
						}}
					>
						{t("common.save")}
					</Button>
				</>
			}
		>
			<p className="pb-2 text-sc-xs text-(--sc-text-muted)">{t("panel.preview.feedback.drawHint")}</p>
			<canvas
				aria-label={t("panel.preview.feedback.regionImage", { n })}
				className="mx-auto block h-auto max-w-full cursor-crosshair touch-none rounded-(--sc-radius-sm) border border-(--sc-border)"
				data-preview-markup
				ref={canvas}
				role="img"
				onPointerDown={event => {
					event.currentTarget.setPointerCapture(event.pointerId);
					drawing.current = true;
					// The point is read now: the event's target is gone by the time React runs the update.
					const point = at(event);
					setStrokes(current => [...current, [point]]);
				}}
				onPointerMove={event => {
					if (!drawing.current) return;
					const point = at(event);
					setStrokes(current => {
						const last = current.at(-1);
						return last ? [...current.slice(0, -1), [...last, point]] : current;
					});
				}}
				onPointerUp={() => {
					drawing.current = false;
				}}
				onPointerCancel={() => {
					drawing.current = false;
				}}
			/>
		</Modal>
	);
}
