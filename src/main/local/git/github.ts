/**
 * Agents › GitHub (C94–C99) over the user's `gh` CLI: issues, Actions,
 * releases, notifications and repositories, plus a GitHub Enterprise host and
 * another repository than the tab's checkout. Contract: `src/shared/github.ts`.
 * The operations run in the core process (`native/ompdesk/crates/core/src/gh/center.rs`,
 * `gh.github`); main keeps the check of what the page sent (`parseGithubRequest`)
 * and spells a clone's destination and its folder with node's `path`.
 * Failures carry gh_missing / gh_unauthenticated / not_a_repo / no_github_remote
 * (as `pr_repo` finds the checkout's repository) or github_failed with gh's own message.
 */
import * as path from "node:path";
import { z } from "zod";
import {
	GITHUB_HOST_PATTERN,
	GITHUB_IMAGE_MAX_BYTES,
	GITHUB_IMAGE_TYPES,
	GITHUB_LOGIN_PATTERN,
	GITHUB_REACTIONS,
	GITHUB_REPO_NAME_PATTERN,
	GITHUB_REPO_PATTERN,
	type GithubOp,
	type GithubRequest,
	type GithubResults,
} from "../../../shared/github";
import { LocalCommandError } from "../types";
import { GITHUB_REPO_MS, ghRequest } from "./pr";

/** Longest a clone may take before main gives up on it. */
const CLONE_TIMEOUT_MS = 600_000;
const LOG_TIMEOUT_MS = 120_000;
/** Main's answer budget for one `github` command: the clone plus resolving gh and the repository. */
export const GITHUB_COMMAND_BUDGET_MS = CLONE_TIMEOUT_MS + 120_000;

/** A positional gh argument: never empty, never read as a flag. */
const word = z
	.string()
	.trim()
	.min(1)
	.max(250)
	.refine(value => !value.startsWith("-") && !/\s/.test(value));
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(65_536);
const title = z.string().trim().min(1).max(256);
/** A GitHub login (a user can be assigned or asked to review). */
const login = z.string().regex(GITHUB_LOGIN_PATTERN);
/** A GraphQL node id (`PRRT_kwDO…`, `IC_kwDO…`). */
const nodeId = z.string().regex(/^[A-Za-z0-9_=-]{1,200}$/);
const people = z.object({
	labels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
	assignees: z.array(login).max(10).optional(),
	reviewers: z.array(login).max(15).optional(),
});

const requestSchema = z
	.discriminatedUnion("op", [
		z.object({ op: z.literal("hosts") }),
		z.object({
			op: z.literal("issue_list"),
			state: z.enum(["open", "closed", "all"]),
			search: z.string().trim().max(256).optional(),
		}),
		z.object({ op: z.literal("issue_get"), number: id }),
		z.object({ op: z.literal("issue_create"), title, body: text }),
		z.object({ op: z.literal("issue_edit"), number: id, title, body: text }),
		z.object({ op: z.literal("issue_state"), number: id, state: z.enum(["open", "closed"]) }),
		z.object({ op: z.literal("issue_comment"), number: id, body: z.string().trim().min(1).max(65_536) }),
		z.object({ op: z.literal("repo_list"), owner: word.optional() }),
		z.object({ op: z.literal("repo_get") }),
		z.object({
			op: z.literal("repo_create"),
			name: z.string().refine(name => GITHUB_REPO_NAME_PATTERN.test(name) || GITHUB_REPO_PATTERN.test(name)),
			visibility: z.enum(["public", "private", "internal"]),
			description: z.string().trim().max(350),
		}),
		z.object({ op: z.literal("repo_clone"), destination: z.string().refine(path.isAbsolute) }),
		z.object({ op: z.literal("repo_fork") }),
		z.object({ op: z.literal("workflow_list") }),
		z.object({ op: z.literal("run_list"), workflow: word.optional() }),
		z.object({ op: z.literal("run_get"), id }),
		z.object({ op: z.literal("run_log"), id, failedOnly: z.boolean() }),
		z.object({ op: z.literal("workflow_dispatch"), workflow: word, ref: word.optional() }),
		z.object({ op: z.literal("run_rerun"), id, failedOnly: z.boolean() }),
		z.object({ op: z.literal("run_cancel"), id }),
		z.object({ op: z.literal("release_list") }),
		z.object({ op: z.literal("release_get"), tag: word }),
		z.object({
			op: z.literal("release_create"),
			tag: word,
			title,
			notes: text,
			draft: z.boolean(),
			prerelease: z.boolean(),
			target: word.optional(),
		}),
		z.object({
			op: z.literal("release_edit"),
			tag: word,
			title,
			notes: text,
			draft: z.boolean(),
			prerelease: z.boolean(),
		}),
		z.object({ op: z.literal("notification_list"), all: z.boolean() }),
		z.object({ op: z.literal("notification_read"), id: z.string().regex(/^\d{1,20}$/) }),
		z.object({ op: z.literal("notification_read_all") }),
		z.object({ op: z.literal("pr_state"), number: id, state: z.enum(["open", "closed"]) }),
		z.object({
			op: z.literal("pr_auto_merge"),
			number: id,
			enable: z.boolean(),
			method: z.enum(["merge", "squash", "rebase"]).optional(),
		}),
		z.object({ op: z.literal("people"), kind: z.enum(["pr", "issue"]), number: id, add: people, remove: people }),
		z.object({ op: z.literal("assignable") }),
		z.object({ op: z.literal("label_list") }),
		z.object({ op: z.literal("pr_conversation"), number: id }),
		z.object({
			op: z.literal("thread_reply"),
			number: id,
			commentId: id,
			body: z.string().trim().min(1).max(65_536),
		}),
		z.object({ op: z.literal("thread_resolve"), threadId: nodeId, resolved: z.boolean() }),
		z.object({ op: z.literal("reaction"), subjectId: nodeId, content: z.enum(GITHUB_REACTIONS), add: z.boolean() }),
		z.object({ op: z.literal("pr_files_viewed"), number: id }),
		z.object({
			op: z.literal("pr_file_viewed"),
			pullRequestId: nodeId,
			path: z.string().min(1).max(4096),
			viewed: z.boolean(),
		}),
		z.object({ op: z.literal("pr_stack"), number: id }),
		z.object({ op: z.literal("pr_for_branch"), branch: word }),
		z.object({ op: z.literal("pr_template") }),
		z.object({ op: z.literal("rate_limit") }),
		z.object({ op: z.literal("item_peek"), number: id }),
		z.object({
			op: z.literal("image_upload"),
			name: z.string().trim().min(1).max(200),
			contentType: z.enum(GITHUB_IMAGE_TYPES),
			// base64 of at most GITHUB_IMAGE_MAX_BYTES.
			data: z
				.string()
				.min(4)
				.max(Math.ceil(GITHUB_IMAGE_MAX_BYTES / 3) * 4)
				.regex(/^[A-Za-z0-9+/]+={0,2}$/),
		}),
		z.object({
			op: z.literal("attachment"),
			url: z
				.string()
				.max(4096)
				.refine(url => /^https:\/\/[a-z0-9.-]+\.githubusercontent\.com\//i.test(url)),
		}),
		z.object({ op: z.literal("pr_diffs"), number: id }),
		z.object({ op: z.literal("project_list") }),
		z.object({
			op: z.literal("project_view"),
			owner: z.string().regex(GITHUB_LOGIN_PATTERN),
			ownerType: z.enum(["organization", "user"]),
			number: id,
			viewId: nodeId.optional(),
			query: z.string().max(1024).optional(),
		}),
		z.object({
			op: z.literal("project_field"),
			projectId: nodeId,
			itemId: nodeId,
			fieldId: nodeId,
			value: z
				.discriminatedUnion("kind", [
					z.object({ kind: z.literal("single-select"), optionId: z.string().min(1).max(200) }),
					z.object({ kind: z.literal("iteration"), iterationId: z.string().min(1).max(200) }),
					z.object({ kind: z.literal("text"), text: z.string().max(1024) }),
					z.object({ kind: z.literal("number"), number: z.number().finite() }),
					z.object({ kind: z.literal("date"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
				])
				.optional(),
		}),
	])
	.and(
		z.object({
			host: z.string().regex(GITHUB_HOST_PATTERN).optional(),
			repo: z.string().regex(GITHUB_REPO_PATTERN).optional(),
		}),
	);

export function parseGithubRequest(raw: unknown): GithubRequest {
	const parsed = requestSchema.safeParse(raw);
	if (!parsed.success) throw new LocalCommandError(`Invalid GitHub request: ${parsed.error.message}`, "github_failed");
	return parsed.data;
}

/** `background`: an automatic re-read of the page, held behind GitHub's rate limit and pace (core `gh/gate.rs`). */
export async function githubCommand(cwd: string, raw: unknown, background = false): Promise<GithubResults[GithubOp]> {
	const request = parseGithubRequest(raw);
	const destination = request.op === "repo_clone" ? path.resolve(request.destination) : null;
	return ghRequest(
		"gh.github",
		{
			cwd,
			request: destination === null ? request : { ...request, destination, parent: path.dirname(destination) },
			cloneTimeoutMs: CLONE_TIMEOUT_MS,
			logTimeoutMs: LOG_TIMEOUT_MS,
			...(background ? { background } : {}),
		},
		GITHUB_REPO_MS + CLONE_TIMEOUT_MS,
	);
}
