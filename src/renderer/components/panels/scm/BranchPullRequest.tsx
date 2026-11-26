/**
 * The Changes panel's pull request of the checkout's branch (Orca's review header and checks panel,
 * `panel/header-review-actions.tsx`, `checks-panel/presentation/checks-list.tsx`, `presentation/triage-strip.tsx`,
 * MIT): its number and title open it in the PR Center, its state, the failing and running checks in one line, and the
 * checks themselves (with their run, log and rerun, `PrChecks`) when unfolded. A branch with no PR shows nothing.
 * While it is open it is read again each minute in the background (Orca's selected tier, `stores/branch-prs.ts`).
 */
import { GitPullRequest } from "lucide-react";
import { useEffect, useState } from "react";
import type { GithubBranchPr } from "../../../../shared/github";
import type { RpcPrDetail } from "../../../../shared/rpc-types";
import { githubItemLink, sessionLinkLabel } from "../../../../shared/session-links";
import { useFocusedScope } from "../../../lib/focused-scope";
import { useGithubLoad } from "../../../lib/github";
import { useT } from "../../../lib/i18n";
import { openExternal } from "../../../lib/open-external";
import { openPullRequest } from "../../../lib/open-pull-request";
import { pollWhileVisible } from "../../../lib/visible-poll";
import { ACTIVE_REFRESH_MS } from "../../../stores/branch-prs";
import { useSessionStore } from "../../../stores/session";
import { useSessionLinks } from "../../../stores/session-links";
import { PrChecks } from "../../agents/pr/PrChecks";
import {
	Badge,
	type BadgeVariant,
	Collapse,
	DisclosureButton,
	ErrorDetail,
	LinkButton,
	SkeletonRows,
} from "../../common";
import { SessionLinksDialog } from "../../layout/sidebar/SidebarSessionLinks";

const STATE_TONE: Record<string, BadgeVariant> = {
	open: "success",
	draft: "default",
	merged: "accent",
	closed: "muted",
};

const stateOf = (pr: GithubBranchPr) => (pr.isDraft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase());

/** The PR's checks, read once when unfolded (`pr_get` carries each check with its run). */
function Checks({ number }: { number: number }) {
	const t = useT();
	const [detail, setDetail] = useState<RpcPrDetail | null>(null);
	const [error, setError] = useState<unknown>(null);
	useEffect(() => {
		let live = true;
		window.omp.rpc.prGet(number).then(
			response => {
				if (!live) return;
				if (response.success) setDetail(response.data as RpcPrDetail);
				else setError(response);
			},
			cause => live && setError(cause),
		);
		return () => {
			live = false;
		};
	}, [number]);
	if (error) return <ErrorDetail error={error} />;
	if (!detail) return <SkeletonRows label={t("common.loading")} widths={[70, 56, 64]} />;
	return <PrChecks detail={detail} />;
}

/**
 * No PR names this branch as its head (a fork's, a renamed branch's): the session's own linked PR when it has one
 * (Orca's "Link another PR", `presentation/review-header.tsx:115`, `empty-content.tsx:139`), else the way to link one.
 */
function LinkedPullRequest({ sessionPath }: { sessionPath: string }) {
	const t = useT();
	const scope = useFocusedScope();
	const linked = useSessionLinks(sessionPath).find(link => link.kind === "pr");
	const [editing, setEditing] = useState(false);
	return (
		<div
			className="flex min-w-0 items-center gap-1.5 px-3 pb-2 text-sc-xs text-(--sc-text-muted)"
			data-branch-pr-link
		>
			<GitPullRequest aria-hidden className="size-(--sc-icon-sm) shrink-0" />
			{linked?.repo && linked.number !== undefined ? (
				<LinkButton
					className="min-w-0 truncate"
					onClick={() =>
						openPullRequest(scope, { repo: linked.repo ?? "", number: linked.number ?? 0 }, linked.url)
					}
				>
					{sessionLinkLabel(linked)}
				</LinkButton>
			) : (
				<span className="min-w-0 truncate">{t("diffPanel.pr.none")}</span>
			)}
			<LinkButton className="ml-auto shrink-0" onClick={() => setEditing(true)} tone="muted">
				{t(linked ? "diffPanel.pr.relink" : "diffPanel.pr.link")}
			</LinkButton>
			{editing && <SessionLinksDialog onClose={() => setEditing(false)} sessionPath={sessionPath} />}
		</div>
	);
}

export function BranchPullRequest({ branch }: { branch: string }) {
	const t = useT();
	const scope = useFocusedScope();
	const sessionFile = useSessionStore(state => state.sessionFile);
	const load = useGithubLoad({ op: "pr_for_branch", branch }, branch);
	const pr = load.data;
	const [open, setOpen] = useState(false);
	const live = pr?.state === "OPEN";
	const { refresh } = load;
	useEffect(() => (live ? pollWhileVisible(refresh, ACTIVE_REFRESH_MS) : undefined), [live, refresh]);
	// A read that answered "no PR" on this computer's session; a failed read (no GitHub remote, no gh) says nothing.
	if (!pr) {
		return pr === null && !load.loading && !load.error && sessionFile && scope.device === undefined ? (
			<LinkedPullRequest sessionPath={sessionFile} />
		) : null;
	}
	const state = stateOf(pr);
	const link = githubItemLink(pr.url);
	const { failure, pending } = pr.checks;
	return (
		<section
			aria-label={t("diffPanel.pr.label")}
			className="flex flex-col gap-1 px-3 pb-2"
			data-branch-pr={pr.number}
		>
			<div className="flex min-w-0 items-center gap-1.5 text-sc-sm">
				<GitPullRequest aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
				<LinkButton
					className="min-w-0 truncate"
					onClick={() => (link ? openPullRequest(scope, link, pr.url) : openExternal(pr.url))}
					title={t("diffPanel.pr.open")}
				>
					#{pr.number} {pr.title}
				</LinkButton>
				<Badge className="ml-auto shrink-0" size="xs" variant={STATE_TONE[state] ?? "default"}>
					{t(`sidebar.row.prState.${state}`)}
				</Badge>
			</div>
			{(pr.checks.success > 0 || failure > 0 || pending > 0) && (
				<DisclosureButton
					className="gap-1.5 text-sc-xs text-(--sc-text-muted)"
					onToggle={() => setOpen(!open)}
					open={open}
				>
					<span className="truncate">
						{failure > 0
							? t("sidebar.row.prChecks.failure", { count: failure })
							: pending > 0
								? t("sidebar.row.prChecks.pending", { count: pending })
								: t("sidebar.row.prChecks.passing")}
					</span>
				</DisclosureButton>
			)}
			<Collapse open={open}>{open && <Checks number={pr.number} />}</Collapse>
		</section>
	);
}
