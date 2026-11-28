import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotsRequest, BotsState, Item, ItemQuestion } from "../../../shared/bots";
import type { ItemsV2Request } from "../../../shared/items-v2";
import { loadLocale, translate } from "../../lib/i18n";
import { questionRows } from "../../lib/question-inbox";
import { useBotsStore } from "../../stores/bots";
import { confirmedAnswers, editAnswer, type ReviewedAnswer, sendReviewedAnswers } from "./inbox-answers";
import { answersText, withRecommendations } from "./items/item-model";
import { useItemsUi } from "./items/item-store";

const now = "2026-11-28T00:00:00.000Z";
const before = useBotsStore.getState();
afterEach(() => {
	vi.unstubAllGlobals();
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
		bot: item.bot,
		device: item.device,
		label: item.title,
		question: item.question,
		answers: ["OK"],
		requestId: `request-${item.id}`,
	};
}
function hostReceipt(read: (device: string | null, r: Extract<ItemsV2Request, { action: "itemReceipt" }>) => string) {
	const itemsV2 = vi.fn(async (device: string | null, request: ItemsV2Request) => {
		if (request.action === "itemReceipt") return { protocol: 2, outcome: read(device, request) };
		if (request.action === "itemDetail" && request.id === "i4") {
			const { events, ...item } = openItem(4);
			return {
				protocol: 2,
				item: { ...item, question: { ...item.question, id: 99 } },
				events,
				asks: [],
				beforeEvent: null,
				afterEvent: null,
			};
		}
		throw new Error("Unexpected query");
	});
	vi.stubGlobal("window", { omp: { bots: { itemsV2 } } });
	return itemsV2;
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
		const written = new Set<string>();
		hostReceipt((_device, r) => (written.has(r.requestId) ? "answered" : "unknown"));
		const command = vi.fn(async (req: BotsRequest) => {
			if (req.action !== "item") throw new Error("unexpected action");
			const i = items.findIndex(item => item.id === req.id);
			if (i !== 2) written.add(drafts[i].requestId);
			if (i === 1) throw new Error("Reply lost after write");
			return {};
		});
		useBotsStore.setState({ state: { bots: [], items }, command });
		useItemsUi.setState({ inboxDrafts: drafts });
		await sendReviewedAnswers();
		const receipts = useItemsUi.getState().inboxReceipts;
		expect(written.has(drafts[1].requestId)).toBe(true);
		expect(receipts.map(row => row.outcome)).toEqual(["sent", "sent", "unconfirmed"]);
		await loadLocale("en");
		expect(translate("inbox.resultSummary", confirmedAnswers(receipts))).toBe("Answers confirmed sent: 2 of 3.");
	});

	it("sends each touched item once, skips replacements and withdrawals received during send, and keeps only retryable drafts", async () => {
		const items = [1, 2, 3, 4, 5, 6].map(openItem);
		const drafts = items.slice(0, 5).map(review);
		const sent = new Set<string>();
		hostReceipt((_device, r) => (sent.has(r.requestId) ? "answered" : "unknown"));
		const command = vi.fn(async (req: BotsRequest) => {
			if (req.action !== "item") throw new Error("unexpected action");
			if (req.id === "i1") {
				const state: BotsState = {
					bots: [],
					items: [
						items[0],
						{ ...items[1], question: { text: "New wording?", options: [], id: 29 } },
						{ ...items[2], status: "working", question: undefined },
						...items.slice(3),
					],
				};
				useBotsStore.setState({ state });
				sent.add(drafts[0].requestId);
				return {};
			}
			if (req.id === "i4") throw new Error("Host disconnected");
			sent.add(drafts[4].requestId);
			return {};
		});
		useBotsStore.setState({ state: { bots: [], items }, command });
		useItemsUi.setState({ inboxDrafts: drafts });
		await Promise.all([sendReviewedAnswers(), sendReviewedAnswers()]);
		expect(command.mock.calls.map(([req]) => req)).toEqual(
			[1, 4, 5].map(id => ({
				action: "item",
				device: null,
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
		command.mockImplementationOnce(async () => {
			sent.add(drafts[3].requestId);
			return {};
		});
		await sendReviewedAnswers();
		expect(command.mock.calls[3]).toEqual(command.mock.calls[1]);
		expect(useItemsUi.getState().inboxReceipts.map(r => r.outcome)).toEqual(["sent"]);
	});

	it("checks the named host's journal and never reports a comment, no-op or refused request as an answer", async () => {
		const items = [1, 2, 3, 4].map(n => ({ ...openItem(n), device: "peer" }));
		const drafts = items.map(review);
		const sent = new Set<string>();
		const query = hostReceipt((device, r) => {
			if (
				device !== "peer" ||
				r.bot !== "b" ||
				r.question !== Number(r.id.slice(1)) ||
				r.requestId !== `request-${r.id}` ||
				!sent.has(r.id)
			)
				return "unknown";
			return r.id === "i1" ? "answered" : r.id === "i2" ? "commented" : "unknown";
		});
		const command = vi.fn(async (req: BotsRequest) => {
			if (req.action !== "item" || req.device !== "peer" || !req.id) throw new Error("Wrong destination");
			sent.add(req.id);
			return req.id === "i4" ? { refused: "question_changed" as const } : {};
		});
		useBotsStore.setState({ state: { bots: [], items: [openItem(1), ...items] }, command });
		useItemsUi.setState({ inboxDrafts: drafts });
		await sendReviewedAnswers();
		expect(useItemsUi.getState().inboxReceipts.map(r => r.outcome)).toEqual([
			"sent",
			"comment",
			"unconfirmed",
			"changed",
		]);
		expect(query).toHaveBeenCalledWith("peer", {
			protocol: 2,
			action: "itemReceipt",
			bot: "b",
			id: "i1",
			requestId: "request-i1",
			question: 1,
		});
		expect(useItemsUi.getState().inboxDrafts).toEqual([drafts[2]]);
	});

	it("confirms an older exact receipt before considering today's closed or replaced question", async () => {
		const draft = review(openItem(1));
		hostReceipt(() => "answered");
		const command = vi.fn();
		useBotsStore.setState({ state: { bots: [], items: [] }, command });
		useItemsUi.setState({ inboxDrafts: [draft] });
		await sendReviewedAnswers();
		expect(useItemsUi.getState().inboxReceipts[0].outcome).toBe("sent");
		expect(command).not.toHaveBeenCalled();
	});
});
