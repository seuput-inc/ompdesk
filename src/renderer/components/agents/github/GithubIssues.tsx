import { CircleDot, CircleOff, Copy, ExternalLink, MessageSquare, Pencil, Play, Plus, RefreshCw } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { GithubIssueDetail, GithubIssueState } from "../../../../shared/github";
import { issueTaskPrompt } from "../../../lib/fix-prompts";
import { copyText, formatTimeAgo } from "../../../lib/format";
import { github, useGithubLoad } from "../../../lib/github";
import { uploadGithubImage } from "../../../lib/github-image";
import { useT } from "../../../lib/i18n";
import { MarkdownRenderer } from "../../../lib/markdown";
import { openExternal } from "../../../lib/open-external";
import { sameRepo, useGithubNav } from "../../../stores/github-nav";
import { toast, toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import {
	AsyncSection,
	Badge,
	Button,
	Card,
	IconButton,
	Input,
	ListRow,
	MarkdownComposer,
	MasterDetail,
	MenuButton,
	Modal,
	SearchField,
	Tabs,
} from "../../common";
import { PeopleFields, useAssignable } from "../pr/PrPeople";
import { type GithubSectionProps, GithubToolbar, NeedsRepo, pausedNotice, useGithubMutation } from "./shared";

const STATES: GithubIssueState[] = ["open", "closed", "all"];

/** New issues not filed yet, by repository: closing the dialog keeps what was typed (Orca `task-page-new-issue-draft.ts`). */
const drafts = new Map<string, { title: string; body: string }>();

/**
 * Title + body editor for a new or edited issue: Write and Preview, @mentions and pasted images; ⌘/Ctrl+Enter files
 * it. With `draftKey` what was typed outlives a close until the issue is filed.
 */
function IssueEditor({
	open,
	initial,
	heading,
	submitLabel,
	target,
	draftKey,
	onClose,
	onSubmit,
}: {
	open: boolean;
	initial: { title: string; body: string };
	heading: string;
	submitLabel: string;
	target: GithubSectionProps["target"];
	draftKey?: string;
	onClose: () => void;
	onSubmit: (value: { title: string; body: string }) => Promise<boolean>;
}) {
	const t = useT();
	const mentions = useAssignable(target);
	const form = useRef<HTMLFormElement>(null);
	const kept = draftKey ? drafts.get(draftKey) : undefined;
	const [title, setTitle] = useState(kept?.title ?? initial.title);
	const [body, setBody] = useState(kept?.body ?? initial.body);
	const [busy, setBusy] = useState(false);
	const keep = (next: { title: string; body: string }) => {
		if (!draftKey) return;
		if (next.title || next.body) drafts.set(draftKey, next);
		else drafts.delete(draftKey);
	};
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!title.trim()) return;
		setBusy(true);
		const done = await onSubmit({ title: title.trim(), body });
		setBusy(false);
		if (!done) return;
		if (draftKey) drafts.delete(draftKey);
		onClose();
	};
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="secondary">
						{t("common.cancel")}
					</Button>
					<Button
						disabled={!title.trim()}
						form="github-issue-editor"
						loading={busy}
						type="submit"
						variant="primary"
					>
						{submitLabel}
					</Button>
				</>
			}
			onClose={onClose}
			open={open}
			size="lg"
			title={heading}
		>
			<form
				className="flex flex-col gap-3"
				id="github-issue-editor"
				onSubmit={event => void submit(event)}
				ref={form}
			>
				<Input
					autoFocus
					label={t("github.issues.title")}
					onChange={event => {
						setTitle(event.target.value);
						keep({ title: event.target.value, body });
					}}
					value={title}
				/>
				<MarkdownComposer
					label={t("github.issues.body")}
					mentions={mentions}
					onChange={next => {
						setBody(next);
						keep({ title, body: next });
					}}
					onImage={file => uploadGithubImage(file, target)}
					onSubmit={() => form.current?.requestSubmit()}
					rows={8}
					value={body}
				/>
			</form>
		</Modal>
	);
}

/** A branch name for work on an issue: its number and title in lowercase words. */
function issueBranch(issue: GithubIssueDetail): string {
	const words = issue.title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/, "");
	return words ? `${issue.number}-${words}` : `issue-${issue.number}`;
}

function IssueDetail({
	issue,
	target,
	onChanged,
}: {
	issue: GithubIssueDetail;
	target: GithubSectionProps["target"];
	onChanged: () => void;
}) {
	const t = useT();
	const { busy, run } = useGithubMutation();
	const mentions = useAssignable(target);
	const [editing, setEditing] = useState(false);
	const [comment, setComment] = useState("");
	const closed = issue.state === "CLOSED";
	const copy = async (what: "url" | "branch" | "prompt") => {
		const text =
			what === "url"
				? issue.url
				: what === "branch"
					? issueBranch(issue)
					: `${t("github.issues.promptLead", { number: issue.number, title: issue.title })}\n${issue.url}\n\n${issue.body}`;
		if (await copyText(text)) toast({ variant: "success", message: t(`github.issues.copied.${what}`) });
		else toastError({ title: t(`github.issues.copyFailed.${what}`), error: "" });
	};
	return (
		<article className="flex flex-col gap-4 px-6 py-5 min-[1280px]:px-10" data-github-issue={issue.number}>
			<header className="flex flex-col gap-2">
				<h3 className="text-sc-lg font-semibold text-(--sc-text)">
					{issue.title} <span className="font-normal text-(--sc-text-muted)">#{issue.number}</span>
				</h3>
				<div className="flex flex-wrap items-center gap-2 text-sc-xs text-(--sc-text-muted)">
					<Badge variant={closed ? "muted" : "success"}>
						{t(closed ? "github.issues.closed" : "github.issues.open")}
					</Badge>
					<span>{issue.author}</span>
					<span>{formatTimeAgo(issue.updatedAt)}</span>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button
						data-github-issue-start
						icon={<Play />}
						onClick={() =>
							useUiStore.getState().openWorktreeDialog({
								name: issueBranch(issue),
								prompt: issueTaskPrompt(issue),
							})
						}
						size="sm"
						variant="primary"
					>
						{t("github.issues.startTask")}
					</Button>
					<Button icon={<Pencil />} onClick={() => setEditing(true)} size="sm" variant="secondary">
						{t("common.edit")}
					</Button>
					<Button
						icon={closed ? <CircleDot /> : <CircleOff />}
						loading={busy === "state"}
						onClick={() =>
							void run(
								"state",
								() =>
									github({
										...target,
										op: "issue_state",
										number: issue.number,
										state: closed ? "open" : "closed",
									}),
								t("github.actionFailed"),
							).then(done => done && onChanged())
						}
						size="sm"
						variant="secondary"
					>
						{t(closed ? "github.issues.reopen" : "github.issues.close")}
					</Button>
					<Button icon={<ExternalLink />} onClick={() => openExternal(issue.url)} size="sm" variant="ghost">
						{t("github.openOnGithub")}
					</Button>
					<MenuButton
						icon={<Copy />}
						items={[
							{ id: "url", label: t("github.issues.copy.url"), onSelect: () => void copy("url") },
							{ id: "branch", label: t("github.issues.copy.branch"), onSelect: () => void copy("branch") },
							{ id: "prompt", label: t("github.issues.copy.prompt"), onSelect: () => void copy("prompt") },
						]}
						label={t("github.issues.copy.label")}
						size="sm"
						variant="ghost"
					/>
				</div>
				<PeopleFields
					assignees={issue.assignees}
					editable
					kind="issue"
					labels={issue.labels}
					number={issue.number}
					onChanged={onChanged}
					target={target}
				/>
			</header>
			<div className="text-sc-md">
				{issue.body.trim() ? (
					<MarkdownRenderer content={issue.body} />
				) : (
					<p className="text-(--sc-text-muted)">{t("github.issues.noBody")}</p>
				)}
			</div>
			<section
				aria-label={t("github.issues.comments")}
				className="flex flex-col gap-3 border-t border-(--sc-divider) pt-4"
			>
				{issue.comments.map((entry, index) => (
					<Card
						// Comments only append; a position names one comment while this issue shows.
						key={`${index}:${entry.createdAt}`}
						padding="sm"
					>
						<div className="mb-1 text-sc-xs text-(--sc-text-muted)">
							{entry.author} · {formatTimeAgo(entry.createdAt)}
						</div>
						<MarkdownRenderer content={entry.body} />
					</Card>
				))}
				<form
					className="flex flex-col gap-2"
					onSubmit={event => {
						event.preventDefault();
						const body = comment.trim();
						if (!body) return;
						void run(
							"comment",
							() => github({ ...target, op: "issue_comment", number: issue.number, body }),
							t("github.actionFailed"),
						).then(done => {
							if (!done) return;
							setComment("");
							onChanged();
						});
					}}
				>
					<MarkdownComposer
						label={t("github.issues.addComment")}
						mentions={mentions}
						onChange={setComment}
						onImage={file => uploadGithubImage(file, target)}
						rows={3}
						value={comment}
					/>
					<div>
						<Button
							disabled={!comment.trim()}
							loading={busy === "comment"}
							size="sm"
							type="submit"
							variant="secondary"
						>
							{t("github.issues.comment")}
						</Button>
					</div>
				</form>
			</section>
			{editing && (
				<IssueEditor
					heading={t("github.issues.editTitle", { number: issue.number })}
					initial={{ title: issue.title, body: issue.body }}
					onClose={() => setEditing(false)}
					onSubmit={value =>
						run(
							"edit",
							() => github({ ...target, op: "issue_edit", number: issue.number, ...value }),
							t("github.actionFailed"),
						).then(done => {
							if (done) onChanged();
							return done;
						})
					}
					open
					submitLabel={t("common.save")}
					target={target}
				/>
			)}
		</article>
	);
}

export function GithubIssues({ target, repoName, targetKey }: GithubSectionProps) {
	const t = useT();
	const [state, setState] = useState<GithubIssueState>("open");
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState<number | null>(null);
	const [creating, setCreating] = useState(false);
	const { run } = useGithubMutation();
	// The issue another surface asked for, once this list is its repository's.
	const asked = useGithubNav(nav => nav.issue);
	useEffect(() => {
		if (!asked || !sameRepo(asked.repo, repoName)) return;
		setState("all");
		setSelected(asked.number);
		useGithubNav.setState({ issue: null });
	}, [asked, repoName]);
	const list = useGithubLoad(
		repoName ? { ...target, op: "issue_list", state, search: search || undefined } : null,
		`${targetKey}|${state}|${search}`,
	);
	const detail = useGithubLoad(
		repoName && selected !== null ? { ...target, op: "issue_get", number: selected } : null,
		`${targetKey}|${selected}`,
	);
	if (!repoName) return <NeedsRepo />;
	const changed = () => {
		list.reload();
		detail.reload();
	};
	const rows = list.data ?? [];
	return (
		<>
			<GithubToolbar>
				<Tabs
					activeId={state}
					ariaLabel={t("github.issues.stateFilter")}
					onChange={id => setState(id as GithubIssueState)}
					tabs={STATES.map(id => ({ id, label: t(`github.issues.state.${id}`) }))}
					variant="segmented"
				/>
				<form
					className="min-w-48 flex-1"
					onSubmit={event => {
						event.preventDefault();
						setSearch(query.trim());
					}}
				>
					<SearchField label={t("github.issues.search")} onValueChange={setQuery} value={query} />
				</form>
				<IconButton icon={<RefreshCw />} label={t("common.refresh")} loading={list.loading} onClick={list.reload} />
				<Button icon={<Plus />} onClick={() => setCreating(true)} size="sm" variant="secondary">
					{t("github.issues.new")}
				</Button>
			</GithubToolbar>
			<MasterDetail
				detail={
					selected === null ? null : (
						<AsyncSection
							error={detail.error}
							hasData={detail.data !== null}
							loading={detail.loading && !detail.data}
							notice={pausedNotice(detail.pausedUntil)}
							onRetry={detail.reload}
						>
							{detail.data && <IssueDetail issue={detail.data} onChanged={changed} target={target} />}
						</AsyncSection>
					)
				}
				label={t("github.issues.list")}
				list={
					<AsyncSection
						emptyLabel={t("github.issues.empty")}
						empty={rows.length === 0}
						error={list.error}
						hasData={rows.length > 0}
						loading={list.loading && !list.data}
						notice={pausedNotice(list.pausedUntil)}
						onRetry={list.reload}
					>
						<ul className="flex flex-col gap-0.5">
							{rows.map(item => (
								<li key={item.number}>
									<ListRow
										leading={
											<CircleDot
												aria-hidden
												className={`size-(--sc-icon-sm) shrink-0 ${item.state === "OPEN" ? "text-(--sc-success)" : "text-(--sc-text-subtle)"}`}
											/>
										}
										onClick={() => setSelected(item.number)}
										secondary={
											<>
												<span className="shrink-0 tabular-nums">#{item.number}</span>
												<span className="min-w-0 flex-1 truncate">{item.author}</span>
												{item.commentCount > 0 && (
													<span className="flex shrink-0 items-center gap-0.5 tabular-nums">
														<MessageSquare aria-hidden className="size-3" />
														<span aria-hidden>{item.commentCount}</span>
														<span className="sr-only">
															{t("github.issues.commentCount", { count: item.commentCount })}
														</span>
													</span>
												)}
												<span className="shrink-0">{formatTimeAgo(item.updatedAt)}</span>
											</>
										}
										selected={item.number === selected}
										size="sm"
										title={item.title}
									/>
								</li>
							))}
						</ul>
					</AsyncSection>
				}
				onBack={() => setSelected(null)}
				open={selected !== null}
			/>
			{creating && (
				<IssueEditor
					draftKey={`${target.host ?? ""}|${repoName}`}
					heading={t("github.issues.newTitle", { repo: repoName })}
					initial={{ title: "", body: "" }}
					onClose={() => setCreating(false)}
					target={target}
					onSubmit={value =>
						run(
							"create",
							async () => {
								const created = await github({ ...target, op: "issue_create", ...value });
								if (created.number) setSelected(created.number);
							},
							t("github.actionFailed"),
							t("github.issues.created"),
						).then(done => {
							if (done) list.reload();
							return done;
						})
					}
					open
					submitLabel={t("github.issues.create")}
				/>
			)}
		</>
	);
}
