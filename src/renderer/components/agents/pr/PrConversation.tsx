/**
 * A pull request's conversation in the PR Center detail, one GraphQL read (`pr_conversation`): comments, reviews and
 * review threads with the timeline's events between them in time order (Orca `discuss-item/conversation-tab-*.tsx`).
 * A review thread shows the code it sits on (the diff hunk's last lines, Orca `CommentCodeContext.tsx`), takes a reply
 * inside it (Orca `conversation/reply.ts`) and is resolved or reopened (Orca `resolve-review-thread.ts`); a resolved
 * thread is folded. Every comment and review takes reactions (Orca `CommentReactions.tsx`). Private image attachments
 * show through the signed URLs GitHub rendered for them (Orca `body-image-urls.ts`). The box at the end comments,
 * approves or asks for changes, with Preview, @mentions and pasted images (`MarkdownComposer`).
 */
import {
	CheckCircle2,
	GitCommit,
	MessageSquare,
	RefreshCw,
	SmilePlus,
	Sparkles,
	Tag,
	UserRound,
	XCircle,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import {
	GITHUB_REACTIONS,
	type GithubImageMap,
	type GithubPrConversation,
	type GithubReactionContent,
	type GithubReactionCount,
	type GithubReviewThread,
	type GithubThreadComment,
	type GithubTimelineEvent,
} from "../../../../shared/github";
import type { RpcCommand, RpcPrComments, RpcPrDetail } from "../../../../shared/rpc-types";
import { DiffView } from "../../../lib/diff";
import { addressCommentsPrompt } from "../../../lib/fix-prompts";
import { type GithubLoad, github } from "../../../lib/github";
import { uploadGithubImage, useGithubImages } from "../../../lib/github-image";
import { useT } from "../../../lib/i18n";
import { MarkdownRenderer } from "../../../lib/markdown";
import { usePrCenterStore } from "../../../stores/pr-center";
import { toast, toastError } from "../../../stores/toast";
import {
	Badge,
	type BadgeVariant,
	Button,
	Card,
	Chip,
	Collapse,
	DisclosureButton,
	IconButton,
	InlineNotice,
	LinkButton,
	MarkdownComposer,
	Popover,
	Skeleton,
	TimeAgo,
} from "../../common";
import { handToPrCheckout } from "./PrActions";
import { useAssignable } from "./PrPeople";

const REACTION_GLYPH: Record<GithubReactionContent, string> = {
	THUMBS_UP: "👍",
	THUMBS_DOWN: "👎",
	LAUGH: "😄",
	HOORAY: "🎉",
	CONFUSED: "😕",
	HEART: "❤️",
	ROCKET: "🚀",
	EYES: "👀",
};

const REVIEW_STATE_TONE: Record<string, BadgeVariant> = {
	APPROVED: "success",
	CHANGES_REQUESTED: "error",
};

/** The lines of a thread's code shown above it, at most. */
const CONTEXT_LINES = 6;

/**
 * The last `keep` lines of a diff hunk under a header whose starts are moved past the lines left out, so the gutter
 * numbers stay true (Orca `pr-comment-code-context.ts`).
 */
export function hunkTail(hunk: string, keep = CONTEXT_LINES): string {
	const [header, ...lines] = hunk.split("\n");
	const found = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header ?? "");
	if (!found || lines.length <= keep) return hunk;
	const dropped = lines.slice(0, lines.length - keep);
	const tail = lines.slice(lines.length - keep);
	const old = Number(found[1]) + dropped.filter(line => !line.startsWith("+")).length;
	const added = Number(found[2]) + dropped.filter(line => !line.startsWith("-")).length;
	const count = (sign: string) => tail.filter(line => !line.startsWith(sign)).length;
	return [`@@ -${old},${count("+")} +${added},${count("-")} @@`, ...tail].join("\n");
}

/** The conversation's items in time order: comments, reviews, threads (at their first comment) and events. */
type Item =
	| { kind: "comment"; at: string; comment: GithubThreadComment }
	| { kind: "review"; at: string; review: GithubPrConversation["reviews"][number] }
	| { kind: "thread"; at: string; thread: GithubReviewThread }
	| { kind: "event"; at: string; event: GithubTimelineEvent };

function items(conversation: GithubPrConversation): Item[] {
	return [
		...conversation.comments.map(comment => ({ kind: "comment" as const, at: comment.createdAt, comment })),
		...conversation.reviews.map(review => ({ kind: "review" as const, at: review.createdAt, review })),
		...conversation.threads.map(thread => ({
			kind: "thread" as const,
			at: thread.comments[0]?.createdAt ?? "",
			thread,
		})),
		...conversation.timeline.map(event => ({ kind: "event" as const, at: event.createdAt, event })),
	].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** A body's Markdown with its private attachments shown. */
function Body({ body, images }: { body: string; images?: GithubImageMap }) {
	const shown = useGithubImages(body, images);
	return body.trim() ? (
		<div className="text-sc-sm">
			<MarkdownRenderer content={shown} />
		</div>
	) : null;
}

function Reactions({
	subjectId,
	reactions,
	onChanged,
}: {
	subjectId: string;
	reactions: readonly GithubReactionCount[];
	onChanged: () => void;
}) {
	const t = useT();
	const anchor = useRef<HTMLButtonElement>(null);
	const [picking, setPicking] = useState(false);
	const [busy, setBusy] = useState(false);
	const react = async (content: GithubReactionContent, add: boolean) => {
		setPicking(false);
		setBusy(true);
		try {
			await github({ op: "reaction", subjectId, content, add });
		} catch (error) {
			toastError({ title: t("prCenter.reactions.failed"), error });
		} finally {
			setBusy(false);
			onChanged();
		}
	};
	return (
		<div className="flex flex-wrap items-center gap-1" data-pr-reactions>
			{reactions.map(reaction => (
				<Chip
					disabled={busy}
					key={reaction.content}
					onPressedChange={pressed => void react(reaction.content, pressed)}
					pressed={reaction.viewerHasReacted}
					tooltip={t(`prCenter.reactions.${reaction.content}`)}
				>
					<span aria-hidden>{REACTION_GLYPH[reaction.content]}</span>
					<span className="sr-only">{t(`prCenter.reactions.${reaction.content}`)}</span>
					<span className="tabular-nums">{reaction.count}</span>
				</Chip>
			))}
			<IconButton
				disabled={busy}
				icon={<SmilePlus />}
				label={t("prCenter.reactions.add")}
				onClick={() => setPicking(true)}
				ref={anchor}
				size="sm"
			/>
			<Popover
				anchorRef={anchor}
				ariaLabel={t("prCenter.reactions.add")}
				onClose={() => setPicking(false)}
				open={picking}
			>
				<div className="flex gap-1">
					{GITHUB_REACTIONS.map(content => (
						<IconButton
							icon={<span aria-hidden>{REACTION_GLYPH[content]}</span>}
							key={content}
							label={t(`prCenter.reactions.${content}`)}
							onClick={() =>
								void react(content, !reactions.some(r => r.content === content && r.viewerHasReacted))
							}
							size="sm"
						/>
					))}
				</div>
			</Popover>
		</div>
	);
}

function CommentBody({
	author,
	createdAt,
	badge,
	body,
	images,
	subjectId,
	reactions,
	onChanged,
}: {
	author: string;
	createdAt: string;
	badge?: ReactNode;
	body: string;
	images?: GithubImageMap;
	subjectId: string;
	reactions: readonly GithubReactionCount[];
	onChanged: () => void;
}) {
	return (
		<div className="flex flex-col gap-1">
			<div className="flex flex-wrap items-center gap-2 text-sc-xs text-(--sc-text-muted)">
				<span className="text-(--sc-text-secondary)">@{author}</span>
				{badge}
				<TimeAgo className="ml-auto" iso={createdAt} />
			</div>
			<Body body={body} images={images} />
			{subjectId && <Reactions onChanged={onChanged} reactions={reactions} subjectId={subjectId} />}
		</div>
	);
}

function Thread({
	thread,
	number,
	mentions,
	open: prOpen,
	onChanged,
}: {
	thread: GithubReviewThread;
	number: number;
	mentions: readonly string[];
	open: boolean;
	onChanged: () => void;
}) {
	const t = useT();
	const [shown, setShown] = useState(!thread.isResolved);
	const [replying, setReplying] = useState(false);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState<"reply" | "resolve" | null>(null);
	const first = thread.comments[0];
	const reply = async () => {
		if (!first?.databaseId || !text.trim()) return;
		setBusy("reply");
		try {
			await github({ op: "thread_reply", number, commentId: first.databaseId, body: text });
			setText("");
			setReplying(false);
			toast({ variant: "success", message: t("prCenter.thread.replied") });
		} catch (error) {
			toastError({ title: t("prCenter.thread.replyFailed"), error });
		} finally {
			setBusy(null);
			onChanged();
		}
	};
	const resolve = async () => {
		setBusy("resolve");
		try {
			await github({ op: "thread_resolve", threadId: thread.id, resolved: !thread.isResolved });
		} catch (error) {
			toastError({ title: t("prCenter.thread.resolveFailed"), error });
		} finally {
			setBusy(null);
			onChanged();
		}
	};
	return (
		<Card className="flex flex-col" data-pr-thread={thread.id} padding="none">
			<DisclosureButton
				className="gap-2 px-3 py-2 text-sc-xs hover:bg-(--sc-hover)"
				onToggle={() => setShown(!shown)}
				open={shown}
			>
				<span className="min-w-0 truncate font-mono text-(--sc-text-secondary)">
					{thread.path}
					{thread.line ? `:${thread.line}` : ""}
				</span>
				{thread.isResolved && <Badge variant="muted">{t("prCenter.thread.resolved")}</Badge>}
				<span className="ml-auto shrink-0 text-(--sc-text-muted)">
					{t("prCenter.thread.count", { count: String(thread.comments.length) })}
				</span>
			</DisclosureButton>
			<Collapse open={shown}>
				<div className="flex flex-col gap-3 border-t border-(--sc-divider) px-3 py-3">
					{thread.diffHunk && (
						<div
							className="overflow-x-auto rounded-(--sc-radius-md) bg-(--sc-surface-1) py-1"
							data-pr-thread-code
						>
							<DiffView diff={hunkTail(thread.diffHunk)} filePath={thread.path} />
						</div>
					)}
					{thread.comments.map(comment => (
						<CommentBody
							author={comment.author}
							body={comment.body}
							createdAt={comment.createdAt}
							images={comment.images}
							key={comment.id}
							onChanged={onChanged}
							reactions={comment.reactions}
							subjectId={comment.id}
						/>
					))}
					{prOpen && (
						<div className="flex flex-wrap items-center gap-2">
							{replying ? (
								<div className="flex w-full flex-col gap-2">
									<MarkdownComposer
										ariaLabel={t("prCenter.thread.replyLabel")}
										mentions={mentions}
										onChange={setText}
										onImage={file => uploadGithubImage(file)}
										onSubmit={() => void reply()}
										placeholder={t("prCenter.thread.replyLabel")}
										rows={2}
										value={text}
									/>
									<div className="flex justify-end gap-2">
										<Button onClick={() => setReplying(false)} size="sm" variant="ghost">
											{t("common.cancel")}
										</Button>
										<Button
											disabled={!text.trim() || !first?.databaseId}
											loading={busy === "reply"}
											onClick={() => void reply()}
											size="sm"
											variant="primary"
										>
											{t("prCenter.thread.reply")}
										</Button>
									</div>
								</div>
							) : (
								<LinkButton onClick={() => setReplying(true)}>{t("prCenter.thread.reply")}</LinkButton>
							)}
							{!replying && (
								<Button
									className="ml-auto"
									loading={busy === "resolve"}
									onClick={() => void resolve()}
									size="sm"
									variant="ghost"
								>
									{t(thread.isResolved ? "prCenter.thread.unresolve" : "prCenter.thread.resolve")}
								</Button>
							)}
						</div>
					)}
				</div>
			</Collapse>
		</Card>
	);
}

const EVENT_ICON: Partial<Record<GithubTimelineEvent["kind"], ReactNode>> = {
	commit: <GitCommit aria-hidden />,
	labeled: <Tag aria-hidden />,
	unlabeled: <Tag aria-hidden />,
	assigned: <UserRound aria-hidden />,
	unassigned: <UserRound aria-hidden />,
	review_requested: <UserRound aria-hidden />,
};

function EventRow({ event }: { event: GithubTimelineEvent }) {
	const t = useT();
	return (
		<li
			className="flex items-center gap-2 px-1 text-sc-xs text-(--sc-text-muted) [&>svg]:size-(--sc-icon-sm) [&>svg]:shrink-0"
			data-pr-event={event.kind}
		>
			{EVENT_ICON[event.kind] ?? <MessageSquare aria-hidden />}
			<span className="min-w-0 truncate">
				{t(`prCenter.timeline.${event.kind}`, { actor: event.actor, subject: event.subject ?? "" })}
			</span>
			{event.sha && <span className="font-mono">{event.sha}</span>}
			<TimeAgo className="ml-auto shrink-0" iso={event.createdAt} />
		</li>
	);
}

/**
 * What reviewers asked for, for an agent (Orca `pr-comments-resolution-prompt.ts:70-126`): the comments and reviews
 * with words, and every comment of a thread still unresolved, with its file and line; an approval with no words or a
 * resolved thread asks for nothing.
 */
export function reviewFeedback(conversation: GithubPrConversation): RpcPrComments["entries"] {
	return [
		...conversation.comments.map(c => ({
			kind: "comment" as const,
			author: c.author,
			body: c.body,
			createdAt: c.createdAt,
			url: c.url,
		})),
		...conversation.reviews.map(r => ({
			kind: "review" as const,
			author: r.author,
			body: r.body,
			createdAt: r.createdAt,
			url: r.url,
			state: r.state,
		})),
		...conversation.threads
			.filter(thread => !thread.isResolved)
			.flatMap(thread =>
				thread.comments.map(c => ({
					kind: "inline" as const,
					author: c.author,
					body: c.body,
					createdAt: c.createdAt,
					url: c.url,
					path: thread.path,
					...(thread.line ? { line: thread.line } : {}),
				})),
			),
	].filter(entry => entry.body.trim());
}

/** Conversation and review form for the selected PR; `load` is the detail's `pr_conversation` read. */
export function PrConversation({ detail, load }: { detail: RpcPrDetail; load: GithubLoad<GithubPrConversation> }) {
	const t = useT();
	const mentions = useAssignable();
	const number = detail.number;
	const [text, setText] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const conversation = load.data;
	const open = !detail.state || detail.state === "OPEN";

	const submit = async (event: "comment" | "approve" | "request_changes") => {
		setBusy(event);
		const command: RpcCommand =
			event === "comment"
				? { type: "pr_comment", number, body: text }
				: { type: "pr_review", number, event, body: text };
		try {
			const response = await window.omp.rpc.command(command);
			if (!response.success) throw response;
			setText("");
			toast({ variant: "success", message: t(`prCenter.review.done.${event}`) });
			load.reload();
			if (event !== "comment") void usePrCenterStore.getState().reloadSelected();
		} catch (error) {
			toastError({ title: t("prCenter.review.failed"), error });
		} finally {
			setBusy(null);
		}
	};

	const list = conversation ? items(conversation) : [];
	const feedback = conversation ? reviewFeedback(conversation) : [];
	const askAgent = async () => {
		setBusy("agent");
		await handToPrCheckout(number, cwd =>
			addressCommentsPrompt({ number, title: detail.title, url: detail.url, comments: feedback, cwd }),
		);
		setBusy(null);
	};
	return (
		<section aria-label={t("prCenter.section.conversation")} className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<h3 className="text-sc-sm font-semibold text-(--sc-text-secondary)">
					{t("prCenter.section.conversation")}
					{conversation &&
						` (${conversation.comments.length + conversation.reviews.length + conversation.threads.length})`}
				</h3>
				<Button
					className="ml-auto"
					disabled={busy !== null || feedback.length === 0}
					icon={<Sparkles />}
					loading={busy === "agent"}
					onClick={() => void askAgent()}
					size="sm"
					variant="ghost"
				>
					{t("fixWithAgent.addressComments")}
				</Button>
				<IconButton
					icon={<RefreshCw />}
					label={t("common.refresh")}
					loading={load.loading}
					onClick={load.reload}
					size="sm"
				/>
			</div>
			{load.error && <InlineNotice detail={load.error} live title={t("prCenter.review.loadFailed")} tone="danger" />}
			{!conversation && !load.error ? (
				<div aria-label={t("prCenter.loading")} className="flex flex-col gap-2" role="status">
					{[0, 1].map(index => (
						<Card aria-hidden className="flex flex-col gap-2" key={index} padding="sm">
							<Skeleton className="h-3 w-32" />
							<Skeleton className="h-3 w-[80%]" />
						</Card>
					))}
				</div>
			) : conversation && list.length === 0 ? (
				<p className="text-sc-sm text-(--sc-text-muted)">{t("prCenter.review.none")}</p>
			) : (
				<ul className="flex flex-col gap-2">
					{list.map((item, index) => {
						const key = `${item.kind}:${item.at}:${index}`;
						if (item.kind === "event") return <EventRow event={item.event} key={key} />;
						if (item.kind === "thread") {
							return (
								<li key={key}>
									<Thread
										mentions={mentions}
										number={number}
										onChanged={load.reload}
										open={open}
										thread={item.thread}
									/>
								</li>
							);
						}
						const entry = item.kind === "comment" ? item.comment : item.review;
						const state = item.kind === "review" ? item.review.state : null;
						return (
							<li key={key}>
								<Card padding="sm">
									<CommentBody
										author={entry.author}
										badge={
											state && (
												<Badge variant={REVIEW_STATE_TONE[state] ?? "default"}>
													{t(`prCenter.review.state.${state}`)}
												</Badge>
											)
										}
										body={entry.body}
										createdAt={entry.createdAt}
										images={entry.images}
										onChanged={load.reload}
										reactions={entry.reactions}
										subjectId={entry.id}
									/>
								</Card>
							</li>
						);
					})}
				</ul>
			)}
			{open && (
				<div className="flex flex-col gap-2 pt-1">
					<MarkdownComposer
						ariaLabel={t("prCenter.review.placeholder")}
						mentions={mentions}
						onChange={setText}
						onImage={file => uploadGithubImage(file)}
						onSubmit={() => text.trim() && void submit("comment")}
						placeholder={t("prCenter.review.placeholder")}
						rows={3}
						value={text}
					/>
					<div className="flex flex-wrap justify-end gap-2">
						<Button
							disabled={busy !== null || !text.trim()}
							icon={<MessageSquare />}
							loading={busy === "comment"}
							onClick={() => void submit("comment")}
							size="sm"
							variant="secondary"
						>
							{t("prCenter.review.comment")}
						</Button>
						<Button
							disabled={busy !== null || !text.trim()}
							icon={<XCircle />}
							loading={busy === "request_changes"}
							onClick={() => void submit("request_changes")}
							size="sm"
							variant="secondary"
						>
							{t("prCenter.review.requestChanges")}
						</Button>
						<Button
							disabled={busy !== null}
							icon={<CheckCircle2 />}
							loading={busy === "approve"}
							onClick={() => void submit("approve")}
							size="sm"
							variant="primary"
						>
							{t("prCenter.review.approve")}
						</Button>
					</div>
				</div>
			)}
		</section>
	);
}
