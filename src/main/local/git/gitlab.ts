/**
 * Agents › GitHub › GitLab over the user's `glab` (contract `src/shared/gitlab.ts`). The runs happen in the core
 * (`native/ompdesk/crates/core/src/glab`, `glab.request`); main keeps the check of what the page sent and hands the
 * core how glab runs (`glabRunner`), `null` when glab is not installed.
 */
import { z } from "zod";
import {
	GITLAB_HOST_PATTERN,
	GITLAB_PROJECT_PATTERN,
	type GitlabOp,
	type GitlabRequest,
	type GitlabResults,
} from "../../../shared/gitlab";
import { CoreError } from "../../core/process";
import { LocalCommandError } from "../types";
import { coreHeld, glabRunner, resolveBin } from "./exec";

/** A list reads the viewer and the list; a detail its notes and approvals too: four glab runs of 30 s at most. */
const GITLAB_MS = 4 * 30_000;

const iid = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const requestSchema = z
	.discriminatedUnion("op", [
		z.object({ op: z.literal("status") }),
		z.object({
			op: z.literal("login"),
			host: z.string().regex(GITLAB_HOST_PATTERN),
			token: z
				.string()
				.trim()
				.min(8)
				.max(512)
				.regex(/^[\x21-\x7e]+$/),
		}),
		z.object({
			op: z.literal("mr_list"),
			state: z.enum(["opened", "merged", "closed", "all"]),
			search: z.string().trim().max(256).optional(),
			mine: z.enum(["authored", "reviewing"]).optional(),
		}),
		z.object({ op: z.literal("mr_get"), iid }),
		z.object({ op: z.literal("mr_action"), iid, action: z.enum(["close", "reopen", "merge", "approve"]) }),
		z.object({ op: z.literal("mr_comment"), iid, body: z.string().trim().min(1).max(65_536) }),
		z.object({ op: z.literal("rate_limit") }),
	])
	.and(z.object({ project: z.string().regex(GITLAB_PROJECT_PATTERN).optional() }));

/** The codes the core refuses a GitLab request with, which the page gets as the command's `code`. */
const REFUSALS = new Set([
	"glab_missing",
	"glab_unauthenticated",
	"gitlab_forbidden",
	"gitlab_not_found",
	"gitlab_rate_limited",
	"gitlab_no_project",
	"gitlab_untrusted_host",
	"gitlab_failed",
	"tracker_busy",
]);

export async function gitlabCommand(cwd: string, raw: unknown): Promise<GitlabResults[GitlabOp]> {
	const parsed = requestSchema.safeParse(raw);
	if (!parsed.success) throw new LocalCommandError(`Invalid GitLab request: ${parsed.error.message}`, "gitlab_failed");
	const request: GitlabRequest = parsed.data;
	const bin = await resolveBin("glab");
	try {
		return await coreHeld("glab.request", { cwd, request, glab: bin ? await glabRunner(bin) : null }, GITLAB_MS);
	} catch (error) {
		if (error instanceof CoreError && REFUSALS.has(error.code))
			throw new LocalCommandError(error.message, error.code);
		throw error;
	}
}
