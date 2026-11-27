import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotsRequest, BotsState, Item, ItemEvent, ItemQuestion } from "../../../shared/bots";
import { loadLocale, translate } from "../../lib/i18n";
import { questionRows } from "../../lib/question-inbox";
import { useBotsStore } from "../../stores/bots";
import { confirmedAnswers, editAnswer, type ReviewedAnswer, sendReviewedAnswers } from "./inbox-answers";
import { answersText, withRecommendations } from "./items/item-model";
import { useItemsUi } from "./items/item-store";

const now = "2026-11-28T00:00:00.000Z";
const before = useBotsStore.getState();
afterEach(() => {
	useBotsStore.setState(before);
	useItemsUi.setState({ inboxDrafts: [], inboxReceipts: [], inboxSending: false });
});

function openItem(number: number): Item & { question: ItemQuestion } {
	return {
		id: `i${number}`,
		number,
		bot: "b",
		title: `Item ${number}`,
		status: "needs_you",
		session: "/a.jsonl",
		createdAt: now,
		updatedAt: now,
		events: [],
		links: [],
		version: 1,
		question: { text: `Question ${number}?`, options: [], id: number },
	};
}
function review(item: Item & { question: ItemQuestion }): ReviewedAnswer {
	return {
		key: item.id,
		itemId: item.id,
		device: item.device,
		label: item.title,
		question: item.question,
		answers: ["OK"],
		requestId: `request-${item.id}`,
	};
}
function accepted(item: Item, draft: ReviewedAnswer, kind: ItemEvent["kind"] = "answered"): Item {
	return {
		...item,
		status: "working",
		question: undefined,
		events: [
			{ id: 40, actor: "owner", kind, text: "OK", at: now, question: draft.question.id, request: draft.requestId },
		],
	};
}

it("applies valid recommendations per decision, preserving unoffered answers and option labels containing commas", () => {
	const q: ItemQuestion = {
		text: "Release",
		options: [],
		decisions: [
			{ question: "Where?", options: ["local", "edge, eu"], recommended: 1, multi: true },
			{ question: "When?", options: ["now"], recommended: 8 },
			{ question: "Who?", options: [] },
		],
	};
	const picks = withRecommendations(q, [["local"], null, "the team"]);
	expect(picks).toEqual([["local", "edge, eu"], null, "the team"]);
	expect(answersText(q, picks)).toBe("Where? → local, edge, eu\nWho? → the team");
});

it("editing a replacement starts a new answer and accounts for the unsent old draft", () => {
	const [row] = questionRows({ bots: [], items: [openItem(1)] }, [], { schedules: [] }, Date.parse(now), key => key);
	if (row.source !== "item") throw new Error("Expected an item question");
	const first = editAnswer({ inboxDrafts: [], inboxReceipts: [] }, row, ["old answer"]);
	const replacement = { ...row, item: { ...row.item, question: { text: "New wording?", options: [], id: 77 } } };
	const next = editAnswer(first, replacement, ["new answer"]);
	expect(next.inboxReceipts).toEqual([{ draft: first.inboxDrafts[0], outcome: "changed" }]);
	expect(next.inboxDrafts).toHaveLength(1);
	expect(next.inboxDrafts[0]).toMatchObject({ question: { id: 77 }, answers: ["new answer"] });
	expect(next.inboxDrafts[0].requestId).not.toBe(first.inboxDrafts[0].requestId);
});

describe("sendReviewedAnswers", () => {
	it("announces only confirmed deliveries when the host records an answer but its reply is lost", async () => {
		const items = [1, 2, 3].map(openItem);
		const drafts = items.map(review);
		const host: BotsState = { bots: [], items: [...items] };
		const command = vi.fn(async (req: BotsRequest) => {
			if (req.action !== "item") throw new Error("unexpected action");
			const i = items.findIndex(item => item.id === req.id);
			if (i !== 2) host.items[i] = accepted(items[i], drafts[i]);
			if (i === 1) throw new Error("Reply lost after write");
			return host;
		});
		useBotsStore.setState({ state: { bots: [], items }, command });
		useItemsUi.setState({ inboxDrafts: drafts });
		await sendReviewedAnswers();
		const receipts = useItemsUi.getState().inboxReceipts;
		expect(host.items[1].events[0].request).toBe(drafts[1].requestId);
		expect(receipts.map(row => row.outcome)).toEqual(["sent", "failed", "unconfirmed"]);
		await loadLocale("en");
		expect(translate("inbox.resultSummary", confirmedAnswers(receipts))).toBe("Answers confirmed sent: 1 of 3.");
	});

	it("sends each touched item once, skips replacements and withdrawals received during send, and keeps only retryable drafts", async () => {
		const items = [1, 2, 3, 4, 5, 6].map(openItem);
		const drafts = items.slice(0, 5).map(review);
		const command = vi.fn(async (req: BotsRequest): Promise<BotsState> => {
			if (req.action !== "item") throw new Error("unexpected action");
			if (req.id === "i1") {
				const state: BotsState = {
					bots: [],
					items: [
						accepted(items[0], drafts[0]),
						{ ...items[1], question: { text: "New wording?", options: [], id: 29 } },
						{ ...items[2], status: "working", question: undefined },
						...items.slice(3),
					],
				};
				useBotsStore.setState({ state });
				return state;
			}
			if (req.id === "i4") throw new Error("Host disconnected");
			return { bots: [], items: [accepted(items[4], drafts[4])] };
		});
		useBotsStore.setState({ state: { bots: [], items }, command });
		useItemsUi.setState({ inboxDrafts: drafts });
		await Promise.all([sendReviewedAnswers(), sendReviewedAnswers()]);
		expect(command.mock.calls.map(([req]) => req)).toEqual(
			[1, 4, 5].map(id => ({
				action: "item",
				id: `i${id}`,
				answer: { text: "OK", question: id },
				requestId: `request-i${id}`,
			})),
		);
		expect(useItemsUi.getState().inboxReceipts.map(r => r.outcome)).toEqual([
			"sent",
			"changed",
			"closed",
			"failed",
			"sent",
		]);
		expect(useItemsUi.getState().inboxReceipts[3].detail).toBe("Host disconnected");
		expect(useItemsUi.getState().inboxDrafts).toEqual([drafts[3]]);
		command.mockResolvedValueOnce({ bots: [], items: [accepted(items[3], drafts[3])] });
		await sendReviewedAnswers();
		expect(command.mock.calls[3]).toEqual(command.mock.calls[1]);
		expect(useItemsUi.getState().inboxReceipts.map(r => r.outcome)).toEqual(["sent"]);
	});

	it("checks the named host's journal and never reports a comment, no-op or refused request as an answer", async () => {
		const items = [1, 2, 3, 4].map(n => ({ ...openItem(n), device: "peer" }));
		const drafts = items.map(review);
		const remote = (item: Item, refused?: "question_changed"): BotsState => ({
			bots: [],
			items: [],
			refused,
			remote: [{ device: "peer", name: "Mac", online: true, bots: [], items: [item] }],
		});
		const command = vi
			.fn<(_request: BotsRequest) => Promise<BotsState>>()
			.mockResolvedValueOnce(remote(accepted(items[0], drafts[0])))
			.mockResolvedValueOnce(remote(accepted(items[1], drafts[1], "commented")))
			.mockResolvedValueOnce(remote(accepted(items[2], { ...drafts[2], requestId: "someone-else" })))
			.mockResolvedValueOnce(
				remote({ ...items[3], question: { id: 99, text: "Replacement?", options: [] } }, "question_changed"),
			);
		useBotsStore.setState({ state: { bots: [], items }, command });
		useItemsUi.setState({ inboxDrafts: drafts });
		await sendReviewedAnswers();
		expect(useItemsUi.getState().inboxReceipts.map(r => r.outcome)).toEqual([
			"sent",
			"comment",
			"unconfirmed",
			"changed",
		]);
		expect(useItemsUi.getState().inboxDrafts).toEqual([drafts[2]]);
	});
});
