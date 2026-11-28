/**
 * Every changed file's diff in one scroll (Orca's combined diff, `combined-diff/*`, FR83): a section per file with its
 * name, counts and a fold, the diffs read a few at a time as the list goes, review notes on their lines as in one
 * file's diff (the notes shelf above lists them all), pictures side by side, and a file's own view one click away.
 * Past `COMBINED_MAX` files the rest are named, not read.
 */
import { useEffect, useMemo, useState } from "react";
import type { RpcGitChanges, RpcGitDiff } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import type { TabRpc } from "../../../lib/tab-rpc";
import { Collapse, DisclosureButton, LinkButton } from "../../common";
import { ChangeCounts } from "../PanelChrome";
import { viewerKind } from "../viewers/file-kind";
import { DiffLines, DiffSkeleton } from "./DiffLines";
import { ImageDiff } from "./ImageDiff";
import { parseRepositoryDiff } from "./repository-diff";

/** Files whose diffs the view reads; a larger change lists the rest by name. */
const COMBINED_MAX = 60;
/** Diffs read at once. */
const READS_AT_ONCE = 4;

type ChangedFile = RpcGitChanges["files"][number];

export function CombinedDiff({
	rpc,
	files,
	root,
	against,
	notesOwner,
	scroller,
	onOpen,
	refresh,
}: {
	rpc: TabRpc;
	files: readonly ChangedFile[];
	root: string;
	/** The base range's merge-base; none diffs against HEAD. */
	against?: string;
	notesOwner: string | null;
	scroller: HTMLElement | null;
	onOpen: (path: string) => void;
	/** Bumped when the checkout changed: every diff is read again. */
	refresh: number;
}) {
	const t = useT();
	const shown = files.slice(0, COMBINED_MAX);
	const [diffs, setDiffs] = useState<Record<string, RpcGitDiff | string>>({});
	const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
	const paths = shown.map(file => file.path).join("\0");
	// biome-ignore lint/correctness/useExhaustiveDependencies: `paths` names the files; `refresh` asks again.
	useEffect(() => {
		let active = true;
		const queue = paths ? paths.split("\0") : [];
		const next = async () => {
			const path = queue.shift();
			if (path === undefined || !active) return;
			const answer = await rpc
				.getGitDiff(path, against)
				.then(response => (response.success ? (response.data as RpcGitDiff) : (response.error ?? t("rpc.failed"))))
				.catch(error => String(error));
			if (active) setDiffs(previous => ({ ...previous, [path]: answer }));
			await next();
		};
		void Promise.all(Array.from({ length: READS_AT_ONCE }, next));
		return () => {
			active = false;
		};
	}, [rpc, paths, against, refresh]);
	return (
		<div className="flex flex-col pb-3" data-combined-diff>
			{shown.map(file => {
				const open = !folded.has(file.path);
				const diff = diffs[file.path];
				return (
					<section className="border-b border-(--sc-divider)" data-combined-file={file.path} key={file.path}>
						<div className="sticky top-0 z-(--sc-z-sticky) flex min-h-(--sc-control-md) items-center gap-1.5 border-b border-(--sc-divider) bg-(--sc-surface-1) px-2 py-1 [[data-sheet-panel]_&]:bg-(--sc-elevated)">
							<DisclosureButton
								className="min-w-0 flex-1"
								onToggle={() =>
									setFolded(previous => {
										const next = new Set(previous);
										if (next.has(file.path)) next.delete(file.path);
										else next.add(file.path);
										return next;
									})
								}
								open={open}
							>
								<span className="truncate text-sc-sm" title={file.path}>
									{file.path}
								</span>
							</DisclosureButton>
							<ChangeCounts added={file.added} removed={file.removed} />
							<LinkButton onClick={() => onOpen(file.path)} tone="muted">
								{t("scm.combined.openFile")}
							</LinkButton>
						</div>
						<Collapse open={open}>
							<CombinedBody
								against={against}
								diff={diff}
								file={file}
								notesOwner={notesOwner}
								root={root}
								rpc={rpc}
								scroller={scroller}
							/>
						</Collapse>
					</section>
				);
			})}
			{files.length > COMBINED_MAX && (
				<p className="px-3 py-2 text-sc-xs text-(--sc-text-muted)">
					{t("scm.combined.more", { count: files.length - COMBINED_MAX })}
				</p>
			)}
		</div>
	);
}

function CombinedBody({
	rpc,
	file,
	diff,
	root,
	against,
	notesOwner,
	scroller,
}: {
	rpc: TabRpc;
	file: ChangedFile;
	diff: RpcGitDiff | string | undefined;
	root: string;
	against?: string;
	notesOwner: string | null;
	scroller: HTMLElement | null;
}) {
	const t = useT();
	const lines = useMemo(
		() => (typeof diff === "object" && diff.kind === "text" ? parseRepositoryDiff(diff.diff) : []),
		[diff],
	);
	if (diff === undefined) return <DiffSkeleton label={t("common.loading")} />;
	if (typeof diff === "string") return <p className="px-3 py-2 text-sc-sm text-(--sc-danger)">{diff}</p>;
	if (diff.kind !== "text")
		return viewerKind(file.path) === "image" ? (
			<ImageDiff against={against} oldPath={file.oldPath} path={file.path} root={root} rpc={rpc} />
		) : (
			<p className="px-3 py-2 text-sc-sm text-(--sc-text-muted)">{t(`diffPanel.kind.${diff.kind}`)}</p>
		);
	return (
		<DiffLines
			inFlow
			lines={lines}
			notes={notesOwner ? { owner: notesOwner } : undefined}
			path={file.path}
			scroller={scroller}
		/>
	);
}
