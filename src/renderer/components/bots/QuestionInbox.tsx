import { Inbox, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { ITEM_TEXT_MAX } from "../../../shared/bots";
import { useQuestionInbox } from "../../hooks/use-question-inbox";
import { formatClock, formatSpan } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useMinuteTick } from "../../lib/now-tick";
import type { QuestionRow } from "../../lib/question-inbox";
import { groupQuestions, openInboxRow } from "../../lib/question-inbox-view";
import { toastError } from "../../stores/toast";
import { Badge, Button, Card, EmptyState, PageLayout } from "../common";
import {
	type AnswerReceipt,
	confirmedAnswers,
	editAnswer,
	type InboxItemRow,
	type ReviewedAnswer,
	sendReviewedAnswers,
} from "./inbox-answers";
import { ItemAnswerEditor } from "./items/ItemAnswerEditor";
import { answersText, type DecisionAnswer, decisionsOf, withRecommendations } from "./items/item-model";
import { useItemsUi } from "./items/item-store";

function QuestionField({
	row,
	drafts,
	receipts,
	sending,
	onEdit,
}: {
	row: QuestionRow;
	drafts: readonly ReviewedAnswer[];
	receipts: readonly AnswerReceipt[];
	sending: boolean;
	onEdit: (row: InboxItemRow, next: DecisionAnswer[]) => void;
}) {
	const t = useT();
	const question = row.source === "item" ? row.item.question : undefined;
	const draft = drafts.find(entry => entry.key === row.key && entry.question.id === question?.id);
	const changed =
		drafts.some(entry => entry.key === row.key && entry.question.id !== question?.id) ||
		receipts.some(entry => entry.draft.key === row.key && entry.outcome === "changed");
	const kindBadge =
		row.source === "approval"
			? { variant: "attention" as const, label: t("attention.approval") }
			: row.source === "access"
				? { variant: "warning" as const, label: t("bots.needs.title") }
				: { variant: "info" as const, label: t("attention.question") };
	return (
		<fieldset
			className="min-w-0 space-y-2 rounded-(--sc-radius-lg) border border-(--sc-code-border) bg-(--sc-code-bg) p-3"
			data-item-id={row.source === "item" ? row.item.id : undefined}
			data-question-row={row.source}
			onKeyDown={event => {
				if (
					event.altKey ||
					event.ctrlKey ||
					event.metaKey ||
					event.repeat ||
					!/^[1-9]$/.test(event.key) ||
					!(event.target instanceof HTMLButtonElement) ||
					!event.target.matches("[data-choice]")
				)
					return;
				const choices = event.target
					.closest("[data-choice-list]")
					?.querySelectorAll<HTMLButtonElement>("[data-choice]");
				const choice = choices?.[Number(event.key) - 1];
				if (!choice || choice.disabled) return;
				event.preventDefault();
				event.stopPropagation();
				choice.focus();
				choice.click();
			}}
		>
			<legend className="sr-only">{[row.project, row.asker, row.title].join(" · ")}</legend>
			<div className="flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<Badge size="xs" variant={kindBadge.variant}>
						{kindBadge.label}
					</Badge>
					<h4 className="min-w-0 truncate text-sc-sm font-medium text-(--sc-text)">{row.title}</h4>
				</div>
				<span className="flex shrink-0 items-center gap-1.5 text-sc-xs tabular-nums text-(--sc-text-subtle)">
					<span>{row.deviceName || row.device || t("board.thisComputer")}</span>
					<span aria-hidden>·</span>
					<span>
						{row.askedAt === null
							? t("inbox.timeUnknown")
							: t("inbox.time", {
									time: formatClock(row.askedAt),
									age: formatSpan(Date.now() - row.askedAt),
								})}
					</span>
				</span>
			</div>
			{row.source === "item" ? (
				<>
					{changed && !draft && <p className="text-sc-sm text-(--sc-attention)">{t("inbox.result.changed")}</p>}
					{row.item.question.id === undefined && <p className="text-sc-sm">{t("inbox.missingId")}</p>}
					<ItemAnswerEditor
						answers={draft?.answers ?? []}
						disabled={sending || row.item.question.id === undefined}
						onChange={next => onEdit(row, next)}
						question={row.item.question}
					/>
				</>
			) : (
				<>
					{row.detail && <p className="whitespace-pre-wrap text-sc-sm">{row.detail}</p>}
					<Button
						disabled={sending}
						onClick={async () => {
							try {
								await openInboxRow(row);
							} catch (error) {
								toastError({ title: t("inbox.openFailed"), error });
							}
						}}
						size="sm"
					>
						{t(`inbox.open.${row.source}`)}
					</Button>
				</>
			)}
		</fieldset>
	);
}

export function QuestionInbox() {
	const t = useT();
	const rows = useQuestionInbox();
	const groups = groupQuestions(rows);
	useMinuteTick(rows.some(row => row.askedAt !== null));
	const drafts = useItemsUi(s => s.inboxDrafts);
	const receipts = useItemsUi(s => s.inboxReceipts);
	const [dismissed, setDismissed] = useState<AnswerReceipt[] | null>(null);
	const showResults = receipts.length > 0 && receipts !== dismissed;
	const ordered = showResults
		? receipts.toSorted((a, b) => Number(a.outcome === "sent") - Number(b.outcome === "sent"))
		: [];
	const inbox = useRef<HTMLDivElement>(null);
	const [review, setReview] = useState(false);
	const sending = useItemsUi(s => s.inboxSending);
	const reviewHeading = useRef<HTMLHeadingElement>(null);
	const resultsHeading = useRef<HTMLHeadingElement>(null);
	const ready = drafts.filter(draft => answersText(draft.question, draft.answers));
	const recommended = rows.filter(
		(row): row is InboxItemRow =>
			row.source === "item" &&
			row.item.question.id !== undefined &&
			decisionsOf(row.item.question).some(
				decision => decision.recommended !== undefined && decision.options[decision.recommended],
			),
	);
	const recommend = () => {
		if (useItemsUi.getState().inboxSending) return;
		useItemsUi.setState(({ inboxDrafts, inboxReceipts }) => {
			let next = { inboxDrafts, inboxReceipts };
			for (const row of recommended) {
				const q = row.item.question;
				const prior = next.inboxDrafts.find(draft => draft.key === row.key && draft.question.id === q.id);
				next = editAnswer(next, row, withRecommendations(q, prior?.answers ?? []));
			}
			return next;
		});
		setReview(true);
		requestAnimationFrame(() => reviewHeading.current?.focus());
	};
	const send = async () => {
		await sendReviewedAnswers();
		setReview(false);
		requestAnimationFrame(() => resultsHeading.current?.focus());
	};
	return (
		<PageLayout body="fill" title={t("inbox.title")}>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col" data-question-inbox ref={inbox} tabIndex={-1}>
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="omp-page-body w-full max-w-4xl space-y-5 px-6 pb-6 min-[1280px]:px-10 [overflow-wrap:anywhere]">
						{review && ready.length > 0 && (
							<Card padding="row" surface="elevated">
								<h2 className="text-sc-md font-semibold" ref={reviewHeading} tabIndex={-1}>
									{t("inbox.review")}
								</h2>
								<p className="mb-2 text-sc-sm text-(--sc-text-muted)">{t("inbox.reviewHint")}</p>
								<ul className="space-y-2 text-sc-sm">
									{ready.map(draft => (
										<li key={draft.requestId}>
											<span className="font-medium">{draft.label}</span>
											<p className="text-(--sc-text-muted)">{draft.question.text}</p>
											<p className="whitespace-pre-wrap">{answersText(draft.question, draft.answers)}</p>
										</li>
									))}
								</ul>
							</Card>
						)}
						<p className="sr-only" role="status">
							{showResults && t("inbox.resultSummary", confirmedAnswers(receipts))}
						</p>
						{showResults && (
							<Card padding="row" surface="elevated">
								<div className="mb-2 flex items-center justify-between gap-2">
									<h2 className="text-sc-md font-semibold" ref={resultsHeading} tabIndex={-1}>
										{t("inbox.results")}
									</h2>
									<Button
										size="sm"
										onClick={() => {
											setDismissed(receipts);
											inbox.current?.focus();
										}}
									>
										{t("inbox.dismissResults")}
									</Button>
								</div>
								<ul className="space-y-2 text-sc-sm">
									{ordered.map(({ draft, outcome, detail }) => (
										<li data-inbox-outcome={outcome} key={draft.requestId}>
											<span className="font-medium">{draft.label}</span>
											<p className="whitespace-pre-wrap text-(--sc-text-muted)">
												{answersText(draft.question, draft.answers)}
											</p>
											<p className="flex items-start gap-1.5">
												{outcome !== "sent" && (
													<TriangleAlert
														aria-hidden="true"
														className="mt-0.5 size-4 shrink-0 text-(--sc-attention)"
													/>
												)}
												{t(`inbox.result.${outcome}`, { limit: ITEM_TEXT_MAX })}
											</p>
											{detail && <p className="text-(--sc-text-muted)">{detail}</p>}
										</li>
									))}
								</ul>
							</Card>
						)}
						{!rows.length && <EmptyState icon={<Inbox />} size="sm" title={t("inbox.empty")} />}
						{groups.map(group => {
							const groupCount = group.askers.reduce((sum, entry) => sum + entry.rows.length, 0);
							return (
								<section className="space-y-2.5" key={group.key}>
									<div className="flex items-baseline justify-between gap-2 border-b border-(--sc-divider) pb-1.5">
										<h2 className="text-sc-md font-semibold text-(--sc-text)">{group.project}</h2>
										<span className="text-sc-xs tabular-nums text-(--sc-text-subtle)">{groupCount}</span>
									</div>
									{group.askers.map(({ key, asker, rows: questions }) => (
										<div className="space-y-2" key={key}>
											<h3 className="text-sc-xs font-semibold text-(--sc-text-muted)">{asker}</h3>
											{questions.map(row => (
												<QuestionField
													drafts={drafts}
													key={row.key}
													onEdit={(edited, answers) =>
														useItemsUi.setState(state => editAnswer(state, edited, answers))
													}
													receipts={receipts}
													row={row}
													sending={sending}
												/>
											))}
										</div>
									))}
								</section>
							);
						})}
					</div>
				</div>
				{(rows.some(row => row.source === "item") || ready.length > 0) && (
					<footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-(--sc-divider) px-4 pt-2 pb-[calc(var(--safe-b)+0.5rem)]">
						<Button data-inbox-recommend disabled={sending || !recommended.length} onClick={recommend}>
							{t("inbox.recommend")}
						</Button>
						<Button
							data-inbox-send
							disabled={!ready.length || sending}
							loading={sending}
							onClick={() => void send()}
							variant="primary"
						>
							{t("inbox.send", { count: ready.length })}
						</Button>
					</footer>
				)}
			</div>
		</PageLayout>
	);
}
