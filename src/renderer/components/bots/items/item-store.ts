/**
 * What the Items tab and the item page keep on this device (Orca's `use-bot-item-walk.ts` open item,
 * `bot-item-comment-draft.ts`, `use-bot-item-pending-comments.ts`, `bot-item-held-answers.ts`, MIT, re-implemented):
 *
 * - The open item per bot (or group), so the page comes back to it across a remount.
 * - Each item's comment draft, which a refused send fills again only while it is empty.
 * - Comments on their way: shown at once under the Activity, sent with a request id so a resend posts once; the
 *   core's answer carries the comment, which drops it. A failure keeps it with Retry and Discard. An answer whose
 *   question the bot replaced meanwhile is refused (`question_changed`): a toast says so and the words go back.
 * - The picks of a several-question ask, per question, kept in `localStorage` until they are sent.
 *
 * And the owner's moves: a status (Waiting with what it waits on) or a snooze for one item or several at once.
 */
import { create } from "zustand";
import type { Item, ItemDecision, ItemStatus } from "../../../../shared/bots";
import { translate } from "../../../lib/i18n";
import { useBotsStore } from "../../../stores/bots";
import { toast, toastError } from "../../../stores/toast";
import type { AnswerReview } from "../inbox-answers";
import type { DecisionAnswer } from "./item-model";

export interface PendingComment {
	requestId: string;
	text: string;
	at: number;
	/** The question it answers (an answer's), else a plain comment. */
	question?: number;
	failed: boolean;
}

interface ItemsUi extends AnswerReview {
	/** Per bot or group id: the item open on its Items tab. */
	open: Record<string, string | null>;
	/** Per item: the comment box's words. */
	drafts: Record<string, string>;
	/** Per item: comments on their way, oldest first. */
	pending: Record<string, PendingComment[]>;
	/** Per bot or group id: its Items list's order as last shown, which the item page steps through. */
	order: Record<string, readonly string[]>;
	inboxSending: boolean;
}

export const useItemsUi = create<ItemsUi>()(() => ({
	open: {},
	drafts: {},
	pending: {},
	order: {},
	inboxDrafts: [],
	inboxReceipts: [],
	inboxSending: false,
}));

export function setOrder(owner: string, order: readonly string[]): void {
	useItemsUi.setState(state => ({ order: { ...state.order, [owner]: order } }));
}

export function openItem(owner: string, item: string | null): void {
	useItemsUi.setState(state => ({ open: { ...state.open, [owner]: item } }));
}

export function setDraft(item: string, text: string): void {
	useItemsUi.setState(state => ({ drafts: { ...state.drafts, [item]: text } }));
}

function setPending(item: string, change: (list: PendingComment[]) => PendingComment[]): void {
	useItemsUi.setState(state => ({ pending: { ...state.pending, [item]: change(state.pending[item] ?? []) } }));
}

export function postItemAnswer(item: string, question: number, text: string, requestId: string) {
	return useBotsStore.getState().command({ action: "item", id: item, answer: { text, question }, requestId });
}

async function post(item: string, entry: PendingComment): Promise<void> {
	try {
		const state =
			entry.question === undefined
				? await useBotsStore.getState().command({
						action: "item",
						id: item,
						comment: entry.text,
						requestId: entry.requestId,
					})
				: await postItemAnswer(item, entry.question, entry.text, entry.requestId);
		setPending(item, list => list.filter(known => known.requestId !== entry.requestId));
		if (state.refused === "question_changed") {
			toast({ variant: "warning", message: translate("bots.items.ask.replaced") });
			// The words go back only into an empty box: what the owner typed since stays.
			if (!useItemsUi.getState().drafts[item]?.trim()) setDraft(item, entry.text);
		}
	} catch (error) {
		setPending(item, list =>
			list.map(known => (known.requestId === entry.requestId ? { ...known, failed: true } : known)),
		);
		toastError({ title: translate("bots.items.comment.failed"), error });
	}
}

/** Sends a comment (or an answer to `question`): shown at once, posted once whatever is retried. */
export function sendComment(item: string, text: string, question?: number): void {
	const entry: PendingComment = {
		requestId: crypto.randomUUID(),
		text,
		at: Date.now(),
		failed: false,
		...(question === undefined ? {} : { question }),
	};
	setPending(item, list => [...list, entry]);
	void post(item, entry);
}

export function retryComment(item: string, requestId: string): void {
	const entry = useItemsUi.getState().pending[item]?.find(known => known.requestId === requestId);
	if (!entry) return;
	setPending(item, list => list.map(known => (known.requestId === requestId ? { ...known, failed: false } : known)));
	void post(item, { ...entry, failed: false });
}

export function discardComment(item: string, requestId: string): void {
	setPending(item, list => list.filter(known => known.requestId !== requestId));
}

/** Moves `items` to `status` in one write (one mail per chat); Waiting says what they wait on (`wait`). */
export function moveItems(items: readonly Item[], status: ItemStatus, note?: { wait?: string; note?: string }): void {
	if (items.length === 0) return;
	void useBotsStore
		.getState()
		.command({ action: "item", ids: items.map(item => item.id), status, ...note })
		.catch((error: unknown) => toastError({ title: translate("bots.items.move.failed"), error }));
}

/** Snoozes `items` until `until` (epoch ms), or wakes them (null). The bot is not told. */
export function snoozeItems(items: readonly Item[], until: number | null): void {
	if (items.length === 0) return;
	void useBotsStore
		.getState()
		.command({
			action: "item",
			ids: items.map(item => item.id),
			snoozeUntil: until === null ? null : new Date(until).toISOString(),
		})
		.catch((error: unknown) => toastError({ title: translate("bots.items.snooze.failed"), error }));
}

// ---- Held answers of a several-question ask ----------------------------------------------------------------------

const heldKey = (item: string, question: number) => `bot-item-answers:${item}:${question}`;

/** The picks held on this device for `question` of `item`, one per question line (null: none). */
export function heldAnswers(item: string, question: number, decisions: readonly ItemDecision[]): DecisionAnswer[] {
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(heldKey(item, question)) ?? "[]");
		const held = Array.isArray(raw) ? raw : [];
		return decisions.map((decision, index) => {
			const answer: unknown = held[index];
			if (Array.isArray(answer)) return answer.filter((pick): pick is string => decision.options.includes(pick));
			if (typeof answer !== "string" || !answer) return null;
			if (decision.options.includes(answer)) return [answer];
			// Older versions held multiple picks as one comma-separated string.
			const picks = answer.split(", ");
			return decision.multi && picks.every(pick => decision.options.includes(pick)) ? picks : answer;
		});
	} catch {
		return decisions.map(() => null);
	}
}

export function holdAnswers(item: string, question: number, answers: readonly DecisionAnswer[]): void {
	try {
		if (answers.every(answer => !answer)) localStorage.removeItem(heldKey(item, question));
		else localStorage.setItem(heldKey(item, question), JSON.stringify(answers));
	} catch {
		// Storage full or off: the picks stay for this page only.
	}
}
