/**
 * Agents › GitHub › GitLab: merge requests over the GitLab CLI (`glab`) of the focused tab's machine (core
 * `native/ompdesk/crates/core/src/glab`, main `src/main/local/git/gitlab.ts`). `project` names `host/group/project`;
 * without it the checkout's own project. A failure carries `glab_missing`, `glab_unauthenticated`, `gitlab_forbidden`,
 * `gitlab_not_found`, `gitlab_rate_limited`, `gitlab_no_project`, `gitlab_untrusted_host` or `gitlab_failed`.
 */

/** `host/group/…/project`. */
export const GITLAB_PROJECT_PATTERN = /^[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9_.-]+){2,}$/;
/** A host with an optional port. */
export const GITLAB_HOST_PATTERN = /^[A-Za-z0-9.-]+(?::\d+)?$/;

export type GitlabMrState = "opened" | "merged" | "closed" | "all";

export type GitlabRequest = { project?: string } & (
	| { op: "status" }
	/** Signs glab in to `host` with a personal access token; the token goes to glab once and is never kept here. */
	| { op: "login"; host: string; token: string }
	| { op: "mr_list"; state: GitlabMrState; search?: string; mine?: "authored" | "reviewing" }
	| { op: "mr_get"; iid: number }
	| { op: "mr_action"; iid: number; action: "close" | "reopen" | "merge" | "approve" }
	| { op: "mr_comment"; iid: number; body: string }
	| { op: "rate_limit" }
);

export type GitlabOp = GitlabRequest["op"];

export interface GitlabRate {
	limit: number | null;
	remaining: number | null;
	/** Epoch seconds. */
	resetAt: number | null;
}

export interface GitlabMr {
	iid: number;
	title: string;
	/** `opened`, `closed`, `merged` or `locked`. */
	state: string;
	draft: boolean;
	author: string;
	sourceBranch: string;
	targetBranch: string;
	url: string;
	updatedAt: string;
	labels: string[];
	notes: number;
	mergeStatus: string;
}

export interface GitlabMrDetail extends GitlabMr {
	description: string;
	pipeline: { status: string; url: string };
	approvedBy: string[];
	comments: { id: number; author: string; body: string; createdAt: string }[];
}

export interface GitlabResults {
	status: { hosts: string[]; signedIn: boolean; project: string | null; envToken: string | null };
	login: { ok: true };
	mr_list: { project: string; items: GitlabMr[]; total: number | null; rate: GitlabRate | null };
	mr_get: GitlabMrDetail;
	mr_action: { ok: true };
	mr_comment: { ok: true };
	rate_limit: { rate: GitlabRate | null };
}
