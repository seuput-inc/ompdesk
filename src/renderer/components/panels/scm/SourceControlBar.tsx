/**
 * The Changes panel's source-control row: branch picker, Pull (with the behind
 * count; a branch diverged from its upstream asks whether to merge or rebase,
 * with the commands shown to copy), Sync (fetch, then pull and push, or a leased
 * force push of a branch rebased after it was pushed) and Push or Publish (with
 * the ahead count), a menu for fetch, stash, pop and undo-last-commit, and the
 * banner of a merge, rebase, cherry-pick or revert that stopped (continue, skip a
 * commit, abort, review the conflicts here or ask this session's agent).
 * The list's own refresh sits in the toolbar above.
 */
import {
	Archive,
	ArchiveRestore,
	ArrowDown,
	ArrowDownUp,
	ArrowUp,
	CloudUpload,
	MoreHorizontal,
	RefreshCcw,
	Sparkles,
	Undo2,
} from "lucide-react";
import { useState } from "react";
import { isConflictStatus } from "../../../../shared/git-status";
import type { RpcGitChanges, RpcGitHead, RpcGitRemoteResult } from "../../../../shared/rpc-types";
import { handToTab } from "../../../lib/composer-handoff";
import { resolveConflictsPrompt } from "../../../lib/fix-prompts";
import { useT } from "../../../lib/i18n";
import type { TabRpc } from "../../../lib/tab-rpc";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { toastError } from "../../../stores/toast";
import { Button, ConfirmDialog, CopyButton, InlineNotice, MenuButton, Modal } from "../../common";
import { BranchPicker } from "./BranchPicker";
import type { NameRequest } from "./NameDialog";
import type { ScmRunner } from "./use-scm-action";

/** The commands a diverged Pull offers, as the person could type them (Orca `pull-policy-error-notice.tsx`). */
const PULL_POLICIES = [
	{ rebase: false, command: "git pull --no-rebase" },
	{ rebase: true, command: "git pull --rebase" },
] as const;

export function SourceControlBar({
	rpc,
	head,
	conflicts,
	runner,
	requestName,
	onReview,
}: {
	rpc: TabRpc;
	head: RpcGitHead;
	conflicts: number;
	runner: ScmRunner;
	requestName: (request: NameRequest) => void;
	/** Opens the conflict review of the stopped operation. */
	onReview?: () => void;
}) {
	const t = useT();
	const tabId = useRuntimeTabId();
	const [confirm, setConfirm] = useState<"undo" | "abort" | null>(null);
	const { busy, run } = runner;
	// A Pull of a branch that diverged from its upstream asks how to join them first (FR30).
	const [diverged, setDiverged] = useState(false);
	const pull = (rebase?: boolean) =>
		void run(
			"pull",
			{ type: "git_remote", action: "pull", ...(rebase === undefined ? {} : { rebase }) },
			{ failure: t("scm.remote.pullFailed") },
		);
	const blocked = busy !== null || head.operation !== null;
	const remoteReason = !head.hasRemote ? t("scm.remote.none") : !head.branch ? t("scm.remote.detached") : undefined;
	const operationLabel = head.operation ? t(`scm.operation.${head.operation}`) : "";
	// The conflicted paths are read when asked: the panel's list may be filtered by its search.
	const resolveWithAgent = async (target: string) => {
		try {
			const response = await rpc.getGitChanges();
			if (!response.success) throw new Error(response.error ?? t("rpc.failed"));
			const changes = response.data as RpcGitChanges;
			const files = changes.files.filter(file => isConflictStatus(file.status)).map(file => file.path);
			handToTab(target, {
				text: resolveConflictsPrompt({ operation: head.operation, files, cwd: changes.root ?? "" }),
				mode: "prepend",
			});
		} catch (error) {
			toastError({ title: t("fixWithAgent.failed"), error });
		}
	};
	return (
		<>
			<div className="flex flex-wrap items-center gap-1 border-b border-(--sc-divider) px-2 py-1.5" data-scm-bar>
				<BranchPicker branch={head.branch} disabled={blocked} requestName={requestName} rpc={rpc} runner={runner} />
				<div className="ml-auto flex shrink-0 items-center gap-0.5">
					<Button
						disabled={blocked || remoteReason !== undefined || !head.upstream}
						icon={<ArrowDown />}
						loading={busy === "pull"}
						onClick={() => (head.ahead > 0 && head.behind > 0 ? setDiverged(true) : pull())}
						size="sm"
						title={
							remoteReason ??
							(head.upstream
								? t("scm.remote.pullTitle", { upstream: head.upstream })
								: t("scm.remote.noUpstream"))
						}
						variant="ghost"
					>
						{t("scm.remote.pull")}
						{head.behind > 0 && <span className="tabular-nums text-(--sc-text-muted)">{head.behind}</span>}
					</Button>
					{head.upstream ? (
						<>
							<Button
								disabled={blocked || remoteReason !== undefined}
								icon={<ArrowDownUp />}
								loading={busy === "sync"}
								onClick={() =>
									void run(
										"sync",
										{ type: "git_remote", action: "sync" },
										{ failure: t("scm.remote.syncFailed") },
									)
								}
								size="sm"
								title={remoteReason ?? t("scm.remote.syncTitle", { upstream: head.upstream })}
								variant="ghost"
							>
								{t("scm.remote.sync")}
							</Button>
							<Button
								disabled={blocked || remoteReason !== undefined}
								icon={<ArrowUp />}
								loading={busy === "push"}
								onClick={() =>
									void run(
										"push",
										{ type: "git_remote", action: "push" },
										{ failure: t("scm.remote.pushFailed") },
									)
								}
								size="sm"
								title={remoteReason ?? t("scm.remote.pushTitle", { upstream: head.upstream })}
								variant="ghost"
							>
								{t("scm.remote.push")}
								{head.ahead > 0 && <span className="tabular-nums text-(--sc-text-muted)">{head.ahead}</span>}
							</Button>
						</>
					) : (
						<Button
							disabled={blocked || remoteReason !== undefined}
							icon={<CloudUpload />}
							loading={busy === "push"}
							onClick={() =>
								void run<RpcGitRemoteResult>(
									"push",
									{ type: "git_remote", action: "push" },
									{
										failure: t("scm.remote.pushFailed"),
										success: t("scm.remote.published", { branch: head.branch ?? "" }),
									},
								)
							}
							size="sm"
							title={remoteReason ?? t("scm.remote.publishTitle")}
							variant="ghost"
						>
							{t("scm.remote.publish")}
						</Button>
					)}
					<MenuButton
						align="end"
						disabled={busy !== null}
						icon={<MoreHorizontal />}
						items={[
							{
								id: "fetch",
								label: t("scm.remote.fetch"),
								icon: RefreshCcw,
								disabled: !head.hasRemote || head.operation !== null,
								disabledReason: head.hasRemote ? undefined : t("scm.remote.none"),
								onSelect: () =>
									void run(
										"fetch",
										{ type: "git_remote", action: "fetch" },
										{ failure: t("scm.remote.fetchFailed") },
									),
							},
							{
								id: "stash",
								label: t("scm.stash.push"),
								icon: Archive,
								disabled: head.operation !== null,
								onSelect: () =>
									requestName({
										title: t("scm.stash.push"),
										label: t("scm.stash.messageLabel"),
										submitLabel: t("scm.stash.submit"),
										optional: true,
										onSubmit: message =>
											void run(
												"stash",
												{ type: "git_stash", action: "push", message: message || undefined },
												{ failure: t("scm.stash.failed"), success: t("scm.stash.done") },
											),
									}),
							},
							{
								id: "pop",
								label: t("scm.stash.pop"),
								icon: ArchiveRestore,
								hint: head.stashes > 0 ? String(head.stashes) : undefined,
								disabled: head.stashes === 0 || head.operation !== null,
								onSelect: () =>
									void run("pop", { type: "git_stash", action: "pop" }, { failure: t("scm.stash.popFailed") }),
							},
							{
								id: "undo",
								label: t("scm.undoCommit"),
								icon: Undo2,
								disabled: head.operation !== null,
								separatorBefore: true,
								onSelect: () => setConfirm("undo"),
							},
						]}
						label={t("scm.more")}
						size="sm"
					/>
				</div>
			</div>
			{head.operation && (
				<InlineNotice
					action={
						<div className="flex gap-1">
							{conflicts > 0 && onReview && (
								<Button disabled={busy !== null} onClick={onReview} size="sm" variant="secondary">
									{t("scm.conflicts.review")}
								</Button>
							)}
							{conflicts > 0 && tabId && (
								<Button
									disabled={busy !== null}
									icon={<Sparkles />}
									onClick={() => void resolveWithAgent(tabId)}
									size="sm"
									variant="secondary"
								>
									{t("fixWithAgent.resolveConflicts")}
								</Button>
							)}
							<Button
								disabled={busy !== null || conflicts > 0}
								loading={busy === "continue"}
								onClick={() =>
									void run(
										"continue",
										{ type: "git_operation", action: "continue" },
										{ failure: t("scm.operation.continueFailed") },
									)
								}
								size="sm"
								variant="secondary"
							>
								{t("scm.operation.continue")}
							</Button>
							{head.operation !== "merge" && (
								<Button
									disabled={busy !== null}
									loading={busy === "skip"}
									onClick={() =>
										void run(
											"skip",
											{ type: "git_operation", action: "skip" },
											{ failure: t("scm.operation.skipFailed") },
										)
									}
									size="sm"
									variant="ghost"
								>
									{t("scm.operation.skip")}
								</Button>
							)}
							<Button disabled={busy !== null} onClick={() => setConfirm("abort")} size="sm" variant="ghost">
								{t("scm.operation.abort")}
							</Button>
						</div>
					}
					className="px-3"
					detail={conflicts > 0 ? t("scm.operation.conflicts", { count: conflicts }) : t("scm.operation.resolved")}
					live
					title={t("scm.operation.inProgress", { operation: operationLabel })}
					tone={conflicts > 0 ? "warning" : "info"}
				/>
			)}
			<ConfirmDialog
				confirmLabel={confirm === "undo" ? t("scm.undoCommit") : t("scm.operation.abort")}
				message={
					confirm === "undo"
						? t("scm.undoCommitBody")
						: t("scm.operation.abortBody", { operation: operationLabel })
				}
				onCancel={() => setConfirm(null)}
				onConfirm={() => {
					const action = confirm;
					setConfirm(null);
					if (action === "undo")
						void run("undo", { type: "git_undo_commit" }, { failure: t("scm.undoCommitFailed") });
					else if (action === "abort")
						void run(
							"abort",
							{ type: "git_operation", action: "abort" },
							{ failure: t("scm.operation.abortFailed") },
						);
				}}
				open={confirm !== null}
				title={
					confirm === "undo"
						? t("scm.undoCommitTitle")
						: t("scm.operation.abortTitle", { operation: operationLabel })
				}
				warning={confirm === "undo" && head.upstream && head.ahead === 0 ? t("scm.undoCommitPushed") : undefined}
			/>
			<Modal
				footer={
					<>
						<Button onClick={() => setDiverged(false)} variant="ghost">
							{t("common.cancel")}
						</Button>
						{PULL_POLICIES.map(policy => (
							<Button
								key={policy.command}
								onClick={() => {
									setDiverged(false);
									pull(policy.rebase);
								}}
								variant={policy.rebase ? "primary" : "secondary"}
							>
								{policy.rebase ? t("scm.remote.pullRebase") : t("scm.remote.pullMerge")}
							</Button>
						))}
					</>
				}
				onClose={() => setDiverged(false)}
				open={diverged}
				size="sm"
				title={t("scm.remote.divergedTitle")}
			>
				<div className="flex flex-col gap-3" data-pull-policy>
					<p className="text-sc-md leading-relaxed text-(--sc-text-secondary)">
						{t("scm.remote.divergedBody", {
							upstream: head.upstream ?? "",
							ahead: head.ahead,
							behind: head.behind,
						})}
					</p>
					{PULL_POLICIES.map(policy => (
						<div className="flex items-center gap-2" key={policy.command}>
							<code className="min-w-0 flex-1 truncate font-mono text-sc-sm">{policy.command}</code>
							<CopyButton label={t("scm.remote.copyCommand")} text={policy.command} />
						</div>
					))}
				</div>
			</Modal>
		</>
	);
}
