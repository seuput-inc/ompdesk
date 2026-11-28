import { ITEM_TEXT_MAX, type ItemQuestion } from "../../../shared/bots";
import type { ItemsV2Reply, ItemsV2Request } from "../../../shared/items-v2";
import { errorDetail } from "../../lib/error-detail";
import type { QuestionRow } from "../../lib/question-inbox";
import { listedItem, useBotsStore } from "../../stores/bots";
import { queryItems } from "../../stores/item-query";
import { answersText, type DecisionAnswer } from "./items/item-model";
import { postItemAnswer, useItemsUi } from "./items/item-store";

export type InboxItemRow = Extract<QuestionRow, { source: "item" }>;
export interface ReviewedAnswer {
	key: string;
	itemId: string;
	bot: string;
	device?: string;
	label: string;
	question: ItemQuestion;
	answers: DecisionAnswer[];
	requestId: string;
}

export interface AnswerReview {
	inboxDrafts: ReviewedAnswer[];
	inboxReceipts: AnswerReceipt[];
}

export function editAnswer(review: AnswerReview, row: InboxItemRow, answers: DecisionAnswer[]): AnswerReview {
	const prior = review.inboxDrafts.find(draft => draft.key === row.key);
	const current = prior?.question.id === row.item.question.id ? prior : undefined;
	const inboxReceipts: AnswerReceipt[] =
		prior && !current
			? [
					...review.inboxReceipts.filter(r => r.draft.requestId !== prior.requestId),
					{ draft: prior, outcome: "changed" },
				]
			: review.inboxReceipts;
	const rest = prior ? review.inboxDrafts.filter(draft => draft !== prior) : review.inboxDrafts;
	if (!answers.some(answer => (Array.isArray(answer) ? answer.length > 0 : Boolean(answer)))) {
		return { inboxDrafts: rest, inboxReceipts };
	}
	const draft = {
		key: row.key,
		itemId: row.item.id,
		bot: row.item.bot,
		device: row.device,
		label: [row.project, row.asker, row.title].join(" · "),
		question: row.item.question,
		answers,
		// A retry keeps this request id until its words change, including after a lost response.
		requestId:
			current && answersText(current.question, current.answers) === answersText(row.item.question, answers)
				? current.requestId
				: crypto.randomUUID(),
	};
	return { inboxDrafts: [...rest, draft], inboxReceipts };
}

export type AnswerOutcome = "sent" | "changed" | "closed" | "comment" | "unconfirmed" | "failed" | "tooLong";
export interface AnswerReceipt {
	draft: ReviewedAnswer;
	outcome: AnswerOutcome;
	detail?: string;
}

export function confirmedAnswers(receipts: readonly AnswerReceipt[]) {
	return { sent: receipts.filter(receipt => receipt.outcome === "sent").length, total: receipts.length };
}

async function deliverOne(draft: ReviewedAnswer, text: string): Promise<AnswerOutcome> {
	const { bot, itemId: id, requestId } = draft;
	const device = draft.device ?? null;
	const question = draft.question.id;
	if (question === undefined) return "unconfirmed";
	const receipt = () => queryItems(device, { protocol: 2, action: "itemReceipt", bot, id, requestId, question });
	const disposition = (outcome: ItemsV2Reply<Extract<ItemsV2Request, { action: "itemReceipt" }>>["outcome"]) =>
		outcome === "answered" ? "sent" : outcome === "commented" ? "comment" : undefined;
	const detail = async () => (await queryItems(device, { protocol: 2, action: "itemDetail", bot, id })).item;
	const refusedOutcome = async () => {
		const item = await detail();
		return item.status === "needs_you" && item.question && !item.closedAt
			? ("changed" as const)
			: ("closed" as const);
	};
	const first = await receipt();
	const saved = disposition(first.outcome);
	if (saved) return saved;
	if (first.outcome === "question_changed") return refusedOutcome();
	const current = listedItem(useBotsStore.getState().state, draft.device, id) ?? (await detail());
	if (!current?.question || current.status !== "needs_you" || current.closedAt || current.question.id !== question) {
		// An old host may have dropped its receipt. A lost write is not proved refused by a newer question.
		if (first.legacy && useItemsUi.getState().inboxReceipts.some(r => r.draft.requestId === requestId))
			return "unconfirmed";
		return current?.status === "needs_you" && current.question && !current.closedAt ? "changed" : "closed";
	}
	if (text.length > ITEM_TEXT_MAX) return "tooLong";
	let refused = false;
	try {
		const result = await postItemAnswer({ id, bot, device: draft.device }, question, text, requestId);
		refused = result.refused === "question_changed";
	} catch (error) {
		const result = await receipt().catch(() => undefined);
		const recovered = result && disposition(result.outcome);
		if (recovered) return recovered;
		if (result?.outcome !== "question_changed") throw error;
		refused = true;
	}
	if (!refused) {
		const result = await receipt();
		const confirmed = disposition(result.outcome);
		if (confirmed) return confirmed;
		if (result.outcome !== "question_changed") return "unconfirmed";
	}
	// The refusal can arrive before the feed announces a replacement or withdrawal.
	return refusedOutcome();
}

/** Recheck immediately before each write. Only the host's receipt proves that it accepted an answer. */
async function deliver(drafts: readonly ReviewedAnswer[]): Promise<AnswerReceipt[]> {
	const receipts: AnswerReceipt[] = [];
	for (const draft of drafts) {
		const text = answersText(draft.question, draft.answers);
		if (!text) continue;
		try {
			receipts.push({ draft, outcome: await deliverOne(draft, text) });
		} catch (error) {
			receipts.push({ draft, outcome: "failed", detail: errorDetail(error) });
		}
	}
	return receipts;
}

export async function sendReviewedAnswers(): Promise<void> {
	const { inboxDrafts, inboxSending } = useItemsUi.getState();
	if (inboxSending || !inboxDrafts.length) return;
	useItemsUi.setState({ inboxSending: true });
	try {
		const receipts = await deliver(inboxDrafts);
		const finished = new Set(
			receipts.flatMap(({ draft, outcome }) =>
				outcome === "sent" || outcome === "changed" || outcome === "closed" || outcome === "comment"
					? [draft.requestId]
					: [],
			),
		);
		useItemsUi.setState(state => ({
			inboxReceipts: receipts,
			inboxDrafts: state.inboxDrafts.filter(draft => !finished.has(draft.requestId)),
		}));
	} finally {
		useItemsUi.setState({ inboxSending: false });
	}
}
