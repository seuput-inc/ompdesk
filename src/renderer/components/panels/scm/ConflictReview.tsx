/**
 * Conflict review for a stopped merge, rebase, cherry-pick or revert (Orca's `conflict-review/*`, FR85): every file
 * still in conflict, each with its diff and a way to settle it here (keep HEAD's side, the incoming side or both, or mark
 * it resolved once edited by hand: the core stages it), and the files resolved since the stop under them. A file
 * leaves the unresolved list only when git says so; one this computer saw conflicted in this stop is remembered as
 * resolved (C1-29), so a failed read of the list never reads as "all resolved". When nothing is left it says so and
 * offers Continue.
 */
import { Check, CheckCircle2, FileDiff, MoreHorizontal } from "lucide-react";
import { isConflictStatus } from "../../../../shared/git-status";
import type { RpcGitChanges } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import { Button, EmptyState, ListRow, MenuButton, SectionLabel } from "../../common";
import { FileIcon } from "../viewers/FileViewer";
import type { ScmRunner } from "./use-scm-action";

/** The paths seen conflicted per stop (`checkout:operation:head`), kept while the app runs. */
const seen = new Map<string, Set<string>>();

export function ConflictReview({
	stop,
	files,
	runner,
	onOpen,
}: {
	/** Names the stop: the checkout, the operation and the commit it stopped on. */
	stop: string;
	files: RpcGitChanges["files"];
	runner: ScmRunner;
	onOpen: (path: string) => void;
}) {
	const t = useT();
	const conflicted = files.filter(file => isConflictStatus(file.status)).map(file => file.path);
	const remembered = seen.get(stop) ?? new Set<string>();
	for (const path of conflicted) remembered.add(path);
	seen.set(stop, remembered);
	const resolved = [...remembered].filter(path => !conflicted.includes(path));
	const busy = runner.busy !== null;
	const settle = (path: string, side: "ours" | "theirs" | "both") =>
		void runner.run(
			"resolve",
			{ type: "git_resolve_conflict", path, side },
			{ failure: t("scm.conflicts.resolveFailed", { path }) },
		);
	return (
		<div className="flex flex-col gap-1 px-3 pb-3" data-conflict-review>
			<SectionLabel as="h3" count={conflicted.length} className="pt-2">
				{t("scm.conflicts.unresolved")}
			</SectionLabel>
			{conflicted.length === 0 ? (
				<EmptyState
					actions={
						<Button
							loading={runner.busy === "continue"}
							disabled={busy}
							onClick={() =>
								void runner.run(
									"continue",
									{ type: "git_operation", action: "continue" },
									{ failure: t("scm.operation.continueFailed") },
								)
							}
							size="sm"
							variant="primary"
						>
							{t("scm.operation.continue")}
						</Button>
					}
					icon={<CheckCircle2 />}
					size="sm"
					title={t("scm.conflicts.allResolved")}
				/>
			) : (
				conflicted.map(path => (
					<div className="flex items-center gap-1" data-conflict-file={path} key={path}>
						<ListRow
							className="min-w-0 flex-1"
							leading={<FileIcon className="size-(--sc-icon-sm) shrink-0" path={path} />}
							onClick={() => onOpen(path)}
							size="sm"
							title={path}
							titleText={path}
						/>
						<MenuButton
							align="end"
							disabled={busy}
							icon={<MoreHorizontal />}
							items={[
								{ id: "open", label: t("scm.conflicts.open"), icon: FileDiff, onSelect: () => onOpen(path) },
								{ id: "ours", label: t("scm.conflicts.keepOurs"), onSelect: () => settle(path, "ours") },
								{ id: "theirs", label: t("scm.conflicts.keepTheirs"), onSelect: () => settle(path, "theirs") },
								{ id: "both", label: t("scm.conflicts.keepBoth"), onSelect: () => settle(path, "both") },
								{
									id: "resolved",
									label: t("scm.conflicts.markResolved"),
									icon: Check,
									separatorBefore: true,
									onSelect: () =>
										void runner.run(
											"stage",
											{ type: "git_stage", paths: [path] },
											{ failure: t("scm.stageFailed") },
										),
								},
							]}
							label={t("scm.conflicts.actions", { path })}
							size="sm"
						/>
					</div>
				))
			)}
			{resolved.length > 0 && (
				<>
					<SectionLabel as="h3" count={resolved.length} className="pt-2">
						{t("scm.conflicts.resolved")}
					</SectionLabel>
					{resolved.map(path => (
						<ListRow
							key={path}
							leading={<Check aria-hidden className="size-(--sc-icon-sm) text-(--sc-success)" />}
							onClick={() => onOpen(path)}
							size="sm"
							title={path}
							titleText={path}
						/>
					))}
				</>
			)}
		</div>
	);
}
