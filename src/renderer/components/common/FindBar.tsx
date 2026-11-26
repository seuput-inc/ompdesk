/**
 * The one find bar (the conversation's ⌘F, a terminal's, the Preview page's): the field with the match count at its
 * end (`data-find-status`, announced politely), previous, next and close. Enter steps to the next match, Shift+Enter
 * to the previous, Escape closes (and stops there, so the surface under it keeps its own Escape); a composing IME key
 * does nothing. The owner keeps the query and the search: it says the count in words and whether there is anything
 * to step to. `tools` go between the field and the steps (a terminal's case and regex toggles). Where the bar sits
 * (floating over a transcript, a row above a page) is the owner's `className`; DOM attributes reach the root.
 */
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { HTMLAttributes, ReactNode, Ref } from "react";
import { isImeKeyEvent } from "../../lib/ime";
import { IconButton } from "./IconButton";
import { Input } from "./Input";

export interface FindBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
	/** The field's name, also its placeholder. */
	label: string;
	query: string;
	onQuery: (query: string) => void;
	/** "3/12", "No matches", or "" with no query. */
	status: string;
	/** Whether there is a match to step to. */
	canStep: boolean;
	onStep: (direction: 1 | -1) => void;
	onClose: () => void;
	previousLabel: string;
	nextLabel: string;
	closeLabel: string;
	inputRef?: Ref<HTMLInputElement>;
	autoFocus?: boolean;
	tools?: ReactNode;
	ref?: Ref<HTMLDivElement>;
}

export function FindBar({
	label,
	query,
	onQuery,
	status,
	canStep,
	onStep,
	onClose,
	previousLabel,
	nextLabel,
	closeLabel,
	inputRef,
	autoFocus,
	tools,
	...attrs
}: FindBarProps) {
	return (
		<div role="search" {...attrs}>
			<div className="min-w-0 flex-1">
				<Input
					aria-label={label}
					autoFocus={autoFocus}
					controlSize="sm"
					leadingIcon={<Search />}
					onChange={event => onQuery(event.target.value)}
					onKeyDown={event => {
						if (isImeKeyEvent(event)) return;
						if (event.key === "Enter") {
							event.preventDefault();
							if (canStep) onStep(event.shiftKey ? -1 : 1);
						} else if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
							onClose();
						}
					}}
					placeholder={label}
					ref={inputRef}
					trailing={
						<span
							aria-live="polite"
							className="text-sc-xs whitespace-nowrap text-(--sc-text-muted) tabular-nums"
							data-find-status
						>
							{status}
						</span>
					}
					value={query}
				/>
			</div>
			{tools}
			<IconButton
				disabled={!canStep}
				icon={<ChevronUp />}
				label={previousLabel}
				onClick={() => onStep(-1)}
				shortcut="⇧↵"
				size="sm"
				variant="ghost"
			/>
			<IconButton
				disabled={!canStep}
				icon={<ChevronDown />}
				label={nextLabel}
				onClick={() => onStep(1)}
				shortcut="↵"
				size="sm"
				variant="ghost"
			/>
			<IconButton icon={<X />} label={closeLabel} onClick={onClose} shortcut="Esc" size="sm" variant="ghost" />
		</div>
	);
}
