/**
 * Slider — a number picked along a range (a volume, a size, a count), applied as it moves.
 *
 * The native `<input type="range">`, drawn by the system in the accent colour as `Checkbox` is, so the arrow keys,
 * Home/End, Page Up/Down and the screen reader's slider role, min, max and value are the browser's own. Every slider
 * has a visible `label` (it names the input through `<label htmlFor>`) and shows its current value beside it, written
 * in the app's language (`uiLocale`), never the OS's. `step` is the native step: a caller with N discrete steps passes
 * `(max - min) / N`. On touch the input's box reaches `--sc-touch-target` (mobile.css); its track and thumb stay drawn
 * at their size.
 */

import { useId } from "react";
import { cx, uiLocale } from "../../lib/format";
import { FieldLabel } from "./Input";

export interface SliderProps {
	label: string;
	value: number;
	onChange: (value: number) => void;
	min?: number;
	max: number;
	step?: number;
	disabled?: boolean;
	id?: string;
	className?: string;
}

export function Slider({ label, value, onChange, min = 0, max, step, disabled, id, className }: SliderProps) {
	const autoId = useId();
	const controlId = id ?? autoId;
	return (
		<div className={cx(disabled && "opacity-50", className)} data-slider>
			<div className="flex items-baseline justify-between gap-2">
				<FieldLabel htmlFor={controlId}>{label}</FieldLabel>
				{/* The slider announces its own value; this is the sighted reading of it. */}
				<span aria-hidden className="text-sc-sm text-(--sc-text-muted) tabular-nums">
					{value.toLocaleString(uiLocale())}
				</span>
			</div>
			<input
				className="block w-full cursor-pointer accent-(--sc-accent) disabled:cursor-not-allowed"
				disabled={disabled}
				id={controlId}
				max={max}
				min={min}
				onChange={event => onChange(Number(event.target.value))}
				step={step}
				type="range"
				value={value}
			/>
		</div>
	);
}
