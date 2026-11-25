/**
 * A pull request's checks in the PR Center detail (Orca `inspect-pull-request/checks-tab*.tsx`,
 * `pull-request-page/checks/{details,row,rerun,toolbar}.tsx`): a one-line triage of what fails, still runs and waits
 * on an answer (Orca `checks-panel/presentation/triage-strip.tsx`), rerun of the failed checks' runs or of every run,
 * and each GitHub Actions check opening in place to its run (jobs, their annotations, the failed log with a copy
 * button: the GitHub center's `RunDetail`). Another CI's check opens its own page.
 */
import { CheckCircle2, Circle, ExternalLink, RotateCcw, XCircle } from "lucide-react";
import { useState } from "react";
import { githubConclusionPassed } from "../../../../shared/github-checks";
import type { RpcPrCheck, RpcPrDetail } from "../../../../shared/rpc-types";
import { github, useGithubLoad } from "../../../lib/github";
import { githubStateLabel } from "../../../lib/github-state";
import { useT } from "../../../lib/i18n";
import { openExternal } from "../../../lib/open-external";
import { usePrCenterStore } from "../../../stores/pr-center";
import { toast, toastError } from "../../../stores/toast";
import { AsyncSection, Button, Card, Collapse, DisclosureButton, IconButton } from "../../common";
import { RunDetail } from "../github/GithubActions";
import { pausedNotice } from "../github/shared";

/** The Actions run a check belongs to: its details page is `…/actions/runs/<run>/job/<job>`. */
export function checkRunId(url: string | undefined): number | null {
	const found = url ? /\/actions\/runs\/(\d+)(?:\/|$)/.exec(url) : null;
	return found ? Number(found[1]) : null;
}

const running = (check: RpcPrCheck) => !check.conclusion;
const failing = (check: RpcPrCheck) => Boolean(check.conclusion) && !githubConclusionPassed(check.conclusion ?? "");

function CheckIcon({ check }: { check: RpcPrCheck }) {
	const className = "size-(--sc-icon-sm) shrink-0";
	if (check.conclusion && githubConclusionPassed(check.conclusion)) {
		return <CheckCircle2 aria-hidden className={`${className} text-(--sc-success)`} />;
	}
	if (check.conclusion) return <XCircle aria-hidden className={`${className} text-(--sc-danger)`} />;
	if (["IN_PROGRESS", "QUEUED", "PENDING"].includes(check.status)) {
		return <Circle aria-hidden className={`${className} fill-current text-(--sc-warning)`} />;
	}
	return <Circle aria-hidden className={`${className} text-(--sc-text-subtle)`} />;
}

/** One line over the PR: failing and running checks and the review threads nobody resolved. */
export function PrTriage({ detail, unresolved }: { detail: RpcPrDetail; unresolved: number | null }) {
	const t = useT();
	const failed = detail.checks.filter(failing).length;
	const pending = detail.checks.filter(running).length;
	if (failed === 0 && pending === 0 && !unresolved) return null;
	return (
		<p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sc-sm" data-pr-triage>
			{failed > 0 && (
				<span className="text-(--sc-danger)">{t("prCenter.triage.failing", { count: String(failed) })}</span>
			)}
			{pending > 0 && (
				<span className="text-(--sc-warning)">{t("prCenter.triage.pending", { count: String(pending) })}</span>
			)}
			{unresolved ? (
				<span className="text-(--sc-text-secondary)">
					{t("prCenter.triage.unresolved", { count: String(unresolved) })}
				</span>
			) : null}
		</p>
	);
}

function CheckRun({ runId }: { runId: number }) {
	const load = useGithubLoad({ op: "run_get", id: runId }, String(runId));
	return (
		<AsyncSection
			error={load.error}
			loading={load.loading}
			notice={pausedNotice(load.pausedUntil)}
			onRetry={load.reload}
		>
			{load.data && <RunDetail embedded onChanged={load.reload} run={load.data} target={{}} />}
		</AsyncSection>
	);
}

function CheckRow({ check }: { check: RpcPrCheck }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const runId = checkRunId(check.url);
	const label = (
		<>
			<CheckIcon check={check} />
			<span className="min-w-0 truncate text-(--sc-text)">{check.name}</span>
			{check.workflow && <span className="truncate text-sc-xs text-(--sc-text-muted)">{check.workflow}</span>}
			<span className="ml-auto shrink-0 text-sc-xs text-(--sc-text-muted)">
				{githubStateLabel(t, check.conclusion ?? check.status)}
			</span>
		</>
	);
	if (runId === null) {
		return (
			<li className="flex items-center gap-2 px-3 py-2 text-sc-sm" data-pr-check>
				{label}
				{check.url && (
					<IconButton
						icon={<ExternalLink />}
						label={t("prCenter.checks.openDetails", { name: check.name })}
						onClick={() => openExternal(check.url ?? "")}
						size="sm"
					/>
				)}
			</li>
		);
	}
	return (
		<li data-pr-check>
			<DisclosureButton
				className="gap-2 px-3 py-2 text-sc-sm hover:bg-(--sc-hover)"
				onToggle={() => setOpen(!open)}
				open={open}
			>
				{label}
			</DisclosureButton>
			<Collapse open={open}>
				<div className="border-t border-(--sc-divider) px-3 py-3">
					<CheckRun runId={runId} />
				</div>
			</Collapse>
		</li>
	);
}

export function PrChecks({ detail }: { detail: RpcPrDetail }) {
	const t = useT();
	const [busy, setBusy] = useState<"failed" | "all" | null>(null);
	const runs = (checks: readonly RpcPrCheck[]) => [
		...new Set(checks.map(check => checkRunId(check.url)).filter((id): id is number => id !== null)),
	];
	const failedRuns = runs(detail.checks.filter(failing));
	const finishedRuns = runs(detail.checks.filter(check => !running(check)));
	const rerun = async (which: "failed" | "all") => {
		setBusy(which);
		try {
			for (const id of which === "failed" ? failedRuns : finishedRuns) {
				await github({ op: "run_rerun", id, failedOnly: which === "failed" });
			}
			toast({ variant: "success", message: t("prCenter.checks.rerunStarted") });
		} catch (error) {
			toastError({ title: t("prCenter.checks.rerunFailed"), error });
		} finally {
			setBusy(null);
			await usePrCenterStore.getState().reloadSelected();
		}
	};
	return (
		<section className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-2">
				<h3 className="text-sc-md font-semibold text-(--sc-text)">
					{t("prCenter.section.checks", { count: String(detail.checks.length) })}
				</h3>
				<div className="ml-auto flex gap-2">
					{failedRuns.length > 0 && (
						<Button
							disabled={busy !== null}
							icon={<RotateCcw />}
							loading={busy === "failed"}
							onClick={() => void rerun("failed")}
							size="sm"
							variant="secondary"
						>
							{t("prCenter.checks.rerunFailedRuns")}
						</Button>
					)}
					{finishedRuns.length > 0 && (
						<Button
							disabled={busy !== null}
							icon={<RotateCcw />}
							loading={busy === "all"}
							onClick={() => void rerun("all")}
							size="sm"
							variant="ghost"
						>
							{t("prCenter.checks.rerunAll")}
						</Button>
					)}
				</div>
			</div>
			<Card padding="none">
				<ul className="flex flex-col divide-y divide-(--sc-divider)">
					{detail.checks.map((check, index) => (
						// One rollup can hold two checks of one name (a `check` job in two workflows).
						<CheckRow check={check} key={`${index}:${check.name}`} />
					))}
				</ul>
			</Card>
		</section>
	);
}
