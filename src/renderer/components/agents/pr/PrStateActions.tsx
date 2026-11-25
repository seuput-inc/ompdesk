/**
 * A pull request's state in the PR Center detail: close and reopen (Orca `pr-actions-panel.tsx:103-160`,
 * `merge-actions.ts:22-107`; a close asks first), auto-merge on and off (`merge-actions.ts:200-275`; shown while
 * something blocks the merge, `pull-request-auto-merge-availability.ts:13-35`), and once the PR is merged the offer
 * to remove its branch's worktree when no session uses it any more (Orca `HostedReviewStateActions.tsx:155-187`;
 * here the safe removal of an unused worktree, `remove_orphan_worktree`, which re-checks that nothing is lost).
 */
import { GitPullRequestClosed, RotateCcw, Trash2, Zap, ZapOff } from "lucide-react";
import { useEffect, useState } from "react";
import type {
	RpcOrphanWorktree,
	RpcOrphanWorktrees,
	RpcPrDetail,
	RpcPrMergeMethod,
} from "../../../../shared/rpc-types";
import { github } from "../../../lib/github";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { usePrCenterStore } from "../../../stores/pr-center";
import { toast, toastError } from "../../../stores/toast";
import { Badge, Banner, Button, ConfirmDialog } from "../../common";

/** Whether auto-merge can help: an open, non-draft PR without conflicts that reviews or checks still hold back. */
export function autoMergeOffered(detail: RpcPrDetail): boolean {
	if (detail.state && detail.state !== "OPEN") return false;
	if (detail.autoMerge) return true;
	if (detail.isDraft || detail.mergeStateStatus === "DIRTY" || detail.mergeStateStatus === "UNSTABLE") return false;
	return (
		detail.reviewDecision === "REVIEW_REQUIRED" ||
		detail.reviewDecision === "CHANGES_REQUESTED" ||
		detail.mergeStateStatus === "BLOCKED" ||
		detail.mergeStateStatus === "BEHIND"
	);
}

/** Close an open PR (after asking), reopen a closed one; a merged PR has neither. */
export function PrStateButton({ detail }: { detail: RpcPrDetail }) {
	const t = useT();
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	if (detail.state === "MERGED") return null;
	const closed = detail.state === "CLOSED";
	const change = async () => {
		setBusy(true);
		try {
			await github({ op: "pr_state", number: detail.number, state: closed ? "open" : "closed" });
			toast({ variant: "success", message: t(closed ? "prCenter.state.reopened" : "prCenter.state.closedDone") });
			setConfirming(false);
		} catch (error) {
			toastError({ title: t(closed ? "prCenter.state.reopenFailed" : "prCenter.state.closeFailed"), error });
		} finally {
			setBusy(false);
			// A failed answer does not prove GitHub kept the old state: read what landed (Orca `merge-actions.ts:104`).
			await usePrCenterStore.getState().reloadSelected();
		}
	};
	return (
		<>
			<Button
				icon={closed ? <RotateCcw /> : <GitPullRequestClosed />}
				loading={busy && closed}
				onClick={() => (closed ? void change() : setConfirming(true))}
				size="sm"
				variant={closed ? "secondary" : "danger-soft"}
			>
				{t(closed ? "prCenter.state.reopen" : "prCenter.state.close")}
			</Button>
			<ConfirmDialog
				busy={busy}
				confirmLabel={t("prCenter.state.close")}
				message={t("prCenter.state.closeBody", { number: String(detail.number) })}
				onCancel={() => setConfirming(false)}
				onConfirm={() => void change()}
				open={confirming}
				title={t("prCenter.state.closeTitle", { number: String(detail.number) })}
			/>
		</>
	);
}

/** Auto-merge turned on or off; `method` is the one the merge dialog has chosen. */
export function PrAutoMergeButton({ detail, method }: { detail: RpcPrDetail; method: RpcPrMergeMethod }) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	if (!autoMergeOffered(detail)) return null;
	const on = Boolean(detail.autoMerge);
	const toggle = async () => {
		setBusy(true);
		try {
			await github({ op: "pr_auto_merge", number: detail.number, enable: !on, ...(on ? {} : { method }) });
			toast({ variant: "success", message: t(on ? "prCenter.autoMerge.disabled" : "prCenter.autoMerge.enabled") });
		} catch (error) {
			toastError({ title: t(on ? "prCenter.autoMerge.disableFailed" : "prCenter.autoMerge.enableFailed"), error });
		} finally {
			setBusy(false);
			await usePrCenterStore.getState().reloadSelected();
		}
	};
	return (
		<Button icon={on ? <ZapOff /> : <Zap />} loading={busy} onClick={() => void toggle()} variant="secondary">
			{t(on ? "prCenter.autoMerge.disable" : "prCenter.autoMerge.enable")}
		</Button>
	);
}

/** The header's mark while auto-merge waits: the method it merges with and who turned it on. */
export function PrAutoMergeBadge({ detail }: { detail: RpcPrDetail }) {
	const t = useT();
	if (!detail.autoMerge || (detail.state && detail.state !== "OPEN")) return null;
	return (
		<Badge title={t("prCenter.autoMerge.by", { login: detail.autoMerge.by })} variant="accent">
			{t("prCenter.autoMerge.on", { method: t(`prCenter.merge.method.${detail.autoMerge.method}`) })}
		</Badge>
	);
}

/** A merged PR whose branch still has a worktree no session uses: offer its safe removal. */
export function PrMergedWorktree({ detail }: { detail: RpcPrDetail }) {
	const t = useT();
	const rpc = useTabRpc();
	const [worktree, setWorktree] = useState<RpcOrphanWorktree | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const merged = detail.state === "MERGED";
	useEffect(() => {
		setWorktree(null);
		if (!merged) return;
		let live = true;
		rpc.command({ type: "get_orphan_worktrees" }, 180_000).then(
			response => {
				if (!live || !response.success) return;
				const found = (response.data as RpcOrphanWorktrees).worktrees.find(
					entry =>
						entry.branch === detail.headRefName && (entry.state === "landed" || entry.state === "untouched"),
				);
				setWorktree(found ?? null);
			},
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [rpc, merged, detail.headRefName]);
	if (!worktree) return null;
	const remove = async () => {
		setBusy(true);
		try {
			const response = await rpc.command({ type: "remove_orphan_worktree", path: worktree.path }, 360_000);
			if (!response.success) throw new Error(response.error);
			toast({ variant: "success", message: t("prCenter.worktree.removed", { branch: detail.headRefName }) });
			setWorktree(null);
			setConfirming(false);
		} catch (error) {
			toastError({ title: t("prCenter.worktree.removeFailed"), error });
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<Banner
				actions={
					<Button icon={<Trash2 />} onClick={() => setConfirming(true)} size="sm" variant="secondary">
						{t("prCenter.worktree.remove")}
					</Button>
				}
				compact
				data-pr-merged-worktree
				variant="neutral"
			>
				{t("prCenter.worktree.unused", { branch: detail.headRefName })}
			</Banner>
			<ConfirmDialog
				busy={busy}
				confirmLabel={t("prCenter.worktree.remove")}
				message={t("prCenter.worktree.removeBody", { path: worktree.path })}
				onCancel={() => setConfirming(false)}
				onConfirm={() => void remove()}
				open={confirming}
				title={t("prCenter.worktree.removeTitle", { branch: detail.headRefName })}
			/>
		</>
	);
}
