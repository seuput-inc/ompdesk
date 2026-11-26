/**
 * The body of the turn rail's "Your messages" list (Orca's `NativeChatRailMessagePanel.tsx` and
 * `native-chat-rail-filter.ts`), loaded when the list first opens: a filter field and one row per loaded prompt, the
 * match in bold accent; the arrows move, Enter or a click picks.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatShortClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { OptionRow, SearchField } from "../common";
import type { ConversationAnchor } from "./chat-stream-utils";

/** A filter's match in a prompt's preview, null when nothing is typed, undefined when the preview lacks it. */
export function matchPrompt(preview: string, query: string): { start: number; end: number } | null | undefined {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return null;
	const at = preview.toLocaleLowerCase().indexOf(needle);
	return at === -1 ? undefined : { start: at, end: at + needle.length };
}

export default function PromptListPanel({
	anchors,
	activeIndex,
	onPick,
}: {
	anchors: readonly ConversationAnchor[];
	activeIndex: number;
	onPick: (rowIndex: number) => void;
}) {
	const t = useT();
	const [query, setQuery] = useState("");
	const [highlight, setHighlight] = useState(-1);
	const listRef = useRef<HTMLDivElement>(null);
	const listboxId = useId();
	const results = useMemo(
		() =>
			anchors.flatMap((anchor, index) => {
				const match = matchPrompt(anchor.preview, query);
				return match === undefined ? [] : [{ anchor, index, match }];
			}),
		[anchors, query],
	);
	const shown = Math.min(
		results.length - 1,
		highlight >= 0 ? highlight : Math.max(0, query.trim() ? 0 : results.findIndex(r => r.index === activeIndex)),
	);
	useEffect(() => {
		listRef.current?.ownerDocument.getElementById(`${listboxId}-${shown}`)?.scrollIntoView?.({ block: "nearest" });
	}, [listboxId, shown]);
	return (
		<div className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-1 p-1">
			<SearchField
				autoFocus
				controlSize="sm"
				label={t("chat.navigator.filter")}
				listbox={{ id: listboxId, activeId: shown >= 0 ? `${listboxId}-${shown}` : undefined }}
				onKeyDown={event => {
					if (isImeKeyEvent(event)) return;
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						const step = event.key === "ArrowDown" ? 1 : -1;
						setHighlight(Math.max(0, Math.min(results.length - 1, shown + step)));
					} else if (event.key === "Enter") {
						event.preventDefault();
						const result = results[shown];
						if (result) onPick(result.anchor.rowIndex);
					}
				}}
				onValueChange={value => {
					setQuery(value);
					setHighlight(-1);
				}}
				placeholder={t("chat.navigator.filter")}
				value={query}
			/>
			{query.trim() ? (
				<div className="px-2 text-sc-xs text-(--sc-text-muted)" data-prompt-list-count>
					{results.length === 0
						? t("chat.navigator.noMatch")
						: t("chat.navigator.matchCount", { count: results.length, total: anchors.length })}
				</div>
			) : null}
			<div className="max-h-80 overflow-y-auto" id={listboxId} ref={listRef} role="listbox">
				{results.map((result, position) => {
					const preview = result.anchor.preview || t("chat.navigator.imagePrompt");
					const { match } = result;
					return (
						<OptionRow
							active={position === shown}
							data-prompt-list-row
							id={`${listboxId}-${position}`}
							key={result.anchor.key}
							onClick={() => onPick(result.anchor.rowIndex)}
							onMouseMove={() => setHighlight(position)}
							selected={result.index === activeIndex}
							size="xs"
						>
							<span className="w-10 shrink-0 text-sc-xs text-(--sc-text-muted) tabular-nums">
								{formatShortClock(result.anchor.timestamp)}
							</span>
							<span className="min-w-0 truncate text-sc-sm">
								{match ? (
									<>
										{preview.slice(0, match.start)}
										<mark className="bg-transparent font-semibold text-(--sc-accent)">
											{preview.slice(match.start, match.end)}
										</mark>
										{preview.slice(match.end)}
									</>
								) : (
									preview
								)}
							</span>
						</OptionRow>
					);
				})}
			</div>
		</div>
	);
}
