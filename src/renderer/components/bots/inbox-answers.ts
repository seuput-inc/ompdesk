import { ITEM_TEXT_MAX, type Item, type ItemQuestion } from "../../../shared/bots";
import { errorDetail } from "../../lib/error-detail";
import type { QuestionRow } from "../../lib/question-inbox";
import { useBotsStore } from "../../stores/bots";
import { answersText, type DecisionAnswer } from "./items/item-model";
import { postItemAnswer, useItemsUi } from "./items/item-store";

export type InboxItemRow = Extract<QuestionRow, { source: "item" }>;
export interface ReviewedAnswer {
	key: string;
	itemId: string;
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

function recorded(item: Item | undefined, draft: ReviewedAnswer): AnswerOutcome | undefined {
	const event = item?.events.find(entry => entry.actor === "owner" && entry.request === draft.requestId);
	if (event?.kind === "answered" && event.question === draft.question.id) return "sent";
	if (event?.kind === "commented") return "comment";
	return undefined;
}

/** Recheck immediately before each write. Only the host's receipt proves that it accepted an answer. */
async function deliver(drafts: readonly ReviewedAnswer[]): Promise<AnswerReceipt[]> {
	const receipts: AnswerReceipt[] = [];
	for (const draft of drafts) {
		const text = answersText(draft.question, draft.answers);
		if (!text) continue;
		const qid = draft.question.id;
		const items = useBotsStore.getState().state.items;
		const current = items.find(item => item.id === draft.itemId && item.device === draft.device);
		let outcome = recorded(current, draft);
		let detail: string | undefined;
		if (!outcome) {
			if (!current?.question || current.status !== "needs_you") outcome = "closed";
			else if (current.question.id !== qid) outcome = "changed";
			else if (qid === undefined || items.some(item => item.id === draft.itemId && item.device !== draft.device))
				outcome = "unconfirmed";
			else if (text.length > ITEM_TEXT_MAX) outcome = "tooLong";
			else {
				try {
					const state = await postItemAnswer(draft.itemId, qid, text, draft.requestId);
					const hostItems = draft.device
						? state.remote?.find(host => host.device === draft.device)?.items
						: state.items;
					const item = hostItems?.find(item => item.id === draft.itemId);
					outcome =
						recorded(item, draft) ??
						(state.refused === "question_changed" ? (item?.question ? "changed" : "closed") : "unconfirmed");
				} catch (error) {
					outcome = "failed";
					detail = errorDetail(error);
				}
			}
		}
		receipts.push({ draft, outcome, detail });
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
