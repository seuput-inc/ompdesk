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
import { z } from "zod";
import { create } from "zustand";
import {
	ITEM_STATUSES,
	type Item,
	type ItemBatchChange,
	type ItemDecision,
	type ItemStatus,
} from "../../../../shared/bots";
import { errorDetail } from "../../../lib/error-detail";
import { uiLocale } from "../../../lib/format";
import { translate } from "../../../lib/i18n";
import { useBotsStore } from "../../../stores/bots";
import { toast, toastError, useToastStore } from "../../../stores/toast";
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

const BATCH_KEY = "omp.itemBatch.v1:";
const sending = new Set<string>();
const savedBatch = z.strictObject({
	device: z.string().min(1).nullable(),
	ids: z.array(z.string().min(1)).min(1),
	change: z.union([
		z.strictObject({ status: z.enum(ITEM_STATUSES), wait: z.string().optional(), note: z.string().optional() }),
		z.strictObject({ snoozeUntil: z.iso.datetime().nullable() }),
	]),
});
type Batch = z.infer<typeof savedBatch>;

function* pendingBatches(): Generator<[string, string]> {
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i);
		if (!key?.startsWith(BATCH_KEY)) continue;
		const raw = localStorage.getItem(key);
		if (raw !== null) yield [key.slice(BATCH_KEY.length), raw];
	}
}

function batchTitle({ device, ids, change }: Batch): string {
	const state = useBotsStore.getState().state;
	const host = state.remote?.find(host => host.device === device);
	const first = state.items.find(row => row.id === ids[0] && (row.device ?? null) === device);
	const target = first ? `#${first.number} ${first.title}` : ids[0];
	const changeName =
		"status" in change
			? translate(`bots.items.status.${change.status}`)
			: change.snoozeUntil
				? translate("bots.items.snooze.rowUntil", { when: new Date(change.snoozeUntil).toLocaleString(uiLocale()) })
				: translate("bots.items.snooze.unsnooze");
	return [host?.name ?? device, ids.length > 1 ? `${target} (+${ids.length - 1})` : target, changeName]
		.filter(Boolean)
		.join(" · ");
}

function dismissRetry(id: string): void {
	const notice = useToastStore
		.getState()
		.toasts.find(entry => entry.action?.key === BATCH_KEY + id && !entry.exitingAt);
	if (notice) useToastStore.getState().dismiss(notice.id);
}

function offerRetry(id: string, raw: string, batch: Batch, error?: unknown): void {
	if (useToastStore.getState().toasts.some(entry => entry.action?.key === BATCH_KEY + id && !entry.exitingAt)) return;
	const key = BATCH_KEY + id;
	toast({
		variant: "warning",
		title: batchTitle(batch),
		message: translate("bots.items.batch.unknown"),
		detail: errorDetail(error),
		durationMs: Number.POSITIVE_INFINITY,
		action: { key, label: translate("common.retry"), run: () => dispatchBatch(id, batch, raw) },
		secondAction: {
			label: translate("bots.items.comment.discard"),
			run: () => {
				if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
				dismissRetry(id);
			},
		},
	});
}

/** Re-open the receipts, not the commands: a restart never sends an old move without the owner choosing Retry. */
export function offerItemBatchRetries(): void {
	try {
		for (const [id, raw] of pendingBatches()) {
			if (sending.has(id)) continue;
			try {
				const batch = savedBatch.safeParse(JSON.parse(raw));
				if (batch.success) offerRetry(id, raw, batch.data);
			} catch {
				// An unreadable ticket must not hide a later one or become a command.
			}
		}
	} catch {
		// This origin does not allow storage. A new durable move will fail before dispatch.
	}
}

const batchResult = z.object({
	ids: z.array(z.string()),
	changed: z.array(z.object({ id: z.string(), version: z.number().int().nonnegative() })),
	refused: z.string().nullable(),
});

async function dispatchBatch(id: string, batch: Batch, raw?: string): Promise<void> {
	if (sending.has(id)) return;
	const key = BATCH_KEY + id;
	sending.add(id);
	dismissRetry(id);
	try {
		if (raw !== undefined && localStorage.getItem(key) !== raw) return;
		const { device, ids, change } = batch;
		const reply = await useBotsStore.getState().command({
			action: raw === undefined ? "item" : "itemBatch",
			device,
			ids,
			requestId: id,
			...change,
		});
		let refused: string | null | undefined = reply.refused;
		if (raw !== undefined) {
			const receipt = batchResult.safeParse(reply.itemBatchResult);
			if (
				!receipt.success ||
				receipt.data.ids.length !== ids.length ||
				receipt.data.ids.some((value, i) => value !== ids[i])
			) {
				offerRetry(id, raw, batch);
				return;
			}
			refused = receipt.data.refused;
			localStorage.removeItem(key);
		}
		if (refused)
			toast({ variant: "warning", title: batchTitle(batch), message: translate("bots.items.batch.refused") });
	} catch (error) {
		if (raw !== undefined) offerRetry(id, raw, batch, error);
		else
			toast({
				variant: "warning",
				title: batchTitle(batch),
				message: translate("bots.items.batch.legacyUnknown"),
				detail: errorDetail(error),
			});
	} finally {
		sending.delete(id);
	}
}

async function submitBatch(items: readonly Item[], change: ItemBatchChange, requestId: string): Promise<void> {
	if (!items.length) return;
	const device = items[0].device ?? null;
	const batch = { device, ids: items.map(item => item.id), change };
	const raw = JSON.stringify(batch);
	const bots = useBotsStore.getState().state.bots;
	const durable = bots.some(bot => bot.device === items[0].device && bot.itemReceipts);
	try {
		if (items.some(item => (item.device ?? null) !== device)) throw new Error("A batch must have one destination.");
		const key = BATCH_KEY + requestId;
		let saved: string | null = null;
		try {
			saved = localStorage.getItem(key);
		} catch (error) {
			if (durable) throw error;
		}
		if (saved !== null) {
			if (saved !== raw) throw new Error("Request id already in use.");
			return dispatchBatch(requestId, batch, raw);
		}
		if (durable) localStorage.setItem(key, raw);
	} catch (error) {
		toast({
			variant: "error",
			title: batchTitle(batch),
			message: translate("bots.items.batch.notSent"),
			detail: errorDetail(error),
		});
		return;
	}
	return dispatchBatch(requestId, batch, durable ? raw : undefined);
}

/** The caller starts one request per host. The saved command keeps the original wait reason or absolute wake time. */
export function moveItems(
	items: readonly Item[],
	status: ItemStatus,
	requestId: string,
	note?: { wait?: string; note?: string },
): Promise<void> {
	return submitBatch(items, { status, ...note }, requestId);
}

export function snoozeItems(items: readonly Item[], until: number | null, requestId: string): Promise<void> {
	return submitBatch(items, { snoozeUntil: until === null ? null : new Date(until).toISOString() }, requestId);
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
