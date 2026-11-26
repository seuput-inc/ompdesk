/**
 * Agents › GitHub (C94–C99): issues, Actions, releases, notifications and
 * repositories over the user's `gh` CLI, one `github` RPC command whose
 * `request.op` picks the operation (main: `src/main/local/git/github.ts`).
 *
 * Every request may name a GitHub Enterprise `host` the user signed `gh` in to;
 * repository operations may name another `repo` (`OWNER/NAME`) than the tab's
 * checkout. Both are checked by the shapes below before gh sees them.
 */

/** `OWNER/NAME` as GitHub allows them (no host part; the host travels separately). */
export const GITHUB_REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** A GitHub login. */
export const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** A host name gh can be signed in to, e.g. `github.com` or `ghe.example.com:8443`. */
export const GITHUB_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/i;
/** A new repository's name. */
export const GITHUB_REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** Where an operation runs: the gh host (default: gh's own) and, for repository operations, the repository. */
export interface GithubTarget {
	host?: string;
	/** `OWNER/NAME`; default: the tab checkout's GitHub repository. */
	repo?: string;
}

export type GithubIssueState = "open" | "closed" | "all";
export type GithubVisibility = "public" | "private" | "internal";

export type GithubRequest = GithubTarget &
	(
		| { op: "hosts" }
		| { op: "issue_list"; state: GithubIssueState; search?: string }
		| { op: "issue_get"; number: number }
		| { op: "issue_create"; title: string; body: string }
		| { op: "issue_edit"; number: number; title: string; body: string }
		| { op: "issue_state"; number: number; state: "open" | "closed" }
		| { op: "issue_comment"; number: number; body: string }
		| { op: "repo_list"; owner?: string }
		| { op: "repo_get" }
		| { op: "repo_create"; name: string; visibility: GithubVisibility; description: string }
		/** Clone `repo` into `destination`, an absolute path that does not exist yet. */
		| { op: "repo_clone"; destination: string }
		| { op: "repo_fork" }
		| { op: "workflow_list" }
		| { op: "run_list"; workflow?: string }
		| { op: "run_get"; id: number }
		| { op: "run_log"; id: number; failedOnly: boolean }
		/** Start a `workflow_dispatch` workflow on `ref` (default: the repository's default branch, as gh's). */
		| { op: "workflow_dispatch"; workflow: string; ref?: string }
		| { op: "run_rerun"; id: number; failedOnly: boolean }
		| { op: "run_cancel"; id: number }
		| { op: "release_list" }
		| { op: "release_get"; tag: string }
		| {
				op: "release_create";
				tag: string;
				title: string;
				notes: string;
				draft: boolean;
				prerelease: boolean;
				target?: string;
		  }
		| { op: "release_edit"; tag: string; title: string; notes: string; draft: boolean; prerelease: boolean }
		| { op: "notification_list"; all: boolean }
		| { op: "notification_read"; id: string }
		| { op: "notification_read_all" }
		/** Close or reopen a PR. */
		| { op: "pr_state"; number: number; state: "open" | "closed" }
		/** Auto-merge with `method` once nothing blocks the PR, or off (`enable: false`). */
		| { op: "pr_auto_merge"; number: number; enable: boolean; method?: GithubMergeMethod }
		/** Labels, assignees and (on a PR) requested reviewers to add and remove. */
		| { op: "people"; kind: "pr" | "issue"; number: number; add: GithubPeople; remove: GithubPeople }
		/** Who can be assigned, asked to review or @mentioned in the repository. */
		| { op: "assignable" }
		| { op: "label_list" }
		| { op: "pr_conversation"; number: number }
		/** Reply inside a review thread to its first comment (`commentId`: that comment's REST id). */
		| { op: "thread_reply"; number: number; commentId: number; body: string }
		| { op: "thread_resolve"; threadId: string; resolved: boolean }
		| { op: "reaction"; subjectId: string; content: GithubReactionContent; add: boolean }
		| { op: "pr_files_viewed"; number: number }
		| { op: "pr_file_viewed"; pullRequestId: string; path: string; viewed: boolean }
		| { op: "pr_stack"; number: number }
		/** The PR of a branch of the checkout's repository: its open one, else its newest. */
		| { op: "pr_for_branch"; branch: string }
		| { op: "pr_template" }
		| { op: "rate_limit" }
		/** An issue's or PR's title and state, for a link's peek and a PR card that follows its PR. */
		| { op: "item_peek"; number: number }
		/** A pasted or dropped image uploaded as a GitHub attachment (github.com and `*.ghe.com`); `data` is base64. */
		| { op: "image_upload"; name: string; contentType: GithubImageType; data: string }
		/** A private attachment's signed image (a `images` value of a conversation) as a `data:` URL the page can show. */
		| { op: "attachment"; url: string }
		/** Every file's diff of a PR from one read, by path (Expand all). */
		| { op: "pr_diffs"; number: number }
		/** Projects (v2) the viewer and its organizations have. */
		| { op: "project_list" }
		/** A project's view (by id, else its first table, roadmap or board) with its items; `query` replaces its filter. */
		| {
				op: "project_view";
				owner: string;
				ownerType: GithubProjectOwnerType;
				number: number;
				viewId?: string;
				query?: string;
		  }
		/** Set (or with no `value`, clear) one field of one item. */
		| { op: "project_field"; projectId: string; itemId: string; fieldId: string; value?: GithubProjectFieldInput }
	);

export type GithubOp = GithubRequest["op"];
export type GithubMergeMethod = "merge" | "squash" | "rebase";
export interface GithubPeople {
	labels?: string[];
	assignees?: string[];
	reviewers?: string[];
}
/** GraphQL's `ReactionContent`, in GitHub's order. */
export const GITHUB_REACTIONS = [
	"THUMBS_UP",
	"THUMBS_DOWN",
	"LAUGH",
	"HOORAY",
	"CONFUSED",
	"HEART",
	"ROCKET",
	"EYES",
] as const;
export type GithubReactionContent = (typeof GITHUB_REACTIONS)[number];
export interface GithubReactionCount {
	content: GithubReactionContent;
	count: number;
	viewerHasReacted: boolean;
}
/** A comment of a PR's conversation or of one of its review threads. */
export interface GithubThreadComment {
	/** GraphQL node id (reactions). */
	id: string;
	/** REST id (a thread reply names the thread's first comment by it). */
	databaseId: number | null;
	author: string;
	body: string;
	createdAt: string;
	url: string;
	reactions: GithubReactionCount[];
	/** A private attachment's URL in `body` → the signed URL it shows through (absent when it holds none). */
	images?: GithubImageMap;
}
/** Private attachment URLs as written in a body → the short-lived signed URL GitHub shows each through. */
export type GithubImageMap = Record<string, string>;
/** The image types GitHub's attachments take (Orca `shared/github/attachments/image-attachment.ts`), at most 10 MB. */
export const GITHUB_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"] as const;
export type GithubImageType = (typeof GITHUB_IMAGE_TYPES)[number];
export const GITHUB_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export interface GithubReviewThread {
	id: string;
	isResolved: boolean;
	path: string;
	line: number | null;
	/** The diff hunk the thread's first comment sits on. */
	diffHunk: string;
	comments: GithubThreadComment[];
}
export interface GithubReview {
	id: string;
	author: string;
	body: string;
	/** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED. */
	state: string;
	createdAt: string;
	url: string;
	reactions: GithubReactionCount[];
	images?: GithubImageMap;
}
export type GithubTimelineKind =
	| "labeled"
	| "unlabeled"
	| "closed"
	| "reopened"
	| "merged"
	| "force_pushed"
	| "review_requested"
	| "assigned"
	| "unassigned"
	| "ready_for_review"
	| "converted_to_draft"
	| "renamed"
	| "commit"
	| "referenced";
export interface GithubTimelineEvent {
	kind: GithubTimelineKind;
	actor: string;
	createdAt: string;
	/** The label, reviewer, assignee, new title, commit headline, merged ref or referencing item. */
	subject?: string;
	url?: string;
	sha?: string;
}
export interface GithubPrConversation {
	/** The PR's GraphQL node id. */
	id: string;
	/** The PR description's private attachments (`images` of its body). */
	bodyImages: GithubImageMap;
	comments: GithubThreadComment[];
	reviews: GithubReview[];
	threads: GithubReviewThread[];
	timeline: GithubTimelineEvent[];
}
export interface GithubLabel {
	name: string;
	color: string;
	description: string;
}
export interface GithubStackEntry {
	number: number;
	title: string;
	state: string;
	isDraft: boolean;
	headRefName: string;
	baseRefName: string;
	url: string;
	current: boolean;
}
export interface GithubRateResource {
	name: "core" | "graphql" | "search";
	limit: number;
	remaining: number;
	used: number;
	/** Seconds since 1970. */
	reset: number;
}
export interface GithubItemPeek {
	number: number;
	title: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	isPr: boolean;
	isDraft: boolean;
	author: string;
	comments: number;
	url: string;
	updatedAt: string;
}
export interface GithubBranchPr {
	number: number;
	title: string;
	url: string;
	isDraft: boolean;
	authorLogin: string;
	headRefName: string;
	baseRefName: string;
	additions: number;
	deletions: number;
	updatedAt: string;
	reviewDecision: string | null;
	checks: { success: number; failure: number; pending: number };
	/** OPEN, CLOSED or MERGED. */
	state: string;
}

export interface GithubIssue {
	number: number;
	title: string;
	state: "OPEN" | "CLOSED";
	author: string;
	labels: string[];
	assignees: string[];
	commentCount: number;
	updatedAt: string;
	url: string;
}
export interface GithubComment {
	author: string;
	body: string;
	createdAt: string;
}
export interface GithubIssueDetail extends GithubIssue {
	body: string;
	comments: GithubComment[];
}
export interface GithubRepo {
	nameWithOwner: string;
	description: string;
	visibility: string;
	isFork: boolean;
	stars: number;
	updatedAt: string;
	url: string;
}
export interface GithubRepoDetail extends GithubRepo {
	defaultBranch: string;
	homepage: string;
	license: string;
	sshUrl: string;
	/** `OWNER/NAME` it was forked from, else null. */
	parent: string | null;
}
export interface GithubWorkflow {
	id: number;
	name: string;
	path: string;
	state: string;
}
export interface GithubRun {
	id: number;
	workflow: string;
	title: string;
	/** queued, in_progress, completed, … */
	status: string;
	/** success, failure, cancelled, … ("" while it runs). */
	conclusion: string;
	branch: string;
	event: string;
	createdAt: string;
	url: string;
}
export interface GithubAnnotation {
	path: string;
	line: number | null;
	/** notice, warning, failure. */
	level: string;
	title: string;
	message: string;
}
export interface GithubJob {
	id: number;
	name: string;
	status: string;
	conclusion: string;
	/** A failed job's annotations (the first five failed jobs). */
	annotations: GithubAnnotation[];
}
export interface GithubRunDetail extends GithubRun {
	jobs: GithubJob[];
}
export interface GithubRelease {
	tag: string;
	name: string;
	isDraft: boolean;
	isPrerelease: boolean;
	isLatest: boolean;
	publishedAt: string;
	createdAt: string;
}
export interface GithubAsset {
	name: string;
	size: number;
	downloads: number;
}
export interface GithubReleaseDetail extends GithubRelease {
	body: string;
	target: string;
	url: string;
	assets: GithubAsset[];
}
export interface GithubNotification {
	id: string;
	unread: boolean;
	reason: string;
	title: string;
	type: string;
	repo: string;
	updatedAt: string;
	/** The web page of the issue, PR, release or repository it is about. */
	url: string;
}

/** What each operation answers. */
export interface GithubResults {
	hosts: { hosts: string[]; repo: string | null };
	issue_list: GithubIssue[];
	issue_get: GithubIssueDetail;
	issue_create: { number: number; url: string };
	issue_edit: { ok: true };
	issue_state: { ok: true };
	issue_comment: { ok: true };
	repo_list: GithubRepo[];
	repo_get: GithubRepoDetail;
	repo_create: { url: string };
	repo_clone: { path: string };
	repo_fork: { ok: true };
	workflow_list: GithubWorkflow[];
	run_list: GithubRun[];
	run_get: GithubRunDetail;
	/** The log's last lines (`truncated` when earlier ones were dropped). */
	run_log: { text: string; truncated: boolean };
	workflow_dispatch: { ok: true };
	run_rerun: { ok: true };
	run_cancel: { ok: true };
	release_list: GithubRelease[];
	release_get: GithubReleaseDetail;
	release_create: { url: string };
	release_edit: { ok: true };
	notification_list: GithubNotification[];
	notification_read: { ok: true };
	notification_read_all: { ok: true };
	pr_state: { ok: true };
	pr_auto_merge: { ok: true };
	people: { ok: true };
	assignable: string[];
	label_list: GithubLabel[];
	pr_conversation: GithubPrConversation;
	thread_reply: { ok: true };
	thread_resolve: { ok: true };
	reaction: { ok: true };
	pr_files_viewed: { id: string; files: Array<{ path: string; state: "VIEWED" | "UNVIEWED" | "DISMISSED" }> };
	pr_file_viewed: { ok: true };
	/** Bottom first; empty when the PR stands alone. */
	pr_stack: GithubStackEntry[];
	pr_for_branch: GithubBranchPr | null;
	pr_template: { body: string | null };
	rate_limit: GithubRateResource[];
	item_peek: GithubItemPeek;
	image_upload: { url: string };
	attachment: { dataUrl: string };
	pr_diffs: Record<string, string>;
	project_list: { projects: GithubProjectSummary[]; partialFailure: string | null };
	project_view: GithubProjectTable;
	project_field: { ok: true };
}

/** A project (v2) one can open (core `gh/projects.rs`; Orca `project-view-discovery.ts`). */
export interface GithubProjectSummary {
	id: string;
	owner: string;
	ownerType: GithubProjectOwnerType;
	number: number;
	title: string;
	url: string;
}

export type GithubProjectOwnerType = "organization" | "user";
export type GithubProjectLayout = "TABLE_LAYOUT" | "BOARD_LAYOUT" | "ROADMAP_LAYOUT";

export type GithubProjectField =
	| { kind: "field"; id: string; name: string; dataType: string }
	| {
			kind: "single-select";
			id: string;
			name: string;
			dataType: "SINGLE_SELECT";
			options: { id: string; name: string; color: string }[];
	  }
	| {
			kind: "iteration";
			id: string;
			name: string;
			dataType: "ITERATION";
			iterations: { id: string; title: string; startDate: string; duration: number }[];
	  };

export type GithubProjectValue =
	| { kind: "single-select"; optionId: string; name: string; color: string }
	| { kind: "iteration"; iterationId: string; title: string; startDate: string; duration: number }
	| { kind: "text"; text: string }
	| { kind: "number"; number: number }
	| { kind: "date"; date: string }
	| { kind: "labels"; labels: string[] }
	| { kind: "users"; users: string[] };

/** A value written to an item's field (`project_field`); none clears it. */
export type GithubProjectFieldInput =
	| { kind: "single-select"; optionId: string }
	| { kind: "iteration"; iterationId: string }
	| { kind: "text"; text: string }
	| { kind: "number"; number: number }
	| { kind: "date"; date: string };

export interface GithubProjectRow {
	id: string;
	itemType: "ISSUE" | "PULL_REQUEST" | "DRAFT_ISSUE" | "REDACTED";
	number: number | null;
	title: string;
	/** A draft issue's text. */
	body: string | null;
	url: string | null;
	state: string | null;
	isDraft: boolean | null;
	/** `OWNER/NAME` of an issue's or PR's repository. */
	repository: string | null;
	assignees: string[];
	labels: string[];
	/** By field id. */
	values: Record<string, GithubProjectValue>;
	updatedAt: string;
}

export interface GithubProjectTable {
	project: {
		id: string;
		title: string;
		url: string;
		owner: string;
		ownerType: GithubProjectOwnerType;
		number: number;
	};
	views: { id: string; number: number | null; name: string; layout: string }[];
	view: {
		id: string;
		name: string;
		layout: GithubProjectLayout;
		/** The view's own filter (a read may replace it). */
		filter: string;
		fields: GithubProjectField[];
		groupBy: GithubProjectField[];
		sortBy: { direction: "ASC" | "DESC"; field: GithubProjectField }[];
	};
	/** In the project's order. */
	rows: GithubProjectRow[];
	totalCount: number;
}
