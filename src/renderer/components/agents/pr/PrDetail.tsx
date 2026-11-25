/**
 * Pull request detail (Agents › Pull requests): header (title, state, branches, diff stat, review decision, a triage
 * line, actions, reviewers, assignees and labels), collapsible markdown body, the stack it sits in, checks, the files
 * index with per-file lazy DiffView expansion (or all at once) and GitHub's viewed marks, and the conversation. Diff
 * text loads on first expand via pr_diff — closed files cost nothing.
 */

import {
	ChevronsDownUp,
	ChevronsUpDown,
	ExternalLink,
	GitBranch,
	GitPullRequest,
	GitPullRequestDraft,
	RefreshCw,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type { RpcPrDetail } from "../../../../shared/rpc-types";
import { DiffView } from "../../../lib/diff";
import { github, useGithubLoad } from "../../../lib/github";
import { useGithubImages } from "../../../lib/github-image";
import { useT } from "../../../lib/i18n";
import { MarkdownRenderer } from "../../../lib/markdown";
import { openExternal } from "../../../lib/open-external";
import { usePrCenterStore } from "../../../stores/pr-center";
import { toastError } from "../../../stores/toast";
import {
	Badge,
	Button,
	Card,
	Checkbox,
	DisclosureButton,
	EmptyState,
	ErrorDetail,
	InlineNotice,
	Skeleton,
} from "../../common";
import { PrEditButton, PrMergeButton } from "./PrActions";
import { PrChecks, PrTriage } from "./PrChecks";
import { PrConversation } from "./PrConversation";
import { PeopleFields } from "./PrPeople";
import { PrStack } from "./PrStack";
import { PrAutoMergeBadge, PrMergedWorktree, PrStateButton } from "./PrStateActions";

const BODY_COLLAPSE_LINES = 12;

function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-2">
				<h3 className="text-sc-md font-semibold text-(--sc-text)">{title}</h3>
				{actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
			</div>
			{children}
		</section>
	);
}

function FileRow({
	path,
	additions,
	deletions,
	viewed,
	onViewed,
}: {
	path: string;
	additions: number;
	deletions: number;
	/** GitHub's viewed mark for you; undefined while unknown. */
	viewed: boolean | undefined;
	onViewed: (viewed: boolean) => void;
}) {
	const t = useT();
	const expanded = usePrCenterStore(state => state.expandedFiles[path]);
	return (
		<li>
			<Card className="overflow-hidden" padding="none">
				<div className="flex items-center">
					<DisclosureButton
						className="min-w-0 flex-1 px-3 py-2 hover:bg-(--sc-hover)"
						onToggle={() => void usePrCenterStore.getState().toggleFile(path)}
						open={expanded !== undefined}
					>
						<span className="min-w-0 flex-1 truncate font-mono text-sc-sm text-(--sc-text)">{path}</span>
						<span className="shrink-0 text-sc-xs tabular-nums text-(--sc-success)">+{additions}</span>
						<span className="shrink-0 text-sc-xs tabular-nums text-(--sc-danger)">−{deletions}</span>
					</DisclosureButton>
					{viewed !== undefined && (
						<label className="mx-3 flex shrink-0 items-center gap-1.5 text-sc-xs text-(--sc-text-muted)">
							<Checkbox
								aria-label={t("prCenter.files.viewedLabel", { path })}
								checked={viewed}
								data-pr-file-viewed
								onChange={event => onViewed(event.target.checked)}
							/>
							{t("prCenter.files.viewed")}
						</label>
					)}
				</div>
				{expanded?.phase === "loading" && (
					<div className="border-t border-(--sc-divider) px-3 py-2">
						<div aria-label={t("prCenter.diffLoading")} className="flex flex-col gap-2" role="status">
							<Skeleton className="h-3 w-[70%]" />
							<Skeleton className="h-3 w-[85%]" />
							<Skeleton className="h-3 w-[55%]" />
						</div>
					</div>
				)}
				{expanded?.phase === "error" && (
					<InlineNotice
						className="border-t border-(--sc-divider) px-3"
						live
						title={t("prCenter.diffFailed")}
						tone="danger"
					/>
				)}
				{expanded?.phase === "ready" && (
					<div className="overflow-x-auto border-t border-(--sc-divider) bg-(--sc-surface-1) py-1">
						<DiffView diff={expanded.diff} filePath={path} />
					</div>
				)}
			</Card>
		</li>
	);
}

/** The files and GitHub's viewed marks: a mark shows at once and the marks read again once GitHub answered. */
function Files({ detail }: { detail: RpcPrDetail }) {
	const t = useT();
	const number = detail.number;
	const viewedLoad = useGithubLoad({ op: "pr_files_viewed", number }, String(number));
	const [marks, setMarks] = useState<Record<string, boolean>>({});
	const expanded = usePrCenterStore(state => Object.keys(state.expandedFiles).length);
	const known = new Map((viewedLoad.data?.files ?? []).map(file => [file.path, file.state === "VIEWED"]));
	const viewedOf = (path: string) => marks[path] ?? known.get(path);
	const viewedCount = detail.files.filter(file => viewedOf(file.path)).length;
	const mark = async (path: string, viewed: boolean) => {
		const id = viewedLoad.data?.id || detail.id;
		if (!id) return;
		setMarks(current => ({ ...current, [path]: viewed }));
		try {
			await github({ op: "pr_file_viewed", pullRequestId: id, path, viewed });
		} catch (error) {
			setMarks(current => {
				const next = { ...current };
				delete next[path];
				return next;
			});
			toastError({ title: t("prCenter.files.viewedFailed"), error });
		}
	};
	const allOpen = expanded >= detail.files.length && detail.files.length > 0;
	return (
		<Section
			actions={
				<>
					{viewedLoad.data && (
						<span className="text-sc-xs tabular-nums text-(--sc-text-muted)" data-pr-viewed-count>
							{t("prCenter.files.viewedCount", {
								count: String(viewedCount),
								total: String(detail.files.length),
							})}
						</span>
					)}
					{detail.files.length > 1 && (
						<Button
							icon={allOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
							onClick={() =>
								allOpen
									? usePrCenterStore.getState().collapseAll()
									: void usePrCenterStore.getState().expandAll()
							}
							size="sm"
							variant="ghost"
						>
							{t(allOpen ? "prCenter.files.collapseAll" : "prCenter.files.expandAll")}
						</Button>
					)}
				</>
			}
			title={t("prCenter.section.files", { count: String(detail.files.length) })}
		>
			<ul className="flex flex-col gap-2">
				{detail.files.map(file => (
					<FileRow
						additions={file.additions}
						deletions={file.deletions}
						key={file.path}
						onViewed={viewed => void mark(file.path, viewed)}
						path={file.path}
						viewed={viewedLoad.data ? Boolean(viewedOf(file.path)) : undefined}
					/>
				))}
			</ul>
		</Section>
	);
}

function Body({ body, images }: { body: string; images?: Record<string, string> }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const shown = useGithubImages(body, images);
	if (!body.trim()) return null;
	const lines = shown.split("\n");
	const collapsible = lines.length > BODY_COLLAPSE_LINES;
	return (
		<Section title={t("prCenter.section.body")}>
			<div className="text-sc-lg">
				<MarkdownRenderer
					content={expanded || !collapsible ? shown : lines.slice(0, BODY_COLLAPSE_LINES).join("\n")}
				/>
			</div>
			{collapsible && (
				<div>
					<Button aria-expanded={expanded} onClick={() => setExpanded(open => !open)} size="sm" variant="ghost">
						{expanded
							? t("prCenter.collapse")
							: t("prCenter.expand", { count: String(lines.length - BODY_COLLAPSE_LINES) })}
					</Button>
				</div>
			)}
		</Section>
	);
}

function Loaded({ detail }: { detail: RpcPrDetail }) {
	const t = useT();
	const conversation = useGithubLoad({ op: "pr_conversation", number: detail.number }, String(detail.number));
	const open = !detail.state || detail.state === "OPEN";
	const unresolved = conversation.data ? conversation.data.threads.filter(thread => !thread.isResolved).length : null;
	return (
		<article className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-6 min-[1280px]:px-10">
			<header className="flex flex-col gap-3">
				<div className="flex items-start gap-3">
					{detail.isDraft ? (
						<GitPullRequestDraft
							aria-hidden
							className="mt-1 size-(--sc-icon-md) shrink-0 text-(--sc-text-muted)"
						/>
					) : (
						<GitPullRequest aria-hidden className="mt-1 size-(--sc-icon-md) shrink-0 text-(--sc-success)" />
					)}
					<h2 className="min-w-0 flex-1 text-sc-xl font-semibold text-(--sc-text)">
						{detail.title} <span className="font-normal text-(--sc-text-muted)">#{detail.number}</span>
					</h2>
					{detail.isDraft && <Badge variant="default">{t("prCenter.draft")}</Badge>}
					<PrAutoMergeBadge detail={detail} />
				</div>
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sc-sm text-(--sc-text-muted)">
					<span className="text-(--sc-text-secondary)">@{detail.authorLogin}</span>
					<span aria-hidden>·</span>
					<GitBranch aria-hidden className="size-(--sc-icon-sm) shrink-0" />
					<span className="font-mono">{detail.headRefName}</span>
					<span aria-hidden>→</span>
					<span className="font-mono">{detail.baseRefName}</span>
					<span aria-hidden>·</span>
					<span className="tabular-nums text-(--sc-success)">+{detail.additions}</span>
					<span className="tabular-nums text-(--sc-danger)">−{detail.deletions}</span>
					{detail.reviewDecision && (
						<>
							<span aria-hidden>·</span>
							<span>{detail.reviewDecision.toLowerCase().replace(/_/g, " ")}</span>
						</>
					)}
				</div>
				<PrTriage detail={detail} unresolved={unresolved} />
				<div className="flex flex-wrap items-center gap-2">
					<Button
						icon={<GitBranch />}
						onClick={() => void usePrCenterStore.getState().checkout(detail.number)}
						size="sm"
						variant="primary"
					>
						{t("prCenter.checkout")}
					</Button>
					<Button icon={<ExternalLink />} onClick={() => openExternal(detail.url)} size="sm" variant="secondary">
						{t("prCenter.openInBrowser")}
					</Button>
					<PrEditButton detail={detail} />
					<PrMergeButton detail={detail} />
					<PrStateButton detail={detail} />
					{detail.state && detail.state !== "OPEN" && (
						// A merge is a change that landed (success); the accent is near the text in the monochrome themes.
						<Badge variant={detail.state === "MERGED" ? "success" : "muted"}>
							{t(`prCenter.state.${detail.state.toLowerCase()}`)}
						</Badge>
					)}
				</div>
				<PeopleFields
					assignees={detail.assignees ?? []}
					editable={open}
					kind="pr"
					labels={detail.labels ?? []}
					number={detail.number}
					onChanged={() => void usePrCenterStore.getState().reloadSelected()}
					reviewers={detail.reviewRequests ?? []}
				/>
				<PrMergedWorktree detail={detail} />
			</header>

			<Body body={detail.body} images={conversation.data?.bodyImages} />
			<PrStack number={detail.number} />
			{detail.checks.length > 0 && <PrChecks agentFix detail={detail} />}
			<Files detail={detail} />
			<PrConversation detail={detail} load={conversation} />
		</article>
	);
}

export function PrDetail() {
	const t = useT();
	const detail = usePrCenterStore(state => state.detail);
	const detailLoading = usePrCenterStore(state => state.detailLoading);
	const selected = usePrCenterStore(state => state.selected);
	const error = usePrCenterStore(state => state.error);

	if (selected === null) {
		return (
			<EmptyState
				className="h-full"
				description={t("prCenter.noSelection")}
				icon={<GitPullRequest />}
				title={t("prCenter.noSelectionTitle")}
			/>
		);
	}
	// A PR seen before shows its last read while it loads again; one never seen is the shape of a PR. A read that
	// failed must not sit on a skeleton forever.
	if (!detail && (detailLoading || !error)) {
		return (
			<div
				aria-label={t("prCenter.loading")}
				className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-6 min-[1280px]:px-10"
				role="status"
			>
				<div className="flex flex-col gap-2">
					<Skeleton className="h-6 w-3/4" />
					<Skeleton className="h-4 w-1/2" />
					<div className="flex gap-2 pt-1">
						<Skeleton className="h-8 w-28 rounded-(--sc-radius-md)" />
						<Skeleton className="h-8 w-28 rounded-(--sc-radius-md)" />
						<Skeleton className="h-8 w-28 rounded-(--sc-radius-md)" />
					</div>
				</div>
				<div className="flex flex-col gap-2">
					<Skeleton className="h-3 w-full" />
					<Skeleton className="h-3 w-[92%]" />
					<Skeleton className="h-3 w-[64%]" />
				</div>
				<div className="flex flex-col gap-2">
					{[0, 1, 2, 3].map(index => (
						<Skeleton className="h-9 w-full rounded-(--sc-radius-md)" key={index} />
					))}
				</div>
			</div>
		);
	}
	if (!detail) {
		return (
			<EmptyState
				actions={
					<Button
						icon={<RefreshCw />}
						onClick={() => void usePrCenterStore.getState().select(selected)}
						size="sm"
						variant="secondary"
					>
						{t("common.retry")}
					</Button>
				}
				className="h-full"
				description={
					<span role="alert">
						<ErrorDetail error={error} />
					</span>
				}
				title={t("prCenter.detailFailed")}
			/>
		);
	}
	// Keyed on the selection so switching PRs resets what belongs to the PR being left behind.
	return <Loaded detail={detail} key={selected} />;
}
