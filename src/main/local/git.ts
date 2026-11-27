/** Git / worktree / PR / source-control commands (rpc-map §5), answered in main over the git and gh CLIs. */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { RpcPrListFilter } from "../../shared/rpc-types";
import {
	archiveBeforeRemove,
	listSavedWorktrees,
	restoreSavedWorktree,
	savedWorktreeStore,
} from "../disk/saved-worktrees";
import { gitFingerprints } from "../git-fingerprints";
import { listOrphanWorktrees, removeOrphanWorktree, sessionOpenFolders } from "../worktree-orphans";
import {
	getGitChanges,
	getGitCompare,
	getGitDiff,
	getGitImage,
	getGitStatus,
	primaryRoot,
	repoRoot,
} from "./git/changes";
import { githubCommand } from "./git/github";
import { gitlabCommand } from "./git/gitlab";
import { getNestedRepos } from "./git/nested";
import {
	prCheckout,
	prComment,
	prComments,
	prCreate,
	prDiff,
	prDraft,
	prEdit,
	prGet,
	prList,
	prMerge,
	prRepo,
	prReview,
} from "./git/pr";
import * as scm from "./git/scm";
import { setupDraft } from "./git/setup-draft";
import { getGitUnlanded } from "./git/unlanded";
import {
	createWorktree,
	prefetchWorktreeBase,
	prepareCreatedWorktree,
	removeWorktree,
	renameUnpushedBranch,
	sparsePresets,
	worktreeBranchSource,
} from "./git/worktree";
import { hasSetupScript, saveSetupScript, setupScriptText, WORKTREE_HOOK_SCRIPTS } from "./git/worktree-seed";
import { LocalCommandError, type LocalHandler } from "./types";

const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const pathsOrAll = (value: unknown) => (value === "all" ? "all" : Array.isArray(value) ? (value as string[]) : []);
/** One PR list filter value gh takes after its flag: a login, `@me` or a label, never read as a flag. */
const filterValue = (value: unknown) => {
	const text = str(value)?.trim();
	return text && text.length <= 100 && !text.startsWith("-") ? text : undefined;
};

/** The PR list's filters the page sent (`RpcPrListFilter`), each one kept only when gh can take it. */
function prListFilter(raw: unknown): RpcPrListFilter {
	const filter = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	return {
		author: filterValue(filter.author),
		label: filterValue(filter.label),
		assignee: filterValue(filter.assignee),
		draft: filter.draft === true,
	};
}

export const handlers: Record<string, LocalHandler> = {
	get_git_status: (_command, ctx) => getGitStatus(ctx.cwd),
	get_git_changes: (_command, ctx) => getGitChanges(ctx.cwd),
	// The work board's "Not in main yet" row: a session branch's commits and uncommitted work (git/unlanded.ts).
	get_git_unlanded: (_command, ctx) => getGitUnlanded(ctx.cwd),
	// One watch per checkout for the whole app answers every window's and tab's check (git-fingerprints.ts).
	get_git_fingerprint: (command, ctx) => gitFingerprints.read(ctx.cwd, str(command.root)),
	get_git_diff: (command, ctx) => getGitDiff(ctx.cwd, str(command.path) ?? "", str(command.against)),
	get_git_compare: (_command, ctx) => getGitCompare(ctx.cwd),
	get_git_image: (command, ctx) => getGitImage(ctx.cwd, str(command.path) ?? "", str(command.against)),
	git_set_base: (command, ctx) => scm.setBase(ctx.cwd, str(command.base) ?? null),
	worktree_create: (command, ctx) => {
		const requestId = str(command.requestId);
		return createWorktree(
			ctx.cwd,
			{
				name: str(command.name) ?? "",
				baseCwd: str(command.baseCwd),
				baseRef: command.baseRef === null ? null : str(command.baseRef) || "HEAD",
				branchPrefix: str(command.branchPrefix),
				branch: worktreeBranchSource(command.branch),
				sparse: str(command.sparse) || undefined,
				...(command.prepare === false ? { prepare: false } : {}),
				...(requestId && requestId.length <= 100 ? { request: { caller: "local", id: requestId } } : {}),
			},
			ctx.bridge,
		);
	},
	// The new task sheet's own step after `worktree_create {prepare: false}`: the seed and the setup hook.
	worktree_prepare: (command, ctx) => prepareCreatedWorktree(str(command.baseCwd) ?? ctx.cwd, str(command.path) ?? ""),
	// The worktree dialog's fetch of the remote default branch when it opens (git/worktree.ts).
	worktree_prefetch: (command, ctx) => prefetchWorktreeBase(str(command.baseCwd) ?? ctx.cwd),
	// The repository's `.ompdesk/sparse` presets (core git/sparse.rs), offered by the new task sheet.
	worktree_sparse_presets: (command, ctx) => sparsePresets(str(command.baseCwd) ?? ctx.cwd),
	// A setup hook drafted from another tool's config when the repository has none (git/setup-draft.ts): read only.
	worktree_setup_draft: async (command, ctx) => {
		const cwd = str(command.baseCwd) ?? ctx.cwd;
		const primary = await primaryRoot(cwd).catch(() => null);
		if (!primary || (await hasSetupScript(primary))) return null;
		const draft = await setupDraft(cwd);
		return draft ? { ...draft, script: WORKTREE_HOOK_SCRIPTS.setup, text: setupScriptText(draft.commands) } : null;
	},
	// The person saves the draft they read and edited; never over an existing script.
	worktree_setup_save: async (command, ctx) =>
		saveSetupScript(await primaryRoot(str(command.baseCwd) ?? ctx.cwd), str(command.text) ?? ""),
	// A name for a new task from its first prompt, by the session's title model (bridge modes/auto-title-engine.ts).
	worktree_name_suggest: (command, ctx) =>
		ctx.bridge.request("suggest_title", { text: (str(command.text) ?? "").slice(0, 4000) }),
	// A new task's placeholder branch named for its work once its session has a title, while never published (FS91).
	worktree_rename_branch: (command, ctx) =>
		renameUnpushedBranch(ctx.cwd, str(command.from) ?? "", str(command.to) ?? ""),
	worktree_remove: (command, ctx) =>
		removeWorktree({ path: str(command.path) ?? "", force: command.force === true }, ctx.bridge, ctx.cwd),
	// Orphaned worktrees (src/main/worktree-orphans.ts): which folders sessions hold is the whole app's, not this tab's.
	get_orphan_worktrees: (_command, ctx) =>
		listOrphanWorktrees(ctx.cwd, { bridge: ctx.bridge, openFolders: sessionOpenFolders }),
	// The person asked for this removal: no process check, but what no tool makes again is archived first.
	remove_orphan_worktree: (command, ctx) =>
		removeOrphanWorktree(
			ctx.cwd,
			str(command.path) ?? "",
			{ bridge: ctx.bridge, openFolders: sessionOpenFolders },
			{ prepare: archiveBeforeRemove(savedWorktreeStore(), null) },
		),
	// Worktrees disk care saved and removed (src/main/disk/saved-worktrees.ts), for this tab's repository.
	get_saved_worktrees: async (_command, ctx) => ({
		worktrees: await listSavedWorktrees(await primaryRoot(ctx.cwd), savedWorktreeStore()),
	}),
	restore_saved_worktree: (command, ctx) =>
		primaryRoot(ctx.cwd).then(async primary => {
			const id = str(command.savedId) ?? "";
			const mine = (await listSavedWorktrees(primary, savedWorktreeStore())).some(record => record.id === id);
			if (!mine) throw new LocalCommandError(`No saved worktree ${id} in this repository.`, "not_saved");
			return restoreSavedWorktree(id, savedWorktreeStore());
		}),
	pr_repo: (_command, ctx) => prRepo(ctx.cwd),
	// Agents › GitHub: issues, Actions, releases, notifications, repositories (request validated in github.ts).
	github: (command, ctx) => githubCommand(ctx.cwd, command.request, command.background === true),
	// Agents › GitHub › GitLab: merge requests over glab (request validated in gitlab.ts).
	gitlab: (command, ctx) => gitlabCommand(ctx.cwd, command.request),
	pr_list: (command, ctx) =>
		prList(ctx.cwd, {
			state: command.state as "open" | "closed" | "merged" | "all" | undefined,
			limit: typeof command.limit === "number" ? command.limit : undefined,
			view: command.view === "review" || command.view === "mine" ? command.view : "all",
			filter: prListFilter(command.filter),
			background: command.background === true,
		}),
	pr_get: (command, ctx) =>
		prGet(ctx.cwd, { number: Number(command.number), background: command.background === true }),
	pr_diff: (command, ctx) => prDiff(ctx.cwd, { number: Number(command.number), path: str(command.path) ?? "" }),
	pr_draft: (command, ctx) => prDraft(ctx.cwd, ctx.omp, { base: str(command.base), head: str(command.head) }),
	pr_create: (command, ctx) =>
		prCreate(ctx.cwd, {
			title: str(command.title) ?? "",
			body: str(command.body) ?? "",
			base: str(command.base),
			head: str(command.head),
			draft: command.draft === true,
		}),
	pr_checkout: (command, ctx) => prCheckout(ctx.cwd, { number: Number(command.number) }, ctx.bridge),
	pr_merge: (command, ctx) =>
		prMerge(ctx.cwd, {
			number: Number(command.number),
			method: command.method === "squash" || command.method === "rebase" ? command.method : "merge",
			deleteBranch: command.deleteBranch === true,
		}),
	pr_review: (command, ctx) =>
		prReview(ctx.cwd, {
			number: Number(command.number),
			event: command.event === "approve" || command.event === "request_changes" ? command.event : "comment",
			body: str(command.body) ?? "",
		}),
	pr_comment: (command, ctx) => prComment(ctx.cwd, { number: Number(command.number), body: str(command.body) ?? "" }),
	pr_comments: (command, ctx) => prComments(ctx.cwd, { number: Number(command.number) }),
	pr_edit: (command, ctx) =>
		prEdit(ctx.cwd, {
			number: Number(command.number),
			title: str(command.title),
			body: str(command.body),
			base: str(command.base),
		}),
	git_stage: (command, ctx) => scm.stage(ctx.cwd, pathsOrAll(command.paths)),
	git_unstage: (command, ctx) => scm.unstage(ctx.cwd, pathsOrAll(command.paths)),
	git_discard: (command, ctx) => scm.discard(ctx.cwd, Array.isArray(command.paths) ? command.paths : []),
	git_commit: (command, ctx) =>
		scm.commit(ctx.cwd, { message: str(command.message) ?? "", amend: command.amend === true }),
	git_commit_message: (_command, ctx) => scm.commitMessage(ctx.cwd, ctx.omp),
	git_last_commit_message: (_command, ctx) => scm.lastCommitMessage(ctx.cwd),
	git_undo_commit: (_command, ctx) => scm.undoCommit(ctx.cwd),
	git_remote: (command, ctx) =>
		scm.remote(
			ctx.cwd,
			command.action === "push" || command.action === "pull" || command.action === "sync" ? command.action : "fetch",
			typeof command.rebase === "boolean" ? command.rebase : undefined,
		),
	git_stash: (command, ctx) => scm.stash(ctx.cwd, command.action === "pop" ? "pop" : "push", str(command.message)),
	git_operation: (command, ctx) =>
		scm.operation(ctx.cwd, command.action === "abort" ? "abort" : command.action === "skip" ? "skip" : "continue"),
	git_rebase_onto: (command, ctx) => scm.rebaseOnto(ctx.cwd, str(command.base) ?? ""),
	git_resolve_conflict: (command, ctx) =>
		scm.resolveConflict(
			ctx.cwd,
			str(command.path) ?? "",
			command.side === "theirs" ? "theirs" : command.side === "both" ? "both" : "ours",
		),
	git_branches: (_command, ctx) => scm.branches(ctx.cwd),
	git_branch: (command, ctx) =>
		scm.branch(ctx.cwd, {
			action:
				(["switch", "create", "rename", "delete", "merge"] as const).find(a => a === command.action) ?? "switch",
			name: str(command.name) ?? "",
			newName: str(command.newName),
			base: str(command.base),
			force: command.force === true,
		}),
	git_log: (command, ctx) =>
		scm.log(ctx.cwd, {
			limit: typeof command.limit === "number" ? command.limit : undefined,
			skip: typeof command.skip === "number" ? command.skip : undefined,
			query: str(command.query),
			branch: str(command.branch),
		}),
	// The Files viewer's Blame toggle (FR87): the file the tab's folder holds, run in that folder.
	get_git_blame: (command, ctx) => scm.blame(ctx.cwd, str(command.path) ?? ""),
	git_commit_detail: (command, ctx) => scm.commitDetail(ctx.cwd, str(command.sha) ?? ""),
	git_commit_diff: (command, ctx) => scm.commitDiff(ctx.cwd, str(command.sha) ?? "", str(command.path) ?? ""),
	git_history_action: (command, ctx) => {
		const action = (
			[
				"checkout",
				"branch",
				"cherry_pick",
				"revert",
				"reset",
				"tag",
				"delete_tag",
				"move_earlier",
				"move_later",
			] as const
		).find(a => a === command.action);
		if (!action) throw new Error(`Unknown history action: ${String(command.action)}`);
		return scm.historyAction(ctx.cwd, {
			action,
			sha: str(command.sha) ?? "",
			mode: command.mode === "soft" || command.mode === "hard" ? command.mode : "mixed",
			name: str(command.name),
		});
	},
	// The repositories inside a folder that is not one (core git/nested.rs): one Changes section each (FR40, FB45).
	get_nested_repos: (_command, ctx) => getNestedRepos(ctx.cwd),
};

/**
 * The Changes panel's commands that may name one repository inside the tab's folder (`repo`, relative to it) when that
 * folder holds several checkouts: each section reads and changes its own repository. Anything else keeps the tab's own.
 */
const NESTED_COMMANDS = [
	"get_git_status",
	"get_git_changes",
	"get_git_fingerprint",
	"get_git_diff",
	"get_git_compare",
	"get_git_image",
	"get_git_blame",
	"git_set_base",
	"git_stage",
	"git_unstage",
	"git_discard",
	"git_commit",
	"git_commit_message",
	"git_last_commit_message",
	"git_undo_commit",
	"git_remote",
	"git_stash",
	"git_operation",
	"git_rebase_onto",
	"git_resolve_conflict",
	"git_branches",
	"git_branch",
	"git_log",
	"git_commit_detail",
	"git_commit_diff",
	"git_history_action",
] as const;

/** `repo` under `cwd`: a relative folder that is a checkout's own root, reached through no link out of `cwd`. */
async function nestedFolder(cwd: string, repo: unknown): Promise<string> {
	const refuse = () => new LocalCommandError(`Not a repository inside ${cwd}: ${String(repo)}`, "invalid_path");
	if (typeof repo !== "string" || !repo || path.isAbsolute(repo) || repo.split(/[/\\]/).includes("..")) throw refuse();
	const [base, folder] = await Promise.all([fs.realpath(cwd), fs.realpath(path.join(cwd, repo))]).catch(() => {
		throw refuse();
	});
	const root = await repoRoot(folder);
	if (!folder.startsWith(base + path.sep) || !root || (await fs.realpath(root)) !== folder) throw refuse();
	return folder;
}

for (const type of NESTED_COMMANDS) {
	const handler = handlers[type];
	if (!handler) continue;
	handlers[type] = async (command, ctx) =>
		command.repo === undefined
			? handler(command, ctx)
			: handler(command, { ...ctx, cwd: await nestedFolder(ctx.cwd, command.repo) });
}
