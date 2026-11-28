/**
 * The agent's in-turn prompts (ask, select, confirm, input, editor, open-url,
 * tool approval, plan approval) as one card docked directly above the
 * composer, the way the Claude app asks: no scrim, the transcript stays
 * readable, choices are numbered rows. With focus
 * in the card, 1–9 pick a row, ↑/↓ move, Enter confirms the focused row and
 * Escape answers "cancel". Without a mounted composer (Settings open) the card
 * floats at the bottom at composer width.
 */

import type { LucideIcon } from "lucide-react";
import {
	createContext,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type RefObject,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { motionPlay } from "../../lib/motion";
import { useSessionRuntime } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { Badge, Kbd } from "../common";
import { ForeignPrompt, useAskDock } from "./ask-dock";

/**
 * How many prompts wait behind the card on screen. Stock answers one dialog at
 * a time and queues the rest; ExtensionDialog provides the count so the card
 * says that more follow.
 */
export const PromptQueueContext = createContext(0);

function PromptDock({ children }: { children: ReactNode }) {
	const dock = useAskDock();
	if (dock) return createPortal(children, dock);
	return (
		<div className="omp-prompt-dock pointer-events-none fixed inset-x-0 bottom-3 z-(--sc-z-popover)">
			<div className="omp-composer-shell pointer-events-auto">{children}</div>
		</div>
	);
}

/** Text fields own their keys: digits and arrows type there, they don't pick rows. */
function isTextField(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && target.matches("input, textarea, [contenteditable='true']");
}

/** Focus the first row of the card (not a destructive default), return focus on close. */
function useCardFocus(cardRef: RefObject<HTMLElement | null>): void {
	const tabId = useSessionRuntime()?.tabId;
	useEffect(() => {
		// A prompt in another visible pane must not steal keyboard focus.
		if (tabId && useTabsStore.getState().activeTabId !== tabId) return;
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const card = cardRef.current;
		card?.focus();
		return () => {
			if (tabId && useTabsStore.getState().activeTabId !== tabId) return;
			const active = document.activeElement;
			if (!active || active === document.body || card?.contains(active)) opener?.focus();
		};
	}, [cardRef, tabId]);
}

export interface PromptCardProps {
	/** The header's title; it wraps rather than cut, so nothing the agent asked is lost. */
	label: string;
	/** The card's accessible name when it says more than the title ("Question: Target"); defaults to `label`. */
	regionLabel?: string;
	/** An id on the title, for a control the title names (`aria-labelledby`). */
	labelId?: string;
	icon: LucideIcon;
	iconClassName?: string;
	/** Right side of the header: step counter, badge. */
	headerAside?: ReactNode;
	/** Optional desktop-only key hints (`1–3` / `Esc`) shown in the footer when the card accepts quick digits. */
	digitCount?: number;
	onCancel: () => void;
	/** Digit `n` (1-based) pressed with focus in the card, outside a text field. */
	onDigit?: (n: number) => void;
	children: ReactNode;
	footer?: ReactNode;
}

export function PromptCard({
	label,
	regionLabel,
	labelId,
	icon: Icon,
	iconClassName,
	headerAside,
	digitCount,
	onCancel,
	onDigit,
	children,
	footer,
}: PromptCardProps) {
	const t = useT();
	const waiting = useContext(PromptQueueContext);
	const foreign = useContext(ForeignPrompt);
	const tabId = useSessionRuntime()?.tabId;
	// A child's card in its opener's dock focuses the opener's pane, where it is drawn, never the child's tab.
	const paneTabId = foreign?.dockTabId ?? tabId;
	const focusPane = () => {
		if (paneTabId) void useTabsStore.getState().switchTab(paneTabId);
	};
	const cardRef = useRef<HTMLElement>(null);
	useCardFocus(cardRef);
	// The agent's request is answered by unmounting the card: it leaves a copy that plays the exit where it stood.
	useLayoutEffect(() => () => motionPlay()?.leaveGhost(cardRef.current), []);
	const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
		if (isImeKeyEvent(event.nativeEvent)) return;
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onCancel();
			return;
		}
		if (!onDigit || isTextField(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
		if (/^[1-9]$/.test(event.key)) {
			event.preventDefault();
			onDigit(Number(event.key));
		}
	};
	const maxDigit = digitCount ? Math.min(9, digitCount) : 0;
	const showShortcutStrip = Boolean(onDigit && maxDigit > 0);
	const showFooter = Boolean(footer) || showShortcutStrip;
	return (
		<PromptDock>
			<section
				aria-label={regionLabel ?? label}
				className="omp-pop-in omp-prompt-card mb-2 flex flex-col overflow-hidden rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-elevated) text-(--sc-text) shadow-(--sc-shadow-md) outline-none [--omp-pop-origin:bottom_center]"
				data-prompt-card
				onKeyDown={onKeyDown}
				onPointerDownCapture={focusPane}
				onFocusCapture={focusPane}
				ref={cardRef}
				role="region"
				tabIndex={-1}
			>
				<div className="flex shrink-0 items-center gap-2.5 border-b border-(--sc-divider) bg-(--sc-surface-1) px-4 py-2.5 [html[data-input=touch]_&]:py-3">
					<span className="flex size-6 shrink-0 items-center justify-center rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-elevated)">
						<Icon aria-hidden className={cx("size-(--sc-icon-sm) shrink-0 text-(--sc-accent)", iconClassName)} />
					</span>
					<span className="min-w-0 flex-1 text-sc-md font-semibold break-keep break-words" id={labelId}>
						{label}
					</span>
					{foreign && (
						<span className="inline-flex min-w-0" data-prompt-from-child>
							<Badge className="max-w-48 truncate" variant="info">
								{t("extDialog.fromChild", { title: foreign.from })}
							</Badge>
						</span>
					)}
					{waiting > 0 && (
						<span className="inline-flex" data-prompt-waiting>
							<Badge variant="muted">{t("extDialog.waiting", { count: waiting })}</Badge>
						</span>
					)}
					{headerAside}
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 [html[data-input=touch]_&]:py-3.5">{children}</div>
				{showFooter && (
					<div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-(--sc-divider) bg-(--sc-surface-1) px-4 py-2">
						{showShortcutStrip && (
							<span
								className="flex shrink-0 items-center gap-2.5 text-sc-xs text-(--sc-text-muted) [html[data-input=touch]_&]:hidden"
								data-prompt-shortcuts
							>
								<span className="inline-flex items-center gap-1">
									<Kbd shortcut={maxDigit === 1 ? "1" : `1–${maxDigit}`} />
									{t("input.menu.hintPick")}
								</span>
								<span className="inline-flex items-center gap-1">
									<Kbd shortcut="Esc" />
									{t("input.menu.hintClose")}
								</span>
							</span>
						)}
						{footer}
					</div>
				)}
			</section>
		</PromptDock>
	);
}

/** Seconds left before omp stops waiting for the answer; nothing when the request has no timeout. */
export function TimeoutFooter({ remaining }: { remaining: number | null }) {
	const t = useT();
	if (remaining === null) return null;
	return (
		<span className="text-sc-xs tabular-nums text-(--sc-text-muted)" data-prompt-countdown>
			{t("extDialog.autoDismiss", { seconds: Math.ceil(remaining / 1000) })}
		</span>
	);
}
