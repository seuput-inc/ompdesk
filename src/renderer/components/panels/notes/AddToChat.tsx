/**
 * "Add to chat" (Orca's `selection-quotes/*`, MIT): a passage the person selected in the transcript, a file or the
 * terminal goes, quoted as `> ` lines and unsent, after the draft of the session they pick (this one, another open one,
 * a new one in this folder; `lib/composer-handoff.ts`), and that session shows.
 */
import { Quote } from "lucide-react";
import { type ReactNode, useState } from "react";
import { handToComposer } from "../../../lib/composer-handoff";
import { useT } from "../../../lib/i18n";
import { toast } from "../../../stores/toast";
import { ContextMenu, MenuButton, type SelectionAction } from "../../common";
import { composerTargetItems, useOtherSessionTargets } from "./composer-targets";

/** The passage as a Markdown quote, a blank line after it for what the person types next (Orca's `formatNativeChatQuote`). */
export function formatQuote(text: string): string {
	const lines = text.trim().split(/\r?\n/);
	return `${lines.map(line => (line.trim() ? `> ${line}` : ">")).join("\n")}\n\n`;
}

function useQuoteItems(tabId: string | null, read: () => string) {
	const t = useT();
	const others = useOtherSessionTargets(tabId);
	return composerTargetItems(t, tabId, others, target => {
		const text = read();
		if (!text.trim()) return;
		void handToComposer(target, { text: formatQuote(text), mode: "append" }).catch(() =>
			toast({ variant: "error", message: t("composerTarget.failed") }),
		);
	});
}

/** The target menu at a point, mounted only while open (its session list stays off the transcript's renders). */
function QuoteTargetsMenu({
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
	const items = useQuoteItems(tabId, () => text);
	return <ContextMenu ariaLabel={t("addToChat.label")} items={items} onClose={onClose} x={x} y={y} />;
}

/** The selection bar's "Add to chat" and the target menu it opens from its button. */
export function useAddToChat(tabId: string | null): { action: SelectionAction; menu: ReactNode } {
	const t = useT();
	const [open, setOpen] = useState<{ text: string; x: number; y: number } | null>(null);
	return {
		action: {
			id: "add-to-chat",
			label: t("addToChat.label"),
			icon: <Quote />,
			run: (text, button) => setOpen({ text, x: button.left, y: button.bottom + 4 }),
		},
		menu: open ? <QuoteTargetsMenu onClose={() => setOpen(null)} tabId={tabId} {...open} /> : null,
	};
}

/** A button that quotes what `read` returns (the terminal's selection) into the session picked from its menu. */
export function AddToChatButton({
	tabId,
	read,
	disabled,
}: {
	tabId: string | null;
	read: () => string;
	disabled?: boolean;
}) {
	const t = useT();
	const items = useQuoteItems(tabId, read);
	return (
		<MenuButton
			disabled={disabled}
			icon={<Quote />}
			items={items}
			keepFocus
			label={t("addToChat.selection")}
			size="sm"
		/>
	);
}
