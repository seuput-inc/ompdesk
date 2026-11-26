/**
 * Which changes the Changes panel lists (Orca's change scope, `change-scope-bar.tsx`, FR27): the uncommitted work, or
 * everything the branch holds against its base (committed and uncommitted, from the merge-base). Against the base it
 * names the base (the picker pins one for the repository), counts the commits each side has, warns which files would
 * conflict when the base's commits come in (FR51) and rebases onto the base (FR29; a stop is the operation banner's).
 */
import { GitPullRequestArrow } from "lucide-react";
import type { RpcGitCompare, RpcGitHead, RpcGitRebased } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import type { TabRpc } from "../../../lib/tab-rpc";
import { toast } from "../../../stores/toast";
import { Button, InlineNotice, Tabs } from "../../common";
import { BasePicker } from "./BasePicker";
import type { ScmRunner } from "./use-scm-action";

export type ChangeScope = "uncommitted" | "base";

export function ScopeBar({
	rpc,
	runner,
	head,
	scope,
	onScope,
	compare,
}: {
	rpc: TabRpc;
	runner: ScmRunner;
	head: RpcGitHead;
	scope: ChangeScope;
	onScope: (scope: ChangeScope) => void;
	/** The base range; undefined while it is read, null when the checkout has no base to compare with. */
	compare: RpcGitCompare | null | undefined;
}) {
	const t = useT();
	const blocked = runner.busy !== null || head.operation !== null;
	const rebase = (base: string) =>
		void runner
			.run<RpcGitRebased>(
				"rebase",
				{ type: "git_rebase_onto", base },
				{ failure: t("scm.base.rebaseFailed"), success: t("scm.base.rebased", { base }) },
			)
			.then(result => {
				if (result?.autostashKept) toast({ variant: "warning", message: t("scm.base.autostashKept") });
			});
	return (
		<>
			<div className="flex flex-wrap items-center gap-1 border-b border-(--sc-divider) px-2 py-1" data-scope-bar>
				<Tabs
					activeId={scope}
					ariaLabel={t("scm.scope.label")}
					compact
					onChange={id => onScope(id as ChangeScope)}
					tabs={[
						{ id: "uncommitted", label: t("scm.scope.uncommitted") },
						{ id: "base", label: t("scm.scope.base"), tooltip: t("scm.scope.baseHint") },
					]}
					variant="segmented"
				/>
				{scope === "base" && (
					<>
						<BasePicker compare={compare ?? null} disabled={blocked} rpc={rpc} runner={runner} />
						{compare && (
							<span className="text-sc-xs tabular-nums text-(--sc-text-muted)" data-base-counts>
								{t("scm.base.counts", { ahead: compare.ahead, behind: compare.behind })}
							</span>
						)}
						{compare && (
							<Button
								className="ml-auto"
								disabled={blocked || compare.behind === 0}
								disabledReason={compare.behind === 0 ? t("scm.base.upToDate") : undefined}
								icon={<GitPullRequestArrow />}
								loading={runner.busy === "rebase"}
								onClick={() => rebase(compare.baseRef)}
								size="sm"
								variant="ghost"
							>
								{t("scm.base.rebase")}
							</Button>
						)}
					</>
				)}
			</div>
			{scope === "base" && compare === null && (
				<InlineNotice className="px-3" detail={t("scm.base.noneDetail")} title={t("scm.base.none")} tone="info" />
			)}
			{scope === "base" && compare && compare.conflicts.length > 0 && (
				<InlineNotice
					action={
						<Button disabled={blocked} onClick={() => rebase(compare.baseRef)} size="sm" variant="secondary">
							{t("scm.base.rebase")}
						</Button>
					}
					className="px-3"
					detail={compare.conflicts.join("\n")}
					title={t("scm.base.conflicts", { count: compare.conflicts.length, base: compare.baseRef })}
					tone="warning"
				/>
			)}
		</>
	);
}
