import { useId } from "react";
import { ITEM_TEXT_MAX, type ItemQuestion } from "../../../../shared/bots";
import { useT } from "../../../lib/i18n";
import { MarkdownRenderer } from "../../../lib/markdown";
import { ChoiceList, TextArea } from "../../common";
import { type DecisionAnswer, decisionsOf } from "./item-model";

/** The item page and inbox edit the same answers. Only the item page sends a single quick pick immediately. */
export function ItemAnswerEditor({
	question,
	answers,
	onChange,
	disabled = false,
	commentBox = false,
}: {
	question: ItemQuestion;
	answers: readonly DecisionAnswer[];
	onChange: (answers: DecisionAnswer[], quickPick: boolean) => void;
	disabled?: boolean;
	/** A single written answer on the item page already has its comment box. */
	commentBox?: boolean;
}) {
	const t = useT();
	const id = useId();
	const decisions = decisionsOf(question);
	const change = (index: number, value: DecisionAnswer, quickPick = false) => {
		const next = [...answers];
		next[index] = value;
		onChange(next, quickPick);
	};
	return (
		<div className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
			{question.text && (
				<div className="text-sc-sm" id={id}>
					<MarkdownRenderer content={question.text} />
				</div>
			)}
			{decisions.map((decision, index) => {
				const answer = answers[index];
				const picks = Array.isArray(answer) ? answer : [];
				const showPrompt = decision.question && (decisions.length > 1 || decision.question !== question.text);
				const labelledBy = showPrompt ? `${id}-${index}` : id;
				return (
					<div
						className="space-y-1.5 not-first:border-t not-first:border-(--sc-border-subtle) not-first:pt-2"
						key={`${index}-${decision.question}`}
					>
						{showPrompt && (
							<div className="text-sc-sm font-medium" id={labelledBy}>
								<MarkdownRenderer content={decision.question} />
							</div>
						)}
						{decision.options.length > 0 && (
							<ChoiceList
								choices={decision.options.map((option, at) => ({
									key: option,
									label: option,
									disabled,
									aside:
										decision.recommended === at ? (
											<span className="text-sc-xs text-(--sc-text-muted)">
												{t("bots.items.ask.recommended")}
											</span>
										) : undefined,
								}))}
								labelledBy={labelledBy}
								mode={decision.multi ? "multi" : "single"}
								onChoose={key => {
									const next = picks.includes(key)
										? picks.filter(pick => pick !== key)
										: decision.multi
											? [...picks, key]
											: [key];
									change(
										index,
										next.length ? next : null,
										decisions.length === 1 && !decision.multi && next.length > 0,
									);
								}}
								selected={new Set(picks)}
							/>
						)}
						{(!commentBox || decisions.length > 1) && (
							<TextArea
								aria-describedby={labelledBy}
								className="w-full"
								disabled={disabled}
								label={t("inbox.writeAnswer")}
								maxLength={ITEM_TEXT_MAX}
								onChange={event => change(index, event.target.value || null)}
								rows={1}
								value={typeof answer === "string" ? answer : ""}
							/>
						)}
					</div>
				);
			})}
		</div>
	);
}
