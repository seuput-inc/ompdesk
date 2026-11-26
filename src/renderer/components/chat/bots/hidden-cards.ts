/**
 * Bot cards the person hid from chats (Orca's `NativeChatCardHideButton.tsx` and `native-chat-card-kind-hidden-toast.tsx`,
 * FC20): one kind at a time, from a card's Hide, with Undo in the toast; Settings › Bots shows the hidden kinds again.
 * Stored as one pref (`hiddenChatCards`), followed across windows through PREFS_CHANGED.
 */
import { create } from "zustand";
import { translate } from "../../../lib/i18n";
import { readPref } from "../../../lib/prefs-read";
import { toast, toastError } from "../../../stores/toast";

export const CHAT_CARD_KINDS = ["itemNotes", "botOffers", "botRequests", "toolsAdded", "quietRuns"] as const;
export type ChatCardKind = (typeof CHAT_CARD_KINDS)[number];

const PREF = "hiddenChatCards";

export const useHiddenCards = create<{ hidden: readonly ChatCardKind[] }>()(() => ({ hidden: [] }));

function parse(value: unknown): ChatCardKind[] {
	return Array.isArray(value) ? CHAT_CARD_KINDS.filter(kind => value.includes(kind)) : [];
}

let read: Promise<boolean> | null = null;

async function reread(): Promise<boolean> {
	const stored = await readPref(PREF);
	if (stored.ok) useHiddenCards.setState({ hidden: parse(stored.value) });
	return stored.ok;
}

/** Reads the pref once, then follows other windows' writes; a failed read is tried again on the next call. */
export function ensureHiddenCards(): Promise<boolean> {
	if (read) return read;
	read = reread().then(ok => {
		if (!ok) read = null;
		return ok;
	});
	window.omp?.prefs?.onChanged?.(event => {
		if (event.key === PREF) void reread();
	});
	return read;
}

export async function setCardHidden(kind: ChatCardKind, hide: boolean): Promise<void> {
	// An unread pref is unknown, not empty: a write now could put back kinds another window showed again.
	if (!(await ensureHiddenCards())) throw new Error("The hidden cards could not be read");
	const others = useHiddenCards.getState().hidden.filter(each => each !== kind);
	const hidden = hide ? [...others, kind] : others;
	useHiddenCards.setState({ hidden });
	await window.omp.prefs.set(PREF, hidden);
}

/** A card's Hide: that kind leaves every chat, and the toast offers it back. */
export function hideCardKind(kind: ChatCardKind): void {
	const failed = (error: unknown) => toastError({ title: translate("chat.botCards.hideFailed"), error });
	void setCardHidden(kind, true)
		.then(() =>
			toast({
				message: translate("chat.botCards.hidden", { kind: translate(`chat.botCards.kind.${kind}`) }),
				action: {
					label: translate("chat.botCards.undo"),
					run: () => void setCardHidden(kind, false).catch(failed),
				},
			}),
		)
		.catch(failed);
}
