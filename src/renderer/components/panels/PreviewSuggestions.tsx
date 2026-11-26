/**
 * Address suggestions under the Preview's address field (Orca's `address-bar/BrowserAddressBarSuggestionList.tsx`):
 * while the person types, this computer's visited sites that match (core `browsing.rs`, a host whose name starts with
 * the text first). ↑/↓ move through them, Enter opens the one moved to, Escape closes the list; the field stays the
 * focus (a combobox over a listbox, `aria-activedescendant`). A row in the panel's flow between the toolbar and the
 * page, never over the page, which the host draws above the window's own content.
 */
import { History } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { PreviewHistoryEntry } from "../../../shared/preview";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { OptionRow } from "../common";

/** Suggestions shown at once. */
const SUGGESTIONS = 6;
/** How long typing rests before the history is asked. */
const ASK_AFTER_MS = 80;

export interface AddressSuggestions {
	entries: PreviewHistoryEntry[];
	active: number;
	listId: string;
	/** The field's combobox attributes. */
	fieldProps: {
		role: "combobox";
		"aria-expanded": boolean;
		"aria-controls": string;
		"aria-autocomplete": "list";
		"aria-activedescendant"?: string;
	};
	/** Handles ↑/↓/Escape and, on Enter with a row moved to, opens it (true: the key was taken). */
	onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => boolean;
	close: () => void;
	setActive: (index: number) => void;
}

/** Suggestions for what the field holds while it is being typed into (`typing`); none once closed or opened. */
export function useAddressSuggestions(text: string, typing: boolean, open: (url: string) => void): AddressSuggestions {
	const [entries, setEntries] = useState<PreviewHistoryEntry[]>([]);
	const [active, setActive] = useState(-1);
	const listId = useId();
	const asked = useRef(0);
	useEffect(() => {
		const ask = ++asked.current;
		if (!typing || !text.trim()) {
			setEntries([]);
			setActive(-1);
			return;
		}
		const timer = setTimeout(() => {
			window.omp.preview.history({ action: "list", query: text, limit: SUGGESTIONS }).then(
				found => {
					if (ask !== asked.current) return;
					setEntries(found);
					setActive(-1);
				},
				() => undefined,
			);
		}, ASK_AFTER_MS);
		return () => clearTimeout(timer);
	}, [text, typing]);
	const close = () => {
		asked.current += 1;
		setEntries([]);
		setActive(-1);
	};
	const shown = entries.length > 0;
	return {
		entries,
		active,
		listId,
		fieldProps: {
			role: "combobox",
			"aria-expanded": shown,
			"aria-controls": listId,
			"aria-autocomplete": "list",
			...(shown && active >= 0 ? { "aria-activedescendant": `${listId}-${active}` } : {}),
		},
		onKeyDown: event => {
			if (!shown || isImeKeyEvent(event.nativeEvent)) return false;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				// -1 is the typed text itself: the moves wrap through it.
				setActive(index => {
					const next = index + step;
					return next < -1 ? entries.length - 1 : next >= entries.length ? -1 : next;
				});
				return true;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				close();
				return true;
			}
			if (event.key === "Enter" && active >= 0) {
				event.preventDefault();
				const entry = entries[active];
				close();
				if (entry) open(entry.url);
				return true;
			}
			return false;
		},
		close,
		setActive,
	};
}

export function PreviewSuggestions({
	suggestions,
	onOpen,
}: {
	suggestions: AddressSuggestions;
	onOpen: (url: string) => void;
}) {
	const t = useT();
	const { entries, active, listId } = suggestions;
	if (entries.length === 0) return null;
	return (
		<div
			aria-label={t("panel.preview.suggestions")}
			className="shrink-0 border-b border-(--sc-divider) p-1"
			data-preview-suggestions
			id={listId}
			role="listbox"
		>
			{entries.map((entry, index) => (
				<OptionRow
					active={index === active}
					id={`${listId}-${index}`}
					key={entry.url}
					onClick={() => {
						suggestions.close();
						onOpen(entry.url);
					}}
					// The field keeps the focus: a press on a row must not blur it before the click lands.
					onMouseDown={event => event.preventDefault()}
					onMouseEnter={() => suggestions.setActive(index)}
					pointerMoves
					size="sm"
				>
					<History aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
					<span className="min-w-0 flex-1 truncate text-sc-sm text-(--sc-text)">{entry.title || entry.url}</span>
					<span className="min-w-0 max-w-[50%] shrink truncate text-sc-xs text-(--sc-text-muted)">
						{entry.url}
					</span>
				</OptionRow>
			))}
		</div>
	);
}
