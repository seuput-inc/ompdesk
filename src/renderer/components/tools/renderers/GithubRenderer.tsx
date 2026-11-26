import { CircleDot, ExternalLink, GitPullRequest, GitPullRequestArrow } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import type { GithubItemPeek } from "../../../../shared/github";
import { githubConclusionPassed } from "../../../../shared/github-checks";
import { type GithubItemLink, githubItemLink } from "../../../../shared/session-links";
import { AnsiText, hasAnsi } from "../../../lib/ansi";
import { useFocusedScope } from "../../../lib/focused-scope";
import { resultText } from "../../../lib/format";
import { githubStateLabel } from "../../../lib/github-state";
import { useT } from "../../../lib/i18n";
import { githubPeekKey, peekGithubItem } from "../../../lib/link-peek";
import { openExternal } from "../../../lib/open-external";
import { openPullRequest } from "../../../lib/open-pull-request";
import { hidden, pollWhileVisible } from "../../../lib/visible-poll";
import { asArray, asRecord } from "../../../lib/wire-value";
import { showIssue } from "../../../stores/github-nav";
import { githubItemState, LinkPeek } from "../../chat/LinkPeek";
import { IconButton } from "../../common";
import type { ToolRendererProps } from "../ToolCard";
import { resultDetails } from "./result";

/**
 * GitHub wire shape: `{ content: [{ type: "text", text }], details }` where
 * `details` is `GhToolDetails` (packages/coding-agent/src/tools/gh.ts):
 *   { repo?, branch?, worktreePath?, headSha?, runId?, status?, conclusion?,
 *     failedJobs?, watch?, checkouts? }
 * The tool arg is `op` (not `action`). View ops render the entity in the text
 * body (`# Issue #N: title`, `State: …`, `URL: …`); `run_watch` carries the
 * structured `watch` view (runs/jobs/failed logs).
 */

interface GhEntity {
	kind: "issue" | "pr" | "unknown";
	number?: number;
	title?: string;
	state?: string;
	url?: string;
	repo?: string;
}

interface GhJob {
	id?: number;
	name: string;
	status?: string;
	conclusion?: string;
	durationSeconds?: number;
}

interface GhRun {
	id?: number;
	label: string;
	branch?: string;
	url?: string;
	jobs: GhJob[];
}

interface GhWatch {
	repo?: string;
	state?: string;
	note?: string;
	runs: GhRun[];
	failedLogs: Array<{ jobName?: string; context: string; tail?: string; available?: boolean }>;
}

const OP_TITLES: Record<string, string> = {
	repo_view: "GitHub Repo",
	file_read: "GitHub File",
	pr_create: "GitHub PR Create",
	pr_checkout: "GitHub PR Checkout",
	pr_push: "GitHub PR Push",
	search_issues: "GitHub Search Issues",
	search_prs: "GitHub Search PRs",
	search_code: "GitHub Search Code",
	search_commits: "GitHub Search Commits",
	search_repos: "GitHub Search Repos",
	run_watch: "GitHub Run Watch",
};

const STATE_COLOR: Record<string, string> = {
	open: "var(--omp-success)",
	closed: "var(--omp-error)",
	merged: "var(--omp-thinking-high)",
	draft: "var(--omp-dim)",
};

function jobColor(job: GhJob): string {
	if (job.conclusion) return githubConclusionPassed(job.conclusion) ? "var(--omp-success)" : "var(--omp-error)";
	if (job.status === "in_progress") return "var(--omp-warning)";
	return "var(--omp-dim)";
}

function parseRun(value: unknown): GhRun | undefined {
	const run = asRecord(value);
	if (!run) return undefined;
	const jobs: GhJob[] = [];
	for (const j of asArray(run.jobs)) {
		const jr = asRecord(j);
		if (!jr || typeof jr.name !== "string") continue;
		jobs.push({
			id: typeof jr.id === "number" ? jr.id : undefined,
			name: jr.name,
			status: typeof jr.status === "string" ? jr.status : undefined,
			conclusion: typeof jr.conclusion === "string" ? jr.conclusion : undefined,
			durationSeconds: typeof jr.durationSeconds === "number" ? jr.durationSeconds : undefined,
		});
	}
	const label =
		typeof run.workflowName === "string"
			? run.workflowName
			: typeof run.displayTitle === "string"
				? run.displayTitle
				: "GitHub Actions";
	return {
		id: typeof run.id === "number" ? run.id : undefined,
		label,
		branch:
			typeof run.branch === "string"
				? run.branch
				: typeof run.headSha === "string"
					? run.headSha.slice(0, 7)
					: undefined,
		url: typeof run.url === "string" ? run.url : undefined,
		jobs,
	};
}

function extractWatch(details: Record<string, unknown> | undefined): GhWatch | undefined {
	const watch = asRecord(details?.watch);
	if (!watch) return undefined;
	const runs: GhRun[] = [];
	const single = parseRun(watch.run);
	if (single) runs.push(single);
	for (const r of asArray(watch.runs)) {
		const parsed = parseRun(r);
		if (parsed) runs.push(parsed);
	}
	const failedLogs: GhWatch["failedLogs"] = [];
	for (const f of asArray(watch.failedLogs)) {
		const fr = asRecord(f);
		if (!fr) continue;
		failedLogs.push({
			jobName: typeof fr.jobName === "string" ? fr.jobName : undefined,
			context:
				typeof fr.workflowName === "string"
					? `${fr.workflowName}  #${typeof fr.runId === "number" ? fr.runId : "?"}`
					: `run #${typeof fr.runId === "number" ? fr.runId : "?"}`,
			tail: typeof fr.tail === "string" ? fr.tail : undefined,
			available: typeof fr.available === "boolean" ? fr.available : undefined,
		});
	}
	return {
		repo: typeof watch.repo === "string" ? watch.repo : undefined,
		state: typeof watch.state === "string" ? watch.state : undefined,
		note: typeof watch.note === "string" ? watch.note : undefined,
		runs,
		failedLogs,
	};
}

function extractEntity(
	args: Record<string, unknown>,
	text: string,
	details: Record<string, unknown> | undefined,
): GhEntity {
	const checkout = asRecord(asArray(details?.checkouts)[0]);
	const header = text.match(
		/^#\s+(?:Created\s+|Checked\s+Out\s+)?(Issue|Pull\s+Request)(?:\s+Worktree)?\s+#(\d+)(?::\s*(.+))?$/m,
	);
	const kind: GhEntity["kind"] = header
		? /pull\s+request/i.test(header[1])
			? "pr"
			: "issue"
		: checkout
			? "pr"
			: "unknown";
	const number =
		header != null
			? Number.parseInt(header[2], 10)
			: typeof checkout?.prNumber === "number"
				? checkout.prNumber
				: undefined;
	const title = header?.[3] ? header[3].trim() : (text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? undefined);
	const state =
		text.match(/^State:\s*(.+)$/m)?.[1]?.trim() ??
		(typeof details?.conclusion === "string" ? details.conclusion : undefined) ??
		(typeof details?.status === "string" ? details.status : undefined);
	const url = text.match(/^URL:\s*(\S+)$/m)?.[1] ?? (typeof checkout?.url === "string" ? checkout.url : undefined);
	const repo =
		typeof details?.repo === "string"
			? details.repo
			: typeof args.repo === "string"
				? args.repo
				: url
					? (url.match(/github\.com\/([^/]+\/[^/]+)/)?.[1] ?? undefined)
					: undefined;
	return { kind, number, title, state, url, repo };
}

/** A PR or issue state in the tool's own words, else a check or run state's (a conclusion), else GitHub's word. */
function stateLabel(t: (key: string) => string, state: string): string {
	const key = `tools.github.state.${state.toLowerCase()}`;
	const own = t(key);
	return own === key ? githubStateLabel(t, state) : own;
}

/** Lines consumed by the entity card, hidden from the body to avoid duplication. */
const ENTITY_LINE_RE =
	/^#\s+(?:Created\s+|Checked\s+Out\s+)?(?:Issue|Pull\s+Request)(?:\s+Worktree)?\s+#\d+|^(?:State|URL):\s*.*$/;

/** How often an open pull request's card reads it again while on screen (Orca's `OPEN_PULL_REQUEST_REFRESH_MS`). */
export const PR_CARD_REFRESH_MS = 60_000;

function entityLink(entity: GhEntity): GithubItemLink | null {
	const fromUrl = entity.url ? githubItemLink(entity.url) : null;
	return fromUrl ?? (entity.repo && entity.number != null ? { repo: entity.repo, number: entity.number } : null);
}

/**
 * An open pull request's fresh title and state while its card is on screen and the window is shown: read as it comes
 * into view, then every minute; once it reads merged or closed it is never read again (Orca's
 * `NativeChatOpenedPullRequestCard.tsx` `usePullRequestDetails`). A failed read keeps what the card showed.
 */
function useLivePullRequest(
	link: GithubItemLink | null,
	toolState: string | undefined,
	cardRef: RefObject<HTMLElement | null>,
): GithubItemPeek | null {
	const [fresh, setFresh] = useState<GithubItemPeek | null>(null);
	// Where nothing can say what is on screen, the card counts as shown.
	const [onScreen, setOnScreen] = useState(typeof IntersectionObserver === "undefined");
	const state = (fresh?.state ?? toolState ?? "").toUpperCase();
	const live = link !== null && state !== "MERGED" && state !== "CLOSED";
	const key = link && githubPeekKey(link);
	const linkRef = useRef(link);
	linkRef.current = link;
	useEffect(() => {
		const card = cardRef.current;
		if (!live || !card || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(([entry]) => setOnScreen(entry?.isIntersecting ?? false));
		observer.observe(card);
		return () => observer.disconnect();
	}, [live, cardRef]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` names the pull request `linkRef` holds.
	useEffect(() => {
		const pr = linkRef.current;
		if (!live || !onScreen || !pr) return;
		const read = () => {
			peekGithubItem(pr, { freshMs: PR_CARD_REFRESH_MS, background: true }).then(setFresh, () => undefined);
		};
		if (!hidden()) read();
		return pollWhileVisible(read, PR_CARD_REFRESH_MS);
	}, [live, onScreen, key]);
	return fresh;
}

const MENTION = /\b([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)#(\d+)\b/g;

/** `owner/repo#n` mentions in a tool's text as links with their card; the rest as it is. */
function withMentions(text: string): ReactNode[] {
	const parts: ReactNode[] = [];
	let last = 0;
	for (const match of text.matchAll(MENTION)) {
		const at = match.index ?? 0;
		const url = `https://github.com/${match[1]}/issues/${match[2]}`;
		parts.push(
			text.slice(last, at),
			<LinkPeek href={url} key={at}>
				<a
					className="text-[var(--omp-md-link)] underline decoration-[var(--omp-md-link-url)]"
					data-github-mention
					href={url}
					onClick={event => {
						event.preventDefault();
						openExternal(url);
					}}
				>
					{match[0]}
				</a>
			</LinkPeek>,
		);
		last = at + match[0].length;
	}
	parts.push(text.slice(last));
	return parts;
}

/** GitHub: op title + entity card (issue/PR) or run-watch jobs; open-external button. */
export function GithubRenderer({ args, result, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const scope = useFocusedScope();
	const cardRef = useRef<HTMLDivElement>(null);
	const effective = isPartial ? partialResult : result;
	const details = resultDetails(effective);
	const text = resultText(effective);
	const op = typeof args.op === "string" ? args.op : "";
	const opTitle = OP_TITLES[op] ?? "GitHub";
	const watch = extractWatch(details);
	const entity = extractEntity(args, text, details);
	const externalUrl =
		entity.url ??
		watch?.runs.find(r => r.url)?.url ??
		(entity.repo && entity.number != null
			? `https://github.com/${entity.repo}/${entity.kind === "pr" ? "pull" : "issues"}/${entity.number}`
			: undefined);
	const Icon = entity.kind === "pr" ? GitPullRequest : CircleDot;
	const body = text
		.split("\n")
		.filter(line => !ENTITY_LINE_RE.test(line))
		.join("\n")
		.trim();
	const prLink = entity.kind === "pr" ? entityLink(entity) : null;
	// An issue on this checkout's gh host opens in Agents › GitHub (an Enterprise one in the browser).
	const issueLink = entity.kind === "issue" ? entityLink(entity) : null;
	const live = useLivePullRequest(prLink, entity.state, cardRef);
	const title = live?.title ?? entity.title;
	const state = live ? githubItemState(live) : entity.state;

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-1.5 font-mono text-omp-sm">
				<Icon
					size={12}
					className="shrink-0"
					style={{ color: entity.kind === "pr" ? "var(--omp-thinking-high)" : "var(--omp-success)" }}
				/>
				<span className="text-[var(--omp-muted)]">{opTitle}</span>
				{entity.repo && <span className="truncate text-[var(--omp-status-path)]">{entity.repo}</span>}
				{watch?.state === "watching" && (
					<span className="ml-auto shrink-0 text-omp-xs text-[var(--omp-accent)]">
						{t("tools.github.watching")}
					</span>
				)}
				{externalUrl && entity.number == null && !entity.title && (
					<IconButton
						className="ml-auto size-5! [&>svg]:size-3!"
						data-github-open
						icon={<ExternalLink />}
						label={t("tools.github.openInBrowser")}
						onClick={() => openExternal(externalUrl)}
						size="sm"
					/>
				)}
			</div>

			{(title || entity.number != null) && (
				<div className="flex items-center gap-2 rounded-md bg-[var(--omp-code-bg)] px-2 py-1.5" ref={cardRef}>
					{entity.number != null && (
						<span className="shrink-0 font-mono text-omp-sm font-semibold text-[var(--omp-dim)]">
							#{entity.number}
						</span>
					)}
					<span className="min-w-0 flex-1 truncate text-omp-md font-medium text-[var(--omp-text)]">
						{title ?? t("tools.github.untitled")}
					</span>
					{state && (
						<span
							className="shrink-0 rounded-full px-1.5 py-px text-omp-xxs font-semibold capitalize"
							data-github-state={state.toLowerCase()}
							style={{
								color: STATE_COLOR[state.toLowerCase()] ?? "var(--omp-muted)",
								background: "var(--omp-bg-tertiary)",
							}}
						>
							{stateLabel(t, state)}
						</span>
					)}
					{prLink && externalUrl && (
						<IconButton
							className="size-5! [&>svg]:size-3!"
							data-github-pr-center
							icon={<GitPullRequestArrow />}
							label={t("linkPeek.openInPrCenter")}
							onClick={() => openPullRequest(scope, prLink, externalUrl)}
							size="sm"
						/>
					)}
					{issueLink && !issueLink.host && (
						<IconButton
							className="size-5! [&>svg]:size-3!"
							data-github-issue-center
							icon={<CircleDot />}
							label={t("tools.github.openInGithubCenter")}
							onClick={() => showIssue(issueLink.repo, issueLink.number)}
							size="sm"
						/>
					)}
					{externalUrl && (
						<IconButton
							className="size-5! [&>svg]:size-3!"
							data-github-open
							icon={<ExternalLink />}
							label={t("tools.github.openInBrowser")}
							onClick={() => openExternal(externalUrl)}
							size="sm"
						/>
					)}
				</div>
			)}

			{watch && (
				<div className="flex flex-col gap-1">
					{watch.note && <div className="text-omp-xs text-[var(--omp-dim)]">{watch.note}</div>}
					{watch.runs.map((run, ri) => (
						<div
							key={run.id ?? ri}
							className="rounded bg-[var(--omp-code-bg)] px-2 py-1 font-mono text-omp-sm leading-[1.7]"
						>
							<div className="flex items-center gap-2">
								<span className="min-w-0 flex-1 truncate text-[var(--omp-md-link)]">{run.label}</span>
								{run.branch && (
									<span className="shrink-0 text-omp-xs text-[var(--omp-text)]">{run.branch}</span>
								)}
								{run.id != null && (
									<span className="shrink-0 text-omp-xs text-[var(--omp-dim)]">#{run.id}</span>
								)}
							</div>
							{run.jobs.length === 0 && (
								<div className="text-omp-xs text-[var(--omp-dim)]">{t("tools.github.waitingJobs")}</div>
							)}
							{run.jobs.map(job => (
								<div key={job.id ?? job.name} className="flex items-center gap-2">
									<span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: jobColor(job) }} />
									<span className="min-w-0 flex-1 truncate text-[var(--omp-muted)]">{job.name}</span>
									{job.durationSeconds != null && (
										<span className="shrink-0 text-omp-xs tabular-nums text-[var(--omp-dim)]">
											{t("time.secondsShort", { count: job.durationSeconds })}
										</span>
									)}
								</div>
							))}
						</div>
					))}
					{watch.failedLogs.map((log, i) => (
						<div key={i} className="rounded bg-[var(--omp-tool-error-bg)]/40 px-2 py-1">
							<div className="font-mono text-omp-xs text-[var(--omp-error)]">
								{log.jobName ?? t("tools.github.job")}{" "}
								<span className="text-[var(--omp-dim)]">{log.context}</span>
							</div>
							{log.available && log.tail ? (
								<pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-omp-xs leading-[1.45] text-[var(--omp-muted)]">
									{hasAnsi(log.tail) ? <AnsiText text={log.tail} /> : log.tail}
								</pre>
							) : (
								<div className="text-omp-xs text-[var(--omp-dim)]">{t("tools.github.logUnavailable")}</div>
							)}
						</div>
					))}
				</div>
			)}

			{body && (
				<pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-omp-sm leading-[1.45] text-[var(--omp-tool-output)]">
					{withMentions(body)}
				</pre>
			)}

			{!entity.title && entity.number == null && !watch && !body && (
				<div className="text-omp-sm italic text-[var(--omp-dim)]">
					{isPartial ? t("tools.github.querying") : t("tools.github.noEntity")}
				</div>
			)}
		</div>
	);
}
