import {
	ArrowDown,
	ArrowLeft,
	ArrowUp,
	CheckCircle2,
	ChevronLeft,
	ChevronRight,
	FolderGit2,
	FolderTree,
	List,
	Pencil,
	RefreshCw,
	Rows3,
	Undo2,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isConflictStatus, stagedState } from "../../../shared/git-status";
import type { RpcGitChanges, RpcGitCompare, RpcGitDiff, RpcGitFingerprint } from "../../../shared/rpc-types";
import { errorDetail } from "../../lib/error-detail";
import { useFocusedScope } from "../../lib/focused-scope";
import { useT } from "../../lib/i18n";
import { lastRead, rememberRead } from "../../lib/last-read";
import type { TabRpc } from "../../lib/tab-rpc";
import { repoRpc, useTabRpc } from "../../lib/tab-rpc";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import {
	anchorFromEvent,
	Button,
	Checkbox,
	ConfirmDialog,
	ContextMenu,
	type ContextMenuAnchor,
	CopyButton,
	EmptyState,
	IconButton,
	InlineNotice,
	ListRow,
	SearchField,
	SkeletonRows,
} from "../common";
import { NotesShelf, useNotesOwner } from "./notes/ReviewNotes";
import { ChangeCounts, ChangeStatus, type ChangeStatusName, PanelToolbar } from "./PanelChrome";
import { BranchPullRequest } from "./scm/BranchPullRequest";
import { ChangeTree } from "./scm/ChangeTree";
import { CombinedDiff } from "./scm/CombinedDiff";
import { CommitBox } from "./scm/CommitBox";
import { ConflictReview } from "./scm/ConflictReview";
import { DiffLines, DiffSkeleton, VirtualRows } from "./scm/DiffLines";
import { ImageDiff } from "./scm/ImageDiff";
import { NameDialog, type NameRequest } from "./scm/NameDialog";
import { NestedRepositories } from "./scm/NestedRepositories";
import { changeStarts, parseRepositoryDiff } from "./scm/repository-diff";
import { type ChangeScope, ScopeBar } from "./scm/ScopeBar";
import { SourceControlBar } from "./scm/SourceControlBar";
import { useScmAction } from "./scm/use-scm-action";
import { EDITABLE_KINDS, FileEditor } from "./viewers/FileEditor";
import { FileIcon } from "./viewers/FileViewer";
import { viewerKind } from "./viewers/file-kind";

type ChangedFile = RpcGitChanges["files"][number];
export function statusName(file: { status: string; oldPath?: string }): ChangeStatusName {
	if (isConflictStatus(file.status)) return "conflicted";
	if (file.status === "??") return "untracked";
	if (file.oldPath || file.status.includes("R")) return "renamed";
	if (file.status.includes("D")) return "deleted";
	if (file.status.includes("A")) return "added";
	return "modified";
}

/** How often the open list asks git again while the window is visible. */
const REPOSITORY_WATCH_MS = 3000;

/**
 * The checkout's fingerprint, or null when git could not answer (a failed poll never forces a reload). `root`
 * is the worktree root this tab's last full read reported, so main skips asking git for it on every poll.
 */
async function readFingerprint(rpc: TabRpc, root: string | null): Promise<string | null> {
	try {
		const response = await rpc.getGitFingerprint(root ?? undefined);
		const data = response.success ? (response.data as RpcGitFingerprint | undefined) : undefined;
		return typeof data?.fingerprint === "string" ? data.fingerprint : null;
	} catch {
		return null;
	}
}

/**
 * The Changes panel's repository view: source control, the changed files (uncommitted, or everything against the
 * base), one file's diff with previous/next change, a picture side by side and editing in place, every diff in one
 * scroll, and conflict review while an operation waits. `repo`: one repository inside a folder that holds several
 * (`NestedRepositories`), whose commands carry it.
 */
export function RepositoryChanges({ sourceSelector, repo }: { sourceSelector?: ReactNode; repo?: string }) {
	const t = useT();
	const tabRpc = useTabRpc();
	const rpc = useMemo(() => (repo ? repoRpc(tabRpc, repo) : tabRpc), [tabRpc, repo]);
	const tabId = useRuntimeTabId();
	const [refresh, setRefresh] = useState(0);
	const { device, cwd } = useFocusedScope();
	const place = repo ? `${cwd}#${repo}` : cwd;
	const changesKey = `scm:changes:${place}`;
	// The last list of this checkout paints at the first frame; the first read below replaces it in place.
	const [changes, setChanges] = useState<RpcGitChanges | null>(
		() => lastRead<RpcGitChanges>(device, changesKey) ?? null,
	);
	const seeded = useRef(changes !== null);
	const [scope, setScope] = useState<ChangeScope>("uncommitted");
	// The base range: undefined until read, null when the checkout has none.
	const [compare, setCompare] = useState<RpcGitCompare | null | undefined>(undefined);
	const [layout, setLayout] = useState<"list" | "tree">("list");
	const [combined, setCombined] = useState(false);
	const [reviewing, setReviewing] = useState(false);
	const [editing, setEditing] = useState(false);
	const [jump, setJump] = useState<{ line: number; serial: number } | null>(null);
	const [selected, setSelected] = useState("");
	const [preview, setPreview] = useState<RpcGitDiff | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [query, setQuery] = useState("");
	const [listScroller, setListScroller] = useState<HTMLDivElement | null>(null);
	const [previewScroller, setPreviewScroller] = useState<HTMLDivElement | null>(null);
	const [combinedScroller, setCombinedScroller] = useState<HTMLDivElement | null>(null);
	const [nameRequest, setNameRequest] = useState<NameRequest | null>(null);
	const [discarding, setDiscarding] = useState<string[] | null>(null);
	const [menu, setMenu] = useState<{ anchor: ContextMenuAnchor; file: ChangedFile } | null>(null);
	const { owner: notesOwner } = useNotesOwner();
	const loadedFor = useRef<TabRpc | null>(null);
	// The fingerprint read just before the last full load; a poll that reads another one reloads.
	const loadedFingerprint = useRef("");
	// The worktree root of the last full load, for this tab only.
	const loadedRoot = useRef<{ rpc: TabRpc; root: string | null } | null>(null);
	const previewFor = useRef<{ rpc: TabRpc; path: string } | null>(null);
	const reload = useCallback(() => setRefresh(value => value + 1), []);
	const runner = useScmAction(rpc, reload);
	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads the checkout.
	useEffect(() => {
		let active = true;
		setLoading(true);
		if (loadedFor.current !== rpc) {
			if (seeded.current) seeded.current = false;
			else {
				setChanges(lastRead<RpcGitChanges>(device, changesKey) ?? null);
				setSelected("");
			}
		}
		setError(null);
		// The base range is read beside the changes; a failed read keeps the last one on screen (C1-29).
		const range =
			scope === "base"
				? rpc.command({ type: "get_git_compare" }).then(response => {
						if (!response.success) throw new Error(response.error ?? t("rpc.failed"));
						return (response.data as RpcGitCompare | null) ?? null;
					})
				: Promise.resolve(undefined);
		void Promise.resolve()
			.then(() => readFingerprint(rpc, loadedRoot.current?.rpc === rpc ? loadedRoot.current.root : null))
			.then(fingerprint => {
				// Read before the changes: an edit in between only makes the next poll reload once more.
				if (active) loadedFingerprint.current = fingerprint ?? "";
				return Promise.all([rpc.getGitChanges(), range]);
			})
			.then(([response, read]) => {
				if (!active) return;
				if (!response.success) throw new Error(response.error ?? t("rpc.failed"));
				loadedFor.current = rpc;
				const data = response.data as RpcGitChanges;
				loadedRoot.current = { rpc, root: data.root };
				setChanges(data);
				rememberRead(device, changesKey, data);
				const listed = read !== undefined ? (read?.files ?? []) : data.files;
				if (read !== undefined) setCompare(read);
				setSelected(previous => (listed.some(file => file.path === previous) ? previous : ""));
			})
			.catch(cause => {
				if (active) setError(errorDetail(cause));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [rpc, refresh, t, device, changesKey, scope]);
	// The checkout changes under an open panel (the agent edits, the user saves in Files or an editor): ask git
	// for a cheap fingerprint (two processes) while the window shows and when it comes back, and read the whole
	// checkout again only when that moved. A hidden window polls nothing.
	useEffect(() => {
		let active = true;
		let reading = false;
		let timer: number | undefined;
		const check = async () => {
			if (document.hidden || reading) return;
			reading = true;
			try {
				const fingerprint = await readFingerprint(
					rpc,
					loadedRoot.current?.rpc === rpc ? loadedRoot.current.root : null,
				);
				if (active && fingerprint !== null && fingerprint !== loadedFingerprint.current) reload();
			} finally {
				reading = false;
			}
		};
		const sync = () => {
			if (document.hidden) {
				window.clearInterval(timer);
				timer = undefined;
				return;
			}
			timer ??= window.setInterval(() => void check(), REPOSITORY_WATCH_MS);
			void check();
		};
		if (!document.hidden) timer = window.setInterval(() => void check(), REPOSITORY_WATCH_MS);
		document.addEventListener("visibilitychange", sync);
		return () => {
			active = false;
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", sync);
		};
	}, [rpc, reload]);
	// The base range's diffs start at its merge-base; the uncommitted ones at HEAD.
	const against = scope === "base" ? (compare?.base ?? undefined) : undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a refresh must also reload the selected diff.
	useEffect(() => {
		let active = true;
		const key = `scm:diff:${place}:${against ?? ""}:${selected}`;
		// A reload of the same file keeps its diff on screen (and its scroll) until the new one arrives.
		const same = previewFor.current?.rpc === rpc && previewFor.current.path === selected;
		if (!same) {
			setPreview(selected ? (lastRead<RpcGitDiff>(device, key) ?? null) : null);
			setEditing(false);
			setJump(null);
		}
		previewFor.current = selected ? { rpc, path: selected } : null;
		if (!selected) return;
		setError(null);
		void Promise.resolve()
			.then(() => rpc.getGitDiff(selected, against))
			.then(response => {
				if (!active) return;
				if (!response.success) throw new Error(response.error ?? t("rpc.failed"));
				const data = response.data as RpcGitDiff;
				setPreview(data);
				rememberRead(device, key, data, false);
			})
			.catch(cause => {
				if (active) setError(errorDetail(cause));
			});
		return () => {
			active = false;
		};
	}, [rpc, selected, refresh, t, device, place, against]);
	const listed = scope === "base" ? (compare?.files ?? []) : (changes?.files ?? []);
	const files = listed.filter(file => file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
	const current = listed.find(file => file.path === selected);
	const position = files.findIndex(file => file.path === selected);
	const totals = listed.reduce(
		(sum, file) => ({ added: sum.added + (file.added ?? 0), removed: sum.removed + (file.removed ?? 0) }),
		{ added: 0, removed: 0 },
	);
	const counted = listed.some(file => file.added !== undefined);
	// Staging, discarding and committing are the uncommitted list's: the base range also holds commits.
	const editable = scope === "uncommitted";
	const staged = changes?.files.filter(file => stagedState(file.status) !== "none").length ?? 0;
	const fullyStaged = changes?.files.filter(file => stagedState(file.status) === "all").length ?? 0;
	const conflicts = changes?.files.filter(file => isConflictStatus(file.status)).length ?? 0;
	const head = changes?.head;
	const scmBusy = runner.busy !== null;
	const lines = useMemo(() => parseRepositoryDiff(preview?.diff ?? ""), [preview]);
	const starts = useMemo(() => changeStarts(lines), [lines]);
	const previewCounts = {
		added: lines.filter(line => line.type === "add").length,
		removed: lines.filter(line => line.type === "remove").length,
	};
	const root = (scope === "base" ? compare?.root : changes?.root) ?? changes?.root ?? null;
	const kind = selected ? viewerKind(selected) : null;
	const canEdit =
		preview?.kind === "text" &&
		kind !== null &&
		EDITABLE_KINDS[kind] === true &&
		current?.status.includes("D") !== true;
	const showChange = (step: 1 | -1) => {
		const at = jump?.line ?? -1;
		const target =
			step === 1 ? starts.find(start => start > at) : [...starts].reverse().find(start => start < (jump ? at : 0));
		if (target !== undefined) setJump({ line: target, serial: (jump?.serial ?? 0) + 1 });
	};
	const setStaged = (paths: string[] | "all", stage: boolean) =>
		void runner.run(
			stage ? "stage" : "unstage",
			stage ? { type: "git_stage", paths } : { type: "git_unstage", paths },
			{ failure: stage ? t("scm.stageFailed") : t("scm.unstageFailed") },
		);
	const allChecked = changes !== null && changes.files.length > 0 && fullyStaged === changes.files.length;
	const reviewOpen = reviewing && head?.operation != null;
	if (changes && !changes.isRepo && !repo)
		return (
			<div className="omp-changes flex min-h-0 flex-1 flex-col">
				{sourceSelector && <PanelToolbar>{sourceSelector}</PanelToolbar>}
				<NestedRepositories rpc={rpc} section={nested => <RepositoryChanges repo={nested} />} />
			</div>
		);
	const openFile = (path: string) => {
		setCombined(false);
		setSelected(path);
	};
	return (
		<div className="omp-changes flex min-h-0 flex-1 flex-col" data-repo={repo}>
			{/* One block for everything above the list, so a short landscape phone can set it beside the list. */}
			<div className="omp-changes-top flex shrink-0 flex-col">
				<PanelToolbar>
					{sourceSelector}
					{/* One line says how many files changed and how many of them are staged: the stage-all box and its
					    count sit in the toolbar, never a second line under the search. */}
					{changes?.isRepo &&
						(editable && changes.files.length > 0 ? (
							<label className="ml-auto flex min-w-0 items-center gap-2 text-sc-xs text-(--sc-text-muted)">
								<Checkbox
									aria-checked={allChecked ? "true" : staged > 0 ? "mixed" : "false"}
									checked={allChecked}
									disabled={scmBusy}
									indeterminate={!allChecked && staged > 0}
									onChange={() => setStaged("all", !allChecked)}
								/>
								<span>{t("scm.stagedSummary", { staged, total: changes.files.length })}</span>
							</label>
						) : (
							<span className="ml-auto text-sc-xs text-(--sc-text-muted)">
								{t("diffPanel.repositorySummary", { count: listed.length })}
							</span>
						))}
					{counted && (
						<>
							<span aria-hidden className="text-(--sc-text-subtle)">
								·
							</span>
							<ChangeCounts {...totals} />
						</>
					)}
					<IconButton
						className="ml-auto"
						icon={<RefreshCw />}
						loading={loading}
						label={t("common.refresh")}
						onClick={reload}
						size="sm"
					/>
					{changes?.truncated && (
						<span className="text-sc-xs text-(--sc-text-muted)" role="status">
							{t("diffPanel.listLimited")}
						</span>
					)}
				</PanelToolbar>
				{changes?.isRepo && head && (
					<SourceControlBar
						conflicts={conflicts}
						head={head}
						onReview={() => setReviewing(true)}
						requestName={setNameRequest}
						rpc={rpc}
						runner={runner}
					/>
				)}
				{changes?.isRepo && head && (
					<ScopeBar
						compare={compare}
						head={head}
						onScope={next => {
							setScope(next);
							setSelected("");
							if (next === "uncommitted") setCompare(undefined);
						}}
						rpc={rpc}
						runner={runner}
						scope={scope}
					/>
				)}
				{changes?.isRepo && head?.branch && <BranchPullRequest branch={head.branch} />}
				{error && (
					<InlineNotice
						action={
							<Button onClick={reload} size="sm" variant="ghost">
								{t("common.retry")}
							</Button>
						}
						className="px-3"
						detail={error}
						live
						title={t("diffPanel.loadFailed")}
						tone="danger"
					/>
				)}
				<NotesShelf
					onOpen={note => {
						if (note.anchor.kind === "diff") openFile(note.anchor.path);
					}}
				/>
				{changes?.isRepo && head && editable && !selected && !combined && !reviewOpen && (
					<CommitBox branch={head.branch} conflicts={conflicts} rpc={rpc} runner={runner} staged={staged} />
				)}
			</div>
			{loading && !changes ? (
				<SkeletonRows className="px-3 py-2" label={t("common.loading")} widths={[56, 70, 48, 64, 52, 60]} />
			) : changes && !changes.isRepo ? (
				<EmptyState icon={<FolderGit2 />} size="sm" title={t("diffPanel.notRepoTitle")} />
			) : reviewOpen && changes && !selected ? (
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="flex items-center gap-1 px-2 pt-2">
						<IconButton
							icon={<ArrowLeft />}
							label={t("scm.conflicts.close")}
							onClick={() => setReviewing(false)}
							size="sm"
						/>
						<span className="text-sc-sm">{t("scm.conflicts.title")}</span>
					</div>
					<ConflictReview
						files={changes.files}
						onOpen={openFile}
						rebase={head?.operation === "rebase"}
						runner={runner}
						stop={`${place}:${head?.operation ?? ""}`}
					/>
				</div>
			) : listed.length === 0 ? (
				<EmptyState
					icon={<CheckCircle2 />}
					size="sm"
					title={scope === "base" && compare === undefined ? t("common.loading") : t("diffPanel.clean")}
				/>
			) : combined && root ? (
				<div className="min-h-0 flex-1 overflow-y-auto" ref={setCombinedScroller}>
					<div>
						<div className="flex items-center gap-1 px-2 pt-2">
							<IconButton
								icon={<ArrowLeft />}
								label={t("scm.combined.close")}
								onClick={() => setCombined(false)}
								size="sm"
							/>
							<span className="text-sc-sm">{t("scm.combined.title", { count: files.length })}</span>
						</div>
						<CombinedDiff
							against={against}
							files={files}
							notesOwner={notesOwner}
							onOpen={openFile}
							refresh={refresh}
							root={root}
							rpc={rpc}
							scroller={combinedScroller}
						/>
					</div>
				</div>
			) : (
				<div className="omp-changes-body min-h-0 flex-1" data-open={!!selected}>
					<div ref={setListScroller} className="omp-changes-list min-h-0 overflow-y-auto px-3 pb-3">
						<div className="sticky top-0 z-(--sc-z-sticky) flex items-center gap-2 bg-(--sc-surface-1) pt-2 pb-1 [[data-sheet-panel]_&]:bg-(--sc-elevated)">
							<div className="min-w-0 flex-1">
								<SearchField
									controlSize="sm"
									label={t("diffPanel.search")}
									onValueChange={setQuery}
									placeholder={t("diffPanel.search")}
									value={query}
								/>
							</div>
							<IconButton
								icon={layout === "list" ? <FolderTree /> : <List />}
								label={layout === "list" ? t("scm.view.tree") : t("scm.view.list")}
								onClick={() => setLayout(value => (value === "list" ? "tree" : "list"))}
								size="sm"
							/>
							<IconButton
								data-combined-toggle
								icon={<Rows3 />}
								label={t("scm.combined.open")}
								onClick={() => {
									setSelected("");
									setCombined(true);
								}}
								size="sm"
							/>
							{editable && (
								<Button
									disabled={scmBusy || changes?.files.length === 0}
									icon={<Undo2 />}
									onClick={() => setDiscarding(changes?.files.map(file => file.path) ?? [])}
									size="sm"
									variant="ghost"
								>
									{t("scm.discardAll")}
								</Button>
							)}
						</div>
						{layout === "tree" ? (
							<ChangeTree
								files={files}
								onMenu={editable ? (anchor, file) => setMenu({ anchor, file }) : undefined}
								onSelect={setSelected}
								selected={selected}
								statusOf={statusName}
							/>
						) : (
							<div>
								<VirtualRows estimate={30} itemKey={file => file.path} items={files} scroller={listScroller}>
									{file => {
										const slash = file.path.lastIndexOf("/");
										const status = statusName(file);
										const state = stagedState(file.status);
										const conflicted = status === "conflicted";
										return (
											<div
												className="group flex items-center gap-1"
												data-staged={editable ? state : undefined}
												onContextMenu={event => {
													if (!editable) return;
													event.preventDefault();
													setMenu({ anchor: anchorFromEvent(event), file });
												}}
											>
												{editable && (
													<label className="ml-1 flex h-(--sc-hit-min) w-7 shrink-0 cursor-pointer items-center justify-center">
														<Checkbox
															aria-checked={
																state === "all" ? "true" : state === "partial" ? "mixed" : "false"
															}
															aria-label={
																state === "all"
																	? t("scm.unstageFile", { path: file.path })
																	: t("scm.stageFile", { path: file.path })
															}
															checked={state === "all"}
															disabled={scmBusy}
															indeterminate={state === "partial"}
															onChange={() => setStaged([file.path], state !== "all")}
														/>
													</label>
												)}
												<ListRow
													className="min-w-0 flex-1"
													leading={
														<FileIcon
															path={file.path}
															className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)"
														/>
													}
													meta={<ChangeCounts added={file.added} removed={file.removed} />}
													onClick={() => setSelected(file.path)}
													secondary={
														slash >= 0 && (
															<span
																className="min-w-0 flex-1 truncate text-left text-(--sc-text-subtle)"
																dir="rtl"
															>
																{`\u200E${file.path.slice(0, slash)}`}
															</span>
														)
													}
													selected={selected === file.path}
													size="sm"
													title={
														<>
															{file.path.slice(slash + 1)}
															<span className="sr-only">, {t(`diffPanel.status.${status}`)}</span>
														</>
													}
													titleText={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
													trailing={<ChangeStatus status={status} />}
												/>
												{editable && (
													<IconButton
														className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
														disabled={scmBusy || conflicted}
														icon={<Undo2 />}
														label={t("scm.discardFile", { path: file.path })}
														onClick={() => setDiscarding([file.path])}
														size="sm"
													/>
												)}
											</div>
										);
									}}
								</VirtualRows>
								{files.length === 0 && (
									<EmptyState
										icon={<FolderGit2 />}
										size="sm"
										title={t("diffPanel.noMatch")}
										actions={
											<Button size="sm" variant="secondary" onClick={() => setQuery("")}>
												{t("common.clear")}
											</Button>
										}
									/>
								)}
							</div>
						)}
					</div>
					{selected && (
						<div ref={setPreviewScroller} className="omp-changes-preview min-h-0 min-w-0 overflow-y-auto">
							<div className="sticky top-0 z-(--sc-z-sticky) flex flex-wrap items-center gap-1 bg-(--sc-surface-1) px-2 py-2 [[data-sheet-panel]_&]:bg-(--sc-elevated)">
								<IconButton
									icon={<ArrowLeft />}
									label={t("diffPanel.back")}
									onClick={() => setSelected("")}
									size="sm"
								/>
								<span className="min-w-0 flex-1 truncate text-sc-sm" title={selected}>
									{selected}
								</span>
								<ChangeCounts
									added={current?.added ?? (preview?.kind === "text" ? previewCounts.added : undefined)}
									removed={current?.removed ?? (preview?.kind === "text" ? previewCounts.removed : undefined)}
								/>
								{preview?.kind === "text" && !editing && (
									<>
										<IconButton
											data-change-nav="previous"
											disabled={starts.length === 0 || (jump !== null && jump.line <= (starts[0] ?? 0))}
											icon={<ArrowUp />}
											label={t("scm.change.previous")}
											onClick={() => showChange(-1)}
											size="sm"
										/>
										<IconButton
											data-change-nav="next"
											disabled={starts.length === 0 || (jump?.line ?? -1) >= (starts.at(-1) ?? -1)}
											icon={<ArrowDown />}
											label={t("scm.change.next")}
											onClick={() => showChange(1)}
											size="sm"
										/>
									</>
								)}
								<IconButton
									icon={<ChevronLeft />}
									label={t("diffPanel.previous")}
									disabled={position <= 0}
									onClick={() => setSelected(files[position - 1]!.path)}
									size="sm"
								/>
								<IconButton
									icon={<ChevronRight />}
									label={t("diffPanel.next")}
									disabled={position < 0 || position >= files.length - 1}
									onClick={() => setSelected(files[position + 1]!.path)}
									size="sm"
								/>
								{canEdit && root && (
									<IconButton
										data-diff-edit
										icon={<Pencil />}
										label={editing ? t("scm.edit.done") : t("scm.edit.start")}
										onClick={() => setEditing(value => !value)}
										pressed={editing}
										size="sm"
									/>
								)}
								{editable && (
									<IconButton
										disabled={scmBusy || !current || isConflictStatus(current.status)}
										icon={<Undo2 />}
										label={t("scm.revertToHead")}
										onClick={() => setDiscarding([selected])}
										size="sm"
									/>
								)}
								<CopyButton disabled={!preview?.diff} label={t("diff.copy")} text={preview?.diff ?? ""} />
							</div>
							{editing && root && kind ? (
								<FileEditor
									diskRevision={refresh}
									kind={kind}
									onDirtyChange={() => {}}
									onSaved={reload}
									path={`${root.replace(/[\\/]+$/, "")}/${selected}`}
									tabId={tabId ?? undefined}
								/>
							) : !preview && !error ? (
								<DiffSkeleton label={t("common.loading")} />
							) : preview?.kind === "text" ? (
								<DiffLines
									jump={jump ?? undefined}
									lines={lines}
									notes={notesOwner ? { owner: notesOwner } : undefined}
									path={selected}
									scroller={previewScroller}
								/>
							) : preview && kind === "image" && root ? (
								<ImageDiff against={against} oldPath={current?.oldPath} path={selected} root={root} rpc={rpc} />
							) : (
								preview && (
									<p className="p-3 text-sc-sm text-(--sc-text-muted)">
										{t(`diffPanel.kind.${preview.kind}`)}
									</p>
								)
							)}
							{preview?.truncated && !editing && (
								<p className="p-3 text-sc-xs text-(--sc-warning)">{t("diffPanel.previewLimited")}</p>
							)}
						</div>
					)}
				</div>
			)}
			{menu && (
				<ContextMenu
					ariaLabel={menu.file.path}
					items={[
						stagedState(menu.file.status) === "all"
							? {
									id: "unstage",
									label: t("scm.unstage"),
									onSelect: () => setStaged([menu.file.path], false),
								}
							: {
									id: "stage",
									label: t("scm.stage"),
									onSelect: () => setStaged([menu.file.path], true),
								},
						{ id: "open", label: t("scm.showDiff"), onSelect: () => setSelected(menu.file.path) },
						{
							id: "discard",
							label: t("scm.discard"),
							icon: Undo2,
							danger: true,
							separatorBefore: true,
							disabled: isConflictStatus(menu.file.status),
							onSelect: () => setDiscarding([menu.file.path]),
						},
					]}
					onClose={() => setMenu(null)}
					x={menu.anchor.x}
					y={menu.anchor.y}
				/>
			)}
			<ConfirmDialog
				confirmLabel={t("scm.discard")}
				message={
					discarding?.length === 1
						? t("scm.discardBody", { path: discarding[0] ?? "" })
						: t("scm.discardAllBody", { count: discarding?.length ?? 0 })
				}
				onCancel={() => setDiscarding(null)}
				onConfirm={() => {
					const paths = discarding;
					setDiscarding(null);
					if (!paths) return;
					if (paths.includes(selected)) setSelected("");
					void runner.run("discard", { type: "git_discard", paths }, { failure: t("scm.discardFailed") });
				}}
				open={discarding !== null}
				title={discarding?.length === 1 ? t("scm.discardTitle") : t("scm.discardAllTitle")}
				warning={t("scm.discardWarning")}
			/>
			<NameDialog onClose={() => setNameRequest(null)} request={nameRequest} />
		</div>
	);
}
