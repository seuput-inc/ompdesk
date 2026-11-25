import { ChevronUp, ListFilter } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cx, formatShortClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { revealAndFocus } from "../../lib/reveal-focus";
import { IconButton, OptionRow, Popover, SearchField } from "../common";
import type { ConversationAnchor } from "./chat-stream-utils";

interface ConversationNavigatorProps {
	activeIndex: number;
	anchors: readonly ConversationAnchor[];
	onNavigate: (rowIndex: number) => void;
}

/** Below this many user turns the transcript is short enough to scroll; a rail would be noise. */
const MIN_ANCHORS = 3;

/** The rail draws this many ticks at most: the newest turns, then a page of older ones per press of its top item. */
export const TURN_RAIL_LIMIT = 20;

interface RailView {
	/** Key of the first tick drawn; null follows the newest turns as they come. */
	startKey: string | null;
	/** The turn in view and the turn count the window was last fitted to. */
	activeKey: string | undefined;
	total: number;
}

/**
 * Navigation rail in the transcript's left gutter: one dot per user turn on a
 * faint track, the current turn emphasized. Hovering or focusing a dot
 * previews that prompt; arrows/Home/End move between dots (roving tabindex).
 * Only the newest `TURN_RAIL_LIMIT` turns are drawn, so a long session keeps
 * ticks big enough to hit; the top item ("N earlier") moves the window one
 * page up, and the window moves by itself when the turn in view leaves it.
 * Older turns not yet read from the session load by themselves when the reader
 * scrolls near the top, so the rail carries no load button for them.
 */
export function ConversationNavigator({ activeIndex, anchors, onNavigate }: ConversationNavigatorProps) {
	const t = useT();
	const [previewIndex, setPreviewIndex] = useState<number | "earlier" | null>(null);
	const [view, setView] = useState<RailView>({ startKey: null, activeKey: undefined, total: 0 });
	const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);
	const earlierRef = useRef<HTMLButtonElement | null>(null);
	const total = anchors.length;
	if (total < MIN_ANCHORS) return null;

	const newestStart = Math.max(0, total - TURN_RAIL_LIMIT);
	const held = view.startKey === null ? -1 : anchors.findIndex(anchor => anchor.key === view.startKey);
	let start = held < 0 ? newestStart : Math.min(held, newestStart);
	const activeKey = anchors[activeIndex]?.key;
	let startKey = view.startKey;
	if (activeKey !== view.activeKey || total !== view.total) {
		// The reader's turn or the turn count changed (a scroll, a jump, a new turn): the turn in view keeps its tick
		// inside the window. A page up with neither changed leaves the window where the reader put it.
		if (activeIndex < start) start = activeIndex;
		else if (activeIndex >= start + TURN_RAIL_LIMIT) start = activeIndex - TURN_RAIL_LIMIT + 1;
		startKey = start >= newestStart ? null : (anchors[start]?.key ?? null);
		setView({ startKey, activeKey, total });
	}

	const end = Math.min(total, start + TURN_RAIL_LIMIT);
	const tabStop = activeIndex < start ? start : Math.min(activeIndex, end - 1);
	const focusMarker = (index: number) => {
		if (index < start && start > 0) {
			earlierRef.current?.focus();
			setPreviewIndex("earlier");
			return;
		}
		const bounded = Math.max(start, Math.min(index, end - 1));
		buttonsRef.current[bounded]?.focus();
		setPreviewIndex(bounded);
	};
	const showEarlier = (control: HTMLButtonElement, byKeyboard: boolean) => {
		const pageStart = Math.max(0, start - TURN_RAIL_LIMIT);
		const page = () => setView(current => ({ ...current, startKey: anchors[pageStart]?.key ?? null }));
		if (!byKeyboard) {
			page();
			return;
		}
		revealAndFocus(control, page, () => (pageStart === 0 ? buttonsRef.current[0] : earlierRef.current));
	};

	return (
		<nav className="omp-conversation-nav" aria-label={t("chat.navigator.label")}>
			<div className="omp-conversation-nav-stack">
				{start > 0 ? (
					<div className="omp-conversation-nav-earlier-slot">
						{/* controls-ok: the omp-conversation-nav-earlier class draws the item and its focus ring */}
						<button
							ref={earlierRef}
							type="button"
							aria-label={t("chat.navigator.earlier", { count: start })}
							tabIndex={-1}
							className="omp-conversation-nav-earlier"
							onBlur={() => setPreviewIndex(current => (current === "earlier" ? null : current))}
							onClick={event => showEarlier(event.currentTarget, event.detail === 0)}
							onFocus={() => setPreviewIndex("earlier")}
							onMouseEnter={() => setPreviewIndex("earlier")}
							onMouseLeave={() => setPreviewIndex(current => (current === "earlier" ? null : current))}
							onKeyDown={event => {
								if (event.key === "ArrowDown" || event.key === "ArrowRight" || event.key === "Home") {
									event.preventDefault();
									focusMarker(start);
								} else if (event.key === "End") {
									event.preventDefault();
									focusMarker(end - 1);
								}
							}}
						>
							<ChevronUp aria-hidden className="size-2.5" />
							<span aria-hidden>{start}</span>
						</button>
						{previewIndex === "earlier" ? (
							<div role="tooltip" className="omp-conversation-nav-preview omp-conversation-nav-preview-earlier">
								{t("chat.navigator.earlier", { count: start })}
							</div>
						) : null}
					</div>
				) : null}
				{anchors.slice(start, end).map((anchor, offset) => {
					const index = start + offset;
					const preview = anchor.preview || t("chat.navigator.imagePrompt");
					const clock = previewIndex === index ? formatShortClock(anchor.timestamp) : "";
					return (
						<div key={anchor.key} className="omp-conversation-nav-slot">
							{/* controls-ok: the omp-conversation-nav-marker class draws the marker and its focus ring */}
							<button
								ref={element => {
									buttonsRef.current[index] = element;
								}}
								type="button"
								aria-current={index === activeIndex ? "location" : undefined}
								aria-label={t("chat.navigator.jumpTo", {
									current: index + 1,
									total: anchors.length,
									preview,
								})}
								tabIndex={index === tabStop ? 0 : -1}
								className={cx("omp-conversation-nav-marker", index === activeIndex && "is-active")}
								onBlur={() => setPreviewIndex(current => (current === index ? null : current))}
								onClick={() => onNavigate(anchor.rowIndex)}
								onFocus={() => setPreviewIndex(index)}
								onMouseEnter={() => setPreviewIndex(index)}
								onMouseLeave={() => setPreviewIndex(current => (current === index ? null : current))}
								onKeyDown={event => {
									if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
										event.preventDefault();
										focusMarker(index - 1);
									} else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
										event.preventDefault();
										focusMarker(index + 1);
									} else if (event.key === "Home") {
										event.preventDefault();
										focusMarker(start);
									} else if (event.key === "End") {
										event.preventDefault();
										focusMarker(end - 1);
									}
								}}
							/>
							{previewIndex === index ? (
								<div role="tooltip" className="omp-conversation-nav-preview">
									<div className="omp-conversation-nav-preview-kicker">
										<span>{t("chat.navigator.turn", { current: index + 1, total: anchors.length })}</span>
										{clock ? <time>{clock}</time> : null}
									</div>
									<p>{preview}</p>
								</div>
							) : null}
						</div>
					);
				})}
				<PromptList activeIndex={activeIndex} anchors={anchors} onNavigate={onNavigate} />
			</div>
		</nav>
	);
}

/** A filter's match in a prompt's preview, or null when nothing is typed. */
export function matchPrompt(preview: string, query: string): { start: number; end: number } | null | undefined {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return null;
	const at = preview.toLocaleLowerCase().indexOf(needle);
	return at === -1 ? undefined : { start: at, end: at + needle.length };
}

/**
 * The rail's list of every loaded prompt with a filter (Orca's `NativeChatRailMessagePanel.tsx` and
 * `native-chat-rail-filter.ts`): typing narrows it to the prompts holding the words (the match in bold accent), the
 * arrows move, Enter or a click jumps there. Prompts older than what the transcript has loaded come as the reader
 * scrolls up, so they join the list then.
 */
function PromptList({ activeIndex, anchors, onNavigate }: ConversationNavigatorProps) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [highlight, setHighlight] = useState(-1);
	const triggerRef = useRef<HTMLButtonElement>(null);
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
	const close = () => {
		setOpen(false);
		setQuery("");
		setHighlight(-1);
	};
	const pick = (rowIndex: number) => {
		close();
		onNavigate(rowIndex);
	};
	return (
		<div className="omp-conversation-nav-list">
			<IconButton
				aria-expanded={open}
				data-prompt-list
				icon={<ListFilter />}
				label={t("chat.navigator.list")}
				onClick={() => setOpen(value => !value)}
				ref={triggerRef}
				size="sm"
				tooltipSide="right"
				variant="ghost"
			/>
			<Popover
				anchorRef={triggerRef}
				ariaLabel={t("chat.navigator.list")}
				onClose={close}
				open={open}
				placement="top-start"
			>
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
								if (result) pick(result.anchor.rowIndex);
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
									onClick={() => pick(result.anchor.rowIndex)}
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
			</Popover>
		</div>
	);
}
