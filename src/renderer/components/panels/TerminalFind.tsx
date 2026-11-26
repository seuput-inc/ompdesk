import type { ISearchOptions } from "@xterm/addon-search";
import { CaseSensitive, Regex } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { FindBar, IconButton, PopoverSurface } from "../common";

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
			<PopoverSurface className="w-80 max-w-[calc(100%-1rem)] p-1.5">
				<FindBar
					autoFocus
					canStep={Boolean(query)}
					className="flex items-center gap-1"
					closeLabel={t("panel.terminal.find.close")}
					label={t("panel.terminal.find.label")}
					nextLabel={t("panel.terminal.find.next")}
					onClose={onClose}
					onQuery={setQuery}
					onStep={direction => (direction > 0 ? next() : previous())}
					previousLabel={t("panel.terminal.find.previous")}
					query={query}
					status={status}
					tools={
						<>
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
						</>
					}
				/>
			</PopoverSurface>
		</div>
	);
}
