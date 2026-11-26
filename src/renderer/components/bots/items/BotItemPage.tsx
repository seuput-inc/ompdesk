/**
 * One item, in its list's place (Orca's `BotItemView.tsx:1-420`, `BotItemHeader.tsx:1-149`,
 * `BotItemActivityList.tsx:1-420`, `BotItemQuestionStep.tsx:1-428`, `BotItemStepper.tsx:1-273`,
 * `BotItemReplyJump.tsx:90-183`, `BotItemReplyingTo.tsx:1-163`, `BotItemLinks.tsx:197-215`, `BotItemCloseNote.tsx`,
 * `BotItemWaitCard.tsx`, `use-bot-item-chords.ts:1-87`, MIT, re-implemented on the kit; FK-B36–B40, C2-33–C2-38):
 *
 * - Top: Back to the list, "i / n" and the previous and next item in the list's order (keys `botItem.back`,
 *   `botItem.previous`, `botItem.next`, rebindable in Settings › Keyboard, only while focus is in the page).
 * - Header: `#n` and title, its status menu (Waiting asks what it waits on; again on a Waiting item it edits that;
 *   the snooze presets while it is open), its links (sessions with their state, PRs with the newer of this page's read
 *   and the PR center's, CI only on open or draft ones, addresses, files) and, while the question is off screen,
 *   Reply ↑/↓. A snoozed item says until when, with Unsnooze. Then its description, close note, chat and Done means.
 * - Activity: comments as cards (the bot's as Markdown, the owner's as typed), one muted line for everything else
 *   (made, edited with before and after, status with its note, reopened, linked, snoozed, back early, a linked
 *   session's report), the open question as a card whose quick replies answer several questions at once, and a
 *   Waiting card last while it waits.
 * - The comment box: a reply to the open question names it ("Replying to: …", hideable); sent at once with a
 *   request id, so a resend never posts twice (`item-store.ts`).
 */
import {
	AlarmClock,
	AlarmClockOff,
	ArrowDown,
	ArrowLeft,
	ArrowUp,
	ChevronDown,
	ChevronUp,
	CircleCheck,
	CircleX,
	FileText,
	GitMerge,
	GitPullRequest,
	GitPullRequestClosed,
	GitPullRequestDraft,
	House,
	Link,
	MessageSquare,
	Pencil,
	Play,
	Plus,
	Send,
	X,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Bot, Item, ItemEvent, ItemLink, ItemQuestion } from "../../../../shared/bots";
import { cx, formatClock, formatTimeAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { actionKbd, chordFromEvent, compileKeymap, KEYMAP_ACTIONS } from "../../../lib/keymap";
import { MarkdownRenderer } from "../../../lib/markdown";
import { openExternal } from "../../../lib/open-external";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";
import {
	Button,
	Card,
	ChoiceList,
	type ContextMenuItem,
	IconButton,
	LinkButton,
	MenuButton,
	PathText,
	TextArea,
} from "../../common";
import { openBotChat } from "../bot-launch";
import { formatSnooze } from "./BotItemDialogs";
import { snoozeMenu, useItemMoves } from "./BotItems";
import { ItemStatusIcon, itemLive, statusName } from "./ItemStatusIcon";
import {
	answersText,
	decisionsOf,
	isClosed,
	isCommentEvent,
	isReopen,
	isSnoozed,
	PICKER_STATUSES,
	questionLine,
} from "./item-model";
import {
	discardComment,
	heldAnswers,
	holdAnswers,
	type PendingComment,
	retryComment,
	sendComment,
	setDraft,
	useItemsUi,
} from "./item-store";
import { useItemPr } from "./use-item-pr";

type T = (key: string, params?: Record<string, string | number>) => string;

/** The item page's own keys, as the person bound them. */
function itemKey(event: KeyboardEvent): "back" | "previous" | "next" | null {
	const chord = chordFromEvent(event.nativeEvent);
	if (!chord) return null;
	const action = compileKeymap(KEYMAP_ACTIONS, useUiStore.getState().keymapOverrides).get(chord);
	return action === "botItem.back"
		? "back"
		: action === "botItem.previous"
			? "previous"
			: action === "botItem.next"
				? "next"
				: null;
}

/** Opens a session an item links: the tab holding it, else a tab of its own. */
function openLinkedSession(path: string): void {
	const tabs = useTabsStore.getState();
	const held = tabs.tabs.find(tab => (tab.sessionPath === path || tab.id === path) && !tab.device);
	useUiStore.getState().closeDestination();
	if (held) void tabs.switchTab(held.id);
	else void tabs.openTab({ sessionPath: path }).catch(() => {});
}

export function BotItemPage({
	bot,
	item,
	order,
	onBack,
	onStep,
}: {
	bot: Bot;
	item: Item;
	/** The list's order, for previous and next. */
	order: readonly string[];
	onBack: () => void;
	onStep: (id: string) => void;
}) {
	const t = useT();
	const overrides = useUiStore(s => s.keymapOverrides);
	const moves = useItemMoves();
	const root = useRef<HTMLDivElement>(null);
	const questionRef = useRef<HTMLDivElement>(null);
	const boxRef = useRef<HTMLTextAreaElement>(null);
	const [questionPlace, setQuestionPlace] = useState<"visible" | "above" | "below">("visible");
	const at = order.indexOf(item.id);
	const previous = at > 0 ? order[at - 1] : undefined;
	const next = at >= 0 ? order[at + 1] : undefined;
	const now = Date.now();
	const open = !isClosed(item.status);
	const question = item.status === "needs_you" ? item.question : undefined;

	// Reply ↑/↓ shows only while the question's card is off screen.
	// biome-ignore lint/correctness/useExhaustiveDependencies: each new question mounts its own card to watch
	useEffect(() => {
		const card = questionRef.current;
		if (!card || typeof IntersectionObserver === "undefined") {
			setQuestionPlace("visible");
			return;
		}
		const observer = new IntersectionObserver(([entry]) => {
			if (!entry) return;
			if (entry.isIntersecting) setQuestionPlace("visible");
			else setQuestionPlace(entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0) ? "above" : "below");
		});
		observer.observe(card);
		return () => observer.disconnect();
	}, [question?.id]);

	const jumpToQuestion = () => {
		const card = questionRef.current;
		if (!card) return;
		card.scrollIntoView({ block: "center", behavior: "smooth" });
		card.animate?.([{ outlineColor: "var(--sc-attention)" }, { outlineColor: "transparent" }], {
			duration: 1400,
			easing: "ease",
		});
		boxRef.current?.focus();
	};

	const statusItems: ContextMenuItem[] = [
		...PICKER_STATUSES.map(
			(status): ContextMenuItem => ({
				id: status,
				label: statusName(status, t, true),
				checked: status === item.status,
				// Waiting again edits what it waits on.
				disabled: status === item.status && status !== "waiting",
				onSelect: () => moves.move([item], status),
			}),
		),
		...(open ? snoozeMenu([item], moves, t, true) : []),
	];

	return (
		<div
			className="flex min-h-0 flex-1 flex-col"
			data-bot-item-page={item.id}
			onKeyDown={event => {
				if (event.defaultPrevented || isImeKeyEvent(event)) return;
				const key = itemKey(event);
				if (!key) return;
				event.preventDefault();
				event.stopPropagation();
				if (event.repeat) return;
				if (key === "back") onBack();
				else if (key === "previous" && previous) onStep(previous);
				else if (key === "next" && next) onStep(next);
			}}
			ref={root}
			tabIndex={-1}
		>
			<div className="flex items-center gap-1 border-b border-(--sc-border-subtle) px-3 py-1.5" data-bot-item-nav>
				<Button icon={<ArrowLeft />} onClick={onBack} size="sm" variant="ghost">
					{t("bots.items.view.back")}
				</Button>
				<span className="flex-1" />
				{at >= 0 && (
					<span className="text-sc-xs tabular-nums text-(--sc-text-muted)">
						{t("bots.items.view.place", { index: at + 1, total: order.length })}
					</span>
				)}
				<IconButton
					data-bot-item-step="previous"
					disabled={!previous}
					icon={<ChevronUp />}
					label={t("bots.items.view.previous")}
					onClick={() => previous && onStep(previous)}
					shortcut={actionKbd("botItem.previous", overrides)}
					size="sm"
				/>
				<IconButton
					data-bot-item-step="next"
					disabled={!next}
					icon={<ChevronDown />}
					label={t("bots.items.view.next")}
					onClick={() => next && onStep(next)}
					shortcut={actionKbd("botItem.next", overrides)}
					size="sm"
				/>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="flex flex-col gap-3 px-4 pt-3">
					<h2 className="text-sc-md font-semibold" title={item.title}>
						<span className="tabular-nums text-(--sc-text-subtle)">#{item.number}</span> {item.title}
					</h2>
					<div className="flex min-w-0 flex-wrap items-center gap-1">
						<MenuButton items={statusItems} label={t("bots.items.view.statusLabel")} size="sm" variant="ghost">
							<span className="flex items-center gap-1.5" data-bot-item-status={item.status}>
								<ItemStatusIcon live={itemLive(item)} status={item.status} />
								{statusName(item.status, t)}
							</span>
						</MenuButton>
						{item.links.map(link => (
							<LinkChip key={`${link.kind}:${link.ref}`} link={link} />
						))}
						{question && questionPlace !== "visible" && (
							<Button
								className="ml-auto"
								data-bot-item-reply-jump={questionPlace}
								icon={questionPlace === "above" ? <ArrowUp /> : <ArrowDown />}
								onClick={jumpToQuestion}
								size="sm"
								variant="secondary"
							>
								{t("bots.items.view.reply")}
							</Button>
						)}
					</div>
					{item.snoozedUntil && isSnoozed(item, now) && (
						<div className="flex items-center gap-2 text-sc-xs text-(--sc-text-muted)" data-bot-item-snoozed>
							<AlarmClock aria-hidden className="size-3.5" />
							<span className="flex-1">
								{t("bots.items.snooze.until", { when: formatSnooze(Date.parse(item.snoozedUntil), now) })}
							</span>
							<Button onClick={() => moves.snooze([item], null)} size="sm" variant="secondary">
								{t("bots.items.snooze.unsnooze")}
							</Button>
						</div>
					)}
					{item.description && (
						<div className="text-sc-sm" data-bot-item-description>
							<MarkdownRenderer content={item.description} />
						</div>
					)}
					{!open && item.closeNote && (
						<p className="text-sc-sm text-(--sc-text-muted)">
							{item.status === "canceled" ? t("bots.items.view.canceledNote") : t("bots.items.view.doneNote")}{" "}
							<span className="text-(--sc-text)">{item.closeNote}</span>
						</p>
					)}
					<dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 text-sc-xs">
						<dt className="text-(--sc-text-muted)">{t("bots.items.field.chat")}</dt>
						<dd>
							<LinkButton onClick={() => void openBotChat(bot, item.session).catch(() => {})} tone="inherit">
								<span className="inline-flex items-center gap-1">
									{item.session === bot.home ? (
										<House aria-hidden className="size-3" />
									) : (
										<MessageSquare aria-hidden className="size-3" />
									)}
									{item.session === bot.home ? t("bots.chats.home") : t("bots.items.chatFallback")}
								</span>
							</LinkButton>
						</dd>
						{item.doneMeans && (
							<>
								<dt className="text-(--sc-text-muted)">{t("bots.items.field.doneMeans")}</dt>
								<dd>{item.doneMeans}</dd>
							</>
						)}
					</dl>
				</div>
				<section aria-label={t("bots.items.view.activity")} className="mt-4 px-4 pb-4" data-bot-item-activity>
					<h3 className="mb-2 text-sc-xs font-medium text-(--sc-text-muted)">{t("bots.items.view.activity")}</h3>
					<Activity bot={bot} item={item} questionRef={questionRef} t={t} />
				</section>
			</div>
			<CommentBox bot={bot} boxRef={boxRef} item={item} question={question} t={t} />
			{moves.dialog}
		</div>
	);
}

/** One link of the item: a session with its state, a PR with its live state, an address, a file. */
function LinkChip({ link }: { link: ItemLink }) {
	if (link.kind === "pr") return <PrChip link={link} />;
	if (link.kind === "session") return <SessionChip link={link} />;
	if (link.kind === "url")
		return (
			<Button icon={<Link />} onClick={() => openExternal(link.ref)} size="sm" variant="ghost">
				<span className="max-w-48 truncate">{link.title ?? link.ref.replace(/^https?:\/\//, "")}</span>
			</Button>
		);
	if (link.kind === "file")
		return (
			<Button
				icon={<FileText />}
				onClick={() => void window.omp.system.openPath(link.ref).catch(() => {})}
				size="sm"
				variant="ghost"
			>
				<PathText className="max-w-48" path={link.ref} />
			</Button>
		);
	return null;
}

function SessionChip({ link }: { link: ItemLink }) {
	const t = useT();
	const tab = useTabsStore(s => s.tabs.find(entry => entry.sessionPath === link.ref || entry.id === link.ref));
	const state = link.state ?? "done";
	const glyph =
		state === "working" || state === "waiting" ? (
			<ItemStatusIcon live status="working" />
		) : state === "failed" || state === "stopped" ? (
			<CircleX aria-hidden className="size-3.5 text-(--sc-danger)" />
		) : (
			<CircleCheck aria-hidden className="size-3.5 text-(--sc-success)" />
		);
	const name = link.title ?? tab?.title ?? t("bots.items.link.session");
	return (
		<Button
			data-bot-item-link="session"
			icon={glyph}
			onClick={() => openLinkedSession(link.ref)}
			size="sm"
			title={`${name} · ${t(`bots.items.link.state.${state}`)}`}
			variant="ghost"
		>
			<span className="max-w-40 truncate">{name}</span>
		</Button>
	);
}

const PR_ICONS = { open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed };
const PR_TONES = {
	open: "text-(--sc-success)",
	draft: "text-(--sc-text-muted)",
	merged: "text-(--sc-info)",
	closed: "text-(--sc-danger)",
};

function PrChip({ link }: { link: ItemLink }) {
	const t = useT();
	const pr = useItemPr(link.ref);
	if (!pr)
		return (
			<Button icon={<GitPullRequest />} onClick={() => openExternal(link.ref)} size="sm" variant="ghost">
				{link.ref}
			</Button>
		);
	const Icon = pr.state ? PR_ICONS[pr.state] : GitPullRequest;
	// CI only where it can still change, once it has an outcome.
	const ci = (pr.state === "open" || pr.state === "draft") && (pr.checks === "success" || pr.checks === "failure");
	const tip = [
		pr.state ? t(`bots.items.link.pr.${pr.state}`) : t("bots.items.link.notRead"),
		ci ? t(`bots.items.link.checks.${pr.checks}`) : null,
		pr.repo,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<Button
			data-bot-item-link="pr"
			data-pr-state={pr.state ?? "unknown"}
			icon={<Icon className={pr.state ? PR_TONES[pr.state] : "text-(--sc-text-muted)"} />}
			onClick={() => openExternal(pr.url)}
			size="sm"
			title={tip}
			variant="ghost"
		>
			<span className="max-w-48 truncate">{pr.title ?? t("bots.items.link.prNumber", { number: pr.number })}</span>
			{pr.title && <span className="text-(--sc-text-subtle)">#{pr.number}</span>}
			{ci &&
				(pr.checks === "success" ? (
					<CircleCheck aria-label={t("bots.items.link.checks.success")} className="size-3 text-(--sc-success)" />
				) : (
					<CircleX aria-label={t("bots.items.link.checks.failure")} className="size-3 text-(--sc-danger)" />
				))}
		</Button>
	);
}

/** The item's events: comments as cards, the rest as muted lines; the open question as its card; Waiting last. */
function Activity({
	bot,
	item,
	questionRef,
	t,
}: {
	bot: Bot;
	item: Item;
	questionRef: React.RefObject<HTMLDivElement | null>;
	t: T;
}) {
	const pending = useItemsUi(s => s.pending[item.id]);
	const question = item.status === "needs_you" ? item.question : undefined;
	const comments = item.events.some(isCommentEvent) || (pending?.length ?? 0) > 0;
	return (
		<div className="flex flex-col gap-1.5">
			{item.events.map(event =>
				event.kind === "asked" && question && event.id === question.id ? (
					<QuestionCard
						bot={bot}
						event={event}
						item={item}
						key={event.id}
						question={question}
						questionRef={questionRef}
					/>
				) : isCommentEvent(event) ? (
					<CommentCard bot={bot} event={event} item={item} key={event.id} t={t} />
				) : (
					<EventLine event={event} key={event.id} t={t} />
				),
			)}
			{item.status === "waiting" && item.wait && (
				<Card data-bot-item-wait-card padding="row" surface="elevated">
					<p className="flex items-center gap-1.5 text-sc-xs font-medium">
						<ItemStatusIcon status="waiting" />
						{t("bots.items.activity.waitingOn")}
						{item.wait.at && (
							<span className="ml-auto font-normal text-(--sc-text-subtle)">{formatTimeAgo(item.wait.at)}</span>
						)}
					</p>
					<p className="mt-1 text-sc-sm">{item.wait.text}</p>
				</Card>
			)}
			{pending?.map(entry => (
				<PendingCard entry={entry} item={item} key={entry.requestId} t={t} />
			))}
			{!comments && <p className="text-sc-xs text-(--sc-text-muted)">{t("bots.items.activity.noComments")}</p>}
		</div>
	);
}

function CommentCard({ bot, item, event, t }: { bot: Bot; item: Item; event: ItemEvent; t: T }) {
	const who = event.actor === "owner" ? t("bots.items.activity.you") : bot.name;
	// An answer names the question it answers.
	const answered =
		event.kind === "answered" && event.question !== undefined
			? item.events.find(asked => asked.id === event.question && asked.kind === "asked")
			: undefined;
	return (
		<Card data-bot-item-comment={event.id} padding="row">
			<p className="flex items-center gap-1.5 text-sc-xs">
				<span className="font-medium">{who}</span>
				{event.kind === "asked" && <span className="text-(--sc-text-muted)">{t("bots.items.activity.asked")}</span>}
				<span className="ml-auto text-(--sc-text-subtle)" title={formatClock(event.at)}>
					{formatTimeAgo(event.at)}
				</span>
			</p>
			{answered?.text && (
				<p className="mt-1 truncate border-l-2 border-(--sc-border-subtle) pl-2 text-sc-xs text-(--sc-text-muted)">
					{questionLine(answered.text)}
				</p>
			)}
			<div className="mt-1 text-sc-sm">
				<MarkdownRenderer content={event.text ?? ""} userText={event.actor === "owner"} />
			</div>
		</Card>
	);
}

function PendingCard({ item, entry, t }: { item: Item; entry: PendingComment; t: T }) {
	return (
		<Card data-bot-item-pending={entry.failed ? "failed" : "sending"} padding="row">
			<p className="flex items-center gap-1.5 text-sc-xs">
				<span className="font-medium">{t("bots.items.activity.you")}</span>
				<span className={cx("ml-auto", entry.failed ? "text-(--sc-danger)" : "text-(--sc-text-subtle)")}>
					{entry.failed ? t("bots.items.comment.notSent") : t("bots.items.comment.sending")}
				</span>
			</p>
			<div className="mt-1 text-sc-sm">
				<MarkdownRenderer content={entry.text} userText />
			</div>
			{entry.failed && (
				<div className="mt-1 flex gap-1">
					<Button onClick={() => retryComment(item.id, entry.requestId)} size="sm" variant="secondary">
						{t("common.retry")}
					</Button>
					<Button onClick={() => discardComment(item.id, entry.requestId)} size="sm" variant="ghost">
						{t("bots.items.comment.discard")}
					</Button>
				</div>
			)}
		</Card>
	);
}

/** One muted line: who did what, and when. */
function EventLine({ event, t }: { event: ItemEvent; t: T }) {
	const workerTitle = useTabsStore(s =>
		event.kind === "worker" ? s.tabs.find(tab => tab.sessionPath === event.link)?.title : undefined,
	);
	const [open, setOpen] = useState(false);
	const by = event.actor === "owner" ? t("bots.items.activity.you") : t("bots.items.activity.bot");
	let icon: ReactNode = null;
	let body: ReactNode = null;
	switch (event.kind) {
		case "made":
			icon = <Plus className="size-3" />;
			body =
				event.text === "needs_you"
					? t("bots.items.activity.madeNeedsYou", { by })
					: t("bots.items.activity.made", { by });
			break;
		case "edited": {
			icon = <Pencil className="size-3" />;
			const field = t(`bots.items.field.${event.field ?? "title"}Lower`);
			body = (
				<span className="flex flex-col">
					<LinkButton onClick={() => setOpen(!open)} tone="inherit">
						{t("bots.items.activity.changed", { by, field })} {open ? "▾" : "›"}
					</LinkButton>
					{open && (
						<span className="mt-0.5 flex flex-col gap-px border-l-2 border-(--sc-border-subtle) pl-2">
							{event.before && <del className="text-(--sc-text-muted)">{event.before}</del>}
							{event.after && <span className="text-(--sc-text)">{event.after}</span>}
						</span>
					)}
				</span>
			);
			break;
		}
		case "status": {
			const to = event.text ?? "";
			icon = PICKER_STATUSES.includes(to as Item["status"]) ? (
				<ItemStatusIcon status={to as Item["status"]} />
			) : null;
			const said =
				to === "done"
					? t("bots.items.activity.closed", { by })
					: to === "canceled"
						? t("bots.items.activity.canceled", { by })
						: isReopen(event)
							? t("bots.items.activity.reopened", { by })
							: event.from === to
								? t("bots.items.activity.waitEdited", { by })
								: t("bots.items.activity.moved", { by, status: statusName(to as Item["status"], t) });
			body = event.note ? `${said}: ${event.note}` : said;
			break;
		}
		case "linked":
			icon = <Play className="size-3" />;
			body = t("bots.items.activity.linked", { by, link: event.text ?? "" });
			break;
		case "snoozed":
			icon = <AlarmClock className="size-3" />;
			body = event.text
				? t("bots.items.activity.snoozed", { by, when: formatSnooze(Date.parse(event.text), Date.parse(event.at)) })
				: t("bots.items.activity.snoozedBare", { by });
			break;
		case "unsnoozed":
			icon = <AlarmClockOff className="size-3" />;
			body = event.early ? t("bots.items.activity.snoozeEnded") : t("bots.items.activity.unsnoozed", { by });
			break;
		case "worker": {
			const stopped = event.state === "blocked";
			icon = stopped ? <CircleX className="size-3" /> : <CircleCheck className="size-3" />;
			body = (
				<>
					{stopped ? t("bots.items.activity.workerStopped") : t("bots.items.activity.workerFinished")}{" "}
					<span className="font-medium">{workerTitle ?? t("bots.items.link.session")}</span>
					{event.text && <span className="block">{event.text}</span>}
				</>
			);
			break;
		}
		default:
			return null;
	}
	return (
		<div
			className="flex items-start gap-2 py-0.5 text-sc-xs leading-5 text-(--sc-text-muted)"
			data-bot-item-event={event.kind}
		>
			<span aria-hidden className="flex h-5 w-4 shrink-0 items-center justify-center">
				{icon}
			</span>
			<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{body}</span>
			<span className="shrink-0 text-(--sc-text-subtle)" title={formatClock(event.at)}>
				{formatTimeAgo(event.at)}
			</span>
		</div>
	);
}

/**
 * The open question (Orca's `BotItemQuestionStep.tsx`): the bot's words, then each question with its quick replies
 * (several picks where it allows them, the recommended one marked) and Type your answer, which fills the comment box.
 * Picks are held on this device until sent; Send answers every picked question in one comment.
 */
function QuestionCard({
	bot,
	item,
	event,
	question,
	questionRef,
}: {
	bot: Bot;
	item: Item;
	event: ItemEvent;
	question: ItemQuestion;
	questionRef: React.RefObject<HTMLDivElement | null>;
}) {
	const t = useT();
	const decisions = useMemo(() => decisionsOf(question), [question]);
	const qid = question.id ?? 0;
	const [answers, setAnswers] = useState<(string | null)[]>(() => heldAnswers(item.id, qid, decisions.length));
	const headId = useId();
	const pending = useItemsUi(s => (s.pending[item.id] ?? []).some(entry => !entry.failed && entry.question === qid));
	const hold = (next: (string | null)[]) => {
		setAnswers(next);
		holdAnswers(item.id, qid, next);
	};
	const pick = (index: number, label: string, multi: boolean) => {
		const next = [...answers];
		if (multi) {
			const picked = (next[index] ?? "").split(", ").filter(Boolean);
			const at = picked.indexOf(label);
			if (at >= 0) picked.splice(at, 1);
			else picked.push(label);
			next[index] = picked.length > 0 ? picked.join(", ") : null;
		} else next[index] = next[index] === label ? null : label;
		hold(next);
		// One question with one pick answers at once, as a quick reply does.
		if (decisions.length === 1 && !multi && next[0]) send(next);
	};
	const send = (picked = answers) => {
		const text = answersText(question, picked);
		if (!text) return;
		sendComment(item.id, text, question.id);
		hold(decisions.map(() => null));
	};
	const count = answers.filter(Boolean).length;
	const several = decisions.length > 1;
	return (
		<div
			className="rounded-(--sc-radius-md) outline-2 outline-transparent"
			data-bot-item-question={qid}
			ref={questionRef}
		>
			<Card padding="row" surface="elevated">
				<p className="flex items-center gap-1.5 text-sc-xs">
					<span className="font-medium">{bot.name}</span>
					<span className="text-(--sc-attention)">{t("bots.items.ask.needsYou")}</span>
					<span className="ml-auto text-(--sc-text-subtle)" title={formatClock(event.at)}>
						{formatTimeAgo(event.at)}
					</span>
				</p>
				{question.text && (
					<div className="mt-1 text-sc-sm" id={headId}>
						<MarkdownRenderer content={question.text} />
					</div>
				)}
				{decisions.map((decision, index) => (
					<div
						className={cx("mt-2", index > 0 && "border-t border-(--sc-border-subtle) pt-2")}
						key={decision.question}
					>
						{(several || !question.text) && (
							<div className="text-sc-sm font-semibold" id={`${headId}-${index}`}>
								<MarkdownRenderer content={decision.question} />
							</div>
						)}
						{decision.options.length > 0 && (
							<div className="mt-1.5">
								<ChoiceList
									choices={decision.options.map((option, at) => ({
										key: option,
										label: option,
										aside:
											decision.recommended === at ? (
												<span className="text-sc-xs text-(--sc-text-muted)">
													{t("bots.items.ask.recommended")}
												</span>
											) : undefined,
									}))}
									labelledBy={several || !question.text ? `${headId}-${index}` : headId}
									mode={decision.multi ? "multi" : "single"}
									onChoose={key => pick(index, key, decision.multi === true)}
									selected={new Set((answers[index] ?? "").split(", ").filter(Boolean))}
								/>
							</div>
						)}
						{answers[index] && !decision.options.includes(answers[index] ?? "") && !decision.multi && (
							<p className="mt-1 flex items-center gap-1.5 text-sc-xs text-(--sc-text-muted)">
								<Pencil aria-hidden className="size-3" />
								{answers[index]}
							</p>
						)}
					</div>
				))}
				{(several || decisions.some(decision => decision.multi)) && (
					<div className="mt-3 flex justify-end">
						<Button
							data-bot-item-answers-send
							disabled={count === 0}
							loading={pending}
							onClick={() => send()}
							size="sm"
							variant="primary"
						>
							{count > 0 && count < decisions.length
								? t("bots.items.ask.sendSome", { count, total: decisions.length })
								: t("bots.items.ask.send")}
						</Button>
					</div>
				)}
			</Card>
		</div>
	);
}

/** The comment box: words for the bot, or the answer to its open question, which it names above the text. */
function CommentBox({
	bot,
	item,
	question,
	boxRef,
	t,
}: {
	bot: Bot;
	item: Item;
	question: ItemQuestion | undefined;
	boxRef: React.RefObject<HTMLTextAreaElement | null>;
	t: T;
}) {
	const draft = useItemsUi(s => s.drafts[item.id] ?? "");
	const [hidden, setHidden] = useState<number | null>(null);
	const replying = question && hidden !== question.id ? question : undefined;
	const send = () => {
		const text = draft.trim();
		if (!text) return;
		// Words typed while a question waits answer it; with the mark hidden they are a comment of their own.
		sendComment(item.id, text, replying ? replying.id : undefined);
		setDraft(item.id, "");
	};
	const line = replying ? questionLine(replying.decisions?.[0]?.question ?? replying.text) : "";
	return (
		<div className="border-t border-(--sc-border-subtle) px-3 py-2" data-bot-item-comment-box>
			{replying && line && (
				<div
					className="mb-1 flex min-w-0 items-center gap-1 text-sc-xs text-(--sc-text-muted)"
					data-bot-item-replying
				>
					<span aria-hidden className="size-1.5 shrink-0 rounded-full bg-(--sc-attention)" />
					<span className="min-w-0 flex-1 truncate">
						{t("bots.items.comment.replyingTo")} <span className="text-(--sc-text)">{line}</span>
					</span>
					<IconButton
						icon={<X />}
						label={t("bots.items.comment.hideReplyingTo")}
						onClick={() => setHidden(replying.id ?? 0)}
						size="sm"
					/>
				</div>
			)}
			<div className="flex items-end gap-2">
				<TextArea
					aria-label={t("bots.items.comment.label")}
					autoGrow
					className="min-w-0 flex-1"
					maxLength={8000}
					onChange={event => setDraft(item.id, event.target.value)}
					onKeyDown={event => {
						if (isImeKeyEvent(event)) return;
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							send();
						}
					}}
					placeholder={
						replying
							? replying.options.length > 0 || replying.decisions?.length
								? t("bots.items.comment.replyOrPick")
								: t("bots.items.comment.replyTo", { name: bot.name })
							: t("bots.items.comment.add")
					}
					ref={boxRef}
					rows={1}
					value={draft}
				/>
				<IconButton
					disabled={!draft.trim()}
					icon={<Send />}
					label={t("bots.items.comment.send")}
					onClick={send}
					shortcut="⌘↵"
					variant="primary"
				/>
			</div>
		</div>
	);
}
