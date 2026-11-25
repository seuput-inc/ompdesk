import { ChevronUp, ListFilter } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { cx, formatShortClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { revealAndFocus } from "../../lib/reveal-focus";
import { IconButton, Popover } from "../common";
import type { ConversationAnchor } from "./chat-stream-utils";

const PromptListPanel = lazy(() => import("./PromptListPanel"));

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

/**
 * The rail's list of every loaded prompt with a filter (Orca's `NativeChatRailMessagePanel.tsx`): the trigger and its
 * popover here, the list itself (`PromptListPanel.tsx`) loaded when it first opens. Prompts older than what the
 * transcript has loaded come as the reader scrolls up, so they join the list then.
 */
function PromptList({ activeIndex, anchors, onNavigate }: ConversationNavigatorProps) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
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
				onClose={() => setOpen(false)}
				open={open}
				placement="top-start"
			>
				<Suspense fallback={null}>
					<PromptListPanel
						activeIndex={activeIndex}
						anchors={anchors}
						onPick={rowIndex => {
							setOpen(false);
							onNavigate(rowIndex);
						}}
					/>
				</Suspense>
			</Popover>
		</div>
	);
}
