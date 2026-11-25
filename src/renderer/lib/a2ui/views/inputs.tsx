/**
 * A2UI's inputs on the kit. Each writes to the surface's data model through its binding; nothing reaches the agent
 * until a Button's action fires, and only while the card answers (`A2uiViewContext.inert` off). A failed check
 * disables the Button with its first message as the reason, and shows under a field once the person edited it.
 */

import { useContext, useId, useState } from "react";
import { Button, Checkbox, Chip, FieldShell, Input, Radio, Select, Slider, TextArea } from "../../../components/common";
import { useT } from "../../i18n";
import { NodeView } from "./NodeView";
import { A2uiViewContext, checkErrors, isNode, read, readText, type ViewProps, writer } from "./props";

/** Past this many options a single choice is a Select instead of a radio group (§2 table). */
const RADIO_MAX = 15;

export function ButtonView({ node, props, inline }: ViewProps & { inline?: boolean }) {
	const t = useT();
	const { inert, primaryId } = useContext(A2uiViewContext);
	const label = isNode(props.child) ? <NodeView inline node={props.child} /> : null;
	if (inline) return label;
	const errors = checkErrors(props);
	const action = typeof props.action === "function" ? (props.action as () => unknown) : undefined;
	const variant =
		props.variant === "primary" && node.componentId === primaryId
			? "primary"
			: props.variant === "borderless"
				? "ghost"
				: "secondary";
	const reason = inert ? t("a2ui.notWaiting") : errors[0];
	return (
		<Button
			className="self-start"
			disabled={inert || errors.length > 0 || !action}
			disabledReason={reason}
			onClick={() => void Promise.resolve(action?.()).catch(() => undefined)}
			variant={variant}
		>
			{label}
		</Button>
	);
}

/** The first check's message once the person changed the field; a fresh form shows none. */
function useShownError(props: Record<string, unknown>): [string | undefined, () => void] {
	const [touched, setTouched] = useState(false);
	return [touched ? checkErrors(props)[0] : undefined, () => setTouched(true)];
}

export function TextFieldView({ props }: ViewProps) {
	const { inert } = useContext(A2uiViewContext);
	const [error, touch] = useShownError(props);
	const set = writer<string | number>(props.value);
	const value = readText(props.value);
	const common = {
		disabled: inert || !set,
		error,
		label: readText(props.label),
		placeholder: readText(props.placeholder) || undefined,
		value,
	};
	if (props.variant === "longText") {
		return (
			<TextArea
				{...common}
				onChange={event => {
					touch();
					set?.(event.target.value);
				}}
			/>
		);
	}
	const number = props.variant === "number";
	return (
		<Input
			{...common}
			inputMode={number ? "decimal" : undefined}
			onChange={event => {
				touch();
				const next = event.target.value;
				set?.(number && next !== "" && Number.isFinite(Number(next)) ? Number(next) : next);
			}}
			type={number ? "number" : "text"}
		/>
	);
}

export function CheckBoxView({ props }: ViewProps) {
	const { inert } = useContext(A2uiViewContext);
	const set = writer<boolean>(props.value);
	return (
		<label className="flex items-center gap-2 text-sc-md">
			<Checkbox
				checked={read(props.value) === true}
				disabled={inert || !set}
				onChange={event => set?.(event.target.checked)}
			/>
			{readText(props.label)}
		</label>
	);
}

export function DateTimeInputView({ props }: ViewProps) {
	const { inert } = useContext(A2uiViewContext);
	const set = writer<string>(props.value);
	const date = props.enableDate !== false;
	const time = props.enableTime === true;
	const bound = (value: unknown) => {
		const resolved = read(value);
		return typeof resolved === "string" ? resolved : undefined;
	};
	return (
		<Input
			disabled={inert || !set}
			label={readText(props.label) || undefined}
			max={bound(props.max)}
			min={bound(props.min)}
			onChange={event => set?.(event.target.value)}
			type={date && time ? "datetime-local" : time ? "time" : "date"}
			value={readText(props.value)}
		/>
	);
}

export function SliderView({ props }: ViewProps) {
	const { inert } = useContext(A2uiViewContext);
	const set = writer<number>(props.value);
	const min = typeof props.min === "number" ? props.min : 0;
	const max = typeof props.max === "number" ? props.max : 100;
	const steps = typeof props.steps === "number" && props.steps > 0 ? props.steps : undefined;
	const value = Number(read(props.value));
	return (
		<Slider
			disabled={inert || !set}
			label={readText(props.label)}
			max={max}
			min={min}
			onChange={next => set?.(next)}
			step={steps ? (max - min) / steps : undefined}
			value={Number.isFinite(value) ? value : min}
		/>
	);
}

interface Option {
	label: string;
	value: string;
}

export function ChoicePickerView({ props }: ViewProps) {
	const { inert } = useContext(A2uiViewContext);
	const groupId = useId();
	const set = writer<string[]>(props.value);
	const current = read(props.value);
	const selected = Array.isArray(current) ? current.filter(v => typeof v === "string") : [];
	const options: Option[] = (Array.isArray(props.options) ? props.options : []).flatMap(option =>
		typeof option === "object" && option !== null && typeof option.value === "string"
			? [{ label: readText(option.label) || option.value, value: option.value }]
			: [],
	);
	const single = props.variant === "mutuallyExclusive";
	const disabled = inert || !set;
	const label = readText(props.label);
	const toggle = (value: string, on: boolean) =>
		set?.(single ? [value] : on ? [...selected, value] : selected.filter(v => v !== value));
	if (single && props.displayStyle !== "chips" && options.length > RADIO_MAX) {
		return (
			<Select
				disabled={disabled}
				label={label || undefined}
				onChange={event => toggle(event.target.value, true)}
				options={options}
				value={selected[0] ?? ""}
			/>
		);
	}
	return (
		<FieldShell label={label || undefined} labelId={`${groupId}-label`} noteId={`${groupId}-note`}>
			<div
				aria-labelledby={label ? `${groupId}-label` : undefined}
				className={props.displayStyle === "chips" ? "flex flex-wrap gap-2" : "flex flex-col gap-1.5"}
				role={single ? "radiogroup" : "group"}
			>
				{options.map(option => {
					const on = selected.includes(option.value);
					if (props.displayStyle === "chips") {
						return (
							<Chip
								disabled={disabled}
								key={option.value}
								onPressedChange={pressed => toggle(option.value, pressed)}
								pressed={on}
							>
								{option.label}
							</Chip>
						);
					}
					const Control = single ? Radio : Checkbox;
					return (
						<label className="flex items-center gap-2 text-sc-md" key={option.value}>
							<Control
								checked={on}
								disabled={disabled}
								name={single ? groupId : undefined}
								onChange={event => toggle(option.value, event.target.checked)}
							/>
							{option.label}
						</label>
					);
				})}
			</div>
		</FieldShell>
	);
}
