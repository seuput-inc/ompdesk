import type { ISearchOptions } from "@xterm/addon-search";
import { CaseSensitive, ChevronDown, ChevronUp, Regex, X } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { IconButton, Input, PopoverSurface } from "../common";

/** What the find bar needs of xterm's search addon (`@xterm/addon-search`). */
export interface TerminalSearch {
	findNext(term: string, options?: ISearchOptions): boolean;
	findPrevious(term: string, options?: ISearchOptions): boolean;
	clearDecorations(): void;
	onDidChangeResults(listener: (results: { resultIndex: number; resultCount: number }) => void): {
		dispose(): void;
	};
}

// xterm draws decorations from hex colours only; these stay readable over every theme (Orca #612).
const DECORATIONS = {
	matchBackground: "#5c4a00",
	matchBorder: "#5c4a00",
	matchOverviewRuler: "#ffcc00",
	activeMatchBackground: "#c4580e",
	activeMatchBorder: "#ffcf6b",
	activeMatchColorOverviewRuler: "#ff9900",
};

/**
 * A narrow or unreflowed screen can make a decoration's width negative: the search itself ran, so only that error is
 * dropped (Orca `terminal-search-safe-find.ts`).
 */
function safeFind(find: () => boolean): void {
	try {
		find();
	} catch (error) {
		if (!(error instanceof Error && /only accepts positive integers/i.test(error.message))) throw error;
	}
}

/**
 * Find in the terminal's scrollback (Orca `terminal-pane/search/TerminalSearch.tsx`): as typed, case and regex
 * toggles, the match count, Enter next, Shift+Enter previous, Escape closes and gives the shell its focus back.
 */
export function TerminalFind({ search, onClose }: { search: TerminalSearch; onClose: () => void }) {
	const t = useT();
	const [query, setQuery] = useState("");
	const [caseSensitive, setCaseSensitive] = useState(false);
	const [regex, setRegex] = useState(false);
	const [results, setResults] = useState({ resultIndex: -1, resultCount: 0 });
	const options = useCallback(
		(incremental: boolean): ISearchOptions => ({ caseSensitive, regex, incremental, decorations: DECORATIONS }),
		[caseSensitive, regex],
	);
	useEffect(() => {
		const subscription = search.onDidChangeResults(setResults);
		return () => {
			subscription.dispose();
			search.clearDecorations();
		};
	}, [search]);
	useEffect(() => {
		if (!query) {
			search.clearDecorations();
			setResults({ resultIndex: -1, resultCount: 0 });
			return;
		}
		safeFind(() => search.findNext(query, options(true)));
	}, [query, search, options]);
	const next = () => query && safeFind(() => search.findNext(query, options(false)));
	const previous = () => query && safeFind(() => search.findPrevious(query, options(false)));
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (isImeKeyEvent(event.nativeEvent)) return;
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onClose();
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (event.shiftKey) previous();
			else next();
		}
	};
	// xterm reports -1 once the matches pass its highlight limit.
	const status = !query
		? ""
		: results.resultCount === 0
			? t("panel.terminal.find.none")
			: results.resultIndex === -1
				? `${results.resultCount}+`
				: `${results.resultIndex + 1}/${results.resultCount}`;
	return (
		<div className="absolute top-2 right-3 z-10" data-terminal-find>
			<PopoverSurface className="flex w-80 max-w-[calc(100%-1rem)] items-center gap-1 p-1.5">
				<Input
					aria-label={t("panel.terminal.find.label")}
					autoFocus
					className="min-w-0 flex-1"
					controlSize="sm"
					onChange={event => setQuery(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder={t("panel.terminal.find.placeholder")}
					value={query}
				/>
				<IconButton
					icon={<CaseSensitive />}
					label={t("panel.terminal.find.case")}
					onClick={() => setCaseSensitive(on => !on)}
					pressed={caseSensitive}
					size="sm"
				/>
				<IconButton
					icon={<Regex />}
					label={t("panel.terminal.find.regex")}
					onClick={() => setRegex(on => !on)}
					pressed={regex}
					size="sm"
				/>
				<span
					aria-live="polite"
					className="min-w-10 shrink-0 text-center text-sc-xs text-(--sc-text-muted) tabular-nums"
					data-terminal-find-status
				>
					{status}
				</span>
				<IconButton
					disabled={!query}
					icon={<ChevronUp />}
					label={t("panel.terminal.find.previous")}
					onClick={previous}
					size="sm"
				/>
				<IconButton
					disabled={!query}
					icon={<ChevronDown />}
					label={t("panel.terminal.find.next")}
					onClick={next}
					size="sm"
				/>
				<IconButton icon={<X />} label={t("panel.terminal.find.close")} onClick={onClose} size="sm" />
			</PopoverSurface>
		</div>
	);
}
