/**
 * The base the Changes panel's "Against base" range compares with: a chip naming it (and why: the repository's pick,
 * the branch's upstream, or the remote's default branch) that opens a filter over the branches. Picking one pins it for
 * the repository (`git_set_base`, every worktree of it shares the pick); "Automatic" unpins it. Orca's
 * `BaseRefPicker.tsx` and "Change Base Ref" (FR28), re-implemented.
 */
import { GitCompareArrows, RotateCcw } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { RpcGitBranch, RpcGitCompare } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import type { TabRpc } from "../../../lib/tab-rpc";
import { Button, InlineNotice, ListRow, Popover, SearchField, SectionLabel, SkeletonRows } from "../../common";
import { useBranchList } from "./use-branch-list";
import type { ScmRunner } from "./use-scm-action";

export function BasePicker({
	rpc,
	compare,
	disabled,
	runner,
}: {
	rpc: TabRpc;
	compare: Pick<RpcGitCompare, "baseRef" | "source" | "pinned"> | null;
	disabled?: boolean;
	runner: ScmRunner;
}) {
	const t = useT();
	const anchorRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const { list, error } = useBranchList(rpc, open);
	const needle = query.trim().toLocaleLowerCase();
	const shown = useMemo(
		() => (list ?? []).filter(item => !item.current && item.name.toLocaleLowerCase().includes(needle)),
		[list, needle],
	);
	const close = () => {
		setOpen(false);
		setQuery("");
	};
	const pick = (base: string | null) => {
		close();
		void runner.run("base", { type: "git_set_base", base }, { failure: t("scm.base.setFailed") });
	};
	const label = compare ? compare.baseRef : t("scm.base.none");
	const why = compare ? t(`scm.base.source.${compare.source}`) : "";
	const row = (item: RpcGitBranch) => (
		<ListRow
			key={`${item.remote ? "r" : "l"}:${item.name}`}
			meta={compare?.pinned === item.name ? t("scm.base.pinned") : undefined}
			onClick={() => pick(item.name)}
			selected={compare?.baseRef === item.name}
			size="sm"
			title={item.name}
			titleText={item.name}
		/>
	);
	return (
		<>
			<Button
				aria-expanded={open}
				aria-haspopup="dialog"
				className="min-w-0 max-w-[16rem]"
				data-base-picker
				disabled={disabled}
				icon={<GitCompareArrows />}
				onClick={() => setOpen(value => !value)}
				ref={anchorRef}
				size="sm"
				title={compare ? t("scm.base.title", { base: compare.baseRef, why }) : t("scm.base.none")}
				variant="ghost"
			>
				<span className="truncate">{label}</span>
			</Button>
			<Popover anchorRef={anchorRef} ariaLabel={t("scm.base.pickerLabel")} onClose={close} open={open}>
				<div className="flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 p-2">
					<SearchField
						autoFocus
						controlSize="sm"
						label={t("scm.base.filter")}
						onValueChange={setQuery}
						placeholder={t("scm.base.filter")}
						value={query}
					/>
					<div className="max-h-[min(24rem,60dvh)] overflow-y-auto">
						<ListRow
							description={t("scm.base.automaticHint")}
							leading={<RotateCcw aria-hidden className="size-(--sc-icon-sm)" />}
							onClick={() => pick(null)}
							selected={compare !== null && compare.pinned === undefined}
							size="sm"
							title={t("scm.base.automatic")}
						/>
						{error ? (
							<InlineNotice detail={error} live title={t("scm.branch.loadFailed")} tone="danger" />
						) : list === null ? (
							<SkeletonRows className="py-1" label={t("common.loading")} widths={[60, 44, 70]} />
						) : (
							<>
								{shown.some(item => !item.remote) && (
									<SectionLabel as="h4" className="px-2 pt-1 pb-0.5">
										{t("scm.branch.local")}
									</SectionLabel>
								)}
								{shown.filter(item => !item.remote).map(row)}
								{shown.some(item => item.remote) && (
									<SectionLabel as="h4" className="px-2 pt-2 pb-0.5">
										{t("scm.branch.remote")}
									</SectionLabel>
								)}
								{shown.filter(item => item.remote).map(row)}
							</>
						)}
					</div>
				</div>
			</Popover>
		</>
	);
}
