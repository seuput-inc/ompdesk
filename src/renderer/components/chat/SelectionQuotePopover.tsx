/**
 * Lightweight selection-to-quote popover over the chat transcript (Orca's
 * `selection-quotes/NativeChatSelectionQuote.tsx` + `SelectionAddToChatPopover.tsx`, MIT).
 *
 * Loaded lazily by `ChatStream` (zero eager first-screen bytes):
 * - Ignores selections anchored inside non-prose chrome (buttons, message actions,
 *   figure headers, tool/thinking disclosure rows).
 * - Clicking "Add to chat" quotes directly into the active session's composer as a `> `
 *   blockquote in a single click (no intermediate menu when quoting locally), and clears
 *   the selection; if other sessions are open, a compact secondary action opens the
 *   session target menu.
 */

import { MessageSquareShare, Quote } from "lucide-react";
import { type RefObject, useState } from "react";
import { handToComposer } from "../../lib/composer-handoff";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { ContextMenu, type SelectionAction, SelectionActions, useCopySelectionAction } from "../common";
import { selectionWithin } from "../common/SelectionActions";
import { composerTargetItems, useOtherSessionTargets } from "../panels/notes/composer-targets";

const NON_QUOTABLE_CHROME_SELECTOR = [
	"button",
	"input",
	"textarea",
	"[data-selection-actions]",
	"[data-figure-header]",
	".omp-message-actions",
	".omp-tool-header",
	".omp-thinking-header",
	".omp-execution-group-header",
].join(", ");

/** Format selected transcript text as a Markdown blockquote with a trailing blank line for reply typing. */
export function formatSelectionQuote(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	const lines = trimmed.split(/\r?\n/);
	return `${lines.map(line => (line.trim() ? `> ${line}` : ">")).join("\n")}\n\n`;
}

/** Whether a selection endpoint lies strictly inside UI chrome rather than quotable chat content. */
export function isNonQuotableSelectionNode(node: Node | null, root: HTMLElement): boolean {
	if (!node) return true;
	const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
	if (!element) return true;
	const chrome = element.closest(NON_QUOTABLE_CHROME_SELECTOR);
	return chrome !== null && root.contains(chrome);
}

/** Accept a transcript selection only when it sits inside `root` and is not UI button/header chrome. */
export function readQuotableTranscriptSelection(root: HTMLElement): { text: string; range: Range } | null {
	const found = selectionWithin(root);
	if (!found) return null;
	if (
		isNonQuotableSelectionNode(found.range.startContainer, root) &&
		isNonQuotableSelectionNode(found.range.endContainer, root)
	) {
		return null;
	}
	return found;
}

function OtherSessionsMenu({
	tabId,
	text,
	x,
	y,
	onClose,
}: {
	tabId: string | null;
	text: string;
	x: number;
	y: number;
	onClose: () => void;
}) {
	const t = useT();
	const others = useOtherSessionTargets(tabId);
	const items = composerTargetItems(t, tabId, others, target => {
		const quote = formatSelectionQuote(text);
		if (!quote) return;
		void handToComposer(target, { text: quote, mode: "append" }).catch(() =>
			toast({ variant: "error", message: t("composerTarget.failed") }),
		);
	});
	return <ContextMenu ariaLabel={t("addToChat.selection")} items={items} onClose={onClose} x={x} y={y} />;
}

export default function SelectionQuotePopover({
	rootRef,
	tabId,
}: {
	rootRef: RefObject<HTMLElement | null>;
	tabId: string | null;
}) {
	const t = useT();
	const copy = useCopySelectionAction();
	const others = useOtherSessionTargets(tabId);
	const [menuState, setMenuState] = useState<{ text: string; x: number; y: number } | null>(null);

	const quoteAction: SelectionAction = {
		id: "quote-to-chat",
		label: t("addToChat.label"),
		icon: <Quote />,
		run: (text, button) => {
			const quote = formatSelectionQuote(text);
			if (!quote) return;
			if (!tabId) {
				setMenuState({ text, x: button.left, y: button.bottom + 4 });
				return;
			}
			window.getSelection()?.removeAllRanges();
			void handToComposer({ tabId }, { text: quote, mode: "append" }).catch(() =>
				toast({ variant: "error", message: t("composerTarget.failed") }),
			);
		},
	};

	const actions: SelectionAction[] = [quoteAction, copy];
	if (others.length > 0 && tabId) {
		actions.push({
			id: "quote-other-session",
			label: t("addToChat.selection"),
			icon: <MessageSquareShare />,
			run: (text, button) => setMenuState({ text, x: button.left, y: button.bottom + 4 }),
		});
	}

	return (
		<>
			<SelectionActions accept={readQuotableTranscriptSelection} actions={actions} rootRef={rootRef} />
			{menuState ? (
				<OtherSessionsMenu
					onClose={() => setMenuState(null)}
					tabId={tabId}
					text={menuState.text}
					x={menuState.x}
					y={menuState.y}
				/>
			) : null}
		</>
	);
}
