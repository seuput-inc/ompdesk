/**
 * The Changes panel of a folder that holds several repositories but is none itself (Orca's folder workspaces, FR40, and
 * nested-repo import, FB45): the repositories one walk found (`get_nested_repos`), each a section that opens its own
 * source control, and the same list as a checklist that adds the picked ones to the sidebar as projects. A walk that
 * stopped at its limit says so.
 */
import { FolderGit2, FolderPlus } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { RpcNestedRepos } from "../../../../shared/rpc-types";
import { errorDetail } from "../../../lib/error-detail";
import { useFocusedScope } from "../../../lib/focused-scope";
import { useT } from "../../../lib/i18n";
import type { TabRpc } from "../../../lib/tab-rpc";
import { toast, toastError } from "../../../stores/toast";
import { Button, Checkbox, DisclosureButton, EmptyState, InlineNotice, SkeletonRows } from "../../common";

export function NestedRepositories({ rpc, section }: { rpc: TabRpc; section: (repo: string) => ReactNode }) {
	const t = useT();
	const { cwd, device } = useFocusedScope();
	const [nested, setNested] = useState<RpcNestedRepos | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState<string | null>(null);
	const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => {
		let active = true;
		setNested(null);
		setError(null);
		rpc.command({ type: "get_nested_repos" }).then(
			response => {
				if (!active) return;
				if (response.success) setNested(response.data as RpcNestedRepos);
				else setError(response.error ?? t("rpc.failed"));
			},
			cause => {
				if (active) setError(errorDetail(cause));
			},
		);
		return () => {
			active = false;
		};
	}, [rpc, t]);
	if (error)
		return <InlineNotice className="px-3" detail={error} live title={t("scm.nested.loadFailed")} tone="danger" />;
	if (!nested) return <SkeletonRows className="px-3 py-2" label={t("common.loading")} widths={[50, 64, 44]} />;
	if (nested.repos.length === 0)
		return <EmptyState icon={<FolderGit2 />} size="sm" title={t("diffPanel.notRepoTitle")} />;
	const addPicked = async () => {
		const folder = cwd.replace(/[\\/]+$/, "");
		try {
			for (const repo of picked)
				await window.omp.sidebarProjects.command({ action: "add", path: `${folder}/${repo}` }, device);
			toast({ variant: "success", message: t("scm.nested.added", { count: picked.size }) });
			setPicked(new Set());
		} catch (cause) {
			toastError({ title: t("scm.nested.addFailed"), error: cause });
		}
	};
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-nested-repos>
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--sc-divider) px-3 py-1.5">
				<span className="min-w-0 flex-1 text-sc-xs text-(--sc-text-muted)">
					{t("scm.nested.summary", { count: nested.repos.length })}
				</span>
				<Button
					disabled={picked.size === 0}
					icon={<FolderPlus />}
					onClick={() => void addPicked()}
					size="sm"
					variant="secondary"
				>
					{t("scm.nested.add", { count: picked.size })}
				</Button>
			</div>
			{nested.truncated && (
				<InlineNotice
					className="px-3"
					detail={t("scm.nested.truncatedDetail")}
					title={t("scm.nested.truncated")}
					tone="info"
				/>
			)}
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				{nested.repos.map(repo => (
					<div
						className={open === repo ? "flex min-h-[24rem] flex-1 flex-col" : "shrink-0"}
						data-nested-repo={repo}
						key={repo}
					>
						<div className="flex items-center gap-2 border-b border-(--sc-divider) px-2 py-1">
							<Checkbox
								aria-label={t("scm.nested.pick", { name: repo })}
								checked={picked.has(repo)}
								onChange={() =>
									setPicked(previous => {
										const next = new Set(previous);
										if (next.has(repo)) next.delete(repo);
										else next.add(repo);
										return next;
									})
								}
							/>
							<DisclosureButton
								className="min-w-0 flex-1"
								onToggle={() => setOpen(current => (current === repo ? null : repo))}
								open={open === repo}
							>
								<span className="truncate text-sc-sm">{repo}</span>
							</DisclosureButton>
						</div>
						{open === repo && section(repo)}
					</div>
				))}
			</div>
		</div>
	);
}
